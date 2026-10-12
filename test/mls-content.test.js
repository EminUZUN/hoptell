// 3.3's authenticated content (experimental): the deterministic CBOR codec against the shared
// vectors (valid encodings both ways, and the encodings a decoder must refuse), the v1 schema,
// the timestamp checks and the acceptance window's exact boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decode, encode } from "../lib/mls/cbor.js";
import { MAX_LIFETIME_MS, MAX_TEXT_CHARS, SKEW_MS, decodeContent, encodeContent, idToRef, newContent, outsideWindow, refToId } from "../lib/mls/content.js";
import { REF_RE } from "../lib/config.js";

const V = JSON.parse(fs.readFileSync(new URL("./vectors/e2ee-content-v1.json", import.meta.url), "utf8"));
const toJs = (v) => (v && typeof v === "object" && "$bytes" in v ? Buffer.from(v.$bytes, "hex") : Array.isArray(v) ? v.map(toJs) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJs(x)])) : v);
const realm = "0123456789abcdef0123456789abcdef";
const a = `m_${"a".repeat(26)}`;
const b = `m_${"b".repeat(26)}`;
const base = () => newContent({ realm, from: { member: b, device: "a".repeat(26), session: "bob" }, to: { member: a, session: "alice" }, body: "hi", now: 1_000_000 });

test("CBOR vectors: every value has exactly one encoding, decoded back unchanged", () => {
  for (const v of V.encode) {
    assert.equal(encode(toJs(v.value)).toString("hex"), v.cbor, v.name);
    assert.deepEqual(decode(Buffer.from(v.cbor, "hex")), toJs(v.value), v.name);
  }
});

test("CBOR vectors: the decoder refuses every non-deterministic, unsupported or malformed encoding", () => {
  for (const v of V.reject) assert.throws(() => decode(Buffer.from(v.cbor, "hex")), (e) => e.code === "bad_cbor", v.name);
  // A key "__proto__" is a key, never a prototype.
  const tricky = decode(encode({ ["__proto__"]: 1 }));
  assert.equal(Object.getPrototypeOf(tricky), Object.prototype);
  assert.deepEqual(Object.keys(tricky), ["__proto__"]);
  assert.throws(() => encode({ x: -1 }), /whole numbers/);
  assert.throws(() => encode({ x: 1.5 }), /whole numbers/);
  assert.throws(() => encode({ x: null }), /cannot encode/);
  assert.throws(() => encode("\ud800"), /not valid Unicode/);
});

test("content vectors: v1 contents encode to their vectors and decode back", () => {
  for (const v of V.content) {
    assert.equal(encodeContent(toJs(v.value)).toString("hex"), v.cbor, v.name);
    assert.deepEqual(decodeContent(Buffer.from(v.cbor, "hex")), toJs(v.value), v.name);
  }
});

test("content schema: exact keys and types; from and to are the conversation's members; reply_to with replies only", () => {
  const c = base();
  assert.equal(c.conversation.a, a, "the canonical pair puts the smaller member id first");
  assert.ok(REF_RE.test(idToRef(c.message_id)));
  assert.deepEqual(refToId(idToRef(c.message_id)), c.message_id);
  const bad = (mutate, re) => {
    const x = structuredClone(base());
    x.message_id = Buffer.from(x.message_id);
    mutate(x);
    assert.throws(() => encodeContent(x), re);
    // and the same bytes from a peer: encode bypassing the schema, then decode
    let bytes;
    try {
      bytes = encode(x);
    } catch {
      return;
    }
    assert.throws(() => decodeContent(bytes), re);
  };
  bad((x) => (x.extra = 1), /unknown key/);
  bad((x) => (x.v = 2), /unknown version/);
  bad((x) => (x.message_id = Buffer.alloc(15)), /16 bytes/);
  bad((x) => (x.conversation = { realm, a: b, b: a }), /canonical order/);
  bad((x) => (x.to.member = `m_${"c".repeat(26)}`), /two members/);
  bad((x) => (x.from.member = x.to.member), /two members/);
  bad((x) => (x.kind = "image"), /kind/);
  bad((x) => (x.reply_to = Buffer.alloc(16)), /reply_to/);
  bad((x) => (x.kind = "reply"), /reply_to/);
  bad((x) => (x.body = Buffer.from("x")), /text body/);
  bad((x) => (x.kind = "file"), /a file's body is a map/);
  bad((x) => delete x.to, /lacks to/);
  bad((x) => (x.from.session = "no spaces"), /from is/);
});

test("timestamps: finite bounded integers; 0 <= expires - created <= 7 days; set once", () => {
  const ok = base();
  assert.equal(ok.expires - ok.created, MAX_LIFETIME_MS);
  const bad = (mutate) => {
    const x = base();
    mutate(x);
    assert.throws(() => decodeContent(encode(x)), /created and expires|within 7 days/);
  };
  bad((x) => (x.expires = x.created - 1));
  bad((x) => (x.expires = x.created + MAX_LIFETIME_MS + 1));
  bad((x) => (x.created = Number.MAX_SAFE_INTEGER - 1) && (x.expires = Number.MAX_SAFE_INTEGER));
  const zero = base();
  zero.expires = zero.created;
  assert.doesNotThrow(() => decodeContent(encode(zero)), "a zero lifetime is allowed");
  assert.throws(() => decodeContent(encode({ ...base(), created: 1.5 })), /whole numbers|created and expires/);
});

test("the acceptance window: created - 5 min <= now < expires + 5 min, exactly", () => {
  const c = base();
  assert.equal(outsideWindow(c, c.created - SKEW_MS), null);
  assert.equal(outsideWindow(c, c.created - SKEW_MS - 1), "not_yet_valid");
  assert.equal(outsideWindow(c, c.expires + SKEW_MS - 1), null);
  assert.equal(outsideWindow(c, c.expires + SKEW_MS), "expired", "the boundary instant is outside");
});

test("limits: a text body has at most 100,000 characters and 256 KiB encoded (multibyte text hits the byte bound first)", () => {
  const c = base();
  c.body = "x".repeat(MAX_TEXT_CHARS);
  assert.doesNotThrow(() => encodeContent(c));
  c.body = "x".repeat(MAX_TEXT_CHARS + 1);
  assert.throws(() => encodeContent(c), /at most 100000 characters/);
  c.body = "🙂".repeat(70_000); // 70,000 characters, 280,000 bytes
  assert.throws(() => encodeContent(c), /at most 262144/);
  c.body = "é".repeat(MAX_TEXT_CHARS); // 200,000 bytes: within both bounds
  assert.doesNotThrow(() => encodeContent(c));
});
