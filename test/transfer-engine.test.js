// Larger transfers through agent sessions (design 6, experimental): the engine offers
// send_transfer only with the experimental flag and approved folders; a file goes encrypted to the
// peer's session, which shows a fixed notice (never the key or a path) and stages it for its owner;
// a review set larger than one frame to a "required" contact goes as a transfer and arrives as a
// checked review set; a contact without the transfers opt-in is not fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { profileKey } from "../lib/profiles.js";
import { storeFor } from "../lib/mls/cli.js";
import { openContacts } from "../lib/quarantine.js";
import { createStaging } from "../lib/transferin.js";
import { deviceRelay, tmpDir } from "./mls-helpers.js";

const PASS = "correct horse battery staple";
const FAKE = fileURLToPath(new URL("./fake-mls-driver.js", import.meta.url));
const textOf = (r) => r.content.map((c) => c.text).join("");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const until = async (fn, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
};

async function homeOf(t, w, member, { contacts, flag = true, roots = null } = {}) {
  const dir = tmpDir(t);
  const env = { HOPTELL_RELAY: w.url, HOPTELL_TOKEN: w.members[member].token, HOPTELL_NAME: member, HOPTELL_HOME: dir, HOPTELL_PUSH: "listener", HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS, HOPTELL_MLS_DRIVER: FAKE, HOPTELL_MACHINE_ID: "m", ...(flag ? { HOPTELL_EXPERIMENTAL_E2EE: "1" } : {}), ...(roots ? { HOPTELL_SNAPSHOT_ROOTS: JSON.stringify(roots) } : {}) };
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(w)), { mode: 0o600 });
  // Enrollment writes the own baseline into the home's contacts (A1).
  const store = await storeFor({ home: dir, profile: profileKey(w.url, null), env, contacts: await openContacts(dir, { notify: false }) });
  await store.enroll(await w.client(member));
  const engine = createEngine(readSettings({ env, homedir: os.tmpdir(), pid: process.pid, hostname: "testhost" }), { findHost: () => null, keepAlive: true });
  t.after(() => engine.stop());
  await engine.start();
  await until(() => engine.session.state === "bound");
  return { dir, engine, env };
}
/**
 * read_inbox as an agent calls it: each read acknowledges the previous batch by its receipt (an
 * unacknowledged batch is shown again before later messages).
 */
function reader(engine) {
  let receipt = null;
  return async () => {
    const out = textOf(await engine.call("read_inbox", receipt ? { ack: receipt } : {}));
    receipt = /Receipt: (\S+)\n/.exec(out)?.[1] ?? null;
    return out;
  };
}
const doc = (w, grantee, extra = {}) => ({ version: 1, revision: 0, default: "ask", grants: [{ realm: w.realm, member: w.members[grantee].id }], blocks: [], encryption: [{ realm: w.realm, mode: "preferred" }], ...extra });

test("an agent session sends a file with send_transfer; the peer's session shows a fixed notice and stages it for its owner", async (t) => {
  const w = await deviceRelay(t, { e2ee: true, transfers: true });
  const bob = await homeOf(t, w, "bob", { contacts: (x) => doc(x, "alice", { transfers: { contacts: [{ realm: x.realm, member: x.members.alice.id, allowed: true }] } }) });
  const root = tmpDir(t);
  const bytes = crypto.randomBytes(600_000);
  fs.writeFileSync(path.join(root, "archive.tar"), bytes);
  const alice = await homeOf(t, w, "alice", { contacts: (x) => doc(x, "bob"), roots: [{ id: "app", path: root }] });
  await new Promise((r) => setTimeout(r, 300)); // both attached their devices
  const tools = await alice.engine.listTools?.();
  if (tools) assert.ok(tools.some((x) => x.name === "send_transfer"));
  const r = await alice.engine.call("send_transfer", { to: "bob", root_id: "app", path: "archive.tar" });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /"state": "accepted"/);
  let got = "";
  const read = reader(bob.engine);
  assert.ok(await until(async () => /a file transfer from alice; 600000 bytes; label "archive\.tar"/.test((got += await read()))), got);
  assert.equal(got.includes(root), false, "no path of the sender");
  const staging = createStaging({ home: bob.dir });
  const [e] = await until(() => (staging.list()[0]?.state === "staged" ? staging.list() : null));
  assert.equal(sha(fs.readFileSync(staging.dataFile(e.t))), sha(bytes));
  assert.equal(w.relay.stats().queueItems, 0, "nothing went through the plaintext queue");
});

test("a contact without the transfers opt-in is not fetched; send_transfer is not offered without the experimental flag", async (t) => {
  const w = await deviceRelay(t, { e2ee: true, transfers: true });
  const bob = await homeOf(t, w, "bob", { contacts: (x) => doc(x, "alice") });
  const root = tmpDir(t);
  fs.writeFileSync(path.join(root, "x.bin"), crypto.randomBytes(1000));
  const alice = await homeOf(t, w, "alice", { contacts: (x) => doc(x, "bob"), roots: [{ id: "app", path: root }] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await alice.engine.call("send_transfer", { to: "bob", root_id: "app", path: "x.bin" })).isError, false);
  let got = "";
  const read = reader(bob.engine);
  assert.ok(await until(async () => /not fetched: your user has not allowed file transfers from this contact/.test((got += await read()))), got);
  assert.deepEqual(createStaging({ home: bob.dir }).list(), []);
  const off = await homeOf(t, w, "carol", { contacts: (x) => doc(x, "bob"), flag: false, roots: [{ id: "app", path: root }] });
  const r = await off.engine.call("send_transfer", { to: "bob", root_id: "app", path: "x.bin" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /unknown tool send_transfer/);
});

test("a review set larger than one frame to a contact whose encryption is required goes as a transfer and arrives as a checked review set", async (t) => {
  const w = await deviceRelay(t, { e2ee: true, transfers: true });
  const bob = await homeOf(t, w, "bob", { contacts: (x) => doc(x, "alice") });
  const root = tmpDir(t);
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), `line ${i}\n`.repeat(40_000));
  const alice = await homeOf(t, w, "alice", { contacts: (x) => ({ ...doc(x, "bob"), encryption: [{ realm: x.realm, member: x.members.bob.id, mode: "required" }] }), roots: [{ id: "app", path: root }] });
  await new Promise((r) => setTimeout(r, 300));
  const r = await alice.engine.call("send_review_set", { to: "bob", files: [0, 1, 2].map((i) => ({ root: "app", path: `f${i}.txt` })), request: "please review" });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /"transport": "transfer"/);
  let got = "";
  const read = reader(bob.engine);
  assert.ok(await until(async () => /hoptell_review_set/.test((got += await read()))), got.slice(-500));
  assert.match(got, /Review set check \(by hoptell on this machine\): every file's content matches its sha256/);
  assert.equal(w.relay.stats().queueItems, 0, "no plaintext");
});
