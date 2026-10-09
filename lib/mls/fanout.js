// Encrypted fan-out to roles and teams (design 4.3), and the retained send state of a device that
// it shares with 3.3's direct sends. EXPERIMENTAL, with 3.3: lib/mls/e2ee.js uses these pure
// functions; nothing here talks to the relay or writes state.
//
// A fan-out is one 3.3 logical message per recipient session ("copies"), each in the two-member
// conversation with that member, sent and recovered by 3.3's own path. Its record lives in the
// device record (rec.e2ee.fanout[id]), written in the same ctx.save() as all of its copies:
//
//   {v: 2, id, send_op, created, expires, addressed, profile, realm, body_digest, reservation,
//    excluded: {first_contact, not_encrypted, unavailable}, candidates,
//    copies: [{member, session, ref, name?, final?: {state, reason?, result?}}], done?}
//
// A copy's state is derived from its logical message and outbox entry while it is in progress;
// its final state is written in the same write as the logical message's terminal state.
//
// Retained send state: every retained logical message keeps a reseal reservation S = R + O in
// every state from which it can still be sealed again (R the frame bound of its content, O the
// outbox envelope), released only when it is pruned or becomes failed or expired. The counted
// bytes are derived from the entries and their states (never from the outbox entries present),
// so they are the same whenever the record is opened. New sends are admitted against the bound
// (count and bytes); recovery, reseals, releases and final results never are.
import crypto from "node:crypto";
import { encryptionMode } from "../contacts.js";
import { pinOf } from "./trust.js";
import { MAX_FRAME_BYTES } from "./relayds.js";
import { DAY } from "./policy.js";

export const FANOUT_VERSION = 2;
export const LIMITS = Object.freeze({
  copies: 50, // per fan-out; more is refused before any copy (no truncation)
  bytes: 8 * 1024 * 1024, // the sum of the copies' reservations R
  inProgress: 4, // fan-outs with non-final copies, per device
  retainedEntries: 2_000, // retained logical messages plus fan-out records (open point 7: placeholder)
  retainedBytes: 64 * 1024 * 1024, // their counted bytes (open point 7: placeholder)
});
// The allowances of the frame bound R = 4 * ceil((content + E) / 3) + J. E covers the MLS
// envelope of an application message (header, AEAD tag, signature, padding): measured at 145 to
// 150 bytes with OpenMLS, suite 0x004D, from 1 byte to 256 KiB of content (the fake driver: 131).
// J covers the send_e2ee frame's other fields at their longest (a 64-character session name) and
// the request id. Checked by "the frame bound R" in test/mls-fanout.test.js.
export const ENVELOPE_E = 512;
export const FRAME_J = 512;
// O: the outbox entry around its frame (the op id key, ref, phase, at, and the JSON around them).
export const OUTBOX_O = 256;
export const FANOUT_KEEP_MS = 7 * DAY; // a fan-out record after every copy is final (replies map to it)
export const REASON_MAX = 32; // a final reason is a short code, cut to this
const SECTION_SLACK = 16; // the braces of the counted sections
// Every state from which 3.3 may still seal a logical message again: each keeps its reservation.
export const RESEALABLE = new Set(["new", "resend", "held", "held_key", "sealed", "sent"]);
export const TERMINAL = new Set(["failed", "expired"]);
// Why a copy's send is final as "unavailable" (no device, no KeyPackage, unknown or unreachable:
// one state, 4.2); any other refusal is "refused".
export const UNAVAILABLE_CODES = new Set(["no_device", "no_key_package", "not_allowed", "not_member", "device_revoked", "unknown"]);
const LONGEST_STATE = "held_key";
const MAX_FINAL = { state: "unavailable", reason: "x".repeat(REASON_MAX), result: { state: "accepted", recipients: Number.MAX_SAFE_INTEGER } };

const json = (x) => Buffer.byteLength(JSON.stringify(x), "utf8");
const b64len = (n) => 4 * Math.ceil(n / 3);

/** The frame bound R of a logical message whose encoded content has `contentBytes` bytes. */
export const frameBound = (contentBytes) => b64len(contentBytes + ENVELOPE_E) + FRAME_J;
/** The reseal reservation S = R + O. */
export const resealReservation = (R) => R + OUTBOX_O;

/** A final result as it is stored: the state, a short reason code, the relay's app result. */
export function finalOf(state, { reason = null, result = null } = {}) {
  return { state, ...(reason ? { reason: String(reason).slice(0, REASON_MAX) } : {}), ...(result ? { result: { state: result.state, recipients: result.recipients } } : {}) };
}

/** The counted bytes of logical message `ref`: its largest state, plus S while it holds one. */
export function logicalBytes(ref, L) {
  const largest = { ...L, state: LONGEST_STATE, group: "f".repeat(32) };
  return json(ref) + 2 + json(largest) + (RESEALABLE.has(L.state) ? resealReservation(L.reserve ?? MAX_FRAME_BYTES) : 0);
}
/** The counted bytes of a fan-out record: at its largest, every copy with the largest final. */
export function recordBytes(id, F) {
  const largest = { ...F, done: Number.MAX_SAFE_INTEGER, copies: F.copies.map((c) => ({ ...c, final: MAX_FINAL })) };
  return json(id) + 2 + json(largest);
}
/** The retained send state of rec.e2ee (`s`): {count, bytes}, derived from the entries and their states. */
export function retained(s) {
  let count = 0;
  let bytes = SECTION_SLACK;
  for (const [ref, L] of Object.entries(s.logical ?? {})) {
    count++;
    bytes += logicalBytes(ref, L);
  }
  for (const [id, F] of Object.entries(s.fanout ?? {})) {
    count++;
    bytes += recordBytes(id, F);
  }
  return { count, bytes };
}
/** The bytes the counted sections actually take now (never more than retained(s).bytes). */
export const actualBytes = (s) => json(s.logical ?? {}) + json(s.outbox ?? {}) + json(s.fanout ?? {});

/**
 * Whether entries adding `count` and `bytes` fit the retained bound. Returns null, or the refusal:
 * {count, bytes, retryAt} (retryAt: when the oldest retained entry may be pruned, or null).
 */
export function admit(s, add, limits = LIMITS, { skewMs }) {
  const cur = retained(s);
  if (cur.count + add.count <= limits.retainedEntries && cur.bytes + add.bytes <= limits.retainedBytes) return null;
  const times = [
    ...Object.values(s.logical ?? {}).map((L) => L.expires + skewMs),
    ...Object.values(s.fanout ?? {}).map((F) => (F.done ? F.done + FANOUT_KEEP_MS : Math.max(...F.copies.map((c) => s.logical?.[c.ref]?.expires ?? F.expires)) + skewMs + FANOUT_KEEP_MS)),
  ];
  return { ...cur, retryAt: times.length ? Math.min(...times) : null };
}

/**
 * The state of a copy: its final state, else derived from its logical message (3.3's state):
 * held_key -> "held"; anything else in progress -> "pending".
 */
export function copyState(s, copy) {
  if (copy.final) return copy.final.state;
  const L = s.logical?.[copy.ref];
  if (L?.state === "held_key") return "held";
  return "pending";
}
/** Whether a fan-out record still has copies that are not final. */
export const inProgress = (F) => F.copies.some((c) => !c.final);

/**
 * The tool result of fan-out record `F`: counts by state with the explicit denominator
 * (candidates = excluded + copies), and per name for an explicit list.
 */
export function summary(s, F) {
  const states = { pending: 0, held: 0, accepted: 0, unavailable: 0, refused: 0, expired: 0 };
  for (const c of F.copies) states[copyState(s, c)]++;
  const ex = F.excluded;
  return {
    id: F.id,
    addressed: F.addressed,
    candidates: F.candidates,
    excluded: { ...ex },
    copies: F.copies.length,
    states,
    ...(F.names ? { names: F.names.map((n) => ({ name: n.name, state: n.copy !== undefined ? copyState(s, F.copies[n.copy]) : n.state, ...(n.reason ? { reason: n.reason } : {}) })) } : {}),
  };
}

/** The digest of a fan-out's body (its record keeps the digest, the copies the body). */
export const bodyDigest = (body) => crypto.createHash("sha256").update(typeof body === "string" ? body : JSON.stringify(body)).digest("hex");

/**
 * Audience selection for `@role` / `@all` (design 4.3, "Audience selection"), from the relay's
 * gate-filtered `list` answer `peers` ([{name, roles}]) and `members` (name -> member id or null,
 * the relay's member_of answers: null for a name that is no member's, or hidden). `doc` is the
 * contacts document (pins and encryption policy), `pins` whether this home keeps pins. Returns
 * {candidates, targets: [{name, member}], excluded} where targets still need the encryption check.
 * Roles select candidates, pins decide: a candidate without a pin (verified only, under
 * requireVerified) is excluded as first_contact. The sender's own sessions (its member's) are
 * removed before counting; a hidden member is never listed, so never counted.
 */
export function selectRole({ to, peers, members, doc, pins, realm, me }) {
  const role = to.slice(1);
  const matched = peers.filter((p) => p.name !== me.session && (role === "all" || (p.roles ?? []).includes(role)));
  const candidates = matched.filter((p) => members.get(p.name) !== me.member);
  const excluded = { first_contact: 0, not_encrypted: 0, unavailable: 0 };
  const targets = [];
  for (const p of candidates) {
    const member = members.get(p.name) ?? null;
    if (!member) {
      // Not a member's session (a shared-token session): it cannot receive encrypted.
      excluded[encryptionMode(doc, realm, null) === "required" ? "unavailable" : "not_encrypted"]++;
      continue;
    }
    const pin = pins ? pinOf(doc, realm, member) : null;
    const requireVerified = Boolean(pin?.requireVerified) || (doc?.requireVerified ?? []).includes(realm);
    if (!pin || (requireVerified && pin.how === "relay-tofu")) {
      excluded.first_contact++;
      continue;
    }
    targets.push({ name: p.name, member });
  }
  return { candidates: candidates.length, targets, excluded };
}
