// The landing action (design 8 addendum, "The landing action"): every landing is one action with
// an immutable id. Its manifest is create-only canonical JSON (JCS) in
// <home>/teams/<team>/landings/<id>/manifest.json, and its digest is the action's identity. The
// action's live state is kept in the team's state (lib/teams.js), written in the same transition
// as the landing journal; an action that ends leaves a create-only tombstone, final.json, next to
// its manifest. Tombstones are never removed by hoptell: team down and up keep them.
//
// Ids are short (L<n>), from one counter for the whole home, never reused or overwritten. An id
// found in two teams refuses.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalize } from "./jcs.js";
import { NAME_RE, ensurePrivateDir } from "./config.js";
import { readPrivateFile } from "./agents.js";
import { withLock, writeRecord } from "./locks.js";
import { MEMBER_ID_RE, parseEnvelope, verifyEnvelope } from "./ownersig.js";
import { REALM_ID_RE } from "./realm.js";

export const MANIFEST_VERSION = 1;
export const ACTION_TTL_MS = 15 * 60_000;
// ready → approved → accepted → moving → landed → finished; or blocked, rejected, expired, superseded.
export const ACTION_STATES = ["ready", "approved", "accepted", "moving", "landed", "finished", "blocked", "rejected", "expired", "superseded"];
// The routes a decision can come by: the terminal (L1), the bridge's receipt and a grant (L3).
export const ACTION_ROUTES = ["terminal", "bridge", "grant"];
export const ACTION_ID_RE = /^L[1-9][0-9]{0,9}$/;
// The states an action ends in: each leaves a tombstone. `abandoned`: the owner gave up an action
// whose outcome is unknown (hoptell team land --abandon); its decision is never usable again.
export const FINAL_STATES = ["finished", "blocked", "rejected", "expired", "superseded", "abandoned"];
const MANIFEST_MAX = 1024 * 1024;
const FINAL_MAX = 64 * 1024;
const LOCK_WAIT_MS = 15_000;

export class LandingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new LandingError(code, message);
};

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** The landings folder of a team, and an action's files. */
export function landingPaths(home, team, id = null) {
  const dir = path.join(home, "teams", team, "landings");
  if (id !== null && !ACTION_ID_RE.test(String(id))) fail("bad_action", `"${String(id).slice(0, 40)}" is not a landing id (L<n>)`);
  const one = id === null ? null : path.join(dir, id);
  return { dir, action: one, manifest: one && path.join(one, "manifest.json"), final: one && path.join(one, "final.json") };
}

/** The teams of the home that have an action `id` (its folder exists). */
function teamsWith(home, id) {
  let teams;
  try {
    teams = fs.readdirSync(path.join(home, "teams"), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return teams.filter((d) => d.isDirectory() && fs.existsSync(path.join(home, "teams", d.name, "landings", id))).map((d) => d.name);
}

/**
 * A new action id, L<n>: the home's counter (teams/landings.seq) moves forward under its own lock,
 * and an id whose folder exists in any team is skipped, so a lost counter never reuses one.
 */
export async function newActionId(home) {
  const root = ensurePrivateDir(path.join(home, "teams"));
  const seq = path.join(root, "landings.seq");
  return withLock(
    seq,
    async () => {
      const r = readPrivateFile(seq, 1024);
      let n = 0;
      if (!r.missing) {
        if (r.problem) fail("bad_state", `${seq} ${r.problem}`);
        let rec;
        try {
          rec = JSON.parse(r.bytes.toString("utf8"));
        } catch {
          fail("bad_state", `${seq} is not valid JSON`);
        }
        if (!Number.isSafeInteger(rec?.last) || rec.last < 0) fail("bad_state", `${seq} holds no landing counter`);
        n = rec.last;
      }
      let id;
      do id = `L${++n}`;
      while (teamsWith(home, id).length);
      writeRecord(seq, { last: n });
      return id;
    },
    { waitMs: LOCK_WAIT_MS },
  );
}

/** fsync a folder, so the entries made in it are durable (best effort where a platform refuses). */
export function syncDir(dir) {
  try {
    const d = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } catch {}
}

/** Write `bytes` to a new file only: refuses when it exists. Durable (fsync of file and folder). */
export function createOnly(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    const d = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(d);
    fs.closeSync(d);
  } catch {}
}

/**
 * Create the manifest of action `id` in `team`: {version, id, ...fields} as canonical JSON, in a
 * folder of its own that must not exist yet. Returns {id, digest, manifest}.
 */
export function createManifest(home, team, id, fields) {
  const manifest = { version: MANIFEST_VERSION, id, ...fields };
  const bytes = canonicalize(manifest);
  const p = landingPaths(home, team, id);
  ensurePrivateDir(p.dir);
  try {
    fs.mkdirSync(p.action, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST") fail("action_exists", `the landing ${id} already exists in team ${team}; hoptell never overwrites one`);
    throw e;
  }
  createOnly(p.manifest, bytes);
  // The new folders are made durable up to the team's folder before any state names the action.
  syncDir(p.dir);
  syncDir(path.dirname(p.dir));
  return { id, digest: sha256(bytes), manifest };
}

/** The manifest of action `id`, checked against its `digest` and its canonical form. */
export function readManifest(home, team, id, digest) {
  const p = landingPaths(home, team, id);
  const r = readPrivateFile(p.manifest, MANIFEST_MAX);
  if (r.missing) fail("action_missing", `the manifest of the landing ${id} (${p.manifest}) is missing`);
  if (r.problem) fail("action_changed", `${p.manifest} ${r.problem}`);
  if (sha256(r.bytes) !== digest) fail("action_changed", `the manifest of the landing ${id} changed since it was made; hoptell does not act on it`);
  let m;
  try {
    m = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    fail("action_changed", `${p.manifest} is not valid JSON`);
  }
  if (canonicalize(m) !== r.bytes.toString("utf8") || m.version !== MANIFEST_VERSION || m.id !== id) fail("action_changed", `${p.manifest} is not a landing manifest of version ${MANIFEST_VERSION}`);
  return m;
}

const FINAL_KEYS = ["version", "id", "digest", "member", "state", "route", "decision", "reason", "observed", "intent", "result", "at"];
// What the tombstone binds of the action and must match on every later read or write.
const BOUND = ["version", "id", "digest", "member", "state", "route", "decision"];
const isHex64 = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const isShortText = (x, max) => x === null || (typeof x === "string" && x.length <= max);
const isIntent = (x) =>
  x !== null &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).sort().join() === "C,H,T,mode,target" &&
  ["T", "H", "C"].every((k) => typeof x[k] === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x[k])) &&
  typeof x.target === "string" &&
  x.target.length <= 200 &&
  x.mode !== null &&
  typeof x.mode === "object" &&
  ["ref", "checkout"].includes(x.mode.kind);
// The cleanup's result of a finished landing (worktrees.js removeOpened), so a rerun reports it.
const isResult = (x) => x === null || (x !== null && typeof x === "object" && !Array.isArray(x) && JSON.stringify(x).length <= 4096);

/** What is wrong with a tombstone record (the first problem), or null. */
export function tombstoneProblem(t) {
  if (t === null || typeof t !== "object" || Array.isArray(t)) return "not an object";
  const keys = Object.keys(t);
  if (keys.length !== FINAL_KEYS.length || !FINAL_KEYS.every((k) => Object.hasOwn(t, k))) return "not the fields of a landing's final record";
  if (t.version !== MANIFEST_VERSION) return "version";
  if (!ACTION_ID_RE.test(String(t.id))) return "id";
  if (!isHex64(t.digest)) return "digest";
  if (typeof t.member !== "string" || !NAME_RE.test(t.member)) return "member";
  if (!FINAL_STATES.includes(t.state)) return "state";
  if (t.route !== null && !ACTION_ROUTES.includes(t.route)) return "route";
  if (t.decision !== null && !isHex64(t.decision)) return "decision";
  if (!isShortText(t.reason, 2000) || !isShortText(t.observed, 4000)) return "reason";
  if (!isIntent(t.intent)) return "intent";
  if (!isResult(t.result) || (t.result !== null && t.state !== "finished")) return "result";
  if (typeof t.at !== "string" || Number.isNaN(Date.parse(t.at))) return "at";
  return null;
}

/**
 * The tombstone of an action that ended (create-only, kept through team down): the action's
 * bound fields (version, id, digest, member, route, decision), the final state, why (`reason`),
 * what hoptell saw (`observed`, for an abandoned one), the original intent from the manifest
 * (target, T, H, C, mode), the cleanup's result of a finished landing, and when. A write that
 * finds a tombstone already there succeeds only when its bound fields and state are the same;
 * the first record's reason, observation, result and time are kept (the first write wins).
 */
export function writeTombstone(home, team, action, manifest, { state, reason = null, observed = null, result = null, at = new Date().toISOString() }) {
  const p = landingPaths(home, team, action.id);
  const intent = { target: manifest.target, T: manifest.T, H: manifest.H, C: manifest.C, mode: manifest.mode };
  const rec = { version: MANIFEST_VERSION, id: action.id, digest: action.digest, member: action.member, state, route: action.route, decision: action.decision, reason, observed, intent, result, at };
  const problem = tombstoneProblem(rec);
  if (problem) fail("bad_action", `the final record of the landing ${action.id} would be invalid (${problem})`);
  try {
    createOnly(p.final, `${JSON.stringify(rec, null, 2)}\n`);
    return rec;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const had = readTombstone(home, team, action.id);
  if (BOUND.some((k) => had[k] !== rec[k]) || canonicalize(had.intent) !== canonicalize(intent)) fail("action_changed", `the landing ${action.id} already ended as ${had.state}, with another record than this run's; hoptell does not record it again`);
  return had;
}

/** The tombstone of action `id` (checked against the schema), or null when it has none. */
export function readTombstone(home, team, id) {
  const p = landingPaths(home, team, id);
  const r = readPrivateFile(p.final, FINAL_MAX);
  if (r.missing) return null;
  if (r.problem) fail("action_changed", `${p.final} ${r.problem}`);
  let t;
  try {
    t = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    fail("action_changed", `${p.final} is not valid JSON`);
  }
  const problem = tombstoneProblem(t);
  if (problem) fail("action_changed", `${p.final} is not a valid final record of a landing (${problem}); hoptell changes nothing by it`);
  if (t.id !== id) fail("action_changed", `${p.final} is the final record of ${t.id}, not of ${id}; hoptell changes nothing by it`);
  return t;
}

/**
 * Whether tombstone `t` is the end of exactly the live `action` (all its bound fields) and its
 * `manifest` (read against the action's digest): the complete intent, target, T, H, C and mode.
 */
export function tombstoneOf(t, action, manifest) {
  const intent = { target: manifest.target, T: manifest.T, H: manifest.H, C: manifest.C, mode: manifest.mode };
  return BOUND.every((k) => k === "version" || k === "state" || t[k] === action[k]) && canonicalize(t.intent) === canonicalize(intent);
}

/**
 * The action folders of `team` that have neither a final record nor a live entry (`live`: the
 * ids in the team's state): orphans of a run that stopped right after the manifest was made.
 * Their ids stay used; nothing acts on them.
 */
export function orphanActions(home, team, live) {
  let names;
  try {
    names = fs.readdirSync(landingPaths(home, team).dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return names.filter((n) => ACTION_ID_RE.test(n) && !live.includes(n) && !fs.existsSync(landingPaths(home, team, n).final)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The team that has action `id`: refused when none or several have it. */
export function teamOfAction(home, id) {
  landingPaths(home, "x", id); // checks the id's form
  const teams = teamsWith(home, id);
  if (!teams.length) fail("no_action", `no landing ${id} in this hoptell home`);
  if (teams.length > 1) fail("ambiguous_action", `the landing ${id} exists in several teams (${teams.join(", ")}); hoptell acts on neither`);
  return teams[0];
}

// ---- evidence ----------------------------------------------------------------------------------
// The lead's test report for a candidate (hoptell team evidence) is copied into the team's folder,
// create-only and named by its digest, so the approval request freezes exactly the bytes that were
// recorded, not a file that changed afterwards.

export const REPORT_MAX = 64 * 1024;

/** The stored copy of a report: <home>/teams/<team>/evidence/<sha256>.txt. */
const evidencePath = (home, team, digest) => path.join(home, "teams", team, "evidence", `${digest}.txt`);

/** Store `bytes` (a report) by its digest; a copy already there must hold the same bytes. Returns the digest. */
export function storeEvidence(home, team, bytes) {
  const digest = sha256(bytes);
  const file = evidencePath(home, team, digest);
  ensurePrivateDir(path.dirname(file));
  try {
    createOnly(file, bytes);
    syncDir(path.dirname(path.dirname(file)));
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    readEvidence(home, team, digest);
  }
  return digest;
}

/** The stored report of `digest`, checked against it. */
export function readEvidence(home, team, digest) {
  if (!isHex64(digest)) fail("bad_evidence", "not a report digest");
  const file = evidencePath(home, team, digest);
  const r = readPrivateFile(file, REPORT_MAX);
  if (r.missing) fail("evidence_missing", `the stored test report ${file} is missing; record the evidence again (hoptell team evidence)`);
  if (r.problem) fail("evidence_changed", `${file} ${r.problem}`);
  if (sha256(r.bytes) !== digest) fail("evidence_changed", `the stored test report ${file} changed since it was recorded; record the evidence again (hoptell team evidence)`);
  return r.bytes;
}

/** A live action as the team state keeps it. */
export const ACTION_KEYS = ["id", "digest", "member", "state", "route", "decision", "reason", "created", "updated"];

// ---- approval through the owner's Telegram bridge (design 8 addendum, option 3) -----------------
// A landing request travels to the bridge as one message: {hoptell_owner_landing: 1, manifest}
// in canonical JSON, at most MANIFEST_FIT bytes of manifest, since the relay takes at most 100,000
// characters of text. The bridge trusts none of it: it checks the manifest's shape and every
// evidence digest itself, and computes the action's digest from the manifest's canonical bytes.
// Its decision comes back as a signed owner envelope of kind landing_decision (lib/ownersig.js)
// whose text is {hoptell_landing_decision: 1, id, digest, decision, decided_at, expires_at}; the
// lead's engine keeps those original bytes as the action's receipt.json, and hoptell team apply
// verifies them again before anything moves.

export const MANIFEST_FIT = 90_000;
export const DECISIONS = ["land", "reject"];
// How long after the owner's tap a land decision can still be applied (the lead runs hoptell team
// apply). The tap itself must come before the action expires; T, H, C and the mode are checked
// again at acceptance, so a late apply never lands a stale state.
export const APPLY_WINDOW_MS = 15 * 60_000;
// What the lead reports back to the card after apply (or after a terminal decision).
export const LANDING_OUTCOMES = ["landed", "blocked", "rejected", "expired"];
export const OUTCOME_TEXT_MAX = 500;
const RECEIPT_MAX = 16 * 1024;

const isPlain = (x) => x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const keysAre = (o, keys) => isPlain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isOid = (x) => typeof x === "string" && OID.test(x);
const isHex32 = (x) => typeof x === "string" && /^[0-9a-f]{32}$/.test(x);
const isIso = (x) => typeof x === "string" && x.length <= 40 && !Number.isNaN(Date.parse(x));
const isAbsPath = (x) => typeof x === "string" && x.length <= 4096 && path.isAbsolute(x) && !x.includes("\0");
const isStr = (x, max) => typeof x === "string" && x.length <= max;
const isName = (x) => typeof x === "string" && NAME_RE.test(x);
const isMs = (x) => Number.isSafeInteger(x) && x > 0;
const MANIFEST_KEYS = ["version", "id", "realm", "enrolment", "team", "run", "member", "target", "T", "H", "C", "parent", "mode", "cleanup", "recipient", "evidence", "created_at", "expires_at", "nonce"];

function modeProblem(m) {
  if (keysAre(m, ["kind"]) && m.kind === "ref") return null;
  if (keysAre(m, ["kind", "worktree", "gitDir"]) && m.kind === "checkout" && isAbsPath(m.worktree) && isAbsPath(m.gitDir)) return null;
  return "mode";
}

function evidenceProblem(e) {
  if (!keysAre(e, ["subject", "diffstat", "patch", "tests", "review"])) return "evidence";
  if (!isStr(e.subject, 4096)) return "subject";
  if (!keysAre(e.diffstat, ["text", "digest"]) || !isStr(e.diffstat.text, MANIFEST_FIT) || sha256(e.diffstat.text) !== e.diffstat.digest) return "diffstat";
  const p = e.patch;
  if (!keysAre(p, ["text", "encoding", "bytes", "digest", "oversize"]) || !isHex64(p.digest) || !Number.isSafeInteger(p.bytes) || p.bytes < 0 || typeof p.oversize !== "boolean") return "patch";
  if (p.oversize) {
    if (p.text !== null || p.encoding !== null) return "patch";
  } else {
    if (!isStr(p.text, MANIFEST_FIT) || !["utf8", "base64"].includes(p.encoding)) return "patch";
    const bytes = patchBytes(p);
    if (!bytes || bytes.length !== p.bytes || sha256(bytes) !== p.digest) return "patch digest";
  }
  const t = e.tests;
  if (!keysAre(t, ["result", "commands", "report", "digest", "at"]) || !["pass", "fail"].includes(t.result) || !isIso(t.at)) return "tests";
  if (!Array.isArray(t.commands) || !t.commands.length || t.commands.length > 16 || !t.commands.every((c) => isStr(c, 2000) && c.trim())) return "test commands";
  if (!isStr(t.report, REPORT_MAX) || sha256(Buffer.from(t.report, "utf8")) !== t.digest) return "test report digest";
  const r = e.review;
  if (!keysAre(r, ["id", "base", "head", "reviewers", "verdicts", "digest"]) || !/^rv-[0-9a-f]{8}$/.test(String(r.id)) || !isOid(r.base) || !isOid(r.head)) return "review";
  if (!Array.isArray(r.reviewers) || !r.reviewers.length || r.reviewers.length > 16 || !r.reviewers.every(isName)) return "reviewers";
  if (!Array.isArray(r.verdicts) || r.verdicts.length > 16 || !r.verdicts.every((v) => keysAre(v, ["reviewer", "verdict", "at"]) && isName(v.reviewer) && ["approve", "changes"].includes(v.verdict) && isIso(v.at))) return "verdicts";
  const review = { id: r.id, base: r.base, head: r.head, reviewers: r.reviewers, verdicts: r.verdicts };
  if (sha256(canonicalize(review)) !== r.digest) return "review digest";
  return null;
}

/** The bytes of a manifest's inline patch, or null (oversize, or not decodable as stated). */
export function patchBytes(p) {
  if (!p || p.oversize || typeof p.text !== "string") return null;
  if (p.encoding === "utf8") return Buffer.from(p.text, "utf8");
  if (p.encoding !== "base64" || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.text)) return null;
  const b = Buffer.from(p.text, "base64");
  return b.toString("base64") === p.text ? b : null;
}

/**
 * What is wrong with a manifest sent for the owner's approval (the first problem), or null: the
 * exact fields, an evidence manifest with a recipient in its own realm, and every evidence digest
 * recomputed from its bytes. The bridge runs it on every request; nothing in it is trusted.
 */
export function manifestProblem(m) {
  if (!keysAre(m, MANIFEST_KEYS)) return "not the fields of a landing manifest";
  if (m.version !== MANIFEST_VERSION) return "version";
  if (!ACTION_ID_RE.test(String(m.id))) return "id";
  if (typeof m.realm !== "string" || !REALM_ID_RE.test(m.realm)) return "realm";
  if (!keysAre(m.enrolment, ["common", "id", "generation"]) || !isAbsPath(m.enrolment.common) || !isHex32(m.enrolment.id) || !Number.isSafeInteger(m.enrolment.generation) || m.enrolment.generation < 1) return "enrolment";
  if (typeof m.team !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(m.team)) return "team";
  if (!isHex32(m.run)) return "run";
  if (!isName(m.member)) return "member";
  if (typeof m.target !== "string" || !/^[A-Za-z0-9][\w./-]{0,199}$/.test(m.target) || m.target.includes("..")) return "target";
  if (![m.T, m.H, m.C, m.parent].every(isOid)) return "commits";
  if (modeProblem(m.mode)) return "mode";
  const c = m.cleanup;
  if (!keysAre(c, ["worktree", "branch", "candidate"]) || !(c.worktree === null || isAbsPath(c.worktree)) || !(c.branch === null || isStr(c.branch, 255)) || !isStr(c.candidate, 255)) return "cleanup";
  const r = m.recipient;
  // `generation`: the team's auto-land revocation generation when the request was made (a lead
  // that takes auto-land grants names it; the bridge offers auto-land only then).
  const gen = Object.hasOwn(r ?? {}, "generation");
  if (!keysAre(r, gen ? ["realm", "member", "lead", "generation"] : ["realm", "member", "lead"]) || r.realm !== m.realm || typeof r.member !== "string" || !MEMBER_ID_RE.test(r.member) || !isName(r.lead) || (gen && (!Number.isSafeInteger(r.generation) || r.generation < 0))) return "recipient";
  const ep = evidenceProblem(m.evidence);
  if (ep) return ep;
  if (!isIso(m.created_at) || !isIso(m.expires_at) || Date.parse(m.expires_at) <= Date.parse(m.created_at)) return "times";
  if (!isHex32(m.nonce)) return "nonce";
  return null;
}

/** The message that asks the owner's bridge for a decision on `manifest` (canonical JSON). */
/** Why a request covered by an auto-land grant was not auto-landed (the bridge words each code). */
export const AUTO_CODES = ["tests_failed", "changes", "no_reviewers", "not_covered", "notices_full"];
const autoProblem = (a) => !isPlain(a) || !keysAre(a, ["why"]) || !Array.isArray(a.why) || !a.why.length || a.why.length > AUTO_CODES.length || !a.why.every((c) => AUTO_CODES.includes(c)) || new Set(a.why).size !== a.why.length;

/**
 * A landing request's text: {hoptell_owner_landing: 1, manifest} as canonical JSON, with `auto`
 * ({why: [codes]}) next to the manifest when an auto-land grant was active but did not decide it.
 */
export function landingRequest(manifest, auto = null) {
  if (auto !== null && autoProblem(auto)) fail("bad_request", "the auto-land note of this request is malformed");
  const text = canonicalize({ hoptell_owner_landing: 1, manifest, ...(auto ? { auto } : {}) });
  const problem = manifestProblem(manifest);
  if (problem) fail("bad_request", `this landing cannot be sent for approval (${problem})`);
  if (Buffer.byteLength(canonicalize(manifest)) > MANIFEST_FIT) fail("evidence_too_large", `the record of this landing is over ${MANIFEST_FIT} bytes`);
  return text;
}

/**
 * A message text read as a landing request: null when it does not claim to be one; {problem}
 * when it does but is malformed or not canonical; else {manifest, digest, bytes} with the digest
 * computed here from the manifest's canonical bytes.
 */
export function parseLandingRequest(text) {
  if (typeof text !== "string" || !text.startsWith("{") || !text.includes('"hoptell_owner_landing"')) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { problem: "not valid JSON" };
  }
  if (!isPlain(v) || !Object.hasOwn(v, "hoptell_owner_landing")) return null;
  if (!(keysAre(v, ["hoptell_owner_landing", "manifest"]) || keysAre(v, ["hoptell_owner_landing", "manifest", "auto"])) || v.hoptell_owner_landing !== 1) return { problem: "not a version-1 landing request" };
  if (Object.hasOwn(v, "auto") && autoProblem(v.auto)) return { problem: "malformed auto-land note" };
  let canon;
  try {
    canon = canonicalize(v);
  } catch {
    return { problem: "not canonical JSON" };
  }
  if (canon !== text) return { problem: "not in its canonical encoding" };
  const problem = manifestProblem(v.manifest);
  if (problem) return { problem: `malformed manifest: ${problem}` };
  const bytes = canonicalize(v.manifest);
  if (Buffer.byteLength(bytes) > MANIFEST_FIT) return { problem: "manifest too large" };
  return { manifest: v.manifest, digest: sha256(bytes), auto: v.auto?.why ?? null };
}

/** The text of a landing decision (canonical JSON); times in ms. */
export function decisionText({ id, digest, decision, decidedAt, expiresAt }) {
  const d = { hoptell_landing_decision: 1, id, digest, decision, decided_at: decidedAt, expires_at: expiresAt };
  if (decisionProblem(d)) fail("bad_decision", `not a landing decision (${decisionProblem(d)})`);
  return canonicalize(d);
}
function decisionProblem(d) {
  if (!keysAre(d, ["hoptell_landing_decision", "id", "digest", "decision", "decided_at", "expires_at"]) || d.hoptell_landing_decision !== 1) return "fields";
  if (!ACTION_ID_RE.test(String(d.id)) || !isHex64(d.digest) || !DECISIONS.includes(d.decision) || !isMs(d.decided_at) || !isMs(d.expires_at)) return "values";
  return null;
}
/** A landing decision's text parsed (canonical only), or null. */
export function parseDecision(text) {
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  let d;
  try {
    d = JSON.parse(text);
    if (decisionProblem(d) || canonicalize(d) !== text) return null;
  } catch {
    return null;
  }
  return d;
}

/** The lead's report of a landing's outcome to the bridge (canonical JSON). */
export function landingStatusText({ digest, state, text }) {
  const s = { hoptell_owner_landing_status: 1, digest, state, text: String(text).slice(0, OUTCOME_TEXT_MAX) };
  if (!isHex64(digest) || !LANDING_OUTCOMES.includes(state)) fail("bad_status", "not a landing outcome");
  return canonicalize(s);
}
/** A message text read as a landing outcome: null when it does not claim to be one, {problem}, or the outcome. */
export function parseLandingStatus(text) {
  if (typeof text !== "string" || !text.startsWith("{") || !text.includes('"hoptell_owner_landing_status"')) return null;
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return { problem: "not valid JSON" };
  }
  if (!isPlain(s) || !Object.hasOwn(s, "hoptell_owner_landing_status")) return null;
  if (!keysAre(s, ["hoptell_owner_landing_status", "digest", "state", "text"]) || s.hoptell_owner_landing_status !== 1 || !isHex64(s.digest) || !LANDING_OUTCOMES.includes(s.state) || !isStr(s.text, OUTCOME_TEXT_MAX)) return { problem: "malformed landing outcome" };
  try {
    if (canonicalize(s) !== text) return { problem: "not in its canonical encoding" };
  } catch {
    return { problem: "not canonical JSON" };
  }
  return { digest: s.digest, state: s.state, text: s.text };
}

// The bridge's owner-only relay status says it takes landing requests. The CLI reads it before it
// sends one: a UX gate only (an older bridge also refuses a request it does not know).
export const BRIDGE_STATUS = canonicalize({ hoptell_bridge: 1, caps: ["landing", "autoland"] });
/** Whether a session status (as the relay lists it) is a bridge's that takes landing requests. */
export function bridgeTakesLandings(status) {
  return bridgeCaps(status).includes("landing");
}
/** The capabilities a bridge's session status names (["landing", "autoland"], ...), or []. */
export function bridgeCaps(status) {
  if (typeof status !== "string" || status.length > 1024) return [];
  try {
    const v = JSON.parse(status);
    return isPlain(v) && v.hoptell_bridge === 1 && Array.isArray(v.caps) ? v.caps.filter((c) => typeof c === "string" && c.length <= 32) : [];
  } catch {
    return [];
  }
}

const receiptPath = (home, team, id) => path.join(landingPaths(home, team, id).action, "receipt.json");

/**
 * Keep the original bytes of a verified landing_decision envelope as the action's receipt,
 * create-only: "stored", "same" (those bytes were there already), or "conflict" (another
 * decision is kept; the first one wins and this one is not stored).
 */
export function storeReceipt(home, team, id, bytes) {
  const file = receiptPath(home, team, id);
  try {
    createOnly(file, bytes);
    return "stored";
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const had = readPrivateFile(file, RECEIPT_MAX);
  if (had.missing || had.problem) fail("receipt_changed", `${file} ${had.problem ?? "disappeared while it was read"}`);
  return had.bytes.equals(Buffer.from(bytes)) ? "same" : "conflict";
}

/** The receipt bytes of action `id` (a string), or null when it has none. */
export function readReceipt(home, team, id) {
  const file = receiptPath(home, team, id);
  const r = readPrivateFile(file, RECEIPT_MAX);
  if (r.missing) return null;
  if (r.problem) fail("receipt_changed", `${file} ${r.problem}`);
  return r.bytes.toString("utf8");
}

/**
 * A landing_decision the lead's engine has just verified (signature, pin, realm, the relay's
 * sender, the addressee, replay): kept as the receipt of the action it names when that action is
 * in this home, its manifest has exactly the decision's digest, and the manifest names this
 * session (`me`: {name, member}) as its recipient. The first decision registered for an action
 * wins: `lock(team, fn)` runs fn under the team's lock (teams.js), and `standing(team, id)` says,
 * under it, whether the action was already decided another way ({result: "conflict", by, kept}:
 * approved in a terminal) or ended ({result: "ended", state}); the receipt is then not written.
 * Returns {id, team, decision, result, kept (the decision kept: this one, or the earlier one on a
 * conflict), by, state} or {problem}; throws when the receipt cannot be written or read back, or
 * the lock is busy (the caller leaves the message with the relay).
 */
export async function ingestDecision(home, env, bytes, me, { lock = (team, fn) => fn(), standing = () => null } = {}) {
  const d = parseDecision(env?.text);
  if (!d) return { problem: "not a landing decision" };
  let team;
  let m;
  try {
    team = teamOfAction(home, d.id);
    m = readManifest(home, team, d.id, d.digest);
  } catch (e) {
    return { problem: e.message };
  }
  if (m.recipient?.lead !== me.name || m.recipient?.member !== me.member || m.realm !== env.realm) return { problem: `the landing ${d.id} was not requested for this session` };
  return lock(team, async () => {
    const st = standing(team, d.id);
    if (st) return { id: d.id, team, decision: d.decision, ...st };
    const result = storeReceipt(home, team, d.id, bytes);
    // A conflict: the decision kept first, which is the one hoptell team apply carries out.
    const kept = result === "conflict" ? (parseDecision(parseEnvelope(readReceipt(home, team, d.id))?.env?.text)?.decision ?? null) : d.decision;
    return { id: d.id, team, decision: d.decision, result, kept, by: "telegram" };
  });
}

/**
 * Verify an action's receipt again from its original bytes (hoptell team apply): an owner
 * envelope of kind landing_decision, signed with a key this home trusts now for the manifest's
 * realm (`pin`), from the pinned bridge name, to the manifest's recipient, for exactly this
 * action and digest; for "land", tapped before the action expired and applied within
 * APPLY_WINDOW_MS of the tap. The relay's sender was checked when the engine took it in; bytes
 * alone cannot show it. `window` false (an action already accepted under this decision, resumed):
 * no time checks. Returns the decision {decision, decided_at, expires_at, receipt (its sha256)}.
 */
export function checkReceipt(bytes, { pin, manifest, digest, now, window = true }) {
  // Resumed (no window): the envelope's own time stands for now, so its age never ends an accepted action.
  const at = window ? now : (parseEnvelope(bytes)?.env?.ts ?? now);
  const v = verifyEnvelope(bytes, { pin, realm: manifest.realm, sender: pin?.name, me: { name: manifest.recipient?.lead, member: manifest.recipient?.member }, now: at });
  if (!v) fail("bad_receipt", `the decision kept for ${manifest.id} is not an owner-channel message`);
  if (!v.ok) fail("bad_receipt", `the decision kept for ${manifest.id} does not verify (${v.reason})`);
  if (v.env.kind !== "landing_decision") fail("bad_receipt", `the decision kept for ${manifest.id} is not a landing decision`);
  const d = parseDecision(v.env.text);
  if (!d || d.id !== manifest.id || d.digest !== digest) fail("bad_receipt", `the decision kept for ${manifest.id} is for another landing`);
  if (d.expires_at !== Date.parse(manifest.expires_at)) fail("bad_receipt", `the decision kept for ${manifest.id} names another expiry than its landing`);
  if (d.decision === "land" && window) {
    if (d.decided_at > d.expires_at) fail("action_expired", `the owner's decision for ${manifest.id} came after it expired`);
    if (now > d.decided_at + APPLY_WINDOW_MS) fail("action_expired", `the owner's decision for ${manifest.id} is older than ${APPLY_WINDOW_MS / 60_000} minutes`);
  }
  return { decision: d.decision, decided_at: d.decided_at, expires_at: d.expires_at, receipt: sha256(bytes) };
}

// ---- auto-land reports (design 8 addendum, option 6) ----------------------------------------------
// The lead's engine answers each auto-land grant and each revocation the owner's bridge sent it:
// {hoptell_owner_autoland_status: 1, ref (the grant's or the revocation's id), state ("on" |
// "refused" for a grant, "off" for a revocation), why (a code, or null), team, targets, left_s,
// teams (for "off": the teams of that home whose auto-land is now off)}. The bridge words it;
// nothing of it is agent text.

export const AUTOLAND_WHY = ["stale", "no_team", "not_lead", "scope", "expired", "storage", "paused"];
const AUTOLAND_STATES = ["on", "refused", "off"];

function autolandStatusProblem(v) {
  if (!keysAre(v, ["hoptell_owner_autoland_status", "ref", "state", "why", "team", "targets", "left_s", "teams"]) || v.hoptell_owner_autoland_status !== 1) return "keys";
  if (typeof v.ref !== "string" || !AUTOLAND_STATES.includes(v.state) || !(v.state === "off" ? REVOKE_ID_RE : /^g_[a-z2-7]{16}$/).test(v.ref)) return "ref";
  if (!Array.isArray(v.teams) || v.teams.length > TEAMS_REPORTED || !v.teams.every((t) => typeof t === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(t)) || (v.state !== "off" && v.teams.length)) return "teams";
  if (v.why !== null && !AUTOLAND_WHY.includes(v.why)) return "why";
  if (v.team !== null && (typeof v.team !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(v.team))) return "team";
  if (!Array.isArray(v.targets) || v.targets.length > 16 || !v.targets.every((t) => typeof t === "string" && /^[A-Za-z0-9][\w./-]{0,199}$/.test(t))) return "targets";
  if (v.left_s !== null && (!Number.isSafeInteger(v.left_s) || v.left_s < 0 || v.left_s > 24 * 3600)) return "left_s";
  return null;
}

/** The text of an auto-land report (canonical JSON); `teams` is [] unless given. */
export function autolandStatusText(r) {
  const v = { hoptell_owner_autoland_status: 1, teams: [], ...r };
  if (autolandStatusProblem(v)) fail("bad_status", `not an auto-land report (${autolandStatusProblem(v)})`);
  return canonicalize(v);
}

/** A message text read as an auto-land report: null when it is none (or malformed, or not canonical). */
export function parseAutolandStatus(text) {
  if (typeof text !== "string" || !text.includes('"hoptell_owner_autoland_status"')) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlain(v) || autolandStatusProblem(v) || canonicalize(v) !== text) return null;
  const { ref, state, why, team, targets, left_s, teams } = v;
  return { ref, state, why, team, targets, left_s, teams };
}

// ---- auto-land revocations (design 8 addendum, option 6) ---------------------------------------
// /autoland off on the owner's Telegram: one signed landing_revoke envelope to each lead session
// the bridge has seen, whose text is {hoptell_landing_revoke: 1, id, issued_at}. The receiving
// engine makes a new revocation generation for every team of its home and reports "off".

export const REVOKE_ID_RE = /^v_[a-z2-7]{16}$/;
/** At most this many teams are named in an "off" report (the rest are turned off all the same). */
export const TEAMS_REPORTED = 64;

/** A new revocation id: v_ and 16 base32 characters. */
export function newRevokeId() {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  return `v_${[...crypto.randomBytes(16)].map((b) => a[b & 31]).join("")}`;
}

/** The text of a revocation (canonical JSON). */
export function revokeText({ id, issuedAt }) {
  if (!REVOKE_ID_RE.test(String(id)) || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) fail("bad_revoke", "the revocation is malformed");
  return canonicalize({ hoptell_landing_revoke: 1, id, issued_at: issuedAt });
}

/** A revocation's fields {id, issued_at} (exactly canonical), or null. */
export function parseRevoke(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!keysAre(v, ["hoptell_landing_revoke", "id", "issued_at"]) || v.hoptell_landing_revoke !== 1 || !REVOKE_ID_RE.test(String(v.id)) || !Number.isSafeInteger(v.issued_at) || v.issued_at <= 0 || canonicalize(v) !== text) return null;
  return { id: v.id, issued_at: v.issued_at };
}
