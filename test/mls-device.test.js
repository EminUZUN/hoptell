// This home's device (design 3.2, experimental), with the fake driver: enrollment durable before
// registration, the encrypted state and its key in the credential store, replenishment, the
// Welcome replay record and its atomic consumption (implementation note 2), rotation, revocation
// from another device, and the supported restore and migrate paths (retired first; a copy on
// another machine cannot send).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deviceStore } from "../lib/mls/device.js";
import { checkKeyPackage, evaluate, pinFirstUse } from "../lib/mls/trust.js";
import { DAY, HOUR, KP_LIFETIME_MS } from "../lib/mls/policy.js";
import { createFakeDriver, fakeWelcome } from "./fake-mls-driver.js";
import { deviceRelay, refusal, tmpDir } from "./mls-helpers.js";

const PASS = "correct horse battery staple";

/** A home of `member` on machine `machine`, with its device store and a relay client. */
async function home(t, w, member, { machine = "machine-a", dir = tmpDir(t), seed = `${member}-${machine}-${dir}`, faults, fault = null } = {}) {
  const driver = createFakeDriver({ seed, now: w.clock.now, faults });
  const store = deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: PASS, keychainBackend: null, machine, now: w.clock.now, fault });
  const client = await w.client(member);
  return { dir, driver, store, client };
}

test("enroll: durable before registration, the state encrypted, its key in the credential store, 20 KeyPackages", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  // The registration's answer is lost: the device stays pending, and enroll resumes with the same id.
  const rpc = a.client.rpc.bind(a.client);
  let lose = true;
  a.client.rpc = (f) => (f.type === "device_register" && lose ? ((lose = false), Promise.reject(Object.assign(new Error("lost"), { kind: "lost" }))) : rpc(f));
  await assert.rejects(a.store.enroll(a.client), /lost/);
  const pending = a.store.record();
  assert.equal(pending.status, "pending");
  const r = await a.store.enroll(a.client);
  assert.equal(r.device, pending.device, "the same device resumes");
  assert.equal(r.published, 20);
  const rec = a.store.record();
  assert.equal(rec.status, "active");
  assert.equal(rec.member, w.members.alice.id);
  assert.equal(rec.realm, w.realm);
  assert.match(rec.fingerprint, /^(\d{5} ){11}\d{5}$/);
  const raw = fs.readFileSync(path.join(a.dir, "mls", "relay-test", "device.json"), "utf8");
  assert.doesNotMatch(raw, /"seed"|fake-kp/, "the library state is not in the clear");
  assert.ok(fs.existsSync(path.join(a.dir, "credentials", `${rec.account}.json`)), "its key is in the credential store (kind device)");
  assert.equal(fs.statSync(path.join(a.dir, "mls", "relay-test", "device.json")).mode & 0o077, 0);
  const listed = await a.client.rpc({ type: "device_list" });
  assert.deepEqual(listed.devices.map((d) => [d.device, d.pin]), [[rec.device, rec.pin]]);
  // Running it again only tops up; a client of another member is refused.
  assert.equal((await a.store.enroll(a.client)).created, false);
  const bob = await w.client("bob");
  await assert.rejects(a.store.replenish(bob), /belongs to member/);
});

test("one writer per device: concurrent enrollments make one device", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const other = deviceStore({ home: a.dir, profile: "relay-test", driver: a.driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "machine-a", now: w.clock.now });
  const [x, y] = await Promise.all([a.store.enroll(a.client), other.enroll(a.client)]);
  assert.equal(x.device, y.device);
  assert.equal((await a.client.rpc({ type: "device_list" })).devices.length, 1);
});

test("replenishment: below 5 the pool is filled to 20 outstanding, at a bounded rate; a lost upload is repeated, not doubled", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const b = await home(t, w, "bob");
  await a.store.enroll(a.client);
  const { device } = await b.store.enroll(b.client);
  const bobId = w.members.bob.id;
  for (let i = 0; i < 17; i++) await a.client.rpc({ type: "kp_take", request: `req-replenish-${i}`, device: a.store.record().device, target: { member: bobId, device } });
  assert.equal((await b.store.replenish(b.client)).published, 0, "within the rate bound nothing is published");
  w.clock.advance(60_000);
  assert.equal((await b.store.replenish(b.client)).published, 0, "3 available + 17 reserved: 20 outstanding already");
  // The reservations are abandoned: after an hour they burn, and the pool is refilled.
  w.clock.advance(HOUR + 1);
  w.directory.sweep();
  // The upload's answer is lost after the relay stored it.
  const rpc = b.client.rpc.bind(b.client);
  let lose = true;
  b.client.rpc = async (f) => {
    const r = await rpc(f);
    if (f.type === "kp_upload" && lose) {
      lose = false;
      throw Object.assign(new Error("lost"), { kind: "lost" });
    }
    return r;
  };
  await assert.rejects(b.store.replenish(b.client), /lost/);
  const again = await b.store.replenish(b.client);
  assert.equal(again.published, 0, "the same bytes again: nothing new");
  const st = await b.client.rpc({ type: "kp_status", device });
  assert.deepEqual([st.available, st.reserved], [20, 0]);
  assert.equal(Object.keys(b.store.record().kps).length, 37, "every package made is in the ledger");
  // With room in the pool (10 taken and burned), packages nearing their expiry are renewed even
  // though 10 are still available; the bound of 20 outstanding holds throughout.
  for (let i = 0; i < 10; i++) await a.client.rpc({ type: "kp_take", request: `req-renew-${i}`, device: a.store.record().device, target: { member: bobId, device } });
  w.clock.advance(KP_LIFETIME_MS - 2 * DAY);
  w.directory.sweep();
  const renewed = await b.store.replenish(b.client);
  assert.equal(renewed.published, 10);
  const after = await b.client.rpc({ type: "kp_status", device });
  assert.equal(after.available + after.reserved, 20);
});

test("implementation note 2: a Welcome is consumed atomically; replayed, unknown and expired ones are refused", async (t) => {
  const faults = new Set();
  let failWrite = false;
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const b = await home(t, w, "bob", { faults, fault: (p) => {
    if (failWrite && p === "device-write") {
      failWrite = false;
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
  } });
  await a.store.enroll(a.client);
  const { device } = await b.store.enroll(b.client);
  const take = (request) => a.client.rpc({ type: "kp_take", request, device: a.store.record().device, target: { member: w.members.bob.id, device } });
  const k1 = await take("req-welcome-1");
  const welcome = fakeWelcome(Buffer.from(k1.kp, "base64"), "aa");
  // A Welcome the library refuses at staging keeps the key.
  faults.add("stageWelcome");
  await assert.rejects(b.store.acceptWelcome(k1.ref, welcome), /fault at stageWelcome/);
  // One that fails to finish is discarded and keeps the key.
  faults.add("finishWelcome");
  await assert.rejects(b.store.acceptWelcome(k1.ref, welcome), /fault at finishWelcome/);
  // The write of the result fails: nothing is consumed on disk.
  failWrite = true;
  await assert.rejects(b.store.acceptWelcome(k1.ref, welcome), /disk full/);
  // Now it succeeds, once; a replay is refused by the durable record, also in a fresh process.
  assert.deepEqual(await b.store.acceptWelcome(k1.ref, welcome), { group: "aa" });
  await assert.rejects(b.store.acceptWelcome(k1.ref, welcome), (e) => e.code === "replayed_welcome");
  const fresh = deviceStore({ home: b.dir, profile: "relay-test", driver: createFakeDriver({ seed: "fresh" }), store: "file", passphrase: PASS, keychainBackend: null, machine: "machine-a", now: w.clock.now });
  await assert.rejects(fresh.acceptWelcome(k1.ref, welcome), (e) => e.code === "replayed_welcome");
  assert.equal(fresh.record().kps[k1.ref].state, "used");
  await assert.rejects(b.store.acceptWelcome("0".repeat(64), welcome), (e) => e.code === "unknown_key_package");
  // Expired: the device refuses a Welcome for a package past its lifetime.
  const k2 = await take("req-welcome-2");
  w.clock.advance(KP_LIFETIME_MS + 1);
  await assert.rejects(b.store.acceptWelcome(k2.ref, fakeWelcome(Buffer.from(k2.kp, "base64"), "bb")), (e) => e.code === "expired_key_package");
  // ... and so does the library on decode (expiry at both ends).
  assert.throws(() => b.driver.inspectKeyPackage(Buffer.from(k2.kp, "base64"), { now: w.clock.now() }), /Expired/);
});

test("rotation from the device: the relay serves the chain and a peer that pinned the old key accepts it without a stop", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const b = await home(t, w, "bob");
  await a.store.enroll(a.client);
  await b.store.enroll(b.client);
  const doc = { version: 1, default: "ask" };
  pinFirstUse(doc, w.realm, w.members.bob.id, evaluate(null, w.realm, w.members.bob.id, (await a.client.rpc({ type: "device_list", member: w.members.bob.id })).devices).active);
  const before = b.store.record();
  const r = await b.store.rotate(b.client);
  assert.equal(r.seq, 1);
  assert.notEqual(b.store.record().key, before.key);
  assert.equal(r.published, 20, "the new key's packages are published");
  const ev = evaluate(doc, w.realm, w.members.bob.id, (await a.client.rpc({ type: "device_list", member: w.members.bob.id })).devices);
  assert.equal(ev.state, "ok");
  assert.equal(ev.rotated.length, 1);
  assert.equal(ev.rotated[0].seq, 1);
});

test("revocation from another device of the member: the relay stops serving it; the revoked one cannot act", async (t) => {
  const w = await deviceRelay(t);
  const laptop = await home(t, w, "alice", { machine: "laptop" });
  const desktop = await home(t, w, "alice", { machine: "desktop" });
  const lost = (await laptop.store.enroll(laptop.client)).device;
  await desktop.store.enroll(desktop.client);
  const r = await desktop.store.revoke(desktop.client, lost);
  assert.equal(r.state, "revoked");
  const d = (await desktop.client.rpc({ type: "device_list" })).devices.find((x) => x.device === lost);
  assert.equal(d.revoked.device, desktop.store.record().device);
  w.clock.advance(60_000);
  const e = await refusal(laptop.store.replenish(laptop.client, { force: 1 }));
  assert.match(e.message, /revoked/);
});

test("restore and migrate retire durably before anything else; a copied home on another machine cannot send", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice", { machine: "old-machine" });
  const old = (await a.store.enroll(a.client)).device;
  const backup = path.join(a.dir, "device-backup.json");
  await a.store.backup(backup, PASS);

  // A raw copy of the home on another machine: the state opens (file store), but it cannot send.
  const copy = tmpDir(t);
  fs.cpSync(a.dir, copy, { recursive: true });
  const elsewhere = deviceStore({ home: copy, profile: "relay-test", driver: a.driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "new-machine", now: w.clock.now });
  assert.match(elsewhere.mayAct(), /another machine/);
  w.clock.advance(60_000);
  await assert.rejects(elsewhere.replenish(a.client, { force: 1 }), /another machine/);
  await assert.rejects(elsewhere.rotate(a.client), /another machine/);

  // The supported path: a failed retire write leaves nothing usable behind ...
  const target = await home(t, w, "alice", { machine: "new-machine" });
  const failing = deviceStore({ home: target.dir, profile: "relay-test", driver: target.driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "new-machine", now: w.clock.now, fault: (p) => {
    if (p === "device-write") throw new Error("crash before the retired record");
  } });
  await assert.rejects(failing.restore(backup, PASS), /crash/);
  assert.equal(target.store.record(), null);
  assert.deepEqual(target.store.retired(), []);
  // ... and a completed one is retired: readable, never sending.
  await target.store.restore(backup, PASS);
  assert.deepEqual(target.store.retired().map((r) => [r.device, r.retiredWhy]), [[old, "restored from a backup"]]);
  assert.equal(target.store.record(), null, "nothing can send with it");
  // Migrate: the new machine enrolls a new device and revokes the old one at the relay.
  const fresh = (await target.store.enroll(target.client)).device;
  assert.notEqual(fresh, old);
  await target.store.revoke(target.client, old);
  const list = (await target.client.rpc({ type: "device_list" })).devices;
  assert.ok(list.find((d) => d.device === old).revoked);
  assert.ok(list.find((d) => d.device === fresh).key);
  // Restoring the device's own backup over itself retires it too (same machine, supported path).
  await a.store.restore(backup, PASS);
  assert.equal(a.store.record().status, "retired");
  assert.match(a.store.mayAct(), /retired/);
  await assert.rejects(a.store.replenish(a.client), /retired/);
  // A wrong passphrase restores nothing.
  await assert.rejects(target.store.restore(backup, "wrong passphrase!"), /cannot be decrypted/);
});

test("a taken KeyPackage is checked at the device: the expected device and key, and not expired", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const b = await home(t, w, "bob");
  const c = await home(t, w, "carol");
  await a.store.enroll(a.client);
  await b.store.enroll(b.client);
  const bob = b.store.record();
  await c.store.enroll(c.client);
  const k = await a.client.rpc({ type: "kp_take", request: "req-check-1", device: a.store.record().device, target: { member: bob.member, device: bob.device } });
  const expected = { realm: w.realm, member: bob.member, device: bob.device, key: Buffer.from(bob.key, "base64") };
  const kp = Buffer.from(k.kp, "base64");
  assert.ok(checkKeyPackage(a.driver, expected, kp, w.clock.now()));
  // A relay that substitutes another member's package for bob's is caught.
  const carol = c.store.record();
  const other = await a.client.rpc({ type: "kp_take", request: "req-check-2", device: a.store.record().device, target: { member: carol.member, device: carol.device } });
  assert.throws(() => checkKeyPackage(a.driver, expected, Buffer.from(other.kp, "base64"), w.clock.now()), /another device/);
  assert.throws(() => checkKeyPackage(a.driver, { ...expected, key: Buffer.alloc(32, 1) }, kp, w.clock.now()), /another key/);
  assert.throws(() => checkKeyPackage(a.driver, expected, kp, w.clock.now() + KP_LIFETIME_MS + 1), /Expired|expired/);
});

test("a Welcome is bound to the KeyPackage it names: one for another package is refused before anything changes; 3.3 may refuse the staged group", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const b = await home(t, w, "bob");
  await a.store.enroll(a.client);
  const { device } = await b.store.enroll(b.client);
  const take = (request) => a.client.rpc({ type: "kp_take", request, device: a.store.record().device, target: { member: w.members.bob.id, device } });
  const x = await take("req-bind-x");
  const y = await take("req-bind-y");
  const wx = fakeWelcome(Buffer.from(x.kp, "base64"), "aa");
  const wy = fakeWelcome(Buffer.from(y.kp, "base64"), "bb");
  // Ref X with a valid Welcome for package Y: refused, and neither package is consumed.
  await assert.rejects(b.store.acceptWelcome(x.ref, wy), (e) => e.code === "key_package_mismatch");
  assert.equal(b.store.record().kps[x.ref].state, "open");
  assert.equal(b.store.record().kps[y.ref].state, "open");
  // 3.3's check of the staged group runs before anything is kept: a refusal keeps the key.
  let seen = null;
  await assert.rejects(b.store.acceptWelcome(x.ref, wx, { validate: (s) => { seen = s; throw new Error("not the group 3.3 expected"); } }), /not the group/);
  assert.equal(Buffer.from(seen.groupId).toString("hex"), "aa");
  assert.equal(seen.ref, x.ref);
  assert.equal(b.store.record().kps[x.ref].state, "open");
  // Each Welcome then joins under its own package, and only that package's replay marker is set.
  assert.deepEqual(await b.store.acceptWelcome(x.ref, wx, { validate: async () => {} }), { group: "aa" });
  assert.equal(b.store.record().kps[x.ref].state, "used");
  assert.equal(b.store.record().kps[y.ref].state, "open");
  assert.deepEqual(await b.store.acceptWelcome(y.ref, wy), { group: "bb" });
  await assert.rejects(b.store.acceptWelcome(y.ref, wy), (e) => e.code === "replayed_welcome");
});

/** Every package the relay serves for `rec`'s device, taken by `requester` (directory calls). */
let takes = 0;
function takeAll(w, requester, rec) {
  const out = [];
  for (;;) {
    try {
      out.push(w.directory.take({ requester, request: `req-all-${takes++}`, target: { member: rec.member, device: rec.device } }));
    } catch (e) {
      if (e.code === "no_key_package") return out;
      throw e;
    }
  }
}

test("rotation after a lost upload: the relay serves only packages of the new key (the reviewer's reproduction)", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const b = await home(t, w, "bob");
  await a.store.enroll(a.client);
  await b.store.enroll(b.client);
  const rpc = b.client.rpc.bind(b.client);
  b.client.rpc = async (frame) => {
    if (frame.type === "kp_upload") throw new Error("lost kp_upload");
    return rpc(frame);
  };
  await assert.rejects(b.store.replenish(b.client, { force: 1 }), /lost kp_upload/);
  b.client.rpc = rpc;
  assert.equal((await b.store.rotate(b.client)).seq, 1);
  const now = b.store.record();
  const taken = takeAll(w, { member: w.members.alice.id, device: a.store.record().device }, now);
  assert.equal(taken.length, 20);
  for (const s of taken) checkKeyPackage(b.driver, { realm: w.realm, member: now.member, device: now.device, key: Buffer.from(now.key, "base64") }, s.kp, w.clock.now());
});

test("rotation retires the old key's unpublished packages; an unfinished rotation publishes nothing; lost answers before and after the relay took it", async (t) => {
  const w = await deviceRelay(t);
  const a = await home(t, w, "alice");
  const b = await home(t, w, "bob");
  await a.store.enroll(a.client);
  await b.store.enroll(b.client);
  const old = b.store.record();
  const rpc = b.client.rpc.bind(b.client);
  const lose = (type, { after = false } = {}) => {
    b.client.rpc = async (frame) => {
      if (frame.type !== type) return rpc(frame);
      b.client.rpc = rpc;
      if (after) await rpc(frame);
      throw new Error(`lost ${type}`);
    };
  };
  // A replenishment's upload is lost: a batch signed by the old key waits to be offered again.
  lose("kp_upload");
  await assert.rejects(b.store.replenish(b.client, { force: 1 }), /lost kp_upload/);
  // The rotation's registration is lost before the relay hears of it: the rotation is pending,
  // and nothing publishes the old batch meanwhile.
  lose("device_register");
  await assert.rejects(b.store.rotate(b.client), /lost device_register/);
  w.clock.advance(60_000);
  await assert.rejects(b.store.replenish(b.client, { force: 1 }), (e) => e.code === "rotation_pending");
  await assert.rejects(b.store.enroll(b.client), (e) => e.code === "rotation_pending");
  // Retried, the relay takes it but the answer is lost; the next retry finds it done.
  lose("device_register", { after: true });
  await assert.rejects(b.store.rotate(b.client), /lost device_register/);
  const r = await b.store.rotate(b.client);
  assert.equal(r.seq, 1);
  assert.equal(r.published, 20);
  const now = b.store.record();
  assert.notEqual(now.key, old.key);
  // Every package the relay serves is the new key's, and each is in the new ledger.
  const served = takeAll(w, { member: w.members.alice.id, device: a.store.record().device }, now);
  assert.equal(served.length, 20);
  for (const s of served) {
    assert.ok(Buffer.from(b.driver.inspectKeyPackage(s.kp, { now: w.clock.now() }).signatureKey).equals(Buffer.from(now.key, "base64")));
    assert.equal(now.kps[s.ref]?.state, "open");
  }
  // The post-rotation upload's answer lost too: the retry offers the new key's batch only.
  const c = await home(t, w, "carol");
  await c.store.enroll(c.client);
  const crpc = c.client.rpc.bind(c.client);
  let uploads = 0;
  c.client.rpc = async (frame) => {
    if (frame.type === "kp_upload" && uploads++ === 0) {
      await crpc(frame);
      throw new Error("lost kp_upload");
    }
    return crpc(frame);
  };
  await assert.rejects(c.store.rotate(c.client), /lost kp_upload/);
  const cr = c.store.record();
  assert.equal(cr.seq, 1);
  w.clock.advance(60_000);
  await c.store.replenish(c.client);
  for (const s of takeAll(w, { member: w.members.alice.id, device: a.store.record().device }, cr)) {
    assert.ok(Buffer.from(c.driver.inspectKeyPackage(s.kp, { now: w.clock.now() }).signatureKey).equals(Buffer.from(cr.key, "base64")));
  }
});

test("revoking this device: the signed revocation is pending until the relay confirms it, resumes after a lost answer or a restart, and nothing else runs meanwhile", async (t) => {
  const w = await deviceRelay(t);
  for (const after of [false, true]) {
    const a = await home(t, w, "alice", { machine: `m-${after}` });
    const { device } = await a.store.enroll(a.client);
    const rpc = a.client.rpc.bind(a.client);
    a.client.rpc = async (frame) => {
      if (frame.type !== "device_revoke") return rpc(frame);
      a.client.rpc = rpc;
      if (after) await rpc(frame);
      throw new Error("lost device_revoke");
    };
    await assert.rejects(a.store.revoke(a.client, device), /lost device_revoke/);
    const served = w.directory.list(w.members.alice.id).find((d) => d.device === device);
    assert.equal(Boolean(served.revoked), after, "the relay has it only when the answer was lost after its commit");
    // Ordinary operations stop at once; another revocation is refused; this one resumes.
    assert.match(a.store.record().mayAct, /not confirmed/);
    w.clock.advance(60_000);
    await assert.rejects(a.store.replenish(a.client, { force: 1 }), (e) => e.code === "not_allowed");
    await assert.rejects(a.store.revoke(a.client, "a".repeat(26)), (e) => e.code === "not_allowed");
    const r = await a.store.revoke(a.client, device);
    assert.equal(r.state, after ? "already" : "revoked");
    assert.equal(a.store.record().status, "revoked");
    assert.ok(w.directory.list(w.members.alice.id).find((d) => d.device === device).revoked);
    await assert.rejects(async () => w.directory.status({ member: w.members.alice.id, device }), (e) => e.code === "device_revoked");
  }
  // A restart between the pending record and the relay: a fresh process resumes the same statement.
  const dir = tmpDir(t);
  const a = await home(t, w, "alice", { machine: "m-restart", dir, seed: "restart" });
  const { device } = await a.store.enroll(a.client);
  a.client.rpc = async (frame) => {
    if (frame.type === "device_revoke") throw new Error("crash");
    return a.client.constructor.prototype.rpc.call(a.client, frame);
  };
  await assert.rejects(a.store.revoke(a.client, device), /crash/);
  const fresh = await home(t, w, "alice", { machine: "m-restart", dir, seed: "restart" });
  const r = await fresh.store.revoke(fresh.client, device);
  assert.equal(r.state, "revoked");
  assert.equal(fresh.store.record().status, "revoked");
  assert.equal(w.directory.list(w.members.alice.id).find((d) => d.device === device).revoked.by, "device");
});
