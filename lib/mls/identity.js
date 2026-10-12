// Device identities (design 3.2, "Identities", "Fingerprints and safety numbers", "Planned
// rotation"), hoptell's own layer: nothing here depends on an MLS library. EXPERIMENTAL: nothing
// ships before a qualified binding manifest and the 3.5 review.
//
// Every hashed or signed structure is a canonical encoding: each field preceded by its length as
// a 4-byte unsigned big-endian integer, the first field the domain. Text fields (realm id, member
// id, device id) are the UTF-8 bytes of their protocol strings; keys are their raw bytes. Pins
// store and compare the 32-byte pin identity; display strings are for people only and lossy.
//
// The display format (12 groups of 5 digits from 60 bytes of SHA-512, each 5-byte chunk modulo
// 100,000) follows Signal's construction, but the numbers are hoptell's own: they are not
// interoperable with Signal safety numbers (implementation note 4).
import crypto from "node:crypto";

export const PIN_DOMAIN = "hoptell-device-fp-v1";
export const DISPLAY_DOMAIN = "hoptell-device-fp-display-v1";
export const SAFETY_DOMAIN = "hoptell-safety-v1";
export const ROTATE_LABEL = "hoptell-rotate-v1";
export const REVOKE_LABEL = "hoptell-revoke-v1";
// Per-session device proofs (amendments 3.5 part 2, A9): attaching a connection to a device, and
// registering a key (a first registration, a rotation, a same-key retry).
export const ATTACH_LABEL = "hoptell-attach-v1";
export const REGISTER_LABEL = "hoptell-register-v1";
// A new device's approval by an existing device of the member (amendments 3.5 part 3, A12).
export const APPROVE_LABEL = "hoptell-device-approve-v1";
/** A12: an approval is valid for at most 24 hours from its issuedAt, which may be 5 minutes ahead of the relay. */
export const APPROVAL_MAX_S = 86_400;
export const APPROVAL_SKEW_S = 300;
export const CREDENTIAL_PREFIX = "hoptell-device-v1";

/** A device id: 16 random bytes in base32 (RFC 4648 alphabet, lowercase, no padding): 26 characters. */
export const DEVICE_ID_RE = /^[a-z2-7]{25}[aeimquy4]$/;
export const REALM_ID_RE = /^[0-9a-f]{32}$/;
export const MEMBER_ID_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
/** The longest rotation chain a peer validates from its pinned key; a longer gap is a key change. */
export const MAX_ROTATION_CHAIN = 10;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A new device id (created with the device's key). */
export const newDeviceId = () => base32(crypto.randomBytes(16));

const asBytes = (x) => (typeof x === "string" ? Buffer.from(x, "utf8") : Buffer.from(x));

/** The canonical encoding: each field as a 4-byte big-endian length, then its bytes. */
export function encodeFields(...fields) {
  const parts = [];
  for (const f of fields) {
    const b = asBytes(f);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    parts.push(len, b);
  }
  return Buffer.concat(parts);
}

const u64 = (n) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("a sequence must be a whole number");
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

function checkTuple({ realm, member, device, key }) {
  if (typeof realm !== "string" || !REALM_ID_RE.test(realm)) throw new Error("realm must be a realm id (32 hex digits)");
  if (typeof member !== "string" || !MEMBER_ID_RE.test(member)) throw new Error("member must be a member id");
  if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) throw new Error("device must be a device id (26 base32 characters)");
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("key must be a 32-byte Ed25519 public key");
}

/** The credential identity of a device (an MLS BasicCredential identity). */
export function credentialIdentity({ realm, member, device }) {
  checkTuple({ realm, member, device, key: new Uint8Array(32) });
  return Buffer.from(`${CREDENTIAL_PREFIX}|${realm}|${member}|${device}`, "utf8");
}

/** Parse a credential identity; null when it is not one of ours. */
export function parseCredentialIdentity(bytes) {
  const parts = Buffer.from(bytes).toString("utf8").split("|");
  if (parts.length !== 4 || parts[0] !== CREDENTIAL_PREFIX) return null;
  const [, realm, member, device] = parts;
  try {
    checkTuple({ realm, member, device, key: new Uint8Array(32) });
  } catch {
    return null;
  }
  return { realm, member, device };
}

/** The pin identity: SHA-256 over the canonical tuple (32 bytes). Pins compare these bytes. */
export function pinIdentity(t) {
  checkTuple(t);
  return crypto.createHash("sha256").update(encodeFields(PIN_DOMAIN, t.realm, t.member, t.device, t.key)).digest();
}

/** 60 bytes of SHA-512 as 12 groups of 5 digits (each 5-byte chunk modulo 100,000). */
export function displayDigits(hash) {
  const groups = [];
  for (let i = 0; i < 12; i++) groups.push(String(hash.readUIntBE(i * 5, 5) % 100_000).padStart(5, "0"));
  return groups.join(" ");
}

/** The display fingerprint of a device, for people (lossy; never compared by code). */
export function displayFingerprint(t) {
  checkTuple(t);
  return displayDigits(crypto.createHash("sha512").update(encodeFields(DISPLAY_DOMAIN, t.realm, t.member, t.device, t.key)).digest());
}

/** One member's device list: the count, then the 32-byte pin identities sorted bytewise. */
function encodeList(pins) {
  const sorted = pins.map((p) => Buffer.from(p)).sort(Buffer.compare);
  for (const p of sorted) if (p.length !== 32) throw new Error("a pin identity has 32 bytes");
  const count = Buffer.alloc(4);
  count.writeUInt32BE(sorted.length);
  return Buffer.concat([count, ...sorted]);
}

/**
 * The safety number of a pair of members in a realm: each member's device pin identities (in any
 * order), the two lists ordered by member id (bytewise), hashed under hoptell-safety-v1 and shown
 * as 12 groups of 5 digits. It changes when either side adds, removes or replaces a device.
 */
export function safetyNumber(realm, a, b) {
  if (typeof realm !== "string" || !REALM_ID_RE.test(realm)) throw new Error("realm must be a realm id");
  for (const s of [a, b]) if (typeof s?.member !== "string" || !MEMBER_ID_RE.test(s.member) || !Array.isArray(s.pins)) throw new Error("each side is {member, pins}");
  if (a.member === b.member) throw new Error("a safety number is between two members");
  const [lo, hi] = Buffer.compare(Buffer.from(a.member), Buffer.from(b.member)) < 0 ? [a, b] : [b, a];
  const encoded = encodeFields(SAFETY_DOMAIN, realm, lo.member, encodeList(lo.pins), hi.member, encodeList(hi.pins));
  return displayDigits(crypto.createHash("sha512").update(encoded).digest());
}

// ---- signatures ---------------------------------------------------------------------------------

// Statements are signed with the device's MLS signature key the way MLS signs (RFC 9420 section
// 5.1.2, SignWithLabel): the signed bytes are SignContent {label "MLS 1.0 " + label, content},
// with variable-length vector headers. Our labels are not MLS's own, so a statement can never be
// taken for an MLS signature, nor the reverse. Verification is Ed25519 (the suite's scheme), here.
function varint(n) {
  if (n < 1 << 6) return Buffer.from([n]);
  if (n < 1 << 14) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  if (n < 1 << 30) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE((n | 0x80000000) >>> 0); // >>> 0: `|` gives a negative 32-bit number here
    return b;
  }
  throw new Error("too long to sign");
}
/** The bytes an MLS SignWithLabel(label, content) signs. */
export function signContent(label, content) {
  const l = Buffer.from(`MLS 1.0 ${label}`, "utf8");
  const c = Buffer.from(content);
  return Buffer.concat([varint(l.length), l, varint(c.length), c]);
}
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
/** Verify an Ed25519 SignWithLabel signature by a raw 32-byte public key. */
export function verifyWithLabel(publicKey, label, content, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(publicKey)]), format: "der", type: "spki" });
    return crypto.verify(null, signContent(label, content), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s, n) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return n === undefined || b.length === n ? b : null;
};
export { b64, unb64 };

/** The canonical bytes of a rotation statement. */
export const rotationContent = (s) => encodeFields(ROTATE_LABEL, s.realm, s.member, s.device, s.oldKey, s.newKey, u64(s.sequence));

/**
 * A planned rotation (design 3.2, "Planned rotation"): {realm, member, device, oldKey, newKey,
 * sequence} signed by the old key and by the new key (possession). `signOld` and `signNew` are
 * the devices' SignWithLabel functions (label, content) -> signature. Returns the wire form.
 */
export async function makeRotation({ realm, member, device, oldKey, newKey, sequence }, signOld, signNew) {
  checkTuple({ realm, member, device, key: oldKey });
  checkTuple({ realm, member, device, key: newKey });
  const content = rotationContent({ realm, member, device, oldKey, newKey, sequence });
  return { realm, member, device, old_key: b64(oldKey), new_key: b64(newKey), sequence, sig_old: b64(await signOld(ROTATE_LABEL, content)), sig_new: b64(await signNew(ROTATE_LABEL, content)) };
}

/** Decode and verify one rotation statement's own signatures; null when it is malformed or forged. */
export function readRotation(w) {
  if (!w || typeof w !== "object") return null;
  const oldKey = unb64(w.old_key, 32);
  const newKey = unb64(w.new_key, 32);
  const sigOld = unb64(w.sig_old, 64);
  const sigNew = unb64(w.sig_new, 64);
  if (!oldKey || !newKey || !sigOld || !sigNew || !Number.isSafeInteger(w.sequence) || w.sequence < 1 || oldKey.equals(newKey)) return null;
  try {
    checkTuple({ realm: w.realm, member: w.member, device: w.device, key: oldKey });
  } catch {
    return null;
  }
  const s = { realm: w.realm, member: w.member, device: w.device, oldKey, newKey, sequence: w.sequence };
  const content = rotationContent(s);
  if (!verifyWithLabel(oldKey, ROTATE_LABEL, content, sigOld) || !verifyWithLabel(newKey, ROTATE_LABEL, content, sigNew)) return null;
  return s;
}

/**
 * Follow rotation statements from a pinned key: {realm, member, device, key, sequence, retired}
 * (retired: keys this device had before, as hex). Statements are applied in sequence order; each
 * must chain (sequence = current + 1, old key = current key), be signed by both keys and not move
 * to a retired key. Returns {ok: true, key, sequence, retired} for the end of a valid chain of at
 * most MAX_ROTATION_CHAIN statements, {ok: true, unchanged: true} when nothing newer chains and
 * the served key is the pinned one, else {ok: false, reason}: a key change (stop).
 */
export function followRotations(pinned, statements, servedKey) {
  const served = Buffer.from(servedKey);
  let key = Buffer.from(pinned.key);
  let sequence = pinned.sequence ?? 0;
  const retired = new Set(pinned.retired ?? []);
  if (served.equals(key)) return { ok: true, unchanged: true, key, sequence, retired: [...retired] };
  const valid = [];
  for (const w of statements ?? []) {
    const s = readRotation(w);
    if (!s || s.realm !== pinned.realm || s.member !== pinned.member || s.device !== pinned.device) continue;
    if (s.sequence <= sequence) continue; // old authority: never replayed
    valid.push(s);
  }
  valid.sort((a, b) => a.sequence - b.sequence);
  let steps = 0;
  for (const s of valid) {
    if (s.sequence !== sequence + 1 || !s.oldKey.equals(key)) break; // a gap: nothing past it chains
    if (retired.has(s.newKey.toString("hex"))) return { ok: false, reason: "a rotation back to a retired key" };
    if (++steps > MAX_ROTATION_CHAIN) return { ok: false, reason: `more than ${MAX_ROTATION_CHAIN} rotations since the pinned key` };
    retired.add(key.toString("hex"));
    key = s.newKey;
    sequence = s.sequence;
    if (key.equals(served)) return { ok: true, key, sequence, retired: [...retired] };
  }
  return { ok: false, reason: "a new key without a valid rotation from the pinned key" };
}

/** The canonical bytes of a device revocation signed by another device of the member. */
export const revocationContent = (r) => encodeFields(REVOKE_LABEL, r.realm, r.member, r.device, r.by, u64(r.at));

/** A revocation statement by device `by` of the same member (or by the device itself). */
export async function makeRevocation({ realm, member, device, by, at }, sign) {
  const content = revocationContent({ realm, member, device, by, at });
  return { realm, member, device, by, at, sig: b64(await sign(REVOKE_LABEL, content)) };
}

/** Whether a revocation statement is signed by `byKey` (the revoking device's key). */
export function checkRevocation(w, byKey) {
  const sig = unb64(w?.sig, 64);
  if (!sig || !Number.isSafeInteger(w.at) || w.at < 0) return false;
  try {
    checkTuple({ realm: w.realm, member: w.member, device: w.device, key: new Uint8Array(32) });
    checkTuple({ realm: w.realm, member: w.member, device: w.by, key: new Uint8Array(32) });
  } catch {
    return false;
  }
  return verifyWithLabel(byKey, REVOKE_LABEL, revocationContent(w), sig);
}

// ---- a new device's approval (amendments 3.5 part 3, A12) ----------------------------------------

/**
 * The canonical bytes of an approval: the label as the domain, then (realm, member, approver
 * device id, new device id, new device's signature key, issuedAt, expiry), times in whole seconds.
 * The relay and the client encode with this one function.
 */
export const approvalContent = (a) => encodeFields(APPROVE_LABEL, a.realm, a.member, a.approver, a.device, a.key, u64(a.issuedAt), u64(a.expiry));

/**
 * An approval by device `approver` of `member` for new device `device` with signature key `key`
 * (32 bytes), issued at `issuedAt` and valid until `expiry` (whole seconds). `sign` is the
 * approver's SignWithLabel (label, content). Returns the wire form.
 */
export async function makeApproval({ realm, member, approver, device, key, issuedAt, expiry }, sign) {
  checkTuple({ realm, member, device: approver, key: new Uint8Array(32) });
  checkTuple({ realm, member, device, key });
  const content = approvalContent({ realm, member, approver, device, key, issuedAt, expiry });
  return { realm, member, approver, device, key: b64(key), issued_at: issuedAt, expiry, sig: b64(await sign(APPROVE_LABEL, content)) };
}

/**
 * Decode an approval's wire form; its signature is checked by the caller against the approver's
 * registered key (checkApproval). {realm, member, approver, device, key, issuedAt, expiry, sig},
 * or null when malformed.
 */
export function readApproval(w) {
  if (!w || typeof w !== "object" || Array.isArray(w)) return null;
  const key = unb64(w.key, 32);
  const sig = unb64(w.sig, 64);
  if (!key || !sig || !Number.isSafeInteger(w.issued_at) || !Number.isSafeInteger(w.expiry) || w.issued_at < 0 || w.expiry < 0) return null;
  try {
    checkTuple({ realm: w.realm, member: w.member, device: w.approver, key: new Uint8Array(32) });
    checkTuple({ realm: w.realm, member: w.member, device: w.device, key });
  } catch {
    return null;
  }
  return { realm: w.realm, member: w.member, approver: w.approver, device: w.device, key, issuedAt: w.issued_at, expiry: w.expiry, sig };
}

/** Whether a decoded approval (readApproval) is signed by `approverKey`. */
export const checkApproval = (a, approverKey) => verifyWithLabel(approverKey, APPROVE_LABEL, approvalContent(a), a.sig);

// ---- per-session device proofs (amendments 3.5 part 2, A9) ---------------------------------------

/** The two proof purposes and their SignWithLabel labels. */
export const PROOF_LABELS = { attach: ATTACH_LABEL, register: REGISTER_LABEL };

/**
 * The canonical bytes a device signs to prove its key on one connection: purpose ("attach" or
 * "register"), realm id, member id, device id, for "register" the 32-byte key being registered,
 * then the connection id and the challenge (both raw bytes). The relay and the client encode with
 * this one function.
 */
export function proofContent({ purpose, realm, member, device, key = null, conn, challenge }) {
  if (purpose !== "attach" && purpose !== "register") throw new Error('a proof purpose is "attach" or "register"');
  checkTuple({ realm, member, device, key: purpose === "register" ? key : new Uint8Array(32) });
  const c = Buffer.from(conn ?? []);
  const ch = Buffer.from(challenge ?? []);
  if (c.length !== 16) throw new Error("a connection id has 16 bytes");
  if (ch.length !== 32) throw new Error("a challenge has 32 bytes");
  return purpose === "register" ? encodeFields(purpose, realm, member, device, key, c, ch) : encodeFields(purpose, realm, member, device, c, ch);
}

/** The base64url text of raw bytes (connection ids and challenges on the wire), and back (null when malformed or of another length). */
export const b64url = (b) => Buffer.from(b).toString("base64url");
export const unb64url = (s, n) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.length === n ? b : null;
};
