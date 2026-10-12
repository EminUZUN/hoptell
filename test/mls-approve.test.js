// A new device needs an existing device's approval at the relay (amendments 3.5 part 3, A12;
// review checklist G2), experimental: a member that has an enrolled, unrevoked device registers
// another only with an approval, signed by one of its devices (or given by the relay admin), of a
// pending request the new device made with its key's proof. Pending requests are no devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_MAX_S, b64, makeApproval, makeRevocation, makeRotation, pinIdentity } from "../lib/mls/identity.js";
import { PENDING_MS } from "../lib/mls/relaydir.js";
import { KP_LIFETIME_MS } from "../lib/mls/policy.js";
import { evaluate } from "../lib/mls/trust.js";
import { evaluateOwn } from "../lib/mls/own.js";
import { createAdmin } from "../lib/admin.js";
import { deviceRelay, fakeDevice, newOp, proveOn, refusal } from "./mls-helpers.js";

const sec = (w) => Math.floor(w.clock.now() / 1000);
const reqId = () => `req-a12-${Math.random().toString(36).slice(2, 10)}`;

/** A relay without the tests' automatic approval; alice's first device a1, attached on c1. */
async function setup(t, opts = {}) {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true, ...opts });
  const A = w.members.alice.id;
  const a1 = await fakeDevice(w.realm, A);
  const c1 = await w.client("alice");
  assert.equal((await register(c1, a1)).state, "enrolled", "the first device registers without approval (the bootstrap)");
  await a1.attachOn(c1);
  const fresh = async (member = A, name = "alice") => ({ d: await fakeDevice(w.realm, member), c: await w.client(name) });
  return { w, A, a1, c1, fresh };
}
/** device_register with a register proof (never approved by the helpers). */
const register = async (c, d, extra = {}) => c.rpc({ ...d.register(), proof: await d.proof(c, "register"), ...extra });
/** device_request with a register proof. */
const request = async (c, d) => c.rpc({ type: "device_request", device: d.device, key: b64(d.key), proof: await d.proof(c, "register") });
/** An approval by fake device `by` of `member` for `d` (overrides for the refusal cases). */
const approval = (w, member, by, d, o = {}) => {
  const issuedAt = o.issuedAt ?? sec(w);
  return makeApproval({ realm: w.realm, member: o.member ?? member, approver: o.approver ?? by.device, device: o.device ?? d.device, key: o.key ?? d.key, issuedAt, expiry: o.expiry ?? issuedAt + APPROVAL_MAX_S }, (l, c) => by.dev.sign(l, c));
};
/** device_approve, with the live request's `requested` (device_pending) unless given. */
const approve = async (c, a, requested) => {
  if (requested === undefined) requested = await c.rpc({ type: "device_pending" }).then((r) => r.requests?.find((x) => x.device === a.device)?.requested ?? 0, () => 0);
  return c.rpc({ type: "device_approve", approval: a, requested });
};
const count = (w, table) => Number(w.db.get(`SELECT count(*) AS n FROM ${table}`).n);

test("A12: the first device registers without approval; a second one without an approval is refused, with one it registers once", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  const r = await refusal(register(c, d));
  assert.equal(r.code, "approval_required");
  assert.match(r.message, /device_request/);
  assert.equal(count(w, "devices"), 1, "nothing registered");
  assert.equal((await request(c, d)).state, "pending");
  assert.equal((await approve(c1, await approval(w, A, a1, d))).state, "approved");
  const ok = await register(c, d);
  assert.equal(ok.state, "enrolled");
  assert.equal(count(w, "device_requests"), 0, "the pending request is consumed with the approval");
  assert.equal(count(w, "devices"), 2);
  assert.equal((await d.attachOn(c)).type, "e2ee_attached");
});

test("A12: a pending request has no device privileges: no attach, no guard, no KeyPackages, no roster, no deliveries, never in device_list or pinning", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const B = w.members.bob.id;
  const bd = await fakeDevice(w.realm, B);
  const cb = await w.client("bob");
  await register(cb, bd);
  await bd.attachOn(cb);
  await cb.rpc({ type: "kp_upload", device: bd.device, packages: await bd.packages(2, w.clock.now() + KP_LIFETIME_MS) });
  const { d, c } = await fresh();
  assert.equal((await request(c, d)).state, "pending");
  // Also when approved: only the registration makes it a device.
  await approve(c1, await approval(w, A, a1, d));
  // No attachment, so no guard passes and no delivery goes to it.
  assert.equal((await refusal(d.attachOn(c))).code, "no_device");
  assert.equal((await refusal(c.rpc({ type: "kp_upload", device: d.device, packages: await d.packages(1, w.clock.now() + KP_LIFETIME_MS) }))).code, "not_attached");
  assert.equal((await refusal(c.rpc({ type: "kp_status", device: d.device }))).code, "not_attached");
  assert.equal((await refusal(c.rpc({ type: "device_pending" }))).code, "not_attached");
  assert.equal((await refusal(c.rpc({ type: "device_revoke", device: a1.device, by_device: d.device, statement: null }))).code, "not_attached");
  assert.equal(count(w, "key_packages"), 2, "only bob's packages");
  // No KeyPackage to take, so no conversation (roster) can add it, and no fan-out targets it.
  assert.equal((await refusal(cb.rpc({ type: "kp_take", request: reqId(), device: bd.device, target: { member: A, device: d.device } }))).code, "no_device");
  // Directly: bob's conversation with alice holds alice's registered device and bob's, never the
  // pending one; the Welcome and a message (fan-out over the roster) are queued for neither it.
  await c1.rpc({ type: "kp_upload", device: a1.device, packages: await a1.packages(1, w.clock.now() + KP_LIFETIME_MS) });
  const { reservation } = await cb.rpc({ type: "kp_take", request: reqId(), device: bd.device, target: { member: A, device: a1.device } });
  const g = await cb.rpc({ type: "group_create", op: newOp(), device: bd.device, peer: A, group: "a".repeat(32), epoch: 1, welcome: { recipients: [a1.device], mls: b64(Buffer.alloc(48, 1)) }, kp_reservations: [reservation] });
  assert.equal(g.type, "group");
  assert.deepEqual(w.ds.roster(g.group).map((x) => x.device).sort(), [a1.device, bd.device].sort());
  assert.equal((await cb.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: bd.device, group: g.group, mls: b64(Buffer.alloc(48, 2)), target: "alice" })).state, "accepted");
  const queued = w.db.all("SELECT device_id FROM e2ee_queue WHERE member_id = ?", A).map((r) => r.device_id);
  assert.ok(queued.length >= 2 && queued.every((x) => x === a1.device), "the Welcome and the message go to a1 only");
  assert.equal(Number(w.db.get("SELECT count(*) AS n FROM e2ee_queue WHERE device_id = ?", d.device).n), 0);
  // An attempt to add it to the roster by name is refused: no reservation exists for it.
  assert.ok((await refusal(cb.rpc({ type: "send_e2ee", kind: "commit", op: newOp(), device: bd.device, group: g.group, expected_epoch: 1, mls: b64(Buffer.alloc(48, 3)), roster_delta: { add: [d.device], remove: [] }, kp_reservations: [] }))).code);
  assert.ok(!w.ds.roster(g.group).some((x) => x.device === d.device));
  // Never listed: neither to the member nor to a peer; pinning judges only listed devices.
  for (const conn of [c1, cb]) {
    const list = await conn.rpc({ type: "device_list", member: A });
    assert.deepEqual(list.devices.map((x) => x.device), [a1.device]);
    const doc = { version: 1, revision: 0, default: "ask", grants: [], blocks: [] };
    assert.ok(!evaluate(doc, w.realm, A, list.devices).active.some((x) => x.device === d.device));
    const own = { member: A, profile: "p", devices: [{ device: a1.device, key: b64(a1.key), pin: b64(pinIdentity({ realm: w.realm, member: A, device: a1.device, key: a1.key })), seq: 0, retired: [], how: "enrolled", at: 1 }], unconfirmed: [] };
    const ev = evaluateOwn(own, w.realm, list.devices);
    assert.deepEqual([ev.unaccepted.length, ev.accepted.length], [0, 1]);
  }
  assert.ok(!w.directory.list(A).some((x) => x.device === d.device), "not in the directory's devices");
});

test("A12: device_pending answers only the member's own proven devices (and the admin channel)", async (t) => {
  const { w, A, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  await request(c, d);
  const r = await c1.rpc({ type: "device_pending" });
  assert.equal(r.member, A);
  assert.deepEqual(r.requests.map((x) => [x.device, x.key, x.approved]), [[d.device, b64(d.key), false]]);
  assert.ok(r.requests[0].requested > 0 && r.requests[0].expires === r.requests[0].requested + PENDING_MS);
  // An unattached connection of the member: refused.
  const plain = await w.client("alice");
  assert.equal((await refusal(plain.rpc({ type: "device_pending" }))).code, "not_attached");
  // Another member's proven device sees only its own (none), never alice's.
  const bd = await fakeDevice(w.realm, w.members.bob.id);
  const cb = await w.client("bob");
  await register(cb, bd);
  await bd.attachOn(cb);
  assert.deepEqual((await cb.rpc({ type: "device_pending" })).requests, []);
  assert.equal((await refusal(cb.rpc({ type: "device_pending", member: A }))).code, "not_allowed");
  // The admin channel.
  const admin = createAdmin({ stateDir: w.dir, db: w.db, realm: w.realm, config: {}, now: w.clock.now });
  const v = await admin.call("pending", { member: A });
  assert.deepEqual(v.rows.map((x) => x.device), [d.device]);
});

test("A12: 4 ordinary pending requests fill the slots and block a fifth until the owner cancels; the sixth with the reserved slot taken is refused", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  // A credential holder's flood: four requests.
  for (let i = 0; i < 4; i++) {
    const { d, c } = await fresh();
    assert.equal((await request(c, d)).state, "pending");
  }
  const mine = await fresh();
  assert.equal((await refusal(request(mine.c, mine.d))).code, "too_many_requests", "the legitimate new device is blocked");
  // The owner cancels the flood from a proven device.
  const flood = (await c1.rpc({ type: "device_pending" })).requests.map((x) => x.device);
  assert.equal(flood.length, 4);
  for (const device of flood) assert.equal((await c1.rpc({ type: "device_pending_cancel", device, by_device: a1.device })).state, "cancelled");
  assert.equal((await request(mine.c, mine.d)).state, "pending");
  // Refill: 3 more ordinary (4 in all), one expected device in the reserved slot, then a sixth.
  for (let i = 0; i < 3; i++) {
    const { d, c } = await fresh();
    await request(c, d);
  }
  const exp = await fresh();
  await c1.rpc({ type: "device_expect", device: exp.d.device, pin: b64(pinIdentity({ realm: w.realm, member: A, device: exp.d.device, key: exp.d.key })), by_device: a1.device });
  assert.equal((await request(exp.c, exp.d)).state, "pending", "the fifth, expected, takes the reserved slot");
  const sixth = await fresh();
  assert.equal((await refusal(request(sixth.c, sixth.d))).code, "too_many_requests");
  assert.equal(count(w, "device_requests"), 5);
  // device_pending_cancel and device_expect are guarded: an unattached connection changes nothing.
  const plain = await w.client("alice");
  assert.equal((await refusal(plain.rpc({ type: "device_pending_cancel", device: mine.d.device, by_device: a1.device }))).code, "not_attached");
  assert.equal((await refusal(plain.rpc({ type: "device_expect", device: sixth.d.device, pin: b64(Buffer.alloc(32)), by_device: a1.device }))).code, "not_attached");
  assert.equal(count(w, "device_requests"), 5);
});

test("A12: a device expected by id and pin identity gets the reserved slot and registers; the expected id with another key is refused that slot", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  for (let i = 0; i < 4; i++) {
    const { d, c } = await fresh();
    await request(c, d);
  }
  const exp = await fresh();
  const pin = pinIdentity({ realm: w.realm, member: A, device: exp.d.device, key: exp.d.key });
  await c1.rpc({ type: "device_expect", device: exp.d.device, pin: b64(pin), by_device: a1.device });
  // An impostor with the expected device id but its own key: the pin differs, no reserved slot.
  const impostor = await fakeDevice(w.realm, A, { device: exp.d.device });
  const ic = await w.client("alice");
  assert.equal((await refusal(request(ic, impostor))).code, "too_many_requests");
  // Another device id with the expected device's... any other id: no reserved slot either.
  const other = await fresh();
  assert.equal((await refusal(request(other.c, other.d))).code, "too_many_requests");
  // The expected one.
  assert.equal((await request(exp.c, exp.d)).state, "pending");
  await approve(c1, await approval(w, A, a1, exp.d));
  assert.equal((await register(exp.c, exp.d)).state, "enrolled");
  assert.equal(count(w, "device_expectations"), 0, "the expectation ends with the registration");
});

test("A12: one pending request per device id: another key for a pending device id is refused; the same (device, key) is answered with its state", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  const first = await request(c, d);
  assert.equal(first.state, "pending");
  const again = await request(c, d);
  assert.deepEqual([again.state, again.expires], ["pending", first.expires], "answered with its state, not renewed");
  const other = await fakeDevice(w.realm, A, { device: d.device });
  const oc = await w.client("alice");
  assert.equal((await refusal(request(oc, other))).code, "request_pending");
  await approve(c1, await approval(w, A, a1, d));
  assert.equal((await request(c, d)).state, "approved");
  await register(c, d);
  assert.equal((await request(c, d)).state, "registered");
  assert.equal((await refusal(request(oc, other))).code, "key_mismatch", "a new key for a registered id is a rotation");
});

test("A12: a cancelled (device, key) cannot ask again for 24 hours (controlled clock); after that it can, and an approval registers it", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  await request(c, d);
  assert.equal((await c1.rpc({ type: "device_pending_cancel", device: d.device, by_device: a1.device })).state, "cancelled");
  assert.deepEqual((await c1.rpc({ type: "device_pending" })).requests, []);
  w.clock.advance(PENDING_MS - 60_000);
  assert.equal((await refusal(request(c, d))).code, "request_blocked");
  w.clock.advance(120_000);
  assert.equal((await request(c, d)).state, "pending");
  await approve(c1, await approval(w, A, a1, d));
  assert.equal((await register(c, d)).state, "enrolled");
});

test("A12: a pending request expires after 24 hours; its approval goes with it; renewed with the same key it needs a new approval", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  await request(c, d);
  const a = await approval(w, A, a1, d);
  await approve(c1, a);
  w.clock.advance(PENDING_MS + 1000);
  assert.equal((await refusal(register(c, d))).code, "approval_required", "the expired request and its approval are gone");
  assert.equal((await refusal(approve(c1, a))).code, "approval_expired");
  assert.equal((await request(c, d)).state, "pending", "renewed with the identical key");
  assert.equal((await refusal(register(c, d))).code, "approval_required");
  await approve(c1, await approval(w, A, a1, d));
  assert.equal((await register(c, d)).state, "enrolled");
});

test("A12: the sweep deletes expired pending requests, blocks and expectations", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const x = await fresh();
  const y = await fresh();
  await request(x.c, x.d);
  await request(y.c, y.d);
  await c1.rpc({ type: "device_pending_cancel", device: y.d.device, by_device: a1.device });
  await c1.rpc({ type: "device_expect", device: x.d.device, pin: b64(pinIdentity({ realm: w.realm, member: A, device: x.d.device, key: x.d.key })), by_device: a1.device });
  w.directory.sweep();
  assert.deepEqual([count(w, "device_requests"), count(w, "device_request_blocks"), count(w, "device_expectations")], [1, 1, 1], "nothing live is swept");
  w.clock.advance(PENDING_MS + 1000);
  w.directory.sweep();
  assert.deepEqual([count(w, "device_requests"), count(w, "device_request_blocks"), count(w, "device_expectations")], [0, 0, 0]);
});

test("A12: time bounds: issuedAt more than 5 minutes ahead, an expiry beyond 24 hours, or an expired approval is refused", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  await request(c, d);
  const now = sec(w);
  const cases = [
    [{ issuedAt: now + 301 }, "bad_approval", /future/],
    [{ issuedAt: now, expiry: now + APPROVAL_MAX_S + 1 }, "bad_approval", /24 hours/],
    [{ issuedAt: now - 2 * APPROVAL_MAX_S, expiry: now - APPROVAL_MAX_S }, "approval_expired", /expired/],
    [{ issuedAt: now - 100, expiry: now }, "approval_expired", /expired/],
  ];
  for (const [o, code, re] of cases) {
    const r = await refusal(approve(c1, await approval(w, A, a1, d, o)));
    assert.equal(r.code, code, JSON.stringify(o));
    assert.match(r.message, re);
  }
  // At the bounds it is taken.
  assert.equal((await approve(c1, await approval(w, A, a1, d, { issuedAt: now + 300 }))).state, "approved");
  assert.equal((await register(c, d)).state, "enrolled");
});

test("A12: an approval by a revoked device, by the new device itself, by another member's device, or with a wrong key or device id is refused", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  await request(c, d);
  // The new device itself: it cannot attach, so it cannot act; and an approval naming itself is refused.
  assert.equal((await refusal(approve(c, await approval(w, A, d, d)))).code, "not_attached");
  assert.equal((await refusal(approve(c1, await approval(w, A, a1, d, { approver: d.device })))).code, "not_attached");
  // Another member's device: its connection acts for bob only; an approval for alice is refused.
  const bd = await fakeDevice(w.realm, w.members.bob.id);
  const cb = await w.client("bob");
  await register(cb, bd);
  await bd.attachOn(cb);
  assert.equal((await refusal(approve(cb, await approval(w, A, bd, d)))).code, "bad_approval");
  assert.equal((await refusal(approve(cb, await approval(w, A, bd, d, { member: w.members.bob.id })))).code, "no_request");
  // A wrong key or device id: the signature covers both, and the request is for another key.
  const stranger = await fakeDevice(w.realm, A);
  assert.equal((await refusal(approve(c1, await approval(w, A, a1, d, { key: stranger.key })))).code, "key_mismatch");
  assert.equal((await refusal(approve(c1, await approval(w, A, a1, d, { device: stranger.device })))).code, "no_request");
  const forged = { ...(await approval(w, A, a1, d)), key: b64(stranger.key) };
  assert.equal((await refusal(approve(c1, forged))).code, "bad_approval", "a statement altered after signing");
  // Signed by a key other than the approver's registered one.
  const notA1 = await fakeDevice(w.realm, A, { device: a1.device });
  assert.equal((await refusal(approve(c1, await approval(w, A, notA1, d)))).code, "bad_approval");
  // A revoked approver: its connection no longer passes the guard.
  const a2 = await fakeDevice(w.realm, A);
  const c2 = await w.client("alice");
  await request(c2, a2);
  await approve(c1, await approval(w, A, a1, a2));
  await register(c2, a2);
  await a2.attachOn(c2);
  const st = await makeRevocation({ realm: w.realm, member: A, device: a2.device, by: a1.device, at: w.clock.now() }, (l, x) => a1.dev.sign(l, x));
  await c1.rpc({ type: "device_revoke", device: a2.device, by_device: a1.device, statement: st });
  const byRevoked = await approval(w, A, a2, d);
  assert.equal((await refusal(approve(c2, byRevoked))).code, "not_attached", "its attachment ended with the revocation");
  assert.throws(() => w.directory.approve({ member: A, approval: byRevoked, by: a2.device }), (e) => e.code === "device_revoked", "and the directory refuses a revoked approver");
  assert.equal(count(w, "devices"), 3, "a1, bob's and the revoked a2; d is not registered");
  assert.equal((await refusal(register(c, d))).code, "approval_required");
});

test("A12: an approver revoked or rotated between approval and consumption is refused at consumption", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  // a2, approved by a1.
  const a2 = await fakeDevice(w.realm, A);
  const c2 = await w.client("alice");
  await request(c2, a2);
  await approve(c1, await approval(w, A, a1, a2));
  await register(c2, a2);
  await a2.attachOn(c2);
  // Revoked: d approved by a2, then a2 revoked by a1.
  const { d, c } = await fresh();
  await request(c, d);
  await approve(c2, await approval(w, A, a2, d));
  const st = await makeRevocation({ realm: w.realm, member: A, device: a2.device, by: a1.device, at: w.clock.now() }, (l, x) => a1.dev.sign(l, x));
  await c1.rpc({ type: "device_revoke", device: a2.device, by_device: a1.device, statement: st });
  const r = await refusal(register(c, d));
  assert.equal(r.code, "approval_invalid");
  assert.match(r.message, /revoked/);
  // Rotated: e approved by a1, then a1 rotates its key.
  const e = await fresh();
  await request(e.c, e.d);
  await approve(c1, await approval(w, A, a1, e.d));
  const next = await a1.driver.createDevice(a1.dev.identity);
  const newKey = Buffer.from(next.signaturePublicKey());
  const rotation = await makeRotation({ realm: w.realm, member: A, device: a1.device, oldKey: a1.key, newKey, sequence: 1 }, (l, x) => a1.dev.sign(l, x), (l, x) => next.sign(l, x));
  const rc = await w.client("alice");
  const proof = await proveOn(rc, { realm: w.realm, member: A, device: a1.device, dev: next, key: newKey }, "register");
  assert.equal((await rc.rpc({ type: "device_register", device: a1.device, key: b64(newKey), pin: b64(pinIdentity({ realm: w.realm, member: A, device: a1.device, key: newKey })), rotation, proof })).state, "rotated", "rotation still works without an approval");
  const r2 = await refusal(register(e.c, e.d));
  assert.equal(r2.code, "approval_invalid");
  assert.match(r2.message, /another key/);
  assert.equal(count(w, "device_requests"), 2, "nothing consumed");
});

test("A12: idempotent: a repeated identical approval is success; a lost answer after registration retries to success without a second approval; the approval registers no other key", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  await request(c, d);
  const a = await approval(w, A, a1, d);
  assert.equal((await approve(c1, a)).state, "approved");
  assert.equal((await approve(c1, a)).state, "approved", "the identical approval again");
  assert.equal((await register(c, d)).state, "enrolled");
  // The answer was lost: the same (device, key) again.
  assert.equal((await register(c, d)).state, "unchanged");
  assert.equal((await approve(c1, a)).state, "registered", "an outbox resend learns it was consumed");
  // Another key for that device id: the approval does not cover it; it needs a rotation.
  const other = await fakeDevice(w.realm, A, { device: d.device });
  const oc = await w.client("alice");
  assert.equal((await refusal(register(oc, other))).code, "key_mismatch");
  assert.equal((await refusal(request(oc, other))).code, "key_mismatch");
  assert.equal(count(w, "devices"), 2);
});

test("A12: consumption is one transaction: a failed commit leaves the request, its approval and no device", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const { d, c } = await fresh();
  await request(c, d);
  await approve(c1, await approval(w, A, a1, d));
  w.fault.arm("before-commit");
  assert.equal((await refusal(register(c, d))).code, "unavailable");
  assert.equal(count(w, "devices"), 1);
  assert.equal(Number(w.db.get("SELECT count(*) AS n FROM device_requests WHERE approver_kind = 'device'").n), 1);
  assert.equal((await register(c, d)).state, "enrolled");
  assert.equal(count(w, "device_requests"), 0);
});

test("A12: a member token alone can no longer add a device, and so cannot revoke the member's devices", async (t) => {
  const { w, A, a1 } = await setup(t);
  // Only the token (no key of alice's devices): it makes its own key and device.
  const evil = await fakeDevice(w.realm, A);
  const ec = await w.client("alice");
  assert.equal((await refusal(register(ec, evil))).code, "approval_required");
  assert.equal((await request(ec, evil)).state, "pending", "a pending request at most");
  assert.equal((await refusal(evil.attachOn(ec))).code, "no_device");
  const st = await makeRevocation({ realm: w.realm, member: A, device: a1.device, by: evil.device, at: w.clock.now() }, (l, x) => evil.dev.sign(l, x));
  assert.equal((await refusal(ec.rpc({ type: "device_revoke", device: a1.device, by_device: evil.device, statement: st }))).code, "not_attached");
  assert.equal(count(w, "device_revocations"), 0);
  assert.equal(w.directory.list(A).length, 1);
});

test("A12: a member whose devices are all suspended cannot bootstrap: it needs the admin's approval", async (t) => {
  const { w, A, a1, fresh } = await setup(t);
  w.db.tx((h) => h.run("UPDATE devices SET suspended = 1 WHERE member_id = ? AND device_id = ?", A, a1.device));
  const { d, c } = await fresh();
  assert.equal((await refusal(register(c, d))).code, "approval_required", "suspended devices count: no bootstrap");
  assert.equal((await request(c, d)).state, "pending");
  // a1 cannot approve (suspended: its attachment and the guard refuse it).
  const s1 = await w.client("alice");
  assert.equal((await refusal(a1.attachOn(s1))).code, "device_suspended");
  const admin = createAdmin({ stateDir: w.dir, db: w.db, realm: w.realm, config: {}, now: w.clock.now });
  const fp = (await admin.call("pending", { member: A })).rows[0].fingerprint;
  assert.equal((await admin.call("device_approve", { member: A, device: d.device, fingerprint: fp })).state, "approved");
  assert.equal((await register(c, d)).state, "enrolled");
  const audit = w.db.get("SELECT action, target, result FROM admin_audit ORDER BY seq DESC LIMIT 1");
  assert.deepEqual({ ...audit }, { action: "devices.approve", target: `${A}/${d.device}`, result: "approved" });
});

test("A12: the bootstrap applies again only when every device is revoked", async (t) => {
  const { w, A, a1, c1, fresh } = await setup(t);
  const st = await makeRevocation({ realm: w.realm, member: A, device: a1.device, by: a1.device, at: w.clock.now() }, (l, x) => a1.dev.sign(l, x));
  await c1.rpc({ type: "device_revoke", device: a1.device, by_device: a1.device, statement: st });
  const { d, c } = await fresh();
  assert.equal((await request(c, d)).state, "not_required");
  assert.equal((await register(c, d)).state, "enrolled");
});

test("A12: the admin approval names the fingerprint the new device shows; a wrong one, or no request, is refused and nothing is recorded", async (t) => {
  const { w, A, fresh } = await setup(t);
  const { d, c } = await fresh();
  const admin = createAdmin({ stateDir: w.dir, db: w.db, realm: w.realm, config: {}, now: w.clock.now });
  await assert.rejects(admin.call("device_approve", { member: A, device: d.device, fingerprint: "00000 ".repeat(12).trim() }), (e) => e.code === "no_request");
  await request(c, d);
  await assert.rejects(admin.call("device_approve", { member: A, device: d.device, fingerprint: "00000 ".repeat(12).trim() }), (e) => e.code === "fingerprint_mismatch");
  assert.equal(count(w, "admin_audit"), 0);
  assert.equal((await refusal(register(c, d))).code, "approval_required");
  // The admin cancels it too (audited); the pair is then blocked.
  assert.equal((await admin.call("pending_cancel", { member: A, device: d.device })).state, "cancelled");
  assert.equal(w.db.get("SELECT action FROM admin_audit ORDER BY seq DESC LIMIT 1").action, "devices.pending-cancel");
  assert.equal((await refusal(request(c, d))).code, "request_blocked");
});
