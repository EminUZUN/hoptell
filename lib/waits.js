// What a session waits on (design 9, A and B): the occurrence its injector sees now, kept so that
// hoptell team status and the session listing can show it, and the budget of the owner's Telegram
// notes. lib/prompts.js classifies the pane; this module keeps the records.
//
// A session's occurrence is sessions/<name>.wait.json, written atomically by its injector only:
//   {v: 1, id: "P<n>", nonce, kind: "prompt"|"stall", subtype, actionable, since, opened, owner}
// owner: {tmux: "$<n>", pane: "%<n>", injector: {pid, start, uid, boot}}, the launch and pane of
// the injector that wrote it. A record whose injector no longer runs is not shown, and a new
// injector removes any record that is not its own before it watches. It holds no pane text. Display ids P<n> count per home (v2/waits/counter.json); the nonce is
// random and names the occurrence everywhere else. The owner budget (v2/waits/budget.json): one
// note per occurrence, a cooldown per session and kind for new occurrences, at most OWNER_HOURLY
// an hour per home, and one summary line beyond that.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, checkName, ensurePrivateDir } from "./config.js";
import { tryLock, writeRecord } from "./locks.js";
import { canonicalize } from "./jcs.js";
import { SUBTYPES } from "./prompts.js";
import { identityState } from "./host.js";

export const OWNER_COOLDOWN_MS = 5 * 60_000;
export const OWNER_HOURLY = 20;
const HOUR = 60 * 60_000;
const RECORD_MAX = 4096;
const BUDGET_MAX = 16384;
const STALLS = ["busy", "unread"];

export const waitFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.wait.json`);
const waitsDir = (home) => ensurePrivateDir(path.join(ensurePrivateDir(path.join(home, "v2")), "waits"));

const isTime = (x) => typeof x === "string" && x.length <= 40 && !Number.isNaN(Date.parse(x));

/** A small JSON file, or null when there is none; throws when it is there but cannot be used. */
function readSmall(file, max = RECORD_MAX) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (!st.isFile() || st.size > max) throw new Error(`${file} is not a small regular file`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Run fn under `<file>.lock`, taken at once or within about a second; throws {code: "busy"} otherwise. */
function locked(file, fn) {
  for (let i = 0; i < 50; i++) {
    const release = tryLock(`${file}.lock`);
    if (typeof release === "function") {
      try {
        return fn();
      } finally {
        release();
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw Object.assign(new Error(`${file} is locked by another process`), { code: "busy" });
}

/** The next display id of this home: P1, P2, ... */
function nextId(home) {
  const file = path.join(waitsDir(home), "counter.json");
  return locked(file, () => {
    let n = 0;
    try {
      const r = readSmall(file);
      if (r && Number.isSafeInteger(r.n) && r.n >= 0) n = r.n;
    } catch {
      // a damaged counter starts again: ids are for display only
    }
    writeRecord(file, { n: n + 1 });
    return `P${n + 1}`;
  });
}

const isOwner = (o) =>
  Boolean(o) &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).length === 3 &&
  typeof o.tmux === "string" &&
  /^\$\d{1,9}$/.test(o.tmux) &&
  typeof o.pane === "string" &&
  /^%\d{1,9}$/.test(o.pane) &&
  Boolean(o.injector) &&
  typeof o.injector === "object" &&
  Object.keys(o.injector).length === 4 &&
  Number.isSafeInteger(o.injector.pid) &&
  o.injector.pid > 1 &&
  typeof o.injector.start === "string" &&
  o.injector.start.length > 0 &&
  o.injector.start.length <= 64 &&
  Number.isSafeInteger(o.injector.uid) &&
  typeof o.injector.boot === "string" &&
  o.injector.boot.length <= 64;
/** Are `a` and `b` the same injector, launch and pane? */
export const sameOwner = (a, b) => isOwner(a) && isOwner(b) && a.tmux === b.tmux && a.pane === b.pane && ["pid", "start", "uid", "boot"].every((k) => a.injector[k] === b.injector[k]);

/** The checked occurrence record `r`, or null. */
function checked(r) {
  const keys = ["v", "id", "nonce", "kind", "subtype", "actionable", "since", "opened", "owner"];
  const ok =
    r &&
    typeof r === "object" &&
    !Array.isArray(r) &&
    Object.keys(r).length === keys.length &&
    keys.every((k) => Object.hasOwn(r, k)) &&
    r.v === 1 &&
    typeof r.id === "string" &&
    /^P[1-9]\d{0,8}$/.test(r.id) &&
    typeof r.nonce === "string" &&
    /^[0-9a-f]{32}$/.test(r.nonce) &&
    (r.kind === "prompt" ? SUBTYPES.includes(r.subtype) : r.kind === "stall" && STALLS.includes(r.subtype)) &&
    typeof r.actionable === "boolean" &&
    isTime(r.since) &&
    isTime(r.opened) &&
    isOwner(r.owner);
  return ok ? r : null;
}

/**
 * Open an occurrence for session `name` (`start`: what lib/prompts.js createWatch returned) and keep
 * it as the session's record, written by injector `owner`. Returns the record; throws when it
 * could not be kept.
 */
export function openOccurrence(home, name, start, { owner, now = Date.now }) {
  const rec = {
    v: 1,
    id: nextId(home),
    nonce: crypto.randomBytes(16).toString("hex"),
    kind: start.kind,
    subtype: start.subtype,
    actionable: Boolean(start.actionable),
    since: new Date(start.since).toISOString(),
    opened: new Date(now()).toISOString(),
    owner,
  };
  if (!checked(rec)) throw new Error("not a valid occurrence");
  ensurePrivateDir(path.join(home, "sessions"));
  writeRecord(waitFileOf(home, name), rec);
  return rec;
}

/** Session `name`'s record as written: the checked record, null when there is none, or false when it is not one. */
function recordOf(home, name) {
  try {
    const r = readSmall(waitFileOf(home, name));
    return r === null ? null : (checked(r) ?? false);
  } catch {
    return false;
  }
}

/**
 * End session `name`'s occurrence `nonce`, if it is still the one kept: only that occurrence is
 * removed, never another injector's. Never throws.
 */
export function closeOccurrence(home, name, nonce) {
  try {
    if (recordOf(home, name)?.nonce === nonce) fs.rmSync(waitFileOf(home, name), { force: true });
  } catch {
    // the record stays; a later injector or team status sees whose it is
  }
}

/**
 * Before injector `owner` watches session `name`: remove a record that is not its own (an earlier
 * injector's, or one that is not a record). Never throws.
 */
export function clearForeignOccurrence(home, name, owner) {
  try {
    const r = recordOf(home, name);
    if (r === null || (r && sameOwner(r.owner, owner))) return;
    if (r) closeOccurrence(home, name, r.nonce);
    else fs.rmSync(waitFileOf(home, name), { force: true });
  } catch {
    // shown by no one: team status checks the injector
  }
}

/**
 * Session `name`'s current occurrence, or null: none, a record that is not one, or one whose
 * injector does not run any more (`state`: lib/host.js identityState; only "same" is shown).
 */
export function readOccurrence(home, name, { state = identityState } = {}) {
  if (typeof name !== "string" || !NAME_RE.test(name)) return null;
  const r = recordOf(home, name);
  return r && state(r.owner.injector) === "same" ? r : null;
}

const LABELS = {
  "codex-startup-trust": "Codex folder trust",
  "folder-trust": "folder trust",
  approval: "an approval",
  login: "a sign-in",
  update: "an update prompt",
  "hook-trust": "hook trust",
  "mcp-trust": "MCP server trust",
  "unknown-dialog": "a dialog",
};

/** What a session waits on, in words: "Codex folder trust", "no change for 12 min". */
export function waitLabel(rec, now = Date.now()) {
  if (rec.kind === "stall") return `no change for ${Math.max(1, Math.floor((now - Date.parse(rec.since)) / 60_000))} min`;
  return LABELS[rec.subtype] ?? "a prompt";
}

/** One line for team status and the listing: "waiting for you: Codex folder trust (P3, 2 min)". */
export function waitLine(rec, now = Date.now()) {
  if (rec.kind === "stall") return `${waitLabel(rec, now)} (${rec.id})`;
  const min = Math.max(0, Math.floor((now - Date.parse(rec.since)) / 60_000));
  return `waiting for you: ${waitLabel(rec, now)} (${rec.id}, ${min} min)`;
}

/**
 * May the injector of `name` tell the owner about occurrence `rec` now? Decided and recorded under
 * the budget's lock: "send" (counted), "summary" (the hour's limit was just reached: one line that
 * says notes are paused), or "skip" (the cooldown of this session and kind, or the hour's limit).
 * A budget that cannot be read or written fails closed ("skip").
 */
export function ownerBudget(home, name, rec, { now = Date.now } = {}) {
  let file;
  try {
    file = path.join(waitsDir(home), "budget.json");
  } catch {
    return "skip";
  }
  try {
    return locked(file, () => {
      const t = now();
      const b = readSmall(file, BUDGET_MAX); // one that cannot be read throws: "skip"
      const sent = Array.isArray(b?.sent) ? b.sent.filter((x) => Number.isFinite(x) && t - x < HOUR && x <= t) : [];
      const last = b && typeof b.last === "object" && !Array.isArray(b.last) ? b.last : {};
      const key = `${name}\n${rec.kind}\n${rec.subtype}`;
      const keep = Object.fromEntries(Object.entries(last).filter(([, at]) => Number.isFinite(at) && t - at < OWNER_COOLDOWN_MS));
      const paused = Number.isFinite(b?.paused) && t - b.paused < HOUR ? b.paused : null;
      let verdict;
      if (Object.hasOwn(keep, key)) verdict = "skip";
      else if (sent.length < OWNER_HOURLY) verdict = "send";
      else verdict = paused === null ? "summary" : "skip";
      if (verdict === "send") {
        sent.push(t);
        keep[key] = t;
      }
      // The record stays small: at most OWNER_HOURLY times, and the cooldowns of the last few minutes.
      const entries = Object.entries(keep).slice(-64);
      writeRecord(file, { sent, last: Object.fromEntries(entries), paused: verdict === "summary" ? t : paused });
      return verdict;
    });
  } catch {
    return "skip";
  }
}

// ---- the note to the owner's bridge ------------------------------------------------------------

const NOTE_KEYS = ["hoptell_wait", "kind", "subtype", "session", "team", "folder", "minutes", "nonce"];

/**
 * The note the injector sends the owner's bridge about occurrence `rec` of session `session`
 * (lib/control.js), or the summary line when the hour's budget ran out (`rec` null): canonical JSON
 * the bridge words itself (lib/ownertexts.js), never pane text. `team` and `folder` (the last part
 * of the launch folder) are display only.
 */
export function waitNoteText(rec, { session, team = null, folder = null, now = Date.now() }) {
  const note = rec
    ? { hoptell_wait: 1, kind: rec.kind, subtype: rec.subtype, session, team, folder: folder ? clipFolder(folder) : null, minutes: Math.max(0, Math.floor((now - Date.parse(rec.since)) / 60_000)), nonce: rec.nonce }
    : { hoptell_wait: 1, kind: "summary", subtype: null, session, team: null, folder: null, minutes: 0, nonce: crypto.randomBytes(16).toString("hex") };
  return canonicalize(note);
}
const clipFolder = (f) => [...String(f).replace(/[\p{Cc}\p{Cf}\u2028\u2029/\\]+/gu, " ").trim()].slice(0, 64).join("") || null;

/**
 * The note `text` checked: its fields, or null when it is not exactly one. Every field has its
 * type checked before it is used; never throws (a note that is not one goes the way of any other
 * reserved text: dropped and confirmed).
 */
export function parseWaitNote(text) {
  try {
    return checkedNote(text);
  } catch {
    return null;
  }
}
function checkedNote(text) {
  if (typeof text !== "string" || !text.startsWith('{"') || text.length > 1024) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== NOTE_KEYS.length || !NOTE_KEYS.every((k) => Object.hasOwn(v, k))) return null;
  if (v.hoptell_wait !== 1 || canonicalize(v) !== text) return null;
  const str = (x) => typeof x === "string";
  const kindOk = v.kind === "summary" ? v.subtype === null : v.kind === "prompt" ? str(v.subtype) && SUBTYPES.includes(v.subtype) : v.kind === "stall" && str(v.subtype) && STALLS.includes(v.subtype);
  const textOk = (x, max) => x === null || (str(x) && x.length > 0 && [...x].length <= max && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(x));
  if (!kindOk || !str(v.session) || !NAME_RE.test(v.session) || !textOk(v.team, 32) || !textOk(v.folder, 64)) return null;
  if (!Number.isSafeInteger(v.minutes) || v.minutes < 0 || v.minutes > 100_000 || !str(v.nonce) || !/^[0-9a-f]{32}$/.test(v.nonce)) return null;
  return v;
}
