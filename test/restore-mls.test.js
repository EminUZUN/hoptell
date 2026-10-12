// A restore under real OpenMLS clients (designs 4.4 and 3.3): the backup is taken while alice and
// bob are at one epoch; alice moves on alone; the relay is restored, its log rolled back and the
// conversation marked replace_required. Without any explicit replacement, a normal send recovers:
// the client learns of the requirement from the relay's answers, replaces the group, and the
// message reaches bob in the new generation, readable. Skipped without the OpenMLS WASM binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/config.js";
import { createAccess } from "../lib/access.js";
import { backupRelay } from "../lib/backup.js";
import { RelayClient } from "../lib/client.js";
import { loadMembersFile } from "../lib/members.js";
import { deviceStore } from "../lib/mls/device.js";
import { createE2ee } from "../lib/mls/e2ee.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { createDeviceDirectory } from "../lib/mls/relaydir.js";
import { createDeliveryService } from "../lib/mls/relayds.js";
import { loadRealm, lockStateDir } from "../lib/realm.js";
import { startRelay } from "../lib/relay.js";
import { openRelayStore } from "../lib/relaystore.js";
import { runRestore } from "../lib/restore.js";
import { ID, membersFile, tmp } from "./restore-helpers.js";
import { memoryContacts, ownFor } from "./mls-helpers.js";

const WASM = process.env.HOPTELL_MLS_WASM || path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm", "pkg", "openmls_wasm.js");
const skip = fs.existsSync(WASM) ? false : `the OpenMLS WASM binding is not built (${WASM})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(25);
  }
}

/** A relay on a store in a temporary state directory, and OpenMLS member clients that reconnect. */
async function mlsWorld(t) {
  const root = tmp(t, "hoptell-restore-mls-");
  const state = path.join(root, "s");
  const members = membersFile(root);
  const backup = path.join(root, "backup");
  let realm, release, db, relay;
  const clients = [];
  const start = async () => {
    release = lockStateDir(state);
    realm = loadRealm(state);
    db = openRelayStore({ dir: state, fullfsync: false });
    const directory = createDeviceDirectory({ db, realm });
    relay = await startRelay({ host: "127.0.0.1", port: 0, members: loadMembersFile(members), realm: { id: realm }, access: createAccess({ stateDir: state }), devices: { directory, ds: createDeliveryService({ db, directory, realm }) }, log: () => {} });
  };
  const stop = async () => {
    for (const c of clients.splice(0)) c.close();
    if (relay) await relay.close();
    db?.close();
    release?.();
    [relay, db, release] = [null, null, null];
  };
  t.after(stop);
  await start();
  // membersFile() stores sha256(name) as each member's token: the name is the token.
  const client = async (name, session) => {
    const c = new RelayClient({ url: `ws://127.0.0.1:${relay.port}`, token: name, name: session, mode: "peer", reconnect: false });
    c.on("error", () => {});
    clients.push(c);
    await c.start().ready(5000);
    return c;
  };
  const devices = {};
  const open = async (name, extra = {}) => {
    let d = devices[name];
    if (!d) {
      const home = path.join(root, name);
      const driver = createOpenMlsDriver(WASM, { testOnlySuite: 77 });
      const contacts = memoryContacts();
      const store = deviceStore({ home, profile: "relay-test", driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", own: ownFor(contacts, home, "relay-test") });
      const c = await client(name, `${name}-enroll`);
      await store.enroll(c);
      c.close();
      // An encrypted send implies a policy for the realm (contacts keep the own baseline, A1).
      contacts.doc.encryption = [{ realm: store.record().realm, mode: "preferred" }];
      d = devices[name] = { home, driver, store, contacts, id: ID[name] };
    }
    const c = await client(name, name);
    const got = [];
    const e = createE2ee({ store: d.store, driver: d.driver, client: c, session: name, home: d.home, profile: "relay-test", contacts: d.contacts, deliver: async (m) => void got.push(m), ...extra });
    await e.attach();
    return { ...d, c, e, got };
  };
  return { start, stop, open, state, members, backup, get db() {
    return db;
  }, get realm() {
    return realm;
  } };
}

test("restore with OpenMLS clients at diverged epochs: a normal send replaces the restored group and the message is read", { skip }, async (t) => {
  const w = await mlsWorld(t);
  const { open, state, members, backup } = w;
  let a = await open("alice");
  let b = await open("bob");
  await a.e.send({ to: { member: b.id, session: "bob" }, body: "before the backup" });
  await until(() => b.got.length === 1, "the first message");
  await backupRelay({ db: w.db, stateDir: state, dest: backup, realm: w.realm, config: { members } });
  // bob is away; alice moves the group on alone (epoch 2), past the backup.
  b.c.close();
  await sleep(50);
  await a.e.update(b.id);
  assert.equal((await a.e.checkpoint(b.id)).epoch, 2);
  await w.stop();
  const restored = await runRestore({ stateDir: state, mode: "start", backupDir: backup, membersFile: members });
  assert.equal(restored.counts.conversations_replace_required, 1);
  await w.start();
  a = await open("alice");
  b = await open("bob");
  assert.deepEqual([(await a.e.checkpoint(b.id)).epoch, (await b.e.checkpoint(a.id)).epoch], [2, 1], "diverged: the relay's log is back at bob's epoch");
  await a.store.replenish(a.c, { force: 1 });
  await b.store.replenish(b.c, { force: 1 });
  // A normal send, nothing else: the client sees the requirement and replaces the group first.
  const sent = await a.e.send({ to: { member: b.id, session: "bob" }, body: "after the restore" });
  assert.notEqual(sent.state, "failed");
  await a.e.recover();
  await b.e.recover();
  await until(() => b.got.some((m) => m.text === "after the restore"), "the message sent after the restore, read by bob");
  const groups = w.db.all("SELECT generation, state, replace_required FROM e2ee_groups ORDER BY generation").map((r) => ({ ...r }));
  assert.deepEqual(groups, [{ generation: 1, state: "replaced", replace_required: 1 }, { generation: 2, state: "active", replace_required: 0 }]);
  // Both are in the new generation and keep talking.
  await b.e.send({ to: { member: a.id, session: "alice" }, body: "and back" });
  await until(() => a.got.some((m) => m.text === "and back"), "bob's answer in the new group");
});

test("a group marked between reading the conversation and publishing: the refusal is not a failure; the group is replaced and the message read", { skip }, async (t) => {
  const w = await mlsWorld(t);
  let armed = false;
  const a = await w.open("alice", {
    fault: (p) => {
      // A restore's mark arriving after the client read the conversation (only the relay sets it).
      if (armed && p === "send-after-persist") {
        armed = false;
        w.db.tx((h) => h.run("UPDATE e2ee_groups SET replace_required = 1 WHERE state = 'active'"));
      }
    },
  });
  const b = await w.open("bob");
  await a.e.send({ to: { member: b.id, session: "bob" }, body: "first" });
  await until(() => b.got.length === 1, "the first message");
  armed = true;
  const sent = await a.e.send({ to: { member: b.id, session: "bob" }, body: "second" });
  assert.equal(armed, false, "the mark was set at publication");
  assert.notEqual(sent.state, "failed");
  await a.e.recover();
  await b.e.recover();
  await until(() => b.got.some((m) => m.text === "second"), "the message, sealed again in the replacement group");
  assert.deepEqual(w.db.all("SELECT generation, state FROM e2ee_groups ORDER BY generation").map((r) => [r.generation, r.state]), [[1, "replaced"], [2, "active"]]);
});
