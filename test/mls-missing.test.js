// A pinned device the relay stops listing (design 3.2 v2.2, amendments-3.5-prep A4), experimental:
// a missing directory row is not a revocation (no removal commit, sending held, never "sent"),
// delivery resumes when it is listed again, the owner's forget-device removes it with one commit;
// an op that would reach no device of the contact is never submitted (the relay refuses it as a
// second line, no_recipient), and one accepted anyway with no peer device keeps its result, is
// reported not delivered, reconciles to the same result and is sealed again once after repair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCommand } from "../lib/mls/cli.js";
import { noPeerEvidence } from "../lib/mls/e2ee.js";
import { describeE2ee } from "../lib/mls/session.js";
import { acceptOwnDevices, deviceRelay, e2eeDevice, newOp, refusal, until } from "./mls-helpers.js";

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const commits = (w, gid) => w.db.get("SELECT count(*) AS n FROM e2ee_log WHERE group_id = ?", gid).n;
const appOps = (w) => w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app'").n;

/** The relay, as `client` sees it, omits the devices in `hidden` from every device list. */
function omit(client, hidden) {
  const rpc = client.rpc.bind(client);
  client.rpc = async (f) => {
    const r = await rpc(f);
    return f.type === "device_list" ? { ...r, devices: r.devices.filter((d) => !hidden.has(d.device)) } : r;
  };
}
/** alice and bob with one delivered message (alice pinned bob's device on first use). */
async function pair(t, opts = {}) {
  const w = await deviceRelay(t, { e2ee: true, ...opts });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "first" })).state, "accepted");
  await until(() => b.s.bob.got.length === 1, "first");
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  return { w, a, b, gid };
}

test("A4: the relay hides all of a contact's pinned devices: no removal commit, no 'sent', held; listed again: delivered; forget-device then removes it with one commit", async (t) => {
  const { w, a, b, gid } = await pair(t);
  const hidden = new Set([b.device]);
  omit(a.s.alice.client, hidden);
  const before = commits(w, gid);
  const r = await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "while hidden" });
  assert.equal(r.state, "held", "never reported as sent");
  assert.match(r.reason, new RegExp(`the relay no longer lists device ${b.device} of ${b.id}`));
  assert.match(describeE2ee("bob", r), /^Not sent yet/);
  assert.equal(commits(w, gid), before, "no removal commit");
  assert.ok(w.ds.roster(gid).some((d) => d.device === b.device), "kept in the group");
  await settle();
  assert.equal(b.s.bob.got.length, 1);
  // Listed again: delivery resumes, once.
  hidden.clear();
  assert.equal(await a.s.alice.e2ee.releaseHeld(b.id), 1);
  await until(() => b.s.bob.got.length === 2, "delivered after the list is restored");
  assert.equal(b.s.bob.got[1].text, "while hidden");
  // Gone again, and the owner forgets it (hoptell contacts forget-device): one removal commit.
  hidden.add(b.device);
  const connect = async () => {
    const c = await w.client("alice");
    omit(c, hidden);
    return c;
  };
  const opts = { sub: "forget-device", member: b.id, device: b.device, home: a.dir, profile: a.profile, connect, contacts: a.contacts };
  const out = [];
  await verifyCommand({ ...opts, say: (x) => out.push(x) });
  await verifyCommand({ ...opts, set: /--set ([0-9a-f]{32})/.exec(out.at(-1))[1], say: () => {} });
  const removal = commits(w, gid);
  const after = await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after forgetting" });
  assert.equal(commits(w, gid), removal + 1, "removed with one commit");
  assert.ok(!w.ds.roster(gid).some((d) => d.device === b.device));
  assert.equal(after.state, "held", "no device of bob is left: held, not sent");
  assert.match(after.reason, /no device of .* is in the conversation/);
});

test("A4: a roster with only the sender's own other devices counts as no recipient: the engine holds, and the relay refuses no_recipient", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const a2 = await e2eeDevice(t, w, "alice", { sessions: [] });
  await acceptOwnDevices(a, a2);
  const b = await e2eeDevice(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "first" });
  await until(() => b.s.bob.got.length === 1, "first");
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  // bob's only device is revoked: alice removes it; her own other device remains.
  w.directory.revoke({ member: b.id, device: b.device, by: { kind: "admin" } });
  const ops = appOps(w);
  const r = await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "nobody of bob" });
  assert.deepEqual(w.ds.roster(gid).map((d) => d.member).sort(), [a.id, a.id]);
  assert.equal(r.state, "held");
  assert.equal(appOps(w), ops, "no op submitted");
  // The relay's second line: an op to that roster is refused before acceptance, nothing recorded.
  const e = await refusal(Promise.resolve().then(() => w.ds.sendApp({ requester: { member: a.id, device: a.device }, op: newOp(), group: gid, mls: Buffer.from("x").toString("base64"), target: "bob" })));
  assert.equal(e.code, "no_recipient");
  assert.equal(appOps(w), ops);
});

test("A4: an op accepted with zero peer devices (a relay without the refusal) is reported not delivered; a lost reply reconciles to the same result; repair reseals it once as a new op", async (t) => {
  const { w, a, b, gid } = await pair(t, { dsCompat: { recipientCheck: false } });
  // The relay's roster loses bob's device while alice's view still holds it (a race, or an older relay).
  const row = w.db.get("SELECT * FROM e2ee_roster WHERE group_id = ? AND device_id = ?", gid, b.device);
  w.db.tx((h) => h.run("DELETE FROM e2ee_roster WHERE group_id = ? AND device_id = ?", gid, b.device));
  // The answer is lost: recovery reconciles it by op id.
  const rpc = a.s.alice.client.rpc.bind(a.s.alice.client);
  let lose = true;
  a.s.alice.client.rpc = async (f) => {
    const r = await rpc(f);
    if (lose && f.type === "send_e2ee" && f.kind === "app") {
      lose = false;
      throw Object.assign(new Error("relay did not answer in time"), { kind: "no_answer" });
    }
    return r;
  };
  const ops = appOps(w);
  const r = await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "to nobody" });
  assert.equal(r.state, "unsent");
  assert.equal(appOps(w), ops + 1, "the relay accepted it");
  const op = w.db.get("SELECT op, result FROM e2ee_ops WHERE kind = 'app' ORDER BY created DESC, rowid DESC LIMIT 1");
  assert.equal(JSON.parse(op.result).peerRecipients, 0);
  const rec = await a.s.alice.e2ee.recover();
  assert.ok(rec.messages >= 1);
  assert.equal(appOps(w), ops + 1, "reconciled to the recorded result, never resent as that op");
  assert.equal(await a.s.alice.e2ee.messageState(r.message_id), "held", "not delivered");
  assert.match(describeE2ee("bob", { state: "undelivered", reason: "accepted by the relay with no device", message_id: r.message_id }), /^Not delivered/);
  await a.s.alice.e2ee.recover();
  assert.equal(appOps(w), ops + 1, "nothing resealed while the roster has no device of bob");
  // Repaired (the conversation is rebuilt; its new group holds bob's device): sealed again once,
  // as a new op, and delivered.
  w.db.tx((h) => h.run("INSERT INTO e2ee_roster (group_id, member_id, device_id) VALUES (?, ?, ?)", row.group_id, row.member_id, row.device_id));
  await a.s.alice.e2ee.replace(b.id);
  await a.s.alice.e2ee.recover();
  await until(() => b.s.bob.got.some((m) => m.text === "to nobody"), "delivered after the repair");
  // One new op for it; the replacement also seals "first" again (MII8: messages of a replaced
  // group are sealed again; bob drops the repeat by its id).
  assert.equal(appOps(w), ops + 3, "one new op for it (and MII8's reseal of the earlier message)");
  const fresh = w.db.all("SELECT op, result FROM e2ee_ops WHERE kind = 'app' AND op != ?", op.op).slice(-2);
  assert.ok(fresh.every((x) => JSON.parse(x.result).peerRecipients === 1), "the new ops reached bob's device");
  await a.s.alice.e2ee.recover();
  await settle();
  assert.equal(b.s.bob.got.filter((m) => m.text === "to nobody").length, 1, "exactly once");
});

test("A4 evidence: peerRecipients when the relay answers it; an older relay's answer is judged by the roster recorded at seal; never by the total", () => {
  const me = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const own = [{ member: me, device: "d1" }, { member: me, device: "d2" }];
  const withPeer = [...own, { member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", device: "d3" }];
  assert.equal(noPeerEvidence({ state: "accepted", recipients: 1, peerRecipients: 0 }, withPeer, me), true, "peerRecipients 0: not delivered, whatever the total");
  assert.equal(noPeerEvidence({ state: "accepted", recipients: 2, peerRecipients: 1 }, own, me), false);
  assert.equal(noPeerEvidence({ state: "accepted", recipients: 1 }, own, me), true, "older relay: only own devices at seal");
  assert.equal(noPeerEvidence({ state: "accepted", recipients: 0 }, withPeer, me), false, "older relay: a peer device at seal (the total is not evidence)");
  assert.equal(noPeerEvidence({ state: "accepted", recipients: 1 }, undefined, me), false, "no evidence: delivered as before");
});
