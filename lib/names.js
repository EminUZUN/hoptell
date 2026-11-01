// Stable session names, the client side (design 10, section 5): which name a Claude Code session
// asks for again after a restart, and the local records that remember it.
//
// Files in <home>/names/ (0700), looked up per relay profile P (lib/profiles.js profileKey):
//   N-<hash(P, name)>.json        the name record: {v, profile, realm, member, name, ticket,
//                                 aliases, used}. One per name, the only place a ticket is kept,
//                                 with the realm and member (id, or null for the shared token)
//                                 the relay named when it gave the ticket. A ticket changes only
//                                 inside it, under its lock, and only if it still holds the
//                                 ticket read. `aliases`: the file ids of the session entries that
//                                 point to it (at most ALIASES_MAX; past that no more entries).
//   S-<hash(P, session id)>.json  a session entry: {v, profile, realm, member, name, used}. It
//                                 points to a name, never to a ticket; created only if absent,
//                                 never re-pointed.
// The profile is only the lookup key: records are used (a ticket sent or replaced, an entry
// followed) only for the realm and member they record, checked against the profile before the
// hello and against the welcome after it (scopeMatches); a bind never replaces another scope's.
// Every mutation takes `allowed` and checks it inside the record's lock, right before writing.
// A running server deletes nothing: records go only by the expiry prune (unused for
// TICKET_TTL_MS; a holder refreshes its name record and its aliases daily). Times on disk are
// pruning hints only.
//
// The start rule (decideStart) reads the session events of the Claude Code process
// (lib/sessionevents.js) as a set: the name is kept only when they name one conversation, plus
// conversations /clear or compaction started from it. Anything else is "off" for this start:
// today's behaviour (an automatic name, nothing written).
//
// Every stdio MCP server of a Claude Code process, a kept name or not, also keeps `<K>.names.json`
// in the wake folder (next to its other wake files, and pruned with them): {key, mcp, parent,
// peer, at, stable: "on" | the reason it is off | "none" (not eligible: a fixed name, a shared
// process)}. `parent` is the identity of the Claude Code process's parent (under hoptell tmux:
// the pane's process, which a team records as its member's session root). doctor shows the
// eligible ones; sessionEventsFor finds which process ran a member, after it has exited (a team
// restart finding its member's conversation).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, ensurePrivateDir } from "./config.js";
import { withLock, writeRecord } from "./locks.js";
import { readRecord, wakeDir } from "./wake.js";
import { readSessionEvents } from "./sessionevents.js";
import { processInfo, sameProcess } from "./host.js";
import { TICKET_TTL_MS } from "./claims.js";

const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_RECORD = 1024;
const MAX_NAME_RECORD = 16 * 1024; // a name record with ALIASES_MAX aliases
export const ALIASES_MAX = 256;
const ALIAS_RE = /^[0-9a-f]{40}$/;
/** Sources whose new session id continues the conversation of the process (no origin). */
const FOLLOWS = new Set(["clear", "compact"]);
const PRUNE_BATCH = 64;
const RECORD_FILE = /^[NS]-[0-9a-f]{40}\.json$/;

export const namesDir = (home) => path.join(home, "names");
const hash = (...parts) => crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
export const nameFile = (home, profile, name) => path.join(namesDir(home), `N-${hash("name", profile, name)}.json`);
const entryId = (profile, sessionId) => hash("claude-code", profile, sessionId);
export const entryFile = (home, profile, sessionId) => path.join(namesDir(home), `S-${entryId(profile, sessionId)}.json`);
const ensureDir = (home) => {
  ensurePrivateDir(home);
  return ensurePrivateDir(namesDir(home));
};
const read = (file, max = MAX_RECORD) => {
  try {
    return readRecord(file, 1, max);
  } catch {
    return null;
  }
};
const readN = (file) => read(file, MAX_NAME_RECORD);
const aliasesOf = (r) => (Array.isArray(r?.aliases) ? r.aliases.filter((a) => typeof a === "string" && ALIAS_RE.test(a)).slice(0, ALIASES_MAX) : []);
const scopeOk = (s) => Boolean(s && typeof s.realm === "string" && s.realm && (s.member === null || (typeof s.member === "string" && s.member)));

/** Whether a name record ({realm, member}) belongs to the authenticated scope `scope` ({realm, member}). */
export const scopeMatches = (rec, scope) => scopeOk(rec) && scopeOk(scope) && rec.realm === scope.realm && rec.member === scope.member;

/** The name record of `name`: {name, ticket, realm, member} or null (missing, unsafe, or another profile). */
export function readName(home, profile, name) {
  const r = readN(nameFile(home, profile, name));
  return r && r.profile === profile && r.name === name && TICKET_RE.test(r.ticket ?? "") && scopeOk(r) ? { name: r.name, ticket: r.ticket, realm: r.realm, member: r.member } : null;
}

/** A session entry: {name, realm, member}, or null. */
export function readEntry(home, profile, sessionId) {
  const r = read(entryFile(home, profile, sessionId));
  return r && r.profile === profile && typeof r.name === "string" && NAME_RE.test(r.name) ? { name: r.name, realm: r.realm, member: r.member } : null;
}

/**
 * Put `ticket` into the name record of `name` for `scope` ({realm, member}), under its lock, only
 * if the record still holds `expect` (a ticket, or null for "absent") for that same scope;
 * undefined (a ticket the relay has just issued): whatever it holds for that scope, never a record
 * of another scope. `allowed()` is checked in the lock, right before the write. Returns
 * "written", "changed" (left as it is) or "stopped" (no longer allowed).
 */
export async function publishTicket(home, profile, name, { expect, ticket, scope, allowed = () => true, now = Date.now() }) {
  if (!TICKET_RE.test(ticket ?? "") || !NAME_RE.test(name) || !scopeOk(scope)) throw new Error("bad name ticket");
  ensureDir(home);
  const file = nameFile(home, profile, name);
  return withLock(file, () => {
    const cur = readN(file);
    if (fs.existsSync(file) && !cur) return "changed"; // unsafe or unreadable: never replaced
    const mine = Boolean(cur && cur.profile === profile && cur.name === name);
    if (expect === null && mine) return "changed";
    if (expect === undefined && mine && !scopeMatches(cur, scope)) return "changed"; // another account's name record
    if (expect != null && !(mine && cur.ticket === expect && scopeMatches(cur, scope))) return "changed";
    if (!allowed()) return "stopped";
    writeRecord(file, { v: 1, profile, realm: scope.realm, member: scope.member, name, ticket, aliases: mine ? aliasesOf(cur) : [], used: now });
    return "written";
  });
}

/**
 * Point the session entry of `sessionId` to `name` for `scope`: first its id goes into the name
 * record's aliases (refreshed with it), then the entry is created if absent. Each step under its
 * record's lock, checking `allowed()` right before writing. Returns "created", "same" (it already
 * points there), "other" (it points elsewhere, or to another scope), "full" (ALIASES_MAX aliases),
 * "changed" (the name record is not this scope's) or "stopped".
 */
export async function linkSession(home, profile, sessionId, name, { scope, allowed = () => true, now = Date.now() }) {
  if (!scopeOk(scope)) throw new Error("bad name scope");
  ensureDir(home);
  const id = entryId(profile, sessionId);
  const nfile = nameFile(home, profile, name);
  const linked = await withLock(nfile, () => {
    const cur = readN(nfile);
    if (!cur || cur.profile !== profile || cur.name !== name || !scopeMatches(cur, scope)) return "changed";
    const aliases = aliasesOf(cur);
    if (aliases.includes(id)) return "ok";
    if (aliases.length >= ALIASES_MAX) return "full";
    if (!allowed()) return "stopped";
    writeRecord(nfile, { ...cur, aliases: [...aliases, id] });
    return "ok";
  });
  if (linked !== "ok") return linked;
  const file = entryFile(home, profile, sessionId);
  return withLock(file, () => {
    if (fs.existsSync(file)) {
      const e = readEntry(home, profile, sessionId);
      return e?.name === name && scopeMatches(e, scope) ? "same" : "other";
    }
    if (!allowed()) return "stopped";
    writeRecord(file, { v: 1, profile, realm: scope.realm, member: scope.member, name, used: now });
    return "created";
  });
}

/**
 * Refresh the `used` time of the name record of `name` (for `scope`) and of its aliases: no folder
 * scan. Each step under its lock, only while `allowed()`.
 */
export async function touchName(home, profile, name, { scope, allowed = () => true, now = Date.now() } = {}) {
  const nfile = nameFile(home, profile, name);
  let aliases = [];
  await withLock(nfile, () => {
    const r = readN(nfile);
    if (!r || r.profile !== profile || r.name !== name || !scopeMatches(r, scope) || !allowed()) return;
    aliases = aliasesOf(r);
    writeRecord(nfile, { ...r, used: now });
  }).catch(() => {});
  for (const a of aliases) {
    const file = path.join(namesDir(home), `S-${a}.json`);
    await withLock(file, () => {
      const r = read(file);
      if (r && r.profile === profile && r.name === name && scopeMatches(r, scope) && allowed()) writeRecord(file, { ...r, used: now });
    }).catch(() => {});
  }
}

/** Where the next prune of a names folder starts: a random place at first, then where the last one stopped. */
const pruneFrom = new Map();

/** Remove records not used for TICKET_TTL_MS (bounded work per call, rotating; each under its lock). */
export async function pruneNames(home, { now = Date.now(), ttlMs = TICKET_TTL_MS } = {}) {
  const dir = namesDir(home);
  let all;
  try {
    all = fs.readdirSync(dir).filter((n) => RECORD_FILE.test(n)).sort();
  } catch {
    return;
  }
  if (!all.length) return;
  const start = (pruneFrom.get(dir) ?? crypto.randomInt(all.length)) % all.length;
  const batch = [...all.slice(start), ...all.slice(0, start)].slice(0, PRUNE_BATCH);
  pruneFrom.set(dir, start + batch.length);
  for (const n of batch) {
    const file = path.join(dir, n);
    await withLock(file, () => {
      const r = n.startsWith("N-") ? readN(file) : read(file);
      if (r && typeof r.used === "number" && now - r.used >= ttlMs) fs.rmSync(file, { force: true });
    }).catch(() => {});
  }
}

/**
 * The start rule (design 10, 5.2) for a Claude Code process whose session events are `events`
 * (readSessionEvents), for the authenticated scope `scope` ({realm, member}) the relay profile
 * last recorded (null when unknown). Returns one of:
 *   {kind: "continue", name, ticket, ids}  continue that name; `ids` are the session ids to give
 *                                          entries (clear/compact ids without one)
 *   {kind: "bind", ids}                    a new automatic name with a ticket, for all of `ids`
 *   {kind: "off", reason}                  no stable name for this start
 */
export function decideStart(home, profile, events, scope) {
  if (events.state === "none") return { kind: "off", reason: "Claude Code reported no session in time" };
  if (events.state !== "ok") return { kind: "off", reason: "this Claude Code process's session events cannot be read" };
  const names = new Set();
  const origins = [];
  const unbound = [];
  for (const [id, sources] of events.ids) {
    const e = readEntry(home, profile, id);
    if (e && !scopeMatches(e, scope)) return { kind: "off", reason: "this conversation's earlier name was kept for another account or relay realm" };
    if (e) names.add(e.name);
    else {
      unbound.push(id);
      if (![...sources].every((s) => FOLLOWS.has(s))) origins.push(id);
    }
  }
  if (names.size > 1) return { kind: "off", reason: "this Claude Code process has served conversations with different names" };
  if (names.size === 1) {
    if (origins.length) return { kind: "off", reason: "this Claude Code process switched conversations (resume or branch)" };
    const [name] = names;
    const rec = readName(home, profile, name);
    if (!rec) return { kind: "off", reason: "this session's earlier name is no longer recorded" };
    if (!scopeMatches(rec, scope)) return { kind: "off", reason: "this session's earlier name was kept for another account or relay realm" };
    return { kind: "continue", name, ticket: rec.ticket, ids: unbound };
  }
  if (origins.length !== 1) return { kind: "off", reason: "this Claude Code process has served more than one conversation" };
  return { kind: "bind", ids: [...events.ids.keys()] };
}

/**
 * Publish a new name for the session ids `ids` (rule 2): the name record first, then the entries
 * in any order, every write only while `allowed()` (checked in each lock). No rollback: a
 * conflicting entry stops it, and what was written stays. Returns "bound" (every entry points to
 * `name`), "other" (an entry points elsewhere, the name record is another scope's or unsafe),
 * "full" (too many aliases) or "stopped" (no longer allowed).
 */
export async function bindName(home, profile, name, ticket, ids, { scope, allowed = () => true } = {}) {
  const p = await publishTicket(home, profile, name, { ticket, scope, allowed });
  if (p !== "written") return p === "stopped" ? "stopped" : "other";
  for (const id of ids) {
    const r = await linkSession(home, profile, id, name, { scope, allowed });
    if (r === "stopped" || r === "full") return r;
    if (r === "other" || r === "changed") return "other";
  }
  return "bound";
}

const STATUS_FILE = /^([0-9a-f]{32})\.names\.json$/;
const STATUS_MAX = 256;
const identityOk = (p) => Boolean(p && Number.isSafeInteger(p.pid) && p.pid > 0 && typeof p.start === "string" && p.start && typeof p.boot === "string" && p.boot);

/**
 * The status of this server for process key `key` in the wake folder `dir` (see the header).
 * `parent`: {pid, start, boot} of the Claude Code process's parent, or null.
 */
export function writeNamesStatus(dir, key, { peer, stable, parent = null, now = Date.now() }) {
  const me = processInfo(process.pid);
  if (!me) return;
  const p = identityOk(parent) ? { pid: parent.pid, start: parent.start, boot: parent.boot } : null;
  writeRecord(path.join(dir, `${key}.names.json`), { v: 1, key, mcp: { pid: process.pid, start: me.start }, parent: p, peer: peer ?? "", at: now, stable: String(stable).slice(0, 200) });
}

/** The status records in the wake folder `dir`, strictly checked; null when there are too many to read. */
function statusRecords(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith(".names.json"));
  } catch {
    return [];
  }
  if (files.length > STATUS_MAX) return null;
  const out = [];
  for (const n of files) {
    const key = n.match(STATUS_FILE)?.[1];
    const r = key ? read(path.join(dir, n)) : null;
    if (!r || r.key !== key || typeof r.peer !== "string" || typeof r.stable !== "string" || !Number.isFinite(r.at) || !Number.isSafeInteger(r.mcp?.pid)) continue;
    out.push(r);
  }
  return out;
}

/** The stable-name status of running eligible servers in the wake folder `dir`, for doctor: [{peer, stable}]. */
export function namesStatus(dir) {
  return (statusRecords(dir) ?? []).filter((r) => r.stable !== "none" && sameProcess(r.mcp)).map((r) => ({ peer: r.peer, stable: r.stable }));
}

/**
 * The session events (readSessionEvents) of the one Claude Code process whose hoptell MCP server
 * ran as `peer` since `since` (ms), running or exited, and whose parent process is `root`
 * ({pid, start, boot}: under hoptell tmux, the pane's process a team records). {state: "none"}
 * when there is no such process, more than one, `since` is not a finite number, or `root` is
 * missing; a record without a parent never matches.
 */
export function sessionEventsFor(home, peer, { since, root } = {}) {
  if (!Number.isFinite(since) || typeof peer !== "string" || !NAME_RE.test(peer) || !identityOk(root)) return { state: "none" };
  const dir = wakeDir(home);
  const recs = statusRecords(dir);
  if (!recs) return { state: "none" };
  const ours = (r) => identityOk(r.parent) && r.parent.pid === root.pid && r.parent.start === root.start && r.parent.boot === root.boot;
  const keys = new Set(recs.filter((r) => r.peer === peer && r.at >= since && ours(r)).map((r) => r.key));
  return keys.size === 1 ? readSessionEvents(dir, [...keys][0]) : { state: "none" };
}
