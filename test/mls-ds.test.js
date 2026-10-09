// The relay's Delivery Service for encrypted direct messages (design 3.3, experimental): the flag
// gates everything; conversations map to one group by create-if-absent; replacement generations;
// one accepted commit per epoch, conflicts only for another operation, op-id idempotency; every
// acceptance is one transaction (log, roster, Welcome queue, reservations); faults on each side of
// the commit and a killed relay; routing by target session; quotas; the frame bound; the log's
// catch-up and retention. MLS bytes are opaque to the relay, so they are arbitrary here.
import { test } from "node:test";
import { createAccess } from "../lib/access.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lockStateDir } from "../lib/realm.js";
import { openRelayDb } from "../lib/relaydb.js";
import { E2EE_CAP, DEVICE_CAP } from "../lib/relay.js";
import { MAX_FRAME_BYTES, LOG_KEEP_EPOCHS } from "../lib/mls/relayds.js";
import { DAY, KP_LIFETIME_MS } from "../lib/mls/policy.js";
import { RELAY_MIGRATIONS } from "../lib/relaystore.js";
import { deviceRelay, fakeDevice, newOp, refusal, tmpDir } from "./mls-helpers.js";

const CRASH = fileURLToPath(new URL("./fixtures/relayds-crash.mjs", import.meta.url));
const groupId = () => crypto.randomBytes(16).toString("hex");
const blob = (n = 64, fill = null) => (fill === null ? crypto.randomBytes(n) : Buffer.alloc(n, fill)).toString("base64");
let reqN = 0;
const reqId = () => `req-${process.pid}-${++reqN}-${crypto.randomBytes(3).toString("hex")}`;

/** alice (one device) and bob (two devices, `n` packages each), clients for each. */
async function setup(t, { n = 4, limits = {}, access = null } = {}) {
  const w = await deviceRelay(t, { e2ee: true, limits, access });
  const alice = await w.client("alice");
  const bob = await w.client("bob");
  const carol = await w.client("carol");
  const ad = await fakeDevice(w.realm, w.members.alice.id);
  const ad2 = await fakeDevice(w.realm, w.members.alice.id);
  const bd = await fakeDevice(w.realm, w.members.bob.id);
  const bd2 = await fakeDevice(w.realm, w.members.bob.id);
  const cd = await fakeDevice(w.realm, w.members.carol.id);
  for (const [c, d] of [[alice, ad], [alice, ad2], [bob, bd], [bob, bd2], [carol, cd]]) {
    await c.rpc(d.register());
    if (n) await c.rpc({ type: "kp_upload", device: d.device, packages: await d.packages(n, w.clock.now() + KP_LIFETIME_MS) });
  }
  const A = w.members.alice.id;
  const B = w.members.bob.id;
  /** A reservation of `requester` for device `target` of `member`. */
  const take = async (client, requester, member, target) => (await client.rpc({ type: "kp_take", request: reqId(), device: requester.device, target: { member, device: target.device } })).reservation;
  /** alice's device creates the conversation's group with bob's two devices. */
  const create = async ({ op = newOp(), group = groupId(), by = ad, client = alice, peer = B, targets = [bd, bd2], member = B } = {}) => {
    const res = [];
    for (const d of targets) res.push(await take(client, by, member, d));
    const frame = { type: "group_create", op, device: by.device, peer, group, epoch: 1, welcome: { recipients: targets.map((d) => d.device), mls: blob(), ratchet_tree: blob(32) }, kp_reservations: res };
    return { frame, answer: await client.rpc(frame), res };
  };
  const commit = (client, by, group, expected, extra = {}) => client.rpc({ type: "send_e2ee", kind: "commit", op: newOp(), device: by.device, group, expected_epoch: expected, mls: blob(), roster_delta: { add: [], remove: [] }, kp_reservations: [], ...extra });
  return { w, alice, bob, carol, ad, ad2, bd, bd2, cd, A, B, take, create, commit };
}

const resState = (w, id) => w.db.get("SELECT state FROM kp_reservations WHERE reservation = ?", id).state;
const counts = (w) => ({
  log: w.db.get("SELECT count(*) AS n FROM e2ee_log").n,
  queue: w.db.get("SELECT count(*) AS n FROM e2ee_queue").n,
  roster: w.db.get("SELECT count(*) AS n FROM e2ee_roster").n,
  used: w.db.get("SELECT count(*) AS n FROM kp_reservations WHERE state = 'used'").n,
});

/** A device's deliveries, received on `client` after it attaches `device`. */
function inbox(client) {
  const got = [];
  const waiters = [];
  client.on("message_e2ee", (m, ack) => {
    got.push({ m, ack });
    for (const w of waiters.splice(0)) w();
  });
  return {
    got,
    async attach(device) {
      return client.rpc({ type: "e2ee_attach", device: device.device });
    },
    async wait(n, ms = 3000) {
      const end = Date.now() + ms;
      while (got.length < n) {
        if (Date.now() > end) throw new Error(`expected ${n} deliveries, got ${got.length}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
      return got;
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 150));
/** The principal the relay queues with a member token's message (sent here past the relay's rate limit). */
const memberSender = (memberId) => ({ memberId, identity: null, family: null });

test("without the experimental flag nothing changes: no e2ee capability, the frames are unknown", async (t) => {
  const plain = await deviceRelay(t, { devices: false });
  const c = await plain.client("alice");
  assert.ok(!c.caps.includes(E2EE_CAP) && !c.caps.includes(DEVICE_CAP));
  for (const type of ["group_create", "group_replace", "conversation", "send_e2ee", "commits_since", "commit_invalid", "member_of", "e2ee_attach"]) {
    await assert.rejects(c.rpc({ type }), /unknown message type/, type);
  }
  // Devices alone (3.2's relay) do not carry encrypted messages either.
  const devicesOnly = await deviceRelay(t);
  const d = await devicesOnly.client("alice");
  assert.ok(d.caps.includes(DEVICE_CAP) && !d.caps.includes(E2EE_CAP));
  await assert.rejects(d.rpc({ type: "send_e2ee" }), /unknown message type/);
  const on = await deviceRelay(t, { e2ee: true });
  const e = await on.client("alice");
  assert.deepEqual(e.caps.filter((x) => x !== E2EE_CAP), d.caps, "the flag only adds the capability");
});

test("encrypted-message frames are for members on protocol 2 with their own enrolled devices", async (t) => {
  const s = await setup(t, { n: 0 });
  const token = crypto.randomBytes(16).toString("hex");
  const shared = await deviceRelay(t, { e2ee: true, shared: token });
  const sc = await shared.client(null, { token });
  assert.equal((await refusal(sc.rpc({ type: "conversation", peer: s.B }))).code, "member_only");
  // bob cannot act as alice's device.
  assert.equal((await refusal(s.bob.rpc({ type: "e2ee_attach", device: s.ad.device }))).code, "no_device");
  assert.equal((await refusal(s.alice.rpc({ type: "group_create", op: newOp(), device: s.ad.device, peer: s.A, group: groupId(), epoch: 1 }))).code, "bad_request", "a conversation is two members");
  assert.equal((await s.alice.rpc({ type: "member_of", name: "bob-laptop" })).member, s.B);
  assert.equal((await s.alice.rpc({ type: "member_of", name: "nobody" })).member, null);
  // A hidden member (the visibility hook of design 4.2) is not named to callers that may not reach it.
  const hidden = await deviceRelay(t, { e2ee: true, visible: (caller, target) => target !== hidden.members.bob.id });
  const hc = await hidden.client("alice");
  assert.equal((await hc.rpc({ type: "member_of", name: "bob" })).member, null);
  assert.equal((await hc.rpc({ type: "member_of", name: "alice-2" })).member, hidden.members.alice.id, "a member always resolves its own names");
});

test("conversations: concurrent creates give one group; a delayed contender changes nothing; op ids are idempotent", async (t) => {
  const s = await setup(t);
  // alice's device and bob's device race to create the pair's group.
  const resA = [await s.take(s.alice, s.ad, s.B, s.bd)];
  const resB = [await s.take(s.bob, s.bd, s.A, s.ad)];
  const fa = { type: "group_create", op: newOp(), device: s.ad.device, peer: s.B, group: groupId(), epoch: 1, welcome: { recipients: [s.bd.device], mls: blob() }, kp_reservations: resA };
  const fb = { type: "group_create", op: newOp(), device: s.bd.device, peer: s.A, group: groupId(), epoch: 1, welcome: { recipients: [s.ad.device], mls: blob() }, kp_reservations: resB };
  const [ra, rb] = await Promise.all([s.alice.rpc(fa), s.bob.rpc(fb)]);
  assert.equal(ra.group, rb.group, "one group for the pair");
  assert.equal([ra.created, rb.created].filter(Boolean).length, 1);
  const winner = ra.created ? { res: resA, loser: resB } : { res: resB, loser: resA };
  assert.equal(resState(s.w, winner.res[0]), "used");
  assert.equal(resState(s.w, winner.loser[0]), "reserved", "the loser's reservation is not consumed (it burns later)");
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_queue").n, 1, "only the winner's Welcome is queued");
  // The same op id with the same payload: the original result; another payload: refused.
  const again = await s.alice.rpc(fa);
  assert.equal(again.group, ra.group);
  assert.equal(again.created, ra.created);
  assert.equal((await refusal(s.alice.rpc({ ...fa, group: groupId() }))).code, "op_reused");
  // A delayed contender after the Welcome was delivered: still the same group, nothing queued.
  const box = inbox(ra.created ? s.bob : s.alice);
  await box.attach(ra.created ? s.bd : s.ad);
  const [{ ack }] = await box.wait(1);
  ack();
  await settle();
  const late = await s.carol.rpc({ type: "conversation", peer: s.A });
  assert.equal(late.group, null, "carol and alice have no conversation");
  const delayed = await s.create({ op: newOp() });
  assert.equal(delayed.answer.group, ra.group);
  assert.equal(delayed.answer.created, false);
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_queue").n, 0);
  for (const r of delayed.res) assert.equal(resState(s.w, r), "reserved");
  assert.equal((await s.bob.rpc({ type: "conversation", peer: s.A })).generation, 1);
});

test("a create is one transaction: Welcome queue entries and reservation consumption only on acceptance", async (t) => {
  const s = await setup(t);
  const before = counts(s.w);
  // A Welcome whose recipients differ from the reserved devices: refused, nothing consumed.
  const res = [await s.take(s.alice, s.ad, s.B, s.bd)];
  const bad = { type: "group_create", op: newOp(), device: s.ad.device, peer: s.B, group: groupId(), epoch: 1, welcome: { recipients: [s.bd2.device], mls: blob() }, kp_reservations: res };
  assert.equal((await refusal(s.alice.rpc(bad))).code, "no_reservation");
  assert.deepEqual(counts(s.w), before);
  assert.equal(resState(s.w, res[0]), "reserved");
  // A device of a third member: refused.
  const cres = [await s.take(s.alice, s.ad, s.w.members.carol.id, s.cd)];
  assert.equal((await refusal(s.alice.rpc({ ...bad, op: newOp(), welcome: { recipients: [s.cd.device], mls: blob() }, kp_reservations: cres }))).code, "not_allowed");
  assert.equal(resState(s.w, cres[0]), "reserved");
  // A fault before the commit: nothing; after it: the retry returns the original result.
  s.w.fault.arm("before-commit");
  const good = { ...bad, op: newOp(), welcome: { recipients: [s.bd.device], mls: blob() } };
  assert.equal((await refusal(s.alice.rpc(good))).code, "unavailable");
  assert.deepEqual(counts(s.w), before);
  s.w.fault.arm("after-commit");
  assert.equal((await refusal(s.alice.rpc(good))).code, "unavailable");
  const r = await s.alice.rpc(good);
  assert.equal(r.created, true);
  assert.equal(r.repeated, true, "the committed result, answered again");
  assert.deepEqual(counts(s.w), { log: 0, queue: 1, roster: 2, used: 1 });
});

test("commits: one accepted per epoch under concurrent senders; conflict only for another op; stale epochs; idempotent retries", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create();
  // bob's devices join (their Welcomes), then three devices race for epoch 1.
  const ops = [newOp(), newOp(), newOp()];
  const frames = [[s.alice, s.ad], [s.bob, s.bd], [s.bob, s.bd2]].map(([c, d], i) => [c, { type: "send_e2ee", kind: "commit", op: ops[i], device: d.device, group: g.group, expected_epoch: 1, mls: blob(), roster_delta: { add: [], remove: [] }, kp_reservations: [] }]);
  const answers = await Promise.all(frames.map(([c, f]) => c.rpc(f)));
  const accepted = answers.filter((a) => a.state === "accepted");
  assert.equal(accepted.length, 1, "one commit per epoch");
  assert.deepEqual([accepted[0].position, accepted[0].epoch], [1, 2]);
  const wi = answers.findIndex((a) => a.state === "accepted");
  for (const [i, a] of answers.entries()) {
    if (i === wi) continue;
    assert.equal(a.state, "conflict");
    assert.deepEqual(a.winner, { position: 1, op: ops[wi], device: frames[wi][1].device, epoch: 1 });
  }
  // A lost answer: the same op and payload returns "accepted" (never a conflict with itself), also
  // after the group moved on.
  assert.equal((await s.commit([s.alice, s.bob, s.bob][wi], [s.ad, s.bd, s.bd2][wi], g.group, 2)).state, "accepted");
  const repeat = await frames[wi][0].rpc(frames[wi][1]);
  assert.deepEqual([repeat.state, repeat.position, repeat.repeated], ["accepted", 1, true]);
  // A conflict answered once is answered the same way again.
  const li = (wi + 1) % 3;
  assert.equal((await frames[li][0].rpc(frames[li][1])).state, "conflict");
  // The same op id with a different payload is refused.
  assert.equal((await refusal(frames[wi][0].rpc({ ...frames[wi][1], mls: blob() }))).code, "op_reused");
  // An epoch ahead of the group: stale_epoch, nothing recorded (a retry may run once it is current).
  const ahead = await s.commit(s.alice, s.ad, g.group, 9);
  assert.deepEqual([ahead.state, ahead.epoch], ["stale_epoch", 3]);
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_log").n, 2);
});

test("roster deltas: removals of roster devices, additions only through the requester's reservations; one transaction", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  const before = counts(s.w);
  // Adding without a reservation, a third member's device, or one already in the roster: refused.
  assert.equal((await refusal(s.commit(s.alice, s.ad, g.group, 1, { roster_delta: { add: [s.bd2.device], remove: [] }, welcome: { recipients: [s.bd2.device], mls: blob() } }))).code, "bad_request");
  const other = await s.take(s.bob, s.bd, s.B, s.bd2); // bob's reservation, not alice's
  assert.equal((await refusal(s.commit(s.alice, s.ad, g.group, 1, { roster_delta: { add: [s.bd2.device], remove: [] }, welcome: { recipients: [s.bd2.device], mls: blob() }, kp_reservations: [other] }))).code, "no_reservation");
  assert.equal((await refusal(s.commit(s.alice, s.ad, g.group, 1, { roster_delta: { add: [], remove: [s.cd.device] } }))).code, "bad_request");
  // A non-roster device cannot publish.
  assert.equal((await refusal(s.commit(s.alice, s.ad2, g.group, 1))).code, "not_member");
  assert.deepEqual(counts(s.w), before);
  assert.equal(resState(s.w, other), "reserved");
  // alice adds bob's second device and alice's second device in one commit; bob's first device and
  // the committer's own get the commit, the added devices their Welcome, exactly this log entry.
  const r1 = await s.take(s.alice, s.ad, s.B, s.bd2);
  const r2 = await s.take(s.alice, s.ad, s.A, s.ad2);
  const ok = await s.commit(s.alice, s.ad, g.group, 1, { roster_delta: { add: [s.bd2.device, s.ad2.device], remove: [] }, welcome: { recipients: [s.ad2.device, s.bd2.device], mls: blob() }, kp_reservations: [r2, r1] });
  assert.equal(ok.state, "accepted");
  assert.deepEqual([resState(s.w, r1), resState(s.w, r2)], ["used", "used"]);
  const rows = s.w.db.all("SELECT device_id, frame FROM e2ee_queue ORDER BY seq").map((r) => ({ device: r.device_id, ...JSON.parse(r.frame) }));
  const commitFrames = rows.filter((f) => f.kind === "commit");
  assert.deepEqual(commitFrames.map((f) => f.device), [s.bd.device]);
  assert.deepEqual(commitFrames[0].log, { position: 1, op: commitFrames[0].log.op, expected_epoch: 1, roster_delta: { add: [s.bd2.device, s.ad2.device], remove: [] } });
  assert.deepEqual(rows.filter((f) => f.kind === "welcome" && f.epoch === 2).map((f) => f.device).sort(), [s.ad2.device, s.bd2.device].sort());
  // bob's first device removes itself: it still receives that commit; afterwards it is not routed to.
  const rm = await s.commit(s.bob, s.bd, g.group, 2, { roster_delta: { add: [], remove: [s.bd.device] } });
  assert.equal(rm.state, "accepted");
  assert.deepEqual(s.w.ds.roster(g.group).map((d) => d.device).sort(), [s.ad.device, s.ad2.device, s.bd2.device].sort());
  assert.equal((await refusal(s.commit(s.bob, s.bd, g.group, 3))).code, "not_member");
});

test("a relay killed at either side of a commit's acceptance: log, roster, queue and reservations agree", async (t) => {
  for (const point of ["before-commit", "after-commit"]) {
    const dir = tmpDir(t);
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [CRASH, dir, point], { timeout: 20_000 }, (err, stdout, stderr) => (err?.signal === "SIGKILL" ? resolve() : reject(new Error(`the fixture did not die at ${point}: ${stdout}${stderr}`))));
    });
    const release = lockStateDir(dir);
    try {
      const db = openRelayDb({ dir, migrations: RELAY_MIGRATIONS });
      const row = (sql) => Object.values(db.get(sql))[0];
      const got = ["e2ee_log", "e2ee_roster", "e2ee_queue", "e2ee_ops"].map((x) => row(`SELECT count(*) FROM ${x}`));
      got.push(row("SELECT count(*) FROM kp_reservations WHERE state = 'used'"));
      // before: the create only (roster 2, its Welcome, one op, one reservation used); after: the
      // commit too (a log entry, roster 3, the commit to bob and the Welcome to his second device,
      // a second op, a second reservation used).
      assert.deepEqual(got, point === "before-commit" ? [0, 2, 1, 1, 1] : [1, 3, 3, 2, 2], point);
      db.close();
    } finally {
      release();
    }
  }
});

test("replacement: generation + 1 by a roster device; the old group stops accepting; stale generations refused", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  const fresh = groupId();
  const res = [await s.take(s.bob, s.bd, s.A, s.ad)];
  const frame = { type: "group_replace", op: newOp(), device: s.bd.device, peer: s.A, expected_generation: 1, group: fresh, epoch: 1, welcome: { recipients: [s.ad.device], mls: blob() }, kp_reservations: res };
  // A device outside the current group cannot replace it.
  assert.equal((await refusal(s.bob.rpc({ ...frame, op: newOp(), device: s.bd2.device }))).code, "not_member");
  const r = await s.bob.rpc(frame);
  assert.deepEqual([r.group, r.generation, r.created], [fresh, 2, true]);
  assert.deepEqual(await s.bob.rpc(frame).then((x) => [x.group, x.repeated]), [fresh, true]);
  assert.equal((await refusal(s.bob.rpc({ ...frame, op: newOp(), group: groupId() }))).code, "stale_generation");
  // The old group: no more messages or commits; the refusal names the current group.
  const old = await refusal(s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob" }));
  assert.equal(old.code, "group_replaced");
  assert.equal((await refusal(s.commit(s.alice, s.ad, g.group, 1))).code, "group_replaced");
  assert.equal((await s.alice.rpc({ type: "conversation", peer: s.B })).group, fresh);
});

test("delivery: application messages reach only the target session's connection of each device; acks are durable", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd, s.bd2] });
  // Two sessions on bob's first device, one on his second.
  const main = await s.w.client("bob", { session: "bob-main" });
  const other = await s.w.client("bob", { session: "bob-other" });
  const second = await s.w.client("bob", { session: "bob-main2" });
  const [bm, bo, b2] = [inbox(main), inbox(other), inbox(second)];
  await bm.attach(s.bd);
  (await bm.wait(1))[0].ack(); // a Welcome goes to an attached connection of the device
  await bo.attach(s.bd);
  await b2.attach(s.bd2);
  (await b2.wait(1))[0].ack();
  const sent = await s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob-main" });
  assert.deepEqual([sent.state, sent.recipients], ["accepted", 2]);
  const got = (await bm.wait(2))[1];
  assert.deepEqual([got.m.kind, got.m.target, got.m.from_member, got.m.from_device, got.m.group, got.m.generation], ["app", "bob-main", s.A, s.ad.device, g.group, 1]);
  await settle();
  assert.equal(bo.got.length, 0, "the other session of the device does not get it");
  assert.equal(b2.got.length, 1, "bob's second device has no bob-main session: it waits there");
  // Unacknowledged: after a reconnect it comes again (same delivery id); acknowledged: never again.
  main.close();
  await settle();
  const main2 = await s.w.client("bob", { session: "bob-main" });
  const bm2 = inbox(main2);
  await bm2.attach(s.bd);
  const [again] = await bm2.wait(1);
  assert.equal(again.m.delivery, got.m.delivery);
  again.ack();
  await settle();
  await s.w.restart();
  const main3 = await s.w.client("bob", { session: "bob-main" });
  const bm3 = inbox(main3);
  await bm3.attach(s.bd);
  await settle();
  assert.equal(bm3.got.length, 0, "an acknowledged delivery is gone, also after a restart");
  // The queue survived the restart for the device that did not take it.
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd2.device }).messages, 1);
});

test("quotas: pending encrypted messages per device are bounded, then refused with quota until acknowledged", async (t) => {
  const s = await setup(t, { limits: { messages: 3 } });
  const { answer: g } = await s.create({ targets: [s.bd] }); // the Welcome counts toward bob's device
  const app = () => s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob" });
  await app();
  await app();
  assert.equal((await refusal(app())).code, "quota");
  const c = await s.w.client("bob", { session: "bob" });
  const box = inbox(c);
  await box.attach(s.bd);
  (await box.wait(3))[0].ack();
  await settle();
  assert.equal((await app()).state, "accepted");
});

test("limits: the complete serialized frame is bounded (512 KiB) and refused, not split or cut", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  // An MLS message over 360 KiB decoded: refused.
  assert.equal((await refusal(s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(361 * 1024, 1), target: "bob" }))).code, "too_large");
  // A commit bundle whose commit and Welcome together exceed the frame: refused as a whole.
  const r = await s.take(s.alice, s.ad, s.B, s.bd2);
  const big = { roster_delta: { add: [s.bd2.device], remove: [] }, welcome: { recipients: [s.bd2.device], mls: blob(200 * 1024, 2) }, kp_reservations: [r], mls: blob(200 * 1024, 3) };
  const before = counts(s.w);
  assert.equal((await refusal(s.commit(s.alice, s.ad, g.group, 1, big))).code, "too_large");
  assert.deepEqual(counts(s.w), before);
  assert.equal(resState(s.w, r), "reserved");
  // Exactly at the bound the relay answers; over it the frame is refused, the connection stays.
  const raw = { type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: "", target: "bob", pad: "" };
  raw.pad = "x".repeat(MAX_FRAME_BYTES + 10 - Buffer.byteLength(JSON.stringify({ ...raw, id: 99 })));
  assert.equal((await refusal(s.alice.rpc(raw))).code, "too_large");
  assert.ok((await s.alice.rpc({ type: "conversation", peer: s.B })).group, "still connected");
  // The largest MLS message fits a delivery with the relay's own fields.
  const max = await s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(360 * 1024, 4), target: "bob" });
  assert.equal(max.state, "accepted");
});

test("catch-up: commits_since serves the log in order; beyond retention a device recovers by replacement; commit_invalid is recorded", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  for (let e = 1; e <= 4; e++) assert.equal((await s.commit(e % 2 ? s.alice : s.bob, e % 2 ? s.ad : s.bd, g.group, e)).state, "accepted");
  const c = await s.bob.rpc({ type: "commits_since", device: s.bd.device, group: g.group, epoch: 2 });
  assert.deepEqual(c.entries.map((e) => [e.position, e.epoch]), [[2, 2], [3, 3], [4, 4]]);
  assert.equal(c.epoch, 5);
  assert.equal((await refusal(s.carol.rpc({ type: "commits_since", device: s.cd.device, group: g.group, epoch: 0 }))).code, "not_member");
  assert.deepEqual(await s.bob.rpc({ type: "commit_invalid", device: s.bd.device, group: g.group, epoch: 4, reason: "roster delta disagrees" }).then((r) => r.recorded), true);
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_invalid").n, 1);
  // 30 days later the log is gone: a device that fell behind is told to replace.
  s.w.clock.advance(31 * DAY);
  s.w.ds.sweep();
  const behind = await refusal(s.bob.rpc({ type: "commits_since", device: s.bd.device, group: g.group, epoch: 2 }));
  assert.equal(behind.code, "too_far_behind");
  assert.deepEqual((await s.bob.rpc({ type: "commits_since", device: s.bd.device, group: g.group, epoch: 5 })).entries, [], "a current device is not behind");
  assert.ok(LOG_KEEP_EPOCHS === 1000);
});

test("MII7 fair delivery: 200 queued messages for an offline session never hide a later one for an attached session", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  const box0 = inbox(await s.w.client("bob", { session: "bob" }));
  await box0.attach(s.bd);
  (await box0.wait(1))[0].ack(); // the Welcome
  await settle();
  for (let i = 0; i < 201; i++) s.w.ds.sendApp({ requester: { member: s.A, device: s.ad.device }, sender: memberSender(s.A), op: newOp(), group: g.group, mls: blob(16), target: i === 200 ? "bob-other" : "bob-offline" });
  const box = inbox(await s.w.client("bob", { session: "bob-other" }));
  await box.attach(s.bd);
  const [m] = await box.wait(1);
  assert.equal(m.m.target, "bob-other");
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd.device }).messages, 201);
  // The selection is in the store: only the attached targets' frames (and control frames).
  assert.deepEqual(s.w.ds.pending({ member: s.B, device: s.bd.device, targets: ["bob-other"], control: false }).map((f) => f.target), ["bob-other"]);
  assert.equal(s.w.ds.pending({ member: s.B, device: s.bd.device, targets: [], control: true }).length, 0);
});

test("MII8 control frames are bounded: past the queue limits older commits of the same group coalesce (the log catches up); removals are never refused", async (t) => {
  const s = await setup(t, { limits: { messages: 1, bytes: 4000 } });
  const { answer: g } = await s.create({ targets: [s.bd] });
  const usage = () => s.w.ds.usage({ member: s.B, device: s.bd.device });
  for (let i = 0; i < 4; i++) assert.equal((await s.commit(s.alice, s.ad, g.group, 1 + i, { mls: blob(1100) })).state, "accepted");
  // The Welcome (not a commit) and the newest commit wait; the older commits are in the log.
  assert.deepEqual(s.w.db.all("SELECT json_extract(frame, '$.kind') AS k FROM e2ee_queue WHERE device_id = ? ORDER BY seq", s.bd.device).map((r) => r.k), ["welcome", "commit"]);
  assert.ok(usage().messages <= 2);
  const newest = s.w.ds.pending({ member: s.B, device: s.bd.device }).find((f) => f.kind === "commit");
  assert.equal(newest.log.expected_epoch, 4);
  assert.equal(s.w.ds.commitsSince({ requester: { member: s.B, device: s.bd.device }, group: g.group, epoch: 1 }).entries.length, 4, "catch-up has every commit");
  // A removal over the limits is accepted (its notification is bounded the same way).
  const removal = await s.commit(s.alice, s.ad, g.group, 5, { mls: blob(1100), roster_delta: { add: [], remove: [s.bd.device] } });
  assert.equal(removal.state, "accepted");
  assert.ok(usage().messages <= 2);
});

test("MII4 the admin-revocation fence covers encrypted messages: no publication, attachment or delivery until stored; revoked attached devices stop at once", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd, s.bd2] });
  const box = inbox(await s.w.client("bob", { session: "bob" }));
  await box.attach(s.bd);
  (await box.wait(1))[0].ack(); // the Welcome
  const app = () => s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob" });
  await app();
  const [, first] = await box.wait(2); // delivered, not acknowledged yet
  const members = Object.values(s.w.members).map((m) => (m.name === "bob" ? { ...m, devicesRevoked: [s.bd.device] } : m));
  // One failed transaction: the store is healthy again, but the revocation is not stored (fenced).
  s.w.fault.arm("before-commit");
  assert.throws(() => s.w.relay.reload(members), (e) => e.membersApplied === true);
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM device_revocations").n, 0);
  // Fenced: publication, attachment and the other frames are refused as retryable.
  assert.equal((await refusal(app())).code, "unavailable");
  assert.equal((await refusal(s.commit(s.alice, s.ad, g.group, 1))).code, "unavailable");
  assert.equal((await refusal(s.alice.rpc({ type: "conversation", peer: s.B }))).code, "unavailable");
  const late = inbox(await s.w.client("bob", { session: "bob-late" }));
  assert.equal((await refusal(late.attach(s.bd2))).code, "unavailable");
  // Delivery pauses too: an acknowledgement (still taken) does not pump what was queued meanwhile.
  s.w.ds.sendApp({ requester: { member: s.A, device: s.ad.device }, sender: memberSender(s.A), op: newOp(), group: g.group, mls: blob(), target: "bob" });
  first.ack();
  await settle();
  assert.equal(box.got.length, 2, "nothing delivered while fenced");
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd.device }).messages, 1, "the acknowledgement was stored");
  // Stored (the next reload or sweep): the revoked device, still attached, receives nothing more;
  // publication resumes for the others.
  s.w.relay.reload(members);
  assert.equal((await app()).state, "accepted");
  await settle();
  assert.equal(box.got.length, 2, "the revoked device's attached connection gets nothing more");
  assert.equal((await refusal(inbox(await s.w.client("bob", { session: "bob-2" })).attach(s.bd))).code, "device_revoked");
  assert.equal((await late.attach(s.bd2)).type, "e2ee_attached");
});

test("MII3 reconciliation is reconcile-or-cancel: an unknown op id is cancelled in the same transaction; its delayed original is refused whatever its payload", async (t) => {
  const s = await setup(t, { limits: { cancelled: 2 } });
  const { answer: g } = await s.create({ targets: [s.bd] });
  const app = (op, extra = {}) => ({ type: "send_e2ee", kind: "app", op, device: s.ad.device, group: g.group, mls: blob(), target: "bob", ...extra });
  const queued = () => s.w.db.get("SELECT count(*) AS n FROM e2ee_queue WHERE json_extract(frame, '$.kind') = 'app'").n;
  // Accepted before: reconciliation and the original's retry both return the original result.
  const accepted = app(newOp());
  assert.equal((await s.alice.rpc(accepted)).state, "accepted");
  assert.equal((await s.alice.rpc({ ...accepted, reconcile: true })).state, "accepted");
  assert.equal((await s.alice.rpc(accepted)).state, "accepted");
  assert.equal(queued(), 1);
  // Never accepted: cancelled, durably; the original arriving later is refused, with any payload.
  const lost = app(newOp());
  assert.equal((await s.alice.rpc({ ...lost, reconcile: true })).state, "cancelled");
  assert.equal((await s.alice.rpc({ ...lost, reconcile: true })).state, "cancelled", "a repeated reconciliation answers the same");
  assert.equal((await refusal(s.alice.rpc(lost))).code, "op_cancelled");
  assert.equal((await refusal(s.alice.rpc({ ...lost, mls: blob() }))).code, "op_cancelled");
  assert.equal((await refusal(s.commit(s.alice, s.ad, g.group, 1, { op: lost.op }))).code, "op_cancelled");
  assert.equal(queued(), 1, "nothing of the cancelled op was queued");
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'cancelled'").n, 1);
  // Bounded per device: past the limit a reconciliation is refused (nothing is cancelled or evicted).
  assert.equal((await s.alice.rpc(app(newOp(), { reconcile: true }))).state, "cancelled");
  assert.equal((await refusal(s.alice.rpc(app(newOp(), { reconcile: true })))).code, "quota");
  assert.equal((await refusal(s.alice.rpc(lost))).code, "op_cancelled", "the older tombstone is kept");
  // They expire with the operations (30 days; an application message lives at most 7 days).
  s.w.clock.advance(31 * DAY);
  s.w.ds.sweep();
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'cancelled'").n, 0);
});

test("MII8 per-device control bound: replacements drop the control frames of superseded generations, one queued Welcome per conversation (the newest)", async (t) => {
  // The reviewer's repro: 25 generations, each a fresh KeyPackage, a Welcome and a commit, for one offline device.
  const w = await deviceRelay(t, { e2ee: true, limits: { messages: 1, bytes: 1024 } });
  const alice = await w.client("alice");
  const bob = await w.client("bob");
  const A = w.members.alice.id;
  const B = w.members.bob.id;
  const ad = await fakeDevice(w.realm, A);
  const bd = await fakeDevice(w.realm, B);
  await alice.rpc(ad.register());
  await bob.rpc(bd.register());
  let group = null;
  for (let i = 0; i < 25; i++) {
    await bob.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w.clock.now() + DAY) });
    const taken = await alice.rpc({ type: "kp_take", request: reqId(), device: ad.device, target: { member: B, device: bd.device } });
    group = groupId();
    const request = { type: i ? "group_replace" : "group_create", op: newOp(), device: ad.device, peer: B, group, epoch: 1, welcome: { recipients: [bd.device], mls: blob(2048, i) }, kp_reservations: [taken.reservation] };
    if (i) request.expected_generation = i;
    assert.equal((await alice.rpc(request)).generation, i + 1);
    assert.equal((await alice.rpc({ type: "send_e2ee", kind: "commit", device: ad.device, op: newOp(), group, expected_epoch: 1, mls: blob(2048, i), roster_delta: { add: [], remove: [] }, kp_reservations: [] })).state, "accepted");
  }
  const queued = w.ds.pending({ member: B, device: bd.device, limit: 100 });
  // Bound: per device and conversation at most one Welcome, plus the current generation's commits
  // (coalesced to the newest past the queue limits).
  assert.deepEqual(queued.map((f) => [f.kind, f.generation]), [["welcome", 25], ["commit", 25]]);
  assert.ok(queued.every((f) => f.group === group));
  const usage = w.ds.usage({ member: B, device: bd.device });
  assert.equal(usage.messages, 2);
  assert.ok(usage.bytes < 10 * 1024, `${usage.bytes} bytes queued`);
});

test("MII8 a replacement drops only control frames: application messages of the old group stay; a re-added device keeps only its newest Welcome", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  assert.equal((await s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob" })).state, "accepted");
  assert.equal((await s.commit(s.alice, s.ad, g.group, 1)).state, "accepted");
  const kinds = () => s.w.ds.pending({ member: s.B, device: s.bd.device, limit: 100 }).map((f) => [f.kind, f.generation]);
  assert.deepEqual(kinds(), [["welcome", 1], ["app", 1], ["commit", 1]]);
  const group = groupId();
  const res = await s.take(s.alice, s.ad, s.B, s.bd);
  const r = await s.alice.rpc({ type: "group_replace", op: newOp(), device: s.ad.device, peer: s.B, expected_generation: 1, group, epoch: 1, welcome: { recipients: [s.bd.device], mls: blob() }, kp_reservations: [res] });
  assert.equal(r.generation, 2);
  assert.deepEqual(kinds(), [["app", 1], ["welcome", 2]]);
  // Removed and added again in the current group: one Welcome, the newest.
  assert.equal((await s.commit(s.alice, s.ad, group, 1, { roster_delta: { add: [], remove: [s.bd.device] } })).state, "accepted");
  const again = await s.take(s.alice, s.ad, s.B, s.bd);
  assert.equal((await s.commit(s.alice, s.ad, group, 2, { roster_delta: { add: [s.bd.device], remove: [] }, welcome: { recipients: [s.bd.device], mls: blob() }, kp_reservations: [again] })).state, "accepted");
  const welcomes = s.w.ds.pending({ member: s.B, device: s.bd.device, limit: 100 }).filter((f) => f.kind === "welcome");
  assert.deepEqual(welcomes.map((f) => [f.generation, f.epoch]), [[2, 3]]);
});

test("MII8 control frames have their own delivery budget: a replacement's Welcome passes 250 unreadable application messages of the superseded generation", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  for (let i = 0; i < 250; i++) s.w.ds.sendApp({ requester: { member: s.A, device: s.ad.device }, sender: memberSender(s.A), op: newOp(), group: g.group, mls: blob(16), target: "bob" });
  const group = groupId();
  const res = await s.take(s.alice, s.ad, s.B, s.bd);
  assert.equal((await s.alice.rpc({ type: "group_replace", op: newOp(), device: s.ad.device, peer: s.B, expected_generation: 1, group, epoch: 1, welcome: { recipients: [s.bd.device], mls: blob() }, kp_reservations: [res] })).generation, 2);
  // The selection reaches control frames whatever the number of application messages before them.
  const sel = s.w.ds.pending({ member: s.B, device: s.bd.device, limit: 200, targets: ["bob"], control: true });
  assert.ok(sel.some((f) => f.kind === "welcome" && f.generation === 2), "the current Welcome is selected past 250 application messages");
  // Delivery: the device never acknowledges the old generation's messages (it cannot read them yet).
  const box = inbox(await s.w.client("bob", { session: "bob" }));
  await box.attach(s.bd);
  await box.wait(51);
  await settle();
  assert.deepEqual(box.got.filter((x) => x.m.kind !== "app").map((x) => [x.m.kind, x.m.generation]), [["welcome", 2]]);
  assert.equal(box.got.filter((x) => x.m.kind === "app").length, 50, "application messages keep their own budget");
});

test("MII8 an in-flight control frame removed by a replacement frees its slot; its late acknowledgement is harmless", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  const box = inbox(await s.w.client("bob", { session: "bob" }));
  await box.attach(s.bd);
  await box.wait(1); // Welcome 1, in flight and never acknowledged
  for (let i = 0; i < 49; i++) s.w.ds.sendApp({ requester: { member: s.A, device: s.ad.device }, sender: memberSender(s.A), op: newOp(), group: g.group, mls: blob(16), target: "bob" });
  for (let e = 1; e <= 16; e++) assert.equal((await s.commit(s.alice, s.ad, g.group, e)).state, "accepted");
  await settle();
  const control = () => box.got.filter((x) => x.m.kind !== "app");
  assert.ok(control().length >= 1 && control().every((x) => x.m.generation === 1));
  // The replacement removes every queued control frame of generation 1, the in-flight ones too.
  const group = groupId();
  const res = await s.take(s.alice, s.ad, s.B, s.bd);
  assert.equal((await s.alice.rpc({ type: "group_replace", op: newOp(), device: s.ad.device, peer: s.B, expected_generation: 1, group, epoch: 1, welcome: { recipients: [s.bd.device], mls: blob() }, kp_reservations: [res] })).generation, 2);
  await settle();
  const w2 = control().filter((x) => x.m.generation === 2);
  assert.deepEqual(w2.map((x) => x.m.kind), ["welcome"], "the replacement's Welcome is not blocked by removed in-flight frames");
  // Late acknowledgements of the removed frames: nothing is answered, nothing else leaves the queue.
  const before = s.w.ds.usage({ member: s.B, device: s.bd.device }).messages;
  for (const x of control().filter((x) => x.m.generation === 1)) x.ack();
  await settle();
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd.device }).messages, before);
  // The connection works on: the current group's commits arrive and are acknowledged.
  w2[0].ack();
  assert.equal((await s.commit(s.alice, s.ad, group, 1)).state, "accepted");
  await settle();
  const c2 = control().filter((x) => x.m.generation === 2 && x.m.kind === "commit");
  assert.equal(c2.length, 1);
  c2[0].ack();
  await settle();
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd.device }).messages, 49);
});

test("gates 1 and 2 apply to encrypted messages: at a new conversation, at send, and again at dispatch", async (t) => {
  let acc;
  const grants = (rev, entries) => acc.putGrants(s.B, rev, { default: "deny", visible: "all", entries });
  const s = await setup(t, {
    access: () => (acc = createAccess({ stateDir: tmpDir(t), policy: null })),
  });
  grants(0, [{ selector: `member:${s.A}`, action: "allow" }]);
  // carol may not start a conversation with bob; alice may.
  const carolTry = await refusal(s.carol.rpc({ type: "group_create", op: newOp(), device: s.cd.device, peer: s.B, group: groupId(), epoch: 1, welcome: null, kp_reservations: [] }));
  assert.equal(carolTry.code, "not_allowed");
  const { answer: g } = await s.create({ targets: [s.bd] });
  assert.ok(g.group);
  const app = () => s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob" });
  assert.equal((await app()).state, "accepted", "queued while allowed");
  // bob withdraws alice's grant: new sends are refused, and the queued one is dropped at dispatch.
  grants(1, []);
  assert.equal((await refusal(app())).code, "not_allowed");
  const bob = await s.w.client("bob", { session: "bob" });
  const box = inbox(bob);
  await box.attach(s.bd);
  await settle();
  assert.ok(box.got.every((x) => x.m.kind !== "app"), "no application message delivered");
  for (const x of box.got) x.ack(); // the Welcome
  await settle();
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd.device }).messages, 0, "and it left the queue");
});

// ---- the relay admin (design 4.4) ---------------------------------------------------------------

/** Suspend a device as a restore with an unreadable old store does (phase 4). */
const suspend = (w, member, device) => w.db.tx((h) => h.run("UPDATE devices SET suspended = 1 WHERE member_id = ? AND device_id = ?", member, device));

test("suspension in the Delivery Service: attach, publication and catch-up refused; frames to and from it held under their expiry until reinstated", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd, s.bd2] });
  const main = await s.w.client("bob", { session: "bob-main" });
  const bm = inbox(main);
  await bm.attach(s.bd); // attached before the suspension
  (await bm.wait(1))[0].ack();
  // A message for bob's second device, queued while it has no connection.
  assert.equal((await s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob-main2" })).state, "accepted");
  suspend(s.w, s.B, s.bd.device);
  suspend(s.w, s.A, s.ad.device);
  // The connection attached before: no commit, no message, no catch-up, no report.
  assert.equal((await refusal(s.commit(main, s.bd, g.group, 1))).code, "device_suspended");
  assert.equal((await refusal(main.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.bd.device, group: g.group, mls: blob(), target: "alice" }))).code, "device_suspended");
  assert.equal((await refusal(main.rpc({ type: "commits_since", device: s.bd.device, group: g.group, epoch: 1 }))).code, "device_suspended");
  assert.equal((await refusal(main.rpc({ type: "commit_invalid", device: s.bd.device, group: g.group, epoch: 1 }))).code, "device_suspended");
  assert.equal((await refusal(s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob-main" }))).code, "device_suspended");
  // Attach refused, on any connection.
  const again = await s.w.client("bob", { session: "bob-again" });
  assert.equal((await refusal(inbox(again).attach(s.bd))).code, "device_suspended");
  assert.equal((await refusal(inbox(await s.w.client("alice", { session: "alice-x" })).attach(s.ad))).code, "device_suspended");
  // Frames to bob's second device from alice's suspended device are held, not dispatched.
  const second = await s.w.client("bob", { session: "bob-main2" });
  const b2 = inbox(second);
  await b2.attach(s.bd2);
  await settle();
  assert.equal(b2.got.length, 0, "the Welcome and the message from the suspended device are held");
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd2.device }).messages, 2, "still queued");
  assert.deepEqual(s.w.ds.pending({ member: s.B, device: s.bd.device }), [], "nothing is read for a suspended device");
  // Reinstating alice's device lets them go.
  s.w.directory.reinstate({ member: s.A, device: s.ad.device });
  s.w.relay.devicesChanged();
  const got = await b2.wait(2);
  assert.deepEqual(got.map((x) => x.m.kind).sort(), ["app", "welcome"]);
  // Held frames keep their own expiry: a week later the message for the suspended device is gone.
  const before = s.w.ds.usage({ member: s.B, device: s.bd.device }).messages;
  assert.ok(before >= 1);
  s.w.clock.advance(8 * DAY);
  s.w.ds.sweep();
  assert.equal(s.w.ds.usage({ member: s.B, device: s.bd.device }).messages, before - 1, "the application message expired while held");
  // Reinstated, bob's first device attaches and publishes again.
  s.w.directory.reinstate({ member: s.B, device: s.bd.device });
  const back = await s.w.client("bob", { session: "bob-back" });
  assert.equal((await inbox(back).attach(s.bd)).type, "e2ee_attached");
});

test("a restored conversation (replace_required) refuses commits until group_replace; commit_invalid is a security event in the audit log", async (t) => {
  const events = [];
  const s = await setup(t);
  const w2 = await deviceRelay(t, { e2ee: true, audit: (action, detail) => events.push([action, detail]) });
  void w2;
  const { answer: g } = await s.create({ targets: [s.bd] });
  s.w.db.tx((h) => h.run("UPDATE e2ee_groups SET replace_required = 1 WHERE group_id = ?", g.group));
  const refused = await refusal(s.commit(s.alice, s.ad, g.group, 1));
  assert.equal(refused.code, "replace_required");
  // New application messages are refused too: the clients' epochs may have diverged (RA4).
  assert.equal((await refusal(s.alice.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: g.group, mls: blob(), target: "bob" }))).code, "replace_required");
  const res = [await s.take(s.bob, s.bd, s.A, s.ad)];
  const r = await s.bob.rpc({ type: "group_replace", op: newOp(), device: s.bd.device, peer: s.A, expected_generation: 1, group: groupId(), epoch: 1, welcome: { recipients: [s.ad.device], mls: blob() }, kp_reservations: res });
  assert.equal(r.generation, 2);
  assert.equal((await s.commit(s.bob, s.bd, r.group, 1)).state, "accepted", "the new group accepts commits");
  // commit_invalid reaches the relay's audit hook.
  const a = await w2.client("alice");
  const b = await w2.client("bob");
  const ad = await fakeDevice(w2.realm, w2.members.alice.id);
  const bd = await fakeDevice(w2.realm, w2.members.bob.id);
  await a.rpc(ad.register());
  await b.rpc(bd.register());
  await b.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(1, w2.clock.now() + KP_LIFETIME_MS) });
  const kp = await a.rpc({ type: "kp_take", request: reqId(), device: ad.device, target: { member: w2.members.bob.id, device: bd.device } });
  const grp = groupId();
  await a.rpc({ type: "group_create", op: newOp(), device: ad.device, peer: w2.members.bob.id, group: grp, epoch: 1, welcome: { recipients: [bd.device], mls: blob() }, kp_reservations: [kp.reservation] });
  await b.rpc({ type: "commit_invalid", device: bd.device, group: grp, epoch: 1, reason: "bad" });
  assert.deepEqual(events, [["e2ee.commit_invalid", { group: grp, epoch: 1 }]]);
});

test("replace_required is in the conversation and catch-up answers; new messages into a marked group are refused, earlier operations keep their answers", async (t) => {
  const s = await setup(t);
  const { answer: g } = await s.create({ targets: [s.bd] });
  const appFrame = (op) => ({ type: "send_e2ee", kind: "app", op, device: s.ad.device, group: g.group, mls: blob(48, 3), target: "bob" });
  const earlier = newOp();
  assert.equal((await s.alice.rpc(appFrame(earlier))).state, "accepted");
  const unknownOp = newOp();
  s.w.db.tx((h) => h.run("UPDATE e2ee_groups SET replace_required = 1 WHERE group_id = ?", g.group));
  assert.equal((await s.alice.rpc({ type: "conversation", peer: s.B })).replace_required, true);
  assert.equal((await s.bob.rpc({ type: "commits_since", device: s.bd.device, group: g.group, epoch: 1 })).replace_required, true);
  const refused = await refusal(s.alice.rpc(appFrame(newOp())));
  assert.equal(refused.code, "replace_required");
  // The same operation again: its original answer. A reconciliation of an op never accepted: cancelled.
  assert.equal((await s.alice.rpc(appFrame(earlier))).state, "accepted");
  assert.equal((await s.alice.rpc({ ...appFrame(unknownOp), reconcile: true })).state, "cancelled");
  // The replacement starts unmarked.
  const res = [await s.take(s.bob, s.bd, s.A, s.ad)];
  const r = await s.bob.rpc({ type: "group_replace", op: newOp(), device: s.bd.device, peer: s.A, expected_generation: 1, group: groupId(), epoch: 1, welcome: { recipients: [s.ad.device], mls: blob() }, kp_reservations: res });
  const now = await s.alice.rpc({ type: "conversation", peer: s.B });
  assert.deepEqual([now.group, now.replace_required], [r.group, false]);
});
