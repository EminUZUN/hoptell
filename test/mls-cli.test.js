// The experimental device commands from the command line (design 3.2): refused without
// HOPTELL_EXPERIMENTAL_E2EE=1; with it (and the fake driver), enroll, list, contacts verify with a
// safety number, pinning on confirmation, and the admin's members device-revoke.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BIN } from "../lib/config.js";
import { RelayClient } from "../lib/client.js";
import { DEVICE_CAP } from "../lib/relay.js";
import { verifyCommand } from "../lib/mls/cli.js";
import { deviceStore } from "../lib/mls/device.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { deviceRelay, fakeDevice, memoryContacts as testMemory, tmpDir } from "./mls-helpers.js";
import { ownKeeper, writeBaseline } from "../lib/mls/own.js";

const FAKE = fileURLToPath(new URL("./fake-mls-driver.js", import.meta.url));

function run(env, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

/** The environment of a fresh home for member `name`. */
function envOf(t, w, name, { flag = true } = {}) {
  const home = tmpDir(t);
  fs.writeFileSync(path.join(home, "empty.env"), "");
  const env = {
    ...process.env,
    HOPTELL_ENV: path.join(home, "empty.env"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    HOPTELL_HOME: home,
    HOPTELL_RELAY: w.url,
    HOPTELL_TOKEN: w.members[name].token,
    HOPTELL_MLS_DRIVER: FAKE,
    HOPTELL_FAKE_MLS_SEED: `${name}-${home}`,
    HOPTELL_CREDENTIAL_STORE: "file",
    HOPTELL_CREDENTIAL_PASSPHRASE: "correct horse battery staple",
    HOPTELL_MACHINE_ID: `machine-of-${name}`,
    HOPTELL_NOTIFY: "off",
    HOPTELL_STATE_DIR: path.join(home, "relay-state"), // members commands record in this relay's audit log, never the real one
  };
  for (const k of ["HOPTELL_NAME", "HOPTELL_PROFILE", "HOPTELL_RELAYS", "HOPTELL_AUTH", "HOPTELL_MLS_WASM"]) delete env[k];
  if (flag) env.HOPTELL_EXPERIMENTAL_E2EE = "1";
  else delete env.HOPTELL_EXPERIMENTAL_E2EE;
  return env;
}

test("without HOPTELL_EXPERIMENTAL_E2EE the device commands are refused and change nothing", async (t) => {
  const w = await deviceRelay(t);
  const env = envOf(t, w, "alice", { flag: false });
  for (const args of [["device", "enroll"], ["contacts", "verify", w.members.bob.id], ["contacts", "accept-device", w.members.bob.id, "a".repeat(26)]]) {
    const r = await run(env, args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /experimental/);
  }
  assert.equal(fs.existsSync(path.join(env.HOPTELL_HOME, "mls")), false);
  const members = path.join(env.HOPTELL_HOME, "members.json");
  fs.writeFileSync(members, JSON.stringify({ members: [{ name: "alice", id: w.members.alice.id, token: w.members.alice.token }] }), { mode: 0o600 });
  const r = await run(env, ["members", "device-revoke", "alice", "a".repeat(26), "--members", members]);
  assert.equal(r.code, 2);
});

test("enroll, list, verify with a safety number, then pin on confirmation", async (t) => {
  const w = await deviceRelay(t);
  const alice = envOf(t, w, "alice");
  const bob = envOf(t, w, "bob");
  const ea = await run(alice, ["device", "enroll"]);
  assert.equal(ea.code, 0, ea.stderr);
  assert.match(ea.stdout, /Enrolled device [a-z2-7]{26} of member m_/);
  assert.match(ea.stdout, /Fingerprint: (\d{5} ){11}\d{5}/);
  assert.match(ea.stdout, /20 KeyPackage\(s\) published/);
  assert.equal((await run(bob, ["device", "enroll"])).code, 0);
  const st = await run(alice, ["device", "status"]);
  assert.match(st.stdout, /\(active\)/);
  const list = await run(alice, ["device", "list"]);
  assert.match(list.stdout, /\(this device\)/);

  const shown = await run(alice, ["contacts", "verify", w.members.bob.id]);
  assert.equal(shown.code, 0, shown.stderr);
  const number = /Safety number with \S+: ((\d{5} ){11}\d{5})/.exec(shown.stdout)?.[1];
  assert.ok(number, shown.stdout);
  assert.match(shown.stdout, /--yes --how in-person/);
  assert.equal(fs.readFileSync(path.join(alice.HOPTELL_HOME, "contacts.json"), "utf8").includes('"pins"'), false, "nothing is pinned before the confirmation");
  // bob computes the same number from his side.
  const fromBob = await run(bob, ["contacts", "verify", w.members.alice.id]);
  assert.equal(/Safety number with \S+: ((\d{5} ){11}\d{5})/.exec(fromBob.stdout)?.[1], number);
  assert.equal((await run(alice, ["contacts", "verify", w.members.bob.id, "--yes"])).code, 1, "--how is required");
  assert.equal((await run(alice, ["contacts", "verify", w.members.bob.id, "--yes", "--how", "in-person"])).code, 1, "--set is required");
  const code = /--set ([0-9a-f]{32})/.exec(shown.stdout)?.[1];
  assert.ok(code, shown.stdout);
  const pinned = await run(alice, ["contacts", "verify", w.members.bob.id, "--yes", "--how", "in-person", "--set", code]);
  assert.equal(pinned.code, 0, pinned.stderr);
  assert.match(pinned.stdout, /Pinned 1 device\(s\)/);
  const doc = JSON.parse(fs.readFileSync(path.join(alice.HOPTELL_HOME, "contacts.json"), "utf8"));
  assert.deepEqual([doc.pins[0].member, doc.pins[0].how, doc.pins[0].devices.length], [w.members.bob.id, "in-person", 1]);
  assert.doesNotMatch(pinned.stdout + shown.stdout, /[A-Za-z0-9+/]{43}=/, "no key is printed");
});

test("the admin revokes a device in the members file; the relay applies it on reload", async (t) => {
  const w = await deviceRelay(t);
  const alice = envOf(t, w, "alice");
  const ea = await run(alice, ["device", "enroll"]);
  const device = /Enrolled device ([a-z2-7]{26})/.exec(ea.stdout)[1];
  const members = path.join(alice.HOPTELL_HOME, "members.json");
  fs.writeFileSync(members, JSON.stringify({ members: Object.values(w.members) }), { mode: 0o600 });
  const r = await run(alice, ["members", "device-revoke", "alice", device, "--members", members]);
  assert.equal(r.code, 0, r.stderr);
  const file = JSON.parse(fs.readFileSync(members, "utf8"));
  assert.deepEqual(file.members.find((m) => m.name === "alice").devicesRevoked, [device]);
  w.relay.reload(file.members);
  const st = await run(alice, ["device", "replenish", "--force"]);
  assert.notEqual(st.code, 0);
  assert.match(st.stderr, /revoked/);
});

test("doctor states the same-machine raw-rollback limit; a relay without the flag is named as such", async (t) => {
  const w = await deviceRelay(t);
  const alice = envOf(t, w, "alice");
  await run(alice, ["device", "enroll"]);
  const d = await run(alice, ["doctor"]);
  assert.match(d.stdout, /encrypted messaging: experimental, not independently reviewed/);
  assert.match(d.stdout, /device keys: experimental; profile \S+: device [a-z2-7]{26} is active/);
  assert.match(d.stdout, /older raw copy of this home on the same machine .* not detected; there is no freshness anchor yet/);
  const plain = await deviceRelay(t, { devices: false });
  const r = await run({ ...envOf(t, plain, "alice"), HOPTELL_TOKEN: plain.members.alice.token }, ["device", "enroll"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not started with --experimental-e2ee/);
});

test("hoptell device migrate: the old device is retired here and revoked at the relay, the new machine enrolled", async (t) => {
  const w = await deviceRelay(t);
  const oldHome = envOf(t, w, "alice");
  const old = /Enrolled device ([a-z2-7]{26})/.exec((await run(oldHome, ["device", "enroll"])).stdout)[1];
  const backup = path.join(oldHome.HOPTELL_HOME, "backup.json");
  assert.equal((await run(oldHome, ["device", "backup", backup])).code, 0);
  const newHome = { ...envOf(t, w, "alice"), HOPTELL_MACHINE_ID: "the-new-machine" };
  const m = await run(newHome, ["device", "migrate", backup]);
  assert.equal(m.code, 0, m.stderr);
  const fresh = /this machine is device ([a-z2-7]{26})/.exec(m.stdout)?.[1];
  assert.ok(fresh && fresh !== old, m.stdout);
  const st = await run(newHome, ["device", "status"]);
  assert.match(st.stdout, new RegExp(`Retired: ${old} \\(restored from a backup\\)`));
  const list = await run(newHome, ["device", "list"]);
  assert.match(list.stdout, new RegExp(`${old}  revoked .* by device ${fresh}`));
  assert.match(list.stdout, new RegExp(`${fresh}  .*\\(this device\\)`));
  // The old home can no longer publish: the relay refuses its revoked device.
  const again = await run(oldHome, ["device", "replenish", "--force"]);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /revoked/);
});

/** A contacts manager over an in-memory policy, revised like lib/quarantine.js's; `meanwhile` runs inside the lock first. */
function memoryContacts(doc, { meanwhile = null } = {}) {
  return {
    currentPolicy: () => ({ doc: structuredClone(doc) }),
    async updatePins(mutate) {
      meanwhile?.(doc);
      const next = structuredClone(doc);
      const result = mutate(next);
      next.revision = (next.revision ?? 0) + 1;
      Object.assign(doc, next);
      return { revision: next.revision, result };
    },
  };
}

test("verify pins only the set that was shown: a device replaced between the display and --yes is refused (the reviewer's reproduction)", async (t) => {
  const w = await deviceRelay(t);
  const homes = {};
  for (const name of ["alice", "bob"]) {
    const dir = tmpDir(t);
    const store = deviceStore({ home: dir, profile: "p", driver: createFakeDriver({ seed: dir, now: w.clock.now }), store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now, own: ownKeeper({ contacts: testMemory(), home: dir, profile: "p" }) });
    const client = await w.client(name);
    await store.enroll(client);
    homes[name] = { dir, store, client };
  }
  const doc = withOwn({ version: 1, default: "ask", grants: [], blocks: [] }, homes.alice.store.record());
  const opts = { sub: "verify", member: w.members.bob.id, home: homes.alice.dir, profile: "p", connect: () => w.client("alice"), contacts: memoryContacts(doc) };
  const shown = [];
  await verifyCommand({ ...opts, say: (x) => shown.push(x) });
  const code = /--set ([0-9a-f]{32})/.exec(shown.at(-1))?.[1];
  // Bob's only device is replaced before Alice confirms what she compared.
  const original = homes.bob.store.record();
  w.directory.revoke({ member: original.member, device: original.device, by: { kind: "admin" } });
  const replacement = await fakeDevice(w.realm, w.members.bob.id);
  await replacement.registerOn(homes.bob.client); // A9: with a register proof
  const confirmed = [];
  let refused;
  await assert.rejects(verifyCommand({ ...opts, yes: true, how: "out-of-band", set: code, say: (x) => confirmed.push(x) }), (e) => (refused = e.message) && /changed since that code was shown/.test(e.message));
  assert.equal(doc.pins, undefined, "nothing is pinned");
  assert.notEqual(confirmed.find((x) => x.startsWith("Safety number")), shown.find((x) => x.startsWith("Safety number")), "the new set is shown");
  // Confirming the set now shown pins exactly it.
  const fresh = /confirm with --set ([0-9a-f]{32})/.exec(refused)[1];
  await verifyCommand({ ...opts, yes: true, how: "out-of-band", set: fresh, say: () => {} });
  assert.deepEqual(doc.pins[0].devices.map((d) => d.device), [replacement.device]);
  assert.equal(doc.pins[0].how, "out-of-band");
});

/** This home's own baseline (A1) for local device record `rec` in `doc` (profile "p"). */
function withOwn(doc, rec) {
  writeBaseline(doc, { rec, profile: "p", now: 0 });
  return doc;
}
const recOf = (realm, member, d) => ({ realm, member, device: d.device, key: d.key.toString("base64"), seq: 0, retiredKeys: [] });

/** A relay client over device lists the test changes (realm REALM, the caller ME). */
function listClient(realm, me, lists) {
  return async () => ({ caps: [DEVICE_CAP], member: { id: me }, close() {}, rpc: async (f) => ({ type: "devices", realm, member: f.member ?? me, devices: lists[f.member ?? me] }) });
}
const served = (d, key = d.key) => ({ device: d.device, key: key.toString("base64"), pin: d.register().pin, seq: 0, rotations: [] });

test("a confirmation is refused when a device is added, or the pins are edited, between the display and the confirmation", async (t) => {
  const realm = "c".repeat(32);
  const me = `m_${"m".repeat(26)}`;
  const bob = `m_${"b".repeat(26)}`;
  const mine = await fakeDevice(realm, me);
  const b1 = await fakeDevice(realm, bob);
  const lists = { [me]: [served(mine)], [bob]: [served(b1)] };
  const doc = withOwn({ version: 1, default: "ask", grants: [], blocks: [], revision: 3 }, recOf(realm, me, mine));
  const base = { sub: "verify", member: bob, home: tmpDir(t), profile: "p", connect: await listClient(realm, me, lists), say: () => {} };
  const codeOf = async (contacts) => {
    const out = [];
    await verifyCommand({ ...base, contacts, say: (x) => out.push(x) });
    return /--set ([0-9a-f]{32})/.exec(out.at(-1))?.[1];
  };
  // A device added meanwhile.
  const code = await codeOf(memoryContacts(doc));
  lists[bob] = [served(b1), served(await fakeDevice(realm, bob))];
  await assert.rejects(verifyCommand({ ...base, contacts: memoryContacts(doc), yes: true, how: "in-person", set: code }), /changed since/);
  assert.equal(doc.pins, undefined);
  // The pins edited after the display (another hoptell run): the revision moved.
  const code2 = await codeOf(memoryContacts(doc));
  doc.revision++;
  await assert.rejects(verifyCommand({ ...base, contacts: memoryContacts(doc), yes: true, how: "in-person", set: code2 }), /changed since/);
  // ... or concurrently, between this run's check and its write: refused under the lock.
  const code3 = await codeOf(memoryContacts(doc));
  const racing = memoryContacts(doc, { meanwhile: (d) => d.revision++ });
  await assert.rejects(verifyCommand({ ...base, contacts: racing, yes: true, how: "in-person", set: code3 }), /changed since/);
  assert.equal(doc.pins, undefined);
  // Nothing changed since the display: the code confirms it.
  const code4 = await codeOf(memoryContacts(doc));
  await verifyCommand({ ...base, contacts: memoryContacts(doc), yes: true, how: "in-person", set: code4 });
  assert.equal(doc.pins[0].devices.length, 2);
});

test("accept-device for a replaced key is bound to the key that was shown", async (t) => {
  const realm = "c".repeat(32);
  const me = `m_${"m".repeat(26)}`;
  const bob = `m_${"b".repeat(26)}`;
  const mine = await fakeDevice(realm, me);
  const b1 = await fakeDevice(realm, bob);
  const lists = { [me]: [served(mine)], [bob]: [served(b1)] };
  const doc = withOwn({ version: 1, default: "ask", grants: [], blocks: [] }, recOf(realm, me, mine));
  const base = { member: bob, home: tmpDir(t), profile: "p", connect: await listClient(realm, me, lists), contacts: memoryContacts(doc), say: () => {} };
  await verifyCommand({ ...base, sub: "verify", yes: true, how: "in-person", set: await (async () => {
    const out = [];
    await verifyCommand({ ...base, sub: "verify", say: (x) => out.push(x) });
    return /--set ([0-9a-f]{32})/.exec(out.at(-1))?.[1];
  })() });
  // The same device id is served with another key (no rotation): a key change.
  const other = await fakeDevice(realm, bob, { device: b1.device });
  lists[bob] = [served(other)];
  const out = [];
  await verifyCommand({ ...base, sub: "accept-device", device: b1.device, say: (x) => out.push(x) });
  assert.match(out.join("\n"), /has a new key/);
  assert.equal(doc.pins[0].devices[0].key, b1.key.toString("base64"), "showing it changes nothing");
  const code = /--set ([0-9a-f]{32})/.exec(out.at(-1))?.[1];
  // A third key replaces it before the confirmation: refused, the pin keeps the original key.
  const third = await fakeDevice(realm, bob, { device: b1.device });
  lists[bob] = [served(third)];
  await assert.rejects(verifyCommand({ ...base, sub: "accept-device", device: b1.device, set: code }), /changed since/);
  assert.equal(doc.pins[0].devices[0].key, b1.key.toString("base64"));
  lists[bob] = [served(other)];
  await verifyCommand({ ...base, sub: "accept-device", device: b1.device, set: code });
  assert.equal(doc.pins[0].devices[0].key, other.key.toString("base64"));
});

/** A home's contacts with encryption entries ({member?: name, mode}) for the relay of `w`. */
const withPolicy = (env, w, entries) =>
  fs.writeFileSync(path.join(env.HOPTELL_HOME, "contacts.json"), JSON.stringify({ version: 1, revision: 0, default: "ask", grants: [], blocks: [], encryption: entries.map((e) => ({ realm: w.realm, ...(e.member ? { member: w.members[e.member].id } : {}), mode: e.mode })) }), { mode: 0o600 });
/** An online peer session of `member` with `roles` that records the plaintext it receives. */
async function peer(t, w, member, name, roles = []) {
  const c = new RelayClient({ url: w.url, token: w.members[member].token, name, mode: "peer", roles, reconnect: false });
  c.on("error", () => {});
  const got = [];
  c.on("message", (m, confirm) => (got.push(m), confirm?.({ released: true })));
  c.start();
  await c.ready(5000);
  t.after(() => c.close());
  return got;
}

test("hoptell send applies the encryption policy: never plaintext to a required contact, nor in a fan-out reaching one; unchanged without a policy", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const toBob = await peer(t, w, "bob", "bob", ["reviewer"]);
  const toCarol = await peer(t, w, "carol", "carol", ["reviewer"]);
  const env = envOf(t, w, "alice");
  // No policy: plaintext as before, direct and fan-out.
  assert.equal((await run(env, ["send", "bob", "plain as before"])).code, 0);
  assert.equal((await run(env, ["send", "@reviewer", "plain fan-out"])).code, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual([toBob.length, toCarol.length], [2, 1]);
  const accepted = w.relay.stats().accepted;
  // bob requires encryption: refused with the agent session's answer, nothing sent.
  withPolicy(env, w, [{ member: "bob", mode: "required" }]);
  const r = await run(env, ["send", "bob", "must not leak"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /encryption is required for bob, but the hoptell CLI does not send encrypted messages yet \(use the agent's send_message tool\); nothing was sent \(never as plaintext\)/);
  // A fan-out that would reach bob: refused; carol (off) alone is not reached either.
  const f = await run(env, ["send", "@reviewer", "must not leak"]);
  assert.notEqual(f.code, 0);
  assert.match(f.stderr, /fan-out \(@reviewer\) is plaintext from the hoptell CLI, and your contacts have an encryption policy for this realm; use the agent's send_message tool/);
  const all = await run(env, ["send", "@all", "must not leak"]);
  assert.notEqual(all.code, 0);
  assert.equal(w.relay.stats().accepted, accepted, "nothing was accepted");
  // carol is off: a direct send to her goes as before.
  assert.equal((await run(env, ["send", "carol", "carol is off"])).code, 0);
  // preferred: plaintext, and the output says it was not encrypted.
  withPolicy(env, w, [{ member: "bob", mode: "preferred" }]);
  const p = await run(env, ["send", "bob", "preferred"]);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /\(Not encrypted: the hoptell CLI does not send encrypted messages yet/);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!toBob.some((m) => m.text === "must not leak") && !toCarol.some((m) => m.text === "must not leak"));
  assert.deepEqual([toBob.length, toCarol.length], [3, 2]);
});

test("hoptell send on a relay that cannot tell members (no encrypted messages): a direct send and a fan-out are refused under a required contact", async (t) => {
  const w = await deviceRelay(t); // device keys, no encrypted messages: members cannot be told
  await peer(t, w, "bob", "bob", ["reviewer"]);
  const env = envOf(t, w, "alice");
  withPolicy(env, w, [{ member: "bob", mode: "required" }]);
  const r = await run(env, ["send", "bob", "must not leak"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /does not carry encrypted messages/);
  const f = await run(env, ["send", "@reviewer", "must not leak"]);
  assert.notEqual(f.code, 0);
  assert.match(f.stderr, /is plaintext from the hoptell CLI/);
  assert.equal(w.relay.stats().accepted, 0);
});

test("hoptell send @role under any encryption policy is refused, also when only off sessions are online when it is checked (the relay picks recipients later)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const toCarol = await peer(t, w, "carol", "carol", ["reviewer"]);
  const env = envOf(t, w, "alice");
  // bob requires encryption but is offline; carol (off) is the only reviewer online.
  withPolicy(env, w, [{ member: "bob", mode: "required" }]);
  const f = await run(env, ["send", "@reviewer", "must not reach bob"]);
  assert.notEqual(f.code, 0, f.stdout);
  assert.match(f.stderr, /is plaintext from the hoptell CLI/);
  // preferred only: a broadcast is refused all the same (it cannot be encrypted from the CLI).
  withPolicy(env, w, [{ mode: "preferred" }]);
  assert.notEqual((await run(env, ["send", "@all", "x"])).code, 0);
  // An explicit off policy only: nothing changes.
  withPolicy(env, w, [{ mode: "off" }]);
  assert.equal((await run(env, ["send", "@reviewer", "off policy"])).code, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(toCarol.map((m) => m.text), ["off policy"]);
});
