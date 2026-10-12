// Encrypted fan-out to roles and teams (design 4.3, experimental), with the fake driver and a real
// relay: audience selection (roles select, pins decide), the frozen set, copies as 3.3 logical
// messages and their derived states, the fan-out record written with its copies, write boundaries
// and recovery, op ids, the limits (copies, reservations, fan-outs in progress), the retained send
// state of a device and its reseal reservations, and terminal states that are never sealed again.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../lib/config.js";
import { RelayClient } from "../lib/client.js";
import { createAccess } from "../lib/access.js";
import { deviceStore } from "../lib/mls/device.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { createE2ee } from "../lib/mls/e2ee.js";
import { encodeContent, newContent, SKEW_MS } from "../lib/mls/content.js";
import { b64, credentialIdentity, newDeviceId } from "../lib/mls/identity.js";
import { decide, evaluate, pinFirstUse } from "../lib/mls/trust.js";
import { ENVELOPE_E, FRAME_J, LIMITS, actualBytes, frameBound, retained } from "../lib/mls/fanout.js";
import { MAX_FRAME_BYTES } from "../lib/mls/relayds.js";
import { describeFanout } from "../lib/mls/session.js";
import { DAY } from "../lib/mls/policy.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { acceptOwnDevices, deviceRelay, memoryContacts, ownFor, tmpDir } from "./mls-helpers.js";

const PASS = "correct horse battery staple";
const OP_RE = /^o_[a-z2-7]{26}$/;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const WASM = process.env.HOPTELL_MLS_WASM || path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm", "pkg", "openmls_wasm.js");
const noWasm = fs.existsSync(WASM) ? false : `the OpenMLS WASM binding is not built (${WASM})`;

/** Wait until `fn()` holds (polling). */
async function until(fn, what = "condition", ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(30);
  }
}

/**
 * A device of `member` (a home with its store, enrolled), and sessions on it: open(session,
 * {roles}) connects that session with its roles and an e2ee engine recording deliveries.
 */
async function device(t, w, member, { sessions = [], contacts = memoryContacts(), limits, driver } = {}) {
  const dir = tmpDir(t);
  driver ??= createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now });
  const store = deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, "relay-test") });
  await store.enroll(await w.client(member));
  const d = { dir, store, driver, member, id: w.members[member].id, device: store.record().device, contacts, s: {} };
  d.engine = (client, session, opts = {}) => {
    const got = [];
    const e2ee = createE2ee({ store, driver, client, session, home: dir, profile: "relay-test", contacts, deliver: async (m) => void got.push(m), now: w.clock.now, limits: opts.limits ?? limits, fault: opts.fault ?? null });
    return { client, e2ee, got };
  };
  d.open = async (session, { roles = [], fault = null, limits: l } = {}) => {
    const client = await connect(w, member, session, roles);
    const s = d.engine(client, session, { fault, limits: l });
    await s.e2ee.attach();
    d.s[session] = s;
    return s;
  };
  for (const s of sessions) await d.open(typeof s === "string" ? s : s.name, typeof s === "string" ? {} : s);
  return d;
}
/** A peer connection of `member` with session name `name` and its roles. */
async function connect(w, member, name, roles = []) {
  const rc = new RelayClient({ url: w.url, token: w.members[member].token, name, mode: "peer", roles, reconnect: false });
  rc.on("error", () => {});
  rc.start();
  await rc.ready(5000);
  return rc;
}
/** Pin `member`'s current devices in `contacts` (relay-tofu, as a first direct send would). */
async function pin(w, client, contacts, member) {
  const devices = (await client.rpc({ type: "device_list", member })).devices;
  pinFirstUse(contacts.doc, w.realm, member, evaluate(contacts.doc, w.realm, member, devices).active);
  contacts.doc.revision++;
}
/** The device's rec.e2ee, as saved. */
const stateOf = (d) => d.store.transact(async (ctx) => structuredClone(ctx.rec.e2ee ?? {}), { act: false });
/** The retained-send-state bound holds for what is saved: actual bytes never exceed the counted ones. */
async function bounded(d, limits = LIMITS) {
  const s = await stateOf(d);
  const r = retained(s);
  assert.ok(actualBytes(s) <= r.bytes, `actual ${actualBytes(s)} <= counted ${r.bytes}`);
  assert.ok(r.bytes <= limits.retainedBytes && r.count <= limits.retainedEntries, `within the bound (${r.count} entries, ${r.bytes} bytes)`);
  return r;
}
const fanoutsOf = async (d) => Object.values((await stateOf(d)).fanout ?? {});
/** Capture the frames `client` sends that match `pred` (the relay still gets them). */
function capture(client, pred) {
  const seen = [];
  const rpc = client.rpc.bind(client);
  client.rpc = (f) => {
    if (pred(f)) seen.push(structuredClone(f));
    return rpc(f);
  };
  return seen;
}
/** Make `client` lose the answer of the next frame matching `pred` (the relay executes it). */
function loseAnswer(client, pred, { send = true } = {}) {
  const rpc = client.rpc.bind(client);
  let armed = true;
  client.rpc = async (f) => {
    if (armed && pred(f)) {
      armed = false;
      if (send) await rpc(f);
      throw Object.assign(new Error("relay did not answer in time"), { kind: "no_answer" });
    }
    return rpc(f);
  };
}
const isApp = (f) => f.type === "send_e2ee" && f.kind === "app";
/**
 * An explicit replace() after heavy traffic: the relay may refuse it for its per-connection rate
 * limit before anything changes (an explicit operation is not retried for its caller); the test
 * waits the window out, so what it checks never depends on timing.
 */
async function replaced(e2ee, peer) {
  for (let i = 0; ; i++) {
    try {
      return await e2ee.replace(peer);
    } catch (e) {
      if (e.code !== "rate_limited" || i >= 15) throw e;
      await settle(1000);
    }
  }
}
const appOps = (w) => w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app'").n;

/**
 * alice (contacts with pins) with sessions alice [reviewer] and alice-2 [reviewer]; bob with
 * sessions bob [reviewer] and bob-2 [reviewer] on one device; carol [reviewer], not pinned.
 */
async function team(t, { relay = {}, limits, alicePins = ["bob"] } = {}) {
  const w = await deviceRelay(t, { e2ee: true, ...relay });
  const contacts = memoryContacts();
  contacts.doc.encryption = [{ realm: w.realm, mode: "preferred" }];
  const alice = await device(t, w, "alice", { contacts, limits, sessions: [{ name: "alice", roles: ["reviewer"] }] });
  await alice.open("alice-2", { roles: ["reviewer"] });
  const bob = await device(t, w, "bob", { sessions: [{ name: "bob", roles: ["reviewer"] }, { name: "bob-2", roles: ["reviewer"] }] });
  const carol = await device(t, w, "carol", { sessions: [{ name: "carol", roles: ["reviewer"] }] });
  for (const m of alicePins) await pin(w, alice.s.alice.client, contacts, w.members[m].id);
  return { w, contacts, alice, bob, carol, fan: (args) => alice.s.alice.e2ee.fanout({ body: "please review", ...args }) };
}

test("selection: roles select, pins decide; own sessions not counted; two sessions of one member get two copies with distinct ids, both delivered", async (t) => {
  const { alice, bob, carol, fan } = await team(t);
  const sent = capture(alice.s.alice.client, isApp);
  const r = await fan({ to: "@reviewer" });
  // Candidates: bob, bob-2, carol (alice-2 is alice's own session, never a candidate).
  assert.deepEqual([r.candidates, r.excluded.first_contact, r.excluded.not_encrypted, r.excluded.unavailable, r.copies], [3, 1, 0, 0, 2]);
  assert.equal(r.candidates, r.excluded.first_contact + r.excluded.not_encrypted + r.excluded.unavailable + r.copies, "the counts add up");
  assert.equal(r.states.accepted, 2);
  await until(() => bob.s.bob.got.length === 1 && bob.s["bob-2"].got.length === 1, "both of bob's sessions");
  assert.notEqual(bob.s.bob.got[0].message_id, bob.s["bob-2"].got[0].message_id, "distinct message ids per copy");
  assert.deepEqual([bob.s.bob.got[0].text, bob.s.bob.got[0].to, bob.s["bob-2"].got[0].to], ["please review", "bob", "bob-2"]);
  assert.equal(carol.s.carol.got.length, 0, "the unpinned member gets nothing");
  assert.equal(alice.s["alice-2"].got.length, 0);
  // The first contact is not pinned by being looked at.
  assert.equal(alice.contacts.doc.pins.some((p) => p.member === carol.id), false);
  // Op ids: 3.3's random op ids, one per publication attempt, distinct.
  assert.equal(sent.length, 2);
  assert.ok(sent.every((f) => OP_RE.test(f.op)));
  assert.equal(new Set(sent.map((f) => f.op)).size, 2);
  // The record: in the device record, with each copy's final result (the relay's app result).
  const [F] = await fanoutsOf(alice);
  assert.equal(F.v, 2);
  assert.match(F.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(F.copies.map((c) => [c.session, c.final.state, c.final.result.state, c.final.result.recipients]), [["bob", "accepted", "accepted", 1], ["bob-2", "accepted", "accepted", 1]]);
  assert.ok(F.done, "every copy final");
  assert.match(describeFanout("@reviewer", r), /sent to 2 of 2 copies\. Not included: 1 session needs a first direct message \(first-contact\)\. 3 sessions matched @reviewer\./);
  await bounded(alice);
});

test("selection: requireVerified excludes relay-tofu pins; verified pins are included", async (t) => {
  const { w, contacts, alice, bob, fan } = await team(t);
  contacts.doc.requireVerified = [w.realm];
  const r = await fan({ to: "@reviewer" });
  assert.deepEqual([r.candidates, r.excluded.first_contact, r.copies], [3, 3, 0], "bob's pin is relay-tofu");
  const listed = await alice.s.alice.client.rpc({ type: "device_list", member: bob.id });
  decide(contacts.doc, w.realm, bob.id, evaluate(contacts.doc, w.realm, bob.id, listed.devices), { accept: "all", how: "in-person" });
  contacts.doc.revision++;
  const v = await fan({ to: "@reviewer" });
  assert.deepEqual([v.excluded.first_contact, v.copies, v.states.accepted], [1, 2, 2]);
});

test("selection: a hidden member is neither listed nor counted; a grant revoked between resolution and dispatch drops that copy silently", async (t) => {
  let acc;
  const { bob, carol, fan } = await team(t, {
    relay: {
      access: (members) => {
        acc = createAccess({ stateDir: tmpDir(t), policy: null });
        // carol is hidden and lets only bob reach her.
        acc.putGrants(members.carol.id, 0, { default: "deny", visible: "grantees", entries: [{ selector: `member:${members.bob.id}`, action: "allow" }] });
        return acc;
      },
    },
  });
  const r = await fan({ to: "@reviewer" });
  assert.deepEqual([r.candidates, r.copies], [2, 2], "carol is not a candidate and not counted");
  await until(() => bob.s.bob.got.length === 1 && bob.s["bob-2"].got.length === 1, "bob's copies");
  // bob goes offline; then denies alice; the next copies are accepted, then dropped at dispatch.
  bob.s.bob.client.close();
  bob.s["bob-2"].client.close();
  await settle(60);
  const before = await fan({ to: ["bob", "bob-2"], body: "second" });
  assert.equal(before.states.accepted, 2, "accepted while the grant held");
  acc.putGrants(bob.id, 0, { default: "deny", visible: "all", entries: [] });
  const again = await bob.open("bob", { roles: ["reviewer"] });
  await settle(400);
  assert.equal(again.got.length, 0, "dropped at dispatch, not delivered");
  assert.equal(carol.s.carol.got.length, 0);
});

test("explicit list: each name as a direct send would answer (unknown and unreachable alike); first use pins the named member", async (t) => {
  const { contacts, carol, fan } = await team(t, { alicePins: [] });
  const r = await fan({ to: ["carol", "nobody-here", "alice-2"] });
  assert.deepEqual(r.names, [{ name: "carol", state: "accepted" }, { name: "nobody-here", state: "unavailable" }, { name: "alice-2", state: "unavailable" }]);
  assert.deepEqual([r.candidates, r.excluded.unavailable, r.copies], [3, 2, 1]);
  await until(() => carol.s.carol.got.length === 1, "carol's copy");
  assert.ok(contacts.doc.pins.some((p) => p.member === carol.id), "a named member is pinned on first use, as a direct send");
  await assert.rejects(fan({ to: ["bob@another-relay"] }), (e) => e.code === "bad_request");
  assert.equal((await fan({ to: ["carol@relay-test"] })).states.accepted, 1, "this relay's own alias");
});

test("policy: preferred with a plaintext-only candidate sends the others encrypted and counts it not-encrypted; required counts it unavailable; never plaintext", async (t) => {
  const { w, contacts, bob, carol, fan } = await team(t, { alicePins: ["bob", "carol"] });
  const plain = [];
  carol.s.carol.client.on("message", (m) => plain.push(m));
  contacts.doc.encryption.push({ realm: w.realm, member: carol.id, mode: "off" });
  const r = await fan({ to: "@reviewer" });
  assert.deepEqual([r.candidates, r.excluded.not_encrypted, r.copies, r.states.accepted], [3, 1, 2, 2]);
  await settle(200);
  assert.equal(carol.s.carol.got.length + plain.length, 0, "no plaintext copy, and no encrypted one under off");
  // Under required, a candidate with no enrolled device is unavailable, never plaintext.
  contacts.doc.encryption = [{ realm: w.realm, mode: "required" }];
  await carol.store.revoke(carol.s.carol.client, carol.device).catch(() => {});
  const req = await fan({ to: ["bob", "carol"], body: "required" });
  assert.deepEqual(req.names, [{ name: "bob", state: "accepted" }, { name: "carol", state: "unavailable" }]);
  await until(() => bob.s.bob.got.length === 2, "bob's copies");
  await settle(200);
  assert.equal(plain.length, 0);
});

test("policy: a role session that is no member's (shared token) is not-encrypted under preferred and unavailable under required", async (t) => {
  const shared = crypto.randomBytes(16).toString("hex");
  const { w, contacts, fan } = await team(t, { relay: { shared } });
  const rc = new RelayClient({ url: w.url, token: shared, name: "outsider", mode: "peer", roles: ["reviewer"], reconnect: false });
  rc.on("error", () => {});
  rc.start();
  await rc.ready(5000);
  t.after(() => rc.close());
  const got = [];
  rc.on("message", (m) => got.push(m));
  const p = await fan({ to: "@reviewer" });
  assert.deepEqual([p.candidates, p.excluded.not_encrypted, p.excluded.first_contact, p.copies], [4, 1, 1, 2]);
  contacts.doc.encryption = [{ realm: w.realm, mode: "required" }];
  const q = await fan({ to: "@reviewer" });
  assert.deepEqual([q.candidates, q.excluded.unavailable, q.excluded.first_contact, q.copies], [4, 1, 1, 2]);
  await settle(200);
  assert.equal(got.length, 0, "never plaintext to it");
});

/** A hosted member's session (design 4.5): its host signs in for it, with `roles`; records what it is sent. */
async function hostedSession(t, w, member, roles = []) {
  const rc = new RelayClient({ url: w.url, token: w.hostToken, hostMember: w.members[member].id, name: member, mode: "peer", roles, reconnect: false });
  rc.on("error", () => {});
  const got = [];
  rc.on("message", (m) => got.push(m));
  rc.start();
  await rc.ready(5000);
  t.after(() => rc.close());
  return Object.assign(rc, { got });
}
const OPEN_POLICY = { groups: {}, rules: [], defaultAction: "allow", requireGrants: false };
const FENCED_POLICY = { ...OPEN_POLICY, groups: { claimed: { members: [], oidcGroups: [{ issuer: "https://idp.example", group: "x" }] } } };

test("hosted custody: a hosted @role candidate is excluded before any copy, not-encrypted under preferred (also with allow-hosted), unavailable under required", async (t) => {
  const { w, contacts, fan, alice } = await team(t, { relay: { hosted: ["hanna"] }, alicePins: ["bob", "carol"] });
  const hanna = await hostedSession(t, w, "hanna", ["reviewer"]);
  const listed = (await alice.s.alice.client.rpc({ type: "list" })).peers.find((p) => p.name === "hanna");
  assert.deepEqual([listed.custody, listed.member_id], ["hosted", w.members.hanna.id], "the relay's list names its custody and member id");
  const p = await fan({ to: "@reviewer" });
  assert.deepEqual([p.candidates, p.excluded.not_encrypted, p.excluded.first_contact, p.excluded.unavailable, p.copies], [4, 1, 0, 0, 3], "counted not-encrypted, not first-contact");
  contacts.doc.encryption.push({ realm: w.realm, member: w.members.hanna.id, mode: "preferred", custody: "allow-hosted" });
  const o = await fan({ to: "@reviewer", body: "allow-hosted" });
  assert.deepEqual([o.candidates, o.excluded.not_encrypted, o.copies], [4, 1, 3], "the override never applies inside a fan-out");
  contacts.doc.encryption = [{ realm: w.realm, mode: "required" }];
  const r = await fan({ to: "@reviewer", body: "required" });
  assert.deepEqual([r.candidates, r.excluded.unavailable, r.excluded.not_encrypted, r.excluded.first_contact, r.copies], [4, 1, 0, 0, 3]);
  assert.match(describeFanout("@reviewer", r), /1 session unavailable/);
  const s = await stateOf(alice);
  assert.ok(Object.values(s.logical).every((L) => L.target !== "hanna" && L.peer !== w.members.hanna.id), "no copy and no logical message for the hosted member");
  await settle(200);
  assert.equal(hanna.got.length, 0, "nothing reaches the hosted member");
});

test("hosted custody: a hosted name in an explicit list gets the direct send's refusal at preflight; allow-hosted is refused as 'send it separately'", async (t) => {
  const { w, contacts, fan, alice, bob } = await team(t, { relay: { hosted: ["hanna"] }, alicePins: ["bob"] });
  const hanna = await hostedSession(t, w, "hanna");
  const r = await fan({ to: ["bob", "hanna"] });
  assert.deepEqual(r.names, [{ name: "bob", state: "accepted" }, { name: "hanna", state: "refused", reason: "hosted_custody" }]);
  assert.deepEqual([r.candidates, r.excluded.refused, r.copies], [2, 1, 1], "the counts add up");
  assert.match(describeFanout("[bob, hanna]", r), /hanna refused \(hosted custody: the host can read; not sent\)/);
  contacts.doc.encryption.push({ realm: w.realm, member: w.members.hanna.id, mode: "preferred", custody: "allow-hosted" });
  const o = await fan({ to: ["hanna"], body: "allow-hosted" });
  assert.deepEqual([o.names, o.excluded.refused, o.copies], [[{ name: "hanna", state: "refused", reason: "hosted_separately" }], 1, 0]);
  assert.match(describeFanout("[hanna]", o), /hosted custody: send it separately/);
  contacts.doc.encryption = [{ realm: w.realm, mode: "required" }, { realm: w.realm, member: w.members.hanna.id, mode: "required", custody: "allow-hosted" }];
  const q = await fan({ to: ["hanna"], body: "required" });
  assert.deepEqual(q.names, [{ name: "hanna", state: "refused", reason: "hosted_custody" }]);
  const s = await stateOf(alice);
  assert.ok(Object.values(s.logical).every((L) => L.target !== "hanna"), "no logical message for the hosted name");
  assert.ok(!(contacts.doc.pins ?? []).some((x) => x.member === w.members.hanna.id), "the hosted name is not pinned");
  await until(() => bob.s.bob.got.length === 1, "bob's copy");
  await settle(200);
  assert.equal(hanna.got.length, 0);
});

test("hosted custody: while the relay's fence is up, hosted members are not candidates and not counted; by name, the answer for an unknown name", async (t) => {
  let acc;
  const { w, fan } = await team(t, {
    relay: { hosted: ["hanna"], access: () => (acc = createAccess({ stateDir: tmpDir(t), policy: OPEN_POLICY })) },
    alicePins: ["bob", "carol"],
  });
  await hostedSession(t, w, "hanna", ["reviewer"]);
  const down = await fan({ to: "@reviewer" });
  assert.deepEqual([down.candidates, down.excluded.not_encrypted, down.copies], [4, 1, 3], "fence down: counted, not-encrypted");
  acc.setPolicy(FENCED_POLICY);
  const up = await fan({ to: "@reviewer", body: "fenced" });
  assert.deepEqual([up.candidates, up.excluded.not_encrypted, up.excluded.unavailable, up.excluded.first_contact, up.copies], [3, 0, 0, 0, 3], "fence up: not a candidate, not counted");
  const named = await fan({ to: ["hanna", "nobody-here"], body: "fenced, by name" });
  assert.deepEqual(named.names, [{ name: "hanna", state: "unavailable" }, { name: "nobody-here", state: "unavailable" }], "as an unknown name");
});

test("states: a new device of one recipient holds only that copy; released after the owner accepts it; an expired held copy is never sent", async (t) => {
  const { w, contacts, alice, bob, carol, fan } = await team(t, { alicePins: ["bob", "carol"] });
  // bob enrolls a second device: sending to bob holds until alice's owner accepts it.
  await acceptOwnDevices(bob, await device(t, w, "bob", { sessions: ["bob-laptop"] })); // bob's owner accepted it (A1)
  const r = await fan({ to: "@reviewer" });
  assert.deepEqual([r.copies, r.states.held, r.states.accepted], [3, 2, 1]);
  await until(() => carol.s.carol.got.length === 1, "carol's copy is not held");
  const [F] = await fanoutsOf(alice);
  assert.equal(F.done, undefined, "in progress");
  const listed = await alice.s.alice.client.rpc({ type: "device_list", member: bob.id });
  decide(contacts.doc, w.realm, bob.id, evaluate(contacts.doc, w.realm, bob.id, listed.devices), { accept: "all", how: "in-person" });
  contacts.doc.revision++;
  await alice.s.alice.e2ee.releaseHeld(bob.id);
  const s = await alice.s.alice.e2ee.fanoutStatus(F.id);
  assert.deepEqual([s.states.held, s.states.accepted], [0, 3]);
  await until(() => bob.s.bob.got.length === 1 && bob.s["bob-2"].got.length === 1, "released copies");
  // Expired while held: never sent, final "expired".
  await acceptOwnDevices(bob, await device(t, w, "bob", { sessions: ["bob-tablet"] }));
  const h = await fan({ to: ["bob"], body: "short-lived", lifetimeMs: 60_000 });
  assert.equal(h.states.held, 1);
  w.clock.advance(60_000 + SKEW_MS);
  const ops = appOps(w);
  await alice.s.alice.e2ee.recover();
  const listed2 = await alice.s.alice.client.rpc({ type: "device_list", member: bob.id });
  decide(contacts.doc, w.realm, bob.id, evaluate(contacts.doc, w.realm, bob.id, listed2.devices), { accept: "all", how: "in-person" });
  contacts.doc.revision++;
  await alice.s.alice.e2ee.releaseHeld(bob.id);
  assert.equal(appOps(w), ops, "never published");
  const all = await fanoutsOf(alice);
  const H = all.find((x) => x.id === h.id);
  assert.equal(H.copies[0].final.state, "expired");
  await bounded(alice);
});

test("states: no KeyPackage for a named member's device -> unavailable (final), never retried by recovery", async (t) => {
  const { w, alice, carol, fan } = await team(t, { alicePins: [] });
  // carol's device has an empty pool.
  for (let i = 0; ; i++) {
    try {
      w.directory.take({ requester: { member: alice.id, device: alice.device }, request: `drain-pool-${i}`, target: { member: carol.id, device: carol.device } });
    } catch {
      break;
    }
  }
  const r = await fan({ to: ["carol"] });
  assert.deepEqual(r.names, [{ name: "carol", state: "unavailable" }]);
  const [F] = await fanoutsOf(alice);
  assert.deepEqual([F.copies[0].final.state, F.copies[0].final.reason], ["unavailable", "no_key_package"]);
  const ops = appOps(w);
  await alice.s.alice.e2ee.recover();
  assert.equal(appOps(w), ops);
  assert.equal((await stateOf(alice)).logical[F.copies[0].ref].state, "failed");
});

test("write boundaries: before the creation write nothing exists; after it every copy is sent once by recovery", async (t) => {
  const { w, alice, bob } = await team(t);
  const crash = (point) => (p) => {
    if (p === point) throw new Error(`crash at ${p}`);
  };
  const before = alice.engine(alice.s.alice.client, "alice", { fault: crash("fanout-before-save") });
  await assert.rejects(before.e2ee.fanout({ to: "@reviewer", body: "lost" }), /crash at fanout-before-save/);
  let s = await stateOf(alice);
  assert.equal(Object.keys(s.fanout ?? {}).length, 0, "no record");
  assert.equal(Object.keys(s.logical ?? {}).length, 0, "no logical messages");
  assert.equal(appOps(w), 0, "nothing sent");
  const after = alice.engine(alice.s.alice.client, "alice", { fault: crash("fanout-after-save") });
  await assert.rejects(after.e2ee.fanout({ to: "@reviewer", body: "kept" }), /crash at fanout-after-save/);
  s = await stateOf(alice);
  assert.equal(Object.keys(s.fanout).length, 1, "the record");
  assert.deepEqual(Object.values(s.logical).map((L) => L.state), ["new", "new"], "and both copies, in one write");
  const fresh = alice.engine(alice.s.alice.client, "alice");
  await fresh.e2ee.recover();
  await until(() => bob.s.bob.got.length === 1 && bob.s["bob-2"].got.length === 1, "sent by recovery");
  await settle(200);
  assert.equal(bob.s.bob.got.length + bob.s["bob-2"].got.length, 2, "once each");
  assert.equal(appOps(w), 2);
  const [F] = await fanoutsOf(alice);
  assert.deepEqual(F.copies.map((c) => c.final?.state), ["accepted", "accepted"]);
});

test("write boundaries: sealed but unpublished -> resealed under a new op id; published, answer lost -> reconciled, the original result kept, nothing resealed", async (t) => {
  const { alice, bob } = await team(t);
  // A copy sealed (outbox entry durable) and the process gone before publication.
  const crashed = alice.engine(alice.s.alice.client, "alice", {
    fault: (p) => {
      if (p === "send-after-persist") throw new Error("crash after the seal");
    },
  });
  await crashed.e2ee.fanout({ to: ["bob"], body: "sealed once" });
  const sealedOps = Object.keys((await stateOf(alice)).outbox);
  assert.equal(sealedOps.length, 1);
  const sent = capture(alice.s.alice.client, isApp);
  const fresh = alice.engine(alice.s.alice.client, "alice");
  await fresh.e2ee.recover();
  await until(() => bob.s.bob.got.length === 1, "accepted once");
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].op, sealedOps[0], "a new op id");
  // Published, the answer lost; the group unchanged.
  loseAnswer(alice.s.alice.client, isApp);
  const r = await fresh.e2ee.fanout({ to: ["bob-2"], body: "answer lost" });
  assert.equal(r.states.pending, 1, "unresolved");
  const s = await stateOf(alice);
  assert.equal(Object.values(s.outbox)[0].phase, "published");
  const resealed = capture(alice.s.alice.client, isApp);
  await fresh.e2ee.recover();
  assert.deepEqual(resealed.map((f) => f.reconcile), [true], "only the reconciliation, nothing resealed");
  const F = (await fanoutsOf(alice)).find((x) => x.id === r.id);
  assert.deepEqual(F.copies[0].final, { state: "accepted", result: { state: "accepted", recipients: 1 } });
  await until(() => bob.s["bob-2"].got.length === 1, "delivered once");
  await settle(200);
  assert.equal(bob.s["bob-2"].got.length, 1);
});

test("write boundaries: a publication the relay never received is cancelled and resealed; the delayed original is refused; a failed reconciliation keeps the entry", async (t) => {
  const { w, alice, bob } = await team(t);
  // Never received: the request is not sent at all.
  loseAnswer(alice.s.alice.client, isApp, { send: false });
  const r = await alice.s.alice.e2ee.fanout({ to: ["bob"], body: "never received" });
  assert.equal(r.states.pending, 1);
  const [entry] = Object.values((await stateOf(alice)).outbox);
  // A reconciliation that does not answer: the entry stays, the copy pending, nothing resealed.
  loseAnswer(alice.s.alice.client, (f) => isApp(f) && f.reconcile, { send: false });
  await alice.s.alice.e2ee.recover();
  assert.equal(Object.keys((await stateOf(alice)).outbox).length, 1, "kept");
  assert.equal((await alice.s.alice.e2ee.fanoutStatus(r.id)).states.pending, 1);
  assert.equal(appOps(w), 0);
  // Now it answers: cancelled, then sealed again under a new op id.
  await alice.s.alice.e2ee.recover();
  await until(() => bob.s.bob.got.length === 1, "resealed and delivered");
  assert.equal((await alice.s.alice.e2ee.fanoutStatus(r.id)).states.accepted, 1);
  const late = await alice.s.alice.client.rpc(entry.frame).then(() => "accepted", (e) => e.code);
  assert.equal(late, "op_cancelled");
});

test("write boundaries: a crash after acceptance, before the write of the logical state and the final result: neither; recovery records both", async (t) => {
  const { w, alice, bob } = await team(t);
  const crashed = alice.engine(alice.s.alice.client, "alice", {
    fault: (p) => {
      if (p === "send-after-publish") throw new Error("crash after the answer");
    },
  });
  const r = await crashed.e2ee.fanout({ to: ["bob"], body: "accepted, answer not recorded" });
  let s = await stateOf(alice);
  const F0 = s.fanout[r.id];
  assert.equal(F0.copies[0].final, undefined, "no final");
  assert.equal(s.logical[F0.copies[0].ref].state, "sealed", "and not sent: neither");
  const fresh = alice.engine(alice.s.alice.client, "alice");
  await fresh.e2ee.recover();
  s = await stateOf(alice);
  assert.equal(s.logical[F0.copies[0].ref].state, "sent");
  assert.deepEqual(s.fanout[r.id].copies[0].final, { state: "accepted", result: { state: "accepted", recipients: 1 } }, "both");
  assert.equal(appOps(w), 1);
  await until(() => bob.s.bob.got.length === 1, "delivered once");
});

test("recovery through current state: the group replaced between sealing and recovery -> sealed again with the same message id, delivered at most once", async (t) => {
  const { alice, bob } = await team(t);
  loseAnswer(alice.s.alice.client, isApp);
  const r = await alice.s.alice.e2ee.fanout({ to: ["bob"], body: "across a replacement" });
  assert.equal(r.states.pending, 1);
  await until(() => bob.s.bob.got.length === 1, "the relay accepted it");
  // bob replaces the conversation's group (a new generation) before alice recovers.
  await bob.s.bob.e2ee.replace(alice.id);
  await settle(300);
  const kinds = capture(alice.s.alice.client, isApp);
  await alice.s.alice.e2ee.recover();
  await settle(300);
  const F = (await fanoutsOf(alice)).find((x) => x.id === r.id);
  assert.deepEqual(F.copies[0].final, { state: "accepted", result: { state: "accepted", recipients: 1 } }, "accepted, final unchanged");
  assert.ok(kinds.some((f) => !f.reconcile), "3.3's replacement resend sealed it again");
  await settle(300);
  assert.equal(bob.s.bob.got.length, 1, "delivered at most once");
});

test("frozen audience: a retry with the same send_op returns the same fan-out; it never resolves the audience again", async (t) => {
  const { w, contacts, alice, carol, fan } = await team(t);
  const r = await fan({ to: "@reviewer", sendOp: "tool-call-1" });
  await pin(w, alice.s.alice.client, contacts, carol.id);
  const again = await fan({ to: "@reviewer", sendOp: "tool-call-1" });
  assert.equal(again.id, r.id);
  assert.deepEqual([again.copies, again.excluded.first_contact], [2, 1], "carol, pinned since, is not added");
  assert.equal((await fanoutsOf(alice)).length, 1, "one record");
  assert.equal(appOps(w), 2);
  const other = await fan({ to: "@reviewer", sendOp: "tool-call-2" });
  assert.equal(other.copies, 3);
});

test("frozen audience: an empty result is kept too; a retry with the same send_op after a pin is added sends nothing, until the record is pruned", async (t) => {
  const { w, contacts, alice, bob, fan } = await team(t, { alicePins: [] });
  const r = await fan({ to: "@reviewer", sendOp: "tool-call-empty" });
  assert.deepEqual([r.candidates, r.excluded.first_contact, r.copies], [3, 3, 0]);
  const [F] = await fanoutsOf(alice);
  assert.equal(F.done, F.created, "final at once");
  assert.equal(retained(await stateOf(alice)).count, 1, "counted against the retained send state");
  await pin(w, alice.s.alice.client, contacts, bob.id);
  const again = await fan({ to: "@reviewer", sendOp: "tool-call-empty" });
  assert.deepEqual([again.id, again.copies], [r.id, 0], "the same empty result");
  assert.equal(appOps(w), 0, "nothing sent");
  // Without a send_op an empty result keeps nothing (no retry could match it).
  const none = await fan({ to: ["nobody-here"] });
  assert.equal(none.copies, 0);
  assert.equal((await fanoutsOf(alice)).length, 1);
  // Pruned 7 days after: the same send_op is a new fan-out then.
  w.clock.advance(7 * DAY);
  const later = await fan({ to: "@reviewer", sendOp: "tool-call-empty" });
  assert.notEqual(later.id, r.id);
  assert.equal(later.copies, 2);
});

test("current policy: a copy not yet sealed when its contact is set to off is refused (policy), never sent; an accepted copy's result is kept", async (t) => {
  const { w, contacts, alice, bob } = await team(t);
  // Accepted first: its final result stays when the policy changes later.
  const sent = await alice.s.alice.e2ee.fanout({ to: ["bob"], body: "accepted before" });
  assert.equal(sent.states.accepted, 1);
  const crashed = alice.engine(alice.s.alice.client, "alice", {
    fault: (p) => {
      if (p === "fanout-after-save") throw new Error("stop after the creation write");
    },
  });
  await assert.rejects(crashed.e2ee.fanout({ to: ["bob-2"], body: "created, then policy off" }), /stop after/);
  contacts.doc.encryption.push({ realm: w.realm, member: bob.id, mode: "off" });
  contacts.doc.revision++;
  const ops = appOps(w);
  await alice.s.alice.e2ee.recover();
  assert.equal(appOps(w), ops, "nothing published");
  const all = await fanoutsOf(alice);
  const late = all.find((F) => F.id !== sent.id);
  assert.deepEqual(late.copies[0].final, { state: "refused", reason: "policy" });
  assert.deepEqual(all.find((F) => F.id === sent.id).copies[0].final, { state: "accepted", result: { state: "accepted", recipients: 1 } }, "unchanged");
  // A replacement would seal the accepted message again: refused under off, its result unchanged.
  await bob.s.bob.e2ee.replace(alice.id);
  await settle(400);
  await alice.s.alice.e2ee.recover();
  assert.equal(appOps(w), ops, "nothing sealed again under off");
  assert.equal((await fanoutsOf(alice)).find((F) => F.id === sent.id).copies[0].final.state, "accepted");
  await bounded(alice);
});

test("current policy: a direct message whose reseal comes after its contact was set to off is refused, not sealed again", async (t) => {
  const { w, contacts, alice, bob } = await team(t);
  loseAnswer(alice.s.alice.client, isApp, { send: false });
  const r = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "never received" });
  assert.equal(r.state, "unsent");
  contacts.doc.encryption.push({ realm: w.realm, member: bob.id, mode: "off" });
  contacts.doc.revision++;
  // An ambiguous published entry is kept until it is reconciled, policy or not.
  loseAnswer(alice.s.alice.client, (f) => isApp(f) && f.reconcile, { send: false });
  await alice.s.alice.e2ee.recover();
  const kept = await stateOf(alice);
  assert.equal(Object.keys(kept.outbox).length, 1, "kept while unresolved");
  assert.equal(kept.logical[r.message_id].state, "sealed");
  await alice.s.alice.e2ee.recover(); // cancelled by reconciliation, then the reseal meets the policy
  assert.equal(appOps(w), 0);
  assert.equal(Object.keys((await stateOf(alice)).outbox).length, 0);
  assert.equal((await stateOf(alice)).logical[r.message_id].state, "failed");
  await settle(200);
  assert.equal(bob.s.bob.got.length, 0);
});

test("device lists during a fan-out: each copy asks again; a device enrolled after one copy is seen by the next (held)", async (t) => {
  const { w, alice, fan } = await team(t);
  // After the first copy is accepted, bob enrolls another device; the clock does not move.
  const rpc = alice.s.alice.client.rpc.bind(alice.s.alice.client);
  let armed = true;
  let lists = 0;
  alice.s.alice.client.rpc = async (f) => {
    if (f.type === "device_list") lists++;
    const r = await rpc(f);
    if (armed && isApp(f)) {
      armed = false;
      await device(t, w, "bob");
    }
    return r;
  };
  const r = await fan({ to: ["bob", "bob-2"] });
  assert.deepEqual(r.names.map((n) => n.state), ["accepted", "held"], "the new device holds the second copy");
  // Within one message the trust gate and the group check share one answer: 2 per copy (bob's and
  // alice's own), plus the preflight's one.
  assert.equal(lists, 1 + 2 * 2);
});

test("a replacement after a 20-copy fan-out: every accepted copy is sealed again without an explicit recover(), also when the relay's rate limit stops a pass", async (t) => {
  const { w, alice, bob, fan } = await team(t);
  t.after(() => (alice.s.alice.e2ee.close(), alice.s["alice-2"].e2ee.close()));
  const names = Array.from({ length: 20 }, (_, i) => `bob-x${i}`);
  const r = await fan({ to: names });
  assert.equal(r.states.accepted, 20);
  const gid = (await stateOf(alice)).conversations[bob.id];
  // Count the relay's rate-limit refusals alice's device meets from here on (its newest
  // connection, alice-2, gets the Welcome and seals again).
  let limited = 0;
  for (const s of [alice.s.alice, alice.s["alice-2"]]) {
    const rpc = s.client.rpc.bind(s.client);
    s.client.rpc = (f) =>
      rpc(f).catch((e) => {
        if (e.code === "rate_limited") limited++;
        throw e;
      });
  }
  // bob replaces the conversation's group; alice processes its Welcome on her own (no recover()).
  // The relay records each accepted copy's op (a rate-limited request is refused before that);
  // its queue is no measure, as bob's device takes the copies from it as they arrive.
  const ops = appOps(w);
  await bob.s.bob.e2ee.replace(alice.id);
  await until(() => appOps(w) === ops + 20, "all 20 copies sealed again and accepted", 15_000);
  assert.ok(limited > 0, "a pass was stopped by the relay's rate limit");
  const s = await stateOf(alice);
  assert.ok(Object.values(s.logical).every((L) => L.state === "sent" && L.group !== gid), "all sent in the new group, nothing left marked resend");
  assert.ok(Object.values(s.fanout)[0].copies.every((c) => c.final.state === "accepted"), "finals unchanged");
});

test("an accepted direct message whose reseal is refused rate_limited at publication is sealed again later, not failed", async (t) => {
  const { w, alice, bob } = await team(t);
  alice.s["alice-2"].client.close(); // alice's one connection gets the Welcome
  await settle(60);
  t.after(() => alice.s.alice.e2ee.close());
  const sent = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "accepted, then replaced" });
  assert.equal(sent.state, "accepted");
  const gid = (await stateOf(alice)).conversations[bob.id];
  // The relay refuses the first reseal's publication for its rate limit (before recording the op).
  const rpc = alice.s.alice.client.rpc.bind(alice.s.alice.client);
  let armed = true;
  alice.s.alice.client.rpc = (f) => {
    if (armed && isApp(f)) {
      armed = false;
      return Promise.reject(Object.assign(new Error("rate limit"), { kind: "relay_error", code: "rate_limited" }));
    }
    return rpc(f);
  };
  // Accepted by the relay (its op recorded), not seen in bob's queue: bob's device may take it first.
  const ops = appOps(w);
  await bob.s.bob.e2ee.replace(alice.id);
  await until(() => appOps(w) === ops + 1, "sealed again and accepted", 10_000);
  assert.equal(armed, false, "the refusal happened");
  const L = (await stateOf(alice)).logical[sent.message_id];
  assert.deepEqual([L.state, L.group !== gid], ["sent", true], "sent in the new group");
});

/** A crash right after a 20-copy fan-out's creation write: 20 copies "new", nothing sent. */
async function twentyNew(t) {
  const team_ = await team(t);
  const { alice } = team_;
  alice.s["alice-2"].client.close();
  const crashed = alice.engine(alice.s.alice.client, "alice", {
    fault: (p) => {
      if (p === "fanout-after-save") throw new Error("stop after the creation write");
    },
  });
  await assert.rejects(crashed.e2ee.fanout({ to: Array.from({ length: 20 }, (_, i) => `bob-y${i}`), body: "recovered" }), /stop after/);
  let limited = 0;
  const rpc = alice.s.alice.client.rpc.bind(alice.s.alice.client);
  alice.s.alice.client.rpc = (f) =>
    rpc(f).catch((e) => {
      if (e.code === "rate_limited") limited++;
      throw e;
    });
  return { ...team_, limited: () => limited };
}

test("recover(): a pass the relay's rate limit stops runs again on its own until every copy is sent (no second recover)", async (t) => {
  const { w, alice, limited } = await twentyNew(t);
  const fresh = alice.engine(alice.s.alice.client, "alice");
  t.after(() => fresh.e2ee.close());
  await fresh.e2ee.recover(); // the one explicit call
  await until(() => appOps(w) === 20, "all 20 copies sent", 15_000);
  assert.ok(limited() > 0, "the first pass was stopped by the rate limit");
  assert.ok(Object.values((await stateOf(alice)).logical).every((L) => L.state === "sent"));
});

test("close(): the scheduled passes stop", async (t) => {
  const { w, alice, limited } = await twentyNew(t);
  const fresh = alice.engine(alice.s.alice.client, "alice");
  await fresh.e2ee.recover();
  assert.ok(limited() > 0);
  fresh.e2ee.close();
  const ops = appOps(w);
  await settle(4000);
  assert.equal(appOps(w), ops, "nothing more after close()");
});

test("limits: 51 copies refused before any copy, 50 sent; n * R over 8 MiB refused; a fifth fan-out in progress refused", async (t) => {
  const { w, alice, fan } = await team(t, { limits: { retainedBytes: 256 * 1024 * 1024, retainedEntries: 10_000 } });
  const names = (n) => Array.from({ length: n }, (_, i) => `bob-x${i}`);
  await assert.rejects(fan({ to: names(51) }), (e) => e.code === "too_many_recipients");
  assert.equal(Object.keys((await stateOf(alice)).logical ?? {}).length, 0, "nothing created");
  const ok = await fan({ to: names(50) });
  assert.deepEqual([ok.copies, ok.states.accepted], [50, 50]);
  // 8 MiB: 30 copies of about 240,000 content bytes each (R about 321,000).
  const big = "😀".repeat(60_000);
  assert.ok(30 * frameBound(240_000) > 8 * 1024 * 1024 && frameBound(240_400) < MAX_FRAME_BYTES);
  await assert.rejects(fan({ to: names(30), body: big }), (e) => e.code === "too_large" && /8388608/.test(e.message));
  assert.equal(Object.keys((await stateOf(alice)).logical).length, 50, "nothing created");
  // A fifth fan-out while four are in progress (their copies held: bob has a new device).
  await device(t, w, "bob", { sessions: ["bob-laptop"] });
  for (let i = 0; i < 4; i++) assert.equal((await fan({ to: ["bob"], body: `held ${i}` })).states.held, 1);
  await assert.rejects(fan({ to: ["bob"], body: "fifth" }), (e) => e.code === "too_many_fanouts");
  await bounded(alice, { ...LIMITS, retainedBytes: 256 * 1024 * 1024, retainedEntries: 10_000 });
});

test("limits: a copy whose frame exceeds its reservation at release is refused (too_large), not sent", async (t) => {
  const { w, contacts, alice, bob, fan } = await team(t);
  await device(t, w, "bob", { sessions: ["bob-laptop"] });
  const r = await fan({ to: ["bob"] });
  assert.equal(r.states.held, 1);
  // Its reservation shrinks below the frame it will seal to (as a reservation too small would be).
  await alice.store.transact(async (ctx) => {
    for (const L of Object.values(ctx.rec.e2ee.logical)) L.reserve = 64;
    ctx.write();
  });
  const listed = await alice.s.alice.client.rpc({ type: "device_list", member: bob.id });
  decide(contacts.doc, w.realm, bob.id, evaluate(contacts.doc, w.realm, bob.id, listed.devices), { accept: "all", how: "in-person" });
  contacts.doc.revision++;
  await alice.s.alice.e2ee.releaseHeld(bob.id);
  const s = await alice.s.alice.e2ee.fanoutStatus(r.id);
  assert.equal(s.states.refused, 1);
  assert.equal(appOps(w), 0);
  assert.equal((await fanoutsOf(alice))[0].copies[0].final.reason, "too_large");
});

test("limits: a recipient device's full queue refuses that copy only (quota)", async (t) => {
  // Each recipient device queues at most two messages.
  const { alice, bob, carol, fan } = await team(t, { alicePins: ["bob", "carol"], relay: { limits: { messages: 2 } } });
  // The conversations exist (their Welcomes delivered), then bob's sessions go offline.
  for (const [d, s] of [[bob, "bob"], [carol, "carol"]]) {
    await alice.s.alice.e2ee.send({ to: { member: d.id, session: s }, body: "hello" });
    await until(() => d.s[s].got.length === 1, `${s} joined`);
  }
  await settle(200);
  bob.s.bob.client.close();
  bob.s["bob-2"].client.close();
  await settle(60);
  // bob's device takes two more; the third copy for it is refused, carol's is not.
  const r = await fan({ to: ["bob", "bob-2", "bob-x", "carol"] });
  assert.deepEqual(r.names.map((n) => n.state), ["accepted", "accepted", "refused", "accepted"]);
  const F = (await fanoutsOf(alice)).find((x) => x.id === r.id);
  assert.equal(F.copies[2].final.reason, "quota");
  await until(() => carol.s.carol.got.length === 2, "carol's copy");
});

test("the frame bound R: content of every size class sealed with the fake driver never exceeds R", async () => {
  await sealedWithin(createFakeDriver({ seed: "r" }));
});
test("the frame bound R: content of every size class sealed with OpenMLS (suite 0x004D) never exceeds R", { skip: noWasm }, async () => {
  await sealedWithin(createOpenMlsDriver(WASM, { testOnlySuite: 0x004d }));
});
async function sealedWithin(driver) {
  const realm = "a".repeat(32);
  const [A, B] = ["a", "b"].map((x) => `m_${x.repeat(26)}`);
  const a = await driver.createDevice(credentialIdentity({ realm, member: A, device: newDeviceId() }));
  const b = await driver.createDevice(credentialIdentity({ realm, member: B, device: newDeviceId() }));
  const gid = crypto.randomBytes(16);
  const g = await a.createGroup(gid);
  await g.commit({ add: [await b.keyPackage({ lifetimeSeconds: 86400 })] });
  await g.mergePending();
  const session = "s".repeat(64);
  for (const chars of [1, 10, 100, 1000, 10_000, 65_000, 100_000]) {
    for (const ch of ["x", "é", "😀"]) {
      const body = ch.repeat(Math.ceil(chars / ch.length)).slice(0, chars);
      const c = newContent({ realm, from: { member: A, device: newDeviceId(), session }, to: { member: B, session }, body });
      let content;
      try {
        content = encodeContent(c);
      } catch {
        continue; // over the 256 KiB content bound: never a logical message
      }
      const frame = { type: "send_e2ee", kind: "app", op: `o_${"a".repeat(26)}`, device: newDeviceId(), group: gid.toString("hex"), mls: b64(await g.encrypt(content, new Uint8Array())), target: session, id: Number.MAX_SAFE_INTEGER };
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      assert.ok(bytes <= frameBound(content.length), `${content.length} content bytes: frame ${bytes} <= R ${frameBound(content.length)} (E ${ENVELOPE_E}, J ${FRAME_J})`);
      assert.ok(frameBound(content.length) <= MAX_FRAME_BYTES);
    }
  }
}

test("retained send state: completed fan-outs reach the bound; the next fan-out and a direct send are refused before any write; recovery is never refused; pruning admits again", async (t) => {
  // A bound of about three small fan-outs of two copies.
  const probe = await team(t);
  await probe.fan({ to: "@reviewer" });
  const one = retained(await stateOf(probe.alice)).bytes;
  // Three rounds fit; a fourth fan-out or one more direct send (about half a round) does not.
  const limits = { ...LIMITS, retainedBytes: 3 * one + 1000 };
  const { w, alice, bob, fan } = await team(t, { limits });
  for (let i = 0; i < 3; i++) {
    const r = await fan({ to: "@reviewer", body: `round ${i}` });
    assert.equal(r.states.accepted, 2);
    await bounded(alice, limits);
  }
  const before = await stateOf(alice);
  await assert.rejects(fan({ to: "@reviewer", body: "too much" }), (e) => e.code === "storage_full" && e.retryAt > w.clock.now());
  await assert.rejects(alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "direct, too much" }), (e) => e.code === "storage_full");
  const after = await stateOf(alice);
  assert.deepEqual(Object.keys(after.logical).sort(), Object.keys(before.logical).sort(), "no logical message written");
  assert.deepEqual(Object.keys(after.fanout).sort(), Object.keys(before.fanout).sort(), "no record written");
  // Reopened at the bound (restart): counted bytes identical; recovery and a replacement's reseals are not refused.
  const reopened = alice.engine(await connect(w, "alice", "alice-r"), "alice-r", { limits });
  await reopened.e2ee.attach();
  assert.equal(retained(await stateOf(alice)).bytes, retained(before).bytes, "the counted bytes after reopening equal those before");
  const ops = appOps(w);
  await replaced(alice.s.alice.e2ee, bob.id);
  await settle(400);
  // (Recovery may wait out the relay's per-connection rate limit; the bound never refuses it.)
  await until(async () => (await alice.s.alice.e2ee.recover(), appOps(w) === ops + 6), "every accepted copy sealed again in the new group, none refused by the bound", 30_000);
  assert.ok(Object.values((await stateOf(alice)).logical).every((L) => L.state === "sent"));
  await bounded(alice, limits);
  // After expires + skew the oldest are pruned and the next fan-out is admitted.
  w.clock.advance(7 * DAY + SKEW_MS);
  const next = await fan({ to: "@reviewer", body: "after pruning" });
  assert.equal(next.states.accepted, 2);
  await bounded(alice, limits);
});

test("retained send state: an accepted large body keeps its reservation; smaller sends cannot take it; its reseal after a replacement is admitted and sent", async (t) => {
  const probe = await team(t);
  await probe.alice.s.alice.e2ee.send({ to: { member: probe.bob.id, session: "bob" }, body: "é".repeat(99_000) });
  const large = retained(await stateOf(probe.alice)).bytes;
  const limits = { ...LIMITS, retainedBytes: large + 40_000 };
  const { w, alice, bob } = await team(t, { limits });
  assert.equal((await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "é".repeat(99_000) })).state, "accepted");
  const s0 = await stateOf(alice);
  const [bigRef] = Object.keys(s0.logical);
  assert.equal(s0.logical[bigRef].state, "sent");
  assert.equal(Object.keys(s0.outbox).length, 0, "sent: no outbox entry, the reservation is kept all the same");
  let n = 0;
  for (;;) {
    try {
      await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob-2" }, body: `small ${n}` });
      n++;
      await bounded(alice, limits);
    } catch (e) {
      if (e.code === "rate_limited") {
        await settle(1000); // the relay's device-request limit, not the bound
        continue;
      }
      assert.equal(e.code, "storage_full");
      break;
    }
    assert.ok(n < 200, "refused eventually");
  }
  assert.ok(n >= 1);
  const counted = retained(await stateOf(alice)).bytes;
  // The group is replaced: the large message's reseal uses the reservation it kept since admission.
  const ops = appOps(w);
  await replaced(alice.s.alice.e2ee, bob.id);
  await settle(300);
  await until(async () => (await alice.s.alice.e2ee.recover(), appOps(w) === ops + 1 + n), "every accepted message sealed again, the large one included", 30_000);
  await bounded(alice, limits);
  assert.equal(retained(await stateOf(alice)).bytes, counted, "the counted bytes do not change with reseals");
  await until(() => bob.s.bob.got.length === 1, "the large one delivered once");
});

test("retained send state: a reseal whose answer is lost stays within its message's reservation; restart and reconciliation complete it", async (t) => {
  const { alice, bob } = await team(t);
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "accepted, then replaced" });
  const counted = retained(await stateOf(alice)).bytes;
  loseAnswer(alice.s.alice.client, isApp);
  await replaced(alice.s.alice.e2ee, bob.id);
  await settle(300);
  const s = await stateOf(alice);
  assert.equal(Object.keys(s.outbox).length, 1, "the reseal's outbox entry, unresolved");
  assert.equal(retained(s).bytes, counted, "allocated within the message's reservation");
  await bounded(alice);
  const fresh = alice.engine(alice.s.alice.client, "alice");
  await fresh.e2ee.recover();
  assert.equal(Object.keys((await stateOf(alice)).outbox).length, 0, "reconciled");
  assert.equal(retained(await stateOf(alice)).bytes, counted, "the same counted bytes after the restart");
});

test("retained send state: a failed or expired message releases its reservation; final results never change the counted bytes", async (t) => {
  const { w, alice, bob, fan } = await team(t);
  await device(t, w, "bob", { sessions: ["bob-laptop"] });
  const r = await fan({ to: ["bob", "bob-2"], lifetimeMs: 60_000 });
  assert.equal(r.states.held, 2);
  const held = retained(await stateOf(alice)).bytes;
  w.clock.advance(60_000 + SKEW_MS - 1);
  await alice.s.alice.e2ee.recover();
  assert.equal(retained(await stateOf(alice)).bytes, held);
  w.clock.advance(1);
  await alice.s.alice.e2ee.recover(); // the expiry is recorded (final "expired"), the reservation released
  const s = await stateOf(alice);
  assert.deepEqual(s.fanout[r.id].copies.map((c) => c.final.state), ["expired", "expired"]);
  assert.ok(retained(s).bytes < held, "released");
  assert.ok(!s.logical[s.fanout[r.id].copies[0].ref], "and pruned with it");
  // Final results fill space counted at creation: counted right after the creation write, and
  // again once every copy recorded its final result.
  const crashed = alice.engine(alice.s.alice.client, "alice", {
    fault: (p) => {
      if (p === "fanout-after-save") throw new Error("stop after the creation write");
    },
  });
  await assert.rejects(crashed.e2ee.fanout({ to: ["bob-2"], body: "counted at creation" }), /stop after/);
  const atCreation = retained(await stateOf(alice)).bytes;
  const listed = await alice.s.alice.client.rpc({ type: "device_list", member: bob.id });
  decide(alice.contacts.doc, w.realm, bob.id, evaluate(alice.contacts.doc, w.realm, bob.id, listed.devices), { accept: "all", how: "in-person" });
  alice.contacts.doc.revision++;
  await alice.s.alice.e2ee.recover();
  const finals = await stateOf(alice);
  assert.ok(Object.values(finals.fanout).every((F) => F.copies.every((c) => c.final)), "every copy final");
  assert.equal(retained(finals).bytes, atCreation, "recording the final results changed nothing counted");
  await bounded(alice);
});

test("results: the tool text adds up, with the denominator", () => {
  const r = { copies: 5, candidates: 8, excluded: { first_contact: 2, not_encrypted: 1, unavailable: 0 }, states: { pending: 0, held: 1, accepted: 4, unavailable: 0, refused: 0, expired: 0 } };
  assert.equal(describeFanout("@reviewer", r), "Fan-out to @reviewer, encrypted (experimental, unreviewed): sent to 4 of 5 copies; 1 waits for a key decision by your user. Not included: 2 sessions need a first direct message (first-contact), 1 session cannot receive encrypted messages (not-encrypted). 8 sessions matched @reviewer.");
});

test("measurement: encryption per copy (1 KB, 1 MB), sealing 50 copies, and one save at the byte bound", { skip: noWasm }, async (t) => {
  const driver = createOpenMlsDriver(WASM, { testOnlySuite: 0x004d });
  const realm = "a".repeat(32);
  const a = await driver.createDevice(credentialIdentity({ realm, member: `m_${"a".repeat(26)}`, device: newDeviceId() }));
  const b = await driver.createDevice(credentialIdentity({ realm, member: `m_${"b".repeat(26)}`, device: newDeviceId() }));
  const g = await a.createGroup(crypto.randomBytes(16));
  await g.commit({ add: [await b.keyPackage({ lifetimeSeconds: 86400 })] });
  await g.mergePending();
  const time = async (fn, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t0 = process.hrtime.bigint();
      await fn();
      out.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    out.sort((x, y) => x - y);
    return out[Math.floor(out.length / 2)];
  };
  const kb = crypto.randomBytes(1024);
  const mb = crypto.randomBytes(1024 * 1024);
  const p1k = await time(() => g.encrypt(kb, new Uint8Array()), 50);
  const p1m = await time(() => g.encrypt(mb, new Uint8Array()), 5);
  const fifty = await time(async () => {
    for (let i = 0; i < 50; i++) await g.encrypt(kb, new Uint8Array());
  }, 3);
  // One save of a device record whose send state is at the byte bound (64 MiB counted, the
  // actual bytes about half of it: bodies plus outbox entries at their reservations' size).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-fanout-measure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = await deviceRelay(t);
  const store = deviceStore({ home: dir, profile: "relay-test", driver: createFakeDriver({ seed: "m" }), store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(memoryContacts(), dir, "relay-test") });
  await store.enroll(await w.client("alice"));
  const body = b64(crypto.randomBytes(190_000));
  const save = await store.transact(async (ctx) => {
    ctx.rec.e2ee = { logical: {} };
    for (let i = 0; retained(ctx.rec.e2ee).bytes < LIMITS.retainedBytes - 600_000; i++) ctx.rec.e2ee.logical[crypto.randomUUID()] = { content: body, peer: "p", target: "t", state: "sent", created: 0, expires: 1, reserve: frameBound(142_500) };
    const t0 = process.hrtime.bigint();
    await ctx.save();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });
  t.diagnostic(`OpenMLS suite 0x004D, ${process.platform}-${process.arch}, Node ${process.version}: encrypt 1 KB p50 ${p1k.toFixed(2)} ms, 1 MB p50 ${p1m.toFixed(1)} ms; 50 copies of 1 KB ${fifty.toFixed(1)} ms; one save at the byte bound ${save.toFixed(0)} ms`);
});
