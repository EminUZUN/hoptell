// The relay's device directory and KeyPackage store (design 3.2, experimental): the flag gates
// everything; enrollment, single-use KeyPackages with atomic reservations, idempotent takes,
// burning, expiry, revocation (by a device and by the admin), rotation, hidden members, faults at
// each side of a commit and a killed relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BIN } from "../lib/config.js";
import { lockStateDir } from "../lib/realm.js";
import { openRelayDb } from "../lib/relaydb.js";
import { DEVICE_CAP } from "../lib/relay.js";
import { createDeviceDirectory, packageRef } from "../lib/mls/relaydir.js";
import { RELAY_MIGRATIONS } from "../lib/relaystore.js";
import { b64, makeRevocation, makeRotation, pinIdentity } from "../lib/mls/identity.js";
import { DAY, HOUR, KP_LIFETIME_MS } from "../lib/mls/policy.js";
import { deviceRelay, fakeDevice, refusal, tmpDir, tokenOf } from "./mls-helpers.js";
import { createAccess } from "../lib/access.js";

const CRASH = fileURLToPath(new URL("./fixtures/devicedir-crash.mjs", import.meta.url));

/** alice and bob each with an enrolled device; bob's pool has `n` packages. */
async function setup(t, { n = 3, ...opts } = {}) {
  const w = await deviceRelay(t, opts);
  const alice = await w.client("alice");
  const bob = await w.client("bob");
  const ad = await fakeDevice(w.realm, w.members.alice.id);
  const bd = await fakeDevice(w.realm, w.members.bob.id);
  await alice.rpc(ad.register());
  await bob.rpc(bd.register());
  if (n) await bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(n, w.clock.now() + KP_LIFETIME_MS) });
  const take = (request, target = { member: w.members.bob.id, device: bd.device }, client = alice, device = ad.device) => client.rpc({ type: "kp_take", request, device, target });
  return { w, alice, bob, ad, bd, take };
}

test("without the experimental flag nothing changes: no capability, frames unknown", async (t) => {
  const w = await deviceRelay(t, { devices: false });
  const c = await w.client("alice");
  assert.ok(!c.caps.includes(DEVICE_CAP));
  for (const type of ["device_register", "device_list", "kp_upload", "kp_take", "device_revoke"]) {
    assert.match((await refusal(c.rpc({ type }))).message, /unknown message type/, type);
  }
  assert.equal(fs.existsSync(path.join(w.dir, "relay.db")), false, "no store is created");
});

test("hoptell relay opens the store on every start (design 4.4); devices stay behind --experimental-e2ee", async (t) => {
  for (const flag of [false, true]) {
    const dir = tmpDir(t);
    const env = { ...process.env, HOPTELL_ENV: path.join(dir, "none.env"), HOPTELL_TOKEN: tokenOf(), HOPTELL_STATE_DIR: path.join(dir, "state") };
    delete env.HOPTELL_EXPERIMENTAL_E2EE;
    fs.writeFileSync(env.HOPTELL_ENV, "");
    const child = spawn(process.execPath, [BIN, "relay", "--host", "127.0.0.1", "--port", "0", ...(flag ? ["--experimental-e2ee"] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    try {
      await new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`relay did not start: ${out}`)), 10_000);
        child.stdout.on("data", (d) => {
          out += d;
          if (/listening/.test(out)) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", () => reject(new Error(`relay exited: ${out}`)));
      });
      assert.equal(fs.existsSync(path.join(env.HOPTELL_STATE_DIR, "relay.db")), true);
    } finally {
      process.kill(pid, "SIGTERM"); // only the process this test started, by its id
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    }
  }
});

test("device frames are for members on protocol 2: a shared-token connection is refused", async (t) => {
  const shared = tokenOf();
  const w = await deviceRelay(t, { shared });
  const c = await w.client(null, { token: shared });
  assert.ok(c.caps.includes(DEVICE_CAP));
  assert.equal((await refusal(c.rpc({ type: "device_list" }))).code, "member_only");
});

test("enrollment: the pin must be the relay's own computation; idempotent; another key is refused; bounded", async (t) => {
  const w = await deviceRelay(t);
  const alice = await w.client("alice");
  const d = await fakeDevice(w.realm, w.members.alice.id);
  assert.equal((await refusal(alice.rpc({ ...d.register(), pin: b64(Buffer.alloc(32)) }))).code, "bad_pin");
  // A device registered under another member's id: the pin binds the authenticated member.
  const forBob = await fakeDevice(w.realm, w.members.bob.id);
  assert.equal((await refusal(alice.rpc(forBob.register()))).code, "bad_pin");
  assert.equal((await alice.rpc(d.register())).state, "enrolled");
  assert.equal((await alice.rpc(d.register())).state, "unchanged");
  const other = await fakeDevice(w.realm, w.members.alice.id, { device: d.device });
  assert.equal((await refusal(alice.rpc(other.register()))).code, "key_mismatch");
  const list = await alice.rpc({ type: "device_list" });
  assert.equal(list.member, w.members.alice.id);
  assert.deepEqual(list.devices.map((x) => [x.device, x.key, x.pin]), [[d.device, b64(d.key), b64(pinIdentity({ realm: w.realm, member: w.members.alice.id, device: d.device, key: d.key }))]]);
  for (let i = 1; i < 20; i++) await alice.rpc((await fakeDevice(w.realm, w.members.alice.id)).register());
  assert.equal((await refusal(alice.rpc((await fakeDevice(w.realm, w.members.alice.id)).register()))).code, "too_many_devices");
});

test("KeyPackages: concurrent takes give distinct packages; a retry with the same request id the same one", async (t) => {
  const { w, take, alice } = await setup(t, { n: 6 });
  const carol = await w.client("carol");
  const cd = await fakeDevice(w.realm, w.members.carol.id);
  await carol.rpc(cd.register());
  const bobTarget = { member: w.members.bob.id, device: (await alice.rpc({ type: "device_list", member: w.members.bob.id })).devices[0].device };
  const results = await Promise.all([
    take("req-alice-1"),
    take("req-alice-2"),
    take("req-alice-3"),
    carol.rpc({ type: "kp_take", request: "req-carol-1", device: cd.device, target: bobTarget }),
    carol.rpc({ type: "kp_take", request: "req-carol-2", device: cd.device, target: bobTarget }),
  ]);
  assert.equal(new Set(results.map((r) => r.ref)).size, 5, "five distinct packages");
  assert.equal(new Set(results.map((r) => r.reservation)).size, 5);
  for (const r of results) assert.equal(packageRef(Buffer.from(r.kp, "base64")), r.ref);
  const again = await take("req-alice-2");
  assert.equal(again.ref, results[1].ref, "a retry returns the same package");
  assert.equal(again.reservation, results[1].reservation);
  // The same request id from another requester device is its own request.
  const ad2 = await fakeDevice(w.realm, w.members.alice.id);
  await alice.rpc(ad2.register());
  const other = await take("req-alice-2", bobTarget, alice, ad2.device);
  assert.notEqual(other.ref, results[1].ref);
  assert.equal((await refusal(take("req-alice-9"))).code, "no_key_package", "the pool is empty");
  assert.match((await refusal(take("req-alice-9"))).message, /no KeyPackage available/);
  // Retried after the pool emptied, the original request still answers with its own package.
  assert.equal((await take("req-alice-1")).ref, results[0].ref);
});

test("implementation note 1: the same request id with a changed target fails; ended reservations are terminal", async (t) => {
  const { w, take, alice, ad, bob, bd } = await setup(t, { n: 4 });
  const carol = await w.client("carol");
  const cd = await fakeDevice(w.realm, w.members.carol.id);
  await carol.rpc(cd.register());
  await carol.rpc({ type: "kp_upload", device: cd.device, packages: await cd.packages(1, w.clock.now() + DAY) });
  const r = await take("req-note1-a");
  assert.equal((await refusal(take("req-note1-a", { member: w.members.carol.id, device: cd.device }))).code, "request_reused");
  // Used: only the matching unconsumed reservation of this requester authorizes one addition.
  const use = (reservations, requester = { member: w.members.alice.id, device: ad.device }, targets = [{ member: w.members.bob.id, device: bd.device }]) =>
    w.db.tx((h) => w.directory.useReservations(h, { requester, reservations, targets }));
  assert.throws(() => use([r.reservation], { member: w.members.carol.id, device: cd.device }), (e) => e.code === "no_reservation", "another requester");
  assert.throws(() => use([r.reservation], undefined, [{ member: w.members.carol.id, device: cd.device }]), (e) => e.code === "no_reservation", "another target");
  use([r.reservation]);
  assert.throws(() => use([r.reservation]), (e) => e.code === "reservation_ended", "used once only");
  assert.equal((await refusal(take("req-note1-a"))).code, "reservation_ended", "a retry after use is terminal");
  // Burned (abandoned): terminal too, and the package never returns to the pool.
  const b = await take("req-note1-b");
  assert.equal((await alice.rpc({ type: "kp_abandon", device: ad.device, reservation: b.reservation })).state, "burned");
  assert.equal((await refusal(take("req-note1-b"))).code, "reservation_ended");
  assert.throws(() => use([b.reservation]), (e) => e.code === "reservation_ended");
  const reupload = await bob.rpc({ type: "kp_upload", device: bd.device, packages: [{ kp: b.kp, not_after: b.not_after }] });
  assert.equal(reupload.accepted, 0, "a taken package is never published again");
  const taken = new Set([r.ref, b.ref]);
  for (const req of ["req-note1-c", "req-note1-d"]) assert.ok(!taken.has((await take(req)).ref));
  assert.equal((await refusal(take("req-note1-e"))).code, "no_key_package");
});

test("an abandoned reservation burns after an hour; expiry at the relay; replenishment status", async (t) => {
  const { w, take, bob, bd, ad } = await setup(t, { n: 2 });
  await take("req-burn-1");
  w.clock.advance(HOUR + 1);
  assert.deepEqual(w.directory.sweep(), { expired: 0, burned: 1, forgotten: 0 });
  assert.equal((await refusal(take("req-burn-1"))).code, "reservation_ended");
  const st = await bob.rpc({ type: "kp_status", device: bd.device });
  assert.deepEqual([st.available, st.reserved], [1, 0], "the burned package is gone, not back in the pool");
  // A package that expires: the relay stops serving it at its not_after.
  await bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w.clock.now() + 1000) });
  assert.equal((await bob.rpc({ type: "kp_status", device: bd.device })).available, 2);
  w.clock.advance(1000);
  assert.equal((await bob.rpc({ type: "kp_status", device: bd.device })).available, 1);
  await take("req-exp-1");
  assert.equal((await refusal(take("req-exp-2"))).code, "no_key_package", "the expired one is not served");
  // A reservation whose package expires before an accepted commit is terminal.
  await bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w.clock.now() + 5000) });
  const soon = await take("req-exp-3");
  w.clock.advance(5000);
  assert.equal((await refusal(take("req-exp-3"))).code, "reservation_ended");
  assert.equal(w.directory.sweep().expired, 1);
  assert.throws(() => w.db.tx((h) => w.directory.useReservations(h, { requester: { member: w.members.alice.id, device: ad.device }, reservations: [soon.reservation] })), (e) => e.code === "reservation_ended");
  // Uploads are bounded: lifetimes within 14 days, at most 20 outstanding.
  assert.equal((await refusal(bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w.clock.now() + 15 * DAY) }))).code, "bad_request");
  assert.equal((await refusal(bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w.clock.now() - 1) }))).code, "bad_request");
  const before = await bob.rpc({ type: "kp_status", device: bd.device });
  await bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(20 - before.available - before.reserved, w.clock.now() + DAY) });
  const full = await bob.rpc({ type: "kp_status", device: bd.device });
  assert.equal(full.available + full.reserved, 20);
  assert.equal((await refusal(bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w.clock.now() + DAY) }))).code, "too_many_key_packages");
});

test("a take is atomic: a fault before the commit changes nothing; after it, the retry finds the reservation", async (t) => {
  const { w, take, bob, bd } = await setup(t, { n: 2 });
  w.fault.arm("before-commit");
  assert.equal((await refusal(take("req-fault-1"))).code, "unavailable");
  assert.equal((await bob.rpc({ type: "kp_status", device: bd.device })).available, 2, "the package is still in the pool");
  assert.equal(w.db.get("SELECT count(*) AS n FROM kp_reservations").n, 0);
  const first = await take("req-fault-1");
  // The answer is lost after the commit: the retry with the same request id gets the same package.
  w.fault.arm("after-commit");
  assert.equal((await refusal(take("req-fault-2"))).code, "unavailable");
  const retried = await take("req-fault-2");
  assert.notEqual(retried.ref, first.ref);
  assert.equal(w.db.get("SELECT count(*) AS n FROM kp_reservations WHERE request = 'req-fault-2'").n, 1);
  assert.equal((await bob.rpc({ type: "kp_status", device: bd.device })).available, 0);
  // Durable across a restart of the relay.
  await w.restart();
  const alice = await w.client("alice");
  const ad = w.db.get("SELECT requester_device FROM kp_reservations WHERE request = 'req-fault-2'").requester_device;
  assert.equal((await alice.rpc({ type: "kp_take", request: "req-fault-2", device: ad, target: { member: w.members.bob.id, device: bd.device } })).ref, retried.ref);
});

test("a relay killed at either side of a take's commit: the pool and the reservation agree", async (t) => {
  for (const point of ["before-commit", "after-commit"]) {
    const dir = tmpDir(t);
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [CRASH, dir, point], { timeout: 20_000 }, (err, stdout, stderr) => (err?.signal === "SIGKILL" ? resolve() : reject(new Error(`the fixture did not die at ${point}: ${stdout}${stderr}`))));
    });
    const release = lockStateDir(dir);
    try {
      const db = openRelayDb({ dir, migrations: RELAY_MIGRATIONS });
      const pool = db.get("SELECT count(*) AS n FROM key_packages").n;
      const reserved = db.get("SELECT count(*) AS n FROM kp_reservations").n;
      assert.deepEqual([pool, reserved], point === "before-commit" ? [1, 0] : [0, 1], point);
      db.close();
    } finally {
      release();
    }
  }
});

test("hidden members: the visibility hook filters device_list and kp_take", async (t) => {
  // The hook lib/access.js plugs into (design 4.2): here alice may not reach bob while `hidden` is set.
  let hidden = null;
  const visible = (caller, target) => !(hidden && caller === hidden.from && target === hidden.to);
  const { w, take, alice, bob, bd } = await setup(t, { n: 1, visible });
  hidden = { from: w.members.alice.id, to: w.members.bob.id };
  assert.deepEqual((await alice.rpc({ type: "device_list", member: w.members.bob.id })).devices, []);
  const unknown = await refusal(take("req-hidden-1", { member: w.members.bob.id, device: bd.device }));
  const absent = await refusal(take("req-hidden-2", { member: w.members.carol.id, device: bd.device }));
  assert.deepEqual([unknown.code, unknown.message], [absent.code, absent.message], "hidden looks like absent");
  assert.equal((await bob.rpc({ type: "device_list" })).devices.length, 1, "own devices are always listed");
  hidden = null;
  assert.equal((await alice.rpc({ type: "device_list", member: w.members.bob.id })).devices.length, 1);
  assert.ok(await take("req-hidden-1"));
});

test("with access configured, a hidden member's devices follow its grants", async (t) => {
  let acc;
  const { w, take, alice, bd } = await setup(t, {
    n: 1,
    access: (members) => {
      acc = createAccess({ stateDir: tmpDir(t), policy: null });
      // bob is hidden and lets only carol reach him.
      acc.putGrants(members.bob.id, 0, { default: "deny", visible: "grantees", entries: [{ selector: `member:${members.carol.id}`, action: "allow" }] });
      return acc;
    },
  });
  assert.deepEqual((await alice.rpc({ type: "device_list", member: w.members.bob.id })).devices, [], "alice is not granted");
  const hidden = await refusal(take("req-acc-1"));
  const absent = await refusal(take("req-acc-2", { member: w.members.carol.id, device: bd.device }));
  assert.deepEqual([hidden.code, hidden.message], [absent.code, absent.message]);
  const carol = await w.client("carol");
  assert.equal((await carol.rpc({ type: "device_list", member: w.members.bob.id })).devices.length, 1, "carol is granted");
  acc.putGrants(w.members.bob.id, 1, { default: "deny", visible: "grantees", entries: [{ selector: `member:${w.members.carol.id}`, action: "allow" }, { selector: `member:${w.members.alice.id}`, action: "allow" }] });
  assert.equal((await alice.rpc({ type: "device_list", member: w.members.bob.id })).devices.length, 1, "after alice is granted");
});

test("revocation from another device: signed, at once, the id never reused; a revoked device cannot act", async (t) => {
  const { w, alice, ad } = await setup(t, { n: 0 });
  const bob = await w.client("bob");
  const bd = (await bob.rpc({ type: "device_list" })).devices[0].device;
  const ad2 = await fakeDevice(w.realm, w.members.alice.id);
  await alice.rpc(ad2.register());
  await alice.rpc({ type: "kp_upload", device: ad2.device, packages: await ad2.packages(3, w.clock.now() + DAY) });
  // bob holds an open reservation of the device to be revoked.
  const r = await bob.rpc({ type: "kp_take", request: "req-rev-1", device: bd, target: { member: w.members.alice.id, device: ad2.device } });
  const statement = (by, signer, device = ad2.device) => makeRevocation({ realm: w.realm, member: w.members.alice.id, device, by, at: w.clock.now() }, (l, c) => signer.sign(l, c));
  // Signed by a device that is not the one named: refused.
  const wrong = await statement(ad.device, ad2.dev);
  assert.equal((await refusal(alice.rpc({ type: "device_revoke", device: ad2.device, by_device: ad.device, statement: wrong }))).code, "bad_statement");
  // bob cannot revoke alice's device (it is not his member).
  assert.notEqual((await refusal(bob.rpc({ type: "device_revoke", device: ad2.device, by_device: bd, statement: await statement(bd, ad.dev) }))).code, undefined);
  const ok = await alice.rpc({ type: "device_revoke", device: ad2.device, by_device: ad.device, statement: await statement(ad.device, ad.dev) });
  assert.equal(ok.state, "revoked");
  const listed = (await bob.rpc({ type: "device_list", member: w.members.alice.id })).devices.find((d) => d.device === ad2.device);
  assert.equal(listed.key, undefined, "its directory entry is no longer served");
  assert.equal(listed.revoked.by, "device");
  assert.equal(listed.revoked.device, ad.device);
  assert.ok(listed.revoked.statement, "the signed statement is served for peers to check");
  assert.equal((await refusal(bob.rpc({ type: "kp_take", request: "req-rev-2", device: bd, target: { member: w.members.alice.id, device: ad2.device } }))).code, "no_device");
  assert.equal(w.db.get("SELECT count(*) AS n FROM key_packages WHERE device_id = ?", ad2.device).n, 0, "its pool is emptied");
  assert.equal(w.db.get("SELECT state FROM kp_reservations WHERE reservation = ?", r.reservation).state, "burned", "open reservations burn");
  assert.equal((await refusal(alice.rpc(ad2.register()))).code, "device_revoked", "a revoked id is refused at enroll");
  assert.equal((await refusal(alice.rpc({ type: "kp_upload", device: ad2.device, packages: await ad2.packages(1, w.clock.now() + DAY) }))).code, "device_revoked");
  assert.equal((await refusal(alice.rpc({ type: "kp_take", request: "req-rev-3", device: ad2.device, target: { member: w.members.bob.id, device: bd } }))).code, "device_revoked");
});

test("revocation by the relay admin (members file): applied at reload, durable, the id refused at enroll", async (t) => {
  const { w, alice, ad } = await setup(t, { n: 0 });
  const members = Object.values(w.members).map((m) => (m.name === "alice" ? { ...m, devicesRevoked: [ad.device] } : m));
  w.relay.reload(members);
  const list = (await alice.rpc({ type: "device_list" })).devices;
  assert.equal(list[0].revoked.by, "admin");
  assert.equal((await refusal(alice.rpc(ad.register()))).code, "device_revoked");
  // An id the admin revoked before it was ever enrolled is refused too.
  const later = await fakeDevice(w.realm, w.members.alice.id);
  w.relay.reload(Object.values(w.members).map((m) => (m.name === "alice" ? { ...m, devicesRevoked: [ad.device, later.device] } : m)));
  assert.equal((await refusal(alice.rpc(later.register()))).code, "device_revoked");
  await w.restart();
  const again = await w.client("alice");
  assert.equal((await refusal(again.rpc(ad.register()))).code, "device_revoked", "durable across a restart");
  assert.throws(() => w.relay.reload([{ name: "alice", id: w.members.alice.id, token: w.members.alice.token, devicesRevoked: ["not-a-device"] }]), /devicesRevoked/);
});

test("rotation at the relay: chained statements replace the key and its packages; a forged one is refused", async (t) => {
  const { w, alice, ad } = await setup(t, { n: 0 });
  await alice.rpc({ type: "kp_upload", device: ad.device, packages: await ad.packages(2, w.clock.now() + DAY) });
  const next = await ad.driver.createDevice(ad.dev.identity);
  const newKey = Buffer.from(next.signaturePublicKey());
  const frame = (statement) => ({ type: "device_register", device: ad.device, key: b64(newKey), pin: b64(pinIdentity({ realm: w.realm, member: w.members.alice.id, device: ad.device, key: newKey })), rotation: statement });
  const st = (seq, signOld) => makeRotation({ realm: w.realm, member: w.members.alice.id, device: ad.device, oldKey: ad.key, newKey, sequence: seq }, signOld, (l, c) => next.sign(l, c));
  assert.equal((await refusal(alice.rpc(frame(await st(2, (l, c) => ad.dev.sign(l, c)))))).code, "bad_rotation", "the sequence must follow");
  assert.equal((await refusal(alice.rpc(frame(await st(1, (l, c) => next.sign(l, c)))))).code, "bad_rotation", "forged: not signed by the old key");
  const ok = await alice.rpc(frame(await st(1, (l, c) => ad.dev.sign(l, c))));
  assert.deepEqual([ok.state, ok.seq], ["rotated", 1]);
  const d = (await alice.rpc({ type: "device_list" })).devices[0];
  assert.equal(d.key, b64(newKey));
  assert.equal(d.rotations.length, 1);
  assert.equal((await alice.rpc({ type: "kp_status", device: ad.device })).available, 0, "the old key's packages are dropped");
  assert.equal((await refusal(alice.rpc(ad.register()))).code, "key_mismatch", "the old key cannot come back without a statement");
});

test("the directory survives its store: a damaged schema refuses to open", async (t) => {
  const dir = tmpDir(t);
  const release = lockStateDir(dir);
  t.after(release);
  const db = openRelayDb({ dir, migrations: RELAY_MIGRATIONS, fullfsync: false });
  const directory = createDeviceDirectory({ db, realm: "0".repeat(32) });
  assert.deepEqual(directory.list("m_" + "a".repeat(26)), []);
  db.close();
  const raw = new (await import("node:sqlite")).DatabaseSync(path.join(dir, "relay.db"));
  raw.exec("DROP INDEX key_packages_pool");
  raw.close();
  assert.throws(() => openRelayDb({ dir, migrations: RELAY_MIGRATIONS }), /changed outside hoptell/);
});

test("admin revocations that cannot be stored: the reload fails and device service pauses until the sweep stores them, also when part of the list was stored", async (t) => {
  const { w, alice } = await setup(t, { n: 0, sweepMs: 1000 });
  const devices = [];
  for (let i = 0; i < 3; i++) {
    const d = await fakeDevice(w.realm, w.members.alice.id);
    await alice.rpc(d.register());
    devices.push(d);
  }
  const revokedIds = () => w.db.all("SELECT device_id FROM device_revocations").map((r) => r.device_id).sort();
  const members = Object.values(w.members).map((m) => (m.name === "alice" ? { ...m, devicesRevoked: devices.map((d) => d.device) } : m));
  // Only the first device's transaction fails: the others are stored, and the reload still fails.
  w.fault.arm("before-commit");
  assert.throws(() => w.relay.reload(members), (e) => e.membersApplied === true && /device revocations/.test(e.message));
  w.fault.arm("before-commit", Infinity); // the store stays broken while we look
  assert.deepEqual(revokedIds(), [devices[1].device, devices[2].device].sort());
  // Every device frame is refused as retryable meanwhile: the unrevoked device is not served.
  assert.equal((await refusal(alice.rpc({ type: "device_list" }))).code, "unavailable");
  assert.equal((await refusal(alice.rpc(devices[0].register()))).code, "unavailable");
  // The store recovers: the sweep stores the rest and service resumes.
  w.fault.disarm();
  let list;
  for (let i = 0; i < 100 && !list; i++) {
    await new Promise((r) => setTimeout(r, 100));
    list = await alice.rpc({ type: "device_list" }).catch((e) => (e.code === "unavailable" ? null : Promise.reject(e)));
  }
  assert.ok(list, "device service resumed");
  assert.deepEqual(revokedIds(), devices.map((d) => d.device).sort());
  for (const d of devices) assert.equal(list.devices.find((x) => x.device === d.device).revoked.by, "admin");
});

test("admin revocations that cannot be stored at start: the relay does not start, also when part of the list was stored", async (t) => {
  const { w, alice } = await setup(t, { n: 0 });
  const a1 = await fakeDevice(w.realm, w.members.alice.id);
  const a2 = await fakeDevice(w.realm, w.members.alice.id);
  await alice.rpc(a1.register());
  await alice.rpc(a2.register());
  w.members.alice.devicesRevoked = [a1.device, a2.device];
  w.fault.arm("before-commit", Infinity);
  await assert.rejects(w.restart(), /device revocations could not be stored.*does not start/);
  w.fault.arm("before-commit"); // only the first: a2 is stored, a1 is not
  await assert.rejects(w.restart(), /device revocations could not be stored/);
  assert.deepEqual(w.db.all("SELECT device_id FROM device_revocations").map((r) => r.device_id), [a2.device]);
  await w.restart();
  const list = (await (await w.client("alice")).rpc({ type: "device_list" })).devices;
  for (const d of [a1, a2]) assert.equal(list.find((x) => x.device === d.device).revoked.by, "admin");
});

// ---- suspension after a restore (design 4.4) ----------------------------------------------------

/** Suspend a device as a restore with an unreadable old store does (phase 4). */
const suspend = (w, member, device) => w.db.tx((h) => h.run("UPDATE devices SET suspended = 1 WHERE member_id = ? AND device_id = ?", member, device));

test("suspension (design 4.4): every use of the device is refused, re-registration never reinstates it; reinstate restores every path", async (t) => {
  const { w, alice, bob, ad, bd, take } = await setup(t, { n: 3 });
  const B = w.members.bob.id;
  suspend(w, B, bd.device);
  // discovery: no directory entry, no KeyPackage served (to others, as for an unknown device).
  const listed = (await alice.rpc({ type: "device_list", member: B })).devices.find((d) => d.device === bd.device);
  assert.equal(listed.key, undefined, "no directory entry");
  assert.equal(listed.suspended, true);
  assert.equal((await refusal(take("req-sus-1"))).code, "no_device");
  // its own use: uploads, status, takes, revoking another device.
  assert.equal((await refusal(bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w.clock.now() + DAY) }))).code, "device_suspended");
  assert.equal((await refusal(bob.rpc({ type: "kp_status", device: bd.device }))).code, "device_suspended");
  assert.equal((await refusal(bob.rpc({ type: "kp_take", request: "req-sus-2", device: bd.device, target: { member: w.members.alice.id, device: ad.device } }))).code, "device_suspended");
  const bd2 = await fakeDevice(w.realm, B);
  await bob.rpc(bd2.register()); // a new device id of the same member enrolls normally
  const statement = await makeRevocation({ realm: w.realm, member: B, device: bd2.device, by: bd.device, at: w.clock.now() }, (l, c) => bd.dev.sign(l, c));
  assert.equal((await refusal(bob.rpc({ type: "device_revoke", device: bd2.device, by_device: bd.device, statement }))).code, "device_suspended");
  // re-registration with the same id and key (idempotent before), and reconnecting: the flag stays.
  assert.equal((await refusal(bob.rpc(bd.register()))).code, "device_suspended");
  await w.restart();
  const bobAgain = await w.client("bob");
  assert.equal((await refusal(bobAgain.rpc(bd.register()))).code, "device_suspended");
  assert.equal(Number(w.db.get("SELECT suspended FROM devices WHERE device_id = ?", bd.device).suspended), 1);
  // The 3.3 commit path's check: a suspended requester's reservations authorize nothing.
  assert.throws(() => w.db.tx((h) => w.directory.useReservations(h, { requester: { member: B, device: bd.device }, reservations: [] })), /suspended/);
  // reinstate (the admin's recovery step): every path works again.
  assert.deepEqual(w.directory.reinstate({ member: B, device: bd.device }), { state: "reinstated" });
  assert.equal((await bobAgain.rpc(bd.register())).state, "unchanged");
  assert.equal((await bobAgain.rpc({ type: "kp_status", device: bd.device })).available, 3);
  const alice2 = await w.client("alice");
  assert.ok((await alice2.rpc({ type: "kp_take", request: "req-sus-3", device: ad.device, target: { member: B, device: bd.device } })).kp);
  assert.ok((await alice2.rpc({ type: "device_list", member: B })).devices.find((d) => d.device === bd.device).key);
  assert.deepEqual(w.directory.reinstate({ member: B, device: bd.device }), { state: "not_suspended" });
});

test("suspension: a suspended device may be revoked; a revoked one is never reinstated; the reinstatement and its record are one transaction", async (t) => {
  const { w, bd } = await setup(t, { n: 1 });
  const B = w.members.bob.id;
  suspend(w, B, bd.device);
  // The audit row cannot be written: nothing changes.
  assert.throws(() => w.directory.reinstate({ member: B, device: bd.device, record: () => { throw new Error("audit refused"); } }), /audit refused/);
  assert.equal(Number(w.db.get("SELECT suspended FROM devices WHERE device_id = ?", bd.device).suspended), 1);
  assert.equal(w.directory.revoke({ member: B, device: bd.device, by: { kind: "admin" } }).state, "revoked");
  assert.throws(() => w.directory.reinstate({ member: B, device: bd.device }), /revoked; a revoked device is never reinstated/);
});
