// `hoptell apply` (design 5.2): the owner applies a proposal that answered one of their review
// sets, on their own machine, after seeing what it will do. No MCP tool reaches this; a peer never
// supplies a path or a command: every write targets the owner's own recorded file, and starts from
// the retained captured bytes.
//
// One apply at a time per home (an apply lock; recovery takes the same lock). The steps:
//  1. checks before anything is written (sender, set, based_on, file ids, base hashes against the
//     retained captures);
//  2. scope: existing text files only;
//  3. the preview is built from the captured bytes in a standalone temporary folder, never a Git
//     work tree; patches go through a controlled `git apply --check`, then `git apply`, there;
//  4. hoptell's own diff of each current file against the result (--preview stops here);
//  5. after confirmation: revalidate every target, write and sync the recovery journal, then
//     replace each file (a temporary file in the same folder whose name and identity are in the
//     journal before a byte is written, sync, check again, rename, sync the folder), recording
//     each completion. Then the commit point: the journal's phase "complete", synced. After it the
//     proposal is marked applied and the journal folder is retired: renamed atomically into
//     apply/done/<id>.<outcome>, and only then emptied and removed;
//  6. `--recover` finishes or rolls back an interrupted apply; a file holding neither its
//     preimage nor its postimage halts recovery for that file and is never overwritten. Once the
//     phase "complete" is durable the apply is committed: recovery only finishes marking and
//     cleanup, and refuses a roll-back. A retired folder is only ever emptied. Temporary files are
//     removed only when they are exactly the ones the journal recorded (path, device, inode);
//     anything else is left for inspection and reported;
//  7. nothing here runs tests, scripts or hooks.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir } from "./config.js";
import { removeDurable, writeDurable } from "./credentials.js";
import { FileToolError, checkRelPath, openRoots, parseRoots, supported } from "./files.js";
import { GitError, controlledGit } from "./gitsafe.js";
import { tryLock } from "./locks.js";
import { MAX_SET_CONTENT, ReviewError, ReviewSetStore, checkPatch, checkProposal, exactText, inGitDir, patchRefusal, readPrivate, rootInGitDir } from "./reviewsets.js";
import { DIGEST_RE, sha256Of } from "./snapshot.js";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
const JOURNAL_MAX = 64 * 1024;
const PHASES = ["prepared", "complete"];
const TEMP_RE = /^\.hoptell-apply-[0-9a-f]{12}\.tmp$/;
const ID_RE = /^[0-9a-f-]{36}$/;
// A retired journal folder: apply/done/<proposal id>.<outcome>. It is only ever emptied.
const RETIRED_RE = /^([0-9a-f-]{36})\.(applied|rolled-back|unwritten)$/;

/** A refusal with a fixed message (never peer text, never raw system errors). */
export class ApplyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const REFUSALS = {
  locked: "another hoptell apply or recovery is running in this home",
  journal_pending: "an earlier apply was interrupted; run hoptell apply --recover first",
  unknown: "no proposal with that id is stored in this home",
  invalid_record: "the stored review set or proposal is damaged; nothing was applied",
  already_applied: "this proposal was already applied",
  expired: "this proposal has expired",
  root_not_approved: "a target's approved folder is not configured (HOPTELL_SNAPSHOT_ROOTS)",
  root_changed: "a target's approved folder was replaced since the review set was captured",
  capture_damaged: "a retained capture does not match its recorded sha256; nothing was applied",
  base_sha256: "a change's base_sha256 is not the sha256 of the retained capture",
  file_missing: "a target file no longer exists",
  path_unsafe: "a target is not a plain file inside its approved folder, or a folder on its path is a symbolic link or on another device",
  identity_changed: "a target file was replaced since it was captured (another device or inode)",
  file_changed: "a target file changed since it was captured; nothing was applied. Send a new review set",
  parent_changed: "a folder on a target's path changed while it was being written",
  not_owner: "a target file belongs to another user",
  patch_failed: "a patch does not apply to the captured bytes",
  not_text: "a change's result is not valid UTF-8 text",
  committed: "every file was written, but marking the proposal applied or removing the recovery journal was interrupted; run hoptell apply --recover --finish to complete it",
  unsupported: "this platform has no guarded file access",
};
const refusal = (code, extra = "") => new ApplyError(code, `${REFUSALS[code] ?? code}${extra}`);

const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);
const applyDir = (home) => path.join(home, "apply");
const doneDir = (home) => path.join(applyDir(home), "done");

// ---- test barriers (crash tests only) ---------------------------------------------------------

/**
 * Tests pass a barrier path: at the step named in <barrier>.step, write <barrier>.at and wait
 * until <barrier>.go exists (the test may kill this process meanwhile). Other steps run through.
 */
function barrierFor(barrier) {
  if (!barrier) return () => {};
  let step = null;
  try {
    step = fs.readFileSync(`${barrier}.step`, "utf8").trim();
  } catch {}
  return (name) => {
    if (name !== step) return;
    fs.writeFileSync(`${barrier}.at`, name);
    const until = Date.now() + 60_000;
    while (!fs.existsSync(`${barrier}.go`)) {
      if (Date.now() > until) throw new ApplyError("barrier", "test barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
}

// ---- rooted file access ------------------------------------------------------------------------

/**
 * The path of `rel` inside an opened approved folder, checked one name at a time: the folder is
 * still the one approved, every folder on the way is a real folder (not a symbolic link) on the
 * same device. Returns {chain: [{dir, dev, ino}], file}.
 */
function walk(root, rel) {
  if (inGitDir(rel) || rootInGitDir(root)) throw refusal("path_unsafe");
  const top = fs.lstatSync(root.canonical, { bigint: true, throwIfNoEntry: false });
  if (!top || !top.isDirectory() || top.dev !== root.dev || top.ino !== root.ino) throw refusal("root_changed");
  const chain = [{ dir: root.canonical, dev: top.dev, ino: top.ino }];
  const parts = rel.split("/");
  let dir = root.canonical;
  for (const name of parts.slice(0, -1)) {
    dir = path.join(dir, name);
    const st = fs.lstatSync(dir, { bigint: true, throwIfNoEntry: false });
    if (!st) throw refusal("file_missing");
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== root.dev) throw refusal("path_unsafe");
    chain.push({ dir, dev: st.dev, ino: st.ino });
  }
  return { chain, file: path.join(dir, parts.at(-1)) };
}

/** Every folder of a chain is still the same folder (device and inode), and none is a link. */
function recheck(chain) {
  for (const c of chain) {
    const st = fs.lstatSync(c.dir, { bigint: true, throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory() || st.dev !== c.dev || st.ino !== c.ino) throw refusal("parent_changed");
  }
}

/** Read a target: a plain regular file (one link, not a symbolic link). Returns {st, bytes} (bytes null when over the limit). */
function readTarget(file, rootDev) {
  const entry = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!entry) throw refusal("file_missing");
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1n || entry.dev !== rootDev) throw refusal("path_unsafe");
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (st.dev !== entry.dev || st.ino !== entry.ino || !st.isFile()) throw refusal("path_unsafe");
    const buf = Buffer.alloc(MAX_SET_CONTENT + 1);
    let n = 0;
    let got;
    while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
    return { st, bytes: n > MAX_SET_CONTENT ? null : Buffer.from(buf.subarray(0, n)) };
  } finally {
    fs.closeSync(fd);
  }
}

const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));

/**
 * Remove a temporary file only when it is exactly the recorded one (a regular file with the
 * recorded device and inode). Returns "removed", "absent" or "left" (something else is there).
 */
function removeTemp(file, temp) {
  const st = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!st) return "absent";
  if (temp.dev === undefined || !st.isFile() || String(st.dev) !== temp.dev || String(st.ino) !== temp.ino) return "left";
  fs.rmSync(file, { force: true });
  return "removed";
}

/**
 * Replace one target whose current bytes must be `expected` with `next` (mode `mode`): a temporary
 * file in the same folder, synced; the folder chain and the target checked again; rename; the
 * folder synced. `identity` ({dev, ino}), when given, must still be the target's. `onTemp` records
 * the temporary file durably: its name before it is created, then its device and inode before
 * any byte is written; only that exact file is ever removed again.
 */
function replaceFile(root, rel, { expected, next, mode, identity = null, onTemp = () => {}, pause = () => {}, index = 0 }) {
  const w = walk(root, rel);
  const cur = readTarget(w.file, root.dev);
  if (identity && (String(cur.st.dev) !== identity.dev || String(cur.st.ino) !== identity.ino)) throw refusal("identity_changed");
  if (!same(cur.bytes, expected)) throw refusal("file_changed");
  if (ownUid() !== null && Number(cur.st.uid) !== ownUid()) throw refusal("not_owner");
  const parent = w.chain.at(-1).dir;
  const name = `.hoptell-apply-${crypto.randomBytes(6).toString("hex")}.tmp`;
  const tmp = path.join(parent, name);
  onTemp({ name });
  let temp = null;
  let renamed = false;
  try {
    const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode & 0o7777);
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      temp = { name, dev: String(st.dev), ino: String(st.ino) };
      onTemp(temp);
      fs.fchmodSync(fd, mode & 0o7777); // the exact mode, whatever the umask
      for (let off = 0; off < next.length; ) {
        const n = fs.writeSync(fd, next, off, next.length - off);
        if (!(n > 0)) throw new Error("no progress");
        off += n;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    pause(`temp-written-${index}`);
    // Check again right before the rename: the same folders, the same file, still the expected bytes.
    recheck(w.chain);
    const again = readTarget(w.file, root.dev);
    if (again.st.dev !== cur.st.dev || again.st.ino !== cur.st.ino || !same(again.bytes, expected)) throw refusal("file_changed");
    fs.renameSync(tmp, w.file);
    renamed = true;
    pause(`renamed-${index}`);
    const dfd = fs.openSync(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      const st = fs.fstatSync(dfd, { bigint: true });
      if (st.dev !== w.chain.at(-1).dev || st.ino !== w.chain.at(-1).ino) throw refusal("parent_changed");
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } finally {
    // Only the file created here; whatever else is at that name now is left alone.
    if (!renamed && temp) removeTemp(tmp, temp);
  }
}

// ---- the lock and the journal -------------------------------------------------------------------

/** Take the apply lock of `home`; returns a release function, or throws ApplyError("locked"). */
export function applyLock(home) {
  ensurePrivateDir(home);
  const got = tryLock(path.join(home, "apply.lock"));
  if (typeof got !== "function") throw refusal("locked", got.pid ? ` (process ${got.pid}); try again when it is done` : "");
  return got;
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Journal folders of this home: retired ones still being emptied first, then unfinished applies. */
export function journals(home) {
  return [
    ...listDir(doneDir(home))
      .filter((n) => RETIRED_RE.test(n))
      .map((n) => path.join(doneDir(home), n)),
    ...listDir(applyDir(home))
      .filter((n) => ID_RE.test(n))
      .map((n) => path.join(applyDir(home), n)),
  ];
}

const relPathOk = (p) => {
  try {
    checkRelPath(p);
  } catch {
    return false;
  }
  return !inGitDir(p);
};
const tempOk = (x) => x === null || (x && typeof x === "object" && TEMP_RE.test(x.name) && (x.dev === undefined ? x.ino === undefined : /^\d+$/.test(x.dev) && /^\d+$/.test(x.ino)));

function validJournal(j) {
  const time = (t) => Number.isSafeInteger(t) && t > 0;
  const ok =
    j && j.v === 1 && ID_RE.test(j.proposal_id) && ID_RE.test(j.review_set_id) && time(j.created_at) && PHASES.includes(j.phase) &&
    Array.isArray(j.targets) && j.targets.length >= 1 &&
    j.targets.every(
      (t, i) =>
        t && t.index === i && typeof t.root_id === "string" && DIGEST_RE.test(t.root_identity) && relPathOk(t.path) && /^\d+$/.test(t.dev) && /^\d+$/.test(t.ino) &&
        Number.isInteger(t.mode) && DIGEST_RE.test(t.pre_sha256) && DIGEST_RE.test(t.post_sha256) && Number.isSafeInteger(t.pre_bytes) && Number.isSafeInteger(t.post_bytes) && typeof t.done === "boolean" &&
        tempOk(t.temp),
    );
  if (!ok) throw new ApplyError("invalid_journal", "the recovery journal is damaged; it was kept for inspection");
  return j;
}

function syncDir(dir) {
  const d = fs.openSync(dir, O_RDONLY | O_DIRECTORY);
  try {
    fs.fsyncSync(d);
  } finally {
    fs.closeSync(d);
  }
}

/**
 * Retire a journal folder: one atomic rename into apply/done/<id>.<outcome> (synced), so an
 * interruption from here on can never be read as an unfinished apply; then empty and remove it.
 * `dir` may already be retired (recovery finishing an interrupted cleanup).
 */
function retireJournal(home, dir, outcome, pause = () => {}) {
  let retired = dir;
  if (path.dirname(dir) !== doneDir(home)) {
    ensurePrivateDir(doneDir(home));
    retired = path.join(doneDir(home), `${path.basename(dir)}.${outcome}`);
    fs.renameSync(dir, retired); // never onto an existing folder: that fails, and the journal stays
    syncDir(doneDir(home));
    syncDir(applyDir(home));
    pause("journal-retired");
  }
  for (const f of fs.readdirSync(retired)) {
    removeDurable(path.join(retired, f));
    pause(`retired-removed-${f}`);
  }
  fs.rmdirSync(retired);
  syncDir(doneDir(home));
}

// ---- diff for the preview ---------------------------------------------------------------------

/** Lines with their terminators, so a missing final newline stays visible. */
const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** A line-level edit script: [[op, line]] with op " ", "-" or "+". */
function editScript(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid = [];
  if (am.length * bm.length > 4_000_000) {
    for (const l of am) mid.push(["-", l]);
    for (const l of bm) mid.push(["+", l]);
  } else {
    // Longest common subsequence over the changed middle.
    const n = am.length;
    const m = bm.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        mid.push([" ", am[i]]);
        i++;
        j++;
      } else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) mid.push(["-", am[i++]]);
      else mid.push(["+", bm[j++]]);
    }
  }
  return [...a.slice(0, pre).map((l) => [" ", l]), ...mid, ...a.slice(a.length - suf).map((l) => [" ", l])];
}

/** Control characters shown as escapes: peer text must not drive the owner's terminal. */
const visible = (s) =>
  // eslint-disable-next-line no-control-regex -- escaping control characters is the point
  s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);

/** A unified diff of two texts, made here (no external diff, textconv or pager). */
export function unifiedDiff(before, after, label, context = 3) {
  const script = editScript(linesOf(before), linesOf(after));
  if (script.every(([op]) => op === " ")) return "";
  const out = [`--- ${visible(label)} (current)`, `+++ ${visible(label)} (after apply)`];
  let oldNo = 1;
  let newNo = 1;
  const pos = script.map(([op]) => {
    const p = { o: oldNo, n: newNo };
    if (op !== "+") oldNo++;
    if (op !== "-") newNo++;
    return p;
  });
  let k = 0;
  while (k < script.length) {
    if (script[k][0] === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    // Extend while changes are within 2*context lines of each other.
    for (;;) {
      while (end < script.length && script[end][0] !== " ") end++;
      let next = end;
      while (next < script.length && script[next][0] === " " && next - end < 2 * context) next++;
      if (next < script.length && script[next][0] !== " " && next - end <= 2 * context) end = next;
      else break;
    }
    end = Math.min(script.length, end + context);
    const slice = script.slice(start, end);
    const oldLen = slice.filter(([op]) => op !== "+").length;
    const newLen = slice.filter(([op]) => op !== "-").length;
    out.push(`@@ -${oldLen ? pos[start].o : pos[start].o - 1},${oldLen} +${newLen ? pos[start].n : pos[start].n - 1},${newLen} @@`);
    for (const [op, line] of slice) {
      const body = line.endsWith("\n") ? line.slice(0, -1) : line;
      out.push(`${op}${visible(body.replace(/\r$/, ""))}${body.endsWith("\r") ? "\\r" : ""}`);
      if (!line.endsWith("\n")) out.push("\\ No newline at end of file");
    }
    k = end;
    start = end;
  }
  return out.join("\n");
}

// ---- the apply --------------------------------------------------------------------------------

/** Open the approved folders from the setting; an empty or broken setting means none. */
export function openApprovedRoots(setting) {
  if (!supported()) throw refusal("unsupported");
  try {
    return openRoots(parseRoots(setting));
  } catch (e) {
    throw new ApplyError("invalid_config", e instanceof FileToolError ? e.message : "the approved folders could not be opened");
  }
}

const closeRoots = (roots) => {
  for (const r of roots.values()) fs.closeSync(r.fd);
};

/**
 * Steps 1 to 4 for proposal `id`: checks, the preview built from the captured bytes, and the
 * diff against each current file. Returns a plan; writes nothing outside a temporary folder that
 * is removed before returning.
 */
export function prepare({ home, roots, id, git = undefined, tmpRoot = os.tmpdir(), now = Date.now() }) {
  const store = new ReviewSetStore({ home });
  let found;
  try {
    found = store.findProposal(String(id).toLowerCase());
  } catch (e) {
    throw refusal(e.code === "unknown" ? "unknown" : "invalid_record");
  }
  const { set, proposal } = found;
  if (proposal.status === "applied") throw refusal("already_applied");
  if (proposal.expires_at <= now) throw refusal("expired");
  // 1. The same checks as at receipt, again (the set's expiry as it was when the proposal came).
  try {
    checkProposal(proposal.proposal, set, proposal.sender, proposal.received_at);
  } catch (e) {
    throw new ApplyError(e.code, `the proposal no longer passes its checks: ${e.message}`);
  }
  const targets = [];
  for (const [i, c] of proposal.proposal.changes.entries()) {
    const f = set.files.find((x) => x.file_id === c.file_id);
    const root = roots.get(f.root_id);
    if (!root) throw refusal("root_not_approved", ` (${f.root_id})`);
    if (root.identity !== f.root_identity) throw refusal("root_changed", ` (${f.root_id})`);
    let base;
    try {
      base = store.captured(set, f.file_id);
    } catch {
      throw refusal("capture_damaged");
    }
    if (sha256Of(base) !== c.base_sha256) throw refusal("base_sha256");
    targets.push({ index: i, change: c, file: f, root, base, post: null, current: null, note: null });
  }

  // 3. The preview, from the captured bytes, in a standalone temporary folder.
  const scratch = fs.mkdtempSync(path.join(tmpRoot, "hoptell-apply-"));
  try {
    fs.chmodSync(scratch, 0o700);
    let g = null;
    for (const t of targets) {
      if (t.change.kind === "replace") {
        t.post = Buffer.from(t.change.text, "utf8");
      } else {
        try {
          checkPatch(t.change.unified_diff, t.file.path);
        } catch (e) {
          throw new ApplyError(e.code ?? "patch_malformed", e instanceof ReviewError ? e.message : patchRefusal());
        }
        if (!g) {
          g = controlledGit({ ...(git !== undefined ? { git } : {}), scratch, ceiling: scratch });
          g.checkVersion();
        }
        t.post = applyPatch(g, scratch, t);
      }
      if (exactText(t.post) === null || t.post.includes(0)) throw refusal("not_text");
      if (t.post.length > MAX_SET_CONTENT) throw refusal("not_text", ` (the result is larger than ${MAX_SET_CONTENT} bytes)`);
    }
  } catch (e) {
    if (e instanceof GitError) throw new ApplyError(e.code, e.message);
    throw e;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // 4. Each current file, read the guarded way, for the preview's diff.
  for (const t of targets) {
    try {
      const w = walk(t.root, t.file.path);
      const cur = readTarget(w.file, t.root.dev);
      t.current = cur.bytes;
      if (String(cur.st.dev) !== t.file.dev || String(cur.st.ino) !== t.file.ino) t.note = "identity_changed";
      else if (!same(cur.bytes, t.base)) t.note = "file_changed";
    } catch (e) {
      t.note = e instanceof ApplyError ? e.code : "file_missing";
    }
  }
  return { set, proposal, targets };
}

/** One patch, in its own folder per approved folder and file identity, through controlled Git. */
function applyPatch(g, scratch, t) {
  // Equal relative paths in different approved folders never share a temporary location.
  const area = path.join(scratch, "t", `${t.file.root_id}-${t.file.dev}-${t.file.ino}`);
  const file = path.join(area, ...t.file.path.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, t.base, { flag: "wx", mode: 0o600 });
  if (sha256Of(fs.readFileSync(file)) !== t.file.sha256) throw refusal("capture_damaged");
  const patch = path.join(scratch, `change-${t.index}.patch`);
  fs.writeFileSync(patch, t.change.unified_diff, { flag: "wx", mode: 0o600 });
  // Never --reject, --unsafe-paths, --index or --3way; outside any repository (the ceiling).
  const args = ["apply", "--whitespace=nowarn", "-p1", "--", patch];
  const check = g.run(["apply", "--check", "--whitespace=nowarn", "-p1", "--", patch], area);
  if (check.status !== 0) throw refusal("patch_failed", ` (change ${t.index + 1}, ${t.file.root_id}:${t.file.path})`);
  const r = g.run(args, area);
  if (r.status !== 0) throw refusal("patch_failed", ` (change ${t.index + 1}, ${t.file.root_id}:${t.file.path})`);
  // Exactly the one file, still a plain file, and nothing else appeared.
  const found = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else found.push({ p, e });
    }
  };
  scan(area);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (found.length !== 1 || found[0].p !== file || !st?.isFile()) throw refusal("patch_failed", " (it touched something other than the one file)");
  return fs.readFileSync(file);
}

/** The preview text of a plan: per file, a diff of the current file against the result. */
export function renderPreview(plan) {
  const out = [];
  const s = plan.proposal.sender;
  const who =
    s.auth === "member"
      ? `member ${visible(s.member)}, authenticated by the relay`
      : "a shared-token name: anyone holding the relay's shared token can use it";
  out.push(`Proposal ${plan.proposal.proposal_id} for review set ${plan.set.review_set_id}, from "${visible(s.name)}" (${who}; realm ${visible(s.realm)}), received ${new Date(plan.proposal.received_at).toISOString()}.`);
  // How the review set's recipient was bound when it was sent: what the sender check above means.
  const r = plan.set.recipient;
  out.push(
    r.auth === "member"
      ? `The review set went to member ${visible(r.member)}, as the relay confirmed; only that member's replies are accepted.`
      : r.auth === "shared"
        ? `The review set went to a shared-token session named "${visible(r.name)}", as the relay confirmed; anyone holding the relay's shared token can use that name.`
        : `The relay that carried the review set did not name its recipient (an older relay), so this is the weaker check: any authenticated sender named "${visible(r.name)}" in this realm is accepted, not one bound member.`,
  );
  for (const t of plan.targets) {
    const label = `${t.file.root_id}:${t.file.path}`;
    out.push("");
    out.push(`== ${visible(label)} (${t.change.kind}${plan.set.git ? `, captured ${plan.set.git.files[t.file.file_id]}` : ""})`);
    if (t.note) out.push(`!! ${REFUSALS[t.note] ?? t.note}: applying will be refused.`);
    if (t.current === null) {
      out.push("(the current file could not be read)");
      continue;
    }
    const diff = unifiedDiff(t.current.toString("utf8"), t.post.toString("utf8"), label);
    out.push(diff || "(no change)");
  }
  return out.join("\n");
}

/**
 * Step 5: revalidate every target, write the journal, replace each file. `pause` is a test
 * barrier. Returns the number of files written. A refusal before the journal writes nothing.
 */
export function commit(plan, { home, pause = () => {}, now = Date.now() }) {
  pause("before-revalidate");
  // Every target, before the first write: inside its folder, no links on the way, a regular
  // file, the same device and inode as captured, and still the captured bytes.
  for (const t of plan.targets) {
    const w = walk(t.root, t.file.path);
    const cur = readTarget(w.file, t.root.dev);
    if (String(cur.st.dev) !== t.file.dev || String(cur.st.ino) !== t.file.ino) throw refusal("identity_changed");
    if (!same(cur.bytes, t.base)) throw refusal("file_changed");
    if (ownUid() !== null && Number(cur.st.uid) !== ownUid()) throw refusal("not_owner");
    t.mode = Number(cur.st.mode & 0o7777n);
  }
  // The journal: synced files, then the record, before the first replace.
  const dir = path.join(ensurePrivateDir(applyDir(home)), plan.proposal.proposal_id);
  fs.mkdirSync(dir, { mode: 0o700 }); // exclusive: one journal per proposal
  syncDir(applyDir(home));
  pause("journal-dir-created");
  const journal = {
    v: 1,
    proposal_id: plan.proposal.proposal_id,
    review_set_id: plan.set.review_set_id,
    created_at: now,
    phase: "prepared",
    targets: plan.targets.map((t, i) => ({
      index: i,
      file_id: t.file.file_id,
      root_id: t.file.root_id,
      root_identity: t.file.root_identity,
      path: t.file.path,
      dev: t.file.dev,
      ino: t.file.ino,
      mode: t.mode,
      pre_sha256: sha256Of(t.base),
      pre_bytes: t.base.length,
      post_sha256: sha256Of(t.post),
      post_bytes: t.post.length,
      done: false,
      temp: null,
    })),
  };
  plan.targets.forEach((t, i) => {
    writeDurable(path.join(dir, `pre-${i}`), t.base);
    writeDurable(path.join(dir, `post-${i}`), t.post);
  });
  const save = () => writeDurable(path.join(dir, "journal.json"), `${JSON.stringify(journal)}\n`);
  save();
  pause("journal-written");
  plan.targets.forEach((t, i) => {
    const onTemp = (temp) => {
      journal.targets[i].temp = temp;
      save();
    };
    replaceFile(t.root, t.file.path, { expected: t.base, next: t.post, mode: t.mode, identity: { dev: t.file.dev, ino: t.file.ino }, onTemp, pause, index: i });
    journal.targets[i].done = true;
    journal.targets[i].temp = null; // renamed: it is the target now
    save();
    pause(`done-${i}`);
  });
  // The commit point: from here the apply is complete; recovery finishes it and never rolls back.
  journal.phase = "complete";
  save();
  pause("complete");
  try {
    new ReviewSetStore({ home }).markApplied(plan.set.review_set_id, plan.proposal);
    pause("marked-applied");
    retireJournal(home, dir, "applied", pause);
  } catch (e) {
    if (e instanceof ApplyError && e.code === "barrier") throw e;
    throw refusal("committed");
  }
  return plan.targets.length;
}

/**
 * Mark a committed apply's proposal applied, unless it already is. Returns a note when the record
 * is gone (expired: the files are complete); throws on any other error (the journal is kept).
 */
function markCommitted(home, id) {
  const store = new ReviewSetStore({ home });
  let found;
  try {
    found = store.findProposal(id);
  } catch (e) {
    if (e.code === "unknown") return "the proposal record is gone (expired); the files are complete";
    throw e;
  }
  if (found.proposal.status !== "applied") store.markApplied(found.set.review_set_id, found.proposal);
  return null;
}

/**
 * Step 6: the state of every unfinished apply, and with `choice` ("finish" or "roll-back") its
 * completion. Returns [{proposal_id, targets: [{label, state, outcome}], resolved, committed,
 * outcome, note, left}]: `committed` once the apply reached its commit point (then it is only
 * finished, never rolled back), `outcome` what was done ("finished", "rolled back", "cleared"),
 * `left` temporary-looking files that were not provably this apply's own, left for inspection.
 */
export function recover({ home, roots, choice = null, pause = () => {} }) {
  const out = [];
  for (const dir of journals(home)) {
    const retired = RETIRED_RE.exec(path.basename(dir));
    if (retired) {
      // Already resolved (the outcome is in the name); only emptying the folder was left.
      const [, id, how] = retired;
      const report = { proposal_id: id, targets: [], resolved: false, committed: how === "applied", outcome: null, note: null, left: [] };
      report.note =
        how === "applied"
          ? `already committed: every file was written${choice === "roll-back" ? ", so nothing was rolled back" : ""}`
          : `${how === "rolled-back" ? "every file's original contents were restored" : "interrupted before any file was written"}${choice ? "" : "; only removing its journal is left"}`;
      if (choice) {
        try {
          retireJournal(home, dir, how, pause);
          report.resolved = true;
          report.outcome = how === "applied" ? "finished" : how === "rolled-back" ? "rolled back" : "cleared";
        } catch {
          report.note += "; its journal folder could not be removed";
        }
      }
      out.push(report);
      continue;
    }
    const id = path.basename(dir);
    const jfile = path.join(dir, "journal.json");
    if (!fs.existsSync(jfile)) {
      // Interrupted while the journal was being written: no file was replaced yet. (A journal is
      // only ever removed after it was retired, so a missing record here always means this.)
      const report = { proposal_id: id, targets: [], resolved: false, committed: false, outcome: null, note: "interrupted before any file was written", left: [] };
      if (choice) {
        retireJournal(home, dir, "unwritten", pause);
        report.resolved = true;
        report.outcome = "cleared";
      }
      out.push(report);
      continue;
    }
    let j;
    try {
      j = validJournal(JSON.parse(readPrivate(jfile, JOURNAL_MAX).toString("utf8")));
    } catch (e) {
      out.push({ proposal_id: id, targets: [], resolved: false, committed: false, outcome: null, note: e instanceof ApplyError ? e.message : "the recovery journal could not be read; it was kept", left: [] });
      continue;
    }
    const report = { proposal_id: j.proposal_id, targets: [], resolved: false, committed: j.phase === "complete", outcome: null, note: null, left: [] };
    out.push(report);
    const save = () => writeDurable(jfile, `${JSON.stringify(j)}\n`);
    const items = j.targets.map((t) => ({ t, label: `${t.root_id}:${t.path}`, state: "unavailable", outcome: null, pre: null, post: null, root: null }));
    for (const item of items) {
      const root = roots.get(item.t.root_id);
      if (root && root.identity === item.t.root_identity) item.root = root;
    }

    // Temporary files: only the one this journal recorded, by exact identity, is removed.
    const tidy = () => {
      const recorded = new Map();
      for (const item of items) {
        if (!item.root) continue;
        let parent;
        try {
          parent = walk(item.root, item.t.path).chain.at(-1).dir;
        } catch {
          continue;
        }
        const temp = item.t.temp;
        if (temp) {
          const rel = path.posix.join(path.posix.dirname(item.t.path), temp.name);
          let r;
          try {
            r = removeTemp(path.join(parent, temp.name), temp);
          } catch {
            r = "left";
          }
          if (r === "left") report.left.push(`${item.t.root_id}:${rel}`);
          else {
            item.t.temp = null;
            save();
          }
          recorded.set(path.join(parent, temp.name), true);
        }
        // Names like ours that this journal did not record: reported, never removed.
        for (const n of listDir(parent)) {
          const full = path.join(parent, n);
          if (!TEMP_RE.test(n) || recorded.has(full)) continue;
          recorded.set(full, true);
          report.left.push(`${item.t.root_id}:${path.posix.join(path.posix.dirname(item.t.path), n)}`);
        }
      }
    };

    if (report.committed) {
      // Past the commit point: never rolled back; recovery only finishes marking and cleanup.
      report.note = choice === "roll-back" ? "already committed: every file was written, so nothing was rolled back" : "already committed: every file was written";
      if (choice) {
        try {
          tidy();
          const gone = markCommitted(home, j.proposal_id);
          if (gone) report.note += `; ${gone}`;
          retireJournal(home, dir, "applied", pause);
          report.resolved = true;
          report.outcome = "finished";
        } catch (e) {
          report.note += `; ${e instanceof ApplyError ? e.message : "marking the proposal applied or removing the journal failed; the journal was kept"}`;
        }
      }
      continue;
    }

    for (const item of items) {
      const t = item.t;
      try {
        item.pre = readPrivate(path.join(dir, `pre-${t.index}`), MAX_SET_CONTENT);
        item.post = readPrivate(path.join(dir, `post-${t.index}`), MAX_SET_CONTENT);
        if (sha256Of(item.pre) !== t.pre_sha256 || sha256Of(item.post) !== t.post_sha256) throw new Error("damaged");
      } catch {
        item.outcome = "the journal's copies are damaged; kept for inspection";
        item.root = null;
        continue;
      }
      if (!item.root) {
        item.outcome = "its approved folder is not configured or was replaced";
        continue;
      }
      try {
        const cur = readTarget(walk(item.root, t.path).file, item.root.dev).bytes;
        item.state = same(cur, item.post) ? "postimage" : same(cur, item.pre) ? "preimage" : "other";
      } catch (e) {
        item.state = "other";
        item.outcome = e instanceof ApplyError ? e.message : "it could not be read";
      }
    }
    if (choice) {
      tidy();
      const want = choice === "finish" ? "postimage" : "preimage";
      items.forEach((item, i) => {
        if (item.state === want) item.outcome ??= "already done";
        else if (item.state === "other") item.outcome ??= "it matches neither the original nor the proposed contents: halted for this file, nothing overwritten";
        else if (item.state !== "unavailable") {
          const onTemp = (temp) => {
            j.targets[i].temp = temp;
            save();
          };
          try {
            replaceFile(item.root, item.t.path, { expected: choice === "finish" ? item.pre : item.post, next: choice === "finish" ? item.post : item.pre, mode: item.t.mode, onTemp, pause, index: i });
            j.targets[i].temp = null;
            save();
            item.state = want;
            item.outcome = choice === "finish" ? "proposed contents written" : "original contents restored";
          } catch (e) {
            item.outcome = `halted: ${e instanceof ApplyError ? e.message : "it could not be written"}`;
          }
        }
      });
      if (items.every((x) => x.state === want)) {
        try {
          if (choice === "finish") {
            // The same commit point as an uninterrupted apply, then marking and cleanup.
            j.phase = "complete";
            save();
            report.committed = true;
            pause("recovered-complete");
            const gone = markCommitted(home, j.proposal_id);
            if (gone) report.note = gone;
          }
          retireJournal(home, dir, choice === "finish" ? "applied" : "rolled-back", pause);
          report.resolved = true;
          report.outcome = choice === "finish" ? "finished" : "rolled back";
        } catch (e) {
          if (e instanceof ApplyError && e.code === "barrier") throw e;
          report.note = "marking the proposal applied or removing the journal failed; the journal was kept";
        }
      }
    }
    report.targets = items.map((x) => ({ label: x.label, state: x.state, outcome: x.outcome }));
  }
  return out;
}

/** Pending proposals for the CLI listing. */
export function listPending(home, now = Date.now()) {
  return new ReviewSetStore({ home }).pending(now).map(({ set, proposal }) => ({
    proposal_id: proposal.proposal_id,
    review_set_id: set.review_set_id,
    from: proposal.sender.name,
    files: proposal.proposal.changes.map((c) => {
      const f = set.files.find((x) => x.file_id === c.file_id);
      return `${f.root_id}:${f.path} (${c.kind})`;
    }),
    received: new Date(proposal.received_at).toISOString(),
  }));
}

export { barrierFor, closeRoots, visible };
