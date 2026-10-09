// The experimental OpenMLS driver (lib/mls/openmls.js) over the bake-off's WASM binding, when it is
// built: HOPTELL_MLS_WASM, or the spike's build in a sibling worktree. Skipped otherwise; the binding
// is never a dependency of the package.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "../lib/config.js";
import { DriverError } from "../lib/mls/driver.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { deviceStore } from "../lib/mls/device.js";
import { credentialIdentity, newDeviceId } from "../lib/mls/identity.js";
import { deviceRelay, fakeDevice, tmpDir } from "./mls-helpers.js";

const WASM = process.env.HOPTELL_MLS_WASM || path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm", "pkg", "openmls_wasm.js");
const skip = fs.existsSync(WASM) ? false : `the OpenMLS WASM binding is not built (${WASM})`;
const T = { realm: "0".repeat(32), member: `m_${"a".repeat(26)}`, device: newDeviceId() };

test("OpenMLS: hoptell's credential identity, KeyPackages decoded and validated, state export and import", { skip }, async () => {
  const d = createOpenMlsDriver(WASM);
  const dev = await d.createDevice(credentialIdentity(T));
  const kp = await dev.keyPackage({ lifetimeSeconds: 14 * 86400 });
  const info = d.inspectKeyPackage(kp);
  assert.equal(Buffer.from(info.identity).toString(), credentialIdentity(T).toString());
  assert.deepEqual(Buffer.from(info.signatureKey), Buffer.from(dev.signaturePublicKey()));
  assert.equal(info.signatureKey.length, 32);
  const tampered = Buffer.from(kp);
  tampered[tampered.length - 5] ^= 1;
  assert.throws(() => d.inspectKeyPackage(tampered), (e) => e instanceof DriverError);
  const again = await d.importDevice(await dev.exportState());
  assert.deepEqual(Buffer.from(again.signaturePublicKey()), Buffer.from(dev.signaturePublicKey()));
  await assert.rejects(dev.sign("hoptell-rotate-v1", Buffer.from("x")), (e) => e.code === "unsupported", "a known binding gap");
  await assert.rejects(dev.stageWelcome(kp), (e) => e instanceof DriverError, "not a Welcome");
});

test("OpenMLS: the library refuses an expired KeyPackage (expiry at the device's end)", { skip }, async () => {
  const d = createOpenMlsDriver(WASM);
  const dev = await d.createDevice(credentialIdentity(T));
  // Lifetimes are whole seconds: a 3 s package is still valid when inspected at once, also on a
  // loaded machine, and expired after 4.2 s.
  const kp = await dev.keyPackage({ lifetimeSeconds: 3 });
  d.inspectKeyPackage(kp);
  await new Promise((r) => setTimeout(r, 4200));
  assert.throws(() => d.inspectKeyPackage(kp), /Expired/);
});

test("OpenMLS: a device enrolls end to end through the relay", { skip }, async (t) => {
  const w = await deviceRelay(t);
  const home = tmpDir(t);
  const store = deviceStore({ home, profile: "relay-test", driver: createOpenMlsDriver(WASM), store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m" });
  const client = await w.client("alice");
  const r = await store.enroll(client);
  assert.equal(r.published, 20);
  const k = await (await w.client("bob")).rpc({ type: "device_list", member: w.members.alice.id });
  assert.equal(k.devices[0].device, r.device);
  const fresh = deviceStore({ home, profile: "relay-test", driver: createOpenMlsDriver(WASM), store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m" });
  assert.equal(fresh.record().key, store.record().key);
});

test("OpenMLS: a Welcome is bound to the KeyPackage it names (suite 77); a refused one keeps both packages", { skip }, async (t) => {
  const wasm = createRequire(import.meta.url)(WASM);
  const driver = createOpenMlsDriver(WASM, { suite: 77 });
  const w = await deviceRelay(t);
  const store = deviceStore({ home: tmpDir(t), profile: "relay-test", driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now });
  await store.enroll(await w.client("bob"));
  const rec = store.record();
  const alice = await fakeDevice(w.realm, w.members.alice.id);
  await (await w.client("alice")).rpc(alice.register());
  const take = (request) => w.directory.take({ requester: { member: w.members.alice.id, device: alice.device }, request, target: { member: rec.member, device: rec.device } });
  const x = take("openmls-bind-x");
  const y = take("openmls-bind-y");
  const committer = new wasm.Device(77, credentialIdentity({ realm: w.realm, member: w.members.alice.id, device: newDeviceId() }));
  t.after(() => committer.free());
  const welcomeFor = (kp, gid) => {
    committer.create_group(Buffer.from(gid));
    const out = committer.commit(Buffer.from(gid), [new wasm.Bytes(kp)], new Uint32Array(), false);
    committer.merge_pending(Buffer.from(gid));
    return out;
  };
  const wy = welcomeFor(y.kp, "group-y");
  await assert.rejects(store.acceptWelcome(x.ref, wy.welcome, { ratchetTree: wy.ratchet_tree }), (e) => e.code === "key_package_mismatch");
  assert.equal(store.record().kps[x.ref].state, "open");
  assert.equal(store.record().kps[y.ref].state, "open");
  // The ledger holds the library's own KeyPackageRef of each package.
  assert.equal(store.record().kps[x.ref].libRef, Buffer.from(driver.inspectKeyPackage(x.kp).ref).toString("hex"));
  // Both private keys are still there: each Welcome joins under its own package.
  const wx = welcomeFor(x.kp, "group-x");
  assert.deepEqual(await store.acceptWelcome(x.ref, wx.welcome, { ratchetTree: wx.ratchet_tree }), { group: Buffer.from("group-x").toString("hex") });
  assert.deepEqual(await store.acceptWelcome(y.ref, wy.welcome, { ratchetTree: wy.ratchet_tree }), { group: Buffer.from("group-y").toString("hex") });
  assert.equal(store.record().kps[x.ref].state, "used");
  assert.equal(store.record().kps[y.ref].state, "used");
});

test("OpenMLS: the KeyPackageRef hoptell computes is the one the library stores (suites 1 and 77)", { skip }, async () => {
  const wasm = createRequire(import.meta.url)(WASM);
  for (const suite of [1, 77]) {
    const driver = createOpenMlsDriver(WASM, { suite });
    const dev = await driver.createDevice(credentialIdentity(T));
    const kp = await dev.keyPackage({ lifetimeSeconds: 14 * 86400 });
    const committer = new wasm.Device(suite, Buffer.from("committer"));
    committer.create_group(Buffer.from("g"));
    const out = committer.commit(Buffer.from("g"), [new wasm.Bytes(kp)], new Uint32Array(), false);
    committer.free();
    const staged = await dev.stageWelcome(out.welcome, out.ratchet_tree);
    assert.deepEqual(Buffer.from(staged.keyPackageRef), Buffer.from(driver.inspectKeyPackage(kp).ref));
    await staged.discard();
  }
});

test("MII9 OpenMLS: a retained past epoch's sender is the device of that epoch, after its removal, a reuse of its leaf, and an export and import", { skip }, async () => {
  const d = createOpenMlsDriver(WASM);
  const realm = "a".repeat(32);
  const [A, B, C] = ["a", "b", "c"].map((x) => `m_${x.repeat(26)}`);
  const [aid, bid, cid] = [A, B, C].map((member) => credentialIdentity({ realm, member, device: newDeviceId() }));
  const [a, b, c] = await Promise.all([aid, bid, cid].map((id) => d.createDevice(id)));
  const gid = crypto.randomBytes(16);
  const ga = await a.createGroup(gid);
  const add = await ga.commit({ add: [await b.keyPackage({ lifetimeSeconds: 86400 })] });
  await ga.mergePending();
  await (await b.stageWelcome(add.welcome, add.ratchetTree)).finish();
  const delayed = await b.group(gid).encrypt(Buffer.from("valid before removal"));
  const index = ga.members().find((m) => Buffer.from(m.identity).equals(bid)).index;
  await ga.commit({ remove: [index] });
  await ga.mergePending();
  // Another device takes the freed leaf.
  const add2 = await ga.commit({ add: [await c.keyPackage({ lifetimeSeconds: 86400 })] });
  await ga.mergePending();
  assert.ok(Buffer.from(ga.members().find((m) => m.index === index)?.identity ?? []).equals(cid), "the leaf is reused");
  await (await c.stageWelcome(add2.welcome, add2.ratchetTree)).finish();
  const again = await d.importDevice(await a.exportState(), { identity: aid });
  const p = await again.group(gid).process(delayed);
  assert.equal(Buffer.from(p.plaintext).toString(), "valid before removal");
  assert.equal(p.epoch, 1);
  assert.ok(Buffer.from(p.sender.identity).equals(bid), "the sender of epoch 1, not the leaf's current device");
  assert.ok(Buffer.from(p.sender.signatureKey).equals(Buffer.from(b.signaturePublicKey())));
  // A current-epoch message resolves in the current roster.
  const now = await again.group(gid).process(await c.group(gid).encrypt(Buffer.from("now")));
  assert.ok(Buffer.from(now.sender.identity).equals(cid));
});
