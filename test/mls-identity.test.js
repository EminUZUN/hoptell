// Device identities (design 3.2, experimental): pin identities and display fingerprints against
// fixed vectors (all-zero, all-ff, high-bit key), safety numbers, rotation chains and revocation
// statements, and the timer rules of lib/mls/policy.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  DEVICE_ID_RE,
  MAX_ROTATION_CHAIN,
  base32,
  checkRevocation,
  credentialIdentity,
  displayDigits,
  displayFingerprint,
  encodeFields,
  followRotations,
  makeRevocation,
  makeRotation,
  newDeviceId,
  parseCredentialIdentity,
  pinIdentity,
  readRotation,
  safetyNumber,
  signContent,
  verifyWithLabel,
} from "../lib/mls/identity.js";
import * as P from "../lib/mls/policy.js";
import { createFakeDriver } from "./fake-mls-driver.js";

const ZERO = { realm: "0".repeat(32), member: `m_${"a".repeat(26)}`, device: "a".repeat(26), key: Buffer.alloc(32, 0) };
const FF = { realm: "f".repeat(32), member: `m_${"7".repeat(26)}`, device: `${"7".repeat(25)}4`, key: Buffer.alloc(32, 0xff) };
const HIGH = { realm: "0123456789abcdef0123456789abcdef", member: "name:alice", device: "abcdefghijklmnopqrstuvwxyy", key: Buffer.from(`80${"00".repeat(30)}01`, "hex") };

// The project's own vectors (implementation note 4: not Signal-compatible numbers).
const VECTORS = [
  [ZERO, "340dbf79af76bdd54569210ba7cf68bc5d98e02ed0e843a5c9a670ecc6abb7b6", "03843 17827 04910 84038 80780 77072 89760 64421 20167 91954 29648 96881"],
  [FF, "d6ce786cbc23812e5a99bcf86e39e91c8aab96362990286a3119b02e70d5b8a4", "97335 02207 40149 41027 95531 32940 69713 66465 41007 47683 11320 40740"],
  [HIGH, "65c2aadad1ddbc8427022a6aa83e15daf6e9478e31a60f9633df1721466e7c88", "19845 18511 71710 44558 94437 60068 98730 79211 56070 31205 35662 29841"],
];

test("pin identities and display fingerprints match the vectors (all-zero, all-ff, high-bit key)", () => {
  for (const [t, pin, display] of VECTORS) {
    assert.equal(pinIdentity(t).toString("hex"), pin);
    assert.equal(pinIdentity(t).length, 32);
    assert.equal(displayFingerprint(t), display);
    assert.match(display, /^(\d{5} ){11}\d{5}$/);
  }
});

test("the encoding is the design's: each field with a 4-byte big-endian length, the domain first", () => {
  // Built by hand, independently of encodeFields.
  const field = (b) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(b.length);
    return [l, b];
  };
  const bytes = Buffer.concat(["hoptell-device-fp-v1", ZERO.realm, ZERO.member, ZERO.device].flatMap((s) => field(Buffer.from(s))).concat(field(ZERO.key)));
  assert.deepEqual(encodeFields("hoptell-device-fp-v1", ZERO.realm, ZERO.member, ZERO.device, ZERO.key), bytes);
  assert.equal(pinIdentity(ZERO).toString("hex"), crypto.createHash("sha256").update(bytes).digest("hex"));
  // Display: 60 bytes of SHA-512 in 5-byte chunks, each modulo 100,000.
  const h = Buffer.alloc(64, 0xff);
  assert.equal(displayDigits(h).split(" ")[0], String(0xffffffffff % 100000).padStart(5, "0"));
  assert.equal(displayDigits(Buffer.alloc(64)), Array(12).fill("00000").join(" "));
});

test("display fingerprints are stable and differ for any field, and pins compare full bytes", () => {
  assert.equal(displayFingerprint(HIGH), displayFingerprint({ ...HIGH, key: Buffer.from(HIGH.key) }));
  const variants = [{ ...HIGH, realm: "1".repeat(32) }, { ...HIGH, member: "name:alicf" }, { ...HIGH, device: "bbcdefghijklmnopqrstuvwxyy" }, { ...HIGH, key: Buffer.from(HIGH.key).fill(2, 31) }];
  for (const v of variants) {
    assert.notEqual(pinIdentity(v).toString("hex"), pinIdentity(HIGH).toString("hex"));
    assert.notEqual(displayFingerprint(v), displayFingerprint(HIGH));
  }
  // Length prefixes keep field boundaries: moving a character between fields changes the pin.
  assert.notDeepEqual(encodeFields("ab", "c"), encodeFields("a", "bc"));
  assert.throws(() => pinIdentity({ ...HIGH, key: Buffer.alloc(31) }), /32-byte/);
  assert.throws(() => pinIdentity({ ...HIGH, device: "short" }), /device id/);
});

test("device ids and credential identities", () => {
  for (let i = 0; i < 50; i++) assert.match(newDeviceId(), DEVICE_ID_RE);
  assert.equal(base32(Buffer.alloc(16)), "a".repeat(26));
  assert.equal(base32(Buffer.alloc(16, 0xff)), `${"7".repeat(25)}4`);
  const id = credentialIdentity(HIGH);
  assert.equal(id.toString(), `hoptell-device-v1|${HIGH.realm}|name:alice|${HIGH.device}`);
  assert.deepEqual(parseCredentialIdentity(id), { realm: HIGH.realm, member: "name:alice", device: HIGH.device });
  assert.equal(parseCredentialIdentity(Buffer.from("alice/laptop")), null);
});

test("safety numbers: ordering independence, and any device change changes them", () => {
  const R = HIGH.realm;
  const dev = (member, n) => pinIdentity({ realm: R, member, device: base32(Buffer.alloc(16, n)), key: Buffer.alloc(32, n) });
  const a = { member: "name:alice", pins: [dev("name:alice", 1), dev("name:alice", 2)] };
  const b = { member: "name:bob", pins: [dev("name:bob", 3)] };
  const n = safetyNumber(R, a, b);
  assert.match(n, /^(\d{5} ){11}\d{5}$/);
  assert.equal(safetyNumber(R, b, a), n, "the two sides compute the same number");
  assert.equal(safetyNumber(R, { ...a, pins: [...a.pins].reverse() }, b), n, "device order does not matter");
  assert.notEqual(safetyNumber(R, { ...a, pins: [a.pins[0]] }, b), n, "a removed device changes it");
  assert.notEqual(safetyNumber(R, { ...a, pins: [...a.pins, dev("name:alice", 9)] }, b), n, "an added device changes it");
  assert.notEqual(safetyNumber(R, a, { ...b, pins: [dev("name:bob", 4)] }), n, "a replaced device changes it");
  assert.notEqual(safetyNumber("2".repeat(32), a, b), n, "another realm");
  assert.throws(() => safetyNumber(R, a, a), /two members/);
});

test("statements are SignWithLabel signatures; a forged or relabeled one fails", async () => {
  const d = createFakeDriver({ seed: "sig" });
  const dev = await d.createDevice(credentialIdentity(HIGH));
  const sig = await dev.sign("hoptell-rotate-v1", Buffer.from("x"));
  assert.ok(verifyWithLabel(dev.signaturePublicKey(), "hoptell-rotate-v1", Buffer.from("x"), sig));
  assert.ok(!verifyWithLabel(dev.signaturePublicKey(), "hoptell-revoke-v1", Buffer.from("x"), sig));
  assert.ok(!verifyWithLabel(dev.signaturePublicKey(), "hoptell-rotate-v1", Buffer.from("y"), sig));
  // RFC 9420 SignContent: varint-prefixed "MLS 1.0 <label>" and content.
  assert.deepEqual(signContent("x", Buffer.from("ab")), Buffer.concat([Buffer.from([9]), Buffer.from("MLS 1.0 x"), Buffer.from([2]), Buffer.from("ab")]));
});

/** A device with a chain of rotations: keys[0] is pinned, statements[i] goes keys[i] -> keys[i+1]. */
async function chain(n, { seed = "chain" } = {}) {
  const d = createFakeDriver({ seed });
  const devs = [];
  for (let i = 0; i <= n; i++) devs.push(await d.createDevice(credentialIdentity(HIGH)));
  const keys = devs.map((x) => Buffer.from(x.signaturePublicKey()));
  const statements = [];
  for (let i = 0; i < n; i++) {
    statements.push(await makeRotation({ ...HIGH, oldKey: keys[i], newKey: keys[i + 1], sequence: i + 1 }, (l, c) => devs[i].sign(l, c), (l, c) => devs[i + 1].sign(l, c)));
  }
  return { keys, statements, devs };
}
const pinnedAt = (keys, i = 0, extra = {}) => ({ realm: HIGH.realm, member: HIGH.member, device: HIGH.device, key: keys[i], sequence: i, ...extra });

test("rotation: a valid chain is accepted, in any order; forged, replayed and retired-key statements are refused", async () => {
  const { keys, statements, devs } = await chain(3);
  assert.ok(readRotation(statements[0]));
  const r = followRotations(pinnedAt(keys), [...statements].reverse(), keys[3]);
  assert.equal(r.ok, true);
  assert.equal(r.sequence, 3);
  assert.deepEqual(r.retired, keys.slice(0, 3).map((k) => k.toString("hex")));
  assert.equal(followRotations(pinnedAt(keys), statements, keys[0]).unchanged, true);

  // Forged: signed by the new key only (the old key's signature replaced).
  const forged = { ...statements[0], sig_old: statements[0].sig_new };
  assert.equal(readRotation(forged), null);
  assert.equal(followRotations(pinnedAt(keys), [forged], keys[1]).ok, false);
  // An attacker's key with a statement it signed with its own key for both roles.
  const evil = await createFakeDriver({ seed: "evil" }).createDevice(credentialIdentity(HIGH));
  const evilKey = Buffer.from(evil.signaturePublicKey());
  const fake = await makeRotation({ ...HIGH, oldKey: keys[0], newKey: evilKey, sequence: 1 }, (l, c) => evil.sign(l, c), (l, c) => evil.sign(l, c));
  assert.equal(followRotations(pinnedAt(keys), [fake], evilKey).ok, false);
  // Replayed: a statement at or below the accepted sequence is old authority.
  assert.equal(followRotations(pinnedAt(keys, 2), [statements[0], statements[1]], keys[1]).ok, false);
  // Retired key: rotating back to a key this device had before.
  const back = await makeRotation({ ...HIGH, oldKey: keys[1], newKey: keys[0], sequence: 2 }, (l, c) => devs[1].sign(l, c), (l, c) => devs[0].sign(l, c));
  const res = followRotations(pinnedAt(keys, 1, { retired: [keys[0].toString("hex")] }), [back], keys[0]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /retired/);
  // Another device's statement does not chain for this one.
  assert.equal(followRotations({ ...pinnedAt(keys), device: `${"b".repeat(25)}a` }, statements, keys[1]).ok, false);
});

test(`rotation: a gap longer than ${MAX_ROTATION_CHAIN} statements is a key change; a missing link too`, async () => {
  const { keys, statements } = await chain(MAX_ROTATION_CHAIN + 1, { seed: "long" });
  assert.equal(followRotations(pinnedAt(keys), statements.slice(0, MAX_ROTATION_CHAIN), keys[MAX_ROTATION_CHAIN]).ok, true, "exactly 10 is validated");
  const long = followRotations(pinnedAt(keys), statements, keys[MAX_ROTATION_CHAIN + 1]);
  assert.equal(long.ok, false);
  assert.match(long.reason, /more than 10/);
  assert.equal(followRotations(pinnedAt(keys), [statements[0], statements[2]], keys[3]).ok, false, "a missing statement breaks the chain");
});

test("revocation statements verify against the revoking device's key only", async () => {
  const d = createFakeDriver({ seed: "rev" });
  const a = await d.createDevice(credentialIdentity(HIGH));
  const b = await d.createDevice(credentialIdentity(HIGH));
  const st = await makeRevocation({ realm: HIGH.realm, member: HIGH.member, device: `${"b".repeat(25)}a`, by: HIGH.device, at: 5 }, (l, c) => a.sign(l, c));
  assert.ok(checkRevocation(st, a.signaturePublicKey()));
  assert.ok(!checkRevocation(st, b.signaturePublicKey()));
  assert.ok(!checkRevocation({ ...st, device: `${"c".repeat(25)}a` }, a.signaturePublicKey()));
});

test("policy timers: replenishment, past-epoch retention, skipped keys, fresh updates", () => {
  const now = 100 * P.DAY;
  assert.equal(P.replenishCount({ available: 4, reserved: 1 }, { now }), 15, "below 5: fill to 20 outstanding");
  assert.equal(P.replenishCount({ available: 10, reserved: 0, oldestExpires: now + P.DAY }, { now }), 10, "oldest expires within 2 days");
  assert.equal(P.replenishCount({ available: 10, reserved: 0, oldestExpires: now + 3 * P.DAY }, { now }), 0);
  assert.equal(P.replenishCount({ available: 0 }, { now, lastAt: now - 1000 }), 0, "bounded rate");
  assert.equal(P.replenishCount({ available: 2, reserved: 18 }, { now }), 0, "at most 20 outstanding");

  const epochs = (ages) => ages.map((age, i) => ({ epoch: 10 - i, began: now - age }));
  assert.deepEqual(P.pastEpochsToKeep(epochs([P.DAY, P.DAY, P.DAY, P.DAY, P.DAY]), now), [10, 9, 8, 7, 6], "more than 3 within 7 days: all kept");
  assert.deepEqual(P.pastEpochsToKeep(epochs([8 * P.DAY, 9 * P.DAY, 10 * P.DAY]), now), [10, 9, 8], "3 or fewer beyond 7 days: kept");
  assert.deepEqual(P.pastEpochsToKeep(epochs([8 * P.DAY, 9 * P.DAY, 10 * P.DAY, 11 * P.DAY]), now), [10, 9, 8], "both exceeded: deleted");
  assert.deepEqual(P.pastEpochsToKeep(epochs([P.DAY, P.DAY, P.DAY, 7 * P.DAY]), now), [10, 9, 8], "exactly 7 days is old");

  assert.equal(P.mayKeepSkipped({ keptForSenderEpoch: 9, forward: 200 }), true);
  assert.equal(P.mayKeepSkipped({ keptForSenderEpoch: 10, forward: 1 }), false);
  assert.equal(P.mayKeepSkipped({ keptForSenderEpoch: 0, forward: 201 }), false);

  assert.deepEqual(P.updateDue({ lastUpdate: now - P.DAY, rotatedAt: now - 1 }, now), { due: true, reason: "rotation" });
  assert.deepEqual(P.updateDue({ lastUpdate: now - P.DAY, removalAt: now - 1 }, now), { due: true, reason: "member removal" });
  assert.equal(P.updateDue({ lastUpdate: now - 7 * P.DAY, lastActivity: now - 1 }, now).due, true);
  assert.equal(P.updateDue({ lastUpdate: now - 7 * P.DAY + 1, lastActivity: now - 1 }, now).due, false);
  assert.equal(P.updateDue({ lastUpdate: now - 30 * P.DAY, lastActivity: now - 31 * P.DAY }, now).due, false, "an idle group owes nothing");
  assert.deepEqual(P.staleMembers({ a: now - 31 * P.DAY, b: now - 29 * P.DAY }, now), ["a"]);
});
