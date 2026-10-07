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
    line = execFileSync("ps", ["-o", "ppid=,uid=,lstart=,args=", "-p", String(pid)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  // lstart is five words, e.g. "Wed Oct  7 11:32:50 2026".
  const m = line.match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/s);
  if (!m) return null;
  let start = m[3].replace(/\s+/g, " ");
  if (process.platform === "linux") {
    // Clock ticks since boot: exact, unlike lstart's whole seconds.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || start;
    } catch {
      // keep lstart
    }
  }
  return { pid, ppid: Number(m[1]), uid: Number(m[2]), start, args: m[4] };
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
