// Encrypted direct messages end to end (design 3.3, experimental), with the fake driver and a real
// relay: conversations and their groups, target sessions (MI4), committer phases and their
// recovery (MI2), the roster cross-check and recovery by replacement, logical ids and replay
// (MI3), the acceptance window, record capacity, rollback (MI5), forks (MI6), holds (3.2's pin
// gate and revocations), and crash windows at each send and receive point.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { ROOT } from "../lib/config.js";
import { deviceStore } from "../lib/mls/device.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { createE2ee, newOpId } from "../lib/mls/e2ee.js";
import { decide, evaluate, pinOf } from "../lib/mls/trust.js";
import { DAY } from "../lib/mls/policy.js";
import { verifyCommand } from "../lib/mls/cli.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { acceptOwnDevices, deviceRelay, memoryContacts, ownFor, refusal, tmpDir } from "./mls-helpers.js";

const PASS = "correct horse battery staple";
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/**
 * A device of `member` (a home with its store, enrolled) and sessions on it. `sessions` are the
 * session names this device's connections hold; each gets an e2ee engine that records deliveries.
 */
async function device(t, w, member, { sessions = [member], dir = tmpDir(t), contacts = memoryContacts(undefined, { file: path.join(dir, "contacts-test.json") }), capacity, fault = null, driver = createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now }) } = {}) {
  const store = deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, "relay-test") });
  // An encrypted send implies a policy for the realm (the session sends encrypted only then).
  if (contacts?.doc) contacts.doc.encryption ??= [{ realm: w.realm, mode: "preferred" }];
  const enrollClient = await w.client(member);
  await store.enroll(enrollClient);
  const d = { dir, store, driver, member, id: w.members[member].id, device: store.record().device, contacts, s: {} };
  d.open = async (session, opts = {}) => {
    const client = await w.client(member, { session });
    const got = [];
    const e2ee = createE2ee({ store, driver, client, session, home: dir, profile: "relay-test", contacts, deliver: async (m) => void got.push(m), now: w.clock.now, capacity, fault: opts.fault ?? fault });
    await e2ee.attach();
    d.s[session] = { client, e2ee, got };
    return d.s[session];
  };
  for (const s of sessions) await d.open(s);
  return d;
}
/** Wait until `fn()` holds (polling). */
async function until(fn, what = "condition", ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(30);
  }
}

test("a conversation: the first send creates the group, the peer joins by Welcome, messages both ways", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  const r = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "hello bob" });
  assert.equal(r.state, "accepted");
  const [m] = await until(() => (bob.s.bob.got.length ? bob.s.bob.got : null), "bob's delivery");
  assert.equal(m.text, "hello bob");
  assert.equal(m.message_id, r.message_id);
  assert.deepEqual([m.sender.auth, m.sender.member.id, m.sender.realm, m.e2ee.device, m.from, m.to], ["member", alice.id, w.realm, alice.device, "alice", "bob"]);
  const back = await bob.s.bob.e2ee.send({ to: { member: alice.id, session: "alice" }, body: "hi alice", replyTo: r.message_id });
  assert.equal(back.state, "accepted");
  const [a] = await until(() => (alice.s.alice.got.length ? alice.s.alice.got : null), "alice's delivery");
  assert.deepEqual([a.text, a.reply_to], ["hi alice", r.message_id]);
  assert.equal((await w.client("carol")).caps.includes("e2ee"), true);
  assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_groups").n, 1, "one group for the pair");
});

/** Capture the frames `client` sends of a type (the relay still gets them). */
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
function loseAnswer(client, pred) {
  const rpc = client.rpc.bind(client);
  let armed = true;
  client.rpc = async (f) => {
    const r = await rpc(f);
    if (armed && pred(f)) {
      armed = false;
      throw Object.assign(new Error("relay did not answer in time"), { kind: "no_answer" });
    }
    return r;
  };
}
/** The message_e2ee frame the relay would send for an application message `sent` (a send_e2ee frame). */
const appFrame = (w, sent, from, to, extra = {}) => ({ type: "message_e2ee", delivery: `e_${crypto.randomBytes(16).toString("hex")}`, group: sent.group, generation: 1, conversation: { realm: w.realm, ...([from.id, to.id].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))) && Object.fromEntries([["a", [from.id, to.id].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))[0]], ["b", [from.id, to.id].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))[1]]])) }, kind: "app", mls: sent.mls, from_member: from.id, from_device: from.device, target: sent.target, ...extra });
const groupRow = (w, gid) => w.db.get("SELECT * FROM e2ee_groups WHERE group_id = ?", gid);

test("MI4 target sessions: two sessions on one device, two devices of one member, an outer target changed with valid ciphertext", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob", { sessions: ["bob", "bob-other"] });
  const bob2 = await device(t, w, "bob", { sessions: ["bob-laptop"] });
  await acceptOwnDevices(bob, bob2); // the owner's two-way acceptance (A1)
  const sent = capture(alice.s.alice.client, (f) => f.type === "send_e2ee" && f.kind === "app");
  assert.equal((await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "for the bob session" })).state, "accepted");
  await until(() => bob.s.bob.got.length === 1, "bob's delivery");
  await settle();
  assert.equal(bob.s["bob-other"].got.length, 0, "the other session of the same device does not see it");
  assert.equal(bob2.s["bob-laptop"].got.length, 0, "the member's other device has no session of that name");
  assert.equal(w.ds.usage({ member: bob.id, device: bob2.device }).messages, 1, "it waits at the relay for a bob session on that device");
  // A relay that changes the outer target: the ciphertext is valid, the authenticated target is
  // "bob"; the copy is refused and costs the genuine message nothing.
  bob.s.bob.client.close();
  await settle();
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "second" });
  const forged = appFrame(w, sent[1], alice, bob, { target: "bob-other" });
  let acked = null;
  assert.equal(await bob.s["bob-other"].e2ee.receive(forged, (o) => (acked = o)), "refused");
  assert.equal(acked, "refused");
  assert.equal(bob.s["bob-other"].got.length, 0);
  const again = await bob.open("bob");
  await until(() => again.got.length === 1, "the genuine copy");
  assert.equal(again.got[0].text, "second");
});

test("MI2: a lost answer, then the retry returns accepted; restarts after persist, after the answer and after the merge never merge twice", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "one" });
  await until(() => bob.s.bob.got.length === 1, "first");
  // A lost answer: the relay accepted the update commit, the device does not know.
  loseAnswer(alice.s.alice.client, (f) => f.type === "send_e2ee" && f.kind === "commit");
  await assert.rejects(alice.s.alice.e2ee.update(bob.id), (e) => e.code === "no_answer");
  const gid = w.db.get("SELECT group_id FROM e2ee_groups").group_id;
  assert.equal(groupRow(w, gid).epoch, 2, "the relay accepted it");
  const r = await alice.s.alice.e2ee.recover();
  assert.equal(r.commits, 1);
  const st = await alice.s.alice.e2ee.status();
  assert.equal(st.groups[gid].epoch, 2, "merged once, as accepted (never taken for a competitor's)");
  // Restarts at each boundary: a fault stops the process there; a fresh engine recovers.
  for (const point of ["commit-after-persist", "commit-after-answer", "commit-after-merge"]) {
    const before = groupRow(w, gid).epoch;
    const s = await alice.open(`alice-${point.slice(7)}`, { fault: (p) => {
      if (p === point) throw new Error(`crash at ${point}`);
    } });
    await assert.rejects(s.e2ee.update(bob.id), new RegExp(point));
    const fresh = await alice.open(`alice-r-${point.slice(7)}`);
    await fresh.e2ee.recover();
    assert.equal(groupRow(w, gid).epoch, before + 1, `${point}: exactly one accepted commit`);
    assert.equal((await fresh.e2ee.status()).groups[gid].epoch, before + 1, `${point}: merged exactly once`);
  }
  // Still one history: bob follows every commit and reads what alice sends.
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "after the restarts" });
  await until(() => bob.s.bob.got.length === 2, "the message after the restarts");
  const ca = await alice.s.alice.e2ee.checkpoint(bob.id);
  const cb = await bob.s.bob.e2ee.checkpoint(alice.id);
  assert.deepEqual([ca.epoch, ca.authenticator], [cb.epoch, cb.authenticator]);
  assert.equal(ca.digits, cb.digits);
});

test("MI2 conflict: concurrent commits, one accepted; the loser clears its pending commit and processes the winner", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "one" });
  await until(() => bob.s.bob.got.length === 1, "first");
  const [ra, rb] = await Promise.all([alice.s.alice.e2ee.update(bob.id), bob.s.bob.e2ee.update(alice.id)]);
  const phases = [ra.phase, rb.phase].sort();
  assert.deepEqual(phases, ["cleared", "merged"]);
  const loser = ra.phase === "cleared" ? ra : rb;
  assert.equal(loser.result.state, "conflict");
  await until(async () => {
    const [x, y] = [await alice.s.alice.e2ee.checkpoint(bob.id), await bob.s.bob.e2ee.checkpoint(alice.id)];
    return x.epoch === 2 && y.epoch === 2 && x.authenticator === y.authenticator;
  }, "both at the winner's epoch with one history");
  await bob.s.bob.e2ee.send({ to: { member: alice.id, session: "alice" }, body: "still talking" });
  await until(() => alice.s.alice.got.length === 1, "after the conflict");
});

test("a roster delta that disagrees with the authenticated commit is refused by every device and recovered by replacement", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  const bob2 = await device(t, w, "bob", { sessions: ["bob-laptop"] });
  await acceptOwnDevices(bob, bob2);
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "one" });
  await until(() => bob.s.bob.got.length === 1, "first");
  // A relay that lies about the delta (it claims bob's laptop was removed) to both bob devices.
  for (const s of [bob.s.bob, bob2.s["bob-laptop"]]) {
    const [listener] = s.client.listeners("message_e2ee");
    s.client.removeAllListeners("message_e2ee");
    s.client.on("message_e2ee", (frame, ack) => listener(frame.kind === "commit" ? { ...frame, log: { ...frame.log, roster_delta: { add: [], remove: [bob2.device] } } } : frame, ack));
  }
  await alice.s.alice.e2ee.update(bob.id);
  await until(() => w.db.get("SELECT count(*) AS n FROM e2ee_invalid").n === 2, "both devices report commit_invalid");
  for (const s of [bob.s.bob, bob2.s["bob-laptop"]]) {
    const st = await s.e2ee.status();
    assert.ok(Object.values(st.groups).some((g) => g.state === "broken"));
    assert.match(st.notices.at(-1).text, /refused \(the roster delta's removals disagree/);
  }
  // bob's next message recovers the conversation with a replacement group (generation 2).
  const r = await bob.s.bob.e2ee.send({ to: { member: alice.id, session: "alice" }, body: "on the new group" });
  assert.equal(r.state, "accepted");
  await until(() => alice.s.alice.got.length === 1, "alice reads it in the replacement");
  const cur = await bob.s.bob.client.rpc({ type: "conversation", peer: alice.id });
  assert.equal(cur.generation, 2);
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob-laptop" }, body: "to the laptop" });
  await until(() => bob2.s["bob-laptop"].got.length === 1, "the laptop joined the replacement too");
});

test("MI3: an unacknowledged delivery, a replacement and a resend: delivered once; created and expires preserved", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "warm-up" });
  await until(() => bob.s.bob.got.length === 1, "warm-up");
  bob.s.bob.client.close();
  await settle();
  const sent = capture(alice.s.alice.client, (f) => f.type === "send_e2ee" && f.kind === "app");
  const m = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "exactly once" });
  w.clock.advance(3600_000);
  const rep = await alice.s.alice.e2ee.replace(bob.id);
  assert.equal(rep.generation, 2);
  // Every message sent into the replaced group is sealed again (the sender cannot know which
  // were delivered): the warm-up and this one; the receiver's replay records sort them out.
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.slice(1).map((f) => f.group === sent[0].group), [false, false]);
  const again = await bob.open("bob");
  await until(() => again.got.length >= 1, "the delivery");
  await settle(300);
  assert.equal(again.got.length, 1, "delivered to the session once");
  assert.equal(again.got[0].message_id, m.message_id);
  assert.equal(w.ds.usage({ member: bob.id, device: bob.device }).messages, 0, "both copies acknowledged");
  assert.equal(again.got[0].ts, w.clock.now() - 3600_000, "created is the original's, not the resend's");
});

test("MI3 window: a resend admitted at T0+6 days that arrives at T0+8 days, after the record expired, is refused; the exact boundary", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  const T0 = w.clock.now();
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "a week" });
  await until(() => bob.s.bob.got.length === 1, "delivered at T0");
  bob.s.bob.client.close();
  await settle();
  w.clock.set(T0 + 6 * DAY);
  await alice.s.alice.e2ee.replace(bob.id);
  w.clock.set(T0 + 8 * DAY);
  const again = await bob.open("bob");
  await until(() => w.ds.usage({ member: bob.id, device: bob.device }).messages === 0, "the resend acknowledged (as refused)");
  assert.equal(again.got.length, 0, "refused by the expiry check, not delivered again");
  assert.equal((await again.e2ee.status()).replay, 0, "the replay record expired");
  // The exact boundary: at expires + 5 min a record is gone and a copy is refused.
  const b2 = await device(t, w, "carol");
  const T1 = w.clock.now();
  await b2.s.carol.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "boundary", lifetimeMs: 60_000 });
  await until(() => again.got.length === 1, "delivered");
  again.client.close();
  await settle();
  w.clock.set(T1 + 60_000 + 5 * 60_000);
  await b2.s.carol.e2ee.replace(bob.id);
  const third = await bob.open("bob");
  await until(() => w.ds.usage({ member: bob.id, device: bob.device }).messages === 0, "the copy at the boundary");
  assert.equal(third.got.length, 0);
  assert.equal((await third.e2ee.status()).replay, 0);
});

test("MI3 capacity: at the record cap an unseen message id is refused with quota (left at the relay); a known id is acknowledged", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob", { capacity: 1 });
  const m1 = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "one" });
  await until(() => bob.s.bob.got.length === 1, "first");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "two" });
  await until(() => bob.s.bob.e2ee.deferredCount() === 1, "the second waits (backpressure)");
  assert.equal(bob.s.bob.got.length, 1);
  assert.equal(w.ds.usage({ member: bob.id, device: bob.device }).messages, 1, "not acknowledged: still at the relay");
  // A known id (the first, sealed again) is acknowledged without a new record.
  await alice.s.alice.e2ee.resend(m1.message_id);
  await until(() => w.ds.usage({ member: bob.id, device: bob.device }).messages === 1 && bob.s.bob.got.length === 1, "the known id acknowledged");
  await settle(200);
  assert.equal(bob.s.bob.got.length, 1);
});

test("MI5 at the device: a tampered application message first, the valid one next (delivered, state otherwise unchanged)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob", { sessions: ["bob", "bob-other"] });
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "warm-up" });
  await until(() => bob.s.bob.got.length === 1, "warm-up");
  bob.s.bob.client.close();
  await settle();
  const sent = capture(alice.s.alice.client, (f) => f.type === "send_e2ee" && f.kind === "app");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "the valid one" });
  const genuine = appFrame(w, sent[0], alice, bob);
  const bytes = Buffer.from(genuine.mls, "base64");
  bytes[bytes.length - 3] ^= 1;
  // An engine of the "bob" session on bob's device (its own connection is closed).
  const e = createE2ee({ store: bob.store, driver: bob.driver, client: bob.s["bob-other"].client, session: "bob", home: bob.dir, profile: "relay-test", contacts: bob.contacts, deliver: async (m) => void got.push(m), now: w.clock.now });
  const got = [];
  assert.equal(await e.receive({ ...genuine, delivery: `e_${"1".repeat(32)}`, mls: bytes.toString("base64") }, () => {}), "refused");
  assert.equal(await e.receive({ ...genuine, delivery: `e_${"2".repeat(32)}`, mls: "AAAA" }, () => {}), "refused", "malformed content");
  assert.equal(await e.receive(genuine, () => {}), "delivered");
  assert.equal(got[0].text, "the valid one");
  // The relay's own copy of it later: a known id, acknowledged, not delivered again.
  const again = await bob.open("bob");
  await until(() => w.ds.usage({ member: bob.id, device: bob.device }).messages === 0, "acknowledged");
  assert.equal(again.got.length, 0);
});

test("MI6 forks: equal device pins with distinct same-epoch histories are detected through checkpoints; recovery replaces", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "one" });
  await until(() => bob.s.bob.got.length === 1, "first");
  const ca = await alice.s.alice.e2ee.checkpoint(bob.id);
  assert.equal(await bob.s.bob.e2ee.compareCheckpoint(alice.id, ca), "match");
  // A partition: bob's device state (same device, same pins) takes another commit at the same
  // epoch than the one alice's side sees.
  await bob.store.transact(async (ctx) => {
    const g = ctx.dev.group(Buffer.from(ca.group, "hex"));
    await g.commit({ update: true });
    await g.mergePending();
    await ctx.save();
  });
  await alice.s.alice.e2ee.update(bob.id).catch(() => {});
  const cb = await bob.s.bob.e2ee.checkpoint(alice.id);
  const ca2 = await alice.s.alice.e2ee.checkpoint(bob.id);
  assert.equal(cb.epoch, ca2.epoch);
  assert.notEqual(cb.authenticator, ca2.authenticator);
  assert.notEqual(cb.digits, ca2.digits, "the owners see different numbers");
  assert.equal(await alice.s.alice.e2ee.compareCheckpoint(bob.id, cb), "fork");
  assert.match((await alice.s.alice.e2ee.status()).notices.at(-1).text, /fork detected/);
  // Recovery: the next send replaces the group.
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "after the fork" });
  await until(() => bob.s.bob.got.some((m) => m.text === "after the fork"), "the replacement");
  assert.equal((await alice.s.alice.client.rpc({ type: "conversation", peer: bob.id })).generation, 2);
});

test("holds: a new device of a pinned contact holds sending until the owner accepts it; a revoked device is removed before anything is sent", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const contacts = memoryContacts();
  const alice = await device(t, w, "alice", { contacts });
  const bob = await device(t, w, "bob");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "pinned on first use" });
  await until(() => bob.s.bob.got.length === 1, "first");
  assert.equal(contacts.doc.pins.find((p) => p.member === bob.id).how, "relay-tofu");
  const bob2 = await device(t, w, "bob", { sessions: ["bob-laptop"] });
  await acceptOwnDevices(bob, bob2);
  const held = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "waits for a decision" });
  assert.equal(held.state, "held");
  await settle();
  assert.equal(bob.s.bob.got.length, 1, "nothing sent while held");
  // The owner accepts the new device: the held message goes out, and the group now holds it.
  const listed = await alice.s.alice.client.rpc({ type: "device_list", member: bob.id });
  decide(contacts.doc, w.realm, bob.id, evaluate(contacts.doc, w.realm, bob.id, listed.devices), { accept: "all" });
  assert.equal(await alice.s.alice.e2ee.releaseHeld(bob.id), 1);
  await until(() => bob.s.bob.got.length === 2, "released exactly once");
  const gid = (await alice.s.alice.e2ee.checkpoint(bob.id)).group;
  assert.ok(w.ds.roster(gid).some((d) => d.device === bob2.device));
  // bob revokes the laptop from his first device (a signed statement): alice removes it before
  // sending, and holds the message while the removal's answer is lost.
  await bob.store.revoke(await w.client("bob"), bob2.device).catch((e) => {
    if (e.code !== "unsupported") throw e;
  });
  loseAnswer(alice.s.alice.client, (f) => f.type === "send_e2ee" && f.kind === "commit");
  const r = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "after the revocation" });
  assert.equal(r.state, "unsent");
  await settle();
  if (bob.s.bob.got.length === 2) {
    assert.deepEqual(pinOf(contacts.doc, w.realm, bob.id).revoked?.map((r) => r.device), [bob2.device], "the trusted revocation is kept in the pins");
  } else {
    // A merged removal makes bob owe an update (A2): his commit can show alice her own removal in
    // the log before recover(), and she then sends; never before the removal was merged.
    assert.ok(!w.ds.roster(gid).some((d) => d.device === bob2.device), "sent only after the removal was merged");
  }
  await alice.s.alice.e2ee.recover();
  await until(() => bob.s.bob.got.length === 3, "sent after the merge");
  assert.ok(!w.ds.roster(gid).some((d) => d.device === bob2.device), "the revoked device left the routing roster");
  assert.equal(pinOf(contacts.doc, w.realm, bob.id).revoked, undefined, "cleared after the accepted removal");
});

const CRASH = new URL("./fixtures/e2ee-crash.mjs", import.meta.url).pathname;
/** Run the crash fixture; resolves once it died by SIGKILL (rejects if it survived). */
function crashChild(w, member, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CRASH, w.url, ...args], { timeout: 20_000, env: { ...process.env, HOPTELL_TEST_TOKEN: w.members[member].token } }, (err, stdout, stderr) => (err?.signal === "SIGKILL" ? resolve() : reject(new Error(`the fixture did not die: ${stdout}${stderr}${err?.message ?? ""}`))));
  });
}
const deliveredFile = (d) => path.join(d.dir, "delivered.jsonl");
const deliveriesOf = (d, extra = []) => {
  const lines = fs.existsSync(deliveredFile(d)) ? fs.readFileSync(deliveredFile(d), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return [...lines, ...extra];
};

test("crash windows (SIGKILL) at every receive point: delivered exactly once into the pipeline (deduplicated by delivery id)", async (t) => {
  // welcome-after-persist: the first message's Welcome joined and persisted, not yet acknowledged.
  for (const point of ["welcome-after-persist", "receive-after-persist", "receive-after-deliver"]) {
    const w = await deviceRelay(t, { e2ee: true });
    const alice = await device(t, w, "alice");
    const bob = await device(t, w, "bob", { sessions: [] });
    await bob.open("bob-warm");
    bob.s["bob-warm"].client.close();
    const child = crashChild(w, "bob", [bob.dir, "bob", point, "receive"]);
    await settle(1500); // the child attached
    await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: `through ${point}` });
    await child;
    // The restarted device: the relay delivers it again; the record decides, nothing decrypts twice.
    const again = await bob.open("bob");
    await until(() => w.ds.usage({ member: bob.id, device: bob.device }).messages === 0, `acknowledged after ${point}`);
    const all = deliveriesOf(bob, again.got.map((m) => ({ id: m.id, message_id: m.message_id, text: m.text })));
    assert.ok(all.length >= 1, point);
    assert.equal(new Set(all.map((m) => m.id)).size, 1, `${point}: one delivery id (the pipeline stores it once)`);
    assert.equal(all[0].text, `through ${point}`);
    if (point !== "receive-after-deliver") assert.equal(all.length, 1, "nothing reached the pipeline before the crash");
  }
});

test("crash windows (SIGKILL) at every send and commit point: the message is sent once, the group created once", async (t) => {
  for (const point of ["commit-after-persist", "commit-after-answer", "commit-after-merge", "send-after-persist", "send-after-publish"]) {
    const w = await deviceRelay(t, { e2ee: true });
    const alice = await device(t, w, "alice", { sessions: [] });
    const bob = await device(t, w, "bob");
    await crashChild(w, "alice", [alice.dir, "alice", point, "send", bob.id, "bob", `through ${point}`]);
    const again = await alice.open("alice");
    await again.e2ee.recover();
    await until(() => bob.s.bob.got.length >= 1, `delivered after ${point}`);
    await settle(300);
    assert.equal(bob.s.bob.got.length, 1, `${point}: once`);
    assert.equal(bob.s.bob.got[0].text, `through ${point}`);
    assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_groups").n, 1, `${point}: one group`);
    assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app'").n, 1, `${point}: one accepted send`);
  }
});

const WASM = process.env.HOPTELL_MLS_WASM || path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm", "pkg", "openmls_wasm.js");
const noWasm = fs.existsSync(WASM) ? false : `the OpenMLS WASM binding is not built (${WASM})`;

test("OpenMLS end to end: create, Welcome, messages both ways, an update commit, a replacement and a resend", { skip: noWasm }, async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice", { driver: createOpenMlsDriver(WASM) });
  const bob = await device(t, w, "bob", { driver: createOpenMlsDriver(WASM) });
  const r = await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "over OpenMLS" });
  assert.equal(r.state, "accepted");
  await until(() => bob.s.bob.got.length === 1, "bob reads it");
  assert.equal(bob.s.bob.got[0].text, "over OpenMLS");
  await bob.s.bob.e2ee.send({ to: { member: alice.id, session: "alice" }, body: "back", replyTo: r.message_id });
  await until(() => alice.s.alice.got.length === 1, "alice reads the reply");
  assert.equal((await bob.s.bob.e2ee.update(alice.id)).phase, "merged");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "after the update" });
  await until(() => bob.s.bob.got.length === 2, "after the update");
  const [ca, cb] = [await alice.s.alice.e2ee.checkpoint(bob.id), await bob.s.bob.e2ee.checkpoint(alice.id)];
  assert.deepEqual([ca.epoch, ca.authenticator], [cb.epoch, cb.authenticator]);
  assert.equal((await alice.s.alice.e2ee.replace(bob.id)).generation, 2);
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "in generation 2" });
  await until(() => bob.s.bob.got.some((m) => m.text === "in generation 2"), "the replacement");
  await settle(300);
  assert.equal(new Set(bob.s.bob.got.map((m) => m.message_id)).size, bob.s.bob.got.length, "resent messages are not delivered twice");
});

test("a planned rotation is refused while the device has encrypted conversations (it would replace the whole library state)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "one" });
  await until(() => bob.s.bob.got.length === 1, "first");
  await assert.rejects(alice.store.rotate(await w.client("alice")), (e) => e.code === "rotation_unsupported");
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "the group still works" });
  await until(() => bob.s.bob.got.length === 2, "second");
});

// ---- review fixes (MII1-MII3, MII6, MII10) -------------------------------------------------------

const noop = () => {};
/** Another e2ee engine of device `d` for `session`, not attached (its frames are handed in by the test). */
async function manual(w, d, session = d.member, opts = {}) {
  const client = opts.client ?? (await w.client(d.member));
  // A9: the device proves its key on a command-style (send-mode) connection before it acts there;
  // a session's connection attaches through e2ee.attach() when the test says so.
  client.proveWith = d.store;
  if (client.mode === "send") await d.store.attach(client);
  const got = [];
  const e2ee = createE2ee({ store: d.store, driver: d.driver, client, session, home: d.dir, profile: "relay-test", contacts: d.contacts, deliver: async (m) => void got.push(m), now: w.clock.now, ...opts });
  return { client, e2ee, got };
}
/** alice and bob with a conversation (one message delivered); bob's session then goes offline. */
async function initial(t, { bobContacts = null } = {}) {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice");
  const b = await device(t, w, "bob", bobContacts ? { contacts: bobContacts } : {});
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" });
  await until(() => b.s.bob.got.length === 1, "initial");
  b.s.bob.client.close();
  await settle(30);
  return { w, a, b };
}
/** `a`'s owner accepts `extra`, a new device of contact `b` (hoptell contacts accept-device). */
async function acceptPeerDevice(a, b, extra) {
  const listed = await a.s.alice.client.rpc({ type: "device_list", member: b.id });
  await a.contacts.updatePins((d) => decide(d, listed.realm, b.id, evaluate(d, listed.realm, b.id, listed.devices), { accept: [extra.device] }));
}
const nextApp = (w, b) => w.ds.pending({ member: b.id, device: b.device, limit: 100 }).find((f) => f.kind === "app");

test("MII1: a decrypted record kept after a crash is revalidated before delivery: target session, acceptance window", async (t) => {
  const { w, a, b } = await initial(t);
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "only for bob, brief lifetime", lifetimeMs: 1000 });
  const frame = nextApp(w, b);
  const crashed = await manual(w, b, "bob", { fault: (p) => { if (p === "receive-after-persist") throw new Error("crash after persistence"); } });
  assert.equal(await crashed.e2ee.receive(frame, noop), "later");
  assert.equal(crashed.got.length, 0);
  // Another session of the device never gets it, whatever the outer target says.
  const other = await manual(w, b, "bob-other");
  assert.equal(await other.e2ee.receive({ ...frame, target: "bob-other" }, noop), "not_mine");
  assert.equal(other.got.length, 0);
  // Its own session, once it expired: refused (acknowledged), never delivered.
  w.clock.advance(1000 + 5 * 60_000 + 1);
  const late = await manual(w, b, "bob");
  let acked = null;
  assert.equal(await late.e2ee.receive(frame, (o) => (acked = o)), "refused");
  assert.equal(acked, "refused");
  assert.equal(late.got.length, 0);
  assert.equal(await late.e2ee.receive(frame, noop), "delivered", "a repeat is only acknowledged");
  assert.equal(late.got.length, 0);
});

test("MII1: a kept record is held when its sender now needs a decision (the hold is evaluated again)", async (t) => {
  const contacts = memoryContacts();
  const { w, a, b } = await initial(t, { bobContacts: contacts });
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "kept, then held" });
  const frame = nextApp(w, b);
  const crashed = await manual(w, b, "bob", { fault: (p) => { if (p === "receive-after-persist") throw new Error("crash"); } });
  assert.equal(await crashed.e2ee.receive(frame, noop), "later");
  contacts.doc.requireVerified = [w.realm];
  const again = await manual(w, b, "bob");
  assert.equal(await again.e2ee.receive(frame, noop), "delivered");
  assert.equal(again.got.length, 0, "held, not delivered");
  assert.match((await again.e2ee.status()).held, /1 message/);
});

test("MII1: a kept record held before a crash is delivered on the first retry once the owner verified the sender (the current hold decides)", async (t) => {
  const contacts = memoryContacts();
  const { w, a, b } = await initial(t, { bobContacts: contacts });
  await contacts.updatePins((doc) => { doc.requireVerified = [w.realm]; });
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "verified before the retry" });
  const frame = nextApp(w, b);
  const crashed = await manual(w, b, "bob", { fault: (p) => { if (p === "receive-after-persist") throw new Error("crash before the hold queue"); } });
  assert.equal(await crashed.e2ee.receive(frame, noop), "later");
  const served = await a.s.alice.client.rpc({ type: "device_list", member: a.id });
  await contacts.updatePins((doc) => decide(doc, w.realm, a.id, evaluate(doc, w.realm, a.id, served.devices), { how: "in-person" }));
  assert.equal(evaluate(contacts.doc, w.realm, a.id, served.devices).holdIn, null);
  const again = await manual(w, b, "bob");
  assert.equal(await again.e2ee.receive(frame, noop), "delivered");
  assert.deepEqual(again.got.map((m) => m.text), ["verified before the retry"], "delivered, not held by the hold recorded before the crash");
  assert.equal((await again.e2ee.status()).held, null);
});

test("MII6: a trust decision that cannot be made defers the receipt (never delivered unchecked); the generation stays available", async (t) => {
  const contacts = memoryContacts();
  const { w, a, b } = await initial(t, { bobContacts: contacts });
  const down = (r) => {
    const rpc = r.client.rpc.bind(r.client);
    let off = true;
    r.client.rpc = (f) => (off && f.type === "device_list" ? Promise.reject(Object.assign(new Error("directory unavailable"), { code: "unavailable" })) : rpc(f));
    return () => (off = false);
  };
  // requireVerified, relay-tofu pin: the message must wait for the owner.
  contacts.doc.requireVerified = [w.realm];
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "unverified must wait" });
  const frame = nextApp(w, b);
  const receiver = await manual(w, b, "bob");
  const up = down(receiver);
  assert.equal(await receiver.e2ee.receive(frame, noop), "later");
  assert.equal(receiver.got.length, 0);
  up();
  assert.equal(await receiver.e2ee.receive(frame, noop), "delivered");
  assert.equal(receiver.got.length, 0, "held for the owner's decision");
  // Without the policy: deferred while the directory is down, delivered once it answers (the
  // valid message's generation was not consumed by the deferred attempt).
  delete contacts.doc.requireVerified;
  w.ds.ack({ member: b.id, device: b.device, delivery: frame.delivery });
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after the outage" });
  const second = nextApp(w, b);
  const r2 = await manual(w, b, "bob");
  const up2 = down(r2);
  assert.equal(await r2.e2ee.receive(second, noop), "later");
  up2();
  assert.equal(await r2.e2ee.receive(second, noop), "delivered");
  assert.deepEqual(r2.got.map((m) => m.text), ["after the outage"]);
});

test("MII3: a sealed, unpublished outbox entry is sent by recovery only through the current trust decision (requireVerified now holds it)", async (t) => {
  const contacts = memoryContacts();
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice", { contacts });
  const b = await device(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" });
  await until(() => b.s.bob.got.length === 1, "initial");
  const writer = await manual(w, a, "alice", { fault: (p) => { if (p === "send-after-persist") throw new Error("crash after encrypt"); } });
  await assert.rejects(writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "must wait for verification" }), /crash after encrypt/);
  contacts.doc.requireVerified = [w.realm];
  const fresh = await manual(w, a, "alice");
  await fresh.e2ee.recover();
  await settle(100);
  assert.equal(b.s.bob.got.length, 1, "not published");
  assert.match((await fresh.e2ee.status()).held, /1 message/);
  assert.equal((await fresh.e2ee.status()).outbox, 0, "the stale ciphertext is gone");
  // Verified: the same logical message (same id, created, expires) goes out.
  const listed = await a.s.alice.client.rpc({ type: "device_list", member: b.id });
  decide(contacts.doc, w.realm, b.id, evaluate(contacts.doc, w.realm, b.id, listed.devices), { accept: "all", how: "in-person" });
  await fresh.e2ee.recover();
  await until(() => b.s.bob.got.length === 2, "sent once verified");
  assert.equal(b.s.bob.got[1].text, "must wait for verification");
});

test("MII3: a sealed outbox entry never reaches a device whose trusted revocation was observed: removal first, sealed again", async (t) => {
  const contacts = memoryContacts();
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice", { contacts });
  const b = await device(t, w, "bob");
  const b2 = await device(t, w, "bob", { sessions: ["bob-laptop"] });
  await acceptOwnDevices(b, b2);
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" });
  await until(() => b.s.bob.got.length === 1, "initial");
  const writer = await manual(w, a, "alice", { fault: (p) => { if (p === "send-after-persist") throw new Error("crash before publishing"); } });
  await assert.rejects(writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "must not reach the revoked device" }), /crash before publishing/);
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  await b.store.revoke(b.s.bob.client, b2.device);
  const fresh = await manual(w, a, "alice");
  await fresh.e2ee.recover();
  assert.ok(!w.ds.roster(gid).some((d) => d.device === b2.device), "the removal was committed first");
  assert.equal(w.ds.pending({ member: b.id, device: b2.device }).filter((f) => f.kind === "app").length, 1, "only the initial message reached the revoked device");
  await until(() => b.s.bob.got.length === 2, "sent after the removal");
  const [first, again] = [b.s.bob.got[0], b.s.bob.got[1]];
  assert.equal(again.text, "must not reach the revoked device");
  assert.ok(again.ts >= first.ts);
});

test("MII3: an entry that may have been published is reconciled by its op id (accepted before: not sent again; never accepted: through the gate)", async (t) => {
  const contacts = memoryContacts();
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice", { contacts });
  const b = await device(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" });
  await until(() => b.s.bob.got.length === 1, "initial");
  // Accepted by the relay, its answer lost: recovery learns the result and publishes nothing new.
  loseAnswer(a.s.alice.client, (f) => f.type === "send_e2ee" && f.kind === "app");
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "accepted, answer lost" })).state, "unsent");
  const before = w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app'").n;
  contacts.doc.requireVerified = [w.realm];
  const r = await a.s.alice.e2ee.recover();
  assert.equal(r.messages, 1);
  assert.equal((await a.s.alice.e2ee.status()).outbox, 0);
  assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app'").n, before, "no new publication");
  await until(() => b.s.bob.got.length === 2, "the accepted one arrives");
  // Never reached the relay (lost on the way): under requireVerified it is held, not published.
  const rpc = a.s.alice.client.rpc.bind(a.s.alice.client);
  let drop = true;
  a.s.alice.client.rpc = (f) => (drop && f.type === "send_e2ee" && f.kind === "app" ? ((drop = false), Promise.reject(Object.assign(new Error("lost"), { kind: "no_answer" }))) : rpc(f));
  delete contacts.doc.requireVerified;
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "lost on the way" })).state, "unsent");
  contacts.doc.requireVerified = [w.realm];
  await a.s.alice.e2ee.recover();
  await settle(100);
  assert.equal(b.s.bob.got.length, 2, "held, not published");
  assert.match((await a.s.alice.e2ee.status()).held, /1 message/);
});

test("MII3: a published entry whose request is still in flight is cancelled by recovery; the delayed original is refused, the message stays held", async (t) => {
  const contacts = memoryContacts();
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice", { contacts });
  const b = await device(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" });
  await until(() => b.s.bob.got.length === 1, "initial");
  // The request leaves, its answer is lost, and the request itself is held up on the way.
  const writer = await manual(w, a, "alice");
  const rpc = writer.client.rpc.bind(writer.client);
  let delayed = null;
  writer.client.rpc = (f) => {
    if (f.type === "send_e2ee" && f.kind === "app" && !f.reconcile) {
      delayed = structuredClone(f);
      return Promise.reject(Object.assign(new Error("the answer was lost while the request was in flight"), { kind: "no_answer" }));
    }
    return rpc(f);
  };
  assert.equal((await writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "must wait under the current policy" })).state, "unsent");
  await contacts.updatePins((doc) => { doc.requireVerified = [w.realm]; });
  const fresh = await manual(w, a, "alice");
  await fresh.e2ee.recover();
  assert.match((await fresh.e2ee.status()).held, /1 message/, "sealed again through the current gate: held");
  assert.equal((await fresh.e2ee.status()).outbox, 0);
  // The original request arrives after the recovery: refused, nothing reaches bob.
  assert.equal((await refusal(rpc(delayed))).code, "op_cancelled");
  await settle(100);
  assert.equal(b.s.bob.got.length, 1);
  assert.match((await fresh.e2ee.status()).held, /1 message/);
});

test("MII10: after hoptell contacts verify, the held messages it promises go out on the sender's next run (recovery), once", async (t) => {
  const contacts = memoryContacts();
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice", { contacts });
  const b = await device(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" });
  await until(() => b.s.bob.got.length === 1, "initial");
  contacts.doc.requireVerified = [w.realm];
  const held = await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "waiting for verification" });
  assert.equal(held.state, "held");
  const opts = { sub: "verify", member: b.id, home: a.dir, profile: "relay-test", connect: () => w.client("alice"), contacts };
  const shown = [];
  await verifyCommand({ ...opts, say: (x) => shown.push(x) });
  const code = /--set ([0-9a-f]{32})/.exec(shown.at(-1))[1];
  const said = [];
  await verifyCommand({ ...opts, yes: true, how: "in-person", set: code, say: (x) => said.push(x) });
  assert.match(said.join("\n"), /released when the sender next runs/);
  const r = await a.s.alice.e2ee.recover();
  assert.equal(r.released, 1);
  await until(() => b.s.bob.got.length === 2, "released");
  assert.equal(b.s.bob.got[1].text, "waiting for verification");
  assert.equal((await a.s.alice.e2ee.status()).held, null);
  await a.s.alice.e2ee.recover();
  await settle(100);
  assert.equal(b.s.bob.got.length, 2, "once");
});

test("MII10: incoming held messages are released only to their target session, within their window, after the owner's decision (a policy change is noticed)", async (t) => {
  const contacts = memoryContacts();
  const { w, a, b } = await initial(t, { bobContacts: contacts });
  contacts.doc.requireVerified = [w.realm];
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "held for bob" });
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "held, expires", lifetimeMs: 1000 });
  const mine = await manual(w, b, "bob");
  for (const f of w.ds.pending({ member: b.id, device: b.device }).filter((x) => x.kind === "app")) assert.equal(await mine.e2ee.receive(f, noop), "delivered");
  assert.equal(mine.got.length, 0);
  assert.match((await mine.e2ee.status()).held, /2 messages/);
  w.clock.advance(1000 + 5 * 60_000 + 1); // the second one is past its acceptance window now
  // The owner verifies alice (a new policy revision).
  const listed = await mine.client.rpc({ type: "device_list", member: a.id });
  await contacts.updatePins((d) => decide(d, w.realm, a.id, evaluate(d, w.realm, a.id, listed.devices), { accept: "all", how: "in-person" }));
  // Another session of the device reassesses first: nothing is drained into it.
  const other = await manual(w, b, "bob-other");
  await other.e2ee.recover();
  assert.equal(other.got.length, 0);
  assert.match((await other.e2ee.status()).held, /1 message/, "the expired one is dropped, bob's stays held for bob");
  // bob's session notices the policy change on its next frame and receives its message once.
  await mine.e2ee.receive({ kind: "unknown", delivery: "e_x" }, noop);
  assert.deepEqual(mine.got.map((m) => m.text), ["held for bob"]);
  await mine.e2ee.recover();
  assert.equal(mine.got.length, 1);
  assert.equal((await mine.e2ee.status()).held, null);
});

test("MII2: a commit adding a device the owner has not accepted waits (not merged, its messages not delivered) until the owner accepts it", async (t) => {
  const contacts = memoryContacts();
  const { w, a, b } = await initial(t, { bobContacts: contacts });
  const extra = await device(t, w, "alice", { sessions: [] });
  await acceptOwnDevices(a, extra); // alice's owner accepted it on both of her devices; bob has not
  assert.equal(pinOf(contacts.doc, w.realm, a.id).devices.length, 1);
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  // alice's device adds her new device itself (bypassing her own gate, as a modified client could).
  const taken = await a.s.alice.client.rpc({ type: "kp_take", request: "mii2-add-unaccepted", device: a.device, target: { member: a.id, device: extra.device } });
  await a.store.transact(async (ctx) => {
    const g = ctx.dev.group(Buffer.from(gid, "hex"));
    const out = await g.commit({ add: [Buffer.from(taken.kp, "base64")] });
    await a.s.alice.client.rpc({ type: "send_e2ee", kind: "commit", op: newOpId(), device: a.device, group: gid, expected_epoch: g.epoch(), mls: Buffer.from(out.commit).toString("base64"), roster_delta: { add: [extra.device], remove: [] }, welcome: { recipients: [extra.device], mls: Buffer.from(out.welcome).toString("base64"), ratchet_tree: Buffer.from(out.ratchetTree).toString("base64") }, kp_reservations: [taken.reservation] });
    await g.mergePending();
    await ctx.save();
  });
  const recv = await manual(w, b, "bob");
  const commit = w.ds.pending({ member: b.id, device: b.device }).find((f) => f.kind === "commit");
  assert.equal(await recv.e2ee.receive(commit, noop), "later", "deferred while the owner's decision is pending");
  assert.ok(!(await recv.e2ee.status()).groups[gid] || (await recv.e2ee.checkpoint(a.id)).epoch === 1, "not merged");
  const newcomer = await manual(w, extra, "alice-new");
  const welcome = w.ds.pending({ member: extra.id, device: extra.device }).find((f) => f.kind === "welcome");
  assert.equal(await newcomer.e2ee.receive(welcome, noop), "delivered");
  assert.equal((await newcomer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "from the new device" })).state, "accepted");
  const frame = nextApp(w, b);
  assert.equal(await recv.e2ee.receive(frame, noop), "later");
  assert.equal(recv.got.length, 0, "nothing from a device the owner has not accepted");
  // The owner accepts it: the commit merges and the message is delivered.
  const listed = await recv.client.rpc({ type: "device_list", member: a.id });
  await contacts.updatePins((d) => decide(d, w.realm, a.id, evaluate(d, w.realm, a.id, listed.devices), { accept: [extra.device] }));
  assert.equal(await recv.e2ee.receive(commit, noop), "delivered");
  assert.equal(await recv.e2ee.receive(frame, noop), "delivered");
  assert.deepEqual(recv.got.map((m) => [m.text, m.e2ee.device]), [["from the new device", extra.device]]);
});

test("MII11: while a commit adding an own device waits for the owner, nothing is sealed in the old epoch; once accepted the message goes out", async (t) => {
  const contacts = memoryContacts();
  const { w, a, b } = await initial(t, { bobContacts: contacts });
  const extra = await device(t, w, "bob", { sessions: [] });
  await acceptPeerDevice(a, b, extra);
  // alice's next message adds bob's new device; bob's owner has not accepted it yet.
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "adds bob's new device" });
  const commit = w.ds.pending({ member: b.id, device: b.device }).find((f) => f.kind === "commit");
  const old = await manual(w, b, "bob");
  assert.equal(await old.e2ee.receive(commit, noop), "later");
  assert.equal((await old.e2ee.checkpoint(a.id)).epoch, 1);
  assert.equal(w.ds.conversation({ member: b.id, peer: a.id }).epoch, 2);
  const sent = await old.e2ee.send({ to: { member: a.id, session: "alice" }, body: "sent while the own device's admission waits" });
  assert.equal(sent.state, "held", "kept until the group is usable at the relay's epoch");
  assert.equal((await old.e2ee.checkpoint(a.id)).epoch, 1);
  assert.equal(w.ds.pending({ member: a.id, device: a.device }).filter((f) => f.kind === "app").length, 0, "nothing sealed in the old epoch");
  // The owner accepts the device (an own device: hoptell device accept, A1): the commit merges and
  // the message is sealed at the current epoch.
  await acceptOwnDevices(b, extra);
  assert.equal(await old.e2ee.receive(commit, noop), "delivered");
  await until(() => a.s.alice.got.length === 1, "the held message after the admission");
  assert.equal(a.s.alice.got[0].text, "sent while the own device's admission waits");
  assert.equal((await old.e2ee.checkpoint(a.id)).epoch, 2);
});

test("MII11 OpenMLS: an own-device admission deferred past the peer's epoch retention never yields an accepted, undecryptable send", { skip: noWasm }, async (t) => {
  const contacts = memoryContacts();
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice", { driver: createOpenMlsDriver(WASM, { testOnlySuite: 77 }) });
  const b = await device(t, w, "bob", { contacts, driver: createOpenMlsDriver(WASM, { testOnlySuite: 77 }) });
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" });
  await until(() => b.s.bob.got.length === 1, "initial");
  b.s.bob.client.close();
  await settle(30);
  const extra = await device(t, w, "bob", { sessions: [], driver: createOpenMlsDriver(WASM, { testOnlySuite: 77 }) });
  await acceptPeerDevice(a, b, extra);
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "adds an own device bob has not accepted" });
  const commit = w.ds.pending({ member: b.id, device: b.device }).find((f) => f.kind === "commit");
  const old = await manual(w, b, "bob");
  assert.equal(await old.e2ee.receive(commit, noop), "later");
  // alice moves on well past her retention of old epochs.
  w.clock.advance(8 * DAY);
  for (let i = 0; i < 4; i++) await a.s.alice.e2ee.update(b.id);
  assert.equal((await a.s.alice.e2ee.checkpoint(b.id)).epoch, 6);
  const sent = await old.e2ee.send({ to: { member: a.id, session: "alice" }, body: "never sealed in a pruned epoch" });
  assert.equal(sent.state, "held");
  assert.equal(w.ds.pending({ member: a.id, device: a.device }).filter((f) => f.kind === "app").length, 0, "nothing undecryptable was accepted");
  assert.equal((await old.e2ee.checkpoint(a.id)).epoch, 1);
  // Accepted (an own device: hoptell device accept, A1): the device catches up to epoch 6 and the
  // message is delivered there.
  await acceptOwnDevices(b, extra);
  assert.equal(await old.e2ee.receive(commit, noop), "delivered");
  // The receive queued the held message's send on the engine's serial queue; checkpoint() runs
  // after it, so the device's catch-up, update and send are done here, without a time bound; the
  // bound below covers alice's decryption only.
  // Epoch 7: its first send 8 days after joining updated first (the fresh-update policy, A2).
  assert.equal((await old.e2ee.checkpoint(a.id)).epoch, 7);
  await until(() => a.s.alice.got.length === 1, "the held message, decrypted");
  assert.equal(a.s.alice.got[0].text, "never sealed in a pruned epoch");
});

test("MII2: a Welcome into a group with an unaccepted device waits for the owner (the key is kept); with a trusted-revoked device it is refused", async (t) => {
  for (const kind of ["pending", "revoked"]) {
    const contacts = memoryContacts();
    const { w, a, b } = await initial(t, { bobContacts: contacts });
    const extra = await device(t, w, "alice", { sessions: [] });
    await acceptOwnDevices(a, extra); // alice's own devices, accepted by her owner (A1)
    const listed = await (await w.client("bob")).rpc({ type: "device_list", member: a.id });
    if (kind === "revoked") {
      // bob accepted the device, then observed its trusted revocation (kept, whatever the relay serves).
      decide(contacts.doc, w.realm, a.id, evaluate(contacts.doc, w.realm, a.id, listed.devices), { accept: [extra.device] });
      pinOf(contacts.doc, w.realm, a.id).revoked = [{ device: extra.device, by: a.device }];
    }
    // alice replaces the conversation's group: her other device is in the new one.
    await a.s.alice.e2ee.replace(b.id);
    const recv = await manual(w, b, "bob");
    const welcome = w.ds.pending({ member: b.id, device: b.device }).filter((f) => f.kind === "welcome").at(-1);
    assert.equal(welcome.generation, 2);
    if (kind === "revoked") {
      assert.equal(await recv.e2ee.receive(welcome, noop), "refused");
      continue;
    }
    assert.equal(await recv.e2ee.receive(welcome, noop), "later");
    assert.equal((await recv.e2ee.checkpoint(a.id)).generation, 1, "not joined");
    await contacts.updatePins((d) => decide(d, w.realm, a.id, evaluate(d, w.realm, a.id, listed.devices), { accept: [extra.device] }));
    assert.equal(await recv.e2ee.receive(welcome, noop), "delivered", "the KeyPackage was kept for the retry");
    assert.equal((await recv.e2ee.checkpoint(a.id)).generation, 2);
  }
});

test("MII8 at the device: a removed device whose older commits were coalesced away learns its removal from the relay (not a retry loop)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true, limits: { messages: 2 } });
  const a = await device(t, w, "alice");
  const b = await device(t, w, "bob");
  const b2 = await device(t, w, "bob", { sessions: [] });
  await acceptOwnDevices(b, b2);
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "initial" })).state, "accepted");
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  // Two commits (opaque to the relay); the second removes b2, whose queue is at its limit.
  const epoch = () => w.ds.conversation({ member: a.id, peer: b.id }).epoch;
  w.ds.sendCommit({ requester: { member: a.id, device: a.device }, op: newOpId(), group: gid, expectedEpoch: epoch(), mls: crypto.randomBytes(64).toString("base64"), delta: { add: [], remove: [] } });
  w.ds.sendCommit({ requester: { member: a.id, device: a.device }, op: newOpId(), group: gid, expectedEpoch: epoch(), mls: crypto.randomBytes(64).toString("base64"), delta: { add: [], remove: [b2.device] } });
  const queued = w.ds.pending({ member: b.id, device: b2.device });
  assert.deepEqual(queued.map((f) => f.kind), ["welcome", "app", "commit"], "the older commit was coalesced");
  const r = await manual(w, b2, "bob-laptop");
  assert.equal(await r.e2ee.receive(queued[0], noop), "delivered");
  assert.equal(await r.e2ee.receive(queued[2], noop), "delivered", "acknowledged, not deferred forever");
  assert.equal((await r.e2ee.status()).groups[gid].state, "removed");
});

test("a legacy-allow home (contacts not managed: no own baseline or pins can be kept) neither enrolls nor encrypts (A1)", async (t) => {
  const legacy = { currentPolicy: () => ({ doc: null, legacy: true }), updatePins: async () => Promise.reject(new Error("this home's contacts are not managed yet")) };
  const w = await deviceRelay(t, { e2ee: true });
  // Enrollment step 2 (the own baseline) cannot be written: nothing is registered with the relay.
  await assert.rejects(device(t, w, "bob", { contacts: legacy }), (e) => e.code === "no_baseline");
  assert.equal((await (await w.client("bob")).rpc({ type: "device_list" })).devices.length, 0, "the relay never heard of it");
  // A device enrolled while the contacts were managed, in a home whose contacts are now unusable:
  // its engine refuses to attach (no baseline, no encryption), never joining or sealing anything.
  const b = await device(t, w, "bob", { sessions: [] });
  const client = await w.client("bob", { session: "bob" });
  const e = createE2ee({ store: b.store, driver: b.driver, client, session: "bob", home: b.dir, profile: "relay-test", contacts: legacy, now: w.clock.now });
  t.after(() => e.close());
  await assert.rejects(e.attach(), (x) => x.code === "no_baseline");
});

/**
 * `client`'s requests of the types in `types` go over fresh connections of `member`, `every` per
 * connection (the per-connection rate limit). A9: device-scoped frames need the device proven on
 * each connection, which takes the device lock: a pool of `pool` connections is proven up front,
 * outside any engine transaction.
 */
async function spread(w, client, member, every = 15, types = null, pool = 64) {
  const rpc = client.rpc.bind(client);
  const prove = client.proveWith && (!types || types.some((x) => x !== "device_list"));
  const ready = [];
  if (prove) for (let i = 0; i < pool; i++) {
    const c = await w.client(member);
    await client.proveWith.attach(c);
    ready.push(c);
  }
  let via = null;
  let n = 0;
  client.rpc = async (f) => {
    if (types && !types.includes(f.type)) return rpc(f);
    if (!via || n++ % every === 0) {
      if (prove && !ready.length) throw new Error("spread: the pool of proven connections is used up");
      via = prove ? ready.shift() : await w.client(member);
    }
    return via.rpc(f);
  };
}

test("MII8 at the device: an offline device reaches the replacement's Welcome past 50 unreadable messages of the superseded generation, and gets all 50 again", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice");
  const b = await device(t, w, "bob", { sessions: [] }); // enrolled, never attached: generation 1's Welcome is not processed
  const writer = await manual(w, a, "alice");
  await spread(w, writer.client, "alice");
  for (let i = 0; i < 50; i++) assert.equal((await writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: `queued ${i}` })).state, "accepted");
  assert.equal((await writer.e2ee.replace(b.id)).generation, 2);
  const kinds = w.ds.pending({ member: b.id, device: b.device, limit: 200 }).map((f) => `${f.kind} ${f.generation}`);
  assert.deepEqual([kinds.length, kinds.indexOf("welcome 2"), kinds.filter((k) => k === "app 1").length], [101, 50, 50]);
  const client = await w.client("bob", { session: "bob" });
  await spread(w, client, "bob", 15, ["device_list"]);
  const recv = await manual(w, b, "bob", { client });
  // Before the device holds a newer generation, a message of a group it has not joined waits for its Welcome.
  assert.equal(await recv.e2ee.receive(w.ds.pending({ member: b.id, device: b.device, limit: 1 })[0], noop), "later");
  await recv.e2ee.attach();
  // Generous budgets: 50 decryptions take about 4 s on an idle machine, and over 15 s under a full parallel test run.
  await until(() => recv.got.length === 50, "all 50 logical messages", 60_000);
  assert.deepEqual(recv.got.map((m) => m.text).sort(), Array.from({ length: 50 }, (_, i) => `queued ${i}`).sort());
  assert.ok(recv.got.every((m) => m.e2ee.generation === 2));
  assert.equal((await recv.e2ee.checkpoint(a.id)).generation, 2);
  // The superseded generation's copies were refused (unreadable here for ever), not left waiting.
  await until(() => w.ds.usage({ member: b.id, device: b.device }).messages === 0, "an empty queue", 15_000);
});

test("MII8 at the device: a message whose acceptance is learned by reconciliation after a replacement is sealed again in the current group", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice");
  const b = await device(t, w, "bob", { sessions: [] }); // never joins generation 1
  const writer = await manual(w, a, "alice");
  loseAnswer(writer.client, (f) => f.type === "send_e2ee" && f.kind === "app");
  const m = await writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "accepted, answer lost" });
  assert.equal(m.state, "unsent");
  assert.equal((await writer.e2ee.replace(b.id)).generation, 2);
  await writer.e2ee.recover(); // reconciled: accepted, into the replaced group
  assert.ok(w.ds.pending({ member: b.id, device: b.device, limit: 100 }).some((f) => f.kind === "app" && f.generation === 2), "sealed again in generation 2");
  const recv = await b.open("bob");
  await until(() => recv.got.length === 1, "the message");
  assert.deepEqual([recv.got[0].message_id, recv.got[0].e2ee.generation], [m.message_id, 2]);
  await until(() => w.ds.usage({ member: b.id, device: b.device }).messages === 0, "an empty queue");
});

/** `client`'s relay is an epoch ahead and its log no longer reaches this device's epoch (too_far_behind, once). */
function tooFarBehindOnce(client) {
  const rpc = client.rpc.bind(client);
  let behind = true;
  client.rpc = async (f) => {
    const r = await rpc(f);
    if (behind && f.type === "conversation") return { ...r, epoch: r.epoch + 1 };
    if (behind && f.type === "commits_since") {
      behind = false;
      throw Object.assign(new Error("the log no longer reaches this epoch"), { code: "too_far_behind" });
    }
    return r;
  };
}

test("MII8 at the device: an automatic replacement (too far behind) seals the replaced group's accepted messages again, without a recover()", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice");
  const b = await device(t, w, "bob", { sessions: [] }); // never joins generation 1
  const writer = await manual(w, a, "alice");
  const old = await writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "before the replacement" });
  assert.equal(old.state, "accepted");
  tooFarBehindOnce(writer.client);
  assert.equal((await writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after the replacement" })).state, "accepted");
  assert.equal((await writer.e2ee.checkpoint(b.id)).generation, 2);
  const recv = await b.open("bob");
  await until(() => recv.got.length >= 1, "the new message");
  await until(() => recv.got.length === 2, "both messages").catch(() => {});
  assert.deepEqual(recv.got.map((m) => [m.text, m.e2ee.generation]).sort(), [["after the replacement", 2], ["before the replacement", 2]]);
  assert.equal(recv.got.find((m) => m.text === "before the replacement").message_id, old.message_id);
  await until(() => w.ds.usage({ member: b.id, device: b.device }).messages === 0, "an empty queue");
});

test("MII8 at the device: a crash after an automatic replacement marked its messages, before they are sealed again: recover() seals them", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice", { sessions: [] });
  const b = await device(t, w, "bob", { sessions: [] }); // never joins generation 1
  let armed = false;
  const writer = await manual(w, a, "alice", { fault: (p) => { if (armed && p === "commit-after-merge") throw new Error("crash after the replacement merged"); } });
  const old = await writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "before the replacement" });
  assert.equal(old.state, "accepted");
  armed = true;
  tooFarBehindOnce(writer.client);
  await assert.rejects(writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after the replacement" }), /crash after the replacement merged/);
  writer.client.close();
  await settle(100);
  const kinds = () => w.ds.pending({ member: b.id, device: b.device, limit: 100 }).map((f) => `${f.kind} ${f.generation}`);
  assert.deepEqual(kinds().filter((k) => k.startsWith("app")), ["app 1"], "nothing sealed in generation 2 before the restart");
  // The restart: attach() runs recover(); no resendPending() here.
  const restarted = await manual(w, a, "alice");
  await restarted.e2ee.attach();
  assert.equal(kinds().filter((k) => k === "app 2").length, 2, "both logical messages sealed in generation 2");
  const recv = await b.open("bob");
  await until(() => recv.got.length === 2, "both messages").catch(() => {});
  assert.deepEqual(recv.got.map((m) => [m.text, m.e2ee.generation]).sort(), [["after the replacement", 2], ["before the replacement", 2]]);
  assert.equal(recv.got.find((m) => m.text === "before the replacement").message_id, old.message_id);
  await until(() => w.ds.usage({ member: b.id, device: b.device }).messages === 0, "an empty queue");
});

test("MII3: resend() refuses a message whose sealed copy has no known outcome; recover() resolves it", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await device(t, w, "alice");
  const b = await device(t, w, "bob", { sessions: [] });
  const writer = await manual(w, a, "alice");
  loseAnswer(writer.client, (f) => f.type === "send_e2ee" && f.kind === "app");
  const m = await writer.e2ee.send({ to: { member: b.id, session: "bob" }, body: "accepted, answer lost" });
  assert.equal(m.state, "unsent");
  const apps = () => w.ds.pending({ member: b.id, device: b.device, limit: 100 }).filter((f) => f.kind === "app").length;
  assert.equal(apps(), 1);
  await assert.rejects(writer.e2ee.resend(m.message_id), (e) => e.code === "unresolved");
  assert.equal(apps(), 1, "not sealed again");
  await writer.e2ee.recover(); // reconciled: accepted
  assert.equal(apps(), 1);
  const recv = await b.open("bob");
  await until(() => recv.got.length === 1, "the message");
  assert.equal(recv.got[0].message_id, m.message_id);
});

test("terminal states are never sealed again: resend(ref), recover() and a replacement's Welcome leave a failed message failed", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  const appOps = () => w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app'").n;
  const stateOf = (d) => d.store.transact(async (ctx) => structuredClone(ctx.rec.e2ee ?? {}), { act: false });
  await alice.s.alice.e2ee.send({ to: { member: bob.id, session: "bob" }, body: "sent, then failed" });
  await until(() => bob.s.bob.got.length === 1, "delivered");
  // A message that ended failed after an earlier acceptance in this group (its group recorded).
  let ref;
  await alice.store.transact(async (ctx) => {
    [ref] = Object.keys(ctx.rec.e2ee.logical);
    ctx.rec.e2ee.logical[ref].state = "failed";
    ctx.write();
  });
  const ops = appOps();
  await assert.rejects(alice.s.alice.e2ee.resend(ref), (e) => e.code === "terminal");
  await alice.s.alice.e2ee.recover();
  // bob replaces the group: alice's Welcome processing must not mark it for a resend.
  await bob.s.bob.e2ee.replace(alice.id);
  await until(async () => (await stateOf(alice)).conversations?.[bob.id] === (await stateOf(bob)).conversations?.[alice.id], "alice joined the replacement");
  await settle(300);
  await alice.s.alice.e2ee.recover();
  assert.equal((await stateOf(alice)).logical[ref].state, "failed");
  assert.equal(appOps(), ops, "never published again");
});
