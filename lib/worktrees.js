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
import { descendantIdentities, identityState, processCwds, processIdentity, processTable } from "./host.js";

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

const isIdentity = (x) => Boolean(x) && typeof x === "object" && Object.keys(x).length === 4 && Number.isSafeInteger(x.pid) && x.pid > 1 && typeof x.start === "string" && x.start !== "" && Number.isSafeInteger(x.uid) && typeof x.boot === "string";
const idKey = (id) => `${id.pid}@${id.start}`;
const SESSION_KEYS = ["member", "pane", "root", "sessionId", "started", "tree", "version"];
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
    JSON.stringify(Object.keys(rec).sort()) === JSON.stringify(SESSION_KEYS) &&
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
function observe({ table = processTable, cwds = () => processCwds(process.getuid()), self = process.pid } = {}) {
  const t = table();
  const scan = cwds();
  return { table: t, scan, chain: t ? ownChain(t, self) : null };
}

/**
 * A member's state for the commands: its recorded session (memberState), and also any process of
 * this user (other than hoptell and its ancestors) whose working folder is in the worktree, such
 * as a command an agent's daemon runs there, wherever it is parented. A process that left the
 * worktree but still writes there is not seen: implementers must have quit, not only moved.
 */
function liveState(home, rec, seen, deps = {}, persist = false) {
  if (!seen.table) return { state: "unknown", why: "the process table could not be read" };
  const st = memberState(home, rec.member, { ...deps, table: () => seen.table, persist });
  if (st.state !== "stopped") return st;
  if (!seen.scan) return { state: "unknown", why: "the working folders of your processes could not be read (lsof on macOS, /proc on Linux)" };
  const stray = seen.scan.find((p) => !seen.chain.has(p.pid) && within(p.cwd, rec.path));
  if (stray) return { state: "running", why: `process ${stray.pid} (${stray.command || "unknown command"}) runs in its worktree, in ${stray.cwd}: if it is the implementer or something it started, quit it; if it is an unrelated shell of yours, cd out of the worktree` };
  return st;
}

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
  const seen = observe(deps);
  for (const r of mine) {
    const st = liveState(home, r, seen, deps, true);
    if (st.state === "running") fail("member_running", `${r.member} (${r.cli}) is still running (${st.why}). An implementer is not kept away from the repository's git metadata, so stop it, or let it quit, before hoptell worktree ${what}`);
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
      const record = (s) => writeRecord(paths.session(rec.member), { version: 1, member: rec.member, sessionId: s.sessionId, pane: s.pane, root: processIdentity(Number(s.pid)), tree: [], started: new Date().toISOString() }, 2);
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
 * (or `base`), and its safety record. `repo`: the lead's working folder. No member of the
 * repository may be running.
 */
export async function addWorktree(home, { repo, member, team, cli, folder = null, base = null, owns = null }, { git = findGit(), now = () => new Date(), procs } = {}) {
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
          if (g.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], lead).status === 0) fail("branch_exists", `branch ${branch} already exists; hoptell does not reuse a branch (delete it, or pick another member or team name)`);
          const parent = path.join(path.dirname(main), `${path.basename(main)}-wt`);
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
  if (r.problem) return { problem: r.missing ? `${member} has no hoptell worktree (hoptell worktree list shows the members that have one)` : `the worktree record of ${member} ${r.problem}` };
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
  const head = g.run([...gd, "rev-parse", "--verify", "--quiet", `refs/heads/${rec.branch}`], rec.path);
  if (head.status !== 0 || text(head) !== rec.head) fail("head_moved", `${rec.branch} moved from ${rec.head} (the last commit hoptell recorded); hoptell commits only on that head`);
  return { rec, g, gd };
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** The changed paths of a worktree against its index and HEAD (untracked included). */
function changedPaths(g, gd, cwd) {
  const r = must(g, [...gd, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=none", "--"], cwd, "git_failed", "git status failed in the worktree");
  return r.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((e) => e.slice(3));
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
 * a link in its own folder). Returns the entries in `rels` order.
 */
function capture(rec, rels, { barrier = null } = {}) {
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
      input: JSON.stringify({ paths: rels, root: rec.path, rootDev: String(st.dev), rootIno: String(st.ino), maxBytes: CAPTURE_MAX }),
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
      const changed = changedPaths(g, gd, rec.path);
      if (!changed.length) fail("nothing_to_commit", `the worktree of ${member} has no changes`);
      const lines = capture(rec, changed, { barrier: captureBarrier }).map((e) => indexLine(g, gd, rec, e));
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
        must(g, [...gd, "update-ref", "-m", "hoptell worktree commit", `refs/heads/${rec.branch}`, commit, rec.head], rec.path, "head_moved", `${rec.branch} moved while committing; nothing was changed`);
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
export async function removeWorktree(home, member, { git = findGit(), procs } = {}) {
  const first = recordFor(home, member);
  const paths = privateDirs(home);
  return withQuietRepo(
    home,
    first.common,
    "remove",
    async (recheck) => {
      const { rec, g, gd } = openWorktree(home, member, { git, expect: first });
      const changed = changedPaths(g, gd, rec.path);
      if (changed.length) fail("dirty_tree", `the worktree of ${member} has ${changed.length} uncommitted change${changed.length > 1 ? "s" : ""} (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""}); commit them with hoptell worktree commit, or clean up by hand`);
      recheck();
      must(g, ["worktree", "remove", rec.path], rec.repo, "remove_failed", `git could not remove the worktree at ${rec.path} (it refuses ignored or locked content; clean up by hand)`);
      let branch = "kept";
      if (rec.head === rec.base) branch = g.run(["update-ref", "-d", `refs/heads/${rec.branch}`, rec.base], rec.repo).status === 0 ? "deleted" : "kept";
      fs.rmSync(paths.record(member), { force: true });
      fs.rmSync(paths.session(member), { force: true });
      return { path: rec.path, branch: rec.branch, head: rec.head, branchState: branch };
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
      const seen = observe();
      for (const r of rows) {
        if (r.problem) {
          out(`${r.member ?? "(registry)"}  (${r.problem})`);
          continue;
        }
        const st = liveState(home, r, seen);
        out(`${r.member}  ${r.cli}  ${st.state}  ${r.branch}  ${r.path}${r.exists ? "" : " (missing)"}  base ${r.base.slice(0, 12)}  head ${r.head.slice(0, 12)}  ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}${r.owns ? `  owns ${r.owns.join(",")}` : ""}`);
      }
      return;
    }
    if (!["add", "commit", "diff", "remove"].includes(sub ?? "")) usage(sub ? `unknown worktree command "${String(sub).slice(0, 40)}"` : "worktree needs a command");
    if (!member) usage(`worktree ${sub} needs a member name`);
    if (sub === "add") {
      if (!opt("--team") || !opt("--cli")) usage("worktree add needs --team and --cli");
      const owns = opt("--owns");
      const rec = await addWorktree(home, { repo: opt("--repo") ?? cwd, member, team: opt("--team"), cli: opt("--cli"), folder: opt("--folder") ?? null, base: opt("--base") ?? null, owns: owns === undefined ? null : owns.split(",").map((o) => o.trim()).filter(Boolean) });
      out(`Worktree for ${member}: ${rec.path}`);
      out(`  branch ${rec.branch} at ${rec.base}`);
      out(`Start it there: hoptell tmux ${member} --cwd ${rec.path} --task <file> -- <hoptell agents flags ${rec.cli} --role implementer --lead <you>>`);
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
    const r = await removeWorktree(home, member);
    out(`Removed ${r.path}.`);
    out(r.branchState === "deleted" ? `  branch ${r.branch} deleted (it had no commits)` : `  branch ${r.branch} kept at ${r.head}; delete it once it has landed`);
  } catch (e) {
    if (e instanceof GitError || e.code === "busy") die(e.message);
    throw e;
  }
}
