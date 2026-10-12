// Device signatures (design 3.2 v2.2, amendments-3.5-prep A3), experimental: rotate, revoke and
// migrate check the driver's signing capability (driver.signing) before any local or relay
// mutation. With the real default driver (the OpenMLS binding, which has no SignWithLabel yet) all
// three refuse, change no file and send no frame; with the capability (the fake driver) they
// work, and a migrate interrupted after its retire step recovers.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "../lib/config.js";
import { deviceCommand } from "../lib/mls/cli.js";
import { deviceStore } from "../lib/mls/device.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { deviceRelay, memoryContacts, tmpDir } from "./mls-helpers.js";

const WASM = process.env.HOPTELL_MLS_WASM || path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm", "pkg", "openmls_wasm.js");
const FAKE = new URL("./fake-mls-driver.js", import.meta.url).pathname;
const NOSIGN = new URL("./fixtures/fake-mls-driver-nosign.mjs", import.meta.url).pathname;
const PASS = "correct horse battery staple";
const built = fs.existsSync(WASM);

/** Every file under `dir` with its SHA-256 (relative path -> digest). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** A home on the relay of `w` for member `name`, with `env` choosing the driver; frames are recorded in `sent`. */
function homeOn(t, w, name, env) {
  const home = tmpDir(t);
  const contacts = memoryContacts();
  const sent = [];
  let connects = 0;
  const connect = async () => {
    connects++;
    const c = await w.client(name);
    const rpc = c.rpc.bind(c);
    c.rpc = (f) => (sent.push(f.type), rpc(f));
    return c;
  };
  const h = { home, contacts, sent, env, connects: () => connects };
  h.cmd = (args) => deviceCommand({ args, home, profile: "relay-test", env: { HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS, ...h.env }, connect, contacts, say: () => {} });
  return h;
}

test("A3: the OpenMLS driver reports its signing capability; the fake driver has it (or not, by option)", () => {
  if (built) assert.equal(createOpenMlsDriver(WASM).signing, typeof createRequire(import.meta.url)(WASM).Device.prototype.sign_with_label === "function");
  assert.equal(createFakeDriver().signing, true);
  assert.equal(createFakeDriver({ signing: false }).signing, false);
});

/**
 * In a home enrolled with `env`'s driver: rotate, revoke (another device, then this one) and
 * migrate. Without the signing capability each refuses before anything changes (no file in the
 * home, no contacts change, no frame, not even a connection); with it each works.
 */
async function deviceSigned(t, w, env, { signing, enrollEnv = env }) {
  // A9: enrolling needs a register proof (SignWithLabel); without signing the homes are enrolled
  // with `enrollEnv` (the same fake library, with signing), then used with `env`.
  const a = homeOn(t, w, "alice", enrollEnv);
  await a.cmd(["enroll"]);
  const enrolled = a.contacts.doc.own[w.realm].devices[0].device;
  // Another device of alice, backed up (for migrate) and enrolled at the relay (for revoke).
  const other = homeOn(t, w, "alice", enrollEnv);
  await other.cmd(["enroll"]);
  const otherDevice = other.contacts.doc.own[w.realm].devices[0].device;
  const backup = path.join(tmpDir(t), "old-device.json");
  await other.cmd(["backup", backup]);
  const list = async () => (await (await w.client("alice")).rpc({ type: "device_list" })).devices;
  if (!signing) {
    a.env = env;
    for (const args of [["rotate"], ["revoke", otherDevice], ["revoke", enrolled], ["migrate", backup]]) {
      const before = snapshot(a.home);
      const contacts = structuredClone(a.contacts.doc);
      const frames = a.sent.length;
      const connects = a.connects();
      await assert.rejects(a.cmd(args), (e) => e.code === "unsupported" && /SignWithLabel/.test(e.message) && /hoptell members device-revoke/.test(e.message), args.join(" "));
      assert.deepEqual(snapshot(a.home), before, `${args[0]}: no file changed`);
      assert.deepEqual(a.contacts.doc, contacts, `${args[0]}: the contacts are unchanged`);
      assert.equal(a.sent.length, frames, `${args[0]}: no frame sent`);
      assert.equal(a.connects(), connects, `${args[0]}: not even connected`);
    }
    assert.ok((await list()).every((d) => !d.revoked), "nothing was revoked");
    return;
  }
  await a.cmd(["rotate"]);
  assert.equal((await list()).find((d) => d.device === enrolled).seq, 1, "rotated");
  await a.cmd(["revoke", otherDevice]);
  assert.ok((await list()).find((d) => d.device === otherDevice).revoked?.statement, "a device-signed revocation");
  // migrate on a third home, from a backup of a fourth device.
  const third = homeOn(t, w, "alice", env);
  const fourth = homeOn(t, w, "alice", env);
  await fourth.cmd(["enroll"]);
  const fourthDevice = fourth.contacts.doc.own[w.realm].devices[0].device;
  const b2 = path.join(tmpDir(t), "fourth.json");
  await fourth.cmd(["backup", b2]);
  await third.cmd(["migrate", b2]);
  assert.ok((await list()).find((d) => d.device === fourthDevice).revoked, "migrate revoked the old device");
}

test("A3: with the real default driver, rotate, revoke and migrate follow its signing capability (they work with it; without it they refuse, changing nothing)", { skip: built ? false : `the OpenMLS WASM binding is not built (${WASM})` }, async (t) => {
  const w = await deviceRelay(t);
  const signing = createOpenMlsDriver(WASM).signing;
  t.diagnostic(`the OpenMLS binding ${signing ? "signs" : "does not sign"} with labels`);
  await deviceSigned(t, w, { HOPTELL_MLS_WASM: WASM }, { signing });
});

test("A3: a binding without SignWithLabel: rotate, revoke and migrate refuse before any change (no file, no frame, no connection)", async (t) => {
  const w = await deviceRelay(t);
  await deviceSigned(t, w, { HOPTELL_MLS_DRIVER: NOSIGN }, { signing: false, enrollEnv: { HOPTELL_MLS_DRIVER: FAKE } });
  // A9: such a binding cannot enroll either (the relay needs a proof): refused before any change.
  const n = homeOn(t, w, "bob", { HOPTELL_MLS_DRIVER: NOSIGN });
  await assert.rejects(n.cmd(["enroll"]), (e) => e.code === "unsupported" && /proof/.test(e.message));
  assert.deepEqual(snapshot(n.home), {}, "no file written");
  assert.deepEqual(n.sent, [], "no frame sent");
  // The store refuses on its own too (any caller).
  const store = deviceStore({ home: tmpDir(t), profile: "relay-test", driver: createFakeDriver({ signing: false }), store: "file", passphrase: PASS, keychainBackend: null });
  await assert.rejects(store.rotate(await w.client("alice")), (e) => e.code === "unsupported");
  await assert.rejects(store.revoke(await w.client("alice"), "a".repeat(26)), (e) => e.code === "unsupported");
});

test("A3: with the capability (fake driver) rotate, revoke and migrate work", async (t) => {
  const w = await deviceRelay(t);
  await deviceSigned(t, w, { HOPTELL_MLS_DRIVER: FAKE }, { signing: true });
});

test("A3: a migrate interrupted after its retire step recovers", async (t) => {
  const w = await deviceRelay(t);
  const env = { HOPTELL_MLS_DRIVER: FAKE };
  // The old device, backed up.
  const old = homeOn(t, w, "alice", env);
  await old.cmd(["enroll"]);
  await old.cmd(["rotate"]);
  const oldDevice = old.contacts.doc.own[w.realm].devices[0].device;
  const backup = path.join(tmpDir(t), "old-device.json");
  await old.cmd(["backup", backup]);
  // The new machine: the migrate's enroll fails once (after the restore retired the old device).
  const fresh = homeOn(t, w, "alice", env);
  let fail = true;
  const cmd = (args) =>
    deviceCommand({
      args, home: fresh.home, profile: "relay-test", env: { HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS, ...env }, contacts: fresh.contacts, say: () => {},
      connect: async () => {
        if (fail) {
          fail = false;
          throw new Error("crash after the retire step");
        }
        return w.client("alice");
      },
    });
  await assert.rejects(cmd(["migrate", backup]), /crash after the retire step/);
  assert.ok(fs.readdirSync(path.join(fresh.home, "mls", "relay-test")).includes(`retired-${oldDevice}.json`), "the old device is retired here first");
  await cmd(["migrate", backup]);
  const list = (await (await w.client("alice")).rpc({ type: "device_list" })).devices;
  assert.ok(list.find((d) => d.device === oldDevice).revoked, "the old device is revoked at the relay");
  const now = fresh.contacts.doc.own[w.realm].devices[0].device;
  assert.notEqual(now, oldDevice);
  assert.ok(list.find((d) => d.device === now).key, "the new one is enrolled");
});
