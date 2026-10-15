// The owner channel's signatures (design 7.2, "Setup, keys and pairing" and "Verification on the
// receiving side"): pins of a bridge key, the trusted pins of this home, the signed envelope of an
// answer, instruction or status, the agent's question envelope, deterministic nonces, and the
// replay store that tells a relay's redelivery from a redone or replayed send.
//
// A pin is "hoptell-owner-channel:1:<realm id>:<wire name>:<ed25519 public key, base64url>". A
// message gets the owner-channel label only when it verifies against a pin this home trusts; a
// session name, member id or role alone is never enough.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, REF_RE, ensurePrivateDir } from "./config.js";
import { writeDurable } from "./credentials.js";
import { ENCRYPTION_REQUIRED, ownPlaintextRefused } from "./contacts.js";
import { canonicalize } from "./jcs.js";
import { REALM_ID_RE } from "./realm.js";
import { checkPrivate } from "./wake.js";

const { O_RDONLY, O_NOFOLLOW } = fs.constants;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

export const PIN_PREFIX = "hoptell-owner-channel";
export const SIGN_DOMAIN = "hoptell-owner-channel/1\n";
export const MEMBER_ID_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
export const KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const B64U_RE = /^[A-Za-z0-9_-]*$/;
const PAIRING_ID_RE = /^p_[a-z2-7]{16}$/;
export const KINDS = ["answer", "instruction", "status"];
export const TEXT_MAX = 4000; // owner text is refused above 3500 at the bridge; status texts are short
export const QUESTION_MAX = 3000;
export const CHOICE_MAX = 40;
export const FUTURE_MS = 5 * 60_000;
export const PAST_MS = 8 * 86400_000;
export const SEEN_MARGIN_MS = 3600_000;
// A nonce is remembered for as long as an envelope carrying it can still verify: it was accepted
// with ts <= acceptance + FUTURE_MS, and verifies until ts + PAST_MS; plus a margin.
export const SEEN_KEEP_MS = PAST_MS + FUTURE_MS + SEEN_MARGIN_MS;
/** Until when a record accepted at `at` for a signed `ts` is kept. */
export const seenKeepUntil = (at, ts) => Math.max(at + SEEN_KEEP_MS, Number.isFinite(ts) ? ts + PAST_MS + SEEN_MARGIN_MS : 0);
export const SEEN_MAX = 10_000;
const MAX_KEYS = 2; // per realm: the current key and a staged next one
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** <home>/owner-channel and its files. */
export function channelPaths(home) {
  const dir = path.join(home, "owner-channel");
  return {
    dir,
    bridge: path.join(dir, "bridge.json"),
    trusted: path.join(dir, "trusted.json"),
    pairing: path.join(dir, "pairing.json"),
    state: path.join(dir, "state.json"),
    audit: path.join(dir, "audit.jsonl"),
    lock: path.join(dir, "run.lock"),
    seen: path.join(dir, "seen"),
  };
}
export const ensureChannelDir = (home) => ensurePrivateDir(channelPaths(ensurePrivateDir(home)).dir);

// ---- private files ----------------------------------------------------------------------------

/**
 * Read a private JSON file (lib/wake.js checks: no symlink, a regular file of ours, mode 0600, one
 * link, at most `max` bytes). null when it does not exist; throws when it is unsafe or malformed.
 */
export function readPrivateJson(file, max = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file} cannot be opened (${e.code || e.message})`);
  }
  try {
    checkPrivate(fs.fstatSync(fd), max, 1, `file ${file} (it must be a private regular file of this user, mode 0600)`);
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n > max) throw new Error(`${file} is too large`);
    try {
      return JSON.parse(buf.subarray(0, n).toString("utf8"));
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Replace a private JSON file atomically and durably (0600). */
export function writePrivateJson(file, value, { fault = null } = {}) {
  ensurePrivateDir(path.dirname(file));
  writeDurable(file, `${JSON.stringify(value)}\n`, { fault });
}

// ---- keys and pins ----------------------------------------------------------------------------

const b64u = (buf) => Buffer.from(buf).toString("base64url");
/** Decode base64url only in its canonical form (re-encoding gives the same text). */
function fromB64u(s, len) {
  if (typeof s !== "string" || !B64U_RE.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.length === len && b64u(buf) === s ? buf : null;
}

/** The key id of a public key (base64url raw key): 16 characters of its SHA-256, the same on every home. */
export const keyIdOf = (pub) => b64u(crypto.createHash("sha256").update(Buffer.from(pub, "base64url")).digest()).slice(0, 16);

/** A new signing key: {pub, priv} (raw keys, base64url; priv is the 32-byte seed). */
export function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  void publicKey;
  return { pub: jwk.x, priv: jwk.d };
}

const publicKeyOf = (pub) => crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" });
const privateKeyOf = ({ pub, priv }) => crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: pub, d: priv }, format: "jwk" });

/** Check a stored key pair: its seed must give its public key. Returns it, or throws. */
export function checkKey(k) {
  if (!fromB64u(k?.pub, 32) || !fromB64u(k?.priv, 32)) throw new Error("the owner-channel signing key is malformed");
  const derived = crypto.createPublicKey(privateKeyOf(k)).export({ format: "jwk" }).x;
  if (derived !== k.pub) throw new Error("the owner-channel signing key does not match its public key");
  return { pub: k.pub, priv: k.priv };
}

export const formatPin = ({ realm, name, pub }) => `${PIN_PREFIX}:1:${realm}:${name}:${pub}`;

/** Parse a pin: {realm, name, pub, keyId}; throws with a readable reason. */
export function parsePin(text) {
  const parts = String(text ?? "").trim().split(":");
  if (parts.length !== 5 || parts[0] !== PIN_PREFIX) throw new Error(`not an owner-channel pin: expected ${PIN_PREFIX}:1:<realm id>:<wire name>:<public key>`);
  if (parts[1] !== "1") throw new Error(`unsupported owner-channel pin version ${JSON.stringify(parts[1].slice(0, 8))}`);
  const [, , realm, name, pub] = parts;
  if (!REALM_ID_RE.test(realm)) throw new Error("the pin's realm id is not 32 lowercase hex characters");
  if (!NAME_RE.test(name)) throw new Error("the pin's bridge name is not a valid wire name");
  if (!fromB64u(pub, 32)) throw new Error("the pin's public key is not a 32-byte base64url Ed25519 key");
  return { realm, name, pub, keyId: keyIdOf(pub) };
}

/** A short fingerprint of a key for people: its key id. */
export const fingerprint = (pub) => keyIdOf(pub);

// ---- trusted pins (<home>/owner-channel/trusted.json) ---------------------------------------

function validTrusted(doc) {
  if (doc?.v !== 1 || !doc.realms || typeof doc.realms !== "object" || Array.isArray(doc.realms)) return false;
  for (const [realm, e] of Object.entries(doc.realms)) {
    if (!REALM_ID_RE.test(realm) || !NAME_RE.test(e?.name ?? "") || !Array.isArray(e.keys) || !e.keys.length || e.keys.length > MAX_KEYS) return false;
    if (!e.keys.every((k) => fromB64u(k?.pub, 32) && k.id === keyIdOf(k.pub))) return false;
  }
  return true;
}

/** The trusted pins of this home: {v: 1, realms: {<realm>: {name, keys: [{id, pub}]}}}. */
export function readTrusted(home) {
  const doc = readPrivateJson(channelPaths(home).trusted, 64 * 1024);
  if (doc === null) return { v: 1, realms: {} };
  if (!validTrusted(doc)) throw new Error(`${channelPaths(home).trusted} is malformed`);
  return doc;
}

/** The trusted entry for `realm` ({name, keys}), or null. A broken file trusts nothing. */
export function pinFor(home, realm) {
  try {
    return readTrusted(home).realms[realm] ?? null;
  } catch {
    return null;
  }
}

// ---- sends to the owner channel by name (design 7.3, 2.6; notes N3, N7) -------------------------

/** The result line after the relay's own outcome text, on a guarded send only. */
export const OWNER_SEND_NOTE = "Messages sent here may appear as notes in your owner's Telegram chat. They won't appear if your owner has hidden this session or you exceed the message limits. For a question that needs an answer, use ask_owner.";
const TEXT_ONLY = "your owner channel takes text only, sent to it by name; nothing was sent";
const NO_TO_MEMBER = "this relay cannot guarantee the recipient; upgrade it. Nothing was sent.";

/** The pinned bridge name for a connection's realm (`client.realm.id`), or null. */
export function ownerChannelNameFor(home, client) {
  const realm = client?.realm?.id;
  return realm ? (pinFor(home, realm)?.name ?? null) : null;
}

/** Whether `to` addresses the owner channel `bridge`: by name, or as a role of that name. */
export const addressesOwnerChannel = (to, bridge) => Boolean(bridge) && typeof to === "string" && (to === bridge || to === `@${bridge}`);

/**
 * The recipient guard, one check before any routing (policy plan, E2EE, files): null when `to`
 * is not this realm's pinned bridge name (nor `@` + it); otherwise {toMember} for a plaintext text
 * send by name that the relay delivers only while the caller's own member holds the name. Throws
 * (nothing is sent) for a file or a role, without the relay's to_member check, and when the own
 * member's encryption policy is "required" (as ask_owner), or when that policy cannot be read
 * (fail closed). `policy()` is read only then: {doc, problem} as contacts' currentPolicy() gives
 * it ({legacy: true} for a home without a managed policy).
 */
export function ownerSendGuard({ home, client, to, file = false, policy }) {
  const bridge = ownerChannelNameFor(home, client);
  if (!addressesOwnerChannel(to, bridge)) return null;
  if (file || to.startsWith("@")) throw new Error(TEXT_ONLY);
  const member = client.member?.id ?? null;
  if (!client.supportsToMember() || !member) throw new Error(NO_TO_MEMBER);
  ownerPolicyCheck({ policy, realm: client.realm.id, member });
  return { toMember: member };
}

/**
 * The encryption-policy check of every send to the owner channel (the send guard and ask_owner):
 * throws when the own member's policy is "required", and fails closed when that policy cannot be
 * read. `policy()` gives {doc, problem} as contacts' currentPolicy() does ({legacy: true} for a
 * home without a managed policy).
 */
export function ownerPolicyCheck({ policy, realm, member }) {
  // Fail closed: a throw, a reported problem, or a managed policy without a document refuses; only
  // an explicit legacy (unmanaged) home has no document.
  const unreadable = (why) => new Error(`the contacts cannot be read (${why || "unknown problem"}), so the encryption policy cannot be checked; nothing was sent`);
  let p;
  try {
    p = policy();
  } catch (e) {
    throw unreadable(e instanceof Error ? e.message : String(e ?? ""));
  }
  if (!p || typeof p !== "object") throw unreadable("no policy");
  const legacy = p.legacy === true;
  if (!legacy && (p.problem || !p.doc || typeof p.doc !== "object")) throw unreadable(p.problem ? String(p.problem) : "no policy document");
  if (ownPlaintextRefused(legacy ? null : p.doc, realm, member)) {
    throw new Error(`${ENCRYPTION_REQUIRED}: the owner channel sends plaintext through the relay, and your encryption policy for your own member requires end-to-end encryption; nothing was sent`);
  }
}

/** Arm a RelayClient's backstop (lib/client.js send): sends to the pinned bridge name need its own member. */
export function armOwnerBackstop(home, client) {
  client.ownerChannelName = () => ownerChannelNameFor(home, client);
  return client;
}

const writeTrusted = (home, doc) => {
  ensureChannelDir(home);
  writePrivateJson(channelPaths(home).trusted, doc);
};

/**
 * Trust a pin. Without `add`, it replaces the realm's entry (both keys); with `add`, the key joins
 * the current entry (same bridge name), staging a key rotation. Returns {realm, name, before: [key
 * ids], after: [key ids]}.
 */
export function trustPin(home, text, { add = false } = {}) {
  const pin = parsePin(text);
  const doc = readTrusted(home);
  const old = doc.realms[pin.realm] ?? null;
  const before = old ? old.keys.map((k) => k.id) : [];
  if (add) {
    if (!old) throw new Error("--add needs a pin already trusted for this realm; trust the current pin first");
    if (old.name !== pin.name) throw new Error(`the pin names the bridge ${pin.name}, but this realm trusts ${old.name}; replace it with trust '<pin>' instead`);
    if (old.keys.some((k) => k.id === pin.keyId)) return { realm: pin.realm, name: pin.name, before, after: before };
    if (old.keys.length >= MAX_KEYS) throw new Error(`this realm already trusts ${MAX_KEYS} keys; remove one with --remove-key <key id> first`);
    doc.realms[pin.realm] = { name: old.name, keys: [...old.keys, { id: pin.keyId, pub: pin.pub }] };
  } else {
    doc.realms[pin.realm] = { name: pin.name, keys: [{ id: pin.keyId, pub: pin.pub }] };
  }
  writeTrusted(home, doc);
  return { realm: pin.realm, name: pin.name, before, after: doc.realms[pin.realm].keys.map((k) => k.id) };
}

/**
 * Stop trusting one key id: in `realm` when given, else in the one realm that holds it (the same
 * key may be pinned for several realms; then the realm must be named). Removing a realm's last key
 * removes the realm.
 */
export function removeTrustedKey(home, keyId, { realm = null } = {}) {
  if (!KEY_ID_RE.test(keyId ?? "")) throw new Error("a key id is 16 base64url characters (see hoptell telegram status)");
  const doc = readTrusted(home);
  const holding = Object.keys(doc.realms).filter((r) => doc.realms[r].keys.some((k) => k.id === keyId));
  if (realm !== null && !holding.includes(realm)) throw new Error(`realm ${String(realm).slice(0, 40)} does not trust key ${keyId}`);
  if (!holding.length) throw new Error(`no trusted key ${keyId}`);
  if (realm === null && holding.length > 1) throw new Error(`key ${keyId} is trusted for more than one realm (${holding.join(", ")}); name one with --realm <realm id>`);
  const at = realm ?? holding[0];
  const e = doc.realms[at];
  const keys = e.keys.filter((k) => k.id !== keyId);
  if (keys.length) doc.realms[at] = { ...e, keys };
  else delete doc.realms[at];
  writeTrusted(home, doc);
  return { realm: at, left: keys.map((k) => k.id) };
}

/**
 * Stop trusting some of one channel's own keys: only in `realm`'s entry, and only when that entry
 * names the bridge `name` (the same key may be pinned in another realm, which stays). Removing the
 * entry's last key removes the entry. Returns the key ids removed.
 */
export function removeChannelKeys(home, realm, name, keyIds) {
  const doc = readTrusted(home);
  const e = doc.realms[realm];
  if (!e || e.name !== name) return [];
  const removed = e.keys.filter((k) => keyIds.includes(k.id)).map((k) => k.id);
  if (!removed.length) return [];
  const keys = e.keys.filter((k) => !keyIds.includes(k.id));
  if (keys.length) doc.realms[realm] = { ...e, keys };
  else delete doc.realms[realm];
  writeTrusted(home, doc);
  return removed;
}

/** Stop trusting the owner channel of a realm. */
export function revokeRealm(home, realm) {
  const doc = readTrusted(home);
  if (!doc.realms[realm]) throw new Error(`no owner channel is trusted for realm ${String(realm).slice(0, 40)}`);
  delete doc.realms[realm];
  writeTrusted(home, doc);
}

// ---- envelopes --------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const goodText = (s, max) => typeof s === "string" && s.length >= 1 && s.length <= max && !LONE_SURROGATE.test(s);
const ms = (n) => Number.isSafeInteger(n) && n > 0;

/** Why an owner envelope (a parsed object) is malformed, or null when its schema holds. */
function schemaProblem(e) {
  if (!isObj(e) || e.hoptell_owner !== 1) return "not a version-1 owner envelope";
  if (!KINDS.includes(e.kind)) return "unknown kind";
  const keys = ["hoptell_owner", "kind", "realm", "from", "to", "text", "pairing", "ts", "nonce", "key", "sig", ...(e.kind === "instruction" ? [] : ["q"])];
  if (!exactKeys(e, keys)) return "unexpected or missing fields";
  if (typeof e.realm !== "string" || !REALM_ID_RE.test(e.realm)) return "bad realm";
  if (typeof e.from !== "string" || !NAME_RE.test(e.from)) return "bad from";
  if (!exactKeys(e.to, ["name", "member"]) || typeof e.to.name !== "string" || !NAME_RE.test(e.to.name) || typeof e.to.member !== "string" || !MEMBER_ID_RE.test(e.to.member)) return "bad to";
  if (e.kind !== "instruction" && (typeof e.q !== "string" || !REF_RE.test(e.q))) return "bad q";
  if (!goodText(e.text, TEXT_MAX)) return "bad text";
  if (!exactKeys(e.pairing, ["id", "at"]) || typeof e.pairing.id !== "string" || !PAIRING_ID_RE.test(e.pairing.id) || !ms(e.pairing.at)) return "bad pairing";
  if (!ms(e.ts)) return "bad ts";
  if (!fromB64u(e.nonce, 32)) return "bad nonce";
  if (typeof e.key !== "string" || !KEY_ID_RE.test(e.key)) return "bad key id";
  if (!fromB64u(e.sig, 64)) return "bad signature encoding";
  return null;
}

/** The bytes a signature covers: the domain prefix and the JCS form of the envelope without sig. */
export function signedBytes(env) {
  const rest = { ...env };
  delete rest.sig;
  return Buffer.from(SIGN_DOMAIN + canonicalize(rest), "utf8");
}

/**
 * Build and sign an envelope. `fields`: {kind, realm, from, to: {name, member}, q?, text, pairing:
 * {id, at}, ts, nonce}; `key`: {pub, priv}. Returns the message text (its exact JCS encoding).
 */
export function signEnvelope(fields, key) {
  const env = { hoptell_owner: 1, kind: fields.kind, realm: fields.realm, from: fields.from, to: { name: fields.to.name, member: fields.to.member }, ...(fields.kind === "instruction" ? {} : { q: fields.q }), text: fields.text, pairing: { id: fields.pairing.id, at: fields.pairing.at }, ts: fields.ts, nonce: fields.nonce, key: keyIdOf(key.pub), sig: b64u(Buffer.alloc(64)) };
  const problem = schemaProblem(env);
  if (problem) throw new Error(`cannot sign an owner envelope: ${problem}`);
  env.sig = b64u(crypto.sign(null, signedBytes(env), privateKeyOf(key)));
  return canonicalize(env);
}

/**
 * Parse a message text as an owner envelope. Returns null when it does not claim to be one (not a
 * JSON object with "hoptell_owner"); {env} when the strict schema holds and the text is exactly
 * its canonical encoding; {reason} otherwise (it claims to be one but is malformed).
 */
export function parseEnvelope(text) {
  if (typeof text !== "string" || !text.startsWith("{") || !text.includes('"hoptell_owner"')) return null;
  let e;
  try {
    e = JSON.parse(text);
  } catch {
    return { reason: "not valid JSON" };
  }
  if (!isObj(e) || !Object.hasOwn(e, "hoptell_owner")) return null;
  const problem = schemaProblem(e);
  if (problem) return { reason: `malformed envelope: ${problem}` };
  let canon;
  try {
    canon = canonicalize(e);
  } catch {
    return { reason: "malformed envelope: not canonical JSON" };
  }
  // One envelope has exactly one encoding: duplicate keys, whitespace, other number forms and
  // other escapes all change the re-canonicalised text.
  if (canon !== text) return { reason: "malformed envelope: not in its canonical encoding" };
  return { env: e };
}

/**
 * Verify an owner envelope for this session (rules 1-5 of the design; rule 6, the replay store,
 * is checked by the caller with the nonce). `pin`: this home's trusted entry for the session's
 * realm ({name, keys}) or null; `realm`: the session's realm id; `sender`: the sender name the
 * relay reported; `me`: {name, member} of this session. Returns {ok: true, env} or {ok: false,
 * reason, env?}; a text that does not claim to be an envelope returns null.
 */
export function verifyEnvelope(text, { pin, realm, sender, me, now = Date.now() }) {
  const p = parseEnvelope(text);
  if (!p) return null;
  if (!p.env) return { ok: false, reason: p.reason };
  const e = p.env;
  const fail = (reason) => ({ ok: false, reason, env: e });
  if (!pin) return fail("this machine trusts no owner channel for this relay");
  if (e.realm !== realm) return fail("another relay realm");
  if (e.from !== pin.name || sender !== e.from) return fail("not sent by the trusted bridge name");
  if (!me?.member || e.to.name !== me.name || e.to.member !== me.member) return fail("not addressed to this session");
  const k = pin.keys.find((x) => x.id === e.key);
  if (!k) return fail("key not trusted");
  let good = false;
  try {
    good = crypto.verify(null, signedBytes(e), publicKeyOf(k.pub), Buffer.from(e.sig, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return fail("bad signature");
  if (e.ts > now + FUTURE_MS) return fail("dated in the future");
  if (e.ts < now - PAST_MS) return fail("too old");
  return { ok: true, env: e };
}

/**
 * A deterministic, domain-separated nonce: HMAC-SHA256(signing key, JCS([domain, bot id, ...]))
 * in base64url. The same event always gives the same nonce, so a redone send is recognisable.
 */
export function nonceOf(key, parts) {
  return b64u(crypto.createHmac("sha256", Buffer.from(key.priv, "base64url")).update(canonicalize(parts)).digest());
}

// ---- the question envelope (agent -> bridge) ---------------------------------------------------

/** The question text an agent sends to the bridge (canonical JSON). */
export function questionEnvelope({ question, choices = [], askedAt, expiresAt }) {
  const q = { hoptell_owner_question: 1, question, choices, asked_at: askedAt, expires_at: expiresAt };
  const problem = questionProblem(q);
  if (problem) throw new Error(problem);
  return canonicalize(q);
}

function questionProblem(q) {
  if (!exactKeys(q, ["hoptell_owner_question", "question", "choices", "asked_at", "expires_at"]) || q.hoptell_owner_question !== 1) return "not a version-1 owner question";
  if (!goodText(q.question, QUESTION_MAX) || !q.question.trim()) return `the question must be 1 to ${QUESTION_MAX} characters`;
  if (!Array.isArray(q.choices) || (q.choices.length !== 0 && (q.choices.length < 2 || q.choices.length > 6))) return "choices: 2 to 6 items, or none";
  if (!q.choices.every((c) => goodText(c, CHOICE_MAX) && c.trim())) return `each choice must be 1 to ${CHOICE_MAX} characters`;
  if (new Set(q.choices).size !== q.choices.length) return "choices must differ";
  if (!ms(q.asked_at) || !ms(q.expires_at) || q.expires_at <= q.asked_at) return "bad asked_at or expires_at";
  return null;
}

/** Parse a question envelope: {q} or null (not a well-formed, canonical question). */
export function parseQuestion(text) {
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  let q;
  try {
    q = JSON.parse(text);
  } catch {
    return null;
  }
  if (questionProblem(q)) return null;
  try {
    if (canonicalize(q) !== text) return null;
  } catch {
    return null;
  }
  return q;
}

// ---- the replay store (<home>/owner-channel/seen/) ----------------------------------------------

const seenFile = (home, realm, nonce) => path.join(channelPaths(home).seen, `${crypto.createHash("sha256").update(`${realm}\n${nonce}`).digest("hex")}.json`);
const SEEN_RE = /^[0-9a-f]{64}\.json$/;
const SEEN_TMP_RE = /^[0-9a-f]{64}\.json\.[0-9a-f]{12}\.tmp$/;
const SEEN_TMP_MS = 10 * 60_000; // a temporary file older than this belongs to no live write
const SEEN_RECORD_MAX = 4096;

/**
 * The replay store cannot answer: a record that is unsafe, unreadable or malformed, a write or
 * sync that failed, or a full store. Callers fail closed: the message is shown unverified with
 * `reason`, or the read waits.
 */
export class SeenStoreError extends Error {
  constructor(reason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

function syncDir(dir) {
  const d = fs.openSync(dir, O_RDONLY);
  try {
    fs.fsyncSync(d);
  } finally {
    fs.closeSync(d);
  }
}

/**
 * A record installed by recordSeen is briefly also linked from its temporary name (link, then
 * unlink), and stays so after a crash in between. Remove that second name when it is exactly our
 * temporary file of this record (same device and inode); any other extra link is unsafe.
 */
function dropInstallLink(file, st) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let removed = false;
  for (const n of fs.readdirSync(dir)) {
    if (!n.startsWith(`${base}.`) || !SEEN_TMP_RE.test(n)) continue;
    let t;
    try {
      t = fs.lstatSync(path.join(dir, n));
    } catch {
      continue;
    }
    if (t.isFile() && t.ino === st.ino && t.dev === st.dev) {
      fs.rmSync(path.join(dir, n), { force: true });
      removed = true;
    }
  }
  if (removed) syncDir(dir);
}

/** Whether `rec` is a complete replay record (of {realm, nonce} when given). */
function validSeen(rec, realm = null, nonce = null) {
  return (
    rec !== null &&
    typeof rec === "object" &&
    !Array.isArray(rec) &&
    rec.v === 1 &&
    typeof rec.realm === "string" &&
    REALM_ID_RE.test(rec.realm) &&
    typeof rec.nonce === "string" &&
    rec.nonce.length > 0 &&
    (realm === null || rec.realm === realm) &&
    (nonce === null || rec.nonce === nonce) &&
    (rec.ref === null || typeof rec.ref === "string") &&
    typeof rec.result === "string" &&
    Number.isFinite(rec.at) &&
    (rec.ts === undefined || rec.ts === null || Number.isFinite(rec.ts)) &&
    (rec.keep_until === undefined || Number.isFinite(rec.keep_until))
  );
}

/**
 * The seen record of {realm, nonce}: {v, realm, nonce, ref, result, at}, or null when there is
 * none (ENOENT only). Throws SeenStoreError when a file is there but cannot be trusted.
 */
export function lookupSeen(home, realm, nonce) {
  const file = seenFile(home, realm, nonce);
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new SeenStoreError("replay store unreadable", e.code ?? e.message);
  }
  try {
    let st = fs.fstatSync(fd);
    if (st.isFile() && st.nlink === 2) {
      dropInstallLink(file, st);
      st = fs.fstatSync(fd);
    }
    try {
      checkPrivate(st, SEEN_RECORD_MAX, 1, "replay record");
    } catch {
      throw new SeenStoreError("replay store unreadable", "unsafe record");
    }
    const buf = Buffer.alloc(SEEN_RECORD_MAX + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    let rec;
    try {
      rec = JSON.parse(buf.subarray(0, n).toString("utf8"));
    } catch {
      throw new SeenStoreError("replay store unreadable", "malformed record");
    }
    if (!validSeen(rec, realm, nonce)) throw new SeenStoreError("replay store unreadable", "malformed record");
    return rec;
  } catch (e) {
    if (e instanceof SeenStoreError) throw e;
    throw new SeenStoreError("replay store unreadable", e.code ?? e.message);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Record that {realm, nonce} was received under message reference `ref`. The first record wins:
 * it is written to a private temporary file, synced, hard-linked into place (never replacing),
 * the temporary name removed and the directory synced. Returns the record read back from disk;
 * throws (SeenStoreError or the I/O error) when it cannot be made durable. `fault(point)`: tests.
 */
export function recordSeen(home, { realm, nonce, ref, result, ts = null, now = Date.now(), fault = null }) {
  ensureChannelDir(home);
  const dir = ensurePrivateDir(channelPaths(home).seen);
  const file = seenFile(home, realm, nonce);
  const existing = lookupSeen(home, realm, nonce);
  if (existing) return existing;
  const rec = { v: 1, realm, nonce, ref, result, at: now, ts: Number.isFinite(ts) ? ts : null, keep_until: seenKeepUntil(now, ts) };
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(rec));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fault?.("written");
    try {
      fs.linkSync(tmp, file); // never replaces: a concurrent first record wins
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    fault?.("linked");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fault?.("unlinked");
  syncDir(dir); // durability failures propagate
  const r = lookupSeen(home, realm, nonce);
  if (!r) throw new SeenStoreError("replay store unreadable", "the record is missing after it was written");
  return r;
}

/**
 * Complete the replay store from a session store's message files (design 7.2: the message file,
 * which holds the nonce, is the source of truth; its record is written after it). Every consumer
 * runs this before it takes or acknowledges messages. A record that is there but unreadable is
 * left as it is (lookups of that nonce fail closed); a record that cannot be written throws.
 */
export async function completeSeen(home, pipe) {
  for (const r of await pipe.ownerNonces()) {
    let present;
    try {
      present = lookupSeen(home, r.realm, r.nonce);
    } catch (e) {
      if (e instanceof SeenStoreError) continue;
      throw e;
    }
    if (!present) recordSeen(home, { realm: r.realm, nonce: r.nonce, ref: r.ref, result: "verified", ts: r.ts ?? null });
  }
}

/**
 * Until when the record in `file` must be kept, or null when it cannot be fully validated (then it
 * is never pruned). A recorded keep_until never shortens the safe bound computed from the record's
 * own fields (acceptance time, signed ts) nor the bound from the file's own modification time.
 */
function seenExpiry(file) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = fs.fstatSync(fd);
    checkPrivate(st, SEEN_RECORD_MAX, 1, "replay record");
    const rec = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!validSeen(rec)) return null;
    // The file must be the record of the {realm, nonce} it names.
    if (path.basename(file) !== path.basename(seenFile("", rec.realm, rec.nonce))) return null;
    return Math.max(seenKeepUntil(rec.at, rec.ts), Number.isFinite(rec.keep_until) ? rec.keep_until : 0, st.mtimeMs + SEEN_KEEP_MS);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Forget seen records whose keep-until time has passed (as recorded in each record, not by the
 * file's mtime), and temporary files no live write uses. A record that cannot be read is kept.
 * A record is never removed while an envelope with its nonce could still verify: see seenFull.
 */
export function pruneSeen(home, now = Date.now()) {
  const dir = channelPaths(home).seen;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of names) {
    const file = path.join(dir, f);
    let expired = false;
    if (SEEN_RE.test(f)) {
      const until = seenExpiry(file);
      expired = until !== null && now > until;
    } else if (SEEN_TMP_RE.test(f)) {
      try {
        expired = now - fs.lstatSync(file).mtimeMs > SEEN_TMP_MS;
      } catch {}
    }
    if (expired) {
      fs.rmSync(file, { force: true });
      n++;
    }
  }
  return n;
}

const countSeen = (home) => {
  try {
    return fs.readdirSync(channelPaths(home).seen).filter((f) => SEEN_RE.test(f)).length;
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw new SeenStoreError("replay store unreadable", e.code ?? e.message);
  }
};

/**
 * Whether the store has room for a new record. Expired records are pruned first; when `max`
 * records inside the replay window remain, it is full and a new owner label fails closed
 * ("replay store full") rather than forget a nonce that could be replayed.
 */
export function seenFull(home, now = Date.now(), max = SEEN_MAX) {
  if (countSeen(home) < max) return false;
  pruneSeen(home, now);
  return countSeen(home) >= max;
}

// ---- receive-side counts (doctor) ----------------------------------------------------------------

const receivedFile = (home) => path.join(channelPaths(home).dir, "received.json");

/** Count an owner envelope that failed verification ("failed", with its reason) or was suppressed as a replay. */
export function countReceived(home, what, reason = null) {
  try {
    ensureChannelDir(home);
    let c = null;
    try {
      c = readPrivateJson(receivedFile(home), 64 * 1024);
    } catch {}
    if (c?.v !== 1) c = { v: 1, failed: 0, suppressed: 0, reasons: {} };
    c[what] = (c[what] ?? 0) + 1;
    if (reason) c.reasons[reason] = (c.reasons[reason] ?? 0) + 1;
    c.at = Date.now();
    writePrivateJson(receivedFile(home), c);
  } catch {
    // a count never stops a delivery
  }
}

/** The receive-side counts: {failed, suppressed, reasons} (zeros when none). */
export function readReceived(home) {
  try {
    const c = readPrivateJson(receivedFile(home), 64 * 1024);
    if (c?.v === 1) return c;
  } catch {}
  return { v: 1, failed: 0, suppressed: 0, reasons: {} };
}
