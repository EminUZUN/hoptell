// Implementer worktrees (design 8, topic 2): `hoptell worktree add | list | diff | commit | remove`.
// An implementer edits files in a git worktree of its own and never commits; the lead commits its
// changes with the controlled runner of lib/gitsafe.js (no system or global configuration, an
// empty HOME, no inherited GIT_* routing) plus the pins below, so nothing the repository or its
// configuration selects runs: no hooks, filters, textconv, external diff or ssh command.
//
// The guarantee needs trusted, quiescent repository metadata (the main repository's .git): no
// implementer may be running (below). The configuration allow list and the recorded
// digests below are drift detection: they tell the owner something changed, they do not stop a
// change that races the check.
//
// `worktree add` writes a safety record per member in <home>/worktrees/<member>.json: the
// worktree's gitdir and commondir (read once, then never again from files in the worktree), the
// base, branch and last commit, the signing settings and the digest of info/attributes. Every
// other command fails closed without a matching record.
//
// Implementers run as the owner's user, and neither Codex's nor Claude Code's flags as launched
// here are shown to keep them away from that metadata. So no implementer of the repository may be
// running while hoptell runs git on it: `hoptell tmux` records each member session it starts in a
// member's worktree (its tmux session id and the identity of its pane's process, later also the
// processes it started), and every command first checks, under a lock of the repository that the
// launch takes too, that none of them is alive. An unknown state refuses.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NAME_RE, checkName, ensurePrivateDir } from "./config.js";
import { GitError, controlledGit, findGit } from "./gitsafe.js";
import { readPrivateFile, within } from "./agents.js";
import { withLock, writeRecord } from "./locks.js";
import { NOT_OFFERED } from "./capabilities.js";
import { currentBoot, descendantIdentities, identityState, processCwdsScan, processIdentity, processTable, startedAtMs } from "./host.js";

export const TEAM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const WORKTREE_CLIS = ["codex", "claude"];
const RECORD_MAX = 256 * 1024;
const MESSAGE_MAX = 64 * 1024;
const OWNS_MAX = 64;
const ADD_TIMEOUT_MS = 300_000; // a checkout of a large repository
const DIFF_CAP = 64 * 1024 * 1024;
const CAPTURE_MAX = 48 * 1024 * 1024; // the bytes of one commit's changed files, in all
const LOCK_WAIT_MS = 10_000;
const MIN_GIT = [2, 43]; // attr.tree came with Git 2.43
const CAPTURE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-helper.mjs");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const fail = (code, message) => {
  throw new GitError(code, message);
};

/** The worktree records and the runner's scratch folder in the hoptell home. */
export function worktreePaths(home) {
  const dir = path.join(home, "worktrees");
  return { dir, scratch: path.join(dir, "scratch"), sessions: path.join(dir, "sessions"), record: (member) => path.join(dir, `${checkName(member, "member name")}.json`), session: (member) => path.join(dir, "sessions", `${checkName(member, "member name")}.json`), repoLock: (common) => path.join(dir, `repo-${sha256(common).slice(0, 16)}`) };
}

// ---- configuration allow list ----------------------------------------------------------------

// core.* basics only: hooksPath, fsmonitor, sshCommand, pager, editor, askPass, worktree,
// attributesFile, alternateRefsCommand and the rest are refused.
const CORE = new Set(["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode", "core.symlinks"]);
const PLAIN = new Set(["extensions.worktreeconfig", "extensions.objectformat", "user.name", "user.email"]);
// SSH signing only, each with the value recorded at `worktree add`. tag.gpgsign is the owner's
// setting too (git never reads it for the commands hoptell runs); other gpg.* keys are refused,
// gpg.ssh.program included.
export const SIGNING = ["gpg.format", "user.signingkey", "gpg.ssh.allowedsignersfile", "commit.gpgsign", "tag.gpgsign"];

/** Is this configuration key on the allow list (signing keys checked separately)? */
export function keyAllowed(key) {
  if (CORE.has(key) || PLAIN.has(key) || SIGNING.includes(key)) return true;
  return /^(remote|branch)\..+\.[a-z0-9-]+$/i.test(key);
}

/** Parse `git config --list -z`: [[key, value|null]]. */
function parseConfigList(buf) {
  return buf
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((e) => {
      const nl = e.indexOf("\n");
      return nl < 0 ? [e, null] : [e.slice(0, nl), e.slice(nl + 1)];
    });
}

/**
 * Check the configuration files git reads for these commands (`files`, existing ones only) against
 * the allow list. Includes are not followed (--file), so an include.path shows up and is refused.
 * Returns the signing settings found ({key: [values]}); throws config_not_allowed.
 */
function checkConfig(g, files, cwd) {
  const signing = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const r = g.run(["config", "--file", file, "--list", "-z"], cwd);
    if (r.status !== 0) fail("config_unreadable", `the git configuration ${file} could not be read`);
    for (const [key, value] of parseConfigList(r.stdout)) {
      if (!keyAllowed(key)) fail("config_not_allowed", `${file} sets ${key}, which hoptell's git does not allow (it could run a program or change what git reads); remove it, or work in this repository without hoptell worktree`);
      if (SIGNING.includes(key)) (signing[key] ??= []).push(value);
    }
  }
  if (signing["gpg.format"] && signing["gpg.format"].some((v) => v !== "ssh")) fail("signing_not_supported", "hoptell supports SSH signing only (gpg.format=ssh)");
  return signing;
}

// The repository's own attributes file: read by git with the highest priority, so it is part of
// the trusted metadata. A driver selected there is refused at add; a change after it is drift.
function attributesState(common) {
  const file = path.join(common, "info", "attributes");
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    fail("attributes_unreadable", `${file} could not be read`);
  }
  return { file, digest: sha256(bytes), drivers: /\b(filter|diff|merge)\s*=|\btext\b|\beol\s*=|\bworking-tree-encoding\b/.test(bytes.toString("utf8")) };
}

// ---- small helpers ------------------------------------------------------------------------------

/**
 * The settings pinned for every worktree command, on top of lib/gitsafe.js's: attributes from an
 * empty tree (never the worktree's .gitattributes), no external diff, no ssh, no signing.
 * Command-line -c values win over repository configuration.
 */
export const worktreePins = (emptyTree = null) => ["diff.external=", "core.sshCommand=false", "commit.gpgsign=false", "tag.gpgsign=false", "log.showSignature=false", "color.ui=false", ...(emptyTree ? [`attr.tree=${emptyTree}`] : [])];

/** A runner for one repository: the gitsafe runner plus the worktree pins. */
function runner(home, { git = findGit(), emptyTree = null, timeoutMs } = {}) {
  const scratch = privateDirs(home).scratch;
  return controlledGit({ git, scratch, pins: worktreePins(emptyTree), ...(timeoutMs ? { timeoutMs } : {}), maxBuffer: DIFF_CAP });
}

/** The worktree folders of the home, created private. */
function privateDirs(home) {
  const paths = worktreePaths(home);
  for (const d of [home, paths.dir, paths.scratch, paths.sessions]) ensurePrivateDir(d);
  return paths;
}

const text = (r) => r.stdout.toString("utf8").trim();

/** Run and require success; `code`/`message` name the failure (never git's own text). */
function must(g, args, cwd, code, message, more) {
  const r = g.run(args, cwd, more?.input, more);
  if (r.status !== 0) fail(code, message);
  return r;
}

/** A glob of `owns` ("lib/**", "test/*.test.js") as a regular expression over a slash path. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/** Check and normalize `owns` (a list of globs, or null). */
export function checkOwns(owns) {
  if (owns == null) return null;
  if (!Array.isArray(owns) || !owns.length || owns.length > OWNS_MAX) fail("bad_owns", `owns is a list of 1 to ${OWNS_MAX} globs`);
  for (const o of owns) {
    if (typeof o !== "string" || !o || o.length > 256 || o.startsWith("/") || o.split("/").some((p) => p === ".." || p === ".") || o.includes("\0") || o.includes("\\")) fail("bad_owns", `"${String(o).slice(0, 60)}" is not a glob relative to the repository (no leading /, no . or .. parts)`);
  }
  return [...owns];
}

const outsideOwns = (paths, owns) => (owns ? paths.filter((p) => !owns.some((o) => globRe(o).test(p))) : []);

// ---- member sessions: who may write ----------------------------------------------------------

export const isIdentity = (x) => Boolean(x) && typeof x === "object" && Object.keys(x).length === 4 && Number.isSafeInteger(x.pid) && x.pid > 1 && typeof x.start === "string" && x.start !== "" && Number.isSafeInteger(x.uid) && typeof x.boot === "string";
const idKey = (id) => `${id.pid}@${id.start}`;
const SESSION_KEYS = ["member", "pane", "root", "sessionId", "started", "tree", "version"];
// firstLaunch {boot, start}: the pane process of the member's first launch on that boot, kept by
// every later launch on it (unplacedProcess). A record written before it existed has none.
const isLaunch = (x) => x === null || (Boolean(x) && typeof x === "object" && Object.keys(x).length === 2 && typeof x.boot === "string" && typeof x.start === "string" && x.start !== "");
const TREE_MAX = 512;

/** A member's session record: {rec}, {missing: true} or {problem}. */
function readSession(home, member) {
  const r = readPrivateFile(worktreePaths(home).session(member), RECORD_MAX);
  if (r.missing) return { missing: true };
  if (r.problem) return { problem: `its session record ${r.problem}` };
  let rec;
  try {
    rec = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    return { problem: "its session record is not valid JSON" };
  }
  const ok =
    rec &&
    typeof rec === "object" &&
    JSON.stringify(Object.keys(rec).filter((k) => k !== "firstLaunch").sort()) === JSON.stringify(SESSION_KEYS) &&
    (!Object.hasOwn(rec, "firstLaunch") || isLaunch(rec.firstLaunch)) &&
    rec.version === 1 &&
    rec.member === member &&
    /^\$\d+$/.test(rec.sessionId) &&
    /^%\d+$/.test(rec.pane) &&
    (rec.root === null || isIdentity(rec.root)) &&
    Array.isArray(rec.tree) &&
    rec.tree.length <= TREE_MAX &&
    rec.tree.every(isIdentity) &&
    typeof rec.started === "string";
  return ok ? { rec } : { problem: "its session record is malformed" };
}

/**
 * Is a member's session still running? {state: "stopped"} when `hoptell tmux` never started one in
 * its worktree, or when no process recorded for it (its pane's process and the processes seen
 * under it at earlier checks, each by pid, start, user and boot) is alive; {state: "running", why}
 * when one is (its current descendants are then added to the record, so they still count after
 * the pane's process exits, when `persist` is set: only under the repository's lock); {state:
 * "unknown", why} when that cannot be told.
 */
export function memberState(home, member, { table = processTable, state = identityState, persist = false } = {}) {
  const s = readSession(home, member);
  if (s.missing) return { state: "stopped" };
  if (s.problem) return { state: "unknown", why: s.problem };
  const rec = s.rec;
  if (!rec.root) return { state: "unknown", why: "its pane's process could not be identified when it started" };
  const t = table();
  if (!t) return { state: "unknown", why: "the process table could not be read" };
  const tree = new Map(rec.tree.map((id) => [idKey(id), id]));
  let running = false;
  let unknown = false;
  let changed = false;
  for (const id of [rec.root, ...rec.tree]) {
    const st = state(id);
    if (st === "same") {
      running = true;
      for (const d of descendantIdentities(id, { table: t })) {
        if (!tree.has(idKey(d)) && idKey(d) !== idKey(rec.root) && tree.size < TREE_MAX) {
          tree.set(idKey(d), d);
          changed = true;
        }
      }
    } else if (st === "unknown") unknown = true;
    else if (id !== rec.root && tree.delete(idKey(id))) changed = true;
  }
  if (changed && persist) writeRecord(worktreePaths(home).session(member), { ...rec, tree: [...tree.values()] }, 2);
  if (running) return { state: "running", why: `its tmux session ${rec.sessionId} or a process it started is still running` };
  if (unknown) return { state: "unknown", why: "a process recorded for it could not be checked" };
  return { state: "stopped" };
}

/** The pids of this process and its ancestors: the lead's own shell may stand in a worktree. */
function ownChain(table, self) {
  const out = new Set([self]);
  for (let p = table.get(self)?.ppid; p > 1 && !out.has(p); p = table.get(p)?.ppid) out.add(p);
  return out;
}

/**
 * What hoptell sees of the processes that could write a member's worktree, read once per check:
 * the process table and the working folder of every process of this user. Null fields when they
 * could not be read (the members then count as unknown).
 */
function observe({ table = processTable, cwds = null, self = process.pid, lsof = undefined, platform = undefined, timeoutMs = undefined, clock = () => performance.now() } = {}, records = []) {
  // timeoutMs: the time the whole observation may take (the reads' own limits otherwise): the
  // table gets all of it, the scan what the table left. Without a table, or time, no scan runs.
  const deadline = timeoutMs === undefined ? null : clock() + timeoutMs;
  const t = table({ timeoutMs });
  const left = deadline === null ? undefined : Math.floor(deadline - clock());
  let s;
  if (!t) s = { rows: null, problem: "the process table could not be read" };
  else if (left !== undefined && left <= 0) s = { rows: null, problem: "the time for the scan ran out" };
  else {
    // A test's cwds() gives the rows (or null); the scan gives the reason too (`lsof`, `platform`:
    // a test's stand-in for the real scan).
    const given = cwds?.({ timeoutMs: left });
    s = cwds ? (Array.isArray(given) || given == null ? { rows: given } : given) : processCwdsScan(process.getuid(), { lsof, platform, timeoutMs: left });
  }
  // records: the worktree records the check covers; first: per repository, the first launch of
  // its members (unplacedProcess).
  return { table: t, scan: s.rows, scanProblem: s.problem ?? null, unreadable: s.unreadable ?? [], chain: t ? ownChain(t, self) : null, records, first: new Map() };
}

/**
 * A member's state for the commands: its recorded session (memberState), and also any process of
 * this user (other than hoptell and its ancestors) whose working folder is in the worktree, such
 * as a command an agent's daemon runs there, wherever it is parented. A process that left the
 * worktree but still writes there is not seen: implementers must have quit, not only moved. A
 * process whose folder cannot be read even by its own user (seen.unreadable: a non-dumpable one,
 * which a member's process can become too) counts as unknown (unplacedProcess).
 */
function liveState(home, rec, seen, deps = {}, persist = false) {
  if (!seen.table) return { state: "unknown", why: "the process table could not be read" };
  const st = memberState(home, rec.member, { ...deps, table: () => seen.table, persist });
  if (st.state !== "stopped") return st;
  if (!seen.scan) return { state: "unknown", why: `the working folders of your processes could not be read (${seen.scanProblem ?? "lsof on macOS, /proc on Linux"})` };
  const stray = seen.scan.find((p) => !seen.chain.has(p.pid) && within(p.cwd, rec.path));
  if (stray) return { state: "running", why: `process ${stray.pid} (${stray.command || "unknown command"}) runs in its worktree, in ${stray.cwd}: if it is the implementer or something it started, quit it; if it is an unrelated shell of yours, cd out of the worktree` };
  const u = unplacedProcess(home, rec.common, seen);
  if (u) return { state: "unknown", unplaced: true, why: `process ${u.pid} (${u.command || "unknown command"}, started ${u.started}) of yours could not be inspected` };
  return st;
}

const UNREADABLE_RULE =
  "Processes you cannot inspect count unless they are older than the team's first launch or part of this command's own login. One of a later login (its systemd --user or sshd) counts until that login ends: end it, or wait for it to end";

/**
 * The first process of seen.unreadable that could be a member's, or null. A member can become
 * non-dumpable (a credential change, a daemon that hides itself), so hoptell places only two kinds:
 * hoptell's own ancestors (this command's login), and a process older than the first launch on
 * this boot of any member of the repository `common`, read in the same clock (Linux clock ticks:
 * unreadable folders are a Linux matter). Relaunches do not move that baseline (firstLaunch). With
 * no launch on this boot, no process of a member started by hoptell tmux can exist, so none counts;
 * with a boot or a launch time that cannot be compared, every one does.
 */
function unplacedProcess(home, common, seen) {
  if (!seen.unreadable.length) return null;
  if (!seen.first.has(common)) {
    const boot = currentBoot();
    const launches = seen.records.filter((r) => !r.problem && r.common === common).map((r) => launchOf(readSession(home, r.member).rec));
    const now = launches.filter((l) => l && boot && l.boot === boot);
    let first;
    if (!boot) first = "all";
    else if (!now.length) first = "none";
    else if (!now.every((l) => /^\d+$/.test(l.start))) first = "all";
    else first = now.map((l) => BigInt(l.start)).reduce((x, y) => (x < y ? x : y));
    seen.first.set(common, first);
  }
  const first = seen.first.get(common);
  if (first === "none") return null;
  for (const p of seen.unreadable) {
    // The start the scan read from that very process: the table, read before it, may show an
    // earlier process under a pid since reused, so a start it shows otherwise places nothing.
    const start = p.start;
    const listed = seen.table.get(p.pid)?.start;
    const same = /^\d+$/.test(start ?? "") && (listed === undefined || listed === start);
    if (same && listed !== undefined && seen.chain.has(p.pid)) continue;
    if (first !== "all" && same && BigInt(start) < first) continue;
    const ms = startedAtMs(start);
    return { ...p, started: ms === null ? "at an unknown time" : new Date(ms).toISOString() };
  }
  return null;
}

/** A session record's first launch ({boot, start}), or null; a record without one: its root's. */
function launchOf(rec) {
  if (!rec) return null;
  if (Object.hasOwn(rec, "firstLaunch")) return rec.firstLaunch;
  return rec.root ? { boot: rec.root.boot, start: rec.root.start } : null;
}

/**
 * A process of yours (other than hoptell and its ancestors) whose working folder is in `dir`:
 * {pid, command, cwd}, null when there is none, or {unknown: why}. `deps`: as for the commands;
 * `timeoutMs`: the budget of the whole observation (the table read and the scan together).
 */
export function processIn(dir, deps = {}, timeoutMs = undefined) {
  const seen = observe({ ...deps, timeoutMs });
  if (!seen.table || !seen.scan) return { unknown: seen.scanProblem ?? "the process table could not be read" };
  return seen.scan.find((p) => !seen.chain.has(p.pid) && within(p.cwd, dir)) ?? null;
}

/** The note on processes whose folder could not be read, for worktree list. */
const unreadableNote = (u) => {
  const names = [...new Set(u.map((p) => p.command).filter(Boolean))].slice(0, 3);
  return `${u.length} process${u.length === 1 ? "" : "es"} of yours could not be inspected${names.length ? ` (${names.join(", ")})` : ""}. ${UNREADABLE_RULE}.`;
};

/**
 * Refuse unless every implementer that shares the repository `common` is known to be stopped. A
 * record that cannot be read refuses too: its repository is unknown.
 */
function quietCheck(home, common, what, deps = {}) {
  const records = listWorktrees(home);
  for (const r of records) {
    if (r.problem) fail("record_invalid", `${r.problem}; hoptell cannot tell which repositories its records belong to, so it runs no git until the owner fixes ${r.member ? `or removes ${path.join(worktreePaths(home).dir, `${r.member}.json`)}` : "it"}`);
  }
  const mine = records.filter((r) => r.common === common);
  if (!mine.length) return;
  const seen = observe(deps, records);
  for (const r of mine) {
    const st = liveState(home, r, seen, deps, true);
    if (st.state === "running") fail("member_running", `${r.member} (${r.cli}) is still running (${st.why}). An implementer is not kept away from the repository's git metadata, so stop it, or let it quit, before ${what.startsWith("hoptell ") ? what : `hoptell worktree ${what}`}`);
    if (st.unplaced) fail("member_unknown", `hoptell cannot tell whether ${r.member} stopped: ${st.why}, so it runs no git on this repository. ${UNREADABLE_RULE}`);
    if (st.state === "unknown") fail("member_unknown", `hoptell cannot tell whether ${r.member} stopped (${st.why}), so it runs no git on this repository. Once you have checked that nothing of it runs, remove ${worktreePaths(home).session(r.member)}`);
  }
}

/**
 * Run `fn(recheck)` under the repository's lock (which `hoptell tmux` takes to start a member
 * there), after the quiet check; `recheck()` repeats it before a step that changes something.
 */
async function withQuietRepo(home, common, what, fn, deps = {}) {
  const paths = privateDirs(home);
  return withLock(
    paths.repoLock(common),
    async () => {
      quietCheck(home, common, what, deps);
      return fn(() => quietCheck(home, common, what, deps));
    },
    { waitMs: LOCK_WAIT_MS },
  );
}

/**
 * Start a member's session in its worktree (`hoptell tmux`): under the repository's lock, only
 * while `rec` is still the member's record and no earlier session of the member runs; then record
 * the session and its pane's process. `start()` writes the session's files and starts it; it
 * returns {sessionId, pane, pid}.
 */
export async function startMemberSession(home, rec, start, deps = {}) {
  const paths = privateDirs(home);
  return withLock(
    paths.repoLock(rec.common),
    async () => {
      // The registration the lock was picked by must still be the member's record.
      const now = readWorktreeRecord(home, rec.member);
      if (now.problem || !sameRegistration(now.rec, rec)) fail("record_changed", `the worktree record of ${rec.member} changed while hoptell waited for the repository's lock; nothing was started`);
      const st = memberState(home, rec.member, { ...deps, persist: true });
      if (st.state !== "stopped") fail("member_running", `an earlier session of ${rec.member} ${st.state === "running" ? "is still running" : "may still be running"} (${st.why})`);
      // The first launch on this boot stays the member's, whatever launches follow it.
      const before = launchOf(readSession(home, rec.member).rec);
      const record = (s) => {
        const root = processIdentity(Number(s.pid));
        const firstLaunch = before && before.boot === currentBoot() ? before : root ? { boot: root.boot, start: root.start } : null;
        writeRecord(paths.session(rec.member), { version: 1, member: rec.member, sessionId: s.sessionId, pane: s.pane, root, tree: [], started: new Date().toISOString(), firstLaunch }, 2);
      };
      let started;
      try {
        started = start();
      } catch (e) {
        // A pane that started and outlived its failed launch still counts.
        if (e.started) record(e.started);
        throw e;
      }
      record(started);
      return started;
    },
    { waitMs: LOCK_WAIT_MS },
  );
}

/** Refuse a Git without the CVE fix or older than 2.43 (attr.tree). Runs on every command. */
function checkGit(g) {
  const version = g.checkVersion("hoptell worktree");
  const [maj, min] = version.split(".").map(Number);
  if (maj < MIN_GIT[0] || (maj === MIN_GIT[0] && min < MIN_GIT[1])) fail("git_too_old", `hoptell worktree needs Git ${MIN_GIT.join(".")} or later (attr.tree); found ${version}`);
}

/** The common git folder of the repository around `dir`, from its files (no git run), or null. */
function locateCommon(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const dotgit = path.join(d, ".git");
    let st = null;
    try {
      st = fs.lstatSync(dotgit);
    } catch {}
    if (st?.isDirectory()) return fs.realpathSync(dotgit);
    if (st?.isFile()) {
      const gd = readGitFile(d);
      return gd ? (commonOf(gd) ?? gd) : null;
    }
    if (path.dirname(d) === d) return null;
  }
}

// ---- add --------------------------------------------------------------------------------------

/**
 * `hoptell worktree add <member> --team <team> --cli <codex|claude>`: a new worktree at
 * <repo parent>/<repo>-wt/<folder> on a new branch team/<team>/<member>, based on the lead's HEAD
 * (or `base`), and its safety record. `repo`: the lead's working folder; `parent`: another folder
 * for the worktree (the team file's `worktrees`). No member of the repository may be running.
 */
export async function addWorktree(home, { repo, member, team, cli, folder = null, base = null, owns = null, parent: parentDir = null }, { git = findGit(), now = () => new Date(), procs } = {}) {
  checkName(member, "member name");
  if (!TEAM_RE.test(team ?? "")) fail("bad_team", `invalid team name "${String(team ?? "").slice(0, 40)}": 1 to 32 lowercase letters, digits or "-", starting with a letter or digit`);
  if (NOT_OFFERED[cli]?.implementer) fail("not_offered", NOT_OFFERED[cli].implementer);
  if (!WORKTREE_CLIS.includes(cli)) fail("bad_cli", `--cli must be ${WORKTREE_CLIS.join(" or ")} (the implementer's CLI)`);
  if (folder != null && !NAME_RE.test(folder)) fail("bad_folder", `invalid folder name "${String(folder).slice(0, 40)}": letters, digits, "_" or "-"`);
  owns = checkOwns(owns);
  const branch = `team/${team}/${member}`;
  let cwd;
  try {
    cwd = fs.realpathSync(repo);
  } catch {
    fail("not_a_repository", `${repo} does not exist`);
  }
  // Found from the files, before any git runs: the repository whose members must be stopped.
  const guess = locateCommon(cwd);
  if (!guess) fail("not_a_repository", `${cwd} is not inside a git work tree`);
  const paths = privateDirs(home);
  return withLock(
    path.join(paths.dir, "add"),
    () =>
      withQuietRepo(
        home,
        guess,
        "add",
        async (recheck) => {
          if (fs.existsSync(paths.record(member))) fail("member_exists", `${member} already has a worktree (hoptell worktree list); remove it first`);
          let g = runner(home, { git });
          checkGit(g);
          const topR = g.run(["rev-parse", "--show-toplevel"], cwd);
          if (topR.status !== 0) fail("not_a_repository", `${cwd} is not inside a git work tree`);
          const lead = fs.realpathSync(text(topR));
          const common = fs.realpathSync(text(must(g, ["rev-parse", "--path-format=absolute", "--git-common-dir"], lead, "git_failed", "the repository's git folder could not be found")));
          if (common !== guess) fail("not_supported", `git names ${common} as the repository's git folder, not ${guess}; hoptell worktree does not support this layout`);
          const leadGitDir = fs.realpathSync(text(must(g, ["rev-parse", "--path-format=absolute", "--git-dir"], lead, "git_failed", "the repository's git folder could not be found")));
          if (path.basename(common) !== ".git") fail("not_supported", "hoptell worktree needs a repository with a .git folder (not a bare repository or a separate git folder)");
          const main = path.dirname(common);
          const format = text(must(g, ["rev-parse", "--show-object-format"], lead, "git_failed", "the repository's object format could not be read"));
          if (!OID[format]) fail("not_supported", `object format ${format} is not supported`);
          const emptyTree = text(must(g, ["hash-object", "-w", "-t", "tree", "--stdin"], lead, "git_failed", "the empty tree could not be written", { input: "" }));
          g = runner(home, { git, emptyTree, timeoutMs: ADD_TIMEOUT_MS });
          // The configuration the add itself reads: the repository's and the lead worktree's own.
          checkConfig(g, [...new Set([path.join(common, "config"), path.join(common, "config.worktree"), path.join(leadGitDir, "config.worktree")])], lead);
          const attributes = attributesState(common);
          if (attributes?.drivers) fail("attributes_not_allowed", `${attributes.file} selects a filter, diff or merge driver or a line-ending conversion; hoptell's git does not run these`);
          for (const k of ["user.name", "user.email"]) {
            if (g.run(["config", "--file", path.join(common, "config"), "--get", k], lead).status !== 0) fail("no_identity", `the repository's config has no ${k}; hoptell's git reads no global configuration, so set it with: git config ${k} "<value>"`);
          }
          const commit = text(must(g, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base ?? "HEAD"}^{commit}`], lead, "bad_base", base ? `${String(base).slice(0, 80)} is not a commit of this repository` : "the repository has no commit yet"));
          if (base == null) {
            const st = must(g, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=no", "--"], lead, "git_failed", "the lead's git status could not be read");
            if (st.stdout.length) fail("dirty_tree", `${lead} has uncommitted changes that would not be in the worktree; commit or stash them first, or name the base with --base <commit>`);
          }
          must(g, ["check-ref-format", "--branch", branch], lead, "bad_branch", `${branch} is not a valid branch name`);
          const had = readRef(g, lead, `refs/heads/${branch}`);
          if (had.state === "error") fail("ref_unreadable", `branch ${branch} could not be read (${had.why}); nothing was changed`);
          if (had.state === "present") fail("branch_exists", `branch ${branch} already exists; hoptell does not reuse a branch (delete it, or pick another member or team name)`);
          // The team file may name another folder for the worktrees; never inside the repository.
          const parent = parentDir == null ? path.join(path.dirname(main), `${path.basename(main)}-wt`) : path.resolve(parentDir);
          if (!path.isAbsolute(String(parentDir ?? parent)) || within(parent, main) || within(main, parent)) fail("bad_folder", `the worktrees folder ${parent} must be an absolute path outside the repository`);
          const target = path.join(parent, folder ?? member);
          if (fs.existsSync(target) || isLink(target)) fail("path_exists", `${target} already exists`);
          fs.mkdirSync(parent, { recursive: true });
          recheck();
          must(g, ["worktree", "add", "--no-track", "-b", branch, target, commit], lead, "add_failed", `git could not add the worktree at ${target}`);
          // The worktree's .git file and the gitdir's commondir: read once, here, into the record.
          const where = readGitFile(target);
          if (!where || !isInside(where, path.join(common, "worktrees"))) fail("add_failed", `${target}/.git does not name a folder under ${common}/worktrees`);
          if (commonOf(where) !== common) fail("add_failed", `the worktree's commondir does not lead back to ${common}`);
          // The signing state the member's commands will read: the repository's config and the
          // member's own config.worktree (git copies the lead's into it when worktreeConfig is on).
          const signing = checkConfig(g, [path.join(common, "config"), path.join(where, "config.worktree")], target);
          const rec = {
            version: 1,
            member,
            team,
            cli,
            branch,
            repo: main,
            lead,
            common,
            gitdir: where,
            path: fs.realpathSync(target),
            objectFormat: format,
            emptyTree,
            base: commit,
            head: commit,
            owns,
            signing,
            attributes: attributes?.digest ?? null,
            commits: [],
            created: now().toISOString(),
          };
          const problem = recordProblem(rec, member);
          if (problem) fail("add_failed", `the new record ${problem}`);
          writeRecord(paths.record(member), rec, 2);
          return rec;
        },
        procs,
      ),
    { waitMs: LOCK_WAIT_MS },
  );
}

const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// Containment of absolute, resolved paths: lib/agents.js within() (a "..cache" folder in a
// worktree is inside it); isInside excludes the folder itself.
const isInside = (p, dir) => p !== dir && within(p, dir);

/** The gitdir a worktree's .git file names (absolute, resolved), or null. */
function readGitFile(worktree) {
  try {
    const st = fs.lstatSync(path.join(worktree, ".git"));
    if (!st.isFile() || st.size > 4096) return null;
    const m = /^gitdir: (.+)\n?$/.exec(fs.readFileSync(path.join(worktree, ".git"), "utf8"));
    return m ? fs.realpathSync(path.resolve(worktree, m[1])) : null;
  } catch {
    return null;
  }
}

/** The common git folder a worktree gitdir's commondir file leads to (resolved), or null. */
function commonOf(gitdir) {
  try {
    return fs.realpathSync(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim()));
  } catch {
    return null;
  }
}

/**
 * The common git folder of the repository `repo` (its .git folder, or the one a linked worktree's
 * .git file leads to), resolved; null when it is neither. For team up's enrolment.
 */
export function commonDirOf(repo) {
  try {
    const st = fs.lstatSync(path.join(repo, ".git"));
    if (st.isDirectory()) return fs.realpathSync(path.join(repo, ".git"));
  } catch {
    return null;
  }
  const gd = readGitFile(repo);
  return gd ? commonOf(gd) : null;
}

// ---- records ----------------------------------------------------------------------------------

const OID = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };
const RECORD_KEYS = ["attributes", "base", "branch", "cli", "commits", "common", "created", "emptyTree", "gitdir", "head", "lead", "member", "objectFormat", "owns", "path", "repo", "signing", "team", "version"];
const COMMIT_KEYS = ["at", "commit", "files", "tree"];

/**
 * Is `p` an absolute path in its canonical form (normalized; resolved when it exists)? A path that
 * is gone still passes: the commands refuse a missing worktree themselves, and its record keeps
 * naming the repository whose members it counts.
 */
function canonical(p) {
  if (typeof p !== "string" || !path.isAbsolute(p) || path.resolve(p) !== p) return false;
  try {
    return fs.realpathSync(p) === p;
  } catch (e) {
    return e.code === "ENOENT";
  }
}

/** What is wrong with a safety record (every field checked, nothing missing or extra), or null. */
export function recordProblem(rec, member) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "is not an object";
  if (JSON.stringify(Object.keys(rec).sort()) !== JSON.stringify(RECORD_KEYS)) return "has missing or unknown fields";
  if (rec.version !== 1 || rec.member !== member) return "is not version 1 of this member's record";
  if (!TEAM_RE.test(String(rec.team)) || !WORKTREE_CLIS.includes(rec.cli) || rec.branch !== `team/${rec.team}/${member}`) return "has a malformed team, CLI or branch";
  const oid = OID[rec.objectFormat];
  if (!oid || ![rec.emptyTree, rec.base, rec.head].every((x) => typeof x === "string" && oid.test(x))) return "has a malformed object format or object id";
  if (![rec.repo, rec.common, rec.gitdir, rec.path, rec.lead].every(canonical)) return "has a path that is not absolute and canonical";
  if (rec.common !== path.join(rec.repo, ".git") || !isInside(rec.gitdir, path.join(rec.common, "worktrees"))) return "has git folders that do not belong together";
  if (rec.owns !== null) {
    try {
      if (JSON.stringify(checkOwns(rec.owns)) !== JSON.stringify(rec.owns)) return "has malformed owns";
    } catch {
      return "has malformed owns";
    }
  }
  if (!rec.signing || typeof rec.signing !== "object" || Array.isArray(rec.signing)) return "has malformed signing settings";
  for (const [k, v] of Object.entries(rec.signing)) {
    if (!SIGNING.includes(k) || !Array.isArray(v) || !v.length || !v.every((x) => x === null || typeof x === "string")) return "has malformed signing settings";
  }
  if (rec.attributes !== null && !/^[0-9a-f]{64}$/.test(String(rec.attributes))) return "has a malformed attributes digest";
  if (!Array.isArray(rec.commits)) return "has a malformed commit list";
  for (const c of rec.commits) {
    if (!c || typeof c !== "object" || JSON.stringify(Object.keys(c).sort()) !== JSON.stringify(COMMIT_KEYS) || !oid.test(String(c.commit)) || !oid.test(String(c.tree)) || !Number.isSafeInteger(c.files) || c.files < 1 || typeof c.at !== "string") return "has a malformed commit list";
  }
  if (typeof rec.created !== "string" || Number.isNaN(Date.parse(rec.created))) return "has a malformed creation time";
  return null;
}

/** A member's record with the file checks and the full schema check, or {problem}. */
export function readWorktreeRecord(home, member) {
  if (!NAME_RE.test(String(member ?? ""))) return { problem: `"${String(member ?? "").slice(0, 40)}" is not a member name` };
  const r = readPrivateFile(worktreePaths(home).record(member), RECORD_MAX);
  // absent: the record file does not exist (ENOENT), the only proof that a worktree is gone.
  if (r.problem) return r.missing ? { absent: true, problem: `${member} has no hoptell worktree (hoptell worktree list shows the members that have one)` } : { problem: `the worktree record of ${member} ${r.problem}` };
  let rec;
  try {
    rec = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    return { problem: `the worktree record of ${member} is not valid JSON` };
  }
  const problem = recordProblem(rec, member);
  return problem ? { problem: `the worktree record of ${member} ${problem}` } : { rec };
}

/**
 * Every member's record (unusable ones as {member, problem}). A registry folder that is absent
 * holds none; one that cannot be listed is one problem with member null, never an empty list.
 */
export function listWorktrees(home) {
  const dir = worktreePaths(home).dir;
  let names;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return [{ member: null, problem: `the worktree registry ${dir} is not a folder` }];
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    return [{ member: null, problem: `the worktree registry ${dir} could not be listed (${e.code ?? "error"})` }];
  }
  return names.map((member) => {
    const r = readWorktreeRecord(home, member);
    return r.rec ? { ...r.rec, exists: fs.existsSync(r.rec.path) } : { member, problem: r.problem };
  });
}

/**
 * The record whose worktree holds `dir` (resolved), or null: `hoptell tmux --cwd` checks names with
 * it. Throws record_invalid when the registry or any record cannot be read.
 */
export function worktreeAt(home, dir) {
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return null;
  }
  const rows = listWorktrees(home);
  const bad = rows.find((r) => r.problem);
  if (bad) fail("record_invalid", `${bad.problem}; hoptell cannot tell whether ${real} is a member's worktree, so it starts no session until the owner fixes it`);
  return rows.find((r) => within(real, r.path)) ?? null;
}

// The fields that tie a record to its repository and worktree.
const sameRegistration = (a, b) => ["member", "cli", "branch", "repo", "common", "gitdir", "path"].every((k) => a[k] === b[k]);

/** The registration a team keeps of a member's worktree (teams.js): these fields of its record. */
export const REGISTRATION_KEYS = ["repo", "common", "gitdir", "path", "branch"];
export const registrationOf = (rec) => Object.fromEntries(REGISTRATION_KEYS.map((k) => [k, rec[k]]));

/**
 * A member's record for a team's landing: the record, only while it is the worktree the team
 * registered (`bound`, from the team's state); a record of the same name for another repository
 * or worktree refuses before any git runs.
 */
function boundRecord(home, member, bound) {
  const rec = recordFor(home, member);
  if (!bound || !REGISTRATION_KEYS.every((k) => rec[k] === bound[k])) fail("not_this_team", `the worktree record of ${member} is for ${rec.repo} (${rec.path}), not the worktree this team registered${bound ? ` in ${bound.repo} (${bound.path})` : ""}; nothing was changed`);
  return rec;
}

/** A member's record for a command, before any git runs: the record, or a refusal. */
function recordFor(home, member) {
  const r = readWorktreeRecord(home, member);
  if (r.problem) fail("no_record", r.problem);
  return r.rec;
}

/**
 * Open a member's worktree for a command (inside withQuietRepo): the record, read again (the same
 * registration as `expect`, the record read before the lock) and re-checked against the repository (fails closed on any difference). Returns {rec, g, gd (the
 * --git-dir/--work-tree options)}.
 */
function openWorktree(home, member, { git = findGit(), expect }) {
  const rec = recordFor(home, member);
  // Read again under the lock: it must still be the record the lock was picked by.
  if (!sameRegistration(rec, expect)) fail("record_changed", `the worktree record of ${member} changed while hoptell waited for the repository's lock; nothing was run`);
  if (!fs.existsSync(rec.path)) fail("worktree_missing", `the worktree of ${member} (${rec.path}) is gone; its record stays for manual cleanup`);
  if (readGitFile(rec.path) !== rec.gitdir) fail("record_mismatch", `${rec.path}/.git no longer names the git folder recorded for ${member}; hoptell will not run git there`);
  if (commonOf(rec.gitdir) !== rec.common) fail("record_mismatch", `the git folder of ${member} no longer leads to ${rec.common}`);
  const g = runner(home, { git, emptyTree: rec.emptyTree });
  checkGit(g);
  const signing = checkConfig(g, [path.join(rec.common, "config"), path.join(rec.gitdir, "config.worktree")], rec.path);
  if (JSON.stringify(sortKeys(signing)) !== JSON.stringify(sortKeys(rec.signing))) fail("signing_changed", `the repository's signing settings changed since hoptell worktree add ${member}; hoptell will not run git there until the owner checks them`);
  if ((attributesState(rec.common)?.digest ?? null) !== rec.attributes) fail("attributes_changed", `${path.join(rec.common, "info", "attributes")} changed since hoptell worktree add ${member}; hoptell will not run git there until the owner checks it`);
  const gd = [`--git-dir=${rec.gitdir}`, `--work-tree=${rec.path}`];
  const sym = g.run([...gd, "symbolic-ref", "-q", "HEAD"], rec.path);
  if (sym.status !== 0 || text(sym) !== `refs/heads/${rec.branch}`) fail("head_moved", `the worktree of ${member} is no longer on ${rec.branch}`);
  const head = readRef(g, rec.repo, `refs/heads/${rec.branch}`);
  if (head.state === "error") fail("ref_unreadable", `${rec.branch} could not be read (${head.why}); nothing was run`);
  if (head.state !== "present" || head.oid !== rec.head) fail("head_moved", `${rec.branch} moved from ${rec.head} (the last commit hoptell recorded); hoptell commits only on that head`);
  return { rec, g, gd };
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** The changed paths of a worktree against its index and HEAD (untracked included). */
function changedPaths(g, gd, cwd) {
  return statusEntries(g, gd, cwd).map((e) => e.path);
}

/** The status entries of a worktree: [{code (the two status letters), path}]. */
function statusEntries(g, gd, cwd) {
  const r = must(g, [...gd, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=none", "--"], cwd, "git_failed", "git status failed in the worktree");
  return r.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((e) => ({ code: e.slice(0, 2), path: e.slice(3) }));
}

const CAPTURE_TEXT = {
  outside_worktree: (p) => `${p} is reached through a symbolic link; hoptell commits only files inside the worktree`,
  changed_during_capture: (p) => `${p} changed while hoptell read it; nothing was committed`,
  not_a_file: (p) => `${p} is a folder (a nested repository or submodule) or not a file; hoptell commits files and symbolic links only`,
  hard_link: (p) => `${p} has more than one hard link (it could be a file from outside the worktree); hoptell does not commit it`,
  other_device: (p) => `${p} is on another file system than the worktree; hoptell does not commit it`,
  too_large: () => `the changed files are over ${CAPTURE_MAX / 1024 / 1024} MiB in all`,
  root_changed: () => "the worktree folder changed while hoptell read it; nothing was committed",
};

/**
 * Read the changed paths of the worktree through lib/capture-helper.mjs (each folder opened
 * without following a link and checked by device and inode before it is entered; a link read as
 * a link in its own folder). `gone`: the paths git reports deleted; a folder that stands at one of
 * them now (a file replaced by a folder) is read as missing, and its files come as their own
 * paths. Returns the entries in `rels` order.
 */
function capture(rec, rels, { barrier = null, gone = [] } = {}) {
  for (const rel of rels) {
    if (rel.endsWith("/")) fail("not_a_file", CAPTURE_TEXT.not_a_file(rel));
    if (!rel || rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === "." || p === "")) fail("bad_path", `git reported a path hoptell does not accept: ${JSON.stringify(rel.slice(0, 120))}`);
  }
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(rec.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    fail("worktree_missing", `the worktree folder ${rec.path} could not be opened`);
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const r = spawnSync(process.execPath, [CAPTURE_HELPER], {
      cwd: rec.path,
      env: barrier ? { HOPTELL_CAPTURE_TEST_BARRIER: barrier } : {},
      input: JSON.stringify({ paths: rels, gone, root: rec.path, rootDev: String(st.dev), rootIno: String(st.ino), maxBytes: CAPTURE_MAX }),
      stdio: ["pipe", "pipe", "pipe", fd],
      maxBuffer: Math.ceil((CAPTURE_MAX * 4) / 3) + 1024 * 1024 + rels.length * 1024,
      timeout: ADD_TIMEOUT_MS,
      shell: false,
    });
    let out = null;
    try {
      out = JSON.parse(r.stdout.toString("utf8"));
    } catch {}
    if (!out) fail("capture_failed", "the worktree's files could not be read");
    if (!out.ok) fail(out.code === "capture_failed" || !CAPTURE_TEXT[out.code] ? "capture_failed" : out.code, (CAPTURE_TEXT[out.code] ?? (() => `the worktree's files could not be read${out.path ? ` (at ${out.path})` : ""}`))(out.path));
    if (!Array.isArray(out.entries) || out.entries.length !== rels.length || out.entries.some((e, i) => e.path !== rels[i])) fail("capture_failed", "the worktree's files could not be read");
    return out.entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** The index line of one captured entry: "<mode> <id>\t<path>", or a deletion. */
function indexLine(g, gd, rec, e) {
  if (e.kind === "missing") return `0 ${"0".repeat(rec.objectFormat === "sha256" ? 64 : 40)}\t${e.path}`;
  const mode = e.kind === "link" ? "120000" : e.exec ? "100755" : "100644";
  // The bytes as read: --no-filters, from stdin, so git opens no path of the worktree.
  const id = text(must(g, [...gd, "hash-object", "-w", "--no-filters", "--stdin"], rec.path, "git_failed", `git could not store ${e.path}`, { input: Buffer.from(e.data, "base64") }));
  return `${mode} ${id}\t${e.path}`;
}

// ---- commit, diff, remove -------------------------------------------------------------------------

/**
 * `hoptell worktree commit <member> -m <message>`: commit every change of the member's worktree
 * (untracked files included, ignored ones not) on its branch, with plumbing that runs no filter:
 * the files read through the capture helper, hash-object --no-filters, a private index,
 * write-tree, commit-tree, a compare-and-swap of the branch. Unsigned (working commits). Files
 * outside the record's `owns` are refused unless `allowOutside`. No member of the repository may
 * be running. Returns {commit, files, outside, branch}.
 */
export async function commitWorktree(home, member, { message, allowOutside = false }, { git = findGit(), now = () => new Date(), procs, captureBarrier = null } = {}) {
  if (typeof message !== "string" || !message.trim()) fail("no_message", "a commit needs a message (-m)");
  if (Buffer.byteLength(message) > MESSAGE_MAX || message.includes("\0")) fail("bad_message", `the message is over ${MESSAGE_MAX} bytes or contains a NUL`);
  const first = recordFor(home, member);
  const paths = privateDirs(home);
  return withQuietRepo(
    home,
    first.common,
    "commit",
    async (recheck) => {
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      const entries = statusEntries(g, gd, rec.path);
      if (!entries.length) fail("nothing_to_commit", `the worktree of ${member} has no changes`);
      const changed = entries.map((e) => e.path);
      const gone = entries.filter((e) => e.code.includes("D")).map((e) => e.path);
      const lines = capture(rec, changed, { barrier: captureBarrier, gone }).map((e) => indexLine(g, gd, rec, e));
      const index = path.join(paths.scratch, `index-${crypto.randomBytes(6).toString("hex")}`);
      const env = { GIT_INDEX_FILE: index };
      try {
        must(g, [...gd, "read-tree", rec.head], rec.path, "git_failed", "git could not read the branch head into a private index", { env });
        must(g, [...gd, "update-index", "-z", "--index-info"], rec.path, "git_failed", "git could not stage the changes in the private index", { env, input: lines.map((l) => `${l}\0`).join("") });
        // The complete delta of the private index from the head, right before the commit.
        const delta = must(g, [...gd, "diff-index", "--cached", "--name-only", "-z", "--no-renames", rec.head, "--"], rec.path, "git_failed", "git could not list the staged changes", { env });
        const files = delta.stdout.toString("utf8").split("\0").filter(Boolean);
        if (!files.length) fail("nothing_to_commit", `the changes of ${member} leave its branch unchanged`);
        const outside = outsideOwns(files, rec.owns);
        if (outside.length && !allowOutside) fail("outside_owns", `these files are outside what ${member} owns (${rec.owns.join(", ")}): ${outside.slice(0, 20).join(", ")}${outside.length > 20 ? ", ..." : ""}; commit with --allow-outside if that is intended`);
        const tree = text(must(g, [...gd, "write-tree"], rec.path, "git_failed", "git could not write the tree", { env }));
        const commit = text(must(g, [...gd, "commit-tree", "--no-gpg-sign", "-p", rec.head, "-F", "-", tree], rec.path, "git_failed", "git could not create the commit", { input: message.endsWith("\n") ? message : `${message}\n` }));
        recheck();
        must(g, [...gd, "update-ref", "--no-deref", "-m", "hoptell worktree commit", `refs/heads/${rec.branch}`, commit, rec.head], rec.path, "head_moved", `${rec.branch} moved while committing; nothing was changed`);
        const next = { ...rec, head: commit, commits: [...rec.commits, { commit, tree, files: files.length, at: now().toISOString() }] };
        writeRecord(paths.record(member), next, 2);
        // The worktree's own index follows the branch, so its status shows what is left.
        g.run([...gd, "read-tree", commit], rec.path);
        g.run([...gd, "update-index", "-q", "--refresh"], rec.path);
        return { commit, files, outside, branch: rec.branch };
      } finally {
        fs.rmSync(index, { force: true });
        fs.rmSync(`${index}.lock`, { force: true });
      }
    },
    procs,
  );
}

/**
 * `hoptell worktree diff <member> [--stat]`: the patch of the member's commits, base..head, with
 * no external diff and no textconv. No member of the repository may be running.
 * Returns {base, head, branch, text}.
 */
export async function diffWorktree(home, member, { stat = false } = {}, { git = findGit(), procs } = {}) {
  const first = recordFor(home, member);
  return withQuietRepo(
    home,
    first.common,
    "diff",
    async (recheck) => {
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      const args = stat ? ["--stat"] : ["--binary", "--full-index"];
      const r = must(g, [...gd, "--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", ...args, rec.base, rec.head, "--"], rec.path, "git_failed", "git diff failed (or its output is over 64 MiB)");
      recheck();
      return { base: rec.base, head: rec.head, branch: rec.branch, text: r.stdout.toString("utf8") };
    },
    procs,
  );
}

/**
 * `hoptell worktree remove <member>`: only while no member of the repository runs, the worktree
 * is clean and the branch is still at the recorded head. The branch is deleted only when it holds
 * no commit of the member (head = base), with a compare-and-delete; otherwise it is kept and named.
 */
export async function removeWorktree(home, member, { git = findGit(), procs, landed = null, bound = null } = {}) {
  // `bound`: the registration a team kept of this worktree (team down); the record must still be it.
  const first = bound ? boundRecord(home, member, bound) : recordFor(home, member);
  return withQuietRepo(
    home,
    first.common,
    "remove",
    async (recheck) => {
      if (bound) boundRecord(home, member, bound);
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      return removeOpened(home, rec, g, gd, recheck, landed);
    },
    procs,
  );
}

/**
 * Remove an opened worktree (under the repository's lock): only a clean one. Its branch is
 * deleted with a compare-and-delete when it holds no commit of the member (head = base), or when
 * `landed` ({head, candidate, target}: hoptell's record that this head landed as `candidate` on
 * `target`) still holds: the head is the one that landed and the candidate is in the target.
 * Landing is never inferred from the patches. Otherwise the branch is kept, with the reason.
 */
function removeOpened(home, rec, g, gd, recheck, landed) {
  const paths = privateDirs(home);
  const changed = changedPaths(g, gd, rec.path);
  if (changed.length) fail("dirty_tree", `the worktree of ${rec.member} has ${changed.length} uncommitted change${changed.length > 1 ? "s" : ""} (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""}); commit them with hoptell worktree commit, or clean up by hand`);
  let deleteAt = null;
  let reason = "it has commits that hoptell has no record of landing";
  if (rec.head === rec.base) deleteAt = rec.base;
  else if (landed) {
    const oid = OID[rec.objectFormat];
    if (landed.head !== rec.head) reason = `its head ${rec.head.slice(0, 12)} is not the one that landed (${String(landed.head).slice(0, 12)})`;
    else if (!oid.test(String(landed.candidate)) || !/^[\w./-]+$/.test(String(landed.target)) || !isAncestorOf(g, rec.repo, landed.candidate, `refs/heads/${landed.target}`)) reason = `the landed commit ${String(landed.candidate).slice(0, 12)} is not in ${landed.target}`;
    else deleteAt = rec.head;
  }
  recheck();
  must(g, ["worktree", "remove", rec.path], rec.repo, "remove_failed", `git could not remove the worktree at ${rec.path} (it refuses ignored or locked content; clean up by hand)`);
  let branch = "kept";
  if (deleteAt) branch = g.run(["update-ref", "--no-deref", "-d", `refs/heads/${rec.branch}`, deleteAt], rec.repo).status === 0 ? "deleted" : "kept";
  if (branch === "kept" && deleteAt) reason = `${rec.branch} moved`;
  fs.rmSync(paths.record(rec.member), { force: true });
  fs.rmSync(paths.session(rec.member), { force: true });
  return { path: rec.path, branch: rec.branch, head: rec.head, branchState: branch, keptBecause: branch === "kept" ? reason : null };
}

/**
 * Git status of a member's worktree for `hoptell team status`, only while the repository is
 * quiet: {changed, outside} or {skipped: reason}. Nothing runs git otherwise.
 */
export async function worktreeStatus(home, member, { git = findGit(), procs, bound = null } = {}) {
  try {
    const first = bound ? boundRecord(home, member, bound) : recordFor(home, member);
    return await withQuietRepo(
      home,
      first.common,
      "hoptell team status reads the repository",
      async () => {
        if (bound) boundRecord(home, member, bound);
        const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
        const changed = changedPaths(g, gd, rec.path);
        return { changed, outside: outsideOwns(changed, rec.owns) };
      },
      procs,
    );
  } catch (e) {
    if (e instanceof GitError || e.code === "busy") return { skipped: e.message };
    throw e;
  }
}

// ---- landing --------------------------------------------------------------------------------------

// Landing (design 8, topic 2, "Merging back"; owner decision 4): the owner runs it. hoptell
// builds a candidate C, a squash of the member's reviewed head with parent T (the target's
// commit), only when the member's base is T: no merge machinery runs. C is signed with the SSH
// settings recorded at worktree add (a fixed ssh-keygen; the key path's "~" expanded here, since
// the runner's HOME is empty) and verified. After the owner approved exactly (T, C), hoptell
// moves the target from T to C by compare-and-swap, or, when exactly one clean worktree has it
// checked out, by a guarded git merge --ff-only there (landAction, under a landing action).

const SSH_KEYGEN = ["/usr/bin/ssh-keygen", "/bin/ssh-keygen", "/usr/local/bin/ssh-keygen", "/opt/homebrew/bin/ssh-keygen"];

/** The signing pins of a record: {sign, verify} -c lists; refuses without recorded SSH signing. */
function signingPins(rec, { homedir, keygen = SSH_KEYGEN.find((p) => fs.existsSync(p)) }) {
  const last = (k) => rec.signing[k]?.at(-1) ?? null;
  const expand = (p) => (typeof p === "string" && p.startsWith("~/") && homedir ? path.join(homedir, p.slice(2)) : p);
  const key = expand(last("user.signingkey"));
  const allowed = expand(last("gpg.ssh.allowedsignersfile"));
  if (last("gpg.format") !== "ssh" || !key || !allowed) fail("signing_required", "landing signs the candidate with the repository's SSH signing settings (gpg.format=ssh, user.signingkey, gpg.ssh.allowedSignersFile), recorded at hoptell worktree add; this worktree's record has none");
  if (!keygen) fail("signing_required", `ssh-keygen was not found at ${SSH_KEYGEN.join(", ")}`);
  const common = ["gpg.format=ssh", `gpg.ssh.program=${keygen}`];
  return { sign: [...common, `user.signingkey=${key}`].flatMap((p) => ["-c", p]), verify: [...common, `gpg.ssh.allowedSignersFile=${allowed}`].flatMap((p) => ["-c", p]) };
}

const checkTarget = (target) => {
  if (typeof target !== "string" || !/^[A-Za-z0-9][\w./-]{0,199}$/.test(target) || target.includes("..") || target.startsWith("team/")) fail("bad_target", `"${String(target).slice(0, 60)}" is not a target branch name (a branch such as main; not a team branch)`);
  return target;
};

/** How a git call ended, for a message: its status (or signal) and the last line it printed. */
const ended = (r) => `${r.status === null ? "stopped by a signal" : `status ${r.status}`}${String(r.stderr ?? "").trim() ? `: ${String(r.stderr).trim().split("\n").at(-1).slice(0, 200)}` : ""}`;

/**
 * Read one full ref name, the one way hoptell reads the branches it decides on (the target, the
 * candidate branch, a member's branch): {state: "present", oid}, {state: "absent"}, or
 * {state: "error", why}. Only clean answers count: git for-each-ref with status 0, nothing on
 * stderr (git warns about a broken ref, skips it and still ends with 0) and exactly one line for
 * this ref, or no output at all; and git symbolic-ref -q with status 1 (not symbolic). A symbolic
 * ref is never followed: it is an error, like any other answer, a signal or a run that failed.
 */
function readRef(g, repo, ref) {
  let r;
  let sym;
  try {
    r = g.run(["for-each-ref", "--format=%(objectname) %(refname) %(symref)", ref], repo);
    sym = g.run(["symbolic-ref", "-q", ref], repo);
  } catch (e) {
    return { state: "error", why: `git could not run (${e.message})` };
  }
  if (sym.status === 0) return { state: "error", why: `${ref} is a symbolic ref; hoptell does not follow it` };
  if (r.status !== 0) return { state: "error", why: `git for-each-ref ended with ${ended(r)}` };
  if (r.stderr.length) return { state: "error", why: `git for-each-ref warned: ${String(r.stderr).trim().split("\n").at(-1).slice(0, 200)}` };
  if (sym.status !== 1 || sym.stdout.length || sym.stderr.length) return { state: "error", why: `git symbolic-ref ended with ${ended(sym)}` };
  const out = r.stdout.toString("utf8");
  if (out === "") return { state: "absent" };
  const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+) \n$/.exec(out);
  if (!m || m[2] !== ref) return { state: "error", why: `git for-each-ref gave an unexpected answer for ${ref}` };
  return { state: "present", oid: m[1] };
}

/** Whether `commit` is in `ref` (read with readRef, never through a symbolic ref). */
function isAncestorOf(g, repo, commit, ref) {
  const r = readRef(g, repo, ref);
  return r.state === "present" && g.run(["merge-base", "--is-ancestor", commit, r.oid], repo).status === 0;
}

/**
 * Every checkout of `branch`: [{at, gitDir, foreign}] (realpaths), one per worktree whose HEAD is
 * refs/heads/<branch>, the main one included. The git folder is read from the folder itself and
 * must belong to `common`, the repository the team enrolled: the main worktree's .git is that
 * folder; a linked one's .git file leads to <common>/worktrees/<name>, whose commondir leads back
 * to `common` and whose gitdir file names this folder's .git. Otherwise `foreign` says why (a
 * folder replaced by another clone, for one) and hoptell runs no git there. A missing folder
 * still counts, as foreign: git still holds the branch there.
 */
function checkedOutAt(g, repo, branch, common) {
  const out = must(g, ["worktree", "list", "--porcelain", "-z"], repo, "git_failed", "git could not list the worktrees").stdout.toString("utf8");
  const found = [];
  for (const block of out.split("\0\0")) {
    const lines = block.split("\0");
    const wt = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!wt || !lines.includes(`branch refs/heads/${branch}`)) continue;
    found.push(checkoutOf(wt, common));
  }
  return found;
}

/** A checkout folder and its git folder, checked against `common` (see checkedOutAt). */
function checkoutOf(wt, common) {
  let at;
  try {
    at = fs.realpathSync(wt);
  } catch {
    return { at: wt, gitDir: null, foreign: `${wt} is missing` };
  }
  const not = (why) => ({ at, gitDir: null, foreign: `${at} is not a worktree of ${common} (${why}); hoptell runs no git there` });
  let st;
  try {
    st = fs.lstatSync(path.join(at, ".git"));
  } catch {
    return not("it has no .git");
  }
  if (st.isDirectory()) return realOr(path.join(at, ".git")) === common ? { at, gitDir: common, foreign: null } : not("its .git is another repository");
  const gd = readGitFile(at);
  if (!gd) return not("its .git file could not be read");
  if (path.dirname(gd) !== path.join(common, "worktrees")) return not(`its .git leads to ${gd}`);
  if (commonOf(gd) !== common) return not("its git folder leads to another repository");
  let back;
  try {
    back = fs.realpathSync(path.resolve(gd, fs.readFileSync(path.join(gd, "gitdir"), "utf8").trim()));
  } catch {
    return not("its git folder does not name it back");
  }
  if (back !== realOr(path.join(at, ".git"))) return not("its git folder names another folder");
  return { at, gitDir: gd, foreign: null };
}
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// The operations git leaves in progress in a git folder: their marker file or folder there.
const IN_PROGRESS = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase or am"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

/**
 * What stands in the way of moving the checkout `co` ({at, gitDir}) of `target`, read with
 * hoptell's git there: a list of reasons, empty when its symbolic HEAD is refs/heads/<target>,
 * HEAD is `oid`, the index matches `oid`'s tree, nothing is changed (untracked files aside) or
 * unmerged, and no merge, rebase, cherry-pick, revert or bisect is in progress. Its own
 * config.worktree must pass the same allow list as the repository's.
 */
function checkoutProblems(g, co, target, oid) {
  if (co.foreign || !co.gitDir) return [co.foreign ?? `${co.at} could not be opened`];
  checkConfig(g, [path.join(co.gitDir, "config.worktree")], co.at);
  const gd = [`--git-dir=${co.gitDir}`, `--work-tree=${co.at}`];
  const problems = [];
  const sym = g.run([...gd, "symbolic-ref", "-q", "HEAD"], co.at);
  if (sym.status !== 0 || text(sym) !== `refs/heads/${target}`) problems.push(`its HEAD is ${sym.status === 0 ? text(sym) : "not a branch"}, not refs/heads/${target}`);
  const head = g.run([...gd, "rev-parse", "--verify", "-q", "HEAD"], co.at);
  if (head.status !== 0 || text(head) !== oid) problems.push(`its HEAD is ${head.status === 0 ? `at ${text(head).slice(0, 12)}` : "unreadable"}, not at ${oid.slice(0, 12)}`);
  const ops = IN_PROGRESS.filter(([f]) => fs.existsSync(path.join(co.gitDir, f))).map(([, what]) => what);
  if (ops.length) problems.push(`a ${ops.join(" and a ")} is in progress there`);
  const st = g.run([...gd, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=no", "--ignore-submodules=none", "--"], co.at);
  if (st.status !== 0) problems.push(`git status could not be read there (${ended(st)})`);
  else {
    const entries = st.stdout.toString("utf8").split("\0").filter(Boolean);
    const unmerged = entries.filter((e) => /^(?:U.|.U|AA|DD)/.test(e));
    if (entries.length) problems.push(`it has ${entries.length} uncommitted change${entries.length === 1 ? "" : "s"}${unmerged.length ? ` (${unmerged.length} unmerged)` : ""}: ${entries.slice(0, 5).map((e) => e.slice(3)).join(", ")}${entries.length > 5 ? ", ..." : ""}`);
  }
  const index = g.run([...gd, "--no-optional-locks", "diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", oid, "--"], co.at);
  if (index.status !== 0 && !problems.some((p) => p.includes("uncommitted"))) problems.push(`its index does not match ${oid.slice(0, 12)}`);
  return problems;
}

/**
 * Files a landing from T to C would add where the checkout `co` already has something untracked
 * or ignored: git would refuse or overwrite them, and hoptell neither deletes nor stashes them.
 * Paths T tracks are not obstructions (the checkout is clean, so they hold T's content): a
 * tracked file that C replaces by a folder, or a tracked folder that C replaces by a file, is
 * the landing's own change; such a folder still blocks when it holds anything T does not track.
 * The paths are read in the repository `repo`.
 */
function inTheWay(g, repo, co, T, C) {
  const list = (args, what) =>
    must(g, args, repo, "git_failed", what)
      .stdout.toString("utf8")
      .split("\0")
      .filter(Boolean);
  const added = list(["diff-tree", "-r", "-z", "--no-renames", "--name-only", "--diff-filter=A", T, C, "--"], "the candidate's added files could not be listed");
  if (!added.length) return [];
  const tracked = new Set(list(["ls-tree", "-r", "-z", "--name-only", "--full-tree", T], "the target's files could not be listed"));
  const problems = [];
  for (const p of added) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const q = parts.slice(0, i).join("/");
      let st;
      try {
        st = fs.lstatSync(path.join(co.at, q));
      } catch {
        break; // nothing there: nothing below it either
      }
      if (tracked.has(q)) break; // a file of T that C replaces
      if (!st.isDirectory()) {
        problems.push(`${q} exists there untracked or ignored, where the landing adds ${p}`);
        break;
      }
      if (i === parts.length) {
        // A folder where C adds a file: only T's own files may be in it.
        const stray = untrackedIn(path.join(co.at, q), q, tracked);
        if (stray) problems.push(`${stray} exists there untracked or ignored, in ${q}, which the landing replaces by a file`);
      }
    }
  }
  return problems.length > 5 ? [...problems.slice(0, 5), `and ${problems.length - 5} more such files`] : problems;
}

/** The first file under `dir` (relative path `rel`) that `tracked` does not have, or null. Bounded. */
function untrackedIn(dir, rel, tracked) {
  const queue = [[dir, rel]];
  let seen = 0;
  while (queue.length) {
    const [d, r] = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return `${r} (it could not be read)`;
    }
    for (const e of entries) {
      if (++seen > 100_000) return `${r} (too many files to check)`;
      const sub = `${r}/${e.name}`;
      if (e.isDirectory()) queue.push([path.join(d, e.name), sub]);
      else if (!tracked.has(sub)) return sub;
    }
  }
  return null;
}

/**
 * The guarded fast-forward of the checkout `co` to `C` (design 8, landing option 1): git merge
 * --ff-only in that worktree, with nothing git could add on its own (no autostash, no overwriting
 * ignored files, no hooks, no submodule recursion). Returns git's result; the caller reads the
 * outcome back and never takes a failure for "not moved".
 */
function fastForwardCheckout(g, co, C) {
  const gd = [`--git-dir=${co.gitDir}`, `--work-tree=${co.at}`];
  return g.run(["-c", "submodule.recurse=false", "-c", "merge.autoStash=false", ...gd, "merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", "--no-verify", "--no-stat", C], co.at);
}

/**
 * Build the landing candidate of `member` for `target` (`hoptell team land <member> --target`).
 * `landRef`: the candidate's branch (team/<team>/land), created only when absent. Returns
 * {target, T, C, H, tree, stat}.
 */
export async function landCandidate(home, member, { target, message, landRef, bound }, { git = findGit(), procs, homedir = null, sshAuthSock = null, hooks = {} } = {}) {
  checkTarget(target);
  if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message) > MESSAGE_MAX || message.includes("\0")) fail("no_message", "the candidate needs a message (-m), at most 64 KiB");
  const first = boundRecord(home, member, bound);
  return withQuietRepo(
    home,
    first.common,
    "hoptell team land",
    async (recheck) => {
      boundRecord(home, member, bound);
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      if (rec.head === rec.base) fail("nothing_to_land", `${member} has no commits (hoptell worktree commit first)`);
      const pins = signingPins(rec, { homedir });
      if (!/^refs\/heads\/team\/[a-z0-9-]+\/land$/.test(landRef)) fail("bad_target", "the candidate branch must be team/<team>/land");
      const t = readRef(g, rec.repo, `refs/heads/${target}`);
      if (t.state === "error") fail("ref_unreadable", `${target} could not be read (${t.why}); nothing was changed`);
      if (t.state === "absent") fail("bad_target", `there is no branch ${target}`);
      const T = t.oid;
      if (T !== rec.base) fail("target_moved", `${target} is at ${T.slice(0, 12)}, not at ${rec.base.slice(0, 12)}, the base of ${member}; hoptell runs no merge: rebase by hand, or redo the change on a new base`);
      const before = readRef(g, rec.repo, landRef);
      if (before.state === "error") fail("ref_unreadable", `${landRef.slice(11)} could not be read (${before.why}); nothing was changed`);
      if (before.state === "present") fail("candidate_exists", `${landRef.slice(11)} already exists; land or discard that candidate first (hoptell team land <member> --discard)`);
      const tree = text(must(g, ["rev-parse", "--verify", `${rec.head}^{tree}`], rec.repo, "git_failed", "the member's tree could not be read"));
      const env = sshAuthSock ? { SSH_AUTH_SOCK: sshAuthSock } : undefined;
      const C = text(must(g, [...pins.sign, "commit-tree", "-S", "-p", T, "-F", "-", tree], rec.repo, "signing_failed", "git could not create the signed candidate (check the signing key and ssh-agent)", { input: message.endsWith("\n") ? message : `${message}\n`, env }));
      must(g, [...pins.verify, "verify-commit", C], rec.repo, "verify_failed", `the candidate ${C} does not verify against the allowed signers file`);
      // Everything that can fail runs before the branch is published; then a journal of the
      // publication (hooks.publishing), the create-only update, and the caller records it.
      const stat = must(g, [...gd, "--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", T, C, "--"], rec.repo, "git_failed", "git diff failed").stdout.toString("utf8").trimEnd();
      hooks.publishing?.({ T, H: rec.head, C });
      // From here every error carries publishOutcome: "not created" (the journal may go) or "unknown".
      let outcome = "not created";
      try {
        recheck();
        outcome = "unknown";
        const made = g.run(["update-ref", "--no-deref", "-m", "hoptell team land: candidate", landRef, C, "0".repeat(T.length)], rec.repo);
        if (made.status !== 0) {
          const rb = readRef(g, rec.repo, landRef);
          if (made.status !== null && (rb.state === "absent" || (rb.state === "present" && rb.oid !== C))) {
            outcome = "not created";
            fail("candidate_exists", `${landRef.slice(11)} could not be created (${ended(made)}); nothing was changed`);
          }
          fail("publish_unknown", `git update-ref ended with ${ended(made)}, and ${landRef.slice(11)} ${rb.state === "error" ? `could not be read (${rb.why})` : `reads ${rb.state === "present" ? rb.oid.slice(0, 12) : "absent"}`}; whether the candidate was published is unknown. Run the same hoptell team land command again`);
        }
        hooks.afterPublish?.();
      } catch (e) {
        if (e && typeof e === "object") e.publishOutcome = outcome;
        throw e;
      }
      return { target, T, C, H: rec.head, tree, stat };
    },
    procs,
  );
}

/**
 * The landing of a team started before landing actions: it finishes a landing journaled then, or
 * confirms one the owner fast-forwarded by hand (`confirm`); lib/teams.js starts nothing new
 * here. The approval is exactly (T, C), checked against `candidate` (hoptell's record: {target,
 * T, C, H}) and against the repository, all under the repository's lock. hoptell moves the target
 * only by compare-and-swap from T to C (`update-ref`), never by a merge, and never a checked-out
 * one; `confirm` also checks a checkout of the target (on it, at C, clean).
 *
 * Evidence is deleted only after the landing is recorded. `hooks.intent()` runs before the move
 * (a journal of what is about to move), `hooks.landed()` once the target is at C; either may
 * throw, which keeps the candidate branch and the worktree. `journaled` ("intent" or "landed"): a
 * journal of this exact (T, C) from an earlier run, so a target already at C is that landing and
 * is finished, not refused. Returns {target, T, C, H, removed, checkedOut}.
 */
export async function landApprove(home, member, { T, C, candidate, landRef, confirm = false, journaled = null, bound }, { git = findGit(), procs, homedir = null, hooks = {} } = {}) {
  const first = boundRecord(home, member, bound);
  const oid = OID[first.objectFormat];
  const flag = confirm ? "--confirm" : "--approve";
  if (!oid.test(String(T)) || !oid.test(String(C))) fail("bad_approval", `the approval names the full target and candidate commit ids: ${flag} <T> <C>`);
  if (!candidate || candidate.T !== T || candidate.C !== C) fail("bad_approval", `no candidate (${String(T).slice(0, 12)}, ${String(C).slice(0, 12)}) is recorded for ${member}; build one with hoptell team land ${member} --target <branch>`);
  const target = checkTarget(candidate.target);
  return withQuietRepo(
    home,
    first.common,
    "hoptell team land",
    async (recheck) => {
      boundRecord(home, member, bound);
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      const pins = signingPins(rec, { homedir });
      if (rec.head !== candidate.H) fail("head_moved", `${member}'s head moved from ${candidate.H.slice(0, 12)} after the candidate was built, so the candidate no longer matches this head. Check hoptell team status <team>. If no landing is pending, discard it with hoptell team land ${member} --discard, then build and review a new one`);
      const targetRef = `refs/heads/${target}`;
      // The candidate: on its branch (until a recorded landing deleted that), one signed commit
      // with parent T and the member's tree.
      const land = readRef(g, rec.repo, landRef);
      if (land.state === "error") fail("ref_unreadable", `${landRef.slice(11)} could not be read (${land.why}); nothing was changed. Run the same hoptell team land command again`);
      if (land.state === "absent" ? journaled !== "landed" : land.oid !== C) fail("candidate_changed", `${landRef.slice(11)} is no longer at ${C.slice(0, 12)}`);
      const parents = text(must(g, ["rev-list", "--parents", "-n", "1", C], rec.repo, "git_failed", "the candidate could not be read")).split(" ");
      const ctree = text(must(g, ["rev-parse", `${C}^{tree}`], rec.repo, "git_failed", "the candidate could not be read"));
      const htree = text(must(g, ["rev-parse", `${rec.head}^{tree}`], rec.repo, "git_failed", "the member's head could not be read"));
      if (parents.length !== 2 || parents[1] !== T || ctree !== htree) fail("candidate_changed", "the candidate is not the member's reviewed tree on the target");
      must(g, [...pins.verify, "verify-commit", C], rec.repo, "verify_failed", `the candidate ${C} does not verify against the allowed signers file`);
      const atStart = readRef(g, rec.repo, targetRef);
      if (atStart.state === "error") fail("ref_unreadable", `${target} could not be read (${atStart.why}); nothing was changed`);
      if (atStart.state === "absent") fail("target_moved", `there is no branch ${target} any more; nothing was changed`);
      const now = atStart.oid;
      let checkedOut = null;
      // Whether this run moved the target: "not attempted", "not moved", "moved" or "unknown".
      // Every error from here on carries it (landOutcome), so a journal is dropped only when
      // nothing moved.
      let outcome = "not attempted";
      try {
        if (now === C) {
          // Already there: the owner's own fast-forward (confirm), or an earlier run of this
          // landing that stopped before it was recorded (journaled).
          if (!confirm && !journaled) fail("already_landed", `${target} is already at ${C.slice(0, 12)}; if you fast-forwarded it yourself, run hoptell team land ${member} --confirm ${T} ${C}`);
          // A checkout of the target must be on it, at C and clean: a ref at C with a stale or
          // dirty checkout is not landed.
          if (confirm) {
            const why = checkoutsAtC(g, rec.repo, target, C, rec.common);
            if (why.length) fail("not_landed", `${target} is at ${C.slice(0, 12)}, but ${why.join("; ")}; nothing was recorded. Fix that, then run the same hoptell team land command again`);
          }
        } else if (now === T && !confirm) {
          // A landing journaled before landing actions moves only a target that is not checked out.
          const where = checkedOutAt(g, rec.repo, target, rec.common);
          if (where.length) fail("land_blocked", `${target} is checked out in ${where.map((w) => w.at).join(", ")}; nothing was moved. Switch that worktree to another branch, then run the same hoptell team land command again`);
          hooks.intent?.();
          hooks.beforeMove?.();
          recheck();
          outcome = "unknown";
          const moved = g.run(["update-ref", "--no-deref", "-m", "hoptell team land", targetRef, C, T], rec.repo);
          if (moved.status !== 0) {
            // "Not moved" only for a compare-and-swap that git refused (a normal status) and a
            // target that reads back present and not at C; a signal, an unreadable or absent
            // target, or one at C leaves the outcome unknown, and the journal stays.
            const rb = readRef(g, rec.repo, targetRef);
            if (moved.status !== null && rb.state === "present" && rb.oid !== C) {
              outcome = "not moved";
              fail("target_moved", `${target} moved while landing; nothing was landed`);
            }
            fail("land_unknown", `git update-ref ended with ${ended(moved)}, and ${target} ${rb.state === "error" ? `could not be read (${rb.why})` : rb.state === "absent" ? "is absent" : `reads ${rb.oid.slice(0, 12)}`}; whether it moved is unknown, so the landing's journal stays. Run the same hoptell team land command again`);
          }
          outcome = "moved";
          hooks.afterMove?.();
          // The postcondition, read back.
          const after = readRef(g, rec.repo, targetRef);
          if (after.state !== "present" || after.oid !== C) fail("land_failed", `${target} ${after.state === "error" ? `could not be read after the update (${after.why})` : `is at ${after.state === "present" ? after.oid.slice(0, 12) : "nothing"} after the update, not at ${C.slice(0, 12)}`}; nothing more was changed. Check it, then run the same hoptell team land command again`);
          checkedOut = checkedOutAt(g, rec.repo, target, rec.common)[0]?.at ?? null;
        } else if (confirm) {
          fail("not_landed", now === T ? `${target} is still at ${T.slice(0, 12)}; run git merge --ff-only ${C} in the worktree that has ${target} checked out first` : `${target} is at ${String(now).slice(0, 12)}, not at ${C.slice(0, 12)}; nothing was recorded`);
        } else fail("target_moved", `${target} is no longer at ${T.slice(0, 12)}; nothing was changed. Land by hand, or discard the candidate when it is safe and redo the change on a new base`);
        if (journaled !== "landed") {
          try {
            hooks.landed?.();
          } catch (e) {
            fail("not_recorded", `${target} is at ${C.slice(0, 12)}, but the landing could not be recorded (${String(e.message).slice(0, 200)}); the candidate branch and the worktree are kept. Run the same hoptell team land command again to finish`);
          }
        }
        hooks.afterRecord?.();
        // Only now the evidence goes: the candidate branch (compare-and-delete, checked), then the
        // worktree. A deletion that did not happen stops here, before the registration goes.
        recheck();
        if (land.state === "present") checkedDelete(g, rec.repo, landRef, C, "the landing is recorded, but", "hoptell team land command");
      } catch (e) {
        if (e && typeof e === "object") e.landOutcome = outcome;
        throw e;
      }
      let removed;
      try {
        removed = removeOpened(home, rec, g, gd, recheck, { head: rec.head, candidate: C, target });
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        removed = { kept: true, why: e.message };
      }
      return { target, T, C, H: rec.head, removed, checkedOut };
    },
    procs,
  );
}

/** What keeps the checkouts of `target` from matching commit `at`: one at most, on it, at `at`, clean. */
function checkoutsAtC(g, repo, target, at, common) {
  const cos = checkedOutAt(g, repo, target, common);
  if (cos.length > 1) return [`${target} is checked out in ${cos.length} worktrees (${cos.map((c) => c.at).join(", ")})`];
  return cos.flatMap((co) => checkoutProblems(g, co, target, at).map((p) => `in ${co.at}, ${p}`));
}

const sameMode = (a, b) => a.kind === b.kind && (a.kind === "ref" || (a.worktree === b.worktree && a.gitDir === b.gitDir));

/**
 * Land under a landing action (design 8 addendum, "The landing action" and option 1): the
 * `--approve <T> <C>` of a team with an enrolment, or the owner's `--confirm <T> <C>`.
 *
 * The mode comes from the checkouts of the target: `ref` (none: compare-and-swap of the ref from
 * T to C) or `checkout` (exactly one: hoptell's guarded git merge --ff-only in that worktree, after
 * checking that it is on the target at T, clean, with no operation in progress). Two or more
 * checkouts refuse. `live`: the member's live action ({id, state, manifest}) or null. The hooks
 * write the action's transitions (lib/teams.js): `begin(info)` makes the action, or continues a
 * ready or approved one, and records the decision (returns its manifest); `accept()` (checked
 * against expiry; with the journal), `moving()` before the move, `landed()` once the target is
 * at C and the checkout checks passed, `block(reason, {moved})`: `moved` false ends the action
 * (nothing moved), true keeps it blocked with the journal. From `moving` on nothing moves again:
 * a later run only reads what happened. An unknown outcome is never "not moved", and nothing is
 * reset. `requested`: the route of a decision made for a requested action ("terminal": hoptell team
 * approve, "bridge": the owner's Telegram, applied by the lead), so a refusal before the move asks
 * for a new request rather than the same command. Test hooks: beforeMove, afterMoving, afterMove,
 * afterRecord. Returns {id, target, T, C,
 * H, removed, checkedOut}.
 */
export async function landAction(home, member, { T, C, candidate, landRef, confirm = false, live = null, common, bound, requested = false }, { git = findGit(), procs, homedir = null, hooks }) {
  const first = boundRecord(home, member, bound);
  const oid = OID[first.objectFormat];
  const flag = confirm ? "--confirm" : "--approve";
  if (!oid.test(String(T)) || !oid.test(String(C))) fail("bad_approval", `the approval names the full target and candidate commit ids: ${flag} <T> <C>`);
  if (!candidate || candidate.T !== T || candidate.C !== C) fail("bad_approval", `no candidate (${String(T).slice(0, 12)}, ${String(C).slice(0, 12)}) is recorded for ${member}; build one with hoptell team land ${member} --target <branch>`);
  const target = checkTarget(candidate.target);
  const again = `hoptell team land ${member} --approve ${T} ${C}`;
  const confirmLine = `hoptell team land ${member} --confirm ${T} ${C}`;
  // What a refusal before the move asks for after the fix: the same command on the manual route;
  // for a decision made with hoptell team approve (`requested`), a new request and a new id.
  const redo = (fix) =>
    requested === "bridge"
      ? `${fix ? `${fix}. ` : ""}Then run hoptell team land ${member} --request-approval again; the owner decides the new id`
      : requested
        ? `${fix ? `${fix}. ` : ""}Then ask the lead to run hoptell team land ${member} --request-approval again, and approve the new id`
        : `${fix ? `${fix}, then run` : "Run"} the same ${again} again`;
  return withQuietRepo(
    home,
    first.common,
    "hoptell team land",
    async (recheck) => {
      boundRecord(home, member, bound);
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      if (rec.common !== common) fail("enrolment_changed", `${member}'s worktree belongs to ${rec.common}, not to ${common}, the repository the team enrolled at team up; nothing was changed`);
      const state = live?.state ?? null;
      let id = live?.id ?? null;
      let manifest = live?.manifest ?? null;
      const targetRef = `refs/heads/${target}`;
      const readTarget = () => readRef(g, rec.repo, targetRef);
      const said = (t) => (t.state === "error" ? `could not be read (${t.why})` : t.state === "absent" ? "is absent" : `is at ${t.oid.slice(0, 12)}`);

      // Record (unless recorded), then the evidence goes: the candidate branch, then the worktree.
      // `observed`: a checkout of the target that appeared during a branch-only landing, already
      // on it at C and clean (named in the result).
      const land = (observed) => {
        if (state !== "landed") {
          try {
            hooks.landed();
          } catch (e) {
            fail("not_recorded", `${target} is at ${C.slice(0, 12)}, but the landing could not be recorded (${String(e.message).slice(0, 200)}); the candidate branch and the worktree are kept. Run the same hoptell team land command again to finish`);
          }
        }
        hooks.afterRecord?.();
        recheck();
        checkedDelete(g, rec.repo, landRef, C, "the landing is recorded, but", "hoptell team land command");
        let removed;
        try {
          removed = removeOpened(home, rec, g, gd, recheck, { head: rec.head, candidate: C, target });
        } catch (e) {
          if (!(e instanceof GitError)) throw e;
          removed = { kept: true, why: e.message };
        }
        return { id, target, T, C, H: rec.head, removed, checkedOut: null, observed };
      };
      // A durable `landed` finishes the cleanup without any move or check.
      if (state === "landed") return land(null);

      const pins = signingPins(rec, { homedir });
      if (rec.head !== candidate.H) fail("head_moved", `${member}'s head moved from ${candidate.H.slice(0, 12)} after the candidate was built, so the candidate no longer matches this head. Check hoptell team status <team>. If no landing is pending, discard it with hoptell team land ${member} --discard, then build and review a new one`);
      const lb = readRef(g, rec.repo, landRef);
      if (lb.state === "error") fail("ref_unreadable", `${landRef.slice(11)} could not be read (${lb.why}); nothing was changed. Run the same hoptell team land command again`);
      if (lb.state !== "present" || lb.oid !== C) fail("candidate_changed", `${landRef.slice(11)} is no longer at ${C.slice(0, 12)}`);
      const parents = text(must(g, ["rev-list", "--parents", "-n", "1", C], rec.repo, "git_failed", "the candidate could not be read")).split(" ");
      const ctree = text(must(g, ["rev-parse", `${C}^{tree}`], rec.repo, "git_failed", "the candidate could not be read"));
      const htree = text(must(g, ["rev-parse", `${rec.head}^{tree}`], rec.repo, "git_failed", "the member's head could not be read"));
      if (parents.length !== 2 || parents[1] !== T || ctree !== htree) fail("candidate_changed", "the candidate is not the member's reviewed tree on the target");
      must(g, [...pins.verify, "verify-commit", C], rec.repo, "verify_failed", `the candidate ${C} does not verify against the allowed signers file`);

      // Whether the target is landed at C: [] when it is. In every mode and on every path, a
      // checkout of the target, when there is one, must be the only one, a worktree of the
      // enrolled repository, on the target at C and clean; in mode checkout it must be the one in
      // the manifest. A checkout is described against the commit the target is at.
      const landedProblems = (mode) => {
        const t = readTarget();
        const why = t.state === "present" && t.oid === C ? [] : [`${target} ${said(t)}, not at ${C.slice(0, 12)}`];
        const cos = checkedOutAt(g, rec.repo, target, rec.common);
        if (mode?.kind === "checkout" && !(cos.length === 1 && sameMode(mode, { kind: "checkout", worktree: cos[0].at, gitDir: cos[0].gitDir }))) why.push(cos.length ? `${target} is checked out in ${cos.map((c) => c.at).join(", ")}, not only in ${mode.worktree}${cos.some((c) => c.foreign) ? ` (${cos.find((c) => c.foreign).foreign})` : ""}` : `${target} is no longer checked out in ${mode.worktree}`);
        else why.push(...checkoutsAtC(g, rec.repo, target, t.state === "present" ? t.oid : C, rec.common));
        return { why, target: t, checkouts: cos };
      };
      // An outcome hoptell cannot tell: the action stays blocked, nothing moves again, nothing is
      // reset. The paste-safe line only when the target is still at T and its one checkout is clean.
      const unknown = (p, mode, how) => {
        const reason = `${how}; ${p.why.join("; ")}`.slice(0, 1000);
        hooks.block(reason, { moved: true });
        const atT = p.target.state === "present" && p.target.oid === T;
        const co = p.checkouts.length === 1 ? p.checkouts[0] : null;
        const clean = mode.kind === "checkout" && atT && co && sameMode(mode, { kind: "checkout", worktree: co.at, gitDir: co.gitDir }) && !checkoutProblems(g, co, target, T).length;
        const atC = p.target.state === "present" && p.target.oid === C;
        const where = p.checkouts.map((c) => c.at).join(", ");
        const next = atC
          ? ` Bring ${p.checkouts.length > 1 ? `the checkouts of ${target} down to one` : `the checkout in ${where} to ${C.slice(0, 12)} (git read-tree -m -u ${T} ${C} there keeps your own changes)`}, then record it with ${confirmLine}`
          : ` Check ${mode.kind === "checkout" ? mode.worktree : target}; once ${target} is at ${C.slice(0, 12)}${mode.kind === "checkout" ? " and that checkout is on it and clean" : ""}, record it with ${confirmLine}`;
        const e = new GitError("land_unknown", `${how}, and ${p.why.join("; ")}. ${atC ? `${target} is at ${C.slice(0, 12)}, but the landing ${id} is blocked: hoptell moves nothing more and resets nothing.` : `Whether ${target} moved is unknown, so the landing ${id} is blocked: hoptell does not move it again and resets nothing.`}${clean ? "" : next}`);
        if (clean) e.paste = { at: co.at, target, T, C, confirm: confirmLine };
        throw e;
      };

      if (confirm) {
        // The owner's reconciliation: the target at C, checked as above, under the live action
        // (whatever moved it) or a new one.
        const cos = checkedOutAt(g, rec.repo, target, rec.common);
        if (!manifest && cos.length > 1) fail("not_landed", `${target} is checked out in ${cos.length} worktrees (${cos.map((c) => c.at).join(", ")}); nothing was recorded. Switch all but one to another branch, then run the same command again`);
        const mode = manifest?.mode ?? (cos.length ? { kind: "checkout", worktree: cos[0].at, gitDir: cos[0].gitDir } : { kind: "ref" });
        const p = landedProblems(mode);
        if (p.why.length) fail("not_landed", `${p.why.join("; ")}; nothing was recorded.${p.target.state === "present" && p.target.oid === T ? ` Move ${target} to ${C.slice(0, 12)} first.` : ""} Fix that, then run the same command again`);
        if (!manifest) {
          manifest = await hooks.begin({ mode, target, T, H: rec.head, C, worktree: rec.path, branch: rec.branch, candidate: landRef.slice(11) });
          id = manifest.id;
          hooks.accept();
        }
        return land(null);
      }

      if (state === "blocked") fail("land_blocked", `the landing ${id} is blocked (${live.reason}); hoptell does not move ${target} again under it. Check it; once ${target} is at ${C.slice(0, 12)} and its checkout is clean, record it with ${confirmLine}`);
      if (state === "moving") {
        // A run stopped after the move may have started: read what happened, never move again.
        const p = landedProblems(manifest.mode);
        if (!p.why.length) return land(manifest.mode.kind === "ref" ? (p.checkouts[0]?.at ?? null) : null);
        unknown(p, manifest.mode, "an earlier run stopped while it moved the target");
      }

      // Not started yet (no action, ready, approved) or accepted (nothing tried): the checks before
      // a move. A refusal ends a live action (nothing moved); the next decision makes a new one.
      const refuse = (code, message) => {
        if (id) hooks.block(message.slice(0, 1000), { moved: false });
        fail(code, message);
      };
      const now = readTarget();
      if (now.state === "error") fail("ref_unreadable", `${target} could not be read (${now.why}); nothing was changed`);
      if (now.state === "absent") refuse("target_moved", `there is no branch ${target} any more; nothing was changed`);
      if (now.oid === C) refuse("already_landed", `${target} is already at ${C.slice(0, 12)}, and hoptell did not move it; if you fast-forwarded it yourself, run ${confirmLine}`);
      if (now.oid !== T) refuse("target_moved", `${target} is no longer at ${T.slice(0, 12)}; nothing was changed. Land by hand, or discard the candidate when it is safe and redo the change on a new base`);
      const cos = checkedOutAt(g, rec.repo, target, rec.common);
      if (cos.length > 1) refuse("land_blocked", `${target} is checked out in ${cos.length} worktrees (${cos.map((c) => c.at).join(", ")}); hoptell moves a checked-out target only when exactly one worktree has it. Nothing was moved. ${redo("Switch all but one to another branch")}`);
      const mode = cos.length ? { kind: "checkout", worktree: cos[0].at, gitDir: cos[0].gitDir } : { kind: "ref" };
      if (mode.kind === "checkout" && (cos[0].foreign || !mode.gitDir)) refuse("land_blocked", `${target} is checked out in ${mode.worktree}, but ${cos[0].foreign ?? "it could not be opened"}. Nothing was moved. ${redo("Fix that")}`);
      if (state === "accepted" && !sameMode(manifest.mode, mode)) refuse("land_blocked", `the checkout of ${target} changed after the landing ${id} was accepted (${manifest.mode.kind === "checkout" ? manifest.mode.worktree : "not checked out"} then, ${mode.kind === "checkout" ? mode.worktree : "not checked out"} now); nothing was moved. ${redo(null)}`);
      if (state !== "accepted") {
        manifest = await hooks.begin({ mode, target, T, H: rec.head, C, worktree: rec.path, branch: rec.branch, candidate: landRef.slice(11) });
        id = manifest.id;
      }
      if (mode.kind === "checkout") {
        const problems = [...checkoutProblems(g, cos[0], target, T), ...inTheWay(g, rec.repo, cos[0], T, C)];
        if (problems.length) refuse("land_blocked", `${target} is checked out in ${mode.worktree}, and ${problems.join("; ")}. Nothing was moved. ${redo("Fix that")}; hoptell then moves it itself`);
      }
      if (state !== "accepted") hooks.accept();
      hooks.beforeMove?.();
      recheck();
      hooks.moving();
      hooks.afterMoving?.();
      if (mode.kind === "ref") {
        const moved = g.run(["update-ref", "--no-deref", "-m", "hoptell team land", targetRef, C, T], rec.repo);
        if (moved.status !== 0) {
          // "Not moved" only for a compare-and-swap that git refused (a normal status) and a
          // target that reads back present and not at C; anything else is an unknown outcome.
          const rb = readTarget();
          if (moved.status !== null && rb.state === "present" && rb.oid !== C) {
            hooks.block(`${target} moved while landing`, { moved: false });
            fail("target_moved", `${target} moved while landing; nothing was landed`);
          }
          unknown({ why: [`${target} ${said(rb)}`], target: rb, checkouts: [] }, mode, `git update-ref ended with ${ended(moved)}`);
        }
        hooks.afterMove?.();
        const after = readTarget();
        if (after.state !== "present" || after.oid !== C) unknown({ why: [`${target} ${said(after)} after the update`], target: after, checkouts: [] }, mode, "the update ended with status 0");
        // A checkout of the target that appeared in the gap keeps T's index and files: then the
        // landing is not finished (only one already at C and clean is).
        const p = landedProblems(mode);
        if (p.why.length) unknown(p, mode, `git update-ref moved ${target} to ${C.slice(0, 12)}, but a checkout of it appeared meanwhile`);
        return land(p.checkouts[0]?.at ?? null);
      }
      const r = fastForwardCheckout(g, cos[0], C);
      hooks.afterMove?.();
      const p = landedProblems(mode);
      const upToDate = /Already up.to.date/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
      if (r.status === 0 && !upToDate && !p.why.length) return land(null);
      if (!p.why.length) p.why.push(`${target} reads ${C.slice(0, 12)}`);
      unknown(p, mode, `git merge --ff-only ${r.status === 0 ? (upToDate ? 'said "Already up to date"' : "ended with status 0") : `ended with ${ended(r)}`}`);
    },
    procs,
  );
}

/**
 * What the target of a landing and its checkouts look like now, as one line of text for the owner
 * (hoptell team land --abandon): the ref against T and C, and each checkout against the ref. It
 * reads only, under the repository's lock, and concludes nothing from what it sees.
 */
export async function observeTarget(home, member, { target, T, C, common, bound }, { git = findGit(), procs } = {}) {
  const first = boundRecord(home, member, bound);
  checkTarget(target);
  return withQuietRepo(
    home,
    first.common,
    "hoptell team land --abandon",
    async () => {
      const g = runner(home, { git, emptyTree: first.emptyTree });
      checkGit(g);
      const t = readRef(g, first.repo, `refs/heads/${target}`);
      const ref = t.state === "present" ? `${target} is at ${t.oid}${t.oid === T ? " (T, where it was)" : t.oid === C ? " (C, the candidate)" : " (neither T nor C)"}` : t.state === "absent" ? `${target} is absent` : `${target} could not be read (${t.why})`;
      const cos = checkedOutAt(g, first.repo, target, common);
      const each = cos.map((co) => {
        const why = t.state === "present" ? checkoutProblems(g, co, target, t.oid) : [co.foreign ?? "not compared"];
        return `checked out in ${co.at}${why.length ? `: ${why.join("; ")}` : ", on it and clean"}`;
      });
      return `${ref}; ${cos.length ? each.join("; ") : "not checked out anywhere"}`;
    },
    procs,
  );
}

export const DIFFSTAT_MAX = 16 * 1024;

/**
 * What a landing request freezes of the repository (hoptell team land --request-approval), read
 * under the repository's lock: the execution mode (the one checkout of the target, or the branch
 * only; two or more checkouts, or one hoptell cannot place, refuse), C's subject, the diffstat and
 * the complete patch T..C. The patch is streamed: every byte of it is counted and hashed, and its
 * bytes are kept only while there are at most `inlineMax` of them, so a patch of any size gives
 * its digest and size (never those of a cut prefix) and `inline` null when it is larger. The
 * target must be at T and the candidate branch at C. Returns {mode, subject, diffstat, patch:
 * {inline, bytes, digest}}.
 */
export async function landingEvidence(home, member, { target, T, C, landRef, common, bound, inlineMax }, { git = findGit(), procs } = {}) {
  const first = boundRecord(home, member, bound);
  checkTarget(target);
  return withQuietRepo(
    home,
    first.common,
    "hoptell team land --request-approval",
    async () => {
      const g = runner(home, { git, emptyTree: first.emptyTree, timeoutMs: ADD_TIMEOUT_MS });
      checkGit(g);
      const repo = first.repo;
      const t = readRef(g, repo, `refs/heads/${target}`);
      if (t.state === "error") fail("ref_unreadable", `${target} could not be read (${t.why}); nothing was recorded`);
      if (t.state !== "present" || t.oid !== T) fail("target_moved", `${target} is no longer at ${T.slice(0, 12)}; nothing was recorded. Discard the candidate and prepare a new one on the new base`);
      const c = readRef(g, repo, landRef);
      if (c.state !== "present" || c.oid !== C) fail("candidate_changed", `${landRef.slice(11)} is not at the candidate ${C.slice(0, 12)}; nothing was recorded`);
      const cos = checkedOutAt(g, repo, target, common);
      if (cos.length > 1) fail("land_blocked", `${target} is checked out in ${cos.length} worktrees (${cos.map((x) => x.at).join(", ")}); hoptell lands a checked-out target only when exactly one worktree has it. Switch all but one to another branch, then request the approval again`);
      if (cos.length && (cos[0].foreign || !cos[0].gitDir)) fail("land_blocked", `${target} is checked out in ${cos[0].at}, but ${cos[0].foreign ?? "it could not be opened"}; nothing was recorded`);
      const mode = cos.length ? { kind: "checkout", worktree: cos[0].at, gitDir: cos[0].gitDir } : { kind: "ref" };
      const subject = text(must(g, ["log", "-1", "--no-show-signature", "--format=%s", C, "--"], repo, "git_failed", "git could not read the candidate's subject")).slice(0, 200);
      const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
      let diffstat = must(g, [...diff, "--stat=120", T, C, "--"], repo, "git_failed", "git diff --stat failed").stdout.toString("utf8").trimEnd();
      if (Buffer.byteLength(diffstat) > DIFFSTAT_MAX) diffstat = must(g, [...diff, "--shortstat", T, C, "--"], repo, "git_failed", "git diff --shortstat failed").stdout.toString("utf8").trim();
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      let kept = [];
      const r = await g.stream([...diff, "--binary", "--full-index", T, C, "--"], repo, (b) => {
        hash.update(b);
        bytes += b.length;
        if (kept && bytes <= inlineMax) kept.push(Buffer.from(b));
        else kept = null;
      });
      if (r.status !== 0) fail("git_failed", `git diff ${r.status === null ? `was stopped (${r.signal ?? "time limit"})` : `exited ${r.status}`}; nothing was recorded`);
      return { mode, subject, diffstat, patch: { inline: kept ? Buffer.concat(kept) : null, bytes, digest: hash.digest("hex") } };
    },
    procs,
  );
}

/**
 * Delete `ref` only while it is at `C`, and check that it went: it is read first (absent is fine;
 * a symbolic ref, an unreadable one or another commit stops here, nothing deleted), and a deletion
 * that git refused is read back the same way. `lead`: how the message starts; `again`: the
 * command to run again.
 */
function checkedDelete(g, repo, ref, C, lead, again) {
  const name = ref.slice(11);
  const was = readRef(g, repo, ref);
  if (was.state === "absent") return;
  if (was.state === "error") fail("ref_unreadable", `${lead} ${name} could not be read (${was.why}); nothing was removed. Check that branch, then run the same ${again} again`);
  if (was.oid !== C) fail("candidate_changed", `${lead} ${name} now points at ${was.oid.slice(0, 12)}, not at the candidate ${C.slice(0, 12)}; check that branch, delete it by hand (git branch -D ${name}), then run the same ${again} again`);
  let d;
  try {
    d = g.run(["update-ref", "--no-deref", "-d", ref, C], repo);
  } catch (e) {
    d = { status: null, stderr: e.message };
  }
  if (d.status === 0) return;
  const rb = readRef(g, repo, ref);
  if (rb.state === "absent") return;
  if (rb.state === "error") fail("ref_unreadable", `${lead} git could not delete ${name} (${ended(d)}) and it could not be read back (${rb.why}); nothing else was removed. Run the same ${again} again`);
  if (rb.oid !== C) fail("candidate_changed", `${lead} ${name} now points at ${rb.oid.slice(0, 12)}, not at the candidate ${C.slice(0, 12)}; check that branch, delete it by hand (git branch -D ${name}), then run the same ${again} again`);
  fail("ref_delete_failed", `${lead} git could not delete ${name} (${ended(d)}); nothing else was removed. Run the same ${again} again`);
}

/**
 * Drop a recorded candidate branch (compare-and-delete at `C`, checked), under the repository's
 * lock. Returns {deleted: true}; a branch already gone counts as deleted.
 */
export async function discardCandidate(home, member, { C, landRef, bound }, { git = findGit(), procs } = {}) {
  const first = boundRecord(home, member, bound);
  return withQuietRepo(
    home,
    first.common,
    "hoptell team land",
    async () => {
      if (!sameRegistration(boundRecord(home, member, bound), first)) fail("record_changed", `the worktree record of ${member} changed while hoptell waited for the repository's lock; nothing was run`);
      const g = runner(home, { git, emptyTree: first.emptyTree });
      checkGit(g);
      checkedDelete(g, first.repo, landRef, C, "the candidate is kept:", `hoptell team land ${member} --discard`);
      return { deleted: true };
    },
    procs,
  );
}

/**
 * After a publication that did not finish (a candidate journal {T, H, C}): is the candidate branch
 * there? {state: "absent"}, or {state: "adopted", target, T, C, H, stat} once it reads exactly C
 * and C is still the signed squash of the member's head H on T. Anything else refuses.
 */
export async function adoptCandidate(home, member, { landRef, target, T, H, C, bound }, { git = findGit(), procs, homedir = null } = {}) {
  const first = boundRecord(home, member, bound);
  return withQuietRepo(
    home,
    first.common,
    "hoptell team land",
    async () => {
      boundRecord(home, member, bound);
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      const r = readRef(g, rec.repo, landRef);
      if (r.state === "error") fail("ref_unreadable", `${landRef.slice(11)} could not be read (${r.why}); the publication's journal is kept. Run the same command again`);
      if (r.state === "absent") return { state: "absent" };
      if (r.oid !== C) fail("candidate_changed", `${landRef.slice(11)} points at ${r.oid.slice(0, 12)}, not at the candidate ${C.slice(0, 12)} that was being published; check that branch, delete it by hand (git branch -D ${landRef.slice(11)}), then run the same command again`);
      if (rec.head !== H) fail("head_moved", `${member}'s head moved from ${H.slice(0, 12)} after the candidate was built; discard it (hoptell team land ${member} --discard)`);
      const parents = text(must(g, ["rev-list", "--parents", "-n", "1", C], rec.repo, "git_failed", "the candidate could not be read")).split(" ");
      const ctree = text(must(g, ["rev-parse", `${C}^{tree}`], rec.repo, "git_failed", "the candidate could not be read"));
      const htree = text(must(g, ["rev-parse", `${H}^{tree}`], rec.repo, "git_failed", "the member's head could not be read"));
      if (parents.length !== 2 || parents[1] !== T || ctree !== htree) fail("candidate_changed", "the published candidate is not the member's tree on the target");
      must(g, [...signingPins(rec, { homedir }).verify, "verify-commit", C], rec.repo, "verify_failed", `the candidate ${C} does not verify against the allowed signers file`);
      const stat = must(g, [...gd, "--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", T, C, "--"], rec.repo, "git_failed", "git diff failed").stdout.toString("utf8").trimEnd();
      return { state: "adopted", target, T, C, H, stat };
    },
    procs,
  );
}

// ---- the command line ---------------------------------------------------------------------------

export const WORKTREE_USAGE = `usage: hoptell worktree add <member> --team <team> --cli <${WORKTREE_CLIS.join("|")}> [--base <commit>] [--folder <name>] [--owns <globs>] [--repo <dir>]
       hoptell worktree list
       hoptell worktree commit <member> -m <message> [--allow-outside]
       hoptell worktree diff <member> [--stat]
       hoptell worktree remove <member>`;

/** `hoptell worktree ...`. `cwd`: the lead's working folder (the default --repo). */
export async function worktreeCommand({ args, home, cwd, fail: die, out }) {
  const VALUE = ["--team", "--cli", "--base", "--folder", "--owns", "--repo", "--message", "-m"];
  const opt = (...names) => {
    const at = args.findIndex((a) => names.includes(a));
    return at < 0 ? undefined : args[at + 1];
  };
  if (args.includes("-m") && (opt("-m") === undefined || opt("-m") === "")) die("-m needs a message", 2);
  const pos = args.filter((a, i) => !a.startsWith("-") && !VALUE.includes(args[i - 1]));
  const [sub, member, ...extra] = pos;
  const usage = (why) => die(`${why}\n${WORKTREE_USAGE}`, 2);
  if (extra.length) usage(`unexpected argument "${String(extra[0]).slice(0, 40)}"`);
  try {
    if (sub === "list") {
      if (member) usage("worktree list takes no member");
      const rows = listWorktrees(home);
      if (!rows.length) return out("No hoptell worktrees.");
      const seen = observe({}, rows);
      for (const r of rows) {
        if (r.problem) {
          out(`${r.member ?? "(registry)"}  (${r.problem})`);
          continue;
        }
        const st = liveState(home, r, seen);
        out(`${r.member}  ${r.cli}  ${st.state}  ${r.branch}  ${r.path}${r.exists ? "" : " (missing)"}  base ${r.base.slice(0, 12)}  head ${r.head.slice(0, 12)}  ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}${r.owns ? `  owns ${r.owns.join(",")}` : ""}`);
      }
      if (seen.unreadable.length) out(unreadableNote(seen.unreadable));
      return;
    }
    if (!["add", "commit", "diff", "remove"].includes(sub ?? "")) usage(sub ? `unknown worktree command "${String(sub).slice(0, 40)}"` : "worktree needs a command");
    if (!member) usage(`worktree ${sub} needs a member name`);
    // A landing a team still has pending for this name keeps its record (hoptell team land).
    const teams = await import("./teams.js");
    if (sub === "add" || sub === "remove") {
      try {
        teams.checkNoPending(home, member);
      } catch (e) {
        die(e.message);
      }
    }
    if (sub === "add") {
      if (!opt("--team") || !opt("--cli")) usage("worktree add needs --team and --cli");
      const owns = opt("--owns");
      const rec = await addWorktree(home, { repo: opt("--repo") ?? cwd, member, team: opt("--team"), cli: opt("--cli"), folder: opt("--folder") ?? null, base: opt("--base") ?? null, owns: owns === undefined ? null : owns.split(",").map((o) => o.trim()).filter(Boolean) });
      out(`Worktree for ${member}: ${rec.path}`);
      out(`  branch ${rec.branch} at ${rec.base}`);
      out(`Start it there: HOPTELL_PUSH=tmux hoptell tmux ${member} --roles implementer --cwd ${rec.path} --task <file> -- <the command hoptell agents flags ${rec.cli} --role implementer --lead <lead> prints>`);
      return;
    }
    if (sub === "commit") {
      const message = opt("-m", "--message");
      if (message === undefined) usage("worktree commit needs -m <message>");
      const r = await commitWorktree(home, member, { message, allowOutside: args.includes("--allow-outside") });
      out(`${r.commit}  ${r.branch}  ${r.files.length} file${r.files.length === 1 ? "" : "s"}`);
      if (r.outside.length) out(`  outside owns (--allow-outside): ${r.outside.join(", ")}`);
      return;
    }
    if (sub === "diff") {
      const r = await diffWorktree(home, member, { stat: args.includes("--stat") });
      out(`# ${r.branch} ${r.base}..${r.head}`);
      return out(r.text.replace(/\n$/, ""));
    }
    // A team landing recorded for this member (hoptell team land) lets its branch go too.
    const landed = teams.landedFor(home, member);
    const r = await removeWorktree(home, member, { landed });
    out(`Removed ${r.path}.`);
    out(r.branchState === "deleted" ? `  branch ${r.branch} deleted (${landed ? "it landed" : "it had no commits"})` : `  branch ${r.branch} kept at ${r.head} (${r.keptBecause}); delete it by hand once you checked it`);
  } catch (e) {
    if (e instanceof GitError || e.code === "busy") die(e.message);
    throw e;
  }
}
