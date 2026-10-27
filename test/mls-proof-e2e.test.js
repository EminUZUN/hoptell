// End to end through the guarded relay (amendments 3.5 part 2, A9): every device path proves its
// key before KeyPackage or group work. enroll (register, attach, replenish), the CLI's replenish
// and status, and a rotation as a durable pending state (save, register with the staged key,
// promote, attach with the new key, replenish), resumed after a SIGKILL at each window; the same
// steps out of order are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { deviceCommand } from "../lib/mls/cli.js";
import { deviceStore } from "../lib/mls/device.js";
import { b64, makeRotation, pinIdentity } from "../lib/mls/identity.js";
import { KP_LIFETIME_MS } from "../lib/mls/policy.js";
import { REATTACH_TRIES } from "../lib/mls/e2ee.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { deviceRelay, e2eeDevice, fakeDevice, memoryContacts, ownFor, proveOn, refusal, tmpDir, until } from "./mls-helpers.js";

const PASS = "correct horse battery staple";
const CRASH = new URL("./fixtures/device-crash.mjs", import.meta.url).pathname;
const FAKE = new URL("./fake-mls-driver.js", import.meta.url).pathname;

/** A home of `member` with a fake-driver device store; make() opens it again (as after a restart). */
function home(t, w, member, { dir = tmpDir(t) } = {}) {
  const contacts = memoryContacts(undefined, { file: path.join(dir, "contacts-test.json") });
  const driver = createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now });
  const make = (opts = {}) => deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, "relay-test"), ...opts });
  return { dir, contacts, driver, store: make(), make };
}
/** The frames `client` sends, from now on (a proof challenge with its purpose). */
function recorded(client) {
  const frames = [];
  const rpc = client.rpc.bind(client);
  client.rpc = (f) => (frames.push(f.type === "proof_challenge" ? `proof_challenge:${f.purpose}` : f.type), rpc(f));
  return frames;
}
const rawRecord = (h) => JSON.parse(fs.readFileSync(path.join(h.dir, "mls", "relay-test", "device.json"), "utf8"));
const relayDevice = async (w, member, device) => (await (await w.client(member)).rpc({ type: "device_list" })).devices.find((d) => d.device === device);

test("A9 end to end: enroll registers with a proof, attaches with a proof, then publishes KeyPackages", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = home(t, w, "alice");
  const c = await w.client("alice");
  const frames = recorded(c);
  const r = await h.store.enroll(c);
  assert.equal(r.created, true);
  assert.equal(r.published, 20);
  assert.deepEqual(frames, ["proof_challenge:register", "device_register", "proof_challenge:attach", "e2ee_attach", "kp_status", "kp_upload"]);
  assert.equal(h.store.record().status, "active");
  // Running it again (resume and top-up) proves again on its connection, in the same order.
  const again = await w.client("alice");
  const second = recorded(again);
  w.clock.advance(61_000);
  await h.store.enroll(again);
  assert.deepEqual(second.slice(0, 4), ["proof_challenge:register", "device_register", "proof_challenge:attach", "e2ee_attach"]);
});

test("A9 end to end: the CLI's replenish attaches with a proof on its own connection; status works", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const dir = tmpDir(t);
  const contacts = memoryContacts();
  const frames = [];
  const connect = async () => {
    const c = await w.client("alice");
    frames.push(recorded(c));
    return c;
  };
  const out = [];
  const cmd = (args) => deviceCommand({ args, home: dir, profile: "relay-test", env: { HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS, HOPTELL_MLS_DRIVER: FAKE }, connect, contacts, say: (x) => out.push(x) });
  await cmd(["enroll"]);
  await cmd(["replenish"]);
  assert.deepEqual(frames.at(-1), ["proof_challenge:attach", "e2ee_attach", "kp_status"], "attached first, on the command's own connection");
  assert.match(out.at(-1), /0 KeyPackages published; 20 available/);
  out.length = 0;
  await cmd(["status"]);
  assert.match(out[0], /\(active\)/);
  // The CLI's connection is send-mode: it acted for the device but took none of its deliveries.
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "mls", "relay-test", "device.json"), "utf8"));
  assert.equal(w.ds.usage({ member: rec.member, device: rec.device }).messages, 0);
});

test("A9 end to end: a rotation saves the pending state, registers the staged key with its proof, promotes it, attaches with the new key and replenishes", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = home(t, w, "alice");
  await h.store.enroll(await w.client("alice"));
  const before = h.store.record();
  const c = await w.client("alice");
  const frames = recorded(c);
  const r = await h.store.rotate(c);
  assert.equal(r.seq, 1);
  assert.deepEqual(frames, ["proof_challenge:register", "device_register", "proof_challenge:attach", "e2ee_attach", "kp_status", "kp_upload"]);
  const after = h.store.record();
  assert.notEqual(after.key, before.key);
  assert.equal(rawRecord(h).pendingRotation, undefined);
  const listed = await relayDevice(w, "alice", after.device);
  assert.deepEqual([listed.key, listed.seq], [after.key, 1]);
  assert.equal(r.published, 20, "a full pool from the new key");
});

test("A9 end to end: the same steps out of order are refused (KeyPackages before an attach, an attach before the registration, the staged key before the relay took it, the old key after)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const A = w.members.alice.id;
  const d = await fakeDevice(w.realm, A);
  const c = await w.client("alice");
  assert.equal((await refusal(d.attachOn(c))).code, "no_device", "attach before the registration");
  await d.registerOn(c);
  assert.equal((await refusal(c.rpc({ type: "kp_upload", device: d.device, packages: await d.packages(1, w.clock.now() + KP_LIFETIME_MS) }))).code, "not_attached", "KeyPackages before an attach");
  await d.attachOn(c);
  // A staged key (the rotation not registered yet) does not attach.
  const next = await d.driver.createDevice(d.dev.identity);
  const newKey = Buffer.from(next.signaturePublicKey());
  const c2 = await w.client("alice");
  assert.equal((await refusal(c2.rpc({ type: "e2ee_attach", device: d.device, proof: await proveOn(c2, { realm: w.realm, member: A, device: d.device, dev: next }, "attach") }))).code, "attach_proof");
  // Registered: then the old key's attachment is refused for KeyPackage work.
  const statement = await makeRotation({ realm: w.realm, member: A, device: d.device, oldKey: d.key, newKey, sequence: 1 }, (l, x) => d.dev.sign(l, x), (l, x) => next.sign(l, x));
  await c2.rpc({ type: "device_register", device: d.device, key: b64(newKey), pin: b64(pinIdentity({ realm: w.realm, member: A, device: d.device, key: newKey })), rotation: statement, proof: await proveOn(c2, { realm: w.realm, member: A, device: d.device, dev: next, key: newKey }, "register") });
  assert.equal((await refusal(c.rpc({ type: "kp_status", device: d.device }))).code, "not_attached");
  assert.equal((await refusal(d.attachOn(c))).code, "attach_proof");
});

test("A9: a rotation the relay refuses stays pending; an attach then proves with the key the relay has (the current one)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = home(t, w, "alice");
  await h.store.enroll(await w.client("alice"));
  const before = h.store.record();
  w.fault.arm("before-commit"); // the relay cannot store the registration: it refuses (unavailable)
  await assert.rejects(h.store.rotate(await w.client("alice")), (e) => e.code === "unavailable");
  assert.ok(rawRecord(h).pendingRotation, "the pending state stays for the owner");
  assert.equal(h.store.record().key, before.key, "the current key stays the active signer");
  // An attach (the engine's start) resumes it: the relay now takes it, and the new key attaches.
  const c = await w.client("alice");
  await h.make().attach(c);
  const rec = h.store.record();
  assert.notEqual(rec.key, before.key);
  assert.equal((await relayDevice(w, "alice", rec.device)).key, rec.key);
  assert.equal((await c.rpc({ type: "kp_status", device: rec.device })).type, "kp_status", "attached with the new key");
  // A registration refused again at the attach: the current key attaches, the rotation still pends.
  const h2 = home(t, w, "bob");
  await h2.store.enroll(await w.client("bob"));
  const b0 = h2.store.record();
  w.fault.arm("before-commit");
  await assert.rejects(h2.store.rotate(await w.client("bob")), (e) => e.code === "unavailable");
  w.fault.arm("before-commit");
  const cb = await w.client("bob");
  await h2.make().attach(cb);
  assert.equal(h2.store.record().key, b0.key);
  assert.ok(rawRecord(h2).pendingRotation);
  assert.equal((await cb.rpc({ type: "kp_status", device: b0.device })).type, "kp_status", "attached with the key the relay has");
});

/** Run the crash fixture; resolves once it died by SIGKILL (rejects if it survived). */
function crash(w, member, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CRASH, w.url, ...args], { timeout: 30_000, env: { ...process.env, HOPTELL_TEST_TOKEN: w.members[member].token, HOPTELL_TEST_MEMBER: member, HOPTELL_TEST_NOW: String(w.clock.now()) } }, (err, stdout, stderr) => (err?.signal === "SIGKILL" ? resolve() : reject(new Error(`the fixture did not die: ${stdout}${stderr}${err?.message ?? ""}`))));
  });
}

test("A9 rotation crash windows (SIGKILL): after the pending save, after the relay's acceptance, after the promotion: one working device with the new key", async (t) => {
  for (const [point, relayHasNew, pending] of [["rotate-after-pending", false, true], ["rotate-after-accept", true, true], ["rotate-after-promote", true, false]]) {
    const w = await deviceRelay(t, { e2ee: true });
    const h = home(t, w, "alice");
    await h.store.enroll(await w.client("alice"));
    const before = h.store.record();
    await crash(w, "alice", [h.dir, point, "rotate"]);
    // What the kill left: on disk and at the relay.
    const mid = rawRecord(h);
    assert.equal(Boolean(mid.pendingRotation), pending, `${point}: pending state on disk`);
    const staged = mid.pendingRotation?.statement.new_key ?? mid.key;
    assert.notEqual(staged, before.key, `${point}: a new key was staged`);
    assert.equal((await relayDevice(w, "alice", before.device)).key, relayHasNew ? staged : before.key, `${point}: the relay's key`);
    // Restart: the attach at startup resumes (register again, idempotent; promote), then attaches.
    const store = h.make();
    const c = await w.client("alice");
    await store.attach(c);
    const rec = store.record();
    assert.equal(rec.device, before.device, `${point}: the same device, never lost`);
    assert.deepEqual([rec.key, rec.seq, rawRecord(h).pendingRotation], [staged, 1, undefined], `${point}: the new key promoted`);
    const listed = (await (await w.client("alice")).rpc({ type: "device_list" })).devices;
    assert.equal(listed.length, 1, `${point}: one device`);
    assert.deepEqual([listed[0].key, listed[0].seq], [staged, 1]);
    // It works: KeyPackage work on the attached connection, from the new key's state.
    w.clock.advance(61_000);
    const r = await store.replenish(c);
    assert.ok(r.published > 0 || r.available > 0, `${point}: replenished`);
    assert.equal(store.mayAct(), null);
  }
});

test("A9: a rotation by a command on another connection detaches the live session; the relay tells it, it proves again with the new key, and queued deliveries resume without a reconnect", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await e2eeDevice(t, w, "alice");
  const bob = await e2eeDevice(t, w, "bob");
  const live = bob.s.bob;
  const notices = [];
  live.client.on("e2ee_detached", (m) => notices.push(m));
  let reconnects = 0;
  live.client.on("ready", () => reconnects++);
  const before = bob.store.record().key;
  // The CLI's rotation, on its own (send-mode) connection, with its own store of the same home.
  w.clock.advance(61_000);
  const cli = deviceStore({ home: bob.dir, profile: "relay-test", driver: createFakeDriver({ seed: "bob-cli", now: w.clock.now }), store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(bob.contacts, bob.dir, "relay-test") });
  await cli.rotate(await w.client("bob"));
  const rec = bob.store.record();
  assert.notEqual(rec.key, before, "rotated");
  await until(() => notices.length, "the relay's detach notice");
  assert.deepEqual(notices[0], { type: "e2ee_detached", device: rec.device, reason: "key_changed" });
  // A message sent now is queued for bob's device; the live session (same connection) gets it.
  const r = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "after the rotation" });
  assert.equal(r.state, "accepted");
  const [m] = await until(() => (live.got.length ? live.got : null), "delivery on the live session", 10_000);
  assert.equal(m.text, "after the rotation");
  assert.equal(reconnects, 0, "the same connection, never reconnected");
  assert.equal((await relayDevice(w, "bob", rec.device)).key, rec.key);
});

test("A9: a revoked device's live session is told so and does not attach again", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await e2eeDevice(t, w, "bob");
  const live = bob.s.bob;
  const notices = [];
  live.client.on("e2ee_detached", (m) => notices.push(m));
  // The device revokes itself (device-signed) from a command's connection.
  await bob.store.revoke(await w.client("bob"), bob.device);
  await until(() => notices.length, "the relay's detach notice");
  assert.equal(notices[0].reason, "revoked");
  await until(() => live.e2ee.detached(), "the engine stops");
  await assert.rejects(live.e2ee.attach(), (e) => e.code === "device_revoked");
});

test("A9: after a detach notice the engine tries 5 times quickly, then on at a bounded rate while the connection is up; close ends it", async (t) => {
  assert.equal(REATTACH_TRIES, 5);
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await e2eeDevice(t, w, "bob", { sessions: [] });
  const client = await w.client("bob", { session: "bob" });
  const s = bob.engine(client, "bob", { reattachBaseMs: 5, reattachMaxMs: 40 });
  await s.e2ee.attach();
  // From now on the relay keeps refusing (every proof challenge is unavailable).
  const at = [];
  const rpc = client.rpc.bind(client);
  client.rpc = (f) => (f.type === "proof_challenge" ? (at.push(Date.now()), Promise.reject(Object.assign(new Error("the relay is unavailable"), { kind: "relay_error", code: "unavailable" }))) : rpc(f));
  client.emit("e2ee_detached", { type: "e2ee_detached", device: bob.device, reason: "key_changed" });
  await until(() => at.length >= 12, "it keeps trying after the quick ones", 10_000);
  // Bounded: after the quick tries no gap is shorter than half the cap (jitter), none much longer than the cap.
  const gaps = at.slice(6).map((x, k) => x - at[5 + k]);
  assert.ok(gaps.every((g) => g >= 15 && g < 400), `bounded gaps: ${gaps}`);
  assert.equal(s.e2ee.detached(), null, "never stopped for good by refusals");
  s.e2ee.close();
  await new Promise((r) => setTimeout(r, 150));
  const n = at.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(at.length, n, "close ends the retries");
});

test("A9: the relay refuses the reattach longer than the quick tries, then recovers: the live session attaches by itself (one notice, no reconnect) and a queued delivery arrives", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await e2eeDevice(t, w, "alice");
  const bob = await e2eeDevice(t, w, "bob", { sessions: [] });
  const client = await w.client("bob", { session: "bob" });
  const live = bob.engine(client, "bob", { reattachBaseMs: 5, reattachMaxMs: 40 });
  await live.e2ee.attach();
  const notices = [];
  client.on("e2ee_detached", (m) => notices.push(m));
  let reconnects = 0;
  client.on("ready", () => reconnects++);
  let refusing = true;
  let refused = 0;
  const rpc = client.rpc.bind(client);
  client.rpc = (f) => (f.type === "proof_challenge" && refusing ? (refused++, Promise.reject(Object.assign(new Error("the relay is unavailable"), { kind: "relay_error", code: "unavailable" }))) : rpc(f));
  // A command rotates the device on another connection: the relay drops the live attachment.
  w.clock.advance(61_000);
  const cli = deviceStore({ home: bob.dir, profile: "relay-test", driver: createFakeDriver({ seed: "bob-cli", now: w.clock.now }), store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(bob.contacts, bob.dir, "relay-test") });
  await cli.rotate(await w.client("bob"));
  await until(() => refused >= 8, "refused beyond the quick tries", 10_000);
  // Meanwhile alice's message is queued for the device.
  assert.equal((await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "queued while refused" })).state, "accepted");
  refusing = false;
  const [m] = await until(() => (live.got.length ? live.got : null), "the queued delivery on the live session", 10_000);
  assert.equal(m.text, "queued while refused");
  assert.deepEqual([notices.length, reconnects], [1, 0], "one notice from the relay, no injected one, no reconnect");
});
