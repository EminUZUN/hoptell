// Saving a staged transfer to a path the owner chose (design 6, "Save"). EXPERIMENTAL. CLI-only and
// owner-run (`hoptell save <t_id> <path> [--overwrite] [--yes]`); no MCP tool saves or opens
// anything.
//
// The destination's parent must exist; it is resolved once with realpath and shown. The bytes are
// copied from staging into a temporary file in that directory (.hoptell-save-<random>, O_EXCL,
// 0600), synced and hashed again. One save at a time per transfer: the save, its recovery, the
// staging cleanup and the ledger change for the entry hold <home>/saves/<t_id>.lock. The save
// journal, <home>/saves/<t_id>.json (the durable writer), moves through:
//   prepared  the destination, the mode (link or overwrite), the replaced file's device and inode
//             (overwrite), and the temporary path that will be created: written before the O_EXCL
//             create, so a file at that path can only come from this operation or a later stranger
//   created   the temporary file's device and inode: written after it was created, filled, synced
//             and hashed; from here on it is identified by its inode, even after a rename
//   placed    after the link or rename and a sync of the directory
//   done      after the temporary file is unlinked (link mode) and the directory synced again
// Success is reported only at done; then the staging copy is deleted (the entry becomes removed)
// and the journal is deleted. Without --overwrite, link(temp, destination) is the no-clobber check
// at the final operation. With --overwrite the replaced file is shown and confirmed, checked again
// (parent and inode), the temporary file is renamed over it and the result checked by inode.
// Recovery (hoptell doctor) decides from the journal and the inodes it finds, and deletes only a
// file whose path holds the inode recorded in `created`; a path in a journal alone is never reason
// enough. Remaining race (as in 5.2): Node has no renameat on a held directory handle, so a process
// of the owner's own account swapping the parent or the destination between the last check and
// the rename can redirect the rename within the owner's files; the inode check after it reports a
// swapped destination.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "./credentials.js";
import { savesDir } from "./transferin.js";
import { decodeHeader } from "./transferwire.js";

export class SaveError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
const refuse = (code, message, extra) => {
  throw new SaveError(code, message, extra);
};

export const journalFile = (home, t) => path.join(savesDir(home), `${t}.json`);
const T_RE = /^t_[0-9a-f]{24}$/;

function syncDir(dir, fault) {
  fault?.("dir-sync", dir);
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
const idOf = (st) => ({ dev: String(st.dev), ino: String(st.ino) });
const sameId = (st, id) => Boolean(st && id && String(st.dev) === id.dev && String(st.ino) === id.ino);
// The file the owner was shown: its identity, plus size and nanosecond times, since Linux reuses
// a freed inode number at once (a file deleted and recreated can have the same dev and ino).
export const shownOf = (st) => ({ ...idOf(st), size: Number(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) });
export const sameShown = (st, shown) => sameId(st, shown) && Number(st.size) === shown.size && String(st.mtimeNs) === shown.mtimeNs && String(st.ctimeNs) === shown.ctimeNs;
const sha256File = (p) => {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    let pos = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
};
/**
 * For recovery, in another process: whether `p` holds the file this save wrote. The device and
 * inode are not enough once the writer's descriptor is closed (Linux reuses a freed inode number),
 * so the birth time (when the file system keeps one), the size and the SHA-256 must match too. A
 * record without size and SHA-256 cannot tell, and matches nothing: it is reported, never acted on.
 */
function holdsSaved(p, id) {
  const st = lstatOrNull(p);
  if (!sameId(st, id) || !st.isFile()) return false;
  if (id.birth !== undefined && id.birth !== "0" && String(st.birthtimeNs) !== id.birth) return false;
  if (typeof id.size !== "string" || typeof id.sha256 !== "string" || String(st.size) !== id.size) return false;
  return sha256File(p) === id.sha256;
}

/** Read a save journal (null when there is none; a damaged one is reported, never guessed). */
export function readJournal(home, t) {
  let text;
  try {
    text = fs.readFileSync(journalFile(home, t), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    const j = JSON.parse(text);
    if (j?.v === 1 && j.t === t) return j;
  } catch {}
  return { v: 1, t, phase: "damaged" };
}
const writeJournal = (home, j, fault) => writeDurable(journalFile(home, j.t), `${JSON.stringify(j)}\n`, { fault: fault ? (p) => fault(`journal-${j.phase}-${p}`) : null });

/**
 * Resolve and check a destination: {parent (realpath), dest, existing: {dev, ino, size, mtimeMs,
 * ctimeMs} | null}.
 * The parent must exist and be a folder; a symlink (or dangling link) at the destination, or
 * anything but a regular file, is refused.
 */
export function resolveDestination(p) {
  if (typeof p !== "string" || !p || p.includes("\0")) refuse("bad_path", "the destination must be a path");
  const abs = path.resolve(p);
  const base = path.basename(abs);
  if (!base || base === "." || base === ".." || abs.endsWith(path.sep)) refuse("bad_path", "the destination must name a file");
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(abs));
  } catch {
    refuse("no_parent", `the destination's folder ${path.dirname(abs)} does not exist`);
  }
  if (!fs.statSync(parent).isDirectory()) refuse("no_parent", `${parent} is not a folder`);
  const dest = path.join(parent, base);
  const st = lstatOrNull(dest);
  if (st?.isSymbolicLink()) refuse("symlink", `${dest} is a symbolic link; hoptell does not save through links`);
  if (st && !st.isFile()) refuse("special", `${dest} is not a regular file (a folder, FIFO, socket or device)`);
  return { parent, dest, existing: st ? shownOf(st) : null };
}

/**
 * Save staged transfer `t` (of `staging`, lib/transferin.js) to `destination`. Without
 * `overwrite` an existing destination is refused at the link; with it, `confirm({dest,
 * existing})` must resolve true (unless `yes`). Resolves to {state: "saved", dest, bytes}; with
 * --overwrite, a failed directory sync after the rename resolves {state: "replaced_unconfirmed"}.
 * `fault(point)` is for tests.
 */
export async function saveTransfer({ home, staging, t, destination, overwrite = false, yes = false, confirm = async () => false, fault = null }) {
  if (!T_RE.test(t ?? "")) refuse("bad_request", "a transfer id is t_ and 24 hex digits (hoptell transfers)");
  const release = staging.saveLock(t);
  if (typeof release !== "function") refuse("locked", `a save or recovery of ${t} is in progress (process ${release.pid})`);
  let tempFd = null;
  try {
    if (readJournal(home, t)) refuse("journal", `a save of ${t} was interrupted; run hoptell doctor to finish or report it first`);
    const entry = staging.readLedger().entries[t];
    if (!entry || entry.state !== "staged") refuse("not_staged", entry ? `${t} is ${entry.state}, not staged` : `no staged transfer ${t} (hoptell transfers)`);
    const r = resolveDestination(destination);
    const mode = overwrite && r.existing ? "overwrite" : "link";
    if (mode === "overwrite" && !yes && !(await confirm({ dest: r.dest, existing: r.existing }))) refuse("not_confirmed", "nothing was saved");
    const src = staging.dataFile(t);
    const st = JSON.parse(fs.readFileSync(path.join(staging.folderOf(t), "descriptor.json"), "utf8"));
    const want = decodeHeader(Buffer.from(st.header, "hex")).plaintextSha256.toString("hex");
    const temp = path.join(r.parent, `.hoptell-save-${crypto.randomBytes(8).toString("hex")}`);
    // 1. prepared: written and synced before the temporary file is created.
    fs.mkdirSync(savesDir(home), { recursive: true, mode: 0o700 });
    const j = { v: 1, t, phase: "prepared", dest: r.dest, parent: r.parent, mode, ...(mode === "overwrite" ? { replaced: { dev: r.existing.dev, ino: r.existing.ino } } : {}), temp, at: Date.now() };
    writeJournal(home, j, fault);
    fault?.("after-prepared");
    // 2. created: the temporary file, filled, synced and hashed; then its identity is recorded. Its
    // descriptor stays open to the end, so its inode number cannot be reused meanwhile: a file
    // with that device and inode is this one.
    const fd = (tempFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
    fault?.("after-create");
    const hash = crypto.createHash("sha256");
    const inFd = fs.openSync(src, "r");
    try {
      const buf = Buffer.alloc(1024 * 1024);
      let n;
      let pos = 0;
      while ((n = fs.readSync(inFd, buf, 0, buf.length, pos)) > 0) {
        hash.update(buf.subarray(0, n));
        for (let off = 0; off < n; ) off += fs.writeSync(fd, buf, off, n - off);
        pos += n;
        fault?.("during-fill");
      }
    } finally {
      fs.closeSync(inFd);
    }
    fs.fsyncSync(fd);
    if (hash.digest("hex") !== want) refuse("hash", "the staging copy no longer matches the sender's digest; nothing was saved (run hoptell doctor)");
    fault?.("after-hash");
    const fst = fs.fstatSync(fd, { bigint: true });
    const id = { ...idOf(fst), birth: String(fst.birthtimeNs), size: String(fst.size), sha256: want };
    // A failure from here up to the created write leaves the file and the journal: recovery keeps
    // both as ambiguous (the file's identity is not recorded yet).
    fault?.("before-created");
    Object.assign(j, { phase: "created", temp_id: id });
    writeJournal(home, j, fault);
    fault?.("after-created");
    if (mode === "link") {
      try {
        fs.linkSync(temp, r.dest); // the no-clobber check, at the final operation
      } catch (e) {
        if (sameId(lstatOrNull(temp), id)) fs.unlinkSync(temp);
        syncDir(r.parent);
        fs.rmSync(journalFile(home, t), { force: true });
        if (e.code === "EEXIST") refuse("exists", `${r.dest} exists; nothing was replaced (use --overwrite to replace it)`);
        throw e;
      }
      fault?.("after-link");
      syncDir(r.parent, fault);
      Object.assign(j, { phase: "placed" });
      writeJournal(home, j, fault);
      if (sameId(lstatOrNull(temp), id)) fs.unlinkSync(temp);
      syncDir(r.parent, fault);
    } else {
      // After confirmation, checked again: the same parent, the same regular file.
      let again;
      try {
        again = fs.realpathSync(path.dirname(path.resolve(destination)));
      } catch {
        again = null;
      }
      const now = lstatOrNull(r.dest);
      if (again !== r.parent || !now?.isFile() || now.isSymbolicLink() || !sameShown(now, r.existing)) {
        if (sameId(lstatOrNull(temp), id)) fs.unlinkSync(temp);
        syncDir(r.parent);
        fs.rmSync(journalFile(home, t), { force: true });
        refuse("changed", `${r.dest} or its folder changed after you confirmed; nothing was saved`);
      }
      fs.renameSync(temp, r.dest);
      fault?.("after-rename");
      try {
        syncDir(r.parent, fault);
      } catch {
        // The rename succeeded: the destination is already replaced, its durability unknown.
        return { state: "replaced_unconfirmed", dest: r.dest, message: `${r.dest} was replaced, but not yet confirmed on disk: run hoptell doctor` };
      }
      if (!sameId(lstatOrNull(r.dest), id)) refuse("swapped", `${r.dest} does not hold the saved file after the rename (another process changed it); run hoptell doctor`);
      Object.assign(j, { phase: "placed" });
      writeJournal(home, j, fault);
    }
    // 4. done; then the ledger transition and the journal's deletion.
    Object.assign(j, { phase: "done" });
    writeJournal(home, j, fault);
    fault?.("after-done");
    await finish(home, staging, t, fault);
    return { state: "saved", dest: r.dest, bytes: entry.bytes };
  } finally {
    if (tempFd !== null) fs.closeSync(tempFd);
    release();
  }
}

/** After done: the entry saved, its staging copy deleted and synced, removed, the journal deleted (each step idempotent). */
async function finish(home, staging, t, fault) {
  await staging.change((l) => {
    const e = l.entries[t];
    if (e?.state === "staged") e.state = "saved";
  });
  const e = staging.readLedger().entries[t];
  if (e && e.state !== "removed") {
    fs.rmSync(staging.folderOf(t), { recursive: true, force: true });
    syncDir(path.dirname(staging.folderOf(t)));
    fault?.("after-staging-delete");
    await staging.change((l) => {
      const x = l.entries[t];
      if (x && x.state !== "removed") Object.assign(x, { state: "removed", removed_at: Date.now() });
    });
  }
  fault?.("before-journal-delete");
  fs.rmSync(journalFile(home, t), { force: true });
  syncDir(savesDir(home));
}

/**
 * Recover an interrupted save of `t` from its journal, under the save lock (hoptell doctor). One
 * ordered algorithm that never removes evidence before it has decided. Resolves to {state, message}:
 * "none" (no journal), "forgotten" (nothing was created), "ambiguous" (a file at the temporary path
 * whose identity was never recorded: kept and reported), "not_completed" (nothing placed; the
 * temporary file was removed), "saved" (finished), "attention" (reported; nothing deleted).
 */
export async function recoverSave({ home, staging, t, fault = null }) {
  const release = staging.saveLock(t);
  if (typeof release !== "function") refuse("locked", `a save or recovery of ${t} is in progress (process ${release.pid})`);
  try {
    const j = readJournal(home, t);
    if (!j) return { state: "none", message: `no interrupted save of ${t}` };
    if (j.phase === "damaged") return { state: "attention", message: `the save journal of ${t} is damaged; look at ${journalFile(home, t)} and the destination yourself (nothing was deleted)` };
    if (j.phase === "prepared") {
      if (j.ambiguous) return { state: "ambiguous", message: ambiguousText(j) };
      if (!lstatOrNull(j.temp)) {
        fs.rmSync(journalFile(home, t), { force: true });
        syncDir(savesDir(home));
        return { state: "forgotten", message: `the save of ${t} had not created anything; its record was dropped` };
      }
      Object.assign(j, { ambiguous: true });
      writeJournal(home, j, fault);
      return { state: "ambiguous", message: ambiguousText(j) };
    }
    if (j.phase === "created" || j.phase === "placed") {
      if (holdsSaved(j.dest, j.temp_id)) {
        syncDir(j.parent, fault);
        Object.assign(j, { phase: "placed" });
        writeJournal(home, j, fault);
        if (j.mode === "link" && holdsSaved(j.temp, j.temp_id)) fs.unlinkSync(j.temp);
        syncDir(j.parent, fault);
        Object.assign(j, { phase: "done" });
        writeJournal(home, j, fault);
      } else if (holdsSaved(j.temp, j.temp_id)) {
        fs.unlinkSync(j.temp);
        syncDir(j.parent, fault);
        fs.rmSync(journalFile(home, t), { force: true });
        syncDir(savesDir(home));
        return { state: "not_completed", message: `the save of ${t} did not complete; ${j.dest} was not changed by hoptell (the transfer is still staged: hoptell save again)` };
      } else {
        if (!j.attention) {
          Object.assign(j, { attention: true });
          writeJournal(home, j, fault);
        }
        return { state: "attention", message: `the save of ${t} cannot be resolved: neither ${j.dest} nor ${j.temp} holds the file it wrote; look at both (nothing was deleted), then hoptell save --forget ${t}` };
      }
    }
    if (j.phase === "done") {
      await finish(home, staging, t, fault);
      return { state: "saved", message: `the save of ${t} to ${j.dest} is complete` };
    }
    return { state: "attention", message: `the save journal of ${t} has an unknown phase; nothing was deleted` };
  } finally {
    release();
  }
}

const ambiguousText = (j) => `the save of ${j.t} was interrupted before it recorded its temporary file; ${j.temp} may be a partial or complete copy, or another program's file. hoptell keeps it: look at it, then hoptell save --forget ${j.t} (the file is never deleted)`;

/** Drop an ambiguous or unresolved save record once the owner has looked (never deletes a file). */
export function forgetSave({ home, staging, t }) {
  const release = staging.saveLock(t);
  if (typeof release !== "function") refuse("locked", `a save or recovery of ${t} is in progress (process ${release.pid})`);
  try {
    const j = readJournal(home, t);
    if (!j) refuse("none", `no save record of ${t}`);
    if (!(j.ambiguous || j.attention || j.phase === "damaged")) refuse("not_ambiguous", `the save of ${t} can still be recovered: run hoptell doctor`);
    fs.rmSync(journalFile(home, t), { force: true });
    syncDir(savesDir(home));
    return { state: "forgotten" };
  } finally {
    release();
  }
}

/** The save journals present (for doctor): [{t, phase, ambiguous?, attention?}]. */
export function listJournals(home) {
  let names = [];
  try {
    names = fs.readdirSync(savesDir(home)).filter((n) => /^t_[0-9a-f]{24}\.json$/.test(n));
  } catch {}
  return names.map((n) => readJournal(home, n.slice(0, -5))).filter(Boolean).map((j) => ({ t: j.t, phase: j.phase, ...(j.ambiguous ? { ambiguous: true } : {}), ...(j.attention ? { attention: true } : {}) }));
}
