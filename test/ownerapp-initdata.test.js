// initData checks (design 7.4, section 4; tests of section 11, "initData" and "Revocation edges").
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appSecret, checkInitData, dataCheckString, hexEqual, parseForm, signInitData } from "../lib/ownerappauth.js";

const TOKEN = `7000001:${crypto.randomBytes(26).toString("base64url")}`;
const OTHER = `7000002:${crypto.randomBytes(26).toString("base64url")}`;
const USER = 5550001;
const NOW = 1_800_000_000_000;
const nowS = NOW / 1000;
const base = (o = {}) => ({ auth_date: String(nowS - 5), query_id: "AAH", user: { id: USER, first_name: "O", is_bot: false }, ...o });
const opts = (o = {}) => ({ secret: appSecret(TOKEN), botId: "7000001", user: USER, chat: USER, since: [], now: NOW, ...o });
const check = (raw, o) => checkInitData(raw, opts(o));

test("initData: a valid one opens; a field Telegram adds later is part of the check", () => {
  const r = check(signInitData(TOKEN, base({ signature: "abc", some_new_field: "x" })));
  assert.equal(r.ok, true);
  assert.equal(r.userId, USER);
  assert.match(r.replayKey, /^[0-9a-f]{64}$/);
  // Dropping the new field from a signed string breaks the hash.
  const raw = signInitData(TOKEN, base({ some_new_field: "x" }));
  assert.equal(check(raw.replace(/some_new_field=x&?/, "")).reason, "bad_hash");
});

test("initData: wrong hash, another bot's token, a changed field, a repeated key, a missing user or auth_date", () => {
  const raw = signInitData(TOKEN, base());
  assert.equal(check(raw.replace(/hash=([0-9a-f])/, (_, c) => `hash=${c === "0" ? "1" : "0"}`)).reason, "bad_hash");
  assert.equal(check(signInitData(OTHER, base())).reason, "bad_hash");
  assert.equal(check(raw.replace("query_id=AAH", "query_id=AAI")).reason, "bad_hash");
  assert.equal(check(`${raw}&query_id=AAH`).reason, "bad_hash");
  const { user, ...noUser } = base();
  assert.ok(user);
  assert.equal(check(signInitData(TOKEN, noUser)).reason, "bad_hash");
  const noDate = base();
  delete noDate.auth_date;
  assert.equal(check(signInitData(TOKEN, noDate)).reason, "bad_hash");
  assert.equal(check(raw.replace(/hash=[0-9a-f]+/, "hash=")).reason, "bad_hash");
  assert.equal(check("x".repeat(4097)).reason, "bad_hash");
  assert.equal(check("%E0%A4%A=1").reason, "bad_hash");
});

test("initData: auth_date at most 10 minutes old and at most 60 seconds ahead", () => {
  assert.equal(check(signInitData(TOKEN, base({ auth_date: String(nowS - 600) }))).ok, true);
  assert.equal(check(signInitData(TOKEN, base({ auth_date: String(nowS - 601) }))).reason, "stale");
  assert.equal(check(signInitData(TOKEN, base({ auth_date: String(nowS + 60) }))).ok, true);
  assert.equal(check(signInitData(TOKEN, base({ auth_date: String(nowS + 120) }))).reason, "stale");
  assert.equal(check(signInitData(TOKEN, base({ auth_date: "1e9" }))).reason, "bad_hash");
});

test("initData: not before the last pairing or app on/rotation, with the 60-second margin", () => {
  const since = NOW - 100_000 + 400; // a change at ...400 ms: rounded down to whole seconds
  const s = Math.floor(since / 1000);
  assert.equal(check(signInitData(TOKEN, base({ auth_date: String(s + 60) })), { since: [since] }).reason, "stale");
  assert.equal(check(signInitData(TOKEN, base({ auth_date: String(s + 61) })), { since: [since] }).ok, true);
  assert.equal(check(signInitData(TOKEN, base({ auth_date: String(s - 10) })), { since: [NOW - 3_000_000, since] }).reason, "stale");
  // Opened 30 seconds in the future (a skewed client), then a rotation 5 seconds later: refused.
  const rotatedAt = NOW + 5000;
  const at = String(nowS + 30);
  assert.equal(check(signInitData(TOKEN, base({ auth_date: at })), { since: [rotatedAt], now: rotatedAt + 1000 }).reason, "stale");
});

test("initData: another user, a bot, receiver, another chat, a group chat_type", () => {
  assert.equal(check(signInitData(TOKEN, base({ user: { id: USER + 1 } }))).reason, "wrong_user");
  assert.equal(check(signInitData(TOKEN, base({ user: { id: USER, is_bot: true } }))).reason, "wrong_user");
  assert.equal(check(signInitData(TOKEN, base({ user: "not json" }))).reason, "wrong_user");
  assert.equal(check(signInitData(TOKEN, base({ receiver: { id: 1 } }))).reason, "wrong_chat");
  assert.equal(check(signInitData(TOKEN, base({ chat: { id: 9, type: "private" } }))).reason, "wrong_chat");
  assert.equal(check(signInitData(TOKEN, base({ chat: { id: USER, type: "group" } }))).reason, "wrong_chat");
  assert.equal(check(signInitData(TOKEN, base({ chat: { id: USER, type: "private" } }))).ok, true);
  assert.equal(check(signInitData(TOKEN, base({ chat_type: "group" }))).reason, "wrong_chat");
  assert.equal(check(signInitData(TOKEN, base({ chat_type: "sender" }))).ok, true);
  assert.equal(check(signInitData(TOKEN, base({ chat_type: "private", start_param: "anything" }))).ok, true);
});

test("initData: re-encoded and reordered copies validate and give the same replay key", () => {
  const fields = base({ user: { id: USER, first_name: "A B+C", last_name: "ç/é" } });
  const raw = signInitData(TOKEN, fields);
  const a = check(raw);
  assert.equal(a.ok, true);
  // + for spaces, and another key order: the same authenticated content.
  const plus = raw.replace(/%20/g, "+");
  assert.notEqual(plus, raw);
  const parts = raw.split("&");
  const reordered = [...parts].reverse().join("&");
  const lower = raw.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  for (const v of [plus, reordered, lower]) {
    const r = check(v);
    assert.equal(r.ok, true, v);
    assert.equal(r.replayKey, a.replayKey);
  }
  // Another initData: another key.
  assert.notEqual(check(signInitData(TOKEN, base({ query_id: "ZZZ" }))).replayKey, a.replayKey);
});

test("initData: the hash compare is constant-time on equal-length lowercase hex; other lengths are refused first", () => {
  const h = crypto.randomBytes(32).toString("hex");
  assert.equal(hexEqual(h, h), true);
  assert.equal(hexEqual(h, `${h.slice(0, 63)}${h[63] === "0" ? "1" : "0"}`), false);
  assert.equal(hexEqual(h.slice(0, 62), h.slice(0, 62)), false);
  assert.equal(hexEqual(h.toUpperCase(), h.toUpperCase()), false);
  assert.equal(hexEqual(`${h}00`, `${h}00`), false);
  assert.equal(hexEqual(null, h), false);
  // The data-check string: byte order of keys, decoded values, hash left out.
  assert.equal(dataCheckString(parseForm("b=2&a=1+x&hash=z&B=3")), "B=3\na=1 x\nb=2");
});
