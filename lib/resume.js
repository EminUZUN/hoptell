// Resuming a team member's conversation on `hoptell team restart` (design 10, Part R).
//
// A member's state keeps a `conversation` record: the CLI's own id of the conversation, the folder
// it belongs to, how hoptell learned it, when the thread was created and which launches it spans.
// Before a restart hoptell decides from evidence it can read whether that conversation is the one
// to continue; when anything is unclear the member starts fresh, with a notice.
//
// - Claude Code: hoptell picks the first id (`--session-id`). The conversation can change inside
//   the process (/clear, /compact, /resume, /branch), so at restart the set of SessionStart events
//   of the member's last Claude Code process decides (`claudeConversation`), and a session file in
//   the member's project folder that those events do not explain makes it not resumable.
// - Codex: the member's hoptell MCP server records the `threadId` Codex puts in the `_meta` of its
//   read_task call (<home>/sessions/<name>.thread.json); the rollout file of that thread under
//   $CODEX_HOME/sessions confirms the id, the folder and the creation time (`codexConversation`).
// - agy: never resumed.
//
// The CLIs' files read here are internal formats: a file that does not parse means "not
// resumable", never a guess.
import fs from "node:fs";
import path from "node:path";
import { checkName, ensurePrivateDir } from "./config.js";
import { readPrivateFile } from "./agents.js";
import { writeRecord } from "./locks.js";

export const RESUME_MODES = ["auto", "never"];
export const RESUMABLE_CLIS = ["codex", "claude"];
/** The team file's `resume` default: implementers continue, reviewers and testers start fresh. */
export const resumeDefault = (role) => (role === "implementer" ? "auto" : "never");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isConversationId = (x) => typeof x === "string" && UUID_RE.test(x);

const SOURCES = ["assigned", "mcp", "rollout", "hook"];
const LAUNCHED_AS = ["startup", "resume"];
const isTime = (x) => typeof x === "string" && x.length <= 40 && !Number.isNaN(Date.parse(x));
export const CONVERSATION_KEYS = ["cli", "id", "cwd", "source", "created", "firstLaunch", "lastLaunch", "launchedAs", "resumable", "why"];
// The evidence a resume compares (design 10, R.3 and R.4): the CLI version of the conversation's
// last launch and the digest of the role template it started with (Claude Code keeps the system
// prompt of its first launch). Absent in a record from before they were kept: unknown.
const EVIDENCE_KEYS = ["cliVersion", "templateDigest"];
export const isVersion = (x) => x === null || (typeof x === "string" && x.length >= 1 && x.length <= 80);
export const isDigest = (x) => x === null || (typeof x === "string" && /^[0-9a-f]{64}$/.test(x));

/** The shape of a member's `conversation` record (lib/teams.js checks every field of a state). */
export function isConversation(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  if (!CONVERSATION_KEYS.every((k) => Object.hasOwn(x, k)) || !keys.every((k) => CONVERSATION_KEYS.includes(k) || EVIDENCE_KEYS.includes(k))) return false;
  if (Object.hasOwn(x, "cliVersion") && !isVersion(x.cliVersion)) return false;
  if (Object.hasOwn(x, "templateDigest") && !isDigest(x.templateDigest)) return false;
  return (
    RESUMABLE_CLIS.includes(x.cli) &&
    isConversationId(x.id) &&
    typeof x.cwd === "string" &&
    path.isAbsolute(x.cwd) &&
    x.cwd.length <= 4096 &&
    SOURCES.includes(x.source) &&
    isTime(x.created) &&
    isTime(x.firstLaunch) &&
    isTime(x.lastLaunch) &&
    LAUNCHED_AS.includes(x.launchedAs) &&
    typeof x.resumable === "boolean" &&
    (x.why === null || (typeof x.why === "string" && x.why.length <= 300))
  );
}

/** The record of a conversation a launch starts or continues; `evidence`: {cliVersion, templateDigest} of that launch, when known. */
export function conversationRecord({ cli, id, cwd, source, created, firstLaunch, lastLaunch, launchedAs }, evidence = null) {
  return { cli, id, cwd, source, created, firstLaunch, lastLaunch, launchedAs, resumable: true, why: null, ...(evidence ? { cliVersion: evidence.cliVersion, templateDigest: evidence.templateDigest } : {}) };
}

/**
 * The warnings of resuming conversation `rec` with a launch whose evidence is `now`
 * ({cliVersion, templateDigest}): a CLI version that changed since the conversation's last launch,
 * and for Claude Code a role template that changed since it started (it keeps the system prompt
 * of its first launch, so only --fresh applies the new one). Evidence not recorded is unknown.
 */
export function resumeWarnings(rec, now, member) {
  const out = [];
  const was = Object.hasOwn(rec, "cliVersion") ? rec.cliVersion : undefined;
  if (was === undefined || was === null || now.cliVersion === null) out.push(`${member}: hoptell cannot tell whether ${rec.cli}'s version changed since the conversation's last launch; resuming it`);
  else if (was !== now.cliVersion) out.push(`${member}: ${rec.cli} changed from ${was} to ${now.cliVersion} since the conversation's last launch; resuming it`);
  if (rec.cli === "claude") {
    const t = Object.hasOwn(rec, "templateDigest") ? rec.templateDigest : undefined;
    const fresh = `hoptell team restart ${member} --fresh applies the current one`;
    if (t === undefined || t === null) out.push(`${member}: hoptell cannot tell whether its role template changed since the conversation started; Claude Code keeps the system prompt it started with (${fresh})`);
    else if (t !== now.templateDigest) out.push(`${member}: its role template changed since the conversation started; Claude Code keeps the system prompt it started with, so the change does not apply (${fresh})`);
  }
  return out;
}

const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// ---- Claude Code ---------------------------------------------------------------------------------

/**
 * The conversation of a member's last Claude Code process, from the set of its SessionStart events
 * (design-10-stable-names, 5.2: `{session_id, source}` lines of wake/<host>.events, read as a set).
 * `L`: the id the launch started with; `launchedAs`: "startup" (a fresh start with --session-id)
 * or "resume". Returns {id} or {why}.
 *   1. E = {L with its source}: L.
 *   2. E = {L with its source} plus exactly one other id X with source clear or compact (or L
 *      itself compacted): X.
 *   3. Anything else: not resumable.
 */
export function claudeConversation(events, L, launchedAs) {
  if (!Array.isArray(events)) return { why: "no session hook data" };
  const set = new Map();
  for (const e of events) {
    if (!e || typeof e !== "object" || !isConversationId(e.session_id) || typeof e.source !== "string") return { why: "the session event log has an entry hoptell cannot read" };
    set.set(`${e.session_id} ${e.source}`, e);
  }
  const all = [...set.values()];
  if (!all.length) return { why: "no session hook data" };
  if (!all.some((e) => e.session_id === L && e.source === launchedAs)) return { why: "the session event log does not show this launch" };
  const rest = all.filter((e) => !(e.session_id === L && e.source === launchedAs));
  if (!rest.length) return { id: L };
  if (rest.every((e) => ["clear", "compact"].includes(e.source))) {
    const ids = new Set(rest.map((e) => e.session_id));
    if (ids.size === 1) return { id: [...ids][0] };
    return { why: "the conversation changed more than once in the session (the order cannot be told)" };
  }
  const other = rest.find((e) => !["clear", "compact"].includes(e.source));
  return { why: `the conversation changed in the session (${String(other.source).slice(0, 40)})` };
}

/** Claude Code's folder of a working folder's sessions: every character but letters and digits becomes "-". */
export const claudeProjectDir = (homedir, cwd) => path.join(homedir, ".claude", "projects", realOr(cwd).replace(/[^A-Za-z0-9]/g, "-"));

/**
 * The cross-check of the event set: in the member's project folder, a session file of an id not
 * in `ids` that changed during the launch ([fromMs, toMs]) is unexplained. Only `<uuid>.jsonl`
 * files and `<uuid>` folders are expected there. Returns null (nothing unexplained) or a reason.
 */
export function claudeUnexplained(dir, ids, fromMs, toMs, chosen) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e.code === "ENOENT" ? "Claude Code's session folder of the member is missing" : `Claude Code's session folder of the member could not be read (${e.code})`;
  }
  let seen = false;
  for (const d of entries) {
    if (d.isDirectory() && UUID_RE.test(d.name)) continue;
    const m = /^([0-9a-f-]{36})\.jsonl$/.exec(d.name);
    if (!d.isFile() || !m || !UUID_RE.test(m[1])) return `an unexpected entry ${d.name.slice(0, 60)} is in Claude Code's session folder of the member`;
    if (m[1] === chosen) seen = true;
    if (ids.has(m[1])) continue;
    let st;
    try {
      st = fs.statSync(path.join(dir, d.name));
    } catch {
      return `the session file ${d.name} could not be read`;
    }
    if (st.mtimeMs >= fromMs && st.mtimeMs <= toMs) return `another conversation (${m[1].slice(0, 8)}) changed during the launch`;
  }
  return seen ? null : "the conversation's session file is missing";
}

// ---- Codex ---------------------------------------------------------------------------------------

/** Where a member's hoptell MCP server records the Codex thread id of its read_task call. */
export const threadFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.thread.json`);

/**
 * Record the thread a Codex member's read_task came from (lib/mcp.js): `_meta.threadId` of the
 * call, which Codex sets and the model cannot. Best effort: never fails the call.
 */
export function recordThread(home, name, meta, { digest = null, now = () => new Date() } = {}) {
  const id = meta && typeof meta === "object" ? meta.threadId : null;
  if (!isConversationId(id)) return false;
  try {
    ensurePrivateDir(path.join(home, "sessions"));
    writeRecord(threadFileOf(home, name), { version: 1, threadId: id, digest, at: now().toISOString() });
    return true;
  } catch {
    return false;
  }
}

/** The thread id recorded for `name` at or after `sinceMs`, or null. */
export function readThread(home, name, sinceMs) {
  const r = readPrivateFile(threadFileOf(home, name), 4096);
  if (r.problem) return null;
  try {
    const t = JSON.parse(r.bytes.toString("utf8"));
    if (t?.version !== 1 || !isConversationId(t.threadId) || !isTime(t.at) || Date.parse(t.at) < sinceMs) return null;
    return t.threadId;
  } catch {
    return null;
  }
}

const FIRST_LINE_MAX = 8 * 1024 * 1024;
const DAYS_MAX = 400;

/** The first line of a file, at most FIRST_LINE_MAX bytes, or null. */
function firstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) return null;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)));
      total += nl < 0 ? n : nl;
      if (nl >= 0) return Buffer.concat(chunks).toString("utf8");
      if (total > FIRST_LINE_MAX) return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The `session_meta` of a rollout file: {id, cwd, timestamp} or null. */
export function rolloutMeta(file) {
  const line = firstLine(file);
  if (!line) return null;
  try {
    const d = JSON.parse(line);
    const p = d?.payload;
    if (d?.type !== "session_meta" || !p || !isConversationId(p.id) || typeof p.cwd !== "string" || !isTime(p.timestamp)) return null;
    return { id: p.id, cwd: p.cwd, timestamp: p.timestamp };
  } catch {
    return null;
  }
}

/** The day folders $CODEX_HOME/sessions/YYYY/MM/DD from a day before `sinceMs` to a day after now. */
function dayDirs(codexHome, sinceMs, nowMs) {
  const out = [];
  const day = 86_400_000;
  const from = Math.max(sinceMs - day, nowMs - DAYS_MAX * day);
  for (let t = from; t <= nowMs + day; t += day) {
    const d = new Date(t);
    const parts = [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")];
    const dir = path.join(codexHome, "sessions", ...parts);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/** Rollout files of the day folders, optionally only those of thread `id`. */
function rollouts(codexHome, sinceMs, nowMs, id = null) {
  const files = [];
  for (const dir of dayDirs(codexHome, sinceMs, nowMs)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) if (n.startsWith("rollout-") && n.endsWith(id ? `-${id}.jsonl` : ".jsonl")) files.push(path.join(dir, n));
  }
  return files;
}

const sameFolder = (a, b) => a === b || realOr(a) === realOr(b);

/**
 * The Codex conversation to resume for a member. `rec`: its conversation record (or null);
 * `launchMs`: the start of the launch that just ended; `cwd`: the member's folder; `thread`: the
 * id its MCP server recorded during that launch (or null); `scan`: whether the rollout files of
 * the folder may be searched without a thread id (implementers only: reviewers share a folder).
 * Returns {rec} (a record to resume) or {why}.
 *   - The recorded thread again: its rollout's session_meta must have the recorded id and folder
 *     and a timestamp equal to the recorded `created` (a resumed thread keeps its first
 *     session_meta, which precedes the later launches).
 *   - A new thread (first discovery): its session_meta must name the member's folder and start at
 *     or after the launch.
 */
export function codexConversation({ codexHome, rec, launchMs, cwd, thread, scan, nowMs = Date.now(), evidence = null }) {
  if (rec && (thread === null || thread === rec.id)) {
    const files = rollouts(codexHome, Date.parse(rec.created), nowMs, rec.id);
    if (files.length !== 1) return { why: files.length ? "the conversation has several rollout files" : "the conversation was not found" };
    const meta = rolloutMeta(files[0]);
    if (!meta || meta.id !== rec.id) return { why: "the conversation's rollout file could not be read" };
    if (!sameFolder(meta.cwd, cwd) || !sameFolder(rec.cwd, cwd)) return { why: `the conversation belongs to ${meta.cwd}` };
    if (Date.parse(meta.timestamp) !== Date.parse(rec.created)) return { why: "the conversation's rollout file is not the one recorded" };
    return { rec };
  }
  // First discovery, from the MCP server's thread id or (implementers) the folder's rollouts.
  let candidates;
  if (thread) candidates = rollouts(codexHome, launchMs, nowMs, thread);
  else if (scan) candidates = rollouts(codexHome, launchMs, nowMs);
  else return { why: "no conversation was recorded for this launch" };
  const found = candidates.map((f) => rolloutMeta(f)).filter((m) => m && (!thread || m.id === thread) && sameFolder(m.cwd, cwd) && Date.parse(m.timestamp) >= launchMs);
  const ids = new Set(found.map((m) => m.id));
  if (ids.size !== 1) return { why: ids.size ? "several conversations started in the member's folder during the launch" : "no conversation of this launch was found" };
  const meta = found[0];
  if (found.length > 1) return { why: "the conversation has several rollout files" };
  const at = new Date(launchMs).toISOString();
  return { rec: conversationRecord({ cli: "codex", id: meta.id, cwd: realOr(cwd), source: thread ? "mcp" : "rollout", created: new Date(Date.parse(meta.timestamp)).toISOString(), firstLaunch: at, lastLaunch: at, launchedAs: "startup" }, evidence) };
}
