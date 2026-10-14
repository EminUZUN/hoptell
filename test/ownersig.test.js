// The owner channel's signatures (lib/ownersig.js, design 7.2): pins, the strict envelope and its
// one encoding, each verification rule failing alone, nonces, trusted pins and the replay store.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sig from "../lib/ownersig.js";

const REALM = "0123456789abcdef0123456789abcdef";
const OTHER_REALM = "fedcba9876543210fedcba9876543210";
const MEMBER = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REF = "11111111-2222-4333-8444-555555555555";
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-ownersig-"));

const key = sig.newKey();
const pin = { name: "me-owner", keys: [{ id: sig.keyIdOf(key.pub), pub: key.pub }] };
const me = { name: "me-alice", member: MEMBER };
const now = 1_800_000_000_000;
const fields = (over = {}) => ({ kind: "answer", realm: REALM, from: "me-owner", to: { ...me }, q: REF, text: "yes, go ahead", pairing: { id: "p_abcdefghijklmnop", at: now - 1000 }, ts: now, nonce: sig.nonceOf(key, ["upd", "42", 7]), ...over });
const check = (text, over = {}) => sig.verifyEnvelope(text, { pin, realm: REALM, sender: "me-owner", me, now, ...over });

test("a pin round-trips and is checked strictly", () => {
  const text = sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub });
  assert.match(text, /^hoptell-owner-channel:1:[0-9a-f]{32}:me-owner:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(sig.parsePin(text), { realm: REALM, name: "me-owner", pub: key.pub, keyId: sig.keyIdOf(key.pub) });
  assert.deepEqual(sig.parsePin(`  ${text}\n`).realm, REALM, "surrounding whitespace is ignored");
  for (const bad of [text.replace("hoptell-owner-channel", "other"), text.replace(REALM, "XYZ"), text.replace("me-owner", "me.owner"), `${text}:extra`, "", text.replace(/.$/, "=")]) {
    assert.throws(() => sig.parsePin(bad), Error, bad);
  }
  assert.throws(() => sig.parsePin(text.slice(0, -2)), /32-byte/);
  assert.throws(() => sig.parsePin(text.replace(":1:", ":2:")), /version/);
  assert.equal(sig.keyIdOf(key.pub).length, 16);
});

test("a signed envelope verifies, and is exactly its canonical encoding", () => {
  const text = sig.signEnvelope(fields(), key);
  const r = check(text);
  assert.equal(r.ok, true);
  assert.equal(r.env.text, "yes, go ahead");
  // Keys sorted, no whitespace.
  assert.equal(text, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).sort(([a], [b]) => (a < b ? -1 : 1)))));
  // Other encodings of the same object are refused before any signature check.
  const obj = JSON.parse(text);
  assert.match(check(JSON.stringify(obj, null, 1)).reason, /canonical/);
  assert.match(check(text.replace('"kind"', '"kind":"answer","kind"')).reason, /canonical|malformed/, "duplicate key");
  assert.match(check(text.replace(`"ts":${now}`, `"ts":${now}.0`)).reason, /canonical/, "another number form");
  assert.match(check(text.replace('"yes, go ahead"', '"yes, go \\u0061head"')).reason, /canonical/, "another escape");
  // The signed bytes carry the domain prefix.
  assert.ok(sig.signedBytes(obj).toString().startsWith("hoptell-owner-channel/1\n"));
  const plain = Buffer.from(sig.signedBytes(obj).toString().slice("hoptell-owner-channel/1\n".length));
  assert.equal(crypto.verify(null, plain, crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.pub }, format: "jwk" }), Buffer.from(obj.sig, "base64url")), false, "the signature does not cover the bytes without the domain");
});

test("the strict schema: exactly the listed keys, types, kinds, and q only for answer and status", () => {
  const good = JSON.parse(sig.signEnvelope(fields(), key));
  const recode = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
  const reasons = (mut) => {
    const o = structuredClone(good);
    mut(o);
    return check(recode(o)).reason;
  };
  assert.match(reasons((o) => (o.extra = 1)), /unexpected/);
  assert.match(reasons((o) => delete o.nonce), /unexpected|missing/);
  assert.match(reasons((o) => (o.kind = "approval")), /kind/);
  assert.match(reasons((o) => delete o.q), /unexpected|missing/);
  assert.match(reasons((o) => (o.to.extra = "x")), /bad to/);
  assert.match(reasons((o) => (o.text = "")), /bad text/);
  assert.match(reasons((o) => (o.text = "x".repeat(sig.TEXT_MAX + 1))), /bad text/);
  assert.match(reasons((o) => (o.ts = "1")), /bad ts/);
  assert.match(reasons((o) => (o.hoptell_owner = 2)), /version-1/);
  // An instruction carries no q.
  const ins = sig.signEnvelope(fields({ kind: "instruction", q: undefined }), key);
  assert.equal(check(ins).ok, true);
  const insObj = JSON.parse(ins);
  insObj.q = REF;
  assert.match(check(recode(insObj)).reason, /unexpected/);
  assert.throws(() => sig.signEnvelope(fields({ kind: "status", q: undefined }), key), /bad q/);
  // Not an envelope at all: plain text, other JSON.
  assert.equal(check("hello"), null);
  assert.equal(check('{"a":1}'), null);
  assert.match(check('{"hoptell_owner": 1').reason, /JSON/);
});

test("each verification rule fails alone", () => {
  const text = sig.signEnvelope(fields(), key);
  assert.equal(check(text).ok, true);
  assert.match(check(text, { pin: null }).reason, /trusts no owner channel/, "no pin");
  assert.match(check(text, { realm: OTHER_REALM }).reason, /realm/, "realm");
  assert.match(check(sig.signEnvelope(fields({ from: "me-other" }), key)).reason, /bridge name/, "from differs from the pin");
  assert.match(check(text, { sender: "me-impostor" }).reason, /bridge name/, "the relay's sender name differs from from");
  assert.match(check(text, { me: { name: "me-bob", member: MEMBER } }).reason, /not addressed/, "to.name");
  assert.match(check(text, { me: { name: "me-alice", member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb" } }).reason, /not addressed/, "to.member");
  const other = sig.newKey();
  assert.match(check(sig.signEnvelope(fields(), other)).reason, /key not trusted/, "an unpinned key");
  // A pinned key id with a signature by another key.
  const forged = JSON.parse(sig.signEnvelope(fields(), other));
  forged.key = sig.keyIdOf(key.pub);
  const recode = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
  assert.match(check(recode(forged)).reason, /bad signature/, "signature");
  // A changed signed field breaks the signature.
  const changed = JSON.parse(text);
  changed.text = "no";
  assert.match(check(recode(changed)).reason, /bad signature/);
  assert.match(check(sig.signEnvelope(fields({ ts: now + sig.FUTURE_MS + 1 }), key)).reason, /future/, "ts in the future");
  assert.equal(check(sig.signEnvelope(fields({ ts: now + sig.FUTURE_MS }), key)).ok, true);
  assert.match(check(sig.signEnvelope(fields({ ts: now - sig.PAST_MS - 1 }), key)).reason, /too old/, "ts too old");
});

test("nonces are deterministic and domain separated", () => {
  const a = sig.nonceOf(key, ["upd", "42", 7]);
  assert.equal(a, sig.nonceOf(key, ["upd", "42", 7]));
  assert.notEqual(a, sig.nonceOf(key, ["exp", "42", 7]));
  assert.notEqual(a, sig.nonceOf(key, ["upd", "43", 7]));
  assert.notEqual(a, sig.nonceOf(sig.newKey(), ["upd", "42", 7]));
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test("a stored key is checked against its public key", () => {
  assert.deepEqual(sig.checkKey(key), key);
  assert.throws(() => sig.checkKey({ pub: sig.newKey().pub, priv: key.priv }), /does not match/);
  assert.throws(() => sig.checkKey({ pub: "x", priv: key.priv }), /malformed/);
});

test("question envelopes: schema and canonical form", () => {
  const t = sig.questionEnvelope({ question: "Deploy now?", choices: ["yes", "no"], askedAt: now, expiresAt: now + 3600_000 });
  assert.deepEqual(sig.parseQuestion(t), { hoptell_owner_question: 1, question: "Deploy now?", choices: ["yes", "no"], asked_at: now, expires_at: now + 3600_000 });
  assert.equal(sig.parseQuestion(` ${t}`), null);
  assert.equal(sig.parseQuestion(t.replace("{", "{ ")), null);
  assert.throws(() => sig.questionEnvelope({ question: "x", choices: ["only"], askedAt: now, expiresAt: now + 1 }), /2 to 6/);
  assert.throws(() => sig.questionEnvelope({ question: "x", choices: ["a", "a"], askedAt: now, expiresAt: now + 1 }), /differ/);
  assert.throws(() => sig.questionEnvelope({ question: "x", choices: ["a".repeat(41), "b"], askedAt: now, expiresAt: now + 1 }), /40/);
  assert.throws(() => sig.questionEnvelope({ question: "x".repeat(3001), askedAt: now, expiresAt: now + 1 }), /3000/);
  assert.ok(sig.parseQuestion(sig.questionEnvelope({ question: "x", askedAt: now, expiresAt: now + 1 })));
});

test("trusted pins: replace, staged add, remove a key, revoke", () => {
  const home = tmpHome();
  const k2 = sig.newKey();
  const k3 = sig.newKey();
  const pin1 = sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub });
  const pin2 = sig.formatPin({ realm: REALM, name: "me-owner", pub: k2.pub });
  assert.equal(sig.pinFor(home, REALM), null);
  assert.deepEqual(sig.trustPin(home, pin1).after, [sig.keyIdOf(key.pub)]);
  assert.equal((fs.statSync(path.join(home, "owner-channel", "trusted.json")).mode & 0o777).toString(8), "600");
  assert.throws(() => sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-other", pub: k2.pub }), { add: true }), /names the bridge/);
  assert.deepEqual(sig.trustPin(home, pin2, { add: true }).after, [sig.keyIdOf(key.pub), sig.keyIdOf(k2.pub)]);
  assert.throws(() => sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: k3.pub }), { add: true }), /2 keys/);
  // Both keys verify while the rotation is staged.
  const both = sig.pinFor(home, REALM);
  assert.equal(check(sig.signEnvelope(fields(), key), { pin: both }).ok, true);
  assert.equal(check(sig.signEnvelope(fields(), k2), { pin: both }).ok, true);
  sig.removeTrustedKey(home, sig.keyIdOf(key.pub));
  assert.match(check(sig.signEnvelope(fields(), key), { pin: sig.pinFor(home, REALM) }).reason, /key not trusted/);
  // Replacement without --add: both keys go.
  const r = sig.trustPin(home, pin1);
  assert.deepEqual(r.before, [sig.keyIdOf(k2.pub)]);
  assert.deepEqual(r.after, [sig.keyIdOf(key.pub)]);
  sig.revokeRealm(home, REALM);
  assert.equal(sig.pinFor(home, REALM), null);
  // An unsafe file trusts nothing.
  sig.trustPin(home, pin1);
  fs.chmodSync(path.join(home, "owner-channel", "trusted.json"), 0o644);
  assert.equal(sig.pinFor(home, REALM), null);
  assert.throws(() => sig.readTrusted(home), /private/);
});

test("the replay store: first record wins, lookups, pruning only outside the replay window", () => {
  const home = tmpHome();
  const nonce = sig.nonceOf(key, ["upd", "1", 1]);
  assert.equal(sig.lookupSeen(home, REALM, nonce), null);
  const a = sig.recordSeen(home, { realm: REALM, nonce, ref: REF, result: "verified", now });
  assert.equal(a.ref, REF);
  const b = sig.recordSeen(home, { realm: REALM, nonce, ref: "99999999-2222-4333-8444-555555555555", result: "verified", now });
  assert.equal(b.ref, REF, "the first record is kept");
  assert.equal(sig.lookupSeen(home, OTHER_REALM, nonce), null, "keyed on realm and nonce");
  const dir = path.join(home, "owner-channel", "seen");
  assert.equal(fs.readdirSync(dir).length, 1, "no temporary files left");
  // That record was accepted at `now` (an earlier time); the others now.
  for (let i = 0; i < 3; i++) sig.recordSeen(home, { realm: REALM, nonce: sig.nonceOf(key, ["x", String(i)]), ref: REF, result: "verified", now: now + 3600_000 });
  assert.equal(sig.pruneSeen(home, now + sig.SEEN_KEEP_MS), 0, "kept up to its keep-until time");
  assert.equal(sig.pruneSeen(home, now + sig.SEEN_KEEP_MS + 1), 1, "only the expired one");
  assert.equal(fs.readdirSync(dir).length, 3, "fresh records are never evicted");
  // The file's mtime does not count: an old mtime on a fresh record changes nothing.
  const past = new Date(Date.now() - sig.SEEN_KEEP_MS - 60_000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), past, past);
  assert.equal(sig.pruneSeen(home, now + 3600_000), 0);
});

test("the replay store at its bound: fresh records stay, the store is full, and frees up only as records expire", () => {
  const home = tmpHome();
  const nonces = [0, 1, 2].map((i) => sig.nonceOf(key, ["full", String(i)]));
  for (const n of nonces) sig.recordSeen(home, { realm: REALM, nonce: n, ref: REF, result: "verified" });
  assert.equal(sig.seenFull(home, Date.now(), 4), false);
  assert.equal(sig.seenFull(home, Date.now(), 3), true, "full at the bound");
  assert.equal(sig.seenFull(home, Date.now(), 2), true, "and above it: nothing fresh is evicted");
  assert.ok(sig.lookupSeen(home, REALM, nonces[0]), "the first nonce is still known (a replay stays suppressed)");
  const dir = path.join(home, "owner-channel", "seen");
  assert.equal(sig.seenFull(home, Date.now() + sig.SEEN_KEEP_MS + 60_000, 3), false, "expired records make room");
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("the replay store's retention covers the signature's validity: a nonce is kept while its envelope still verifies, also with a future ts", () => {
  const home = tmpHome();
  const at = now;
  const ts = at + sig.FUTURE_MS; // the latest ts accepted at `at`
  const env = sig.signEnvelope(fields({ ts, nonce: sig.nonceOf(key, ["edge", "1"]) }), key);
  assert.equal(check(env, { now: at }).ok, true, "accepted at `at`");
  sig.recordSeen(home, { realm: REALM, nonce: JSON.parse(env).nonce, ref: REF, result: "verified", ts, now: at });
  const lastValid = ts + sig.PAST_MS;
  assert.equal(check(env, { now: lastValid }).ok, true, "still verifies at ts + PAST_MS");
  assert.match(check(env, { now: lastValid + 1 }).reason, /too old/);
  // A full store at that boundary: the record is not pruned, so the store stays full and a replay
  // is still recognised.
  assert.equal(sig.seenFull(home, lastValid, 1), true);
  assert.ok(sig.lookupSeen(home, REALM, JSON.parse(env).nonce), "kept at the last moment it could verify");
  assert.ok(sig.seenKeepUntil(at, ts) >= lastValid + sig.SEEN_MARGIN_MS);
  assert.equal(sig.seenFull(home, sig.seenKeepUntil(at, ts), 1), true, "kept through its keep-until time");
  assert.equal(sig.seenFull(home, sig.seenKeepUntil(at, ts) + 1, 1), false, "then pruned");
  // A record accepted for a ts far in the past is still kept SEEN_KEEP_MS from acceptance.
  assert.equal(sig.seenKeepUntil(at, at - sig.PAST_MS), at + sig.SEEN_KEEP_MS);
});

test("the replay store recovers its own install link and fails closed on anything else", () => {
  const home = tmpHome();
  const dir = path.join(home, "owner-channel", "seen");
  const nonce = sig.nonceOf(key, ["crash", "1"]);
  const other = "99999999-2222-4333-8444-555555555555";
  sig.recordSeen(home, { realm: REALM, nonce, ref: REF, result: "verified", now });
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  // A crash between link and unlink: the record also has its temporary name (two links).
  fs.linkSync(file, `${file}.0123456789ab.tmp`);
  assert.equal(fs.statSync(file).nlink, 2);
  assert.equal(sig.lookupSeen(home, REALM, nonce).ref, REF, "read, and the temporary name removed");
  assert.equal(fs.statSync(file).nlink, 1);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
  // A concurrent writer meeting that state (EEXIST on link) returns the record on disk, not its own.
  fs.linkSync(file, `${file}.ba9876543210.tmp`);
  assert.equal(sig.recordSeen(home, { realm: REALM, nonce, ref: other, result: "verified" }).ref, REF);
  assert.equal(fs.statSync(file).nlink, 1);
  // A crash before the link leaves only a temporary file: no record (a later write installs one),
  // and pruning removes the stale temporary file.
  const n2 = sig.nonceOf(key, ["crash", "2"]);
  sig.recordSeen(home, { realm: REALM, nonce: n2, ref: REF, result: "verified" });
  const f2 = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => f !== file);
  fs.renameSync(f2, `${f2}.aaaaaaaaaaaa.tmp`);
  assert.equal(sig.lookupSeen(home, REALM, n2), null);
  const stale = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(`${f2}.aaaaaaaaaaaa.tmp`, stale, stale);
  assert.equal(sig.pruneSeen(home), 1);
  // Another extra link, a malformed or foreign record, a symlink or a loose mode: unreadable, and
  // recordSeen neither replaces it nor pretends its own record is in place.
  const bad = [
    (f) => fs.linkSync(f, path.join(home, "elsewhere")),
    (f) => fs.writeFileSync(f, "{not json", { mode: 0o600 }),
    (f) => fs.writeFileSync(f, JSON.stringify({ v: 1, realm: REALM, nonce: "other", ref: REF, result: "verified", at: 1 }), { mode: 0o600 }),
    (f) => fs.chmodSync(f, 0o644),
    (f) => {
      fs.rmSync(f);
      fs.symlinkSync(path.join(home, "target"), f);
    },
  ];
  bad.forEach((spoil, i) => {
    const h = tmpHome();
    const n = sig.nonceOf(key, ["bad", String(i)]);
    sig.recordSeen(h, { realm: REALM, nonce: n, ref: REF, result: "verified" });
    const d = path.join(h, "owner-channel", "seen");
    const f = path.join(d, fs.readdirSync(d)[0]);
    spoil(f);
    assert.throws(() => sig.lookupSeen(h, REALM, n), (e) => e instanceof sig.SeenStoreError && e.reason === "replay store unreadable", `case ${i}`);
    assert.throws(() => sig.recordSeen(h, { realm: REALM, nonce: n, ref: other, result: "verified" }), sig.SeenStoreError, `case ${i}`);
  });
});

test("the replay store: a failure at write, link, unlink or directory sync propagates and installs no false record", () => {
  for (const point of ["written", "linked", "unlinked"]) {
    const home = tmpHome();
    const nonce = sig.nonceOf(key, ["fault", point]);
    const fault = (p) => {
      if (p === point) throw Object.assign(new Error(`EIO at ${p}`), { code: "EIO" });
    };
    assert.throws(() => sig.recordSeen(home, { realm: REALM, nonce, ref: REF, result: "verified", fault }), /EIO/, point);
    const dir = path.join(home, "owner-channel", "seen");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, `${point}: no temporary file left`);
    const rec = sig.lookupSeen(home, REALM, nonce);
    // Before the link nothing is installed; after it, the record on disk is the real one.
    assert.equal(rec === null, point === "written", point);
    assert.equal(sig.recordSeen(home, { realm: REALM, nonce, ref: REF, result: "verified" }).ref, REF, `${point}: a retry completes`);
  }
});

test("pruning keeps a record it cannot fully validate, and never takes a keep_until below the record's safe bound", () => {
  const nonce = sig.nonceOf(key, ["malformed", "1"]);
  const later = Date.now() + 365 * 86400_000; // far beyond any retention
  const spoiled = [
    { keep_until: 1 },
    { v: 2, realm: REALM, nonce, ref: REF, result: "verified", at: 1, keep_until: 1 },
    { v: 1, realm: REALM, nonce: "another nonce", ref: REF, result: "verified", at: 1, keep_until: 1 },
  ];
  for (const [i, bad] of spoiled.entries()) {
    const home = tmpHome();
    sig.recordSeen(home, { realm: REALM, nonce, ref: REF, result: "verified" });
    const dir = path.join(home, "owner-channel", "seen");
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    fs.writeFileSync(file, JSON.stringify(bad), { mode: 0o600 });
    assert.equal(sig.seenFull(home, later, 1), true, `case ${i}: a full-store prune keeps it`);
    assert.ok(fs.existsSync(file), `case ${i}`);
    assert.throws(() => sig.lookupSeen(home, REALM, nonce), sig.SeenStoreError, `case ${i}: the original nonce still fails closed`);
  }
  // A complete record whose recorded times are too early: its file was written now, so it is kept
  // for SEEN_KEEP_MS from then, whatever keep_until and at say.
  const home = tmpHome();
  sig.recordSeen(home, { realm: REALM, nonce, ref: REF, result: "verified" });
  const dir = path.join(home, "owner-channel", "seen");
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.writeFileSync(file, JSON.stringify({ v: 1, realm: REALM, nonce, ref: REF, result: "verified", at: 1, ts: null, keep_until: 1 }), { mode: 0o600 });
  assert.equal(sig.pruneSeen(home, Date.now() + sig.SEEN_KEEP_MS - 60_000), 0);
  assert.ok(sig.lookupSeen(home, REALM, nonce));
});
