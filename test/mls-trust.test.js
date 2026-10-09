// Pins and key-change stops (design 3.2, experimental): trust on first use recorded as relay-tofu,
// new devices hold sending, a replaced key stops traffic both ways until the owner decides (the
// decision names old and new fingerprints), held messages released exactly once, planned
// rotations accepted, revocations trusted only when signed by a pinned device, pins scoped by
// (realm, member) and compared by full identity, requireVerified never satisfied by relay-tofu,
// and pins kept in contacts.json under the contacts lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openContacts } from "../lib/quarantine.js";
import { validateContacts } from "../lib/contacts.js";
import { b64, credentialIdentity, makeRevocation, makeRotation, newDeviceId, pinIdentity } from "../lib/mls/identity.js";
import { applyRevocations, clearRevocation, clearRevocationOverflow, decide, evaluate, gate, heldQueue, pairSafetyNumber, pinFirstUse, pinOf, retireRemovedDevice } from "../lib/mls/trust.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { fakeDevice, tmpDir } from "./mls-helpers.js";

const REALM = "a".repeat(32);
const OTHER_REALM = "b".repeat(32);
const BOB = `m_${"b".repeat(26)}`;
const ME = `m_${"m".repeat(26)}`;
const driver = createFakeDriver({ seed: "trust" });

/** A device of `member` as the relay serves it (with an optional rotation chain). */
async function device(member = BOB, { realm = REALM, id = newDeviceId() } = {}) {
  const dev = await driver.createDevice(credentialIdentity({ realm, member, device: id }));
  const key = Buffer.from(dev.signaturePublicKey());
  const served = (k = key, extra = {}) => ({ device: id, key: b64(k), pin: b64(pinIdentity({ realm, member, device: id, key: k })), seq: 0, rotations: [], ...extra });
  return { id, dev, key, served };
}
const fresh = () => ({ version: 1, default: "ask", grants: [], blocks: [] });

test("first use is accepted as unverified (relay-tofu); requireVerified holds until verified in person or out of band", async () => {
  const a = await device();
  const doc = fresh();
  const ev = evaluate(doc, REALM, BOB, [a.served()]);
  assert.equal(ev.state, "first-use");
  pinFirstUse(doc, REALM, BOB, ev.active);
  assert.equal(pinOf(doc, REALM, BOB).how, "relay-tofu");
  assert.deepEqual(validateContacts(doc), []);
  const ok = evaluate(doc, REALM, BOB, [a.served()]);
  assert.deepEqual([ok.state, ok.verified], ["ok", false], "delivered, marked unverified");
  doc.requireVerified = [REALM];
  assert.equal(evaluate(doc, REALM, BOB, [a.served()]).state, "hold", "relay-tofu never satisfies requireVerified");
  assert.equal(evaluate(fresh(), REALM, BOB, [a.served()]).state, "first-use");
  assert.equal(evaluate({ ...fresh(), requireVerified: [REALM] }, REALM, BOB, [a.served()]).state, "hold", "nor does no pin at all");
  decide(doc, REALM, BOB, ok, { how: "in-person" });
  assert.deepEqual([evaluate(doc, REALM, BOB, [a.served()]).state, evaluate(doc, REALM, BOB, [a.served()]).verified], ["ok", true]);
  // Per contact too.
  const doc2 = fresh();
  pinFirstUse(doc2, REALM, BOB, ev.active);
  pinOf(doc2, REALM, BOB).requireVerified = true;
  assert.equal(evaluate(doc2, REALM, BOB, [a.served()]).state, "hold");
});

test("pins are scoped by (realm, member) and compare the full pin identity", async () => {
  const a = await device();
  const doc = fresh();
  pinFirstUse(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served()]).active);
  // The same member id and device in another realm is another contact.
  assert.equal(evaluate(doc, OTHER_REALM, BOB, [{ ...a.served(), pin: b64(pinIdentity({ realm: OTHER_REALM, member: BOB, device: a.id, key: a.key })) }]).state, "first-use");
  // Another member never inherits the pin.
  const carol = `m_${"c".repeat(26)}`;
  assert.equal(evaluate(doc, REALM, carol, [{ ...a.served(), pin: b64(pinIdentity({ realm: REALM, member: carol, device: a.id, key: a.key })) }]).state, "first-use");
  // A relay that serves a pin not matching (realm, member, device, key) is ignored, not believed.
  assert.equal(evaluate(doc, REALM, BOB, [{ ...a.served(), pin: b64(Buffer.alloc(32, 7)) }]).active.length, 0);
});

test("a new device of a pinned contact holds sending until the owner accepts it; release is exactly once", async (t) => {
  const home = tmpDir(t);
  const q = heldQueue({ home, profile: "p" });
  const a = await device();
  const b = await device();
  const doc = fresh();
  pinFirstUse(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served()]).active);
  const ev = evaluate(doc, REALM, BOB, [a.served(), b.served()]);
  assert.equal(ev.state, "hold");
  assert.deepEqual(ev.newDevices.map((d) => d.id ?? d.device), [b.id]);
  const g = gate(ev, q, { realm: REALM, member: BOB });
  const held = [g.outbound("one"), g.outbound("two")];
  assert.ok(held.every((h) => h.deliver === false && h.held));
  assert.equal(g.inbound("from an accepted device").deliver, true, "receiving is not stopped by a new device");
  assert.equal(q.line(), "2 messages wait for a key decision (the owner runs hoptell contacts verify)");
  assert.doesNotMatch(q.line(), /[A-Za-z0-9+/]{43}=/, "never the keys");
  const { decisions } = decide(doc, REALM, BOB, ev, { accept: [b.id] });
  assert.equal(decisions[0].decision, "accepted new device");
  assert.equal(evaluate(doc, REALM, BOB, [a.served(), b.served()]).state, "ok");
  // Released exactly once, even when the process dies between handing out and removing.
  // The sink is 3.3's sender, which uses the held id as its operation id: a second hand-out of the
  // same id is the same operation, so it is delivered once.
  const sink = new Map();
  const handouts = [];
  const deliver = async (msg, id) => {
    handouts.push(id);
    if (!sink.has(id)) sink.set(id, [msg]);
  };
  let crash = true;
  const crashing = heldQueue({ home, profile: "p", fault: (p) => {
    if (p === "held-after-deliver" && crash) {
      crash = false;
      throw new Error("crash");
    }
  } });
  await assert.rejects(crashing.release(REALM, BOB, deliver), /crash/);
  await Promise.all([q.release(REALM, BOB, deliver), q.release(REALM, BOB, deliver)]);
  assert.equal(handouts.length, 3, "the message whose removal crashed was handed out again, with the same id");
  assert.equal(new Set(handouts).size, 2);
  assert.deepEqual([...sink.values()].map((v) => v.length), [1, 1], "each held message delivered once");
  assert.deepEqual([...sink.values()].map((v) => v[0]).sort(), ["one", "two"]);
  assert.equal(q.count(REALM, BOB), 0);
  assert.equal(await q.release(REALM, BOB, deliver), 0);
});

test("a replaced key stops traffic both ways; the decision names old and new fingerprints and releases both directions once", async (t) => {
  const home = tmpDir(t);
  const q = heldQueue({ home, profile: "p" });
  const a = await device();
  const doc = fresh();
  pinFirstUse(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served()]).active);
  decide(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served()]), { how: "out-of-band" });
  const attacker = await driver.createDevice(credentialIdentity({ realm: REALM, member: BOB, device: a.id }));
  const evilKey = Buffer.from(attacker.signaturePublicKey());
  const ev = evaluate(doc, REALM, BOB, [a.served(evilKey)]);
  assert.equal(ev.state, "stop");
  assert.equal(ev.changed[0].device, a.id);
  assert.notEqual(ev.changed[0].old, ev.changed[0].new);
  const g = gate(ev, q, { realm: REALM, member: BOB });
  assert.equal(g.outbound("out").deliver, false);
  assert.equal(g.inbound("in").deliver, false, "receiving stops too");
  assert.equal(q.count(REALM, BOB, "out"), 1);
  assert.equal(q.count(REALM, BOB, "in"), 1);
  // Not silently accepted: verifying the old set again keeps the stop.
  assert.equal(evaluate(doc, REALM, BOB, [a.served(evilKey)]).state, "stop");
  const { decisions } = decide(doc, REALM, BOB, ev, { accept: [a.id] });
  assert.deepEqual(decisions.map((d) => [d.decision, d.old, d.new]), [["accepted replaced key", ev.changed[0].old, ev.changed[0].new]]);
  assert.deepEqual(pinOf(doc, REALM, BOB).decisions.at(-1).device, a.id);
  assert.deepEqual(validateContacts(doc), []);
  assert.equal(evaluate(doc, REALM, BOB, [a.served(evilKey)]).state, "ok");
  const seen = [];
  assert.equal(await q.release(REALM, BOB, async (m, id, dir) => seen.push([m, dir, id])), 2);
  assert.deepEqual(seen.map(([m, d]) => [m, d]).sort(), [["in", "in"], ["out", "out"]]);
  assert.equal(await q.release(REALM, BOB, async () => assert.fail("released twice")), 0);
});

test("a planned rotation passes without a stop and is persisted; a forged statement is a key change", async () => {
  const a = await device();
  const doc = fresh();
  pinFirstUse(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served()]).active);
  const next = await driver.createDevice(a.dev.identity);
  const newKey = Buffer.from(next.signaturePublicKey());
  const st = await makeRotation({ realm: REALM, member: BOB, device: a.id, oldKey: a.key, newKey, sequence: 1 }, (l, c) => a.dev.sign(l, c), (l, c) => next.sign(l, c));
  const ev = evaluate(doc, REALM, BOB, [a.served(newKey, { seq: 1, rotations: [st] })]);
  assert.equal(ev.state, "ok");
  decide(doc, REALM, BOB, ev, { accept: [] });
  const pinned = pinOf(doc, REALM, BOB).devices[0];
  assert.deepEqual([pinned.key, pinned.seq], [b64(newKey), 1]);
  assert.deepEqual(pinned.retired, [a.key.toString("hex")]);
  // The old statement again, now that sequence 1 is accepted: no replay of old authority.
  assert.equal(evaluate(doc, REALM, BOB, [a.served(a.key, { rotations: [st] })]).state, "stop");
  const forged = { ...st, sig_old: st.sig_new };
  assert.equal(evaluate(fresh(), REALM, BOB, [a.served()]).state, "first-use");
  const doc2 = fresh();
  pinFirstUse(doc2, REALM, BOB, evaluate(doc2, REALM, BOB, [a.served()]).active);
  assert.equal(evaluate(doc2, REALM, BOB, [a.served(newKey, { rotations: [forged] })]).state, "stop");
});

test("revocations: signed by another pinned device holds sending to it at once; relay-only ones are advisory", async () => {
  const a = await device();
  const b = await device();
  const doc = fresh();
  pinFirstUse(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served(), b.served()]).active);
  const signed = await makeRevocation({ realm: REALM, member: BOB, device: b.id, by: a.id, at: 1 }, (l, c) => a.dev.sign(l, c));
  const ev = evaluate(doc, REALM, BOB, [a.served(), { device: b.id, revoked: { at: 1, by: "device", device: a.id, statement: signed } }]);
  assert.deepEqual(ev.holdDevices, [b.id]);
  assert.equal(ev.revoked[0].trusted, true);
  // The relay admin, or a statement by a key nobody pinned: advisory only.
  const admin = evaluate(doc, REALM, BOB, [a.served(), { device: b.id, revoked: { at: 1, by: "admin" } }]);
  assert.deepEqual([admin.holdDevices, admin.revoked[0].trusted], [[], false]);
  const stranger = await device();
  const bogus = await makeRevocation({ realm: REALM, member: BOB, device: b.id, by: stranger.id, at: 1 }, (l, c) => stranger.dev.sign(l, c));
  assert.deepEqual(evaluate(doc, REALM, BOB, [a.served(), { device: b.id, revoked: { at: 1, by: "device", device: stranger.id, statement: bogus } }]).holdDevices, []);
  // A device revoking itself is not "another pinned device".
  const self = await makeRevocation({ realm: REALM, member: BOB, device: b.id, by: b.id, at: 1 }, (l, c) => b.dev.sign(l, c));
  assert.deepEqual(evaluate(doc, REALM, BOB, [a.served(), { device: b.id, revoked: { at: 1, by: "device", device: b.id, statement: self } }]).holdDevices, []);
});

test("the safety number of a pair changes with any device of either side", async () => {
  const m1 = await device(ME);
  const b1 = await device();
  const b2 = await device();
  const mine = evaluate(null, REALM, ME, [m1.served()]).active;
  const n = pairSafetyNumber(REALM, ME, mine, BOB, evaluate(null, REALM, BOB, [b1.served()]).active);
  assert.equal(pairSafetyNumber(REALM, BOB, evaluate(null, REALM, BOB, [b1.served()]).active, ME, mine), n);
  assert.notEqual(pairSafetyNumber(REALM, ME, mine, BOB, evaluate(null, REALM, BOB, [b1.served(), b2.served()]).active), n);
});

test("pins live in contacts.json under the contacts lock; an unmanaged home refuses instead of becoming managed", async (t) => {
  const managed = tmpDir(t);
  const c = await openContacts(managed, { notify: false });
  const a = await device();
  const rev0 = c.currentPolicy().doc.revision;
  const r = await c.updatePins((doc) => pinFirstUse(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served()]).active));
  assert.equal(r.revision, rev0 + 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(managed, "contacts.json"), "utf8"));
  assert.equal(onDisk.pins[0].member, BOB);
  assert.equal(onDisk.pins[0].devices[0].pin, b64(pinIdentity({ realm: REALM, member: BOB, device: a.id, key: a.key })));
  // An invalid change is refused and the file is unchanged.
  await assert.rejects(c.updatePins((doc) => (doc.pins[0].how = "trust-me")), /how must be/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(managed, "contacts.json"), "utf8")).revision, r.revision);

  const legacy = tmpDir(t);
  fs.mkdirSync(path.join(legacy, "inbox"), { recursive: true }); // an existing install: legacy-allow
  const l = await openContacts(legacy, { notify: false });
  await assert.rejects(l.updatePins(() => {}), /hoptell contacts init/);
  assert.equal(fs.existsSync(path.join(legacy, "contacts.json")), false);
});

test("requireVerified holds incoming messages of an unverified contact too; a new device holds sending only", async () => {
  const a = await device();
  const records = [];
  const queue = { hold: (h) => (records.push(h), `h_${records.length}`) };
  const at = { realm: REALM, member: BOB };
  // No pin, or only relay-tofu, under requireVerified: both directions wait, with the reason.
  for (const pinned of [false, true]) {
    const doc = { ...fresh(), requireVerified: [REALM] };
    if (pinned) pinFirstUse(doc, REALM, BOB, [evaluate(null, REALM, BOB, [a.served()]).active[0]]);
    const ev = evaluate(doc, REALM, BOB, [a.served()]);
    const g = gate(ev, queue, at);
    assert.equal(g.outbound("out").deliver, false);
    const r = g.inbound("in");
    assert.equal(r.deliver, false);
    assert.match(r.reason, /requireVerified/);
  }
  assert.deepEqual(records.map((h) => h.direction), ["out", "in", "out", "in"]);
  // Verified: delivered both ways. A new device: sending holds, receiving does not.
  const doc = fresh();
  pinFirstUse(doc, REALM, BOB, evaluate(null, REALM, BOB, [a.served()]).active);
  doc.pins[0].how = "in-person";
  doc.requireVerified = [REALM];
  assert.equal(gate(evaluate(doc, REALM, BOB, [a.served()]), queue, at).inbound("in").deliver, true);
  const b = await device();
  const ev = evaluate(doc, REALM, BOB, [a.served(), b.served()]);
  assert.equal(gate(ev, queue, at).outbound("out").deliver, false);
  assert.deepEqual(gate(ev, queue, at).inbound("in"), { deliver: true, unverified: false });
});

test("a trusted revocation, once observed, holds until the accepted removal, whatever the relay serves later", async () => {
  const a = await device();
  const b = await device();
  const doc = fresh();
  pinFirstUse(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served(), b.served()]).active);
  const signed = await makeRevocation({ realm: REALM, member: BOB, device: b.id, by: a.id, at: 7 }, (l, c) => a.dev.sign(l, c));
  const ev = evaluate(doc, REALM, BOB, [a.served(), { device: b.id, revoked: { at: 7, by: "device", device: a.id, statement: signed } }]);
  assert.deepEqual(applyRevocations(doc, REALM, BOB, ev), [b.id]);
  assert.deepEqual(validateContacts(doc), []);
  // A later answer drops the revocation record, or serves the device as active again: still held.
  for (const later of [[a.served()], [a.served(), b.served()]]) {
    const again = evaluate(doc, REALM, BOB, later);
    assert.deepEqual(again.holdDevices, [b.id]);
    assert.ok(!again.active.some((d) => d.device === b.id), "a revoked device is never active again");
    assert.equal(again.state, "ok");
  }
  // verify (decide "all") keeps it too.
  decide(doc, REALM, BOB, evaluate(doc, REALM, BOB, [a.served(), b.served()]), { accept: "all", how: "in-person" });
  assert.deepEqual(evaluate(doc, REALM, BOB, [a.served(), b.served()]).holdDevices, [b.id]);
  // 3.3's accepted removal clears it.
  const copy = structuredClone(doc);
  assert.equal(clearRevocation(doc, REALM, BOB, b.id), true);
  assert.deepEqual(evaluate(doc, REALM, BOB, [a.served()]).holdDevices, []);
  assert.deepEqual(validateContacts(doc), []);
  // The helper 3.3 uses clears the revocation and unpins the device together: the relay's lasting
  // revocation record then never brings the hold back, and the id is not pinned for later use.
  assert.equal(retireRemovedDevice(copy, REALM, BOB, b.id), true);
  assert.equal(pinOf(copy, REALM, BOB).revoked, undefined);
  assert.deepEqual(pinOf(copy, REALM, BOB).devices.map((d) => d.device), [a.id]);
  assert.deepEqual(applyRevocations(copy, REALM, BOB, evaluate(copy, REALM, BOB, [a.served(), { device: b.id, revoked: { at: 7, by: "device", device: a.id, statement: signed } }])), [], "an unpinned device is not kept again");
  assert.deepEqual(validateContacts(copy), []);
  const before = JSON.stringify(copy);
  assert.equal(retireRemovedDevice(copy, REALM, BOB, a.id), false, "no kept revocation: nothing changes (an active device stays pinned)");
  assert.equal(JSON.stringify(copy), before);
});

test("held release: a sink that resolves false keeps the message held (another session's)", async (t) => {
  const q = heldQueue({ home: tmpDir(t), profile: "p" });
  q.hold({ realm: REALM, member: BOB, direction: "in", reason: "x", message: { id: "e_1", to: "s1" } });
  q.hold({ realm: REALM, member: BOB, direction: "in", reason: "x", message: { id: "e_2", to: "s2" } });
  assert.ok(q.has("in", "e_1") && !q.has("out", "e_1"));
  assert.deepEqual(q.held(), [{ realm: REALM, member: BOB, direction: "in" }]);
  const got = [];
  assert.equal(await q.release(REALM, BOB, async (m) => (m.to === "s1" ? void got.push(m.id) : false)), 1);
  assert.deepEqual(got, ["e_1"]);
  assert.equal(q.count(REALM, BOB), 1);
  assert.ok(q.has("in", "e_2"));
});

test("kept revocations are never evicted: room is reserved, and an overflow stays latched until groups are rebuilt", async () => {
  const realm = "a".repeat(32);
  const member = `m_${"b".repeat(26)}`;
  const served = (d) => ({ ...d.register(), seq: 0, rotations: [] });
  const signer = await fakeDevice(realm, member);
  const doc = { version: 1, default: "ask", grants: [], blocks: [] };
  pinFirstUse(doc, realm, member, evaluate(doc, realm, member, [served(signer)]).active);
  const revoke = async (victim, i) => {
    const statement = await makeRevocation({ realm, member, device: victim.device, by: signer.device, at: i }, (l, c) => signer.dev.sign(l, c));
    return { device: victim.device, revoked: { at: i, by: "device", statement } };
  };
  let oldest;
  for (let i = 0; i < 98; i++) {
    const victim = await fakeDevice(realm, member);
    oldest ??= victim.device;
    decide(doc, realm, member, evaluate(doc, realm, member, [served(signer), served(victim)]), { how: "in-person" });
    applyRevocations(doc, realm, member, evaluate(doc, realm, member, [served(signer), await revoke(victim, i)]));
    decide(doc, realm, member, evaluate(doc, realm, member, [served(signer)]), { how: "in-person" });
  }
  // Reservation: 98 kept + the signer + one more fits the bound; two more would not.
  const [x, y] = [await fakeDevice(realm, member), await fakeDevice(realm, member)];
  assert.throws(() => decide(doc, realm, member, evaluate(doc, realm, member, [served(signer), served(x), served(y)]), { how: "in-person" }), (e) => e.code === "revocations_full");
  decide(doc, realm, member, evaluate(doc, realm, member, [served(signer), served(x)]), { accept: [x.device], how: "in-person" });
  // An overflow from older state (kept records filled before the reservation existed): latched.
  const p = doc.pins[0];
  while (p.revoked.length < 100) p.revoked.push({ device: newDeviceId(), by: signer.device });
  applyRevocations(doc, realm, member, evaluate(doc, realm, member, [served(signer), await revoke(x, 98)]));
  assert.equal(p.revokedOverflow, true);
  assert.deepEqual(validateContacts(doc), []);
  // A later answer that omits the overflowed revocation does not clear it, nor does a verify.
  applyRevocations(doc, realm, member, evaluate(doc, realm, member, [served(signer)]));
  assert.equal(p.revokedOverflow, true, "latched across a partial answer");
  const late = await fakeDevice(realm, member);
  assert.throws(() => decide(doc, realm, member, evaluate(doc, realm, member, [served(signer), served(late)]), { how: "in-person" }), (e) => e.code === "revocations_full");
  decide(doc, realm, member, evaluate(doc, realm, member, [served(signer)]), { how: "in-person" });
  assert.equal(p.revokedOverflow, true, "latched across a verify");
  const ev = evaluate(doc, realm, member, [served(signer)]);
  assert.equal(ev.state, "stop");
  assert.ok(ev.holdOut && ev.holdIn);
  assert.ok(ev.holdDevices.includes(oldest), "kept holds stay");
  // Only the explicit recovery, after every conversation is rebuilt, ends it.
  assert.throws(() => clearRevocationOverflow(doc, realm, member), (e) => e.code === "groups_not_replaced");
  assert.equal(clearRevocationOverflow(doc, realm, member, { groupsReplaced: true }), true);
  assert.notEqual(evaluate(doc, realm, member, [served(signer)]).state, "stop");
});
