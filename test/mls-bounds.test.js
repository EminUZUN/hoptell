// The skipped-key bounds of existing groups (design 3.2 v2.2, amendment A6 for groups made by an
// earlier binding, Codex R21), experimental: a group whose own bounds are not policy.js's 10 and
// 200 (manifest 4's binding made them with 5 and 1000), or unknown (a binding without the query),
// is replaced before more application traffic, through the replacement path (one replacement, no
// wedge), on first use or on load; a driver whose new groups would not comply stops instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeDriver } from "./fake-mls-driver.js";
import { deviceRelay, e2eeDevice, until, tmpDir } from "./mls-helpers.js";

const generations = (w) => w.db.all("SELECT generation FROM e2ee_groups ORDER BY generation").map((g) => g.generation);

/** Mark the current group of `d`'s conversation with `peer` as made with bounds `bounds` (null: unknown), as an earlier binding made it. */
async function madeWith(d, peer, bounds) {
  const gid = (await d.s[Object.keys(d.s)[0]].e2ee.checkpoint(peer.id)).group;
  await d.store.transact(async (ctx) => {
    ctx.dev._state.mls[gid].skip = bounds;
    await ctx.save();
  }, { act: false });
  return gid;
}
/** alice and bob whose drivers share `skip` (the bounds new groups are made with), one message delivered. */
async function pair(t, skip = { perSenderEpoch: 10, forward: 200 }) {
  const w = await deviceRelay(t, { e2ee: true });
  const make = (member) => {
    const dir = tmpDir(t);
    return e2eeDevice(t, w, member, { dir, driver: createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now, skip }) });
  };
  const a = await make("alice");
  const b = await make("bob");
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "made by the earlier binding" })).state, "accepted");
  await until(() => b.s.bob.got.length === 1, "first");
  return { w, a, b };
}

test("A6 existing groups: a group made with 5/1000 is replaced before the next send (one replacement), and traffic goes on there", async (t) => {
  const { w, a, b } = await pair(t);
  // Both devices' group was made by the earlier binding (5/1000); the binding now makes 10/200.
  const old = await madeWith(a, b, { perSenderEpoch: 5, forward: 1000 });
  await madeWith(b, a, { perSenderEpoch: 5, forward: 1000 });
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after the upgrade" })).state, "accepted");
  assert.deepEqual(generations(w), [1, 2], "one replacement");
  const fresh = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  assert.notEqual(fresh, old);
  await until(() => b.s.bob.got.some((m) => m.text === "after the upgrade"), "read in the replacement");
  assert.equal((await b.s.bob.e2ee.checkpoint(a.id)).group, fresh);
  assert.equal((await b.s.bob.e2ee.send({ to: { member: a.id, session: "alice" }, body: "back" })).state, "accepted");
  await until(() => a.s.alice.got.some((m) => m.text === "back"), "and back");
  assert.deepEqual(generations(w), [1, 2], "no further replacement (no wedge, no loop)");
});

test("A6 existing groups: unknown bounds (a binding without the query) count as out of bounds and are replaced on load", async (t) => {
  const { w, a, b } = await pair(t);
  await madeWith(a, b, null);
  await madeWith(b, a, null);
  // bob's next start (attach) replaces his conversation before any send.
  const s = await b.open("bob-2");
  assert.deepEqual(generations(w), [1, 2], "replaced on load");
  await until(async () => (await a.s.alice.e2ee.checkpoint(b.id))?.generation === 2, "alice joined the replacement");
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob-2" }, body: "in the replacement" })).state, "accepted");
  await until(() => s.got.some((m) => m.text === "in the replacement"), "delivered");
  assert.deepEqual(generations(w), [1, 2]);
});

test("A6 existing groups: an application message in an out-of-bounds group is refused, and its sender seals it again in the replacement", async (t) => {
  const { w, a, b } = await pair(t);
  b.s.bob.client.close();
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "sealed in the old group" });
  const frame = w.ds.pending({ member: b.id, device: b.device, limit: 100 }).find((f) => f.kind === "app");
  assert.ok(frame);
  await madeWith(b, a, { perSenderEpoch: 5, forward: 1000 });
  const recv = b.engine(await b.proven(), "bob");
  assert.equal(await recv.e2ee.receive(frame, () => {}), "refused", "no application traffic in the old group");
  assert.equal(recv.got.length, 0);
  // bob's conversation is replaced (as on load); alice seals her message again there (MII8).
  await until(() => generations(w).length === 2, "replaced");
  const s = await b.open("bob");
  await until(() => s.got.some((m) => m.text === "sealed in the old group"), "delivered in the replacement");
  assert.equal(s.got.filter((m) => m.text === "sealed in the old group").length, 1, "once");
  assert.deepEqual(generations(w), [1, 2]);
});

test("A6 existing groups: a driver whose new groups would not comply stops encrypted sending instead of replacing in a loop", async (t) => {
  const skip = { perSenderEpoch: 10, forward: 200 };
  const { w, a, b } = await pair(t, skip);
  await madeWith(a, b, { perSenderEpoch: 5, forward: 1000 });
  Object.assign(skip, { perSenderEpoch: 5, forward: 1000 }); // the binding itself still makes 5/1000
  await assert.rejects(a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "no" }), (e) => e.code === "skip_limits");
  assert.deepEqual(generations(w), [1], "no replacement");
});

test("A6 receive boundary: an imported group with 5/1000 never processes an inbound application message (generation above 200); one replacement, then traffic both ways", async (t) => {
  const { w, a, b } = await pair(t);
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  b.s.bob.client.close();
  // alice's sending generation moves past 200 in the group (as 201 messages would).
  await a.store.transact(async (ctx) => {
    const g = ctx.dev.group(Buffer.from(gid, "hex"));
    for (let i = 0; i < 201; i++) await g.encrypt(Buffer.from("x"), new Uint8Array());
    await ctx.save();
  });
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "generation above 200" });
  const frame = w.ds.pending({ member: b.id, device: b.device, limit: 100 }).find((f) => f.kind === "app");
  assert.ok(JSON.parse(Buffer.from(frame.mls, "base64").subarray(8, 8 + Buffer.from(frame.mls, "base64").readUInt32BE(4)).toString()).gen > 200, "the ciphertext is at a generation above 200");
  // bob's copy of the group was imported from the earlier binding: its own bounds are 5/1000.
  await madeWith(b, a, { perSenderEpoch: 5, forward: 1000 });
  const lib = () => b.store.transact(async (ctx) => Buffer.from(await ctx.dev.exportState()), { act: false });
  const before = await lib();
  const recv = b.engine(await b.proven(), "bob");
  let acked = null;
  assert.equal(await recv.e2ee.receive(frame, (o) => (acked = o)), "refused", "not processed");
  assert.equal(acked, "refused");
  assert.equal(recv.got.length, 0, "nothing decrypted or delivered");
  const consumed = JSON.parse((await lib()).toString()).mls[gid].consumed;
  assert.deepEqual(consumed, JSON.parse(before.toString()).mls[gid].consumed, "no generation of alice's was consumed");
  // The replacement is driven from there, once; alice seals her message again in it.
  await until(() => generations(w).length === 2, "replaced");
  const s = await b.open("bob");
  await until(() => s.got.some((m) => m.text === "generation above 200"), "delivered in the replacement");
  assert.equal(s.got.filter((m) => m.text === "generation above 200").length, 1);
  assert.equal((await s.e2ee.send({ to: { member: a.id, session: "alice" }, body: "back" })).state, "accepted");
  await until(() => a.s.alice.got.some((m) => m.text === "back"), "and back");
  assert.deepEqual(generations(w), [1, 2], "one replacement");
});

test("A6 new groups: a first send with an old-limit driver (unknown, 5/1000) creates no group, sends nothing and answers skip_limits", async (t) => {
  for (const skip of [{ perSenderEpoch: 10, forward: 200, unknown: true }, { perSenderEpoch: 5, forward: 1000 }]) {
    const w = await deviceRelay(t, { e2ee: true });
    const dir = tmpDir(t);
    const a = await e2eeDevice(t, w, "alice", { dir, driver: createFakeDriver({ seed: `alice-${dir}`, now: w.clock.now, skip }) });
    const b = await e2eeDevice(t, w, "bob");
    await assert.rejects(a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "first" }), (e) => e.code === "skip_limits");
    assert.deepEqual(generations(w), [], "no group at the relay");
    assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_ops").n, 0, "nothing sent");
    assert.equal(w.db.get("SELECT count(*) AS n FROM kp_reservations").n, 0, "no KeyPackage taken");
    const lib = await a.store.transact(async (ctx) => Object.keys(ctx.dev._state.mls), { act: false });
    assert.deepEqual(lib, [], "no group in the device's state");
  }
});

test("A6 new groups: a replacement under an old-limit driver does the same; a driver whose new group differs from what it reports is caught too", async (t) => {
  const skip = { perSenderEpoch: 10, forward: 200 };
  const { w, a, b } = await pair(t, skip);
  for (const change of [{ unknown: true }, { perSenderEpoch: 5, forward: 1000 }, { groups: { perSenderEpoch: 5, forward: 1000 } }]) {
    Object.assign(skip, { perSenderEpoch: 10, forward: 200 }, change);
    if (!("unknown" in change)) delete skip.unknown;
    if (!("groups" in change)) delete skip.groups;
    const ops = w.db.get("SELECT count(*) AS n FROM e2ee_ops").n;
    await assert.rejects(a.s.alice.e2ee.replace(b.id), (e) => e.code === "skip_limits", JSON.stringify(change));
    assert.deepEqual(generations(w), [1], `${JSON.stringify(change)}: no replacement group`);
    assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_ops").n, ops, "nothing sent");
  }
  // A compliant driver again: the conversation goes on in its group.
  delete skip.groups;
  Object.assign(skip, { perSenderEpoch: 10, forward: 200 });
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "still here" })).state, "accepted");
  await until(() => b.s.bob.got.some((m) => m.text === "still here"), "delivered");
});
