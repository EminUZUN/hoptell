// Which agent process hosts us? Used to pick the delivery mode and to bind hook files to one
// Claude Code process. Processes are matched by pid, start time, user and boot; start
// times may have whole-second precision.
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const MAX_DEPTH = 6; // wrappers between us and the agent (sh -c, npx, env, ...)

// System tools (ps, sysctl) are run by their absolute path in the system folders, so that no PATH
// (a process started with an empty environment included) decides which program answers; only a
// tool found in none of them is looked up by name.
const TOOL_DIRS = ["/bin", "/usr/bin", "/usr/sbin", "/sbin"];
const SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const tools = new Map();
function systemTool(name) {
  if (!tools.has(name)) {
    const found = TOOL_DIRS.map((d) => `${d}/${name}`).find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
    tools.set(name, found ?? name);
  }
  return tools.get(name);
}

let bootId = null;
/** An identifier of the current boot ("" when it cannot be read). */
export function currentBoot() {
  if (bootId != null) return bootId;
  bootId = "";
  try {
    if (process.platform === "linux") bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin") bootId = (execFileSync(systemTool("sysctl"), ["-n", "kern.boottime"], { encoding: "utf8", env: { PATH: SYSTEM_PATH } }).match(/sec = (\d+)/) || [])[1] || "";
  } catch {
    // stays ""
  }
  return bootId;
}

/** {pid, ppid, uid, start, args} for `pid`, or null when it is not running or unreadable. */
export function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let line;
  try {
    line = execFileSync(systemTool("ps"), ["-o", "ppid=,uid=,stat=,lstart=,args=", "-p", String(pid)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH || SYSTEM_PATH, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  // lstart is five words, e.g. "Wed Oct  7 11:32:50 2026".
  const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/s);
  if (!m) return null;
  let start = m[4].replace(/\s+/g, " ");
  // A zombie (stat Z) has exited and only waits for its parent to reap it. Not a group leader that
  // called pthread_exit while other threads of it still run: Linux ps marks it multi-threaded
  // ("l"), and the /proc read below gives its thread count.
  let zombie = m[3].startsWith("Z") && !m[3].includes("l");
  if (process.platform === "linux") {
    // Clock ticks since boot: exact, unlike lstart's whole seconds; the state and thread count
    // from the same read.
    try {
      const f = statFields(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
      start = f[19] || start;
      zombie = exitedGroup(f);
    } catch {
      // keep lstart and ps's state
    }
  }
  return { pid, ppid: Number(m[1]), uid: Number(m[2]), start, args: m[5], zombie };
}

let bootMs;
/**
 * The wall-clock time (ms) of a `start` from processInfo, or null. On Linux `start` is clock
 * ticks since boot, converted with the boot time in /proc/stat (whole seconds) and USER_HZ (100
 * on every Linux architecture Node supports); elsewhere it is lstart, read in UTC.
 */
export function startedAtMs(start) {
  if (typeof start !== "string") return null;
  if (/^\d+$/.test(start)) {
    if (process.platform !== "linux") return null;
    if (bootMs === undefined) {
      bootMs = null;
      try {
        const m = fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m);
        if (m) bootMs = Number(m[1]) * 1000;
      } catch {
        // stays null
      }
    }
    return bootMs === null ? null : bootMs + Number(start) * 10;
  }
  const t = Date.parse(`${start} UTC`);
  return Number.isFinite(t) ? t : null;
}

/**
 * One read of the process table: Map pid -> {pid, ppid, uid, start, zombie}, or null when it
 * cannot be read. Each row's fields come from one read of that process, in the form processInfo
 * uses for `start` (macOS: one `ps -axo` listing with lstart in LC_ALL=C and TZ=UTC; Linux:
 * /proc/<pid>/stat, whose start is clock ticks since boot). A Linux process whose stat changed
 * while it was read (another start, a new parent) is listed as {pid, unknown: true}.
 */
export function processTable({ platform = process.platform, timeoutMs = undefined } = {}) {
  if (platform === "linux") return linuxTable();
  let out;
  try {
    out = execFileSync(systemTool("ps"), ["-axo", "pid=,ppid=,uid=,stat=,lstart="], { encoding: "utf8", env: { PATH: process.env.PATH || SYSTEM_PATH, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs });
  } catch {
    return null;
  }
  return parsePsTable(out);
}

/** The rows of `ps -axo pid=,ppid=,uid=,stat=,lstart=` output (see processTable). */
export function parsePsTable(out) {
  const table = new Map();
  for (const line of String(out).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*$/);
    if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), start: m[5].replace(/\s+/g, " "), zombie: m[4].startsWith("Z") });
  }
  return table.size ? table : null;
}

/** The fields of a /proc/<pid>/stat line after the command (the last ")"): [0] state, [1] ppid, [17] num_threads, [19] start. */
const statFields = (line) => line.slice(line.lastIndexOf(")") + 2).split(" ");
/**
 * Whether a stat line is of a thread group that has exited: state Z or X with one thread left. A
 * leader that called pthread_exit shows Z while its other threads still run (num_threads above 1).
 */
const exitedGroup = (f) => (f[0] === "Z" || f[0] === "X") && f[17] === "1";

function linuxStat(pid) {
  const f = statFields(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  return { state: f[0], ppid: Number(f[1]), start: f[19], exited: exitedGroup(f) };
}

function linuxTable() {
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const table = new Map();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    try {
      // The uid is read between two reads of stat: the same start and parent in both make the
      // three one process's fields.
      const a = linuxStat(pid);
      const uid = fs.statSync(`/proc/${pid}`).uid;
      const b = linuxStat(pid);
      if (!/^\d+$/.test(a.start) || a.start !== b.start || a.ppid !== b.ppid) table.set(pid, { pid, unknown: true });
      else table.set(pid, { pid, ppid: a.ppid, uid, start: a.start, zombie: a.exited });
    } catch (e) {
      // Gone while the table was read; any other read error leaves the row unknown (never absent).
      if (e?.code !== "ENOENT" && e?.code !== "ESRCH") table.set(pid, { pid, unknown: true });
    }
  }
  return table.size ? table : null;
}

/**
 * The working folders of `uid`'s processes: [{pid, cwd, command}], or null when they cannot all be
 * read (no lsof, an error, output that does not parse, a live process whose folder is unreadable).
 * Linux reads /proc/<pid>/cwd; macOS runs `lsof -a -d cwd -u <uid> -Fpcn`. processCwdsScan gives
 * the reason too.
 */
export function processCwds(uid, options = {}) {
  return processCwdsScan(uid, options).rows;
}

/**
 * processCwds with the reason when it cannot answer: {rows, unreadable?} or {rows: null, problem}.
 * On Linux, `unreadable` lists the live processes ({pid, command}) whose cwd refuses even their
 * own user (EACCES or EPERM: non-dumpable ones); every other failure to read one is unknown.
 *
 * Only a complete answer is used: lsof exiting 0 with output that parses. A nonzero exit, a
 * signal, a timeout or a spawn error is unknown, with lsof's own message in the reason: a scan
 * that failed part-way cannot show which processes it missed (one started during the scan, for
 * one). A row without a folder is dropped only for a process that is positively gone (kill 0
 * gives ESRCH); a live one stays unknown. lsof lists no zombies. `timeoutMs`: the time lsof may
 * take (30 s otherwise); on Linux, a deadline checked before each process and each retry pause
 * (a read in progress is not cut short). `lsof`, `exists`, `proc`, `pause` (a synchronous sleep,
 * ms), `clock` (monotonic ms): for tests.
 */
export function processCwdsScan(uid, { platform = process.platform, proc = "/proc", exists = pidExists, lsof = "/usr/sbin/lsof", pause = pauseSync, timeoutMs = undefined, clock = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(uid) || uid < 0) return { rows: null, problem: "no user id" };
  if (platform === "linux") {
    const r = linuxCwds(uid, proc, exists, pause, timeoutMs === undefined ? Infinity : clock() + timeoutMs, clock);
    return r.problem ? { rows: null, problem: r.problem } : r;
  }
  const r = spawnSync(lsof, ["-a", "-d", "cwd", "-u", String(uid), "-Fpcn"], { cwd: "/", encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs ?? 30_000 });
  const why = () => `lsof ${r.error ? `failed (${r.error.code ?? r.error.message})` : r.signal ? `was stopped by ${r.signal}` : `exited ${r.status}`}${String(r.stderr ?? "").trim() ? `: ${String(r.stderr).trim().split("\n")[0].slice(0, 200)}` : ""}`;
  if (r.error || r.signal || r.status !== 0) return { rows: null, problem: why() };
  const rows = parseLsofRows(r.stdout);
  if (!rows) return { rows: null, problem: "lsof's output did not parse" };
  const out = [];
  for (const row of rows) {
    if (row.cwd?.startsWith("/")) out.push(row);
    else if (exists(row.pid) !== false) return { rows: null, problem: `lsof did not give the folder of process ${row.pid}, which still runs` };
  }
  if (!out.length) return { rows: null, problem: "lsof listed no process" };
  return { rows: out };
}

/** The rows of `lsof -Fpcn` output for the cwd descriptor, or null when it does not parse. */
export function parseLsofCwds(out) {
  const rows = parseLsofRows(out);
  return rows?.length && rows.every((r) => r.cwd?.startsWith("/")) ? rows : null;
}

/** The rows of `lsof -Fpcn` output, a row's cwd null when lsof gave none; null when it does not parse. */
function parseLsofRows(out) {
  const rows = [];
  let cur = null;
  for (const line of String(out).split("\n")) {
    if (!line) continue;
    const [tag, value] = [line[0], line.slice(1)];
    if (tag === "p") {
      if (!/^\d+$/.test(value)) return null;
      cur = { pid: Number(value), cwd: null, command: "" };
      rows.push(cur);
    } else if (!cur) return null;
    else if (tag === "c") cur.command = value;
    else if (tag === "n") cur.cwd = value;
    else if (tag !== "f") return null;
  }
  return rows;
}

// A process caught while it exits is read again after each of these pauses (ms, about 750 in all);
// at most RETRY_MAX of them per scan, which then stays within RETRY_MAX * 750 ms.
const RETRY_MS = [50, 100, 150, 200, 250];
const RETRY_MAX = 8;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
const pauseSync = (ms) => Atomics.wait(PAUSE, 0, 0, ms);

function linuxCwds(uid, proc, exists, pause = pauseSync, deadline = Infinity, clock = () => performance.now()) {
  let names;
  try {
    names = fs.readdirSync(proc);
  } catch (e) {
    return { problem: `${proc} could not be listed (${e?.code ?? e?.message})` };
  }
  const rows = [];
  const unreadable = [];
  let retried = 0;
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    if (clock() >= deadline) return { problem: `the time for the scan ran out before ${proc}/${n} was read` };
    let owner;
    try {
      owner = fs.statSync(`${proc}/${n}`).uid;
    } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ESRCH") continue; // exited after the listing
      return { problem: `${who(proc, n)}: its /proc entry could not be checked (${e?.code ?? e?.message})` };
    }
    if (owner !== uid) continue;
    let r = inspectCwd(proc, n, exists, owner);
    if (r.transient) {
      // A process caught while it exits: read again a few times, briefly, until it is gone or
      // reads plainly. One that stays so (a pthread_exit leader whose thread keeps running) is
      // unknown, and so is a scan that meets more of them than it can wait for.
      if (++retried > RETRY_MAX) return { problem: `more than ${RETRY_MAX} of your processes were exiting while hoptell read them (the last: ${r.transient})` };
      for (const ms of RETRY_MS) {
        if (clock() + ms > deadline) return { problem: `the time for the scan ran out while ${r.transient}` };
        pause(ms);
        if (gone(proc, n, exists)) {
          r = { skip: true };
          break;
        }
        r = inspectCwd(proc, n, exists, owner);
        if (!r.transient) break;
      }
      if (r.transient) return { problem: r.transient };
    }
    if (r.problem) return { problem: r.problem };
    if (r.unreadable) unreadable.push(r.unreadable);
    if (r.row) rows.push(r.row);
  }
  return rows.length ? { rows, unreadable } : { problem: `no process of yours was found in ${proc}` };
}

const who = (proc, n) => `process ${n} (${commOf(proc, n) || "unknown command"})`;

/**
 * One reading of process `n`'s working folder: {row}, {skip} (gone, or exited), {unreadable}
 * (a live one that refuses it to its own user), {transient} (a shape a process shows while it
 * exits: read again) or {problem} (unknown). Each with the reason it was not a row. `uid`: the owner of its /proc entry.
 */
function inspectCwd(proc, n, exists, uid) {
  let cwd;
  try {
    cwd = fs.readlinkSync(`${proc}/${n}/cwd`);
  } catch (e) {
    // Unreadable is not gone: a live process whose main thread exited has no readable cwd
    // (proc_pid_cwd(5)). Only a process positively gone is skipped: kill(pid, 0) gives ESRCH,
    // or, when that cannot be told, its /proc entry is ENOENT. Any other answer is unknown.
    const cwdFailed = `readlink cwd gave ${e?.code ?? e?.message}`;
    const alive = exists(Number(n));
    if (alive === false) return { skip: true };
    // A zombie (state Z, or X while it goes) has exited: it has no cwd and writes nothing, though
    // kill(pid, 0) still succeeds until it is reaped (lsof leaves zombies out too). A leader that
    // called pthread_exit also shows Z while its other threads run (and write): skipped only with
    // one thread left and every task of it exited (exitedState).
    const st = exitedState(proc, n);
    if (st.skip) return st;
    if (st.why) return { [st.retry ? "transient" : "problem"]: `${who(proc, n)}: ${cwdFailed}; ${st.why}` };
    // A live process that refuses its cwd even to its own user (EACCES, EPERM: a non-dumpable
    // one, such as systemd --user, (sd-pam) or sshd's session process) is listed apart, as
    // unreadable: its folder is not known, and the caller decides what that means, by the start
    // read here from this very process (null when its stat gave none), never by another reading.
    if (alive === true && (e?.code === "EACCES" || e?.code === "EPERM")) return { unreadable: { pid: Number(n), uid, start: /^\d+$/.test(st.start ?? "") ? st.start : null, command: commOf(proc, n) } };
    if (alive !== true && gone(proc, n, () => null)) return { skip: true };
    // A cwd already released by a process that still shows running, sleeping or in disk wait is
    // one on its way out.
    const why = `${who(proc, n)}: ${cwdFailed} while it ${alive === true ? `runs (state ${st.state})` : "may still run"}`;
    return alive === true && e?.code === "ENOENT" && ["D", "R", "S"].includes(st.state) ? { transient: why } : { problem: why };
  }
  return { row: { pid: Number(n), cwd, command: commOf(proc, n) } };
}

/** Is process `n` positively gone: kill(pid, 0) gives ESRCH, or its /proc entry is ENOENT? */
function gone(proc, n, exists) {
  if (exists(Number(n)) === false) return true;
  try {
    fs.statSync(`${proc}/${n}`);
    return false;
  } catch (e) {
    return e?.code === "ENOENT";
  }
}

/**
 * Whether process `n` (its cwd unreadable) has exited, from its stat and its tasks: {skip} (gone,
 * or a group that exited: state Z or X, one thread, every task Z or X; or state Z with no task
 * listed and at most one thread), {state, start} (not a
 * zombie: the caller decides), {why} (unknown) or {why, retry} (states a group shows while it
 * exits: a task still running while the leader is Z, as when a program's main thread returns
 * before its other threads end, a task's stat gone, num_threads above 1 while every task listed
 * has exited, the task listing gone).
 */
function exitedState(proc, n) {
  let f;
  try {
    f = statFields(fs.readFileSync(`${proc}/${n}/stat`, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ESRCH") return { skip: true };
    return { why: `its stat could not be read (${e?.code ?? e?.message})` };
  }
  if (f[0] !== "Z" && f[0] !== "X") return { state: f[0], start: f[19] };
  const head = `state ${f[0]}`;
  let tids;
  try {
    tids = fs.readdirSync(`${proc}/${n}/task`).filter((x) => /^\d+$/.test(x));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ESRCH") return { why: `${head}, and its task listing is gone (${e.code})`, retry: true };
    return { why: `${head}, and its task listing could not be read (${e?.code ?? e?.message})` };
  }
  if (!tids.length) {
    // A zombie caught while it is reaped: its task list is already empty. The list alone proves
    // nothing (proc_pid_task(5): it can be unavailable once the main thread exits), so the
    // numeric thread count decides: state Z with at most one thread counted has exited. A count
    // above one (a thread may still run) is read again and stays unknown; so does state X.
    if (f[0] !== "Z" || !/^\d+$/.test(f[17] ?? "")) return { why: `${head}, with no task listed` };
    return Number(f[17]) <= 1 ? { skip: true } : { why: `${head}, with no task listed and num_threads ${f[17]}`, retry: true };
  }
  let missing = null;
  for (const tid of tids) {
    try {
      const state = statFields(fs.readFileSync(`${proc}/${n}/task/${tid}/stat`, "utf8"))[0];
      if (state !== "Z" && state !== "X") return { why: `${head}, while its task ${tid} is in state ${state}`, retry: true };
    } catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ESRCH") return { why: `${head}, and the stat of its task ${tid} could not be read (${e?.code ?? e?.message})` };
      missing ??= `${head}, and the stat of its task ${tid} is gone (${e.code})`;
    }
  }
  if (missing) return { why: missing, retry: true };
  if (!/^\d+$/.test(f[17] ?? "")) return { why: `${head}, with num_threads unreadable` };
  if (f[17] !== "1") return { why: `${head}, with num_threads ${f[17]} while every task listed has exited`, retry: true };
  return { skip: true };
}

/** A process's command name from /proc (display only), or "". */
function commOf(proc, n) {
  try {
    return fs.readFileSync(`${proc}/${n}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The identities ({pid, start, uid, boot}) of `root`'s descendants in one process table: each is
 * reached through parent links of that same table, so its pid, parent and start were read
 * together. Fail closed: [] unless the root itself is in the table with its recorded start and
 * uid (on the recorded boot). Only processes of the root's user, never zombies or unknown rows.
 */
export function descendantIdentities(root, { table = processTable(), boot = currentBoot() } = {}) {
  if (!table || !root || !boot || root.boot !== boot) return [];
  const r = table.get(root.pid);
  if (!r || r.unknown || r.zombie || r.start !== root.start || r.uid !== root.uid) return [];
  const kids = new Map();
  for (const row of table.values()) if (!row.unknown) kids.set(row.ppid, [...(kids.get(row.ppid) ?? []), row]);
  const out = [];
  const seen = new Set([root.pid]);
  for (const queue = [...(kids.get(root.pid) ?? [])]; queue.length; ) {
    const c = queue.shift();
    if (seen.has(c.pid)) continue;
    seen.add(c.pid);
    if (!c.zombie && c.uid === root.uid) out.push({ pid: c.pid, start: c.start, uid: c.uid, boot });
    queue.push(...(kids.get(c.pid) ?? []));
  }
  return out;
}

/** Is a ps command line a Claude Code process? Native binary, versioned binary or npm package. */
export function isClaude(args) {
  const words = String(args).split(/\s+/);
  return (
    /(^|\/)claude$/.test(words[0]) ||
    /\/claude\/versions\/[^/]+$/.test(words[0]) ||
    (/(^|\/)node$/.test(words[0]) && /claude-code/.test(words[1] || ""))
  );
}

const isCodex = (args) => /(^|\/)codex$/.test(String(args).split(/\s+/)[0]);

/**
 * The nearest Claude Code process above `pid` (normally our parent), or null when another
 * agent (Codex) or nothing is found first. Includes pid 1, where Claude runs in a container.
 */
export function findClaudeHost(pid = process.ppid) {
  for (let i = 0; i < MAX_DEPTH && pid >= 1; i++) {
    const info = processInfo(pid);
    if (!info) return null;
    if (isClaude(info.args)) return { pid, uid: info.uid, start: info.start, boot: currentBoot(), args: info.args };
    if (isCodex(info.args) || pid === 1) return null;
    pid = info.ppid;
  }
  return null;
}

/** Was this Claude Code process started with the hoptell channel enabled? */
export function channelEnabled(host) {
  const words = String(host?.args || "").split(/\s+/);
  return (
    words.some((w) => /^--(dangerously-load-development-)?channels$/.test(w)) &&
    words.some((w) => /^(server:hoptell|plugin:hoptell@\S+)$/.test(w))
  );
}

/** A file-name-safe key derived from pid, start time, user and boot. */
export const hostKey = (host) => crypto.createHash("sha256").update(`${host.uid}|${host.boot}|${host.pid}|${host.start}`).digest("hex").slice(0, 32);

/** Is `who` ({pid, start}) still the same running process? */
export function sameProcess(who) {
  if (!who || !Number.isSafeInteger(who.pid)) return false;
  const info = processInfo(who.pid);
  return Boolean(info && info.start === who.start && info.uid === process.getuid());
}

/**
 * The identity a kill is checked against (design 7.1): {pid, start, uid, boot}, taken right after
 * the process started, or null when it cannot be read.
 */
export function processIdentity(pid, { info = processInfo, boot = currentBoot } = {}) {
  const i = info(pid);
  return i ? { pid, start: i.start, uid: i.uid, boot: boot() } : null;
}

/**
 * What can be observed about `stored` ({pid, start, uid, boot}): "same" (that process still runs),
 * "different" (positively observed gone: another boot, the pid absent, a zombie, or another start
 * or uid actually read) or "unknown" (the boot or the process could not be read, or the stored
 * identity is malformed). Only "different" may count as an exit; only "same" may be signalled.
 */
export function identityState(stored, { info = processInfo, boot = currentBoot, exists = pidExists } = {}) {
  if (!stored || !Number.isSafeInteger(stored.pid) || stored.pid < 2) return "unknown";
  if (typeof stored.start !== "string" || !stored.start || !Number.isSafeInteger(stored.uid) || typeof stored.boot !== "string") return "unknown";
  const b = boot();
  if (!b) return "unknown";
  if (b !== stored.boot) return "different";
  const i = info(stored.pid);
  if (!i) return exists(stored.pid) === false ? "different" : "unknown";
  // An exited process its parent has not reaped yet (a zombie) is no longer that running process.
  if (i.zombie) return "different";
  // A start read in another form than the stored one (Linux /proc ticks vs ps lstart) is not a
  // comparison.
  if (/^\d+$/.test(i.start) !== /^\d+$/.test(stored.start)) return "unknown";
  return i.start === stored.start && i.uid === stored.uid ? "same" : "different";
}

/** Does `pid` exist? false only on ESRCH (positively absent); null when it cannot be told. */
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e?.code === "ESRCH") return false;
    return e?.code === "EPERM" ? true : null;
  }
}

/**
 * Is `stored` still the same running process (identityState "same")? Anything unreadable or
 * different is false (fail closed). Unlike sameProcess, this compares the stored uid and the
 * boot; it is the check before any signal.
 */
export function sameIdentity(stored, deps = {}) {
  return identityState(stored, deps) === "same";
}
