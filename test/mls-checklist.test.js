// Review checklist rows 7, 8 and 11 and amendment A7 (3.5 preparation), experimental:
//   row 11 / A7  a standalone proposal, as an application message and as a commit-log entry: refused,
//                nothing of it saved (the library state as before), and the conversation goes on;
//   row 8        a crash between a received commit's merge and its save: the commit is applied
//                once after the restart and the next message decrypts;
//   row 7        a relay that swaps the ratchet tree sent beside a Welcome (another group's tree, a
//                leaf key replaced, a truncated tree): refused, the KeyPackage kept, no group joined.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "../lib/config.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { deviceRelay, e2eeDevice, memoryContacts, newOp, until } from "./mls-helpers.js";
import { createFakeDriver } from "./fake-mls-driver.js";

const BAKEOFF = path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm");
const WASM = process.env.HOPTELL_MLS_WASM || path.join(BAKEOFF, "pkg", "openmls_wasm.js");
// The binding's test build (feature test-proposals): the same source, plus propose_for_test.
const TRACE = path.join(BAKEOFF, "pkg-trace", "openmls_wasm.js");
const noWasm = fs.existsSync(WASM) ? false : `the OpenMLS WASM binding is not built (${WASM})`;
const noTrace = fs.existsSync(TRACE) ? false : `the OpenMLS binding's test build is not built (${TRACE})`;
const MAGIC = Buffer.from("hoptell-openmls-state-v2\n");
const noop = () => {};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => Buffer.from(b).toString("base64");

/** A world of alice (sending, attached) and bob (frames handed in by the test), on `driver()`. */
async function world(t, driver = () => undefined) {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await e2eeDevice(t, w, "alice", { ...(driver() ? { driver: driver() } : {}) });
  const bob = await e2eeDevice(t, w, "bob", { sessions: [], ...(driver() ? { driver: driver() } : {}) });
  const recv = bob.engine(await bob.proven(), "bob");
  const fed = new Set();
  /** Hand bob's queued frames (not yet handed in) to his engine; returns [kind, outcome] each. */
  const feed = async () => {
    const out = [];
    for (const f of w.ds.pending({ member: bob.id, device: bob.device, limit: 200 })) {
      if (fed.has(f.delivery)) continue;
      fed.add(f.delivery);
      out.push([f.kind, await recv.e2ee.receive(f, noop)]);
    }
    return out;
  };
  return { w, alice, bob, recv, feed };
}
const deviceFile = (d) => path.join(d.dir, "mls", "relay-test", "device.json");
const libState = (d) => d.store.transact(async (ctx) => Buffer.from(await ctx.dev.exportState()), { act: false });

/**
 * Row 11 / A7 on `driver()`: alice crafts a standalone proposal with `propose(gid)` (as a member
 * device would send one). As an application message and as a commit-log entry it is refused, the
 * receiver saves nothing of it, and the conversation goes on (a valid message and commit; after
 * the commit-log entry, which the relay counted as an epoch, a replacement group).
 */
async function proposals(t, driver, propose) {
  const { w, alice, bob, recv, feed } = await world(t, driver);
  const to = { member: bob.id, session: "bob" };
  assert.equal((await alice.s.alice.e2ee.send({ to, body: "one" })).state, "accepted");
  await feed();
  assert.deepEqual(recv.got.map((m) => m.text), ["one"]);
  const gid = (await alice.s.alice.e2ee.checkpoint(bob.id)).group;
  const appTemplate = w.ds.pending({ member: bob.id, device: bob.device, limit: 200 }).find((f) => f.kind === "app");

  // As an application message.
  const before = { file: fs.readFileSync(deviceFile(bob)), lib: await libState(bob) };
  const proposal = await propose(alice, gid, bob);
  const frame = { ...appTemplate, delivery: `e_${crypto.randomBytes(16).toString("hex")}`, mls: b64(proposal) };
  assert.equal(await recv.e2ee.receive(frame, noop), "refused");
  assert.ok(fs.readFileSync(deviceFile(bob)).equals(before.file), "nothing saved");
  assert.ok((await libState(bob)).equals(before.lib), "the exported state is byte-identical");
  // The conversation goes on: a valid message and a valid commit from the same sender.
  await alice.s.alice.e2ee.send({ to, body: "two" });
  assert.equal((await alice.s.alice.e2ee.update(bob.id)).phase, "merged");
  await alice.s.alice.e2ee.send({ to, body: "three" });
  assert.deepEqual((await feed()).map(([, o]) => o), ["delivered", "delivered", "delivered"]);
  assert.deepEqual(recv.got.map((m) => m.text), ["one", "two", "three"]);
  assert.equal((await recv.e2ee.checkpoint(alice.id)).authenticator, (await alice.s.alice.e2ee.checkpoint(bob.id)).authenticator);

  // As a commit-log entry (the relay cannot tell; it accepts it as the next epoch).
  const epoch = (await alice.s.alice.e2ee.checkpoint(bob.id)).epoch;
  const logged = await propose(alice, gid, bob);
  await alice.s.alice.client.rpc({ type: "send_e2ee", kind: "commit", op: newOp(), device: alice.device, group: gid, expected_epoch: epoch, mls: b64(logged), roster_delta: { add: [], remove: [] } });
  const stateBefore = JSON.parse(fs.readFileSync(deviceFile(bob), "utf8")).state;
  const libBefore = await libState(bob);
  assert.deepEqual((await feed()).map(([k, o]) => [k, o]), [["commit", "refused"]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(deviceFile(bob), "utf8")).state, stateBefore, "the library state is not saved for it");
  assert.ok((await libState(bob)).equals(libBefore), "the exported state is byte-identical");
  const st = (await recv.e2ee.status()).groups[gid];
  assert.equal(st.state, "broken", "hoptell's own record: the relay's log cannot be followed");
  assert.match(st.invalid.why, /does not validate|not a commit/);
  // The next valid message from that sender is read (in the replacement group).
  assert.equal((await alice.s.alice.e2ee.send({ to, body: "after the proposal" })).state, "accepted");
  await until(async () => (await feed(), recv.got.some((m) => m.text === "after the proposal")), "the next message", 6000);
  // Exactly one replacement (generation 2), and traffic continues there both ways, with no other.
  const groups = () => w.db.all("SELECT group_id, generation FROM e2ee_groups ORDER BY generation");
  assert.deepEqual(groups().map((g) => g.generation), [1, 2], "one replacement group");
  const replacement = groups()[1].group_id;
  assert.equal((await alice.s.alice.e2ee.checkpoint(bob.id)).group, replacement);
  assert.equal((await recv.e2ee.checkpoint(alice.id)).group, replacement);
  assert.equal((await alice.s.alice.e2ee.send({ to, body: "and on" })).state, "accepted");
  await until(async () => (await feed(), recv.got.some((m) => m.text === "and on")), "traffic in the replacement", 6000);
  assert.equal((await recv.e2ee.send({ to: { member: alice.id, session: "alice" }, body: "back" })).state, "accepted");
  await until(() => alice.s.alice.got.some((m) => m.text === "back"), "and back");
  assert.equal(groups().length, 2, "no further replacement");
  assert.equal(recv.got.filter((m) => m.text === "after the proposal").length, 1, "delivered once");
}

test("row 11 / A7 (fake driver, as the binding behaved before A7): a standalone proposal is refused on both paths and nothing of it is saved", async (t) => {
  await proposals(t, () => undefined, (alice, gid) => alice.store.transact(async (ctx) => ctx.dev.group(Buffer.from(gid, "hex")).proposeForTest("remove", 1)));
});

test("row 11 / A7 (OpenMLS, the binding's test build): a Remove proposal is refused on both paths, the state byte-identical, the conversation goes on", { skip: noTrace }, async (t) => {
  const wasm = createRequire(import.meta.url)(TRACE);
  await proposals(t, () => createOpenMlsDriver(TRACE), async (alice, gid, bob) => {
    // alice's device as a raw binding device (a copy of its state): it signs the proposal as
    // alice's member device would; its own state is not kept.
    const state = Buffer.from(await libState(alice));
    const body = state.subarray(0, MAGIC.length).equals(MAGIC) ? state.subarray(MAGIC.length + 4 + state.readUInt32BE(MAGIC.length)) : state;
    const raw = wasm.Device.import_state(body);
    try {
      const g = Buffer.from(gid, "hex");
      const bobLeaf = raw.members(g).find((m) => Buffer.from(m.identity).toString().includes(bob.id)).index;
      return Buffer.from(raw.propose_for_test(g, "remove", bobLeaf));
    } finally {
      raw.free();
    }
  });
});

const CRASH = new URL("./fixtures/e2ee-crash.mjs", import.meta.url).pathname;
/** Run the crash fixture as a session of `member`; resolves once it died by SIGKILL. */
const crashChild = (w, member, args) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [CRASH, w.url, ...args], { timeout: 20_000, env: { ...process.env, HOPTELL_TEST_TOKEN: w.members[member].token } }, (err, stdout, stderr) => (err?.signal === "SIGKILL" ? resolve() : reject(new Error(`the fixture did not die: ${stdout}${stderr}${err?.message ?? ""}`))));
  });

test("row 8: SIGKILL between a received commit's merge and its save: after the restart the commit is applied once and the next message decrypts", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await e2eeDevice(t, w, "alice");
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hoptell-row8-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // bob's contacts are shared with the crash fixture through his home.
  const bob = await e2eeDevice(t, w, "bob", { sessions: [], dir, contacts: memoryContacts(undefined, { file: path.join(dir, "contacts-test.json") }), driver: createFakeDriver({ seed: `bob-${dir}`, now: w.clock.now }) });
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "before" });
  const warm = await bob.open("bob");
  await until(() => warm.got.length === 1, "joined");
  warm.client.close();
  await settle();
  const child = crashChild(w, "bob", [bob.dir, "bob", "commit-receive-after-merge", "receive"]);
  await settle(1500); // the child attached
  assert.equal((await alice.s.alice.e2ee.update(bob.id)).phase, "merged");
  await child;
  const epoch = (await alice.s.alice.e2ee.checkpoint(bob.id)).epoch;
  // The restart: the relay delivers the commit again; it is processed once.
  const again = await bob.open("bob");
  await until(async () => (await again.e2ee.checkpoint(alice.id))?.epoch === epoch, "the commit applied after the restart");
  const [ca, cb] = [await alice.s.alice.e2ee.checkpoint(bob.id), await again.e2ee.checkpoint(alice.id)];
  assert.equal(cb.authenticator, ca.authenticator, "one history");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "after the restart" });
  await until(() => again.got.some((m) => m.text === "after the restart"), "the next message decrypts");
  await until(() => w.ds.usage({ member: bob.id, device: bob.device }).messages === 0, "everything acknowledged");
});

/** The ratchet tree's first leaf's encryption key, located in its TLS encoding: [offset, length]. */
function firstLeafKey(tree) {
  const varint = (b, o) => {
    const p = b[o] >> 6;
    if (p === 0) return [b[o] & 0x3f, 1];
    if (p === 1) return [((b[o] & 0x3f) << 8) | b[o + 1], 2];
    return [((b[o] & 0x3f) << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3], 4];
  };
  let o = varint(tree, 0)[1];
  assert.equal(tree[o], 1, "the first node is present");
  assert.equal(tree[o + 1], 1, "and a leaf");
  o += 2;
  const [n, l] = varint(tree, o);
  return [o + l, n];
}

test("row 7 (OpenMLS): a Welcome with a swapped ratchet tree (another group's, a leaf key replaced, truncated) is refused, the KeyPackage kept, no group joined", { skip: noWasm }, async (t) => {
  const wasm = createRequire(import.meta.url)(WASM);
  const { w, alice, bob, recv } = await world(t, () => createOpenMlsDriver(WASM));
  assert.equal((await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "hello" })).state, "accepted");
  const welcome = w.ds.pending({ member: bob.id, device: bob.device, limit: 200 }).find((f) => f.kind === "welcome");
  const tree = Buffer.from(welcome.ratchet_tree, "base64");
  // (a) The tree of another group of the same members: alice's key, another of bob's KeyPackages.
  const taken = await alice.s.alice.client.rpc({ type: "kp_take", request: "row7-other-group", device: alice.device, target: { member: bob.id, device: bob.device } });
  const state = Buffer.from(await libState(alice));
  const raw = wasm.Device.import_state(state.subarray(MAGIC.length + 4 + state.readUInt32BE(MAGIC.length)));
  const other = Buffer.from("row7-other-group");
  raw.create_group(other);
  const otherTree = Buffer.from(raw.commit(other, [new wasm.Bytes(Buffer.from(taken.kp, "base64"))], new Uint32Array(), false).ratchet_tree);
  raw.free();
  // (b) One leaf's key replaced (a byte of the first leaf's encryption key changed).
  const [at, len] = firstLeafKey(tree);
  assert.ok(len >= 32);
  const replaced = Buffer.from(tree);
  replaced[at + Math.floor(len / 2)] ^= 0x5a;
  // (c) Truncated.
  const truncated = tree.subarray(0, Math.floor(tree.length / 2));
  const ref = welcome.kp_ref;
  for (const [what, swapped] of [["another group's tree", otherTree], ["a leaf key replaced", replaced], ["a truncated tree", truncated]]) {
    assert.equal(await recv.e2ee.receive({ ...welcome, delivery: `e_${crypto.randomBytes(16).toString("hex")}`, ratchet_tree: b64(swapped) }, noop), "refused", what);
    assert.deepEqual(Object.keys((await recv.e2ee.status()).groups), [], `${what}: no group joined`);
    assert.equal(bob.store.record().kps[ref].state, "open", `${what}: the KeyPackage is kept`);
  }
  // The genuine Welcome still joins under the same KeyPackage, and the message is read.
  assert.equal(await recv.e2ee.receive(welcome, noop), "delivered");
  assert.equal(bob.store.record().kps[ref].state, "used");
  const app = w.ds.pending({ member: bob.id, device: bob.device, limit: 200 }).find((f) => f.kind === "app");
  assert.equal(await recv.e2ee.receive(app, noop), "delivered");
  assert.equal(recv.got[0].text, "hello");
});
