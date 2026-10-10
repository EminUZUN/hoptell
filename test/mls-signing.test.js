// Device signatures with the real OpenMLS driver (amendments-3.5-prep A3, A6, A7; manifest 5's
// binding): SignWithLabel and VerifyWithLabel against the shared vectors of identity.js's encoding,
// the driver's capability flag, the skipped-key bounds against policy.js, a standalone proposal
// refused with the state unchanged, and rotate, revoke and migrate end to end with the real
// driver (in process and from the command line), including a migrate interrupted after the retire
// step. The binding is the bake-off's build in the sibling worktree (or HOPTELL_MLS_WASM).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { BIN, ROOT } from "../lib/config.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { deviceStore } from "../lib/mls/device.js";
import { MAX_FORWARD_GENERATIONS, MAX_SKIPPED_PER_SENDER_EPOCH } from "../lib/mls/policy.js";
import { REVOKE_LABEL, ROTATE_LABEL, credentialIdentity, newDeviceId, readRotation, signContent, verifyWithLabel } from "../lib/mls/identity.js";
import { evaluate, pinFirstUse } from "../lib/mls/trust.js";
import { deviceRelay, memoryContacts, ownFor, tmpDir } from "./mls-helpers.js";

const require = createRequire(import.meta.url);
const BAKEOFF = path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm");
const WASM = process.env.HOPTELL_MLS_WASM || path.join(BAKEOFF, "pkg", "openmls_wasm.js");
// The bake-off's test-only build (feature test-proposals): only to send a standalone proposal.
const TEST_WASM = path.join(path.dirname(path.dirname(WASM)), "pkg-trace", "openmls_wasm.js");
const skip = fs.existsSync(WASM) ? false : `the OpenMLS WASM binding is not built (${WASM})`;
const VECTORS = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./vectors/sign-with-label-v1.json", import.meta.url)), "utf8"));
const PASS = "correct horse battery staple";
const unhex = (s) => Buffer.from(s, "hex");

test("SignWithLabel vectors: identity.js's encoding gives the shared SignContent bytes, and verifies the shared signatures", () => {
  assert.equal(VECTORS.format, "hoptell-sign-with-label-vectors-v1");
  const pk = unhex(VECTORS.publicKey);
  for (const v of VECTORS.cases) {
    assert.equal(signContent(v.label, unhex(v.content)).toString("hex"), v.signContent, v.name);
    assert.equal(verifyWithLabel(pk, v.label, unhex(v.content), unhex(v.signature)), true, v.name);
    assert.equal(verifyWithLabel(pk, v.label === ROTATE_LABEL ? REVOKE_LABEL : ROTATE_LABEL, unhex(v.content), unhex(v.signature)), false, `${v.name}: another label`);
  }
});

test("OpenMLS signing: the driver says signing: true; the binding signs with the device key over identity.js's bytes and verifies the shared vectors", { skip }, async () => {
  const d = createOpenMlsDriver(WASM);
  assert.equal(d.signing, true);
  assert.equal(typeof d.verify, "function");
  const dev = await d.createDevice(credentialIdentity({ realm: "0".repeat(32), member: `m_${"a".repeat(26)}`, device: newDeviceId() }));
  const pk = Buffer.from(dev.signaturePublicKey());
  const before = Buffer.from(await dev.exportState());
  for (const v of VECTORS.cases) {
    const content = unhex(v.content);
    const sig = Buffer.from(await dev.sign(v.label, content));
    assert.equal(sig.length, 64);
    assert.equal(verifyWithLabel(pk, v.label, content, sig), true, `${v.name}: identity.js verifies the binding's signature`);
    assert.equal(d.verify(pk, v.label, content, sig), true, `${v.name}: the binding verifies its own`);
    assert.equal(d.verify(unhex(VECTORS.publicKey), v.label, content, unhex(v.signature)), true, `${v.name}: the binding verifies the shared vector`);
    assert.equal(d.verify(pk, v.label, Buffer.concat([content, Buffer.from([0])]), sig), false, `${v.name}: other content`);
  }
  assert.ok(Buffer.from(await dev.exportState()).equals(before), "signing changes no state");
  // Only hoptell's labels: the binding refuses to sign an MLS structure's label.
  await assert.rejects(dev.sign("LeafNodeTBS", Buffer.from("x")), /refused label/);
  // The imported device signs with the same key.
  const again = await d.importDevice(await dev.exportState());
  assert.equal(Buffer.from(await again.sign(ROTATE_LABEL, Buffer.from("x"))).toString("hex"), Buffer.from(await dev.sign(ROTATE_LABEL, Buffer.from("x"))).toString("hex"));
});

test("OpenMLS skipped-key bounds: the binding's skip_limits() equal policy.js's (10 per sender per epoch, 200 forward), and a new group's own bounds too", { skip }, async () => {
  const d = createOpenMlsDriver(WASM);
  const want = { perSenderEpoch: MAX_SKIPPED_PER_SENDER_EPOCH, forward: MAX_FORWARD_GENERATIONS };
  assert.deepEqual(d.skipLimits(), want);
  const dev = await d.createDevice(credentialIdentity({ realm: "0".repeat(32), member: `m_${"s".repeat(26)}`, device: newDeviceId() }));
  const g = await dev.createGroup(crypto.randomBytes(16));
  assert.deepEqual(g.skipLimits(), want, "the group reports the bounds it was made with");
});

test("OpenMLS: a standalone proposal is refused by the binding; the device's exported state is byte-identical, and the next message and commit are processed", { skip: skip || (fs.existsSync(TEST_WASM) ? false : `the test-only build is not built (${TEST_WASM})`) }, async () => {
  const d = createOpenMlsDriver(WASM);
  const T = require(TEST_WASM);
  const id = (member) => credentialIdentity({ realm: "0".repeat(32), member: `m_${member.repeat(26)}`, device: newDeviceId() });
  const a = await d.createDevice(id("a"));
  const b = await d.createDevice(id("b"));
  const carol = new T.Device(d.suite, id("c")); // the proposer, from the test-only build
  const gid = crypto.randomBytes(16);
  const ga = await a.createGroup(gid);
  const out = await ga.commit({ add: [await b.keyPackage(), Uint8Array.from(carol.key_package())] });
  await ga.mergePending();
  const staged = await b.stageWelcome(out.welcome, out.ratchetTree);
  await staged.finish();
  const sc = carol.join_stage(out.welcome, out.ratchetTree);
  carol.join_finish(sc.handle);
  const gb = b.group(gid);
  const before = Buffer.from(await b.exportState());
  const proposal = carol.propose_for_test(gid, "remove", 0); // remove the creator (leaf 0)
  await assert.rejects(gb.process(proposal), (e) => e.attribution === "adapter" && /standalone proposal is refused/.test(e.message));
  assert.ok(Buffer.from(await b.exportState()).equals(before), "nothing of the proposal is kept");
  const m = carol.encrypt(gid, Buffer.from("after the proposal"), new Uint8Array());
  const p = await gb.process(m);
  assert.equal(Buffer.from(p.plaintext).toString(), "after the proposal");
  const u = carol.commit(gid, [], new Uint32Array(), true);
  carol.merge_pending(gid);
  const pc = await gb.process(u.commit);
  assert.equal(pc.kind, "commit");
  await pc.merge();
  assert.equal(gb.members().length, 3);
});

/** A home of `member` with the real OpenMLS driver. */
async function home(t, w, member, { machine = "machine-a", dir = tmpDir(t) } = {}) {
  const driver = createOpenMlsDriver(WASM);
  // Enrollment records the own-device baseline in the home's contacts (A1).
  const contacts = memoryContacts();
  const store = deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: PASS, keychainBackend: null, machine, now: w.clock.now, own: ownFor(contacts, dir, "relay-test") });
  return { dir, driver, store, contacts, client: await w.client(member) };
}

test("OpenMLS rotate end to end: the statement is signed by both keys in the binding, the relay takes it, a peer that pinned the old key follows it without a stop", { skip }, async (t) => {
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
  const after = b.store.record();
  assert.notEqual(after.key, before.key);
  assert.equal(r.published, 20, "the new key's packages");
  const served = (await a.client.rpc({ type: "device_list", member: w.members.bob.id })).devices;
  const st = served.find((d) => d.device === before.device).rotations.at(-1);
  const s = readRotation(st);
  assert.ok(s, "identity.js verifies both of the binding's signatures");
  assert.equal(s.oldKey.toString("base64"), before.key);
  assert.equal(s.newKey.toString("base64"), after.key);
  const ev = evaluate(doc, w.realm, w.members.bob.id, served);
  assert.equal(ev.state, "ok");
  assert.deepEqual(ev.rotated.map((x) => x.seq), [1]);
  // The rotated device's state holds the new key and signs with it.
  const statement = { ...st, sequence: 2 };
  assert.equal(readRotation(statement), null, "a statement altered after signing is refused");
});

test("OpenMLS revoke end to end: another device of the member signs the revocation in the binding; the relay applies it; a peer treats it as trusted; self-revocation completes", { skip }, async (t) => {
  const w = await deviceRelay(t);
  const laptop = await home(t, w, "alice", { machine: "laptop" });
  const desktop = await home(t, w, "alice", { machine: "desktop" });
  const phone = await home(t, w, "alice", { machine: "phone" });
  const bob = await home(t, w, "bob");
  const lost = (await laptop.store.enroll(laptop.client)).device;
  const keep = (await desktop.store.enroll(desktop.client)).device;
  const third = (await phone.store.enroll(phone.client)).device;
  const doc = { version: 1, default: "ask" };
  pinFirstUse(doc, w.realm, w.members.alice.id, evaluate(null, w.realm, w.members.alice.id, (await bob.client.rpc({ type: "device_list", member: w.members.alice.id })).devices).active);
  const r = await desktop.store.revoke(desktop.client, lost);
  assert.equal(r.state, "revoked");
  const served = (await bob.client.rpc({ type: "device_list", member: w.members.alice.id })).devices;
  assert.equal(served.find((d) => d.device === lost).revoked.device, keep);
  const ev = evaluate(doc, w.realm, w.members.alice.id, served);
  assert.deepEqual(ev.holdDevices, [lost]);
  assert.equal(ev.revoked.find((x) => x.device === lost).trusted, true, "identity.js verifies the binding's revocation signature against the pinned key");
  w.clock.advance(60_000);
  await assert.rejects(laptop.store.replenish(laptop.client, { force: 1 }), /revoked/);
  // A device revokes itself: the signed statement is pending, then confirmed.
  const self = await phone.store.revoke(phone.client, third);
  assert.equal(self.state, "revoked");
  assert.equal(phone.store.record().status, "revoked");
});

function run(env, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}
/** The environment of a fresh home for member `name`, with the real OpenMLS binding. */
function envOf(t, w, name, machine) {
  const home = tmpDir(t);
  fs.writeFileSync(path.join(home, "empty.env"), "");
  const env = {
    ...process.env,
    HOPTELL_ENV: path.join(home, "empty.env"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    HOPTELL_HOME: home,
    HOPTELL_RELAY: w.url,
    HOPTELL_TOKEN: w.members[name].token,
    HOPTELL_MLS_WASM: WASM,
    HOPTELL_CREDENTIAL_STORE: "file",
    HOPTELL_CREDENTIAL_PASSPHRASE: PASS,
    HOPTELL_MACHINE_ID: machine,
    HOPTELL_NOTIFY: "off",
    HOPTELL_STATE_DIR: path.join(home, "relay-state"),
    HOPTELL_EXPERIMENTAL_E2EE: "1",
  };
  for (const k of ["HOPTELL_NAME", "HOPTELL_PROFILE", "HOPTELL_RELAYS", "HOPTELL_AUTH", "HOPTELL_MLS_DRIVER"]) delete env[k];
  return env;
}

test("OpenMLS from the command line: rotate, migrate (the old device retired here and revoked at the relay with a binding signature)", { skip }, async (t) => {
  const w = await deviceRelay(t);
  const oldHome = envOf(t, w, "alice", "old-machine");
  const old = /Enrolled device ([a-z2-7]{26})/.exec((await run(oldHome, ["device", "enroll"])).stdout)?.[1];
  assert.ok(old);
  const rot = await run(oldHome, ["device", "rotate"]);
  assert.equal(rot.code, 0, rot.stderr);
  assert.match(rot.stdout, /Rotated to key sequence 1/);
  const backup = path.join(oldHome.HOPTELL_HOME, "backup.json");
  assert.equal((await run(oldHome, ["device", "backup", backup])).code, 0);
  const newHome = envOf(t, w, "alice", "new-machine");
  const m = await run(newHome, ["device", "migrate", backup]);
  assert.equal(m.code, 0, m.stderr);
  const fresh = /this machine is device ([a-z2-7]{26})/.exec(m.stdout)?.[1];
  assert.ok(fresh && fresh !== old, m.stdout);
  const list = await run(newHome, ["device", "list"]);
  assert.match(list.stdout, new RegExp(`${old}  revoked .* by device ${fresh}`));
  const again = await run(oldHome, ["device", "replenish", "--force"]);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /revoked/);
});

test("OpenMLS from the command line: a migrate interrupted after the retire step (and after the enrollment) recovers by running it again", { skip }, async (t) => {
  const w = await deviceRelay(t);
  const oldHome = envOf(t, w, "alice", "old-machine");
  const old = /Enrolled device ([a-z2-7]{26})/.exec((await run(oldHome, ["device", "enroll"])).stdout)?.[1];
  const backup = path.join(oldHome.HOPTELL_HOME, "backup.json");
  assert.equal((await run(oldHome, ["device", "backup", backup])).code, 0);

  // Interrupted after the retire step: migrate's first step (`device restore`) completed, durably,
  // and nothing after it ran. The old device is retired here and still active at the relay.
  const newHome = envOf(t, w, "alice", "new-machine");
  assert.equal((await run(newHome, ["device", "restore", backup])).code, 0);
  let st = await run(newHome, ["device", "status"]);
  assert.match(st.stdout, /No device for this relay yet/);
  const archived = () => fs.readdirSync(path.join(newHome.HOPTELL_HOME, "mls")).flatMap((p) => fs.readdirSync(path.join(newHome.HOPTELL_HOME, "mls", p)).filter((f) => f === `retired-${old}.json`));
  assert.equal(archived().length, 1, "the old device is archived retired here");
  assert.doesNotMatch((await run(newHome, ["device", "list"])).stdout, /revoked/);
  const m = await run(newHome, ["device", "migrate", backup]);
  assert.equal(m.code, 0, m.stderr);
  const fresh = /this machine is device ([a-z2-7]{26})/.exec(m.stdout)?.[1];
  assert.ok(fresh && fresh !== old);
  assert.match((await run(newHome, ["device", "list"])).stdout, new RegExp(`${old}  revoked .* by device ${fresh}`));
  st = await run(newHome, ["device", "status"]);
  assert.match(st.stdout, new RegExp(`Device ${fresh} \\(active\\)`));
  assert.equal((st.stdout.match(/Retired: /g) ?? []).length, 1, "the old device is archived once");

  // Interrupted after the enrollment too (retired, enrolled, not yet revoked): running migrate
  // again keeps the enrolled device and finishes the revocation.
  const w2 = await deviceRelay(t);
  const old2Home = envOf(t, w2, "alice", "old-machine");
  const old2 = /Enrolled device ([a-z2-7]{26})/.exec((await run(old2Home, ["device", "enroll"])).stdout)?.[1];
  const backup2 = path.join(old2Home.HOPTELL_HOME, "backup.json");
  assert.equal((await run(old2Home, ["device", "backup", backup2])).code, 0);
  const new2 = envOf(t, w2, "alice", "new-machine");
  assert.equal((await run(new2, ["device", "restore", backup2])).code, 0);
  const enrolled = /Enrolled device ([a-z2-7]{26})/.exec((await run(new2, ["device", "enroll"])).stdout)?.[1];
  const m2 = await run(new2, ["device", "migrate", backup2]);
  assert.equal(m2.code, 0, m2.stderr);
  assert.equal(/this machine is device ([a-z2-7]{26})/.exec(m2.stdout)?.[1], enrolled, "the same device, not a second enrollment");
  assert.match((await run(new2, ["device", "list"])).stdout, new RegExp(`${old2}  revoked .* by device ${enrolled}`));
});
