// Agent runs (design 7.1): the run record, the run directory, the per-run supervisor, stopping,
// the sweep and pruning.
//
//   <home>/agents/runs/<run>.json   the run record (0600), changed only under the agents lock
//   <home>/agents/runs/<run>/       0700: task.md, relays.json, env, mcp.json, output, log, result
//
// Process identity: the record stores {pid, start, uid, boot} of the supervisor, the agent
// (headless) and the tmux pane's process. Every path that signals compares all four with the
// stored values first (lib/host.js sameIdentity) and signals nothing when any part cannot be read
// or differs: the run then ends as `lost`. Nothing is ever killed by name or pattern.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { BIN } from "./config.js";
import { agentsPaths, approvalOf, audit, ensureAgentsDirs, readApproved, readPrivateFile, readProfile, sha256, withAgentsLock } from "./agents.js";
import { currentBoot, descendantIdentities, identityState, processIdentity, processTable, sameIdentity } from "./host.js";
import { writeRecord } from "./locks.js";
import { GATES, OFFERED_MODES, cliDigest, gateRefusal, gateShape, headlessModeOf, nativeDigest, storedShape } from "./agentadapters.js";
import { CLOUD_NOTE, checkHardening, cloudLineClass, managedSources, preflight, preflightTargets } from "./agentdeny.js";

export const RUN_RE = /^r_[0-9a-f]{16}$/;
export const LIVE = ["starting", "running", "stopping"];
export const ENDED = ["exited", "stopped", "expired", "lost", "failed", "discarded"];
const RECORD_MAX = 64 * 1024;
export const STREAM_CAP = 10 * 1024 * 1024; // stdout and log, each
export const STOP_GRACE_MS = 10_000;
const START_WAIT_MS = 15_000; // a "starting" record without a supervisor counts as live this long
export const KEEP = { days: 7, runs: 100 };
const POLL_MS = 1000;

export const newRunId = () => `r_${crypto.randomBytes(8).toString("hex")}`;

/** The files of one run. */
export function runPaths(home, run) {
  if (!RUN_RE.test(run)) throw new Error(`"${String(run).slice(0, 40)}" is not a run id`);
  const runs = agentsPaths(home).runs;
  const dir = path.join(runs, run);
  return { record: path.join(runs, `${run}.json`), dir, task: path.join(dir, "task.md"), relays: path.join(dir, "relays.json"), env: path.join(dir, "env"), mcp: path.join(dir, "mcp.json"), output: path.join(dir, "output"), log: path.join(dir, "log"), result: path.join(dir, "result"), agentEnv: path.join(dir, "agent-env.json") };
}

/** Read a run record with the file checks: the record, or {problem}. */
export function readRunChecked(home, run) {
  if (!RUN_RE.test(String(run))) return { problem: "not a run id" };
  // (readPrivateFile reads again after a transient hard-link check failure during a rename.)
  const r = readPrivateFile(runPaths(home, run).record, RECORD_MAX);
  if (r.problem) return { problem: r.missing ? "no such run" : `the run record is ${r.problem}` };
  try {
    const rec = JSON.parse(r.bytes.toString("utf8"));
    if (rec?.version !== 1 || rec.run !== run) return { problem: "the run record is malformed" };
    return { rec };
  } catch {
    return { problem: "the run record is not valid JSON" };
  }
}

/** The run record, or null when missing or failing the checks. */
export const readRun = (home, run) => readRunChecked(home, run).rec ?? null;

/** Every run record of the home (unreadable ones left out), newest first. */
export function listRuns(home) {
  let names;
  try {
    names = fs.readdirSync(agentsPaths(home).runs);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json") && RUN_RE.test(n.slice(0, -5)))
    .map((n) => readRun(home, n.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** Write a new record and its private run directory (the caller holds the agents lock). */
export function createRunFiles(home, rec) {
  ensureAgentsDirs(home);
  const p = runPaths(home, rec.run);
  fs.mkdirSync(p.dir, { mode: 0o700 });
  writeRecord(p.record, { version: 1, ...rec });
  return p;
}

/** Change a record under the agents lock: fn(rec) mutates it or returns false to leave it. */
export async function updateRun(home, run, fn) {
  return withAgentsLock(home, () => {
    const rec = readRun(home, run);
    if (!rec) return null;
    if (fn(rec) === false) return rec;
    writeRecord(runPaths(home, run).record, rec);
    return rec;
  });
}

/**
 * Does a record count as live (limits, the run-only MCP server)? A live state whose supervisor
 * still matches its stored identity, or a "starting" record whose supervisor has not recorded
 * itself yet and that was created moments ago.
 */
export function isLive(rec, { now = Date.now(), check = sameIdentity } = {}) {
  if (!rec || !LIVE.includes(rec.state)) return false;
  if (rec.supervisor) return check(rec.supervisor);
  return rec.state === "starting" && now - Date.parse(rec.created) < START_WAIT_MS;
}

/**
 * The tri-state observation behind `check`: identityState for the real check; an injected
 * boolean check (tests) reads as "same" or "different".
 */
const stateOf = (check) => (check === sameIdentity ? identityState : (id) => (check(id) ? "same" : "different"));

/**
 * Signal a recorded process after the identity check: "signalled", "mismatch" (nothing sent),
 * "gone" (it matched but had exited by the time of the signal: ESRCH, or a refusal after which
 * its exit is positively observed) or "failed" (the signal was refused and its exit is not
 * observed: it may still run). `group`: its whole process group.
 */
export function signalChecked(identity, sig, { group = false, check = sameIdentity, kill = process.kill, state = stateOf(check) } = {}) {
  if (!check(identity)) return "mismatch";
  try {
    kill(group ? -identity.pid : identity.pid, sig);
    return "signalled";
  } catch (e) {
    if (e?.code === "ESRCH") return "gone";
    // macOS refuses (EPERM) a signal to a group whose processes have all exited but are not yet
    // reaped: only an exit actually observed (not an unreadable identity) makes it "gone".
    return state(identity) === "different" ? "gone" : "failed";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long a process may take to go after SIGKILL (a loaded machine) before a stop reports failed.
const KILL_WAIT_MS = 5000;

/** Wait until the process is observed gone (identityState "different"), up to ms. */
async function endsWithin(identity, ms, state) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (state(identity) === "different") return true;
    await sleep(100);
  }
  return state(identity) === "different";
}

/**
 * Stop a recorded process: SIGTERM after the identity check, SIGKILL after the grace period,
 * checked again. For tmux, `tmuxEnd` (guarded kill-session on the recorded pane and pid) replaces
 * the SIGTERM. Returns "ended" (its exit was observed: identityState "different"), "lost"
 * (nothing was signalled: it did not match, or its identity could not be read) or "failed" (a
 * signal was refused, or its exit was not observed after SIGKILL: it may still run, so it must
 * not be recorded as ended).
 */
export async function stopProcess(identity, { group = true, graceMs = STOP_GRACE_MS, check = sameIdentity, kill = process.kill, tmuxEnd = null, note = () => {}, state = stateOf(check) } = {}) {
  if (!identity || !check(identity)) return "lost";
  if (tmuxEnd) {
    if (!tmuxEnd()) {
      // The pane no longer runs that process: nothing else is signalled.
      return state(identity) === "different" ? "ended" : "lost";
    }
  } else {
    const r = signalChecked(identity, "SIGTERM", { group, check, kill, state });
    note(`SIGTERM: ${r}`);
    if (r === "mismatch") return state(identity) === "different" ? "ended" : "lost";
    if (r === "failed") return "failed";
  }
  if (await endsWithin(identity, graceMs, state)) return "ended";
  // ESRCH ("gone") is not proof: the group can be absent while the pid still runs. Only an exit
  // observed afterwards counts as ended.
  const k = signalChecked(identity, "SIGKILL", { group, check, kill, state });
  note(`SIGKILL: ${k}`);
  if (k === "failed") return "failed";
  if (k === "mismatch" && state(identity) !== "different") return "failed";
  return (await endsWithin(identity, KILL_WAIT_MS, state)) ? "ended" : "failed";
}

// How often a supervisor reads its agent's process tree.
const TREE_POLL_MS = 1000;
// The most descendants a run may have recorded at once: more stops the run (tree_limit). While
// it stops, what is seen is still recorded, up to TREE_HARD (the run record has a size limit);
// a recorded identity is never dropped to make room, and anything past TREE_HARD is counted and
// reported (log, audit, the run's end), never left out silently.
export const TREE_MAX = 256;
export const TREE_HARD = 384;

/** A well-formed stored identity ({pid, start, uid, boot}). */
const isIdentity = (x) => Boolean(x) && Number.isSafeInteger(x.pid) && x.pid > 1 && typeof x.start === "string" && Number.isSafeInteger(x.uid) && typeof x.boot === "string";

/**
 * The descendants of an agent recorded while it runs. A CLI may start its commands and MCP
 * servers in process groups or sessions of their own (Codex does), which a signal to the agent's
 * group does not reach, and a process the agent leaves behind is re-parented away from it. So
 * `poll()` (once a second) records the identity of each descendant it sees, from one read of the
 * process table, and only while the root still matches; `end()` stops every recorded process that
 * still matches its identity, each by its exact pid: SIGTERM, then SIGKILL after `graceMs`.
 * The guarantee covers recorded descendants only: a process that starts and is re-parented away
 * between two polls is never seen, and can outlive the run.
 * A recorded identity is forgotten only when it is positively observed gone (`state(id)` is
 * "different": the pid absent, a zombie, another start, uid or boot); an unreadable one is kept,
 * and end() reports it as failed. Past `max` recorded identities nothing is evicted: every
 * descendant seen is still recorded (up to `hard`; beyond it counted in `unrecorded`) and
 * `onOverflow()` is called once, after that poll's identities were recorded (the supervisor
 * stops the run).
 * `known`: identities recorded earlier (the run record's `tree`); `onChange()` is called when the
 * recorded set changes. end() returns {ended, failed: [identities]} (failed: still running, or
 * not observed gone).
 */
export function processTree(root, { table = processTable, boot = currentBoot, check = sameIdentity, state = null, kill = process.kill, known = [], onChange = () => {}, onOverflow = () => {}, max = TREE_MAX, hard = TREE_HARD } = {}) {
  // An injected boolean check (tests) cannot observe an exit: false reads as "unknown".
  const stateNow = state ?? (check === sameIdentity ? identityState : (id) => (check(id) ? "same" : "unknown"));
  const map = new Map();
  for (const id of Array.isArray(known) ? known : []) if (isIdentity(id)) map.set(id.pid, id);
  const tree = {
    known: map,
    overflow: false,
    unrecorded: new Set(),
    poll() {
      const t = table();
      if (!t) return;
      let changed = false;
      // Forget what is positively gone: the table no longer shows it as that process, and its
      // own identity check confirms the exit (a row missed by a transient read error is kept).
      for (const [pid, id] of map) {
        const r = t.get(pid);
        if (r?.unknown) continue;
        if (r && !r.zombie && r.start === id.start && r.uid === id.uid) continue;
        if (stateNow(id) === "different") {
          map.delete(pid);
          changed = true;
        }
      }
      const found = root ? descendantIdentities(root, { table: t, boot: boot() }) : [];
      // The root is checked again after the table was read: a root that went meanwhile adds nothing.
      let overflowNow = false;
      if (found.length && check(root)) {
        for (const id of found) {
          if (map.get(id.pid)?.start === id.start) continue;
          if (!map.has(id.pid) && map.size >= max && !tree.overflow) overflowNow = tree.overflow = true;
          if (!map.has(id.pid) && map.size >= hard) {
            tree.unrecorded.add(`${id.pid}@${id.start}`);
            continue;
          }
          map.set(id.pid, id);
          changed = true;
        }
      }
      if (changed) onChange();
      if (overflowNow) onOverflow();
    },
    async end({ graceMs = STOP_GRACE_MS } = {}) {
      // Only an identity observed "different" is gone; "same" is signalled, "unknown" is kept.
      const sort = () => {
        const same = [];
        const unknown = [];
        for (const [pid, id] of map) {
          const st = stateNow(id);
          if (st === "different") map.delete(pid);
          else (st === "same" ? same : unknown).push(id);
        }
        return { same, unknown };
      };
      const n = map.size;
      let { same } = sort();
      if (!n) return { ended: 0, failed: [] };
      for (const id of same) signalChecked(id, "SIGTERM", { check, kill, state: stateNow });
      for (const until = Date.now() + graceMs; same.length && Date.now() < until; ({ same } = sort())) await sleep(100);
      for (const id of same) signalChecked(id, "SIGKILL", { check, kill, state: stateNow });
      for (const until = Date.now() + KILL_WAIT_MS; same.length && Date.now() < until; ({ same } = sort())) await sleep(100);
      const failed = [...map.values()];
      return { ended: n - failed.length, failed };
    },
  };
  return tree;
}

const TREE_LIMIT_LINE = `the agent has more than ${TREE_MAX} processes to record; stopping it (tree_limit)`;
/** The terminal state of a supervised run: a stop's kind, `tree_limit` ends it failed. */
const endStateOf = (how) => (how?.outcome === "lost" ? "lost" : !how ? "exited" : how.kind === "tree_limit" || how.kind === "read_containment_changed" ? "failed" : how.kind);
const treeLimitFields = (how, tree) => ({
  ...(how?.kind === "tree_limit" && how.outcome !== "lost" ? { error: "tree_limit", errorText: `the agent had more than ${TREE_MAX} descendant processes to record at once` } : {}),
  ...(how?.kind === "read_containment_changed" && how.outcome !== "lost" ? { error: "read_containment_changed", errorText: `stopped after start: an input of the run's path denial changed (${how.why})`.slice(0, 500) } : {}),
  ...(tree?.unrecorded.size ? { treeUnrecorded: tree.unrecorded.size } : {}),
});

/** Keep the recorded descendants in the run record (atomically), so a sweep can end them. */
const persistTree = (home, run, tree) =>
  updateRun(home, run, (r) => {
    if (ENDED.includes(r.state)) return false;
    r.tree = [...tree.known.values()];
  }).catch(() => {});

/** The supervisor's tree options from its hooks (tests: a fake table, a kill, smaller limits). */
const treeHooks = (hooks, root) => ({
  ...(hooks.treeTable ? { table: () => hooks.treeTable(root) } : {}),
  ...(hooks.treeMax ? { max: hooks.treeMax } : {}),
  ...(hooks.treeHard ? { hard: hooks.treeHard } : {}),
  kill: hooks.treeKill ?? process.kill,
});

/** End what is left of an agent's tree, with a line in the run log when anything was. */
async function endTree(tree, graceMs, logLine) {
  if (tree.unrecorded.size) logLine(`${tree.unrecorded.size} process(es) of the agent were seen but not recorded (more than ${TREE_HARD} at once); they are not ended by hoptell`);
  const r = await tree.end({ graceMs });
  if (r.ended) logLine(`ended ${r.ended} process(es) the agent left behind`);
  if (r.failed.length) logLine(`could not end process(es) the agent left behind: ${r.failed.map((x) => x.pid).join(", ")}`);
  return r;
}

/**
 * Descendants that could not be ended: the run is not recorded as ended. It stays `stopping`
 * with its intended end (`endAs`) and those identities (`tree`), and a sweep ends them and then
 * the run. Returns false when the run had already ended.
 */
async function leaveForSweep(home, run, endAs, failed) {
  let left = false;
  await updateRun(home, run, (r) => {
    if (ENDED.includes(r.state)) return false;
    r.state = "stopping";
    r.endAs = endAs;
    r.tree = failed;
    r.stopFailed = new Date().toISOString();
    left = true;
  });
  if (left) audit(home, "stop-incomplete", { run, left: failed.map((x) => x.pid) });
  return left;
}

/**
 * Write a run's terminal state under the agents lock: the first terminal write wins. `fields`
 * are assigned to the record. Returns {won, rec}; only the winner audits the end, delivers and
 * removes the run's settings files.
 */
export async function finishRun(home, run, fields) {
  let won = false;
  const rec = await updateRun(home, run, (r) => {
    if (ENDED.includes(r.state)) return false;
    Object.assign(r, fields, { ended: new Date().toISOString() });
    won = true;
  });
  return { won, rec };
}

// ---- the agent's environment ---------------------------------------------------------------------

const KEPT = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ"];

/**
 * The agent's environment, from an allow list (never the spawner's environment as a whole):
 * the kept variables and LC_*, the run's HOPTELL_* settings, and the profile's env.pass names.
 * Every other HOPTELL_* is dropped (HOPTELL_TOKEN, HOPTELL_RELAY, HOPTELL_AUTH, ...).
 */
export function agentEnv(base, { home, run, name, roles, pass = [] }) {
  const p = runPaths(home, run);
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (KEPT.includes(k) || k.startsWith("LC_") || (pass.includes(k) && !k.startsWith("HOPTELL_"))) env[k] = v;
  }
  return { ...env, HOPTELL_HOME: home, HOPTELL_NAME: name, HOPTELL_ROLES: roles.join(","), HOPTELL_RELAYS: p.relays, HOPTELL_ENV: p.env, HOPTELL_RUN: run };
}

// ---- starting a supervisor -------------------------------------------------------------------------

/**
 * Start the supervisor of `run`, detached in its own session and process group, with `env` (the
 * scrubbed environment), so it outlives the caller. Resolves once the record is `running` or has
 * ended (the agent started or failed to), or after `waitMs` with the record as it is then.
 */
export async function startSupervisor(home, run, { env, waitMs = 30_000, node = process.execPath, bin = BIN } = {}) {
  const p = runPaths(home, run);
  const log = fs.openSync(p.log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  let child;
  try {
    child = spawn(node, [bin, "agents", "supervise", run, "--home", home], { detached: true, stdio: ["ignore", log, log], env, cwd: "/" });
  } finally {
    fs.closeSync(log);
  }
  child.on("error", () => {});
  child.unref();
  const until = Date.now() + waitMs;
  for (;;) {
    const rec = readRun(home, run);
    if (!rec || rec.state !== "starting" || Date.now() > until) return rec;
    if (rec.supervisor === undefined && child.exitCode !== null) return rec;
    await sleep(50);
  }
}

// ---- the supervisor ----------------------------------------------------------------------------------

/** Cut a UTF-8 buffer to at most max bytes at a character boundary. */
export function cutUtf8(buf, max) {
  if (buf.length <= max) return buf;
  let n = max;
  while (n > 0 && (buf[n] & 0xc0) === 0x80) n--;
  return buf.subarray(0, n);
}

/** A capped writer into a file: keeps the first `cap` bytes, drains and counts the rest. */
function cappedFile(file, cap) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  let written = fs.fstatSync(fd).size;
  let dropped = 0;
  return {
    write(chunk) {
      const room = Math.max(0, cap - written);
      const keep = chunk.subarray(0, room);
      if (keep.length) {
        fs.writeSync(fd, keep);
        written += keep.length;
      }
      dropped += chunk.length - keep.length;
    },
    close() {
      fs.closeSync(fd);
      return { bytes: written, dropped };
    },
  };
}

/**
 * The final answer of a headless run: from the CLI's own channel (`plan.result.from`: "file", the
 * CLI wrote <run>/result; "json", a field of the JSON on stdout), else stdout; cut to `max` bytes.
 */
export function collectResult(p, plan, max) {
  const notes = [];
  let buf = null;
  const from = plan.result?.from ?? "stdout";
  if (from === "file") {
    // Written by the CLI with its own umask, inside the private run directory.
    const r = readPrivateFile(p.result, 64 * 1024 * 1024, { privateMode: false });
    if (r.bytes) buf = r.bytes;
    else notes.push("the CLI wrote no final answer; stdout is used");
  } else if (from === "json") {
    try {
      const doc = JSON.parse(fs.readFileSync(p.output, "utf8"));
      const v = doc?.[plan.result.field ?? "result"];
      if (typeof v === "string") buf = Buffer.from(v);
      else notes.push("the CLI's JSON had no final answer; stdout is used");
    } catch {
      notes.push("the CLI's output was not JSON; stdout is used");
    }
  }
  if (!buf) {
    try {
      buf = fs.readFileSync(p.output);
    } catch {
      buf = Buffer.alloc(0);
    }
  }
  const full = buf.length;
  const kept = cutUtf8(buf, max);
  if (kept.length < full) notes.push(`the result was cut from ${full} to ${kept.length} bytes (limits.resultBytes)`);
  return { text: kept, notes, full };
}

/**
 * `hoptell agents supervise <run>`: start the agent, enforce the lifetime, collect the result,
 * record the end. `env` is the supervisor's own (scrubbed) environment, which the agent's is built from. `hooks` (filled by the spawn module): beforeAgent(rec) may throw {code} to fail
 * the run before the agent starts (the name probe); deliver(rec, result) sends the result; launchTmux(rec)
 * starts a tmux run and returns {pane, pid, session, end()}.
 */
export async function supervise(home, run, hooks = {}, { env } = {}) {
  const p = runPaths(home, run);
  // A stop can come at any time from now on (stop_agent signals the recorded supervisor).
  const signals = { requested: false, onStop: null };
  process.on("SIGTERM", () => {
    signals.requested = true;
    signals.onStop?.();
  });
  process.on("SIGHUP", () => {}); // the spawner's terminal going away changes nothing
  const logLine = (...a) => {
    try {
      fs.appendFileSync(p.log, `[hoptell ${new Date().toISOString()}] ${a.join(" ")}\n`);
    } catch {}
  };
  const self = processIdentity(process.pid);
  let rec = await updateRun(home, run, (r) => {
    if (r.state !== "starting" || r.supervisor) return false;
    r.supervisor = self;
  });
  if (!rec || rec.state !== "starting" || !self || rec.supervisor?.pid !== process.pid) return logLine("not a run waiting for its supervisor; nothing started");
  const fail = async (code, message) => {
    logLine("failed:", message);
    const f = await finishRun(home, run, { state: "failed", error: code, errorText: String(message).slice(0, 500) });
    if (!f.won) return;
    audit(home, "ended", { run, state: "failed", error: code });
    removeRunSecrets(p);
  };
  if (rec.cliVersionUntested) logLine(`warning: ${rec.cli} ${rec.cliVersion ?? "(version unknown)"} is a version the adapter's tests have not covered; its flags were checked, its sandbox and approval behaviour were not`);
  try {
    await hooks.beforeAgent?.(rec, { log: logLine });
  } catch (e) {
    return fail(e.code ?? "failed", e.message);
  }
  if (signals.requested || readRun(home, run)?.state === "stopping") {
    // Stopped before the agent started: nothing to signal.
    const f = await finishRun(home, run, { state: "stopped" });
    if (!f.won) return;
    audit(home, "ended", { run, state: "stopped", stoppedBy: f.rec.stoppedBy ?? null });
    return removeRunSecrets(p);
  }
  return rec.mode === "tmux" ? superviseTmux(home, rec, p, hooks, { logLine, fail, signals, env }) : superviseHeadless(home, rec, p, hooks, { logLine, fail, signals, env });
}

/** Remove the run's settings files (relays file, env, MCP configuration) at the end of a run. */
export function removeRunSecrets(p) {
  for (const f of [p.relays, p.env, p.mcp, p.agentEnv]) fs.rmSync(f, { force: true });
}

/** The run's identifiers in the agent's environment: the only values put on a tmux command line. */
export const RUN_IDS = ["HOPTELL_HOME", "HOPTELL_NAME", "HOPTELL_ROLES", "HOPTELL_RELAYS", "HOPTELL_ENV", "HOPTELL_RUN"];

/**
 * The agent's environment for a tmux run, pass-through values included, in a private file of the
 * run (0600, created exclusively); `hoptell agents exec` reads and removes it before it starts
 * the CLI, so no value of it is ever a command-line argument.
 */
export function writeAgentEnvFile(p, environment) {
  fs.rmSync(p.agentEnv, { force: true });
  fs.writeFileSync(p.agentEnv, JSON.stringify(environment), { mode: 0o600, flag: "wx" });
}

/** Read and remove the agent's environment file: the environment, or {problem}. */
export function takeAgentEnvFile(p) {
  const r = readPrivateFile(p.agentEnv, 256 * 1024);
  fs.rmSync(p.agentEnv, { force: true });
  if (r.problem) return { problem: `the run's environment file is ${r.problem}` };
  try {
    const env = JSON.parse(r.bytes.toString("utf8"));
    if (!env || typeof env !== "object" || Array.isArray(env) || !Object.values(env).every((v) => typeof v === "string")) throw new Error();
    return { env };
  } catch {
    return { problem: "the run's environment file is malformed" };
  }
}

/**
 * A run's task, read with the file checks and bound to the record: {bytes} only when its digest
 * is the record's taskDigest (the task the spawn was made and confirmed with), else {problem}.
 */
export function readTaskChecked(p, rec) {
  const t = readPrivateFile(p.task, rec.limits?.taskBytes ?? 32768);
  if (t.problem) return t;
  if (typeof rec.taskDigest !== "string" || sha256(t.bytes) !== rec.taskDigest) return { problem: "it is not the task the run was made with" };
  return t;
}

/**
 * Is `command` still the CLI the spawn (or its confirmation) checked? Its file's digest must be
 * the record's cliDigest, and the native binary it starts the record's nativeDigest (when one was
 * recorded; `home` holds the digest cache). null, or {code, problem}. Called right before the
 * CLI starts.
 */
export function cliProblem(rec, command, home) {
  if (typeof rec.cliDigest !== "string") return { code: "cli_changed", problem: "the run records no checked CLI" };
  const now = cliDigest(command);
  if (now.problem) return { code: "cli_missing", problem: now.problem };
  const changed = { code: "cli_changed", problem: `${command} changed since it was checked (another file or version); start the spawn again` };
  if (now.digest !== rec.cliDigest) return changed;
  if (rec.nativeDigest != null && nativeDigest(home, rec.cli, command).digest !== rec.nativeDigest) return changed;
  return null;
}

/**
 * The binding of a Codex headless run's stored plan to its mode (design-7.1-read-containment.md,
 * "Binding a run to its mode"), at confirmation and at start, without rebuilding the plan: the
 * profile re-read (its digest the record's, still approved), the plan's mode that profile's
 * codex.headlessMode and an offered mode, and the stored plan's shape (storedShape) the profile's
 * shape. With `gate` ({version, digest, native}: the binary as checked) the mode must also be gated
 * now for that binary and shape. A record without plan.mode (made before modes existed) counts as
 * plain only when its stored shape is a gated plain shape of that binary; anything else is refused,
 * and nothing is inferred from it. {profile, mode} or {code, message}; `changedCode` is the code
 * for a changed or unapproved profile.
 */
export function planBinding(home, rec, { homedir = null, env = null, gates = GATES, gate = null, changedCode = "profile_not_approved" } = {}) {
  const read = readProfile(home, rec.profile, { homedir, env, relaysFile: rec.ownerRelays ?? null, gates });
  if (!read.missing && read.problems.length) return { code: changedCode, message: `agent profile ${rec.profile} is no longer valid: ${read.problems.join("; ")}` };
  if (read.missing || read.digest !== rec.profileDigest || approvalOf(read, readApproved(home)) !== "approved") return { code: changedCode, message: `agent profile ${rec.profile} is missing, unreadable, changed or no longer approved since the spawn` };
  const mode = headlessModeOf(read.profile);
  const planMode = rec.plan?.mode;
  const unverified = (why) => ({ code: "adapter_gate_unverified", message: `run ${rec.run} cannot start: ${why}` });
  if (planMode === undefined && mode !== "plain") return unverified(`its plan records no headless mode, and its profile asks for ${mode}`);
  if (planMode !== undefined && planMode !== mode) return unverified(`its plan was made for headless mode ${planMode}, and its profile now asks for ${mode}`);
  if (!OFFERED_MODES.includes(mode)) return unverified(`headless mode ${mode} is not offered`);
  const shape = storedShape(rec.cli, rec.plan, { home, run: rec.run, cwd: rec.cwd });
  if (!shape || shape !== gateShape(read.profile, "headless")) return unverified("its stored arguments are not the shape of its profile's mode");
  if (gate || planMode === undefined) {
    const g = gate ?? { version: rec.cliVersion ?? null, digest: rec.cliDigest, native: rec.nativeDigest ?? null };
    if (gateRefusal(rec.cli, "headless", { ...g, shape }, gates, mode)) return { code: "adapter_gate_unverified", message: `${rec.cli} in headless mode is not available on this binary (version ${g.version ?? "unknown"}) with this run's arguments (headless mode ${mode}): its adapter gates have not passed` };
  }
  return { profile: read.profile, mode };
}

/** How often a hardened run's inputs are checked again while it runs (design: CONTAIN_POLL_MS). */
export const CONTAIN_POLL_MS = 1000;

/**
 * Steps 2-5 of the start-time revalidation of a hardened run, against the one environment object
 * `env1`; at a tick (`tick`) steps 2-4 only, never the preflight. null, or {problem} (paths and
 * classes only).
 */
function hardenedCheck(home, rec, env1, hooks, { tick = false } = {}) {
  const homedir = rec.homedir ?? env1.HOME ?? null;
  const b = planBinding(home, rec, { homedir, env: env1, gates: hooks.gates ?? GATES, gate: tick ? null : { version: rec.cliVersion ?? null, digest: rec.cliDigest, native: rec.nativeDigest ?? null }, changedCode: "read_containment_unverified" });
  if (b.code) return { problem: b.message };
  if (b.mode !== "hardening") return { problem: `the run's mode is ${b.mode}, not hardening` };
  const h = checkHardening({ home, relaysFile: rec.ownerRelays, homedir, env: env1, pass: rec.pass ?? [], cwd: rec.cwd, roots: b.profile.folders.roots, plan: rec.plan }, { managed: hooks.managed ?? managedSources, ...(hooks.fsx ? { fsx: hooks.fsx } : {}) });
  if (h.problem) return { problem: `${h.kind}: ${h.problem}` };
  if (tick) return null;
  const targets = preflightTargets({ home, run: rec.run, deny: h.deny, tokenFiles: h.tokenFiles, codexHome: h.codexHome });
  const pf = preflight({ command: rec.plan.command, plan: rec.plan, cwd: rec.cwd, env: env1, targets }, { ...(hooks.preflightRun ? { run: hooks.preflightRun } : {}) });
  if (pf) return { problem: `preflight: ${pf.problem}` };
  return null;
}

/**
 * The stream of a hardened run: one FIFO in the run directory for the CLI's stdout and stderr, so
 * their write order is kept (the cloud stream check needs it). {fd (the write end, for the child),
 * stream (the read end)}.
 */
function mergedStream(p) {
  const fifo = path.join(p.dir, "stream");
  fs.rmSync(fifo, { force: true });
  execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
  try {
    // O_RDWR opens without waiting for a reader; the read end then opens at once.
    const fd = fs.openSync(fifo, fs.constants.O_RDWR);
    const rfd = fs.openSync(fifo, fs.constants.O_RDONLY);
    return { fd, stream: fs.createReadStream(null, { fd: rfd }) };
  } finally {
    fs.rmSync(fifo, { force: true });
  }
}

async function superviseHeadless(home, rec, p, hooks, opts) {
  if (rec.plan?.mode === "hardening") return runHeadless(home, rec, p, hooks, opts, true);
  if (rec.plan?.mode !== undefined && rec.plan.mode !== "plain") return opts.fail("adapter_gate_unverified", `headless mode ${rec.plan.mode} is not offered`);
  // A plain Codex run: its plan stays bound to its profile's digest and mode, its stored arguments
  // to the plain shape (so a hardened plan never starts as plain, nor the reverse), and it is
  // gated now for the binary the spawn checked (an update that revokes the gate stops it here).
  // Every record a spawn makes has `probe`; a record without it was not made by a spawn.
  if (rec.probe && rec.cli === "codex") {
    const b = planBinding(home, rec, { homedir: rec.homedir ?? opts.env?.HOME ?? null, env: opts.env, gates: hooks.gates ?? GATES, gate: { version: rec.cliVersion ?? null, digest: rec.cliDigest, native: rec.nativeDigest ?? null } });
    if (b.code) return opts.fail(b.code, b.message);
  }
  return runHeadless(home, rec, p, hooks, opts, false);
}

/** The line a hardened run's stop after start leaves in its notes (never called a refusal). */
const CHANGED_NOTE = (why) => `stopped after start: an input of the run's path denial changed (${why}); the result is partial`;

/**
 * A headless run. `hardened`: path-deny hardening (design-7.1-read-containment.md): the one
 * environment object (the agent's plus RUST_LOG=codex_cloud_config=info), the start-time
 * revalidation and preflight right before the CLI starts, stdout and stderr on one FIFO (JSON lines
 * to `output`, the rest to `log`), the cloud stream audit, and the per-tick check that stops the
 * run with read_containment_changed. It never switches to another mode.
 */
async function runHeadless(home, rec, p, hooks, { logLine, fail, signals, env }, hardened) {
  const { run, plan } = rec;
  const graceMs = Math.min(STOP_GRACE_MS, Math.max(100, rec.graceMs ?? STOP_GRACE_MS));
  // The task the run was made (and confirmed) with: its bytes are read once, checked against the
  // record's taskDigest, and those bytes are what the agent gets on stdin.
  let task = null;
  if (plan.stdin === "task") {
    const t = readTaskChecked(p, rec);
    if (t.problem) return fail("failed", `the task cannot be used: ${t.problem}`);
    task = t.bytes;
  }
  // The CLI the spawn checked, and no other file, right before it starts.
  const changed = cliProblem(rec, plan.command, home);
  if (changed) return fail(changed.code, changed.problem);
  // Step 1: the environment, built once; the checks, the preflight, the CLI and every tick use it.
  const env1 = { ...agentEnv(env, { home, run, name: rec.name, roles: rec.roles, pass: rec.pass ?? [] }), ...(hardened ? { RUST_LOG: "codex_cloud_config=info" } : {}) };
  let merged = null;
  if (hardened) {
    // Steps 2-5, after cliProblem and immediately before the spawn, with no cache.
    const bad = hardenedCheck(home, rec, env1, hooks);
    if (bad) return fail("read_containment_unverified", `path-deny hardening could not be verified at start: ${bad.problem}`);
    try {
      merged = mergedStream(p);
    } catch (e) {
      return fail("failed", `the run's stream could not be made: ${e.message}`);
    }
  }
  let child;
  const t0 = Date.now();
  try {
    child = (hooks.spawn ?? spawn)(plan.command, plan.args, { cwd: rec.cwd, env: env1, stdio: [task ? "pipe" : "ignore", merged ? merged.fd : "pipe", merged ? merged.fd : "pipe"], detached: true });
  } catch (e) {
    if (merged) {
      fs.closeSync(merged.fd);
      merged.stream.destroy();
    }
    return fail("cli_missing", e.message);
  } finally {
    // The child holds its own copy of the write end.
    if (merged && child) fs.closeSync(merged.fd);
  }
  if (task) {
    child.stdin.on("error", () => {}); // an agent that exits without reading its task
    child.stdin.end(task);
  }
  const spawned = await new Promise((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (e) => resolve(e));
  });
  if (spawned) {
    merged?.stream.destroy();
    return fail("cli_missing", spawned.message);
  }
  const agent = processIdentity(child.pid);
  const out = cappedFile(p.output, STREAM_CAP);
  const err = cappedFile(p.log, STREAM_CAP);
  // A hardened run's cloud stream audit (design "Cloud stream check by mode": audit only).
  const cloud = { none: 0, firstEvent: false, observed: [] };
  const observe = (cls, counts = null) => {
    cloud.observed.push(cls);
    audit(home, "codex_cloud_config_observed", { run, class: cls, ...(counts && Object.keys(counts).length ? { counts } : {}) });
  };
  let streamEnded = Promise.resolve();
  if (merged) {
    // One stream, split by line: JSON lines are the event stream, the rest the log.
    let pending = Buffer.alloc(0);
    const line = (buf) => {
      const text = buf.toString("utf8");
      if (text.startsWith("{")) {
        if (!cloud.firstEvent) {
          cloud.firstEvent = true;
          if (cloud.none < 2) observe("missing_none");
        }
        out.write(buf);
        return;
      }
      const c = cloudLineClass(text);
      if (c?.cls === "none") cloud.none++;
      else if (c) observe(c.cls, c.counts);
      err.write(buf);
    };
    merged.stream.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let i; (i = pending.indexOf(10)) >= 0; ) {
        line(pending.subarray(0, i + 1));
        pending = pending.subarray(i + 1);
      }
      // A line longer than the stream cap is passed on in pieces (it cannot be a whole event).
      if (pending.length > STREAM_CAP) {
        err.write(pending);
        pending = Buffer.alloc(0);
      }
    });
    streamEnded = new Promise((resolve) => {
      merged.stream.once("close", resolve);
      merged.stream.once("end", () => {
        if (pending.length) line(pending);
        pending = Buffer.alloc(0);
        resolve();
      });
      merged.stream.once("error", resolve);
    });
  } else {
    child.stdout.on("data", (c) => out.write(c));
    child.stderr.on("data", (c) => err.write(c));
  }
  // With the merged stream the child has no stdio pipes: it is done at its exit; the stream ends
  // once whatever it left holding the write end is gone (after the tree's end, below).
  const exited = new Promise((resolve) => child.once(merged ? "exit" : "close", (code, signal) => resolve({ code, signal })));
  const tree = processTree(agent, { ...treeHooks(hooks, agent), onChange: () => persistTree(home, run, tree), onOverflow: () => stop("tree_limit") });
  // Stopping: on SIGTERM (stop_agent, hoptell agents stop: the record says who) or the lifetime.
  let stopping = null;
  const stop = (kind, why = null) => {
    if (stopping) return stopping;
    logLine(kind === "expired" ? "lifetime reached; stopping the agent" : kind === "tree_limit" ? TREE_LIMIT_LINE : kind === "read_containment_changed" ? `stopping the agent after start: an input of its path denial changed (${why})` : "stop requested; stopping the agent");
    stopping = (async () => {
      // A lock held too long (busy) does not abort the stop: the agent is still stopped.
      await updateRun(home, run, (r) => {
        if (r.state === "running" || r.state === "starting") r.state = "stopping";
      }).catch((e) => logLine("the run record could not be marked stopping:", e.message));
      tree.poll();
      // A changed input stops with the minimum grace, not the run's.
      return { kind, why, outcome: await stopProcess(agent, { group: true, graceMs: kind === "read_containment_changed" ? 100 : graceMs }) };
    })();
    return stopping;
  };
  // The per-tick check of a hardened run: steps 2-4 against the same environment object, one at a
  // time (a tick never overlaps the previous one); never the preflight.
  let tickTimer = null;
  let ticking = Boolean(merged);
  const tick = () => {
    if (!ticking) return;
    let bad;
    try {
      bad = hardenedCheck(home, rec, env1, hooks, { tick: true });
    } catch (e) {
      bad = { problem: `the check failed (${e.message})` };
    }
    if (bad) {
      audit(home, "read_containment_changed", { run, reason: String(bad.problem).slice(0, 300) });
      stop("read_containment_changed", String(bad.problem).slice(0, 300));
      return;
    }
    tickTimer = setTimeout(tick, hooks.containPollMs ?? CONTAIN_POLL_MS);
  };
  if (merged) tickTimer = setTimeout(tick, hooks.containPollMs ?? CONTAIN_POLL_MS);
  // The tree is read only from here on: `stop` (its overflow handler) exists.
  const treePoll = setInterval(() => tree.poll(), TREE_POLL_MS);
  const lifetimeMs = rec.lifetimeMinutes * 60_000;
  await updateRun(home, run, (r) => {
    r.agent = agent;
    r.state = r.state === "stopping" ? "stopping" : "running";
    r.started = new Date(t0).toISOString();
    r.ends = new Date(t0 + lifetimeMs).toISOString();
  });
  audit(home, "started", { run, supervisor: rec.supervisor, agent, wireNames: rec.wireNames, args: [plan.command, ...plan.args], ...(plan.mode ? { headlessMode: plan.mode } : {}), ...(rec.cliVersionUntested ? { cliVersionUntested: true, cliVersion: rec.cliVersion ?? null } : {}) });
  const timer = setTimeout(() => stop("expired"), lifetimeMs);
  signals.onStop = () => stop("stopped");
  // A stop requested before the agent was recorded.
  if (signals.requested || readRun(home, run)?.state === "stopping") stop("stopped");
  const { code, signal } = await exited;
  clearTimeout(timer);
  ticking = false;
  clearTimeout(tickTimer);
  const how = stopping ? await stopping : null;
  // What the agent left running (after an exit or a stop) and the tree recorded ends with it.
  clearInterval(treePoll);
  const left = await endTree(tree, graceMs, logLine);
  if (merged) {
    // A process the tree did not record may still hold the stream: it is not waited for long.
    const done = await Promise.race([streamEnded.then(() => true), sleep(2000).then(() => false)]);
    if (!done) {
      logLine("the agent's stream was still open after its end; it is closed");
      merged.stream.destroy();
    }
  }
  const o = out.close();
  const e = err.close();
  const result = collectResult(p, plan, rec.limits.resultBytes);
  const notes = [...result.notes];
  if (o.dropped) notes.push(`stdout was cut at ${STREAM_CAP} bytes (${o.dropped} bytes discarded)`);
  if (e.dropped) notes.push(`the log was cut at ${STREAM_CAP} bytes (${e.dropped} bytes discarded)`);
  if (tree.unrecorded.size) notes.push(`${tree.unrecorded.size} process(es) of the agent were seen but not recorded (more than ${TREE_HARD} at once) and may still run`);
  if (how) notes.push(how.kind === "expired" ? "the lifetime ran out: the result is partial" : how.kind === "tree_limit" ? `the agent started more than ${TREE_MAX} processes at once and was stopped (tree_limit): the result is partial` : how.kind === "read_containment_changed" ? CHANGED_NOTE(how.why) : "the run was stopped: the result is partial");
  if (cloud.observed.length) notes.push(CLOUD_NOTE);
  fs.writeFileSync(`${p.result}.tmp`, result.text, { mode: 0o600 });
  fs.renameSync(`${p.result}.tmp`, p.result);
  // The agent has exited (its close event came): a stop's "failed" outcome changes nothing now.
  const state = endStateOf(how);
  const digest = sha256(result.text);
  const endAs = { state, ...treeLimitFields(how, tree), exit: { code, signal }, duration: Date.now() - t0, result: { bytes: result.text.length, digest, notes } };
  if (left.failed.length) {
    // The agent's answer is delivered; the run ends once a sweep has ended what is left.
    if (!(await leaveForSweep(home, run, endAs, left.failed))) return logLine("the run was already ended; its result is kept but not delivered");
    const shown = [...notes, `${left.failed.length} process(es) the agent left behind could not be ended yet`];
    try {
      await hooks.deliver?.({ ...readRun(home, run), ...endAs }, { text: result.text, notes: shown, log: logLine });
    } catch (err2) {
      logLine("the result could not be delivered:", err2.message);
    }
    return removeRunSecrets(p);
  }
  const f = await finishRun(home, run, endAs);
  if (!f.won) return logLine(`the run was already ended (${f.rec?.state}); its result is kept but not delivered`);
  const final = f.rec;
  audit(home, "ended", { run, state, ...(endAs.error ? { error: endAs.error } : {}), ...(endAs.treeUnrecorded ? { treeUnrecorded: endAs.treeUnrecorded } : {}), exit: { code, signal }, duration: final.duration, result: { bytes: result.text.length, digest }, ...(final.stoppedBy ? { stoppedBy: final.stoppedBy } : {}) });
  try {
    await hooks.deliver?.(final, { text: result.text, notes, log: logLine });
  } catch (err2) {
    logLine("the result could not be delivered:", err2.message);
  }
  removeRunSecrets(p);
}

async function superviseTmux(home, rec, p, hooks, { logLine, fail, signals, env }) {
  const { run } = rec;
  const graceMs = Math.min(STOP_GRACE_MS, Math.max(100, rec.graceMs ?? STOP_GRACE_MS));
  if (!hooks.launchTmux) return fail("failed", "tmux mode is not available");
  // The CLI the spawn checked (hoptell agents exec checks it again right before it starts it).
  const changed = cliProblem(rec, rec.plan?.cli?.command ?? "", home);
  if (changed) return fail(changed.code, changed.problem);
  let t;
  const t0 = Date.now();
  try {
    const full = agentEnv(env, { home, run, name: rec.name, roles: rec.roles, pass: rec.pass ?? [] });
    writeAgentEnvFile(p, full);
    t = await hooks.launchTmux(rec, { ids: Object.fromEntries(RUN_IDS.map((k) => [k, full[k]])), base: env });
  } catch (e) {
    // The agent's settings go first: without them `hoptell agents exec` starts no CLI, so a process
    // of the pane that a stop's signal misses (one forked while the signal went out) starts none.
    fs.rmSync(p.agentEnv, { force: true });
    // The agent's pane had started (its session was ended): its process is stopped by its pid,
    // after the identity check, in case it outlived the session.
    if (/^\d+$/.test(String(e?.started?.pid ?? ""))) {
      const left = processIdentity(Number(e.started.pid));
      let stopped = left ? await (hooks.stopProcess ?? stopProcess)(left, { group: true, graceMs, note: (m) => logLine(m) }) : "lost";
      logLine("the agent's process after a failed start:", stopped);
      if (stopped === "failed") {
        // It may still run: the run stays live (`stopping`) with the pane's identity and session
        // id, so a sweep retries if this supervisor goes; the session is ended by id again, and
        // the run ends only once the process is observed gone.
        await updateRun(home, run, (r) => {
          if (ENDED.includes(r.state)) return false;
          r.state = "stopping";
          r.pane = { ...left, pane: e.started.pane, session: `hoptell-${rec.name}`, sessionId: e.started.sessionId };
          r.error = e.code ?? "failed";
          r.errorText = String(e.message).slice(0, 500);
          r.stopFailed = new Date().toISOString();
        });
        try {
          logLine("its session ended again:", e.started.end?.() ?? "not available");
        } catch (err) {
          logLine("its session could not be ended:", err.message);
        }
        logLine("waiting for the agent's process to exit");
        while ((hooks.identityState ?? identityState)(left) !== "different") await sleep(POLL_MS);
      }
    }
    return fail(e.code ?? "failed", e.message);
  }
  const pane = processIdentity(Number(t.pid));
  const lifetimeMs = rec.lifetimeMinutes * 60_000;
  await updateRun(home, run, (r) => {
    r.pane = pane ? { ...pane, pane: t.pane, session: t.session, sessionId: t.sessionId } : null;
    r.state = r.state === "stopping" ? "stopping" : "running";
    r.started = new Date(t0).toISOString();
    r.ends = new Date(t0 + lifetimeMs).toISOString();
  });
  audit(home, "started", { run, supervisor: rec.supervisor, agent: pane, wireNames: rec.wireNames, args: rec.plan ? [rec.plan.command, ...rec.plan.args] : [], tmux: { session: t.session, sessionId: t.sessionId, pane: t.pane } });
  if (!pane) {
    // The pane's process could not be read right after the start: it is never signalled.
    const f = await finishRun(home, run, { state: "lost", lostReason: "the pane's process could not be read after the start" });
    if (!f.won) return;
    audit(home, "ended", { run, state: "lost" });
    return removeRunSecrets(p);
  }
  let stopping = null;
  const tree = processTree(pane, { ...treeHooks(hooks, pane), onChange: () => persistTree(home, run, tree), onOverflow: () => stop("tree_limit") });
  const stop = (kind) => {
    stopping ??= (async () => {
      logLine(kind === "expired" ? "lifetime reached; ending the tmux session" : kind === "tree_limit" ? TREE_LIMIT_LINE : "stop requested; ending the tmux session");
      await updateRun(home, run, (r) => {
        if (r.state === "running") r.state = "stopping";
      }).catch((e) => logLine("the run record could not be marked stopping:", e.message));
      tree.poll();
      return { kind, outcome: await stopProcess(pane, { graceMs, tmuxEnd: () => t.end(pane.pid) }) };
    })();
    return stopping;
  };
  // The tree is read only from here on: `stop` (its overflow handler) exists.
  const treePoll = setInterval(() => tree.poll(), TREE_POLL_MS);
  const timer = setTimeout(() => stop("expired"), lifetimeMs);
  signals.onStop = () => stop("stopped");
  if (signals.requested || readRun(home, run)?.state === "stopping") stop("stopped");
  // The run ends when the pane's process exits (or no longer matches), or when stopped.
  // An unreadable identity is not an exit: only an exit observed ends the run.
  while (identityState(pane) !== "different" && !stopping) await sleep(POLL_MS);
  clearTimeout(timer);
  const how = stopping ? await stopping : null;
  if (how?.outcome === "failed") {
    // It could not be stopped: never recorded as ended while it still matches.
    logLine("the tmux session could not be ended; waiting for its process to exit");
    while (identityState(pane) !== "different") await sleep(POLL_MS);
  }
  clearInterval(treePoll);
  const left = await endTree(tree, graceMs, logLine);
  // The agent exited by itself: the session (with its injector) is ended by its immutable id.
  if (!how) t.cleanup?.();
  const state = endStateOf(how);
  const endAs = { state, ...treeLimitFields(how, tree), duration: Date.now() - t0 };
  if (left.failed.length) {
    await leaveForSweep(home, run, endAs, left.failed);
    return removeRunSecrets(p);
  }
  const f = await finishRun(home, run, endAs);
  if (!f.won) return;
  const final = f.rec;
  audit(home, "ended", { run, state, ...(endAs.error ? { error: endAs.error } : {}), ...(endAs.treeUnrecorded ? { treeUnrecorded: endAs.treeUnrecorded } : {}), duration: final.duration, ...(final.stoppedBy ? { stoppedBy: final.stoppedBy } : {}) });
  removeRunSecrets(p);
}

// ---- stop, sweep, prune ------------------------------------------------------------------------------

/**
 * Stop a run (stop_agent, hoptell agents stop): the record goes to `stopping` with who asked; a
 * live supervisor gets SIGTERM after its identity check and stops the agent itself. Without one,
 * the agent is stopped here as the sweep does. Returns the record's state afterwards.
 */
export async function stopRun(home, run, { by = "owner", deps = {} } = {}) {
  const check = deps.check ?? sameIdentity;
  let before = null;
  const rec = await updateRun(home, run, (r) => {
    before = r.state;
    if (!LIVE.includes(r.state) && r.state !== "pending-confirmation") return false;
    if (r.state === "pending-confirmation") {
      r.state = "discarded";
      r.ended = new Date().toISOString();
    } else r.state = "stopping";
    r.stoppedBy = by;
  });
  if (!rec) return { refused: "no such run" };
  if (!LIVE.includes(before)) {
    if (before === "pending-confirmation") {
      removeRunSecrets(runPaths(home, run));
      audit(home, "discarded", { run, by });
    }
    return { run, state: rec.state };
  }
  const sig = rec.supervisor ? signalChecked(rec.supervisor, "SIGTERM", { check, kill: deps.kill }) : "mismatch";
  if (sig === "signalled") {
    // The supervisor records the end; wait briefly so the answer can name it.
    const until = Date.now() + (deps.waitMs ?? 2000);
    let cur = rec;
    while (Date.now() < until && LIVE.includes(cur.state)) {
      await sleep(100);
      cur = readRun(home, run) ?? cur;
    }
    return { run, state: cur.state };
  }
  // A supervisor that matches but refused the signal is not bypassed: the run stays `stopping`.
  if (sig === "failed") return { run, state: "stopping", problem: "the supervisor could not be signalled" };
  return { run, state: await endWithoutSupervisor(home, rec, { by, ...deps }) };
}

/**
 * A run whose supervisor is gone: its agent (or pane process) is stopped if it still matches its
 * stored identity, and so is every descendant the record keeps (`tree`) that still matches, even
 * when the agent itself is gone. The run then ends as its supervisor meant it to (`endAs`), else
 * `stopped` (`expired` past its lifetime), or `lost` when its agent no longer matched. Anything
 * that could not be ended keeps the run `stopping` for the next sweep.
 */
async function endWithoutSupervisor(home, rec, { by = "sweep", check = sameIdentity, kill = process.kill, graceMs = STOP_GRACE_MS, tmuxEnd = null, table } = {}) {
  const target = rec.mode === "tmux" ? rec.pane : rec.agent;
  const expired = rec.ends && Date.now() >= Date.parse(rec.ends);
  const grace = Math.min(graceMs, rec.graceMs ?? graceMs);
  const tree = processTree(target, { check, kill, known: rec.tree, ...(table ? { table } : {}) });
  let outcome = "lost";
  if (target && check(target)) {
    const end = rec.mode === "tmux" ? (tmuxEnd ?? (await tmuxEnder(rec))) : null;
    tree.poll();
    outcome = await stopProcess(target, { group: true, graceMs: grace, check, kill, tmuxEnd: end });
  }
  const left = await tree.end({ graceMs: grace });
  if (outcome === "failed" || left.failed.length) {
    // Something may still run: the record stays live (`stopping`) so the next sweep tries again.
    await updateRun(home, rec.run, (r) => {
      if (ENDED.includes(r.state)) return false;
      r.state = "stopping";
      r.stoppedBy ??= by;
      r.tree = left.failed;
      r.stopFailed = new Date().toISOString();
    });
    return "stopping";
  }
  let fields;
  if (rec.endAs && typeof rec.endAs.state === "string" && ENDED.includes(rec.endAs.state)) fields = { ...rec.endAs };
  else {
    // A run whose start failed (its pane's process could not be stopped then) ends failed.
    const state = outcome === "lost" ? "lost" : rec.error ? "failed" : expired ? "expired" : "stopped";
    fields = { state, stoppedBy: rec.stoppedBy ?? by, ...(state === "lost" ? { lostReason: target ? "its process no longer matches the recorded identity, or the identity cannot be read" : "no process was recorded" } : {}) };
  }
  const f = await finishRun(home, rec.run, { ...fields, tree: [] });
  if (!f.won) return f.rec?.state ?? fields.state;
  audit(home, "ended", { run: rec.run, state: fields.state, ...(fields.error ? { error: fields.error } : {}), ...(fields.treeUnrecorded ? { treeUnrecorded: fields.treeUnrecorded } : {}), stoppedBy: rec.stoppedBy ?? (rec.endAs ? null : by), ...(left.ended ? { leftEnded: left.ended } : {}) });
  removeRunSecrets(runPaths(home, rec.run));
  return fields.state;
}

/** The guarded tmux termination of a run's recorded pane (see lib/tmux.js guarded). */
async function tmuxEnder(rec) {
  if (!rec.pane?.pane || !rec.pane.sessionId) return null;
  const { endSession } = await import("./tmux.js");
  return () => {
    try {
      return endSession(rec.pane.pane, rec.pane.pid, rec.pane.sessionId);
    } catch {
      return false;
    }
  };
}

/**
 * The sweep (MCP server start, hoptell agents list, doctor): live runs whose supervisor is gone
 * are ended (their agent stopped only if it still matches), runs past their lifetime are stopped,
 * old pending confirmations are discarded, then old runs are pruned. Returns what changed.
 * `quick` (list_agents): nothing is signalled and nothing waited for; only runs whose supervisor
 * and agent are both gone are marked lost.
 */
export async function sweep(home, { now = Date.now(), deps = {}, quick = false } = {}) {
  const check = deps.check ?? sameIdentity;
  const changed = [];
  for (const rec of listRuns(home)) {
    if (rec.state === "pending-confirmation" && now - Date.parse(rec.created) > 3600_000) {
      let won = false;
      await updateRun(home, rec.run, (r) => {
        if (r.state !== "pending-confirmation") return false;
        r.state = "discarded";
        r.stoppedBy = "expiry";
        r.ended = new Date(now).toISOString();
        won = true;
      });
      // A start that won the lock first is left to the next pass.
      if (!won) continue;
      // Like a discard by the owner (agentspawn.js discardPending): the run's settings files go.
      removeRunSecrets(runPaths(home, rec.run));
      audit(home, "discarded", { run: rec.run, by: "expiry" });
      changed.push({ run: rec.run, state: "discarded" });
      continue;
    }
    if (!LIVE.includes(rec.state)) continue;
    const supervised = rec.supervisor ? check(rec.supervisor) : now - Date.parse(rec.created) < START_WAIT_MS;
    const past = rec.ends && now >= Date.parse(rec.ends) + 60_000; // the supervisor had its minute
    if (supervised && !past) continue;
    if (quick) {
      // list_agents: only what needs no signal and no wait. A run whose supervisor and agent are
      // both gone is marked lost; anything still running is left to the full sweep (MCP start,
      // hoptell agents list, doctor).
      const target = rec.mode === "tmux" ? rec.pane : rec.agent;
      if (supervised || (target && check(target)) || (Array.isArray(rec.tree) && rec.tree.some((id) => isIdentity(id) && check(id)))) continue;
    }
    if (supervised && rec.supervisor) {
      // A supervisor that did not enforce the lifetime: asked to stop, as stop_agent does, and
      // given its grace period to record the end itself. The agent is never stopped from here
      // while that supervisor still matches.
      await updateRun(home, rec.run, (r) => {
        if (!LIVE.includes(r.state)) return false;
        r.state = "stopping";
        r.stoppedBy ??= "sweep";
      });
      signalChecked(rec.supervisor, "SIGTERM", { check, kill: deps.kill });
      const until = Date.now() + (deps.supervisorWaitMs ?? Math.min(STOP_GRACE_MS, rec.graceMs ?? STOP_GRACE_MS) + 5000);
      let cur = readRun(home, rec.run);
      while (Date.now() < until && cur && LIVE.includes(cur.state) && check(rec.supervisor)) {
        await sleep(100);
        cur = readRun(home, rec.run);
      }
      if (!cur || !LIVE.includes(cur.state) || check(rec.supervisor)) {
        changed.push({ run: rec.run, state: cur?.state ?? "gone" });
        continue;
      }
      rec.stoppedBy ??= "sweep";
    } else if (supervised) continue; // starting, its supervisor not recorded yet
    const state = await endWithoutSupervisor(home, readRun(home, rec.run) ?? rec, { by: "sweep", ...deps });
    changed.push({ run: rec.run, state });
  }
  changed.push(...prune(home, { now }).map((run) => ({ run, state: "pruned" })));
  return changed;
}

/**
 * Remove ended runs beyond the kept ones (7 days or 100 runs, whichever is fewer). Runs created
 * in the last hour are always kept (the hourly rate counts them). Returns the removed run ids.
 */
export function prune(home, { now = Date.now(), keep = KEEP } = {}) {
  const ended = listRuns(home).filter((r) => ENDED.includes(r.state));
  const removed = [];
  ended.forEach((r, i) => {
    const age = now - Date.parse(r.created);
    if (age < 3600_000) return;
    if (i < keep.runs && age < keep.days * 86400_000) return;
    const p = runPaths(home, r.run);
    fs.rmSync(p.dir, { recursive: true, force: true });
    fs.rmSync(p.record, { force: true });
    removed.push(r.run);
  });
  return removed;
}
