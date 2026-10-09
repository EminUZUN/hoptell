// The authenticated content of an encrypted direct message (design 3.3, "Authenticated content",
// "Logical message ids and replay", "Limits"). EXPERIMENTAL. The MLS application message's
// plaintext is this structure in deterministic CBOR (lib/mls/cbor.js), version 1:
//
//   {v: 1, message_id: 16 bytes, created: ms, expires: ms,
//    conversation: {realm, a, b},            the canonical pair (a < b, bytewise)
//    from: {member, device, session}, to: {member, session},
//    kind: "text" | "file" | "reply", reply_to?: 16 bytes (with "reply" only), body}
//
// body is a text string for "text" and "reply" (at most 100,000 characters, and the encoded
// content at most 256 KiB) and a map for "file" (a send_file snapshot: hashes and paths travel
// encrypted too). The decoder takes exactly these keys and types; anything else is refused.
// created and expires are set once for a logical message, expires at most 7 days after created,
// and a resend into a replacement group keeps both unchanged.
//
// message_id is shown as a UUID string (the receipt and reply pipeline's message reference).
import crypto from "node:crypto";
import { NAME_RE } from "../config.js";
import { decode, encode, CborError } from "./cbor.js";
import { DEVICE_ID_RE, MEMBER_ID_RE, REALM_ID_RE } from "./identity.js";
import { DAY } from "./policy.js";

export const CONTENT_VERSION = 1;
export const MAX_LIFETIME_MS = 7 * DAY;
export const SKEW_MS = 5 * 60_000;
export const MAX_TEXT_CHARS = 100_000;
export const MAX_TEXT_CONTENT_BYTES = 256 * 1024;
export const MAX_FILE_CONTENT_BYTES = 320 * 1024; // within the 360 KiB MLS message bound, with MLS's own overhead
const MAX_TIME = 8_640_000_000_000_000; // the largest JavaScript time
const KINDS = new Set(["text", "file", "reply"]);
const TOP = ["body", "conversation", "created", "expires", "from", "kind", "message_id", "reply_to", "to", "v"];

export class ContentError extends Error {
  constructor(message) {
    super(`authenticated content: ${message}`);
    this.code = "bad_content";
  }
}
const bad = (m) => {
  throw new ContentError(m);
};

/** A message id as the pipeline's reference (a UUID string), and back. */
export const idToRef = (b) => {
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const refToId = (ref) => Buffer.from(String(ref).replace(/-/g, ""), "hex");
/** A new logical message id: 16 random bytes (in UUID form, so it is also a valid reference). */
export const newMessageId = () => refToId(crypto.randomUUID());

const keysExactly = (o, allowed, required, what) => {
  if (!o || typeof o !== "object" || Array.isArray(o) || o instanceof Uint8Array) bad(`${what} must be a map`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${what} has an unknown key ${JSON.stringify(k)}`);
  for (const k of required) if (!(k in o)) bad(`${what} lacks ${k}`);
};
const isTime = (t) => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME;
const isId16 = (b) => b instanceof Uint8Array && b.length === 16;
const str = (x, re) => typeof x === "string" && re.test(x);

/** Check a content structure (as built or as decoded); throws ContentError. Returns it. */
export function checkContent(c) {
  keysExactly(c, TOP, ["v", "message_id", "created", "expires", "conversation", "from", "to", "kind", "body"], "the content");
  if (c.v !== CONTENT_VERSION) bad(`unknown version ${c.v}`);
  if (!isId16(c.message_id)) bad("message_id must be 16 bytes");
  // The receiver's schema checks of the timestamps (3.3 implementation note): finite, bounded
  // integers, and 0 <= expires - created <= 7 days.
  if (!isTime(c.created) || !isTime(c.expires)) bad("created and expires must be whole milliseconds");
  if (c.expires - c.created < 0 || c.expires - c.created > MAX_LIFETIME_MS) bad("expires must be within 7 days after created");
  keysExactly(c.conversation, ["a", "b", "realm"], ["a", "b", "realm"], "conversation");
  const { realm, a, b } = c.conversation;
  if (!str(realm, REALM_ID_RE) || !str(a, MEMBER_ID_RE) || !str(b, MEMBER_ID_RE)) bad("conversation is {realm, a, b} with a realm id and member ids");
  if (Buffer.compare(Buffer.from(a), Buffer.from(b)) >= 0) bad("conversation members must be in canonical order (a < b)");
  keysExactly(c.from, ["device", "member", "session"], ["device", "member", "session"], "from");
  keysExactly(c.to, ["member", "session"], ["member", "session"], "to");
  if (!str(c.from.member, MEMBER_ID_RE) || !str(c.from.device, DEVICE_ID_RE) || !str(c.from.session, NAME_RE)) bad("from is {member, device, session}");
  if (!str(c.to.member, MEMBER_ID_RE) || !str(c.to.session, NAME_RE)) bad("to is {member, session}");
  const pair = [c.from.member, c.to.member].sort();
  if (c.from.member === c.to.member || pair[0] !== a || pair[1] !== b) bad("from and to must be the conversation's two members");
  if (!KINDS.has(c.kind)) bad('kind must be "text", "file" or "reply"');
  if (c.kind === "reply" ? !isId16(c.reply_to) : c.reply_to !== undefined) bad('reply_to (16 bytes) goes with kind "reply" only');
  if (c.kind === "file") {
    if (!c.body || typeof c.body !== "object" || Array.isArray(c.body) || c.body instanceof Uint8Array) bad("a file's body is a map (the snapshot)");
  } else {
    if (typeof c.body !== "string" || !c.body.trim()) bad("a text body is a non-empty text string");
    if ([...c.body].length > MAX_TEXT_CHARS) bad(`a text body has at most ${MAX_TEXT_CHARS} characters`);
  }
  return c;
}

/** Encode content (checked first, and its size). */
export function encodeContent(c) {
  checkContent(c);
  let out;
  try {
    out = encode(c);
  } catch (e) {
    if (e instanceof CborError) bad(e.message);
    throw e;
  }
  const max = c.kind === "file" ? MAX_FILE_CONTENT_BYTES : MAX_TEXT_CONTENT_BYTES;
  if (out.length > max) bad(`the encoded content has ${out.length} bytes; at most ${max}`);
  return out;
}

/** Decode and check content; throws ContentError for anything not exactly version 1. */
export function decodeContent(bytes) {
  let c;
  try {
    c = decode(bytes);
  } catch (e) {
    if (e instanceof CborError) bad(e.message);
    throw e;
  }
  checkContent(c);
  const max = c.kind === "file" ? MAX_FILE_CONTENT_BYTES : MAX_TEXT_CONTENT_BYTES;
  if (Buffer.byteLength(bytes) > max) bad(`the encoded content is larger than ${max} bytes`);
  return c;
}

/**
 * A new logical message: the id, created and expires are set here once (expires at most 7 days
 * later; `lifetimeMs` shortens it), and kept unchanged for every resend.
 */
export function newContent({ realm, from, to, kind = "text", body, replyTo = null, now = Date.now(), lifetimeMs = MAX_LIFETIME_MS, messageId = newMessageId() }) {
  const [a, b] = [from.member, to.member].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  const c = { v: CONTENT_VERSION, message_id: Buffer.from(messageId), created: now, expires: now + Math.min(lifetimeMs, MAX_LIFETIME_MS), conversation: { realm, a, b }, from, to, kind, body };
  if (replyTo) c.reply_to = Buffer.from(replyTo);
  return checkContent(c);
}

/**
 * The acceptance window (MI3): a logical message is delivered only while created - 5 min <= now
 * and now < expires + 5 min. Returns null (inside) or "expired" / "not_yet_valid".
 */
export function outsideWindow(c, now) {
  if (now >= c.expires + SKEW_MS) return "expired";
  if (c.created - SKEW_MS > now) return "not_yet_valid";
  return null;
}
