// The owner's own view of their sessions (design 7.3, 2.7 and 2.8): favourites, aliases, hidden
// sessions and two times per session, in <home>/owner-channel/people.json on the bridge machine.
// Keyed by wire name under the bridge's own member and bound to the paired Telegram user: a file
// written for another member or another user is ignored and replaced on the next change, so a new
// owner never inherits it. Only the paired owner (through the bridge's own buttons and prompts) and
// the bridge machine's CLI change it; nothing an agent or the relay sends is read into it. An alias
// is a label, never an address: no recipient is ever looked up through this file.
import fs from "node:fs";
import path from "node:path";
import { withLock } from "./locks.js";
import { NAME_RE } from "./config.js";
import { channelPaths, readPrivateJson, writePrivateJson } from "./ownersig.js";

export const PEOPLE_MAX = 2000; // entries; past it the least recently used unmarked ones go, never a marked one
export const PEOPLE_PROTECT_MS = 86400_000; // an entry changed this recently is kept past the cap (Undo lasts a day)
export const PEOPLE_PRUNE_MS = 30 * 86400_000; // unmarked entries not talked to (or seen) for 30 days go
export const ALIAS_MAX = 24;
/** First lines of the bot's own messages start with these: an alias may not. */
const CARD_MARKS = ["❓", "✅", "⌛", "⚠", "✖", "💬", "✏", "👍", "★", "☆", "🔍", "🙈", "ⓘ", "◀", "▶"];

export const peoplePath = (home) => path.join(channelPaths(home).dir, "people.json");

// Sessions are dictionaries without a prototype, and every entry a plain copy: a wire name such as
// "constructor" or "toString" is an ordinary key, never an inherited property.
const dict = () => Object.create(null);
const fresh = (member, owner) => ({ v: 1, member, owner, sessions: dict() });
const isEntry = (e) => e && typeof e === "object" && !Array.isArray(e);
const ENTRY_KEYS = ["fav", "alias", "alias_host", "hidden", "last_talked", "first_seen", "rev", "last_op", "rev_at"];
const copyEntry = (e) => {
  const out = dict();
  for (const k of ENTRY_KEYS) if (Object.hasOwn(e, k)) out[k] = e[k];
  return out;
};

/**
 * people.json for this bridge member and paired user: {v, member, owner, sessions}. Missing,
 * unreadable or malformed, or written for another member or user: an empty one (not written until
 * a change). `owner` is the paired Telegram user id; without a pairing (null) nothing applies.
 */
export function readPeople(home, { member, owner }) {
  const want = { member: member ?? null, owner: owner == null ? null : String(owner) };
  if (!want.member || !want.owner) return fresh(want.member, want.owner);
  let doc;
  try {
    doc = readPrivateJson(peoplePath(home), 4 * 1024 * 1024);
  } catch {
    return fresh(want.member, want.owner);
  }
  if (!doc || doc.v !== 1 || doc.member !== want.member || String(doc.owner) !== want.owner || !isEntry(doc.sessions)) return fresh(want.member, want.owner);
  const sessions = dict();
  for (const [name, e] of Object.entries(doc.sessions)) if (NAME_RE.test(name) && isEntry(e)) sessions[name] = copyEntry(e);
  return { v: 1, member: want.member, owner: want.owner, sessions, ...(Number.isSafeInteger(doc.seq) && doc.seq > 0 ? { seq: doc.seq } : {}) };
}

/**
 * A settings change of one entry (design 7.4, section 7): it gets a new revision and `last_op`
 * names the write that made it (an app op id, "bot:<update id>" or "cli:<random>"), so recovery and
 * Undo know which writer made the current revision, even when two writers set the same values.
 * Signals (last_talked, first_seen) are not settings and leave both alone. The revision written is
 * the file's next one (updatePeople renumbers): revisions never repeat in one file, also when an
 * entry is pruned and made again, so "changed away and back" is always a new revision.
 */
export function bump(e, op) {
  e.rev = (Number.isSafeInteger(e.rev) && e.rev > 0 ? e.rev : 0) + 1;
  e.last_op = String(op);
  return e;
}
/** An entry's revision (0 when it has none). */
export const revOf = (e) => (Number.isSafeInteger(e?.rev) && e.rev > 0 ? e.rev : 0);

/** Whether an entry carries something the owner set (it is kept regardless of age). */
export const marked = (e) => Boolean(e?.fav || e?.alias || e?.hidden);

/** Thrown when the scope a change was made for is no longer the current one (a re-pair, an unpair). */
export class PeopleStaleError extends Error {
  constructor() {
    super("the owner channel's pairing changed, so nothing was saved");
    this.code = "PEOPLE_STALE";
  }
}

/** Thrown by a change that refuses (an alias rule): nothing is written. `reason`: the rule. */
export class PeopleRefusedError extends Error {
  constructor(reason) {
    super(`refused: ${reason}`);
    this.code = "PEOPLE_REFUSED";
    this.reason = reason;
  }
}

/** Thrown when a new name would be marked while PEOPLE_MAX entries are all marked. */
export class PeopleFullError extends Error {
  constructor() {
    super("people.json is full of saved entries");
    this.code = "PEOPLE_FULL";
  }
}

const lastUse = (e) => Math.max(Number(e.last_talked) || 0, Number(e.first_seen) || 0, Number(e.rev_at) || 0);

/**
 * Drop unmarked entries untouched for 30 days, then the least recently used unmarked ones past
 * PEOPLE_MAX. A marked entry is never dropped: automatic signals never displace a saved preference.
 */
export function prune(doc, now = Date.now()) {
  for (const [name, e] of Object.entries(doc.sessions)) if (!marked(e) && now - lastUse(e) > PEOPLE_PRUNE_MS) delete doc.sessions[name];
  const names = Object.keys(doc.sessions);
  if (names.length > PEOPLE_MAX) {
    // Past the cap, an entry changed in the last day is kept like a marked one: its Undo may
    // still check its revision. A newly seen agent's entry goes instead (updatePeople).
    const kept = (e) => marked(e) || now - (Number(e.rev_at) || 0) < PEOPLE_PROTECT_MS;
    const unmarked = names.filter((n) => !kept(doc.sessions[n])).sort((a, b) => lastUse(doc.sessions[a]) - lastUse(doc.sessions[b]));
    for (const name of unmarked.slice(0, names.length - PEOPLE_MAX)) delete doc.sessions[name];
  }
  return doc;
}

/**
 * Read, change and write people.json in one step, under <people.json>.lock (the bridge and the CLI
 * both change it): `change(sessions, entry)` edits the entries (an entry is created on first use
 * by `entry(name)`) and returns a result that is passed on; it sees the sessions as read under the
 * lock, so a check it makes (an alias rule) holds for the write. Nothing is written without a
 * member and a paired user. `still()`, called under the lock before anything is read, says whether
 * `scope` (and the pairing the change was made under) is still the current one; if not,
 * PeopleStaleError and nothing is written (a change made for an earlier owner never lands in a
 * later owner's file). When PEOPLE_MAX entries are all marked, a new unmarked entry is not kept
 * (its signals are skipped) and marking a new name throws PeopleFullError; nothing is written then.
 */
export async function updatePeople(home, scope, change, now = Date.now(), { still = () => true } = {}) {
  const doc0 = readPeople(home, scope);
  if (!doc0.member || !doc0.owner) throw new Error("the owner channel is not paired, so there is nothing to change yet");
  fs.mkdirSync(channelPaths(home).dir, { recursive: true, mode: 0o700 });
  return withLock(peoplePath(home), () => {
    if (!still()) throw new PeopleStaleError();
    const doc = readPeople(home, scope);
    const before = new Set(Object.keys(doc.sessions));
    const revsBefore = new Map(Object.entries(doc.sessions).map(([n, e]) => [n, revOf(e)]));
    let seq = Math.max(doc.seq ?? 0, ...revsBefore.values());
    const entry = (name) => {
      if (!NAME_RE.test(name)) throw new PeopleRefusedError("name");
      if (!Object.hasOwn(doc.sessions, name)) doc.sessions[name] = dict();
      return doc.sessions[name];
    };
    const result = change(doc.sessions, entry);
    // Every entry whose revision the change raised gets the file's next revision.
    // It also records when (rev_at): a change counts as use, so an entry a change left unmarked
    // (a name removed) is not pruned while its Undo can still check its revision.
    for (const [name, e] of Object.entries(doc.sessions)) {
      if (revOf(e) === (revsBefore.get(name) ?? 0)) continue;
      e.rev = ++seq;
      e.rev_at = now;
    }
    doc.seq = seq;
    for (const [name, e] of Object.entries(doc.sessions)) {
      for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === false || e[k] === null || e[k] === "") delete e[k];
      if (!Object.keys(e).length) delete doc.sessions[name];
    }
    prune(doc, now);
    const names = Object.keys(doc.sessions);
    if (names.length > PEOPLE_MAX) {
      // Only marked or just-changed entries are left past the cap: a name that was not here before
      // cannot join.
      const added = names.filter((n) => !before.has(n));
      if (added.some((n) => marked(doc.sessions[n]))) throw new PeopleFullError();
      for (const n of added) delete doc.sessions[n];
    }
    writePrivateJson(peoplePath(home), doc);
    return result;
  });
}

/** Remove people.json (unpair --all), under its lock: a change waiting for the lock finds it gone. */
export async function removePeople(home) {
  if (!fs.existsSync(channelPaths(home).dir)) return;
  await withLock(peoplePath(home), () => fs.rmSync(peoplePath(home), { force: true }), { waitMs: 10_000 });
}

/**
 * Why `alias` cannot name `wire`, checked against `sessions` (people.json as read under its lock)
 * and `listed` (own agents' wire names the relay lists now, if known); `display(name)` gives a
 * logical name. Every other session's alias, and every other own agent's logical and wire name,
 * is taken. null: it can.
 */
export function aliasProblemIn(alias, wire, sessions, listed, display) {
  const names = new Set([...listed, ...Object.keys(sessions)]);
  names.delete(wire);
  const taken = [...[...names].flatMap((n) => [n, display(n)]), ...Object.keys(sessions).filter((n) => n !== wire && typeof sessions[n].alias === "string").map((n) => sessions[n].alias)];
  return aliasProblem(alias, taken);
}

/**
 * Why `alias` cannot name session `wire` (null: it can). `taken`: the other names to compare with
 * case-insensitively (other sessions' aliases, and every own agent's logical and wire name now
 * listed or held in people.json, except this session's own). Codes: "control", "length",
 * "prefix" (@ or /), "symbol" (·, or a leading emoji or bot mark), "taken".
 */
export function aliasProblem(alias, taken = []) {
  const raw = String(alias ?? "");
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(raw.replace(/[\t ]/g, ""))) return "control";
  const a = raw.trim().replace(/\s+/g, " ");
  if (a.length < 1 || [...a].length > ALIAS_MAX) return "length";
  if (/^[@/]/.test(a)) return "prefix";
  if (a.includes("·") || /^\p{Extended_Pictographic}/u.test(a) || CARD_MARKS.some((m) => a.startsWith(m))) return "symbol";
  const lower = a.toLowerCase();
  if (taken.some((x) => String(x).toLowerCase() === lower)) return "taken";
  return null;
}

/** The alias as stored (trimmed, inner spaces folded). */
export const normalAlias = (alias) => String(alias).trim().replace(/\s+/g, " ");

/**
 * The fields one settings change writes (shared by the bot's buttons and the app): favourite and
 * hidden exclude each other (a favourite is always shown; hiding one ends it). Explicit values,
 * never a toggle, so a redone change sets the same thing again.
 */
export function settingFields(setting, value) {
  if (setting === "fav") return value ? { fav: true, hidden: false } : { fav: false };
  if (setting === "hidden") return value ? { hidden: true, fav: false } : { hidden: false };
  throw new Error(`unknown setting ${setting}`);
}
