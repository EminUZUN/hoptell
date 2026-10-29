// Auto-land grants (design 8 addendum, option 6): the owner's bypass. While a grant is active, the
// lead lands reviewed and tested work of one team run on the grant's frozen targets without a
// decision per landing. Each auto-landing is still a normal landing action (lib/landings.js) with
// its own immutable manifest; the grant only supplies the decision (route "grant", the grant's
// digest).
//
// A grant is owner-only. It comes from the owner's Telegram (a signed landing_grant envelope, the
// only kind that proves it came through the owner's bridge) or from a terminal (hoptell team
// autoland: policy only, like hoptell team approve, since a process of the same user can type it).
// Its record is create-only: <home>/teams/<team>/grants/<id>.json. What changes is kept apart, in
// grants/state.json, under the team's lock: each grant's status (active, revoked, exhausted,
// expired, retired: every one but active is final), the actions it approved, the slots they
// reserved and the notices the owner was given for them; the revocation generation; and the
// auto-landing notices still to send.
//
// Revocation is an epoch, not a time: every grant names the team's revocation generation it was
// given under, and only a grant of the current generation is usable. Each --off makes a new
// generation, so every earlier grant, seen or not yet delivered, is dead whatever the clocks of
// the Mac and the bridge say.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalize } from "./jcs.js";
import { ensurePrivateDir } from "./config.js";
import { readPrivateFile } from "./agents.js";
import { writeRecord } from "./locks.js";
import { LandingError, createOnly } from "./landings.js";
import { MEMBER_ID_RE, parseEnvelope, seenKeepUntil, verifyEnvelope } from "./ownersig.js";

export const GRANT_MAX_MS = 24 * 60 * 60_000;
export const GRANT_DEFAULT_MS = 2 * 60 * 60_000;
export const GRANT_ID_RE = /^g_[a-z2-7]{16}$/;
export const GRANT_STATUSES = ["active", "revoked", "exhausted", "expired", "retired"];
const TARGETS_MAX = 16;
const COUNT_MAX = 1000;
const RECORD_MAX = 64 * 1024;
const STATE_MAX = 1024 * 1024;
/**
 * Notices this Mac still owes the owner's bridge at which no new auto-landing starts (none is ever
 * dropped). It counts only what the bridge has not taken: a notice the bridge took and holds until
 * Telegram shows it no longer counts, so the bridge's own list (at most 2,000 lines, any team or
 * Mac) can fill up meanwhile.
 */
export const NOTICES_MAX = 50;
/** How far in this Mac's future a grant's not_before may be (the bridge's clock may run ahead); expiry has no such allowance. */
export const NOT_BEFORE_SKEW_MS = 120_000;
const NOTICES_HARD = 1000;

const fail = (code, message) => {
  throw new LandingError(code, message);
};
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const isPlain = (x) => x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const same = (x, keys) => Object.keys(x).sort().join() === [...keys].sort().join();
const isBranch = (x) => typeof x === "string" && /^[A-Za-z0-9][\w./-]{0,199}$/.test(x) && !x.includes(".."); // as lib/teams.js
const isMs = (x) => Number.isSafeInteger(x) && x > 0;

/** A new grant id: g_ and 16 base32 letters. */
export function newGrantId() {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  return `g_${[...crypto.randomBytes(16)].map((b) => a[b & 31]).join("")}`;
}

/** The grants folder of a team, a grant's record and the state. */
export function grantPaths(home, team, id = null) {
  const dir = path.join(home, "teams", team, "grants");
  if (id !== null && !GRANT_ID_RE.test(String(id))) fail("bad_grant", `"${String(id).slice(0, 40)}" is not a grant id`);
  return { dir, state: path.join(dir, "state.json"), record: id && path.join(dir, `${id}.json`) };
}

// ---- the scope ---------------------------------------------------------------------------------

const SCOPE_KEYS = ["hoptell_landing_grant", "id", "team", "run", "generation", "enrolment", "recipient", "targets", "issued_at", "not_before", "expires_at", "max_count", "op", "origin"];

/**
 * What is wrong with a grant's scope, or null. Exactly these keys: the team and its run, the
 * revocation generation it was given under, the repository's enrolment, the recipient lead and member (null for a terminal grant), the frozen,
 * sorted set of targets (never empty, never "any"), the times in ms (at most GRANT_MAX_MS from
 * issue to expiry), an optional count, the operation "land", and the action whose card gave it.
 */
export function scopeProblem(g) {
  if (!isPlain(g) || !same(g, SCOPE_KEYS)) return "keys";
  if (g.hoptell_landing_grant !== 1) return "version";
  if (!GRANT_ID_RE.test(String(g.id))) return "id";
  if (typeof g.team !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(g.team)) return "team";
  if (typeof g.run !== "string" || !/^[0-9a-f]{32}$/.test(g.run)) return "run";
  if (!Number.isSafeInteger(g.generation) || g.generation < 0) return "generation";
  const e = g.enrolment;
  if (!isPlain(e) || !same(e, ["common", "id", "generation"]) || typeof e.common !== "string" || !path.isAbsolute(e.common) || e.common.length > 4096 || typeof e.id !== "string" || !/^[0-9a-f]{32}$/.test(e.id) || !Number.isSafeInteger(e.generation) || e.generation < 1) return "enrolment";
  const r = g.recipient;
  if (r !== null && (!isPlain(r) || !same(r, ["lead", "member"]) || typeof r.lead !== "string" || r.lead.length > 64 || !MEMBER_ID_RE.test(String(r.member)))) return "recipient";
  if (!Array.isArray(g.targets) || !g.targets.length || g.targets.length > TARGETS_MAX || !g.targets.every(isBranch) || canonicalize(g.targets) !== canonicalize([...new Set(g.targets)].sort())) return "targets";
  if (!isMs(g.issued_at) || !isMs(g.not_before) || !isMs(g.expires_at)) return "times";
  if (g.not_before < g.issued_at || g.expires_at <= g.not_before || g.expires_at - g.issued_at > GRANT_MAX_MS) return "times";
  if (g.max_count !== null && (!Number.isSafeInteger(g.max_count) || g.max_count < 1 || g.max_count > COUNT_MAX)) return "max_count";
  if (g.op !== "land") return "op";
  if (g.origin !== null && (typeof g.origin !== "string" || !/^[0-9a-f]{64}$/.test(g.origin))) return "origin";
  return null;
}

/** A grant's scope as the canonical JSON text a landing_grant envelope carries. */
export function grantText(scope) {
  const p = scopeProblem(scope);
  if (p) fail("bad_grant", `the grant is malformed (${p})`);
  return canonicalize(scope);
}

/** The scope a landing_grant text carries (exactly canonical), or null. */
export function parseGrant(text) {
  let g;
  try {
    g = JSON.parse(text);
  } catch {
    return null;
  }
  return !scopeProblem(g) && canonicalize(g) === text ? g : null;
}

// ---- records and state -----------------------------------------------------------------------

/**
 * Keep a grant's record, create-only: {version, source: "terminal"|"telegram", scope, envelope
 * (the original signed bytes, or null)}. Returns {id, digest} (the digest of the record's
 * canonical JSON, which an action approved by it names). A record already there must be the same.
 */
export function storeGrant(home, team, { source, scope, envelope = null }) {
  if (!["terminal", "telegram"].includes(source) || (source === "telegram") !== (typeof envelope === "string")) fail("bad_grant", "a grant from Telegram has its signed envelope, one from a terminal none");
  grantText(scope);
  const bytes = canonicalize({ version: 1, source, scope, envelope });
  const p = grantPaths(home, team, scope.id);
  ensurePrivateDir(p.dir);
  try {
    createOnly(p.record, bytes);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const had = readPrivateFile(p.record, RECORD_MAX);
    if (had.missing || had.problem || had.bytes.toString("utf8") !== bytes) fail("grant_changed", `${p.record} already holds another grant than this one; hoptell keeps the first`);
  }
  return { id: scope.id, digest: sha256(bytes) };
}

/** A grant's record {version, source, scope, envelope, digest}; refused when it is missing, changed or malformed. */
export function readGrant(home, team, id) {
  const p = grantPaths(home, team, id);
  const r = readPrivateFile(p.record, RECORD_MAX);
  if (r.missing) fail("no_grant", `no auto-land grant ${id} is kept for team ${team}`);
  if (r.problem) fail("grant_changed", `${p.record} ${r.problem}`);
  const text = r.bytes.toString("utf8");
  let g;
  try {
    g = JSON.parse(text);
  } catch {
    fail("grant_changed", `${p.record} is not valid JSON`);
  }
  if (!isPlain(g) || !same(g, ["version", "source", "scope", "envelope"]) || g.version !== 1 || !["terminal", "telegram"].includes(g.source) || (g.source === "telegram") !== (typeof g.envelope === "string") || scopeProblem(g.scope) || g.scope.id !== id || canonicalize(g) !== text) fail("grant_changed", `${p.record} is not a valid grant record; hoptell uses nothing from it`);
  return { ...g, digest: sha256(text) };
}

// `revokes`: the Telegram revocations (/autoland off) already applied to this team, {id, until}:
// a redelivery of one makes no new generation (which would revoke a grant given since). Each is
// kept until no copy of it can verify any more (revokeKeptUntil). A revocation not kept always
// revokes: its signed time never stands in for it. At most REVOKES_MAX: when they are all still
// kept, the one kept until the earliest gives way and `revoke_dedup_gap_until` rises to its until.
// Until then auto-land is paused (no grant is given or kept, autolandPausedUntil), so a copy of
// the one that gave way can only revoke again with no grant to take; after it, that copy no
// longer verifies.
const EMPTY = { version: 1, generation: 0, grants: {}, notices: [], revokes: [], revoke_dedup_gap_until: 0 };
export const REVOKES_MAX = 2000;

/** Until when auto-land is paused for the team of `gs` (see `revokes`), or null when it is not at `now`. */
export const autolandPausedUntil = (gs, now) => (now <= gs.revoke_dedup_gap_until ? gs.revoke_dedup_gap_until : null);

/**
 * Until when a revocation applied at `appliedAt`, signed at `signedAt`, is kept: the owner channel's
 * replay horizon (a copy verifies until its time plus PAST_MS, inclusive), so the two stay aligned.
 * Kept while until >= now.
 */
export const revokeKeptUntil = (signedAt, appliedAt) => seenKeepUntil(appliedAt, signedAt);
const ACTION_RE = /^L[1-9][0-9]{0,9}$/;
const ids = (x, max) => Array.isArray(x) && x.length <= max && x.every((v) => ACTION_RE.test(String(v)));
const keys = (x, max) => Array.isArray(x) && x.length <= max && x.every((v) => /^L[1-9][0-9]{0,9}:(landed|blocked|rejected|expired)$/.test(String(v)));

/** A grant's row in the state: its status, the actions it approved, their slots, the notices acknowledged ("L9:landed"). */
export const newRow = () => ({ status: "active", actions: [], slots: [], noticed: [] });

function stateProblem(s) {
  if (!isPlain(s) || !same(s, Object.keys(EMPTY)) || s.version !== 1) return "keys";
  if (!Number.isSafeInteger(s.generation) || s.generation < 0) return "generation";
  if (!isPlain(s.grants)) return "grants";
  for (const [id, g] of Object.entries(s.grants)) {
    if (!GRANT_ID_RE.test(id) || !isPlain(g) || !same(g, Object.keys(newRow())) || !GRANT_STATUSES.includes(g.status) || !ids(g.actions, 4 * COUNT_MAX) || !ids(g.slots, COUNT_MAX) || !keys(g.noticed, 16 * COUNT_MAX)) return `grants.${id.slice(0, 20)}`;
  }
  if (!Array.isArray(s.notices) || s.notices.length > NOTICES_HARD || !s.notices.every((n) => isPlain(n) && noticeProblem(n) === null)) return "notices";
  if (!Array.isArray(s.revokes) || s.revokes.length > REVOKES_MAX || !s.revokes.every((v) => isPlain(v) && same(v, ["id", "until"]) && /^v_[a-z2-7]{16}$/.test(String(v.id)) && Number.isSafeInteger(v.until) && v.until > 0)) return "revokes";
  if (!Number.isSafeInteger(s.revoke_dedup_gap_until) || s.revoke_dedup_gap_until < 0) return "revoke_dedup_gap_until";
  return null;
}

/** The grants state of a team (an empty one when it has none); refused when it cannot be read. */
export function readGrantState(home, team) {
  const p = grantPaths(home, team);
  const r = readPrivateFile(p.state, STATE_MAX);
  if (r.missing) return structuredClone(EMPTY);
  if (r.problem) fail("grant_changed", `${p.state} ${r.problem}`);
  let s;
  try {
    s = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    fail("grant_changed", `${p.state} is not valid JSON`);
  }
  // Written before revocations from Telegram.
  if (isPlain(s) && !Object.hasOwn(s, "revokes")) s.revokes = [];
  if (isPlain(s) && !Object.hasOwn(s, "revoke_dedup_gap_until")) s.revoke_dedup_gap_until = 0;
  if (isPlain(s)) delete s.revoke_watermark; // an earlier form, never relied on
  if (isPlain(s) && Array.isArray(s.revokes)) s.revokes = s.revokes.map((v) => (isPlain(v) && Object.hasOwn(v, "issued_at") ? { id: v.id, until: v.until } : v));
  const problem = stateProblem(s);
  if (problem) fail("grant_changed", `${p.state} is not a valid grants state (${problem}); hoptell auto-lands nothing by it`);
  return s;
}

/** Write the grants state durably (the caller holds the team's lock). */
export function writeGrantState(home, team, s) {
  const problem = stateProblem(s);
  if (problem) fail("grant_changed", `the grants state to write is malformed (${problem})`);
  ensurePrivateDir(grantPaths(home, team).dir);
  writeRecord(grantPaths(home, team).state, s, 2);
}

/** The ids of the grants kept for a team (records), sorted. */
export function grantIds(home, team) {
  try {
    return fs
      .readdirSync(grantPaths(home, team).dir)
      .map((n) => n.replace(/\.json$/, ""))
      .filter((n) => GRANT_ID_RE.test(n))
      .sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// ---- checks -------------------------------------------------------------------------------------

/**
 * The status grant `g` (a record) has now in grants state `gs`, for the team state `s` (its run and
 * enrolment) at `now`, each condition read afresh, never only from the status recorded: revoked
 * (recorded so, or given under an earlier revocation generation), retired (recorded so, another
 * run, or the team down), expired (recorded so, or past its expiry), exhausted (recorded so, or
 * its slots used up). The order matters: a revocation shows even for a grant whose count or time
 * ran out. Writes nothing: the caller records a change (settleGrants).
 */
export function statusOf(g, gs, s, now) {
  const st = gs.grants[g.scope.id]?.status ?? "active";
  if (st === "revoked" || g.scope.generation !== gs.generation) return "revoked";
  if (st === "retired" || g.scope.run !== s.run || s.status === "down") return "retired";
  if (st === "expired" || now >= g.scope.expires_at) return "expired";
  if (st === "exhausted" || (g.scope.max_count !== null && (gs.grants[g.scope.id]?.slots.length ?? 0) >= g.scope.max_count)) return "exhausted";
  return "active";
}

/** Record in `gs` the status each kept grant has now; returns whether anything changed. */
export function settleGrants(home, team, gs, s, now) {
  let changed = false;
  for (const id of grantIds(home, team)) {
    let g;
    try {
      g = readGrant(home, team, id);
    } catch {
      continue;
    }
    const st = statusOf(g, gs, s, now);
    const row = (gs.grants[id] ??= newRow());
    if (row.status !== st) {
      row.status = st;
      changed = true;
    }
  }
  return changed;
}

/**
 * Check grant `id` (digest `digest`, as an action names it) for team state `s`: the record is the
 * same, a Telegram grant verifies again against the pin this home trusts now (`pinFor(realm)`)
 * and names this team's lead, and its scope is this team, run and enrolment. `phase`:
 * - "accept": also not revoked or retired, within its times (not before not_before, less NOT_BEFORE_SKEW_MS; not at or
 *   after expires_at), with a slot free (only the count exempts a slot this action already holds),
 *   and `target` in its set; each read afresh, never from a status recorded earlier;
 * - "move": not revoked and not retired (time and count were checked at acceptance);
 * - "resume": the record only (an action accepted under it reconciles whatever happened since).
 * Returns the record; throws a LandingError whose code says why (grant_revoked, grant_expired, ...).
 */
export function checkGrant(home, team, s, gs, { id, digest, phase, target = null, action = null, now, pinFor }) {
  const g = readGrant(home, team, id);
  if (g.digest !== digest) fail("grant_changed", `the auto-land grant ${id} is not the one this landing was approved by`);
  if (g.source === "telegram") {
    const env = parseEnvelope(g.envelope)?.env;
    const pin = env ? pinFor(env.realm) : null;
    const v = verifyEnvelope(g.envelope, { pin, realm: env?.realm, sender: pin?.name, me: { name: g.scope.recipient?.lead, member: g.scope.recipient?.member }, now: env?.ts ?? now });
    if (!v?.ok) fail("grant_unverified", `the auto-land grant ${id} does not verify (${v?.reason ?? "not an owner-channel message"})`);
    if (v.env.kind !== "landing_grant" || v.env.text !== grantText(g.scope)) fail("grant_unverified", `the auto-land grant ${id} is not the signed grant it claims to be`);
    if (g.scope.recipient.lead !== s.lead) fail("grant_scope", `the auto-land grant ${id} was given for the lead ${g.scope.recipient.lead}, not ${s.lead}`);
  }
  if (g.scope.team !== team || canonicalize(g.scope.enrolment) !== canonicalize(s.enrolment)) fail("grant_scope", `the auto-land grant ${id} is for another team or repository`);
  if (phase === "resume") return g;
  const row = gs.grants[id] ?? newRow();
  if (row.status === "revoked" || g.scope.generation !== gs.generation) fail("grant_revoked", `the owner turned auto-land off (the grant ${id} is revoked)`);
  if (row.status === "retired" || g.scope.run !== s.run || s.status === "down") fail("grant_retired", `the auto-land grant ${id} was for an earlier run of team ${team}`);
  if (phase === "move") return g;
  if (row.status === "expired" || now >= g.scope.expires_at) fail("grant_expired", `the auto-land grant ${id} expired`);
  if (now + NOT_BEFORE_SKEW_MS < g.scope.not_before) fail("grant_not_yet", `the auto-land grant ${id} is not valid yet`);
  const held = action !== null && row.slots.includes(action);
  if (!held && g.scope.max_count !== null && row.slots.length >= g.scope.max_count) fail("grant_exhausted", `the auto-land grant ${id} has no landings left`);
  if (target !== null && !g.scope.targets.includes(target)) fail("grant_scope", `the auto-land grant ${id} does not cover ${target}`);
  return g;
}

/**
 * Reserve a slot of grant `id` for `action` in `gs` (idempotent: an action holds at most one slot,
 * and a retry keeps it); the last slot makes the grant exhausted. The caller writes `gs` before
 * the action is accepted, so a slot is a reservation: a run that stops before the acceptance keeps
 * it used (a resume of that action reuses it, after the checks of acceptance again).
 */
export function reserveSlot(gs, g, action) {
  const row = (gs.grants[g.scope.id] ??= newRow());
  if (!row.slots.includes(action)) row.slots.push(action);
  if (g.scope.max_count !== null && row.slots.length >= g.scope.max_count && row.status === "active") row.status = "exhausted";
}

/**
 * The grant that covers `target` for the team now (settled first), or null: the active one that
 * lasts longest. Returns {g, left (ms)}.
 */
export function coveringGrant(home, team, gs, s, { target, now, pinFor }) {
  let best = null;
  for (const id of grantIds(home, team)) {
    let g;
    try {
      g = readGrant(home, team, id);
      checkGrant(home, team, s, gs, { id, digest: g.digest, phase: "accept", target, now, pinFor });
    } catch {
      continue;
    }
    if (!best || g.scope.expires_at > best.g.scope.expires_at) best = { g, left: g.scope.expires_at - now };
  }
  return best;
}

/** Revoke every grant given so far, also ones not delivered yet: a new revocation generation. */
export function revoke(home, team, gs, s, now) {
  gs.generation += 1;
  settleGrants(home, team, gs, s, now);
}

// ---- notices ----------------------------------------------------------------------------------

const NOTICE_STATES = ["landed", "blocked", "rejected", "expired"];

function noticeProblem(n) {
  if (!same(n, ["digest", "id", "team", "target", "state", "left_s"])) return "keys";
  if (!/^[0-9a-f]{64}$/.test(String(n.digest)) || !/^L[1-9][0-9]{0,9}$/.test(String(n.id)) || typeof n.team !== "string" || n.team.length > 32 || !isBranch(n.target) || !NOTICE_STATES.includes(n.state)) return "fields";
  if (n.left_s !== null && (!Number.isSafeInteger(n.left_s) || n.left_s < 0 || n.left_s > GRANT_MAX_MS / 1000)) return "left_s";
  return null;
}

/**
 * An auto-landing's notice for the owner's Telegram (canonical JSON; the bridge words it):
 * {hoptell_owner_landing_notice: 1, digest (the action's), id, team, target, state, left_s (the
 * grant's time left, or null)}.
 */
export function noticeText(n) {
  if (noticeProblem(n)) fail("bad_notice", "the auto-land notice is malformed");
  return canonicalize({ hoptell_owner_landing_notice: 1, ...n });
}

/** The fields of a notice text (exactly canonical), or null. */
export function parseNotice(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlain(v) || v.hoptell_owner_landing_notice !== 1 || canonicalize(v) !== text) return null;
  const n = { ...v };
  delete n.hoptell_owner_landing_notice;
  return noticeProblem(n) ? null : n;
}

/** Queue a notice in `gs` (one per action and state); none is ever dropped unsent. */
export function queueNotice(gs, n) {
  if (noticeProblem(n)) fail("bad_notice", "the auto-land notice is malformed");
  if (gs.notices.some((x) => x.digest === n.digest && x.state === n.state)) return;
  if (gs.notices.length >= NOTICES_HARD) fail("notices_full", `${NOTICES_HARD} auto-land notices are pending; check the owner's Telegram`);
  gs.notices.push(n);
}

/** Parse a duration for --for: <n>m or <n>h, at most GRANT_MAX_MS. Returns ms or null. */
export function parseDuration(text) {
  const m = /^([1-9][0-9]{0,4})(m|h)$/.exec(String(text ?? ""));
  if (!m) return null;
  const ms = Number(m[1]) * (m[2] === "h" ? 60 * 60_000 : 60_000);
  return ms <= GRANT_MAX_MS ? ms : null;
}

/** A time left as the owner reads it: "1 h 20 min", "45 min", "under a minute". */
export function leftText(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
}
