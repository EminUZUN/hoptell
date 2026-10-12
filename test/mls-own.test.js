// Own-device trust (design 3.2 v2.2, amendments-3.5-prep A1), experimental: the own pins in
// contacts.json and their invariants, the crash-safe enrollment order (local record, own baseline,
// then the relay), the upgrade of an older home (the local device the only baseline, the old
// relay-tofu own entry gone and its other devices unconfirmed, their conversations stopped, in one
// atomic write), its remedies, and own devices' rotations and key changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deviceCommand, deviceDecision, fetchDevices, ownDoctor, retireDevice, verifyCommand } from "../lib/mls/cli.js";
import { createE2ee } from "../lib/mls/e2ee.js";
import { pairSafetyNumber } from "../lib/mls/trust.js";
import { validateContacts } from "../lib/contacts.js";
import { b64, newDeviceId, pinIdentity } from "../lib/mls/identity.js";
import { acceptOwn, checkOwn, evaluateOwn, writeBaseline } from "../lib/mls/own.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { acceptOwnDevices, deviceRelay, e2eeDevice, fakeDevice, memoryContacts, ownFor, tmpDir, until } from "./mls-helpers.js";

const REALM = "a".repeat(32);
const REALM2 = "c".repeat(32);
const ME = `m_${"m".repeat(26)}`;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const FAKE = new URL("./fake-mls-driver.js", import.meta.url).pathname;

/** A local device record (device.json's public part) of member ME in `realm`. */
async function localRecord(realm = REALM, seed = "own") {
  const d = await fakeDevice(realm, ME, { driver: createFakeDriver({ seed }) });
  return { realm, member: ME, device: d.device, key: b64(d.key), pin: b64(pinIdentity({ realm, member: ME, device: d.device, key: d.key })), seq: 0, retiredKeys: [], d };
}
const fresh = () => ({ version: 1, revision: 0, default: "ask", grants: [], blocks: [] });

test("A1 schema: own pins per realm, with the invariants checked on every read", async () => {
  const doc = fresh();
  const p1 = await localRecord(REALM, "p1");
  const p2 = await localRecord(REALM2, "p2");
  writeBaseline(doc, { rec: p1, profile: "work", now: 1 });
  writeBaseline(doc, { rec: p2, profile: "home", now: 2 });
  assert.deepEqual(validateContacts(doc), [], "two profiles in two realms, each with its own enrolled device");
  assert.deepEqual(Object.keys(doc.own).sort(), [REALM, REALM2]);
  // After an acceptance: one local enrolled device plus one accepted own device in a realm.
  const other = await localRecord(REALM, "other");
  acceptOwn(doc, REALM, { device: other.device, key: other.d.key, pin: Buffer.from(other.pin, "base64"), seq: 0 }, { by: p1.device, now: 3 });
  assert.deepEqual(validateContacts(doc), []);
  assert.deepEqual(doc.own[REALM].devices.map((d) => [d.how, d.by ?? null]), [["enrolled", null], ["accepted", p1.device]]);
  // Each invariant refuses the document.
  const broken = (mutate) => {
    const d = structuredClone(doc);
    mutate(d);
    return validateContacts(d);
  };
  assert.match(broken((d) => (d.own[REALM].devices[1].how = "enrolled", delete d.own[REALM].devices[1].by)).join(), /exactly one enrolled device/);
  assert.match(broken((d) => d.own[REALM].unconfirmed.push({ ...structuredClone(d.own[REALM].devices[1]), how: undefined, at: undefined, by: undefined, seen: 1 }) && d.own[REALM].unconfirmed.forEach((u) => Object.keys(u).forEach((k) => u[k] === undefined && delete u[k]))).join(), /listed twice/);
  assert.match(broken((d) => (d.own[REALM].devices[1].key = b64(Buffer.alloc(32, 7)))).join(), /pin does not match/);
  assert.match(broken((d) => (d.pins = [{ realm: REALM, member: ME, devices: [], verifiedAt: "x", how: "relay-tofu" }])).join(), /must not be in pins/);
  assert.match(broken((d) => (d.own[REALM].devices[0].how = "relay-tofu")).join(), /how must be/);
  assert.deepEqual(checkOwn(doc), []);
});

test("A1 enrollment order: local record, then the own baseline, then the relay; a crash after each step resumes to the same single enrolled device", async (t) => {
  for (const point of ["after-record", "after-baseline", "device_register"]) {
    const w = await deviceRelay(t);
    const dir = tmpDir(t);
    const contacts = memoryContacts();
    let armed = true;
    const fault = (p) => {
      if (armed && p === point) {
        armed = false;
        throw new Error(`crash at ${p}`);
      }
    };
    const { deviceStore } = await import("../lib/mls/device.js");
    const make = () => deviceStore({ home: dir, profile: "relay-test", driver: createFakeDriver({ seed: dir, now: w.clock.now }), store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, "relay-test"), fault });
    const client = await w.client("alice");
    if (point === "device_register") {
      // The relay's answer to the registration is lost (the third step): it runs again.
      const rpc = client.rpc.bind(client);
      client.rpc = (f) => (f.type === "device_register" && armed ? ((armed = false), Promise.reject(Object.assign(new Error("crash at device_register"), { kind: "lost" }))) : rpc(f));
    }
    await assert.rejects(make().enroll(client), /crash at/);
    const local = make().record();
    assert.ok(local, `${point}: the local record is durable first`);
    if (point === "after-record") {
      assert.equal(contacts.doc.own, undefined, "no baseline yet");
      assert.equal((await client.rpc({ type: "device_list" })).devices.length, 0, "nothing registered without the baseline");
    }
    const r = await make().enroll(client);
    assert.equal(r.device, local.device, `${point}: resumed with the same device`);
    const own = contacts.doc.own[w.realm];
    assert.deepEqual(own.devices.map((d) => [d.device, d.how]), [[local.device, "enrolled"]], `${point}: one enrolled device, the local one`);
    assert.equal(own.devices[0].key, local.key, "its key is the locally held key");
    assert.deepEqual((await client.rpc({ type: "device_list" })).devices.map((d) => d.device), [local.device]);
  }
});

/** alice (a1, a2: both accepted) and bob, one conversation holding all three devices. */
async function threeDevices(t, opts = {}) {
  const w = await deviceRelay(t, { e2ee: true });
  const a1 = await e2eeDevice(t, w, "alice", opts);
  const a2 = await e2eeDevice(t, w, "alice", { sessions: [] });
  await acceptOwnDevices(a1, a2);
  const bob = await e2eeDevice(t, w, "bob");
  assert.equal((await a1.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "before" })).state, "accepted");
  await until(() => bob.s.bob.got.length === 1, "first");
  const gid = (await a1.s.alice.e2ee.checkpoint(bob.id)).group;
  assert.ok(w.ds.roster(gid).some((d) => d.device === a2.device));
  return { w, a1, a2, bob, gid };
}
/** Turn a1's contacts into what next 0b85af5 wrote: no own entry, a relay-tofu pin entry for the own member. */
function asOldHome(a1, ...devices) {
  const doc = a1.contacts.doc;
  const e = doc.own[doc.encryption[0].realm];
  const realm = doc.encryption[0].realm;
  const rec = (x) => e.devices.find((d) => d.device === x.device);
  doc.pins = [...(doc.pins ?? []), { realm, member: a1.id, devices: devices.map((x) => ({ device: rec(x).device, pin: rec(x).pin, key: rec(x).key, seq: rec(x).seq })), verifiedAt: new Date(0).toISOString(), how: "relay-tofu" }];
  delete doc.own;
  assert.deepEqual(validateContacts(doc), []);
}

test("A1 upgrade: the local device becomes the only enrolled own device, the old relay-tofu entry goes, its other devices are unconfirmed and their conversations stop, in one write; accept resumes", async (t) => {
  const { w, a1, a2, bob, gid } = await threeDevices(t);
  asOldHome(a1, a1, a2);
  const revision = a1.contacts.doc.revision;
  // A crash during the upgrade (the write fails): nothing changes, and the next start upgrades once.
  const update = a1.contacts.updatePins;
  a1.contacts.updatePins = async () => {
    a1.contacts.updatePins = update;
    throw new Error("crash during the upgrade");
  };
  await assert.rejects(a1.open("alice-crash"), /crash during the upgrade/);
  assert.equal(a1.contacts.doc.own, undefined);
  const s = await a1.open("alice-2");
  const doc = a1.contacts.doc;
  assert.equal(doc.revision, revision + 1, "one atomic write");
  const own = doc.own[w.realm];
  assert.deepEqual(own.devices.map((d) => [d.device, d.how]), [[a1.device, "enrolled"]]);
  assert.equal(own.devices[0].key, a1.store.record().key, "the locally held key");
  assert.deepEqual(own.unconfirmed.map((d) => d.device), [a2.device]);
  assert.equal(typeof own.upgradedAt, "number");
  assert.equal(doc.pins?.some((p) => p.member === a1.id) ?? false, false, "the old own pin entry is gone");
  // Idempotent: another start changes nothing.
  await a1.open("alice-3");
  assert.equal(a1.contacts.doc.revision, revision + 1);
  // The conversation holding the unconfirmed device is stopped: no send, no commit.
  const before = w.db.get("SELECT count(*) AS n FROM e2ee_log").n;
  const held = await s.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "stopped" });
  assert.equal(held.state, "held");
  assert.match(held.reason, /not accepted/);
  await assert.rejects(s.e2ee.update(bob.id), (e) => e.code === "held_own");
  assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_log").n, before, "no commit");
  await settle();
  assert.equal(bob.s.bob.got.length, 1);
  // The owner accepts it (hoptell device accept): the conversation resumes, the message goes once.
  await acceptOwnDevices(a1, a2);
  await s.e2ee.recover();
  await until(() => bob.s.bob.got.length === 2, "resumed");
  assert.equal(bob.s.bob.got[1].text, "stopped");
  assert.ok(w.ds.roster(gid).some((d) => d.device === a2.device), "kept");
});

test("A1 upgrade remedies: a device-signed revocation removes the unconfirmed device with one commit (signing capability); without it, a relay-admin revocation then the removal", async (t) => {
  for (const how of ["signed", "admin"]) {
    const { w, a1, a2, bob, gid } = await threeDevices(t);
    asOldHome(a1, a1, a2);
    const s = await a1.open("alice-2");
    assert.equal((await s.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "stopped" })).state, "held");
    if (how === "signed") {
      // The fake driver signs (a binding with SignWithLabel, A3): a1 revokes a2 itself.
      assert.notEqual(a1.driver.signing, false);
      await a1.store.revoke(await w.client("alice"), a2.device);
    } else w.directory.revoke({ member: a1.id, device: a2.device, by: { kind: "admin" } });
    const commits = w.db.get("SELECT count(*) AS n FROM e2ee_log WHERE group_id = ?", gid).n;
    await s.e2ee.recover();
    await until(() => bob.s.bob.got.length === 2, `${how}: sent after the removal`);
    assert.ok(!w.ds.roster(gid).some((d) => d.device === a2.device), `${how}: removed`);
    assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_log WHERE group_id = ?", gid).n, commits + 1, `${how}: with one commit`);
    assert.deepEqual(a1.contacts.doc.own[w.realm].unconfirmed, [], `${how}: no longer unconfirmed once removed`);
  }
});

test("A1 upgrade: a relay that lists no own device (or deletes the rows) never resets the baseline", async (t) => {
  const { w, a1, a2 } = await threeDevices(t);
  asOldHome(a1, a1, a2);
  // The relay hides every own device from a1.
  const client = await w.client("alice", { session: "alice-hidden" });
  const rpc = client.rpc.bind(client);
  client.rpc = async (f) => (f.type === "device_list" && (f.member === undefined || f.member === a1.id) ? { ...(await rpc(f)), devices: [] } : rpc(f));
  const s = a1.engine(client, "alice-hidden");
  await s.e2ee.attach();
  const own = a1.contacts.doc.own[w.realm];
  assert.deepEqual(own.devices.map((d) => d.device), [a1.device], "the baseline is the local device");
  assert.deepEqual(own.unconfirmed.map((d) => d.device), [a2.device], "the old pins still go to unconfirmed, from local state only");
  const ev = evaluateOwn(own, w.realm, []);
  assert.deepEqual(ev.missing.map((d) => d.device), [a1.device], "missing, never dropped");
  await s.e2ee.attach();
  assert.deepEqual(a1.contacts.doc.own[w.realm].devices.map((d) => d.device), [a1.device]);
});

test("A1: an accepted own device rotates along its own record's chain; another key under the same id stops sending", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a1 = await e2eeDevice(t, w, "alice");
  const a2 = await e2eeDevice(t, w, "alice", { sessions: [] });
  await acceptOwnDevices(a1, a2);
  const bob = await e2eeDevice(t, w, "bob");
  // a2 rotates before it joins any conversation (the binding cannot rotate in active groups, A2/A3).
  await a2.store.rotate(await w.client("alice"));
  const rotated = a2.store.record();
  assert.equal(rotated.seq, 1);
  assert.equal((await a1.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "after the rotation" })).state, "accepted");
  await until(() => bob.s.bob.got.length === 1, "delivered");
  const pinned = a1.contacts.doc.own[w.realm].devices.find((d) => d.device === a2.device);
  assert.deepEqual([pinned.key, pinned.seq, pinned.retired.length], [rotated.key, 1, 1], "the chain was followed from a1's own record");
  const gid = (await a1.s.alice.e2ee.checkpoint(bob.id)).group;
  assert.ok(w.ds.roster(gid).some((d) => d.device === a2.device));
  // The relay serves another key under a2's id (no rotation): a key change, sending stops.
  const forged = await fakeDevice(w.realm, a1.id, { device: a2.device });
  w.db.tx((h) => {
    h.run("UPDATE devices SET sig_key = ?, pin = ? WHERE device_id = ?", forged.key, pinIdentity({ realm: w.realm, member: a1.id, device: a2.device, key: forged.key }), a2.device);
    h.run("DELETE FROM device_rotations WHERE device_id = ?", a2.device);
  });
  const r = await a1.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "must not go" });
  assert.equal(r.state, "held");
  assert.match(r.reason, /changed without a valid rotation/);
  await settle();
  assert.equal(bob.s.bob.got.length, 1);
  assert.equal(a1.contacts.doc.own[w.realm].devices.find((d) => d.device === a2.device).key, rotated.key, "the pin is not replaced");
});

test("A1: a home without managed contacts has no baseline: nothing enrolls (and the relay hears nothing)", async (t) => {
  const w = await deviceRelay(t);
  const { deviceStore } = await import("../lib/mls/device.js");
  const dir = tmpDir(t);
  const store = deviceStore({ home: dir, profile: "relay-test", driver: createFakeDriver({ seed: dir }), store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now });
  const client = await w.client("alice");
  await assert.rejects(store.enroll(client), (e) => e.code === "no_baseline");
  assert.equal((await client.rpc({ type: "device_list" })).devices.length, 0);
  assert.equal(newDeviceId().length, 26);
});

// ---- the malicious relay (A1's blocking tests), end to end through the e2ee engine ----------------

/** The relay's lists for a verify by `d` of `member`, and the decision view (lib/mls/cli.js). */
async function decisionOf(w, d, member) {
  const lists = await fetchDevices(() => w.client(d.member), member);
  return deviceDecision({ sub: "verify", member, ...lists, doc: d.contacts.doc });
}
/** `d` verifies `peer` as an owner would, in person (show, then confirm with the code shown). */
async function verifyAs(w, d, peer) {
  const opts = { sub: "verify", member: peer.id, home: d.dir, profile: d.profile, connect: () => w.client(d.member), contacts: d.contacts };
  const out = [];
  await verifyCommand({ ...opts, say: (x) => out.push(x) });
  const code = /--set ([0-9a-f]{32})/.exec(out.at(-1))?.[1];
  assert.ok(code, out.join("\n"));
  await verifyCommand({ ...opts, yes: true, how: "in-person", set: code, say: () => {} });
}
/** A device X of `member` enrolled at the relay by someone else (the relay itself, or a stolen credential), with KeyPackages. */
async function intruder(w, member) {
  const x = await fakeDevice(w.realm, w.members[member].id);
  const c = await w.client(member);
  // A9: the credential holder holds X's key, so it proves it (registration, then attachment).
  await x.registerOn(c);
  await x.attachOn(c);
  await c.rpc({ type: "kp_upload", device: x.device, packages: await x.packages(5, w.clock.now() + 10 * 86_400_000) });
  return x;
}
const appsTo = (w, member, device) => w.ds.pending({ member, device, limit: 100 });

test("A1 malicious relay: an extra own device X of A shown to both sides; A's verify refuses, A never adds X, B's number differs from A's", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "before X" });
  await until(() => a.s.alice.got.length === 1, "first");
  const x = await intruder(w, "alice");
  // A's verify of B refuses: the relay lists a device of A's that A has not accepted.
  const opts = { sub: "verify", member: b.id, home: a.dir, profile: a.profile, connect: () => w.client("alice"), contacts: a.contacts };
  const shown = [];
  await assert.rejects(verifyCommand({ ...opts, say: (s) => shown.push(s) }), (e) => e.message.includes(`the relay lists device ${x.device} of yours that you have not accepted: accept it from one of your devices (hoptell device accept ${x.device}) or revoke it`));
  assert.ok(!shown.some((s) => s.startsWith("Safety number")), "no number to compare");
  assert.ok(shown.some((s) => s.includes(x.device) && s.includes("not accepted")), "both sets shown, X marked");
  // A's conversations never add X.
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after X" })).state, "accepted");
  await until(() => b.s.bob.got.length === 1, "delivered");
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  assert.ok(!w.ds.roster(gid).some((d) => d.device === x.device), "X is not in A's group");
  // Doctor reports it (from what the engine saw).
  const lines = ownDoctor({ home: a.dir, profile: a.profile, rec: a.store.record() }).map(([, text]) => text).join("\n");
  assert.match(lines, new RegExp(`the relay lists device ${x.device} of yours .* that you have not accepted`));
  // B's verify shows a number for A's devices including X; A's own pins give another number.
  const bv = (await decisionOf(w, b, a.id)).view;
  assert.ok(bv.devices.some((d) => d.device === x.device && d.state === "new"));
  const ownPins = a.contacts.doc.own[w.realm].devices.map((d) => ({ pin: Buffer.from(d.pin, "base64") }));
  const bList = await (await w.client("alice")).rpc({ type: "device_list", member: b.id });
  const aNumber = pairSafetyNumber(w.realm, a.id, ownPins, b.id, bList.devices.map((d) => ({ pin: Buffer.from(d.pin, "base64") })));
  assert.ok(bv.safetyNumber);
  assert.notEqual(bv.safetyNumber, aNumber, "an honest comparison cannot complete");
});

test("A1 malicious relay: B verified A before X appeared, or requireVerified is on: B sends no Welcome and no message to X", async (t) => {
  for (const how of ["verified", "requireVerified"]) {
    const w = await deviceRelay(t, { e2ee: true });
    const a = await e2eeDevice(t, w, "alice");
    const b = await e2eeDevice(t, w, "bob");
    if (how === "verified") {
      await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "first use" });
      await until(() => a.s.alice.got.length === 1, "first");
      await verifyAs(w, b, a);
    } else await b.contacts.updatePins((doc) => void (doc.requireVerified = [w.realm]));
    const x = await intruder(w, "alice");
    const r = await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "not for X" });
    assert.equal(r.state, "held", how);
    await settle();
    assert.deepEqual(appsTo(w, a.id, x.device), [], `${how}: nothing at all queued for X (no Welcome, no message)`);
  }
});

test("A1 documented limit (first use): with B unverified and requireVerified off, B's first-use traffic includes the relay's extra device X", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  const x = await intruder(w, "alice");
  // LIMIT (design 3.2 v2.2, A1, kept as is): own pins control only the owner's own sending; a peer
  // that has not verified the owner takes the relay's list on first use (relay-tofu).
  assert.equal((await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "first use" })).state, "accepted");
  const gid = (await b.s.bob.e2ee.checkpoint(a.id)).group;
  assert.ok(w.ds.roster(gid).some((d) => d.device === x.device), "the documented first-use limit: X is in B's group");
  assert.ok(appsTo(w, a.id, x.device).some((f) => f.kind === "welcome"), "and X is sent the Welcome");
  // A's own device does not follow: the group holding X waits for A's decision.
  const r = await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "from A" });
  assert.equal(r.state, "held");
});

test("A1 accept flow: a second own device accepted from the first joins A's conversations; B sees it as a new device of A, held until B accepts", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "one" });
  await until(() => b.s.bob.got.length === 1, "first");
  const a2 = await e2eeDevice(t, w, "alice", { sessions: [] });
  // Not accepted yet: A's conversations do not add it.
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "two" });
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  assert.ok(!w.ds.roster(gid).some((d) => d.device === a2.device));
  // hoptell device accept on a (show, then --set), and on a2 the other direction.
  await acceptCli(w, a, a2.device);
  await acceptCli(w, a2, a.device);
  assert.deepEqual(a.contacts.doc.own[w.realm].devices.map((d) => [d.device, d.how, d.by ?? null]), [[a.device, "enrolled", null], [a2.device, "accepted", a.device]]);
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "three" });
  await until(() => w.ds.roster(gid).some((d) => d.device === a2.device), "a2 added to A's conversation");
  // B pinned A's devices on first use: a2 is a new device of A, sending to A is held.
  const r = await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "held" });
  assert.equal(r.state, "held");
  assert.match(r.reason, /new device/);
});

/** `hoptell device accept <device>` on test device `d` (show, then confirm with the code shown). */
async function acceptCli(w, d, device) {
  const env = { HOPTELL_MLS_DRIVER: FAKE, HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: "correct horse battery staple" };
  const out = [];
  const base = { home: d.dir, profile: d.profile, env, connect: () => w.client(d.member), contacts: d.contacts };
  await deviceCommand({ ...base, args: ["accept", device], say: (x) => out.push(x) });
  const code = /--set ([0-9a-f]{32})/.exec(out.at(-1))?.[1];
  assert.ok(code, out.join("\n"));
  await deviceCommand({ ...base, args: ["accept", device, "--set", code], say: (x) => out.push(x) });
  return out;
}

test("A1/A4 verify: a pinned peer device the relay omits is shown as missing, never dropped; re-pinning is refused until forget-device or its return", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  const b2 = await e2eeDevice(t, w, "bob", { sessions: [] });
  await acceptOwnDevices(b, b2);
  await verifyAs(w, a, b);
  // The relay stops listing b2 to alice (a missing row, not a revocation).
  const hidden = new Set([b2.device]);
  const connect = () => hiding(w, "alice", hidden);
  const decision = async () => deviceDecision({ sub: "verify", member: b.id, ...(await fetchDevices(connect, b.id)), doc: a.contacts.doc });
  const v = (await decision()).view;
  assert.deepEqual(v.devices.find((d) => d.device === b2.device)?.state, "missing", "shown as missing");
  assert.ok(v.blocked);
  const opts = { sub: "verify", member: b.id, home: a.dir, profile: a.profile, connect, contacts: a.contacts };
  const out = [];
  await verifyCommand({ ...opts, say: (x) => out.push(x) });
  assert.ok(out.some((x) => x.includes(b2.device) && x.includes("missing")));
  assert.ok(!out.some((x) => /--set/.test(x)), "no confirmation is offered");
  await assert.rejects(verifyCommand({ ...opts, yes: true, how: "in-person", set: "0".repeat(32), say: () => {} }), /nothing is pinned/);
  assert.ok(a.contacts.doc.pins.find((p) => p.member === b.id).devices.some((d) => d.device === b2.device), "still pinned");
  // It returns: verify works again.
  hidden.clear();
  assert.equal((await decision()).view.blocked, null);
  // Gone again: the owner forgets it (the only owner-driven removal).
  hidden.add(b2.device);
  const f = [];
  const fopts = { sub: "forget-device", member: b.id, device: b2.device, home: a.dir, profile: a.profile, connect, contacts: a.contacts };
  await verifyCommand({ ...fopts, say: (x) => f.push(x) });
  const code = /--set ([0-9a-f]{32})/.exec(f.at(-1))?.[1];
  assert.ok(code, f.join("\n"));
  await verifyCommand({ ...fopts, set: code, say: () => {} });
  assert.ok(!a.contacts.doc.pins.find((p) => p.member === b.id).devices.some((d) => d.device === b2.device), "forgotten");
  assert.equal((await decision()).view.blocked, null);
  // A device the relay still lists is never forgotten.
  const kept = [];
  await verifyCommand({ ...fopts, device: b.device, set: "0".repeat(32), say: (x) => kept.push(x) });
  assert.match(kept.join("\n"), /is not missing/);
  assert.ok(a.contacts.doc.pins.find((p) => p.member === b.id).devices.some((d) => d.device === b.device));
});

/** A client of `member` whose relay omits the devices in `hidden` from every device list. */
async function hiding(w, member, hidden) {
  const c = await w.client(member);
  const rpc = c.rpc.bind(c);
  c.rpc = async (f) => {
    const r = await rpc(f);
    return f.type === "device_list" ? { ...r, devices: r.devices.filter((d) => !hidden.has(d.device)) } : r;
  };
  return c;
}

test("A1 new baseline: a new device id (peers see a new device, held), the old ids stay pinned on their side and missing", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "one" });
  await until(() => a.s.alice.got.length === 1, "first");
  const old = a.device;
  // Every own device is lost: a new baseline on the owner's explicit confirmation only.
  const c = await w.client("alice");
  await a.store.retire("lost");
  await assert.rejects(a.store.enroll(c), (e) => e.code === "baseline_mismatch", "never a new baseline without --new-baseline");
  const r = await a.store.enroll(c, { newBaseline: true });
  assert.notEqual(r.device, old, "a new device id, not a key change of the old one");
  assert.deepEqual(a.contacts.doc.own[w.realm].devices.map((d) => [d.device, d.how]), [[r.device, "enrolled"]]);
  w.directory.revoke({ member: a.id, device: old, by: { kind: "admin" } });
  w.db.tx((h) => h.run("DELETE FROM device_revocations WHERE device_id = ?", old));
  w.db.tx((h) => h.run("DELETE FROM devices WHERE device_id = ?", old));
  // B: the new id is a new device of A (held); the old one stays pinned, shown as missing.
  const s = await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "two" });
  assert.equal(s.state, "held");
  const v = (await decisionOf(w, b, a.id)).view;
  assert.equal(v.devices.find((d) => d.device === r.device)?.state, "new");
  assert.equal(v.devices.find((d) => d.device === old)?.state, "missing");
  assert.ok(b.contacts.doc.pins.find((p) => p.member === a.id).devices.some((d) => d.device === old), "still pinned on B's side");
});

test("A1 one device per home and realm: a second profile is refused at enrollment; an older home with two stops both until one is retired", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  await assert.rejects(e2eeDevice(t, w, "alice", { dir: a.dir, contacts: a.contacts, profile: "second" }), /already has a device in realm .*, profile relay-test: one device per home and realm/);
  assert.equal(fs.existsSync(path.join(a.dir, "mls", "second", "device.json")), false, "refused before anything is written");
  // An older home (before this rule): a second profile's device in the same realm, no own entry yet.
  const other = await e2eeDevice(t, w, "alice", { sessions: [], profile: "second" });
  fs.cpSync(path.join(other.dir, "mls", "second"), path.join(a.dir, "mls", "second"), { recursive: true });
  fs.cpSync(path.join(other.dir, "credentials"), path.join(a.dir, "credentials"), { recursive: true });
  delete a.contacts.doc.own;
  await assert.rejects(a.open("alice-2"), (e) => e.code === "realm_conflict" && /relay-test, second/.test(e.message));
  const { deviceStore } = await import("../lib/mls/device.js");
  const second = deviceStore({ home: a.dir, profile: "second", driver: other.driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(a.contacts, a.dir, "second") });
  const e2 = createE2ee({ store: second, driver: other.driver, client: await w.client("alice", { session: "alice-second" }), session: "alice-second", home: a.dir, profile: "second", contacts: a.contacts, now: w.clock.now });
  t.after(() => e2.close());
  await assert.rejects(e2.attach(), (e) => e.code === "realm_conflict");
  assert.equal(a.contacts.doc.own, undefined, "nothing written for that realm");
  assert.match(ownDoctor({ home: a.dir, profile: "relay-test", rec: a.store.record() }).map(([, x]) => x).join("\n"), /one device per home and realm/);
  // The owner retires the second profile's device (hoptell device retire): the remaining one upgrades.
  await retireDevice({ store: second, contacts: a.contacts, profile: "second" });
  assert.equal(second.record().status, "retired");
  // The retired profile's engine (still running, reconnecting) never claims the realm back.
  const e3 = createE2ee({ store: second, driver: other.driver, client: await w.client("alice", { session: "alice-second-2" }), session: "alice-second-2", home: a.dir, profile: "second", contacts: a.contacts, now: w.clock.now });
  t.after(() => e3.close());
  await assert.rejects(e3.attach(), (e) => e.code === "no_baseline");
  assert.equal(a.contacts.doc.own, undefined, "a retired device writes no baseline");
  await a.open("alice-3");
  assert.deepEqual(a.contacts.doc.own[w.realm].devices.map((d) => d.device), [a.device]);
  assert.equal(a.contacts.doc.own[w.realm].profile, "relay-test");
});

test("A1 retire (Codex guard): retiring the sole own device of a realm keeps its baseline, retired; a plain enroll is refused, --new-baseline works and keeps it in history", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "before" });
  await until(() => b.s.bob.got.length === 1, "first");
  const old = a.device;
  const before = structuredClone(a.contacts.doc.own[w.realm]);
  const r = await retireDevice({ store: a.store, contacts: a.contacts, profile: a.profile });
  assert.equal(r.baseline, true);
  const own = a.contacts.doc.own[w.realm];
  assert.equal(typeof own.retiredAt, "number", "kept, marked retired");
  assert.deepEqual(own.devices, before.devices, "the own-device record is kept as it was");
  // Its conversations stop here: the retired device sends nothing.
  await assert.rejects(a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after" }), (e) => e.code === "not_allowed");
  // A plain enroll never makes a fresh baseline silently, and writes nothing.
  const c = await w.client("alice");
  await assert.rejects(a.store.enroll(c), (e) => e.code === "baseline_retired");
  assert.equal(a.store.record().device, old, "no new device was created");
  assert.deepEqual(a.contacts.doc.own[w.realm].devices, before.devices);
  // The explicit recovery: a new device id, the old baseline kept for review.
  const n = await a.store.enroll(c, { newBaseline: true });
  assert.notEqual(n.device, old);
  const fresh = a.contacts.doc.own[w.realm];
  assert.deepEqual(fresh.devices.map((d) => [d.device, d.how]), [[n.device, "enrolled"]]);
  assert.equal(fresh.retiredAt, undefined);
  assert.equal(fresh.history.length, 1);
  assert.deepEqual(fresh.history[0].devices.map((d) => d.device), [old]);
  assert.equal(typeof fresh.history[0].retiredAt, "number");
  assert.deepEqual(validateContacts(a.contacts.doc), []);
  const s = await a.open("alice-new");
  assert.equal((await s.e2ee.send({ to: { member: b.id, session: "bob" }, body: "from the new baseline" })).state, "held", "bob sees a new device of alice: held until he accepts it");
});

test("A1 retire (Codex guard): retiring a duplicate profile removes only that profile's state; the other profile's own entry stays intact", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const other = await e2eeDevice(t, w, "alice", { sessions: [], profile: "second" });
  fs.cpSync(path.join(other.dir, "mls", "second"), path.join(a.dir, "mls", "second"), { recursive: true });
  fs.cpSync(path.join(other.dir, "credentials"), path.join(a.dir, "credentials"), { recursive: true });
  const before = structuredClone(a.contacts.doc.own);
  await assert.rejects(a.open("alice-2"), (e) => e.code === "realm_conflict");
  const { deviceStore } = await import("../lib/mls/device.js");
  const second = deviceStore({ home: a.dir, profile: "second", driver: other.driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(a.contacts, a.dir, "second") });
  const r = await retireDevice({ store: second, contacts: a.contacts, profile: "second" });
  assert.equal(r.baseline, false, "the duplicate held no own entry");
  assert.deepEqual(a.contacts.doc.own, before, "the remaining profile's own authority is untouched");
  assert.equal(a.store.record().status, "active");
  await a.open("alice-3");
  assert.deepEqual(a.contacts.doc.own, before);
});
