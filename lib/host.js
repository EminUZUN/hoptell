// Which agent process hosts us? Used to pick the delivery mode and to bind hook files to one
// Claude Code process. Processes are matched by pid, start time, user and boot; start
// times may have whole-second precision.
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const MAX_DEPTH = 6; // wrappers between us and the agent (sh -c, npx, env, ...)

let bootId = null;
/** An identifier of the current boot ("" when it cannot be read). */
export function currentBoot() {
  if (bootId != null) return bootId;
  bootId = "";
  try {
    if (process.platform === "linux") bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin") bootId = (execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).match(/sec = (\d+)/) || [])[1] || "";
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
    line = execFileSync("ps", ["-o", "ppid=,uid=,stat=,lstart=,args=", "-p", String(pid)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  // lstart is five words, e.g. "Wed Oct  7 11:32:50 2026".
  const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/s);
  if (!m) return null;
  let start = m[4].replace(/\s+/g, " ");
  if (process.platform === "linux") {
    // Clock ticks since boot: exact, unlike lstart's whole seconds.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || start;
    } catch {
      // keep lstart
    }
  }
  // A zombie (stat Z) has exited and only waits for its parent to reap it.
  return { pid, ppid: Number(m[1]), uid: Number(m[2]), start, args: m[5], zombie: m[3].startsWith("Z") };
}

/**
 * One read of the process table: Map pid -> {pid, ppid, uid, start, zombie}, or null when it
 * cannot be read. Each row's fields come from one read of that process, in the form processInfo
 * uses for `start` (macOS: one `ps -axo` listing with lstart in LC_ALL=C and TZ=UTC; Linux:
 * /proc/<pid>/stat, whose start is clock ticks since boot). A Linux process whose stat changed
 * while it was read (another start, a new parent) is listed as {pid, unknown: true}.
 */
export function processTable({ platform = process.platform } = {}) {
  if (platform === "linux") return linuxTable();
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart="], { encoding: "utf8", env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
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

function linuxStat(pid) {
  const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  return { state: f[0], ppid: Number(f[1]), start: f[19] };
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
      else table.set(pid, { pid, ppid: a.ppid, uid, start: a.start, zombie: a.state === "Z" });
    } catch (e) {
      // Gone while the table was read; any other read error leaves the row unknown (never absent).
      if (e?.code !== "ENOENT" && e?.code !== "ESRCH") table.set(pid, { pid, unknown: true });
    }
  }
  return table.size ? table : null;
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
