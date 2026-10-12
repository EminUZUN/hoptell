// A12 end to end (amendments 3.5 part 3): hoptell device accept on an existing own device reads
// the new device's pending request, pins it and records a signed approval in the approval outbox
// in one contacts write, then sends it (again at every attach until the relay answers); the new
// device's enroll waits for it and completes. Crashes, lost answers, expiry, cancellation, a
// changed key, and the CLI's pending and expect.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { deviceStore, machineId } from "../lib/mls/device.js";
import { deviceCommand, deviceDecision, fetchDevices as fetchDevicesOver, ownDoctor, ownLines, verifyCommand, waitingLines } from "../lib/mls/cli.js";
import { b64, pinIdentity } from "../lib/mls/identity.js";
import { PENDING_MS } from "../lib/mls/relaydir.js";
import * as decisions from "../lib/decisions.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { deviceRelay, e2eeDevice, fakeDevice, memoryContacts, ownFor, refusal, tmpDir } from "./mls-helpers.js";

const FAKE = new URL("./fake-mls-driver.js", import.meta.url).pathname;
const PASS = "correct horse battery staple";

/** A device of `member` not enrolled yet: enroll() asks for approval and waits `waitMs` for it. */
function newDevice(t, w, member, { waitMs = 300 } = {}) {
  const dir = tmpDir(t);
  const contacts = memoryContacts(undefined, { file: path.join(dir, "contacts.json") });
  contacts.doc.encryption = [{ realm: w.realm, mode: "preferred" }];
  const profile = "relay-test";
  const store = deviceStore({ home: dir, profile, driver: createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now }), store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, profile), approvalPollMs: 100, approvalWaitMs: waitMs });
  return { dir, store, contacts, member, profile, enroll: async (opts = {}) => store.enroll(await w.client(member), opts), device: () => store.record()?.device };
}

/** Count the device_approve frames a connection sends; `lose` drops the answer of the next n. */
function spy(c, { lose = 0 } = {}) {
  const s = { approves: 0, lose };
  const rpc = c.rpc.bind(c);
  c.rpc = async (f) => {
    if (f.type !== "device_approve") return rpc(f);
    s.approves++;
    const r = await rpc(f);
    if (s.lose > 0) {
      s.lose--;
      throw new Error("the connection was lost before the answer");
    }
    return r;
  };
  return s;
}

/** A proven (attached) connection of test device `d`, spied; attaching sends its outbox. */
async function attached(w, d, opts) {
  const c = await w.client(d.member);
  const s = spy(c, opts);
  const r = await d.store.attach(c);
  return { c, s, r };
}

/**
 * hoptell device accept <device> on test device `d` through the decision service, as the CLI does
 * it (with the device's own clock): show, decide (sign, then one contacts write), then send unless
 * `send` is false (a crash right after the write). Returns {shown, r, sent, c, s}.
 */
async function accept(w, d, device, { send = true, lose = 0, contacts = d.contacts } = {}) {
  const { c, s } = await attached(w, d, { lose });
  const sources = { contacts, devices: { own: async () => ({ list: await c.rpc({ type: "device_list" }), pending: await c.rpc({ type: "device_pending" }), thisDevice: d.device, sign: (x) => d.store.signApproval({ device: x.device, key: x.key }) }) } };
  const id = `device-own:${device}`;
  const shown = await decisions.show({ home: d.dir, id, sources });
  if (!shown.view.waiting) return { shown, c, s };
  const r = await decisions.decide({ home: d.dir, id, action: "accept", token: shown.nativeToken, sources });
  const sent = send && r.done ? await d.store.flushApprovals(c) : null;
  return { shown, r, sent, c, s };
}

/** The CLI's hoptell device <args> on test device `d` (output lines). */
async function cli(w, d, args) {
  const out = [];
  const env = { HOPTELL_MLS_DRIVER: FAKE, HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS };
  await deviceCommand({ args, home: d.dir, profile: d.profile, env, connect: () => w.client(d.member), contacts: d.contacts, say: (x) => out.push(x) });
  return out;
}
const outbox = (d, w) => d.contacts.doc.own?.[w.realm]?.approvals ?? [];
const ownLinesOf = (list, d) => ownLines({ list, doc: d.contacts.doc, thisDevice: d.device });
const ownIds = (d, w) => d.contacts.doc.own[w.realm].devices.map((x) => x.device);
const registered = (w, member) => w.directory.list(w.members[member].id).filter((x) => !x.revoked).map((x) => x.device);
const pendingAt = (w) => w.db.all("SELECT device_id, approver_kind FROM device_requests").map((r) => [r.device_id, r.approver_kind]);

test("A12 end to end: enroll waits for the approval; hoptell device accept shows the same fingerprint, approves, and the enrollment completes", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  let waiting = null;
  let shown = null;
  const a2 = await e2eeDevice(t, w, "alice", {
    sessions: [],
    onWaiting: async (x) => {
      waiting = x;
      // Waiting: nothing registered, and the CLI's waiting text names the command to run.
      assert.deepEqual(registered(w, "alice"), [a.device]);
      assert.ok(waitingLines(x).includes(`waiting for approval from one of your devices: run hoptell device accept ${x.device} there`));
      shown = await cli(w, a, ["accept", x.device]);
      const code = /--set ([0-9a-f]{32})/.exec(shown.at(-1))?.[1];
      assert.ok(code, shown.join("\n"));
      shown.push(...(await cli(w, a, ["accept", x.device, "--set", code])));
    },
  });
  assert.ok(waiting, "enroll waited for the approval");
  const rec = a2.store.record();
  assert.equal(rec.status, "active");
  assert.equal(waiting.fingerprint, rec.fingerprint, "the new device shows its fingerprint");
  assert.ok(shown.includes(`Its fingerprint: ${rec.fingerprint}`), "accept shows the same one");
  assert.equal(waiting.pin, Buffer.from(rec.pin, "base64").toString("hex"));
  assert.ok(shown.some((l) => /Sent the approval of device .*: the relay recorded it/.test(l)), shown.join("\n"));
  assert.deepEqual(registered(w, "alice").sort(), [a.device, a2.device].sort());
  assert.deepEqual(ownIds(a, w), [a.device, a2.device], "pinned as an accepted own device");
  assert.deepEqual(outbox(a, w), [], "the outbox entry is removed once the relay confirmed it");
  assert.deepEqual(pendingAt(w), []);
});

test("A12: a crash after accept's single contacts write: one resend at the next attach, one registration; a crash before it leaves neither pin nor outbox", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice");
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const id = n.device();
  // Before the write: signing happened, the contacts write did not (the process died there).
  const failing = { ...a.contacts, currentPolicy: a.contacts.currentPolicy, updatePins: async () => { throw new Error("killed before the write"); } };
  await assert.rejects(accept(w, a, id, { contacts: failing }), /killed before the write/);
  assert.deepEqual(ownIds(a, w), [a.device], "no pin");
  assert.deepEqual(outbox(a, w), [], "no outbox entry");
  assert.deepEqual(pendingAt(w), [[id, null]], "nothing approved at the relay");
  // The owner runs accept again; this time the process dies right after the write.
  const r = await accept(w, a, id, { send: false });
  assert.equal(r.r.done, true);
  assert.deepEqual(ownIds(a, w), [a.device, id]);
  assert.equal(outbox(a, w).length, 1, "pin and outbox entry in the one write");
  assert.equal(r.s.approves, 0);
  assert.deepEqual(pendingAt(w), [[id, null]]);
  // Restart: the next attach sends it once; the next one sends nothing.
  const first = await attached(w, a);
  assert.equal(first.s.approves, 1);
  assert.deepEqual(first.r.approvals, [{ device: id, state: "approved" }]);
  assert.deepEqual(outbox(a, w), []);
  assert.equal((await attached(w, a)).s.approves, 0);
  // The new device's enroll completes: registered once.
  const e = await n.enroll();
  assert.equal(n.store.record().status, "active");
  assert.equal(e.created, false);
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
});

test("A12: a lost device_approve answer: the entry stays, the next attach resends it (identical: success), one registration", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice");
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const id = n.device();
  const r = await accept(w, a, id, { lose: 1 });
  assert.equal(r.s.approves, 1);
  assert.deepEqual(r.sent.map((x) => x.state), ["unsent"]);
  assert.deepEqual(pendingAt(w), [[id, "device"]], "the relay recorded it; the answer was lost");
  assert.equal(outbox(a, w).length, 1, "kept for the next attach");
  const again = await attached(w, a);
  assert.equal(again.s.approves, 1);
  assert.deepEqual(again.r.approvals, [{ device: id, state: "approved" }]);
  assert.deepEqual(outbox(a, w), []);
  await n.enroll();
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
  assert.equal(registered(w, "alice").length, 2);
});

test("A12: a second hoptell device accept of an accepted device with an unconfirmed outbox entry resends it instead of answering already accepted", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice");
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const id = n.device();
  await accept(w, a, id, { send: false });
  const out = await cli(w, a, ["accept", id]);
  assert.ok(out.some((l) => l.startsWith(`Sent the waiting approval of device ${id} again: the relay recorded it`)), out.join("\n"));
  assert.ok(!out.some((l) => /not waiting|already/.test(l)), out.join("\n"));
  assert.deepEqual(outbox(a, w), []);
  await n.enroll();
  assert.equal(n.store.record().status, "active");
});

test("A12: a request that expires after accept's write is renewed with the identical key and approved by a second accept; it then registers", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice");
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const id = n.device();
  await accept(w, a, id, { send: false }); // written, never sent (the device was offline)
  w.clock.advance(PENDING_MS + 60_000);
  // The next attach finds it past its expiry: removed; the own pin stays.
  const r = await attached(w, a);
  assert.deepEqual(r.r.approvals, [{ device: id, state: "expired" }]);
  assert.deepEqual(outbox(a, w), []);
  assert.deepEqual(ownIds(a, w), [a.device, id]);
  // The new device asks again with the identical key.
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  assert.deepEqual(pendingAt(w), [[id, null]]);
  const again = await accept(w, a, id);
  assert.equal(again.shown.view.state, "requested again");
  assert.deepEqual(again.sent, [{ device: id, state: "approved" }]);
  await n.enroll();
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
});

test("A12: a cancelled request is renewed with the identical key only after the 24-hour block (controlled clock); a second accept approves it", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice");
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const id = n.device();
  await accept(w, a, id, { send: false });
  // Cancelled (hoptell device pending --cancel) before the approval reached the relay.
  const out = await cli(w, a, ["pending", "--cancel", id]);
  assert.match(out.at(-1), /Cancelled the pending request/);
  // That run's attach sent the outbox entry first, answered "no request": removed; the pin stays.
  assert.deepEqual(outbox(a, w), []);
  assert.deepEqual(ownIds(a, w), [a.device, id]);
  w.clock.advance(PENDING_MS - 60_000);
  await assert.rejects(n.enroll(), (e) => e.code === "request_blocked", "before the block ends the renewal is refused");
  w.clock.advance(120_000);
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const again = await accept(w, a, id);
  assert.equal(again.shown.view.state, "requested again");
  assert.deepEqual(again.sent, [{ device: id, state: "approved" }]);
  await n.enroll();
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
});

test("A12: a renewed request with another key for an accepted device is refused by accept as a key change", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice");
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const id = n.device();
  await accept(w, a, id, { send: false });
  await cli(w, a, ["pending", "--cancel", id]);
  // Someone asks for that device id with another key (the cancel blocks only the old key).
  const other = await fakeDevice(w.realm, w.members.alice.id, { device: id });
  const oc = await w.client("alice");
  await oc.rpc({ type: "device_request", device: id, key: b64(other.key), proof: await other.proof(oc, "register") });
  const r = await accept(w, a, id);
  assert.equal(r.shown.view.state, "key changed");
  assert.equal(r.shown.view.waiting, false);
  await assert.rejects(cli(w, a, ["accept", id]), /key change, not a renewed request; refused/);
  assert.deepEqual(outbox(a, w), []);
  assert.deepEqual(pendingAt(w), [[id, null]], "not approved");
});

test("A12 CLI: the new device prints its pin identity; hoptell device expect reserves the slot for it; hoptell device pending lists requests with fingerprints", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice");
  await assert.rejects(n.enroll(), (e) => e.code === "approval_pending");
  const id = n.device();
  const status = await cli(w, n, ["status"]);
  const hex = /^Pin identity: ([0-9a-f]{64})$/.exec(status.find((l) => l.startsWith("Pin identity:")) ?? "")?.[1];
  assert.equal(hex, pinIdentity({ realm: w.realm, member: w.members.alice.id, device: id, key: Buffer.from(n.store.record().key, "base64") }).toString("hex"));
  const fp = status.find((l) => l.startsWith("Fingerprint:")).slice("Fingerprint: ".length);
  const list = await cli(w, a, ["pending"]);
  assert.ok(list.some((l) => l.startsWith(`${id}  ${fp}  requested `)), list.join("\n"));
  const exp = await cli(w, a, ["expect", id, hex]);
  assert.match(exp.at(-1), /Expecting device/);
  const row = w.db.get("SELECT device_id, pin, by_device FROM device_expectations");
  assert.deepEqual([row.device_id, Buffer.from(row.pin).toString("hex"), row.by_device], [id, hex, a.device]);
  await assert.rejects(cli(w, a, ["expect", id, "abc"]), /usage: hoptell device expect/);
  // Without an attached own device, nothing is shown.
  const plain = await w.client("alice");
  assert.equal((await refusal(plain.rpc({ type: "device_pending" }))).code, "not_attached");
});

// ---- review fixes ---------------------------------------------------------------------------------

const STOP = "stop waiting (the test leaves the request pending)";
/** Enroll `n` only up to its pending request (its waiting callback stops the run). */
const askOnly = (n) => assert.rejects(n.enroll({ onWaiting: () => Promise.reject(new Error(STOP)) }), new RegExp(STOP.replace(/[()]/g, "\\$&")));

/**
 * An approval recorded at the relay and then invalidated (its approver revoked, suspended or
 * rotated): the relay reports the request pending again, enroll goes back to waiting, a fresh
 * approval is signed and the device registers.
 */
async function recovery(t, kind) {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const A = w.members.alice.id;
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const a2 = await e2eeDevice(t, w, "alice", { sessions: [], onWaiting: (x) => w.adminApprove("alice", x) });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  const approver = kind === "rotate" ? a : a2;
  assert.deepEqual((await accept(w, approver, id)).sent, [{ device: id, state: "approved" }]);
  assert.deepEqual(pendingAt(w), [[id, "device"]]);
  if (kind === "revoke") await a.store.revoke(await w.client("alice"), a2.device);
  if (kind === "suspend") w.db.tx((h) => h.run("UPDATE devices SET suspended = 1 WHERE member_id = ? AND device_id = ?", A, a2.device));
  if (kind === "rotate") assert.equal((await a.store.rotate(await w.client("alice"))).seq, 1);
  // The member's devices see it waiting again (the approval that no longer holds is dropped).
  const { c } = await attached(w, a);
  assert.deepEqual((await c.rpc({ type: "device_pending" })).requests.map((x) => [x.device, x.approved]), [[id, false]]);
  assert.deepEqual(pendingAt(w), [[id, null]]);
  // Enroll waits again; a fresh accept (a has not pinned it, or pinned it with the same key) approves it.
  let waited = false;
  await n.enroll({
    onWaiting: async () => {
      waited = true;
      const r = await accept(w, a, id);
      assert.equal(r.shown.view.waiting, true, `accept offers a fresh approval (${r.shown.view.state})`);
      assert.deepEqual(r.sent, [{ device: id, state: "approved" }]);
    },
  });
  assert.ok(waited, "enroll went back to waiting");
  assert.equal(n.store.record().status, "active");
  assert.ok(registered(w, "alice").includes(id));
}
test("A12 fix: an approver revoked before consumption: the request is pending again, enroll keeps waiting, a fresh approval registers it", (t) => recovery(t, "revoke"));
test("A12 fix: an approver suspended before consumption: the request is pending again, enroll keeps waiting, a fresh approval registers it", (t) => recovery(t, "suspend"));
test("A12 fix: an approver rotated before consumption: the request is pending again, enroll keeps waiting, a fresh approval by the new key registers it", (t) => recovery(t, "rotate"));

test("A12 fix: an unsent outbox approval signed before the approver rotated is signed again with the new key (one write) and sent", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const A = w.members.alice.id;
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id, { send: false });
  const old = outbox(a, w)[0].approval;
  await a.store.rotate(await w.client("alice"));
  // As it is, the relay refuses it (signed by the retired key).
  assert.throws(() => w.directory.approve({ member: A, approval: old, by: a.device }), (e) => e.code === "bad_approval");
  const rev = a.contacts.doc.revision;
  const r = await attached(w, a);
  assert.equal(r.s.approves, 1, "sent once, signed again");
  assert.deepEqual(r.r.approvals, [{ device: id, state: "approved" }]);
  assert.equal(a.contacts.doc.revision, rev + 2, "one write replaces it, one removes it once confirmed");
  const row = w.db.get("SELECT approval, approver_key FROM device_requests WHERE device_id = ?", id);
  assert.notEqual(JSON.parse(row.approval).sig, old.sig);
  assert.equal(Buffer.from(row.approver_key).toString("base64"), a.store.record().key);
  assert.deepEqual(outbox(a, w), []);
  await n.enroll();
  assert.equal(n.store.record().status, "active");
});

test("A12 fix: an accepted device awaiting registration is out of the safety number until the relay lists it; the mark is then cleared", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const A = w.members.alice.id;
  const B = w.members.bob.id;
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const b = await e2eeDevice(t, w, "bob", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id);
  assert.equal(a.contacts.doc.own[w.realm].devices.find((x) => x.device === id).awaiting, true);
  const numbers = async () => {
    const ca = await a.proven();
    const cb = await b.proven();
    const va = deviceDecision({ sub: "verify", member: B, theirs: await ca.rpc({ type: "device_list", member: B }), mine: await ca.rpc({ type: "device_list" }), doc: a.contacts.doc }).view;
    const vb = deviceDecision({ sub: "verify", member: A, theirs: await cb.rpc({ type: "device_list", member: A }), mine: await cb.rpc({ type: "device_list" }), doc: b.contacts.doc }).view;
    return { va, vb };
  };
  const before = await numbers();
  assert.ok(before.va.safetyNumber && before.va.safetyNumber === before.vb.safetyNumber, "both sides compute the same number");
  assert.deepEqual(before.va.own.find((x) => x.device === id)?.state, "awaiting registration");
  const lines = ownLinesOf(await (await a.proven()).rpc({ type: "device_list" }), a);
  assert.ok(lines.some((l) => l.startsWith(id) && l.includes("awaiting its registration")), lines.join("\n"));
  await n.enroll();
  // Listed now: in the number on both sides even before the mark is cleared, and the engine's next
  // look at the own devices clears it.
  const listed = await numbers();
  assert.equal(listed.va.safetyNumber, listed.vb.safetyNumber);
  assert.notEqual(listed.va.safetyNumber, before.va.safetyNumber);
  await a.open("alice");
  assert.equal(a.contacts.doc.own[w.realm].devices.find((x) => x.device === id).awaiting, undefined);
  assert.equal((await numbers()).va.safetyNumber, listed.va.safetyNumber);
});

test("A12 fix: a crash after accept's durable contacts write (the real contacts file): reloaded from disk, one resend, one registration", async (t) => {
  const { openContacts } = await import("../lib/quarantine.js");
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const dir = tmpDir(t);
  const profile = "relay-test";
  const open = async () => {
    const contacts = await openContacts(dir, { notify: false });
    const store = deviceStore({ home: dir, profile, driver: createFakeDriver({ seed: `restart-${dir}`, now: w.clock.now }), store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, profile) });
    return { dir, profile, member: "alice", contacts, store, get device() {
      return store.record().device;
    } };
  };
  const first = await open();
  await first.store.enroll(await w.client("alice"));
  const a = { ...first, device: first.device };
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  const r = await accept(w, a, id, { send: false }); // the process dies right after the write
  assert.equal(r.r.done, true);
  // Restart: a new contacts manager and device store, read from disk.
  const again = await open();
  const doc = again.contacts.currentPolicy().doc;
  assert.deepEqual(doc.own[w.realm].devices.map((x) => [x.device, x.awaiting ?? false]), [[a.device, false], [id, true]]);
  assert.equal(doc.own[w.realm].approvals.length, 1, "pin and outbox entry durable together");
  assert.deepEqual(pendingAt(w), [[id, null]], "nothing sent before the crash");
  const c = await w.client("alice");
  const s = spy(c);
  const at = await again.store.attach(c);
  assert.equal(s.approves, 1);
  assert.deepEqual(at.approvals, [{ device: id, state: "approved" }]);
  assert.equal((await openContacts(dir, { notify: false })).currentPolicy().doc.own[w.realm].approvals, undefined, "removed on disk");
  const c2 = await w.client("alice");
  const s2 = spy(c2);
  await again.store.attach(c2);
  assert.equal(s2.approves, 0, "no second resend");
  await n.enroll();
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
});

test("A12 fix: an unsent approval signed before a rotation is not signed again for a request renewed after expiry: dropped, the renewal stays pending, a fresh accept approves it", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  // Accepted an hour after the request (written, never sent): the approval outlives the request.
  w.clock.advance(60 * 60_000);
  await accept(w, a, id, { send: false });
  const old = outbox(a, w)[0].approval;
  // The request expires while the approval is still unexpired; the device asks again, same key.
  w.clock.advance(PENDING_MS - 30 * 60_000);
  assert.ok(old.expiry * 1000 > w.clock.now(), "the old approval is still unexpired");
  await askOnly(n);
  assert.deepEqual(pendingAt(w), [[id, null]]);
  // The approver rotates; the next attach must not sign a fresh approval for the renewed request.
  await a.store.rotate(await w.client("alice"));
  const r = await attached(w, a);
  assert.equal(r.s.approves, 0, "nothing sent");
  assert.deepEqual(r.r.approvals, [{ device: id, state: "request_gone" }]);
  assert.deepEqual(outbox(a, w), [], "the entry is dropped");
  assert.deepEqual(ownIds(a, w), [a.device, id], "the pin stays");
  assert.deepEqual(pendingAt(w), [[id, null]], "the renewed request stays pending");
  // A fresh hoptell device accept approves the renewed request; the device registers.
  const again = await accept(w, a, id);
  assert.equal(again.shown.view.state, "requested again");
  assert.deepEqual(again.sent, [{ device: id, state: "approved" }]);
  await n.enroll();
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
});

/** A connect() for `member` whose relay omits the devices in `hidden` from every device list. */
const hidingConnect = (w, member, hidden) => async () => {
  const c = await w.client(member);
  const rpc = c.rpc.bind(c);
  c.rpc = async (f) => {
    const r = await rpc(f);
    return f.type === "device_list" ? { ...r, devices: r.devices.filter((d) => !hidden.has(d.device)) } : r;
  };
  return c;
};
/** hoptell device list on test device `d` over `connect` (output lines). */
async function listOver(d, connect) {
  const out = [];
  const env = { HOPTELL_MLS_DRIVER: FAKE, HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS };
  await deviceCommand({ args: ["list"], home: d.dir, profile: d.profile, env, connect, contacts: d.contacts, say: (x) => out.push(x) });
  return out;
}
/** hoptell contacts verify <member> on test device `d` over `connect` (output lines; a refusal is a line). */
async function verifyOver(d, member, connect) {
  const out = [];
  await verifyCommand({ sub: "verify", member, home: d.dir, profile: d.profile, connect, contacts: d.contacts, say: (x) => out.push(x) }).catch((e) => out.push(`refused: ${e.message}`));
  return out;
}
const awaitingMark = (d, w, id) => d.contacts.doc.own[w.realm].devices.find((x) => x.device === id)?.awaiting;
const doctorLines = (d) => ownDoctor({ home: d.dir, profile: d.profile, rec: d.store.record() }).map(([, x]) => x);

/** a (alice) accepts a pending device n, which then registers; nothing encrypted is opened. */
async function acceptedThenRegistered(t) {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const b = await e2eeDevice(t, w, "bob", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id);
  assert.equal(awaitingMark(a, w, id), true);
  await n.enroll();
  return { w, a, b, n, id, hidden: new Set() };
}

test("A12 fix: hoptell device list records the registration of an awaiting device; omitted later, it shows as missing", async (t) => {
  const { w, a, id, hidden } = await acceptedThenRegistered(t);
  const connect = hidingConnect(w, "alice", hidden);
  const seen = await listOver(a, connect);
  assert.equal(awaitingMark(a, w, id), undefined, "the transition is persisted");
  assert.ok(!seen.some((l) => l.includes("awaiting")), seen.join("\n"));
  hidden.add(id);
  const later = await listOver(a, connect);
  const line = later.find((l) => l.startsWith(id)) ?? "";
  assert.match(line, /the relay no longer lists it/);
  assert.doesNotMatch(line, /awaiting/);
});

test("A12 fix: hoptell contacts verify records the registration of an awaiting device; omitted later, it shows as missing and stays in the safety number", async (t) => {
  const { w, a, b, id, hidden } = await acceptedThenRegistered(t);
  const connect = hidingConnect(w, "alice", hidden);
  const number = (lines) => lines.find((l) => l.startsWith("Safety number"));
  const own = (lines) => lines.find((l) => l.trim().startsWith(id))?.trim();
  const seen = await verifyOver(a, b.id, connect);
  assert.equal(awaitingMark(a, w, id), undefined, "the transition is persisted");
  assert.match(own(seen), /\(accepted\)$/);
  hidden.add(id);
  const later = await verifyOver(a, b.id, connect);
  assert.match(own(later), /\(missing\)$/, later.join("\n"));
  // As for any missing own pin: kept in this side's half of the number.
  assert.equal(number(later), number(seen));
  assert.ok(number(seen));
});

test("A12 fix: hoptell doctor shows an awaiting device, then, once a look at the relay recorded its registration and later its omission, as no longer listed", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id);
  const hidden = new Set();
  const connect = hidingConnect(w, "alice", hidden);
  await listOver(a, connect);
  assert.ok(doctorLines(a).some((l) => l.includes(`your device ${id} is accepted and awaiting its registration`)), doctorLines(a).join("\n"));
  await n.enroll();
  await listOver(a, connect);
  assert.equal(awaitingMark(a, w, id), undefined);
  assert.ok(!doctorLines(a).some((l) => l.includes(id)), doctorLines(a).join("\n"));
  hidden.add(id);
  await listOver(a, connect);
  const lines = doctorLines(a);
  assert.ok(lines.some((l) => l.includes(`your device ${id} is no longer listed by the relay`)), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes(id) && l.includes("awaiting")));
});

test("A12 fix: the outbox entry keeps the relay's requested time; a renewal is never signed again for, even with the approver's clock ahead of the relay's", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const AHEAD = 4 * 60_000; // within the relay's 5-minute allowance for issuedAt
  const a = await e2eeDevice(t, w, "alice", { sessions: [], now: () => w.clock.now() + AHEAD });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  const first = w.db.get("SELECT created FROM device_requests WHERE device_id = ?", id).created;
  // Accepted a minute before the request expires (relay time), written and never sent.
  w.clock.advance(PENDING_MS - 60_000);
  await accept(w, a, id, { send: false });
  const entry = outbox(a, w)[0];
  assert.equal(entry.requested, Number(first), "the request instance it approved");
  // Two minutes later the request has expired and the device asks again with the same key.
  w.clock.advance(2 * 60_000);
  await askOnly(n);
  const renewed = Number(w.db.get("SELECT created FROM device_requests WHERE device_id = ?", id).created);
  assert.notEqual(renewed, entry.requested);
  // The approver's clock is ahead: its approval looks issued after the renewal, so a comparison of
  // the request time with issuedAt would take the renewal for the accepted request.
  assert.ok(Math.floor(renewed / 1000) <= entry.approval.issued_at, "the old comparison would have passed");
  assert.ok(entry.approval.expiry * 1000 > w.clock.now() + AHEAD, "the approval is still unexpired");
  await a.store.rotate(await w.client("alice"));
  const r = await attached(w, a);
  assert.equal(r.s.approves, 0, "nothing sent");
  assert.deepEqual(r.r.approvals, [{ device: id, state: "request_gone" }]);
  assert.deepEqual(outbox(a, w), []);
  assert.deepEqual(ownIds(a, w), [a.device, id], "the pin stays");
  assert.deepEqual(pendingAt(w), [[id, null]], "the renewal stays pending");
  const again = await accept(w, a, id);
  assert.equal(again.shown.view.state, "requested again");
  assert.deepEqual(again.sent, [{ device: id, state: "approved" }]);
  await n.enroll();
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
});

test("A12 fix: an outbox entry without a stored requested time is never signed again: dropped when its approver rotated", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id, { send: false });
  // As written before the requested time was kept.
  await a.contacts.updatePins((doc) => {
    for (const x of doc.own[w.realm].approvals) delete x.requested;
  });
  assert.equal(outbox(a, w)[0].requested, undefined);
  await a.store.rotate(await w.client("alice"));
  const r = await attached(w, a);
  assert.equal(r.s.approves, 0);
  assert.deepEqual(r.r.approvals, [{ device: id, state: "request_gone" }]);
  assert.deepEqual(outbox(a, w), []);
  assert.deepEqual(pendingAt(w), [[id, null]], "the request stays pending for a fresh accept");
  assert.deepEqual((await accept(w, a, id)).sent, [{ device: id, state: "approved" }]);
  await n.enroll();
  assert.ok(registered(w, "alice").includes(id));
});

test("A12 fix: an unsent approval is not recorded for a request renewed after expiry (no rotation): the relay refuses it as request_gone, the entry is dropped, a fresh accept approves", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  // Accepted near the end of the request's 24 hours; written, never sent.
  w.clock.advance(PENDING_MS - 60_000);
  await accept(w, a, id, { send: false });
  const entry = outbox(a, w)[0];
  w.clock.advance(2 * 60_000);
  await askOnly(n); // renewed with the same key
  assert.ok(entry.approval.expiry * 1000 > w.clock.now(), "the signature is still valid");
  const r = await attached(w, a);
  assert.equal(r.s.approves, 1, "sent as it is");
  assert.deepEqual(r.r.approvals, [{ device: id, state: "request_gone" }], "refused for the renewed request");
  assert.deepEqual(outbox(a, w), []);
  assert.deepEqual(ownIds(a, w), [a.device, id], "the pin stays");
  assert.deepEqual(pendingAt(w), [[id, null]], "the renewal stays pending");
  const again = await accept(w, a, id);
  assert.equal(again.shown.view.state, "requested again");
  assert.deepEqual(again.sent, [{ device: id, state: "approved" }]);
  await n.enroll();
  assert.deepEqual(registered(w, "alice").sort(), [a.device, id].sort());
});

test("A12 fix: a request renewed between the client's read of device_pending and its device_approve is refused by the relay (request_gone)", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  w.clock.advance(PENDING_MS - 60_000);
  await accept(w, a, id, { send: false });
  await a.store.rotate(await w.client("alice")); // so the flush reads device_pending before it re-signs
  const c = await w.client("alice");
  const s = spy(c);
  const rpc = c.rpc.bind(c);
  let renewed = false;
  c.rpc = async (f) => {
    const r = await rpc(f);
    if (f.type === "device_pending" && !renewed) {
      // The client has read the accepted request; it expires and the device asks again now.
      renewed = true;
      w.clock.advance(2 * 60_000);
      await askOnly(n);
    }
    return r;
  };
  const at = await a.store.attach(c);
  assert.ok(renewed);
  assert.equal(s.approves, 1, "the re-signed approval was sent");
  assert.deepEqual(at.approvals, [{ device: id, state: "request_gone" }]);
  assert.deepEqual(outbox(a, w), []);
  assert.deepEqual(pendingAt(w), [[id, null]], "the renewal stays pending");
  // The relay needs the request instance with every device_approve.
  const c2 = await a.proven();
  await assert.rejects(c2.rpc({ type: "device_approve", approval: (await accept(w, a, id, { send: false })).r && outbox(a, w)[0].approval }), (e) => e.code === "bad_request");
  assert.deepEqual(pendingAt(w), [[id, null]]);
});

test("A12 fix: an awaiting device first observed after a valid rotation is recorded as registered; omitted later, it shows as missing", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id);
  await n.enroll();
  // The new device rotates before a looks at the relay: the relay serves the rotated key.
  assert.equal((await n.store.rotate(await w.client("alice"))).seq, 1);
  const hidden = new Set();
  const connect = hidingConnect(w, "alice", hidden);
  const seen = await listOver(a, connect); // one observation, no encrypted messaging
  assert.equal(awaitingMark(a, w, id), undefined, "the rotation chain proves the registration");
  assert.ok(!seen.some((l) => l.includes("awaiting")), seen.join("\n"));
  hidden.add(id);
  const line = (await listOver(a, connect)).find((l) => l.startsWith(id)) ?? "";
  assert.match(line, /the relay no longer lists it/);
  assert.doesNotMatch(line, /awaiting/);
});

test("A12 fix: the engine's own-seen record is compared with the file, so a CLI observation in between never leaves doctor with a stale clean result", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [] });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id);
  await n.enroll();
  const hidden = new Set();
  const connect = hidingConnect(w, "alice", hidden);
  await listOver(a, connect); // its registration is recorded
  assert.equal(awaitingMark(a, w, id), undefined);
  hidden.add(id);
  const missing = () => doctorLines(a).some((l) => l.includes(`your device ${id} is no longer listed by the relay`));
  // The engine sees the device missing.
  const e = a.engine(await connect(), "alice").e2ee;
  await e.attach();
  assert.ok(missing(), "engine: missing");
  // hoptell device list then sees it present.
  hidden.clear();
  await listOver(a, connect);
  assert.ok(!missing(), "CLI: present");
  // The engine sees it missing again: the same as its last observation, but not what the file says.
  hidden.add(id);
  await e.attach();
  assert.ok(missing(), "engine again: missing (written although its own last observation was the same)");
});

test("A12 fix: a failed contacts write while recording a registration never hides device list or verify; confirmation stays blocked until it is recorded", async (t) => {
  const { w, a, b, id } = await acceptedThenRegistered(t);
  const connect = hidingConnect(w, "alice", new Set());
  const write = a.contacts.updatePins;
  a.contacts.updatePins = async () => {
    throw Object.assign(new Error("another hoptell process holds the contacts lock"), { code: "busy" });
  };
  // device list: the relay's devices are shown, with a warning.
  const listed = await listOver(a, connect);
  assert.match(listed[0], /^Warning: .*could not be recorded.*another hoptell process holds the contacts lock/);
  assert.ok(listed.some((l) => l.startsWith(id)), listed.join("\n"));
  assert.equal(awaitingMark(a, w, id), true, "not recorded");
  // verify: both sets and the number shown, with a warning; nothing offered or confirmed.
  const shown = await verifyOver(a, b.id, connect);
  assert.ok(shown.some((l) => l.trim().startsWith(id)), shown.join("\n"));
  assert.ok(shown.some((l) => l.startsWith("Safety number")));
  assert.ok(shown.some((l) => /^Warning: .*could not be recorded/.test(l)));
  assert.ok(!shown.some((l) => /--set/.test(l)), "no confirmation offered");
  const s = await decisions.show({ home: a.dir, id: `device-verify:${b.id}`, sources: { contacts: a.contacts, devices: { fetch: (m) => fetchDevicesOver(connect, m) } } });
  assert.deepEqual(s.actions, []);
  const tried = await verifyCommand({ sub: "verify", member: b.id, yes: true, how: "in-person", set: s.nativeToken, home: a.dir, profile: a.profile, connect, contacts: a.contacts, say: () => {} }).catch((e) => e);
  assert.match(String(tried?.message), /nothing is pinned: .*could not be recorded/);
  const decided = await decisions.decide({ home: a.dir, id: `device-verify:${b.id}`, action: "verify", token: s.nativeToken, options: { how: "in-person" }, sources: { contacts: a.contacts, devices: { fetch: (m) => fetchDevicesOver(connect, m) } } });
  assert.equal(decided.refused, true);
  assert.match(decided.reason, /could not be recorded/);
  // The write works again: recorded, and the confirmation is offered.
  a.contacts.updatePins = write;
  const again = await verifyOver(a, b.id, connect);
  assert.equal(awaitingMark(a, w, id), undefined);
  assert.ok(again.some((l) => /--set/.test(l)), again.join("\n"));
});

test("A12 fix: a delayed hoptell device accept --set code made for a request is refused once the request is renewed with the same key; the renewed one is confirmed again", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  const shown = await cli(w, a, ["accept", id]);
  const code = /--set ([0-9a-f]{32})/.exec(shown.at(-1))?.[1];
  assert.ok(code, shown.join("\n"));
  // The owner confirms later: meanwhile the request ended (removed here as an expiry would; the
  // CLI signs with the machine's clock, so the relay's is moved by a minute only) and the device
  // asked again with the same key.
  w.db.tx((h) => h.run("DELETE FROM device_requests WHERE device_id = ?", id));
  w.clock.advance(60_000);
  await askOnly(n);
  await assert.rejects(cli(w, a, ["accept", id, "--set", code]), /changed since that code was shown/);
  assert.deepEqual(outbox(a, w), [], "nothing signed or written");
  assert.deepEqual(ownIds(a, w), [a.device]);
  const fresh = /--set ([0-9a-f]{32})/.exec((await cli(w, a, ["accept", id])).at(-1))?.[1];
  assert.notEqual(fresh, code);
  const done = await cli(w, a, ["accept", id, "--set", fresh]);
  assert.match(done.at(-1), /the relay recorded it/);
  await n.enroll();
  assert.ok(registered(w, "alice").includes(id));
});

test("A12 fix: one device list observation after a registration and a rotation records the rotated key: verify's safety number matches the peer's", async (t) => {
  const { w, a, b, n, id } = await acceptedThenRegistered(t);
  assert.equal((await n.store.rotate(await w.client("alice"))).seq, 1);
  const served = w.directory.list(w.members.alice.id).find((x) => x.device === id);
  await listOver(a, hidingConnect(w, "alice", new Set())); // one observation, no encrypted messaging
  const pin = a.contacts.doc.own[w.realm].devices.find((x) => x.device === id);
  assert.equal(pin.awaiting, undefined);
  assert.equal(pin.key, served.key, "the rotated key is recorded");
  assert.equal(pin.seq, 1);
  // a's own half now uses the key the relay serves: the same number as bob computes.
  const ca = await a.proven();
  const cb = await b.proven();
  const va = deviceDecision({ sub: "verify", member: b.id, theirs: await ca.rpc({ type: "device_list", member: b.id }), mine: await ca.rpc({ type: "device_list" }), doc: a.contacts.doc }).view;
  const vb = deviceDecision({ sub: "verify", member: a.id, theirs: await cb.rpc({ type: "device_list", member: a.id }), mine: await cb.rpc({ type: "device_list" }), doc: b.contacts.doc }).view;
  assert.ok(va.safetyNumber);
  assert.equal(va.safetyNumber, vb.safetyNumber);
});

test("A12 fix: hoptell device accept that drops a stale outbox entry goes on to show the renewed request in the same run", async (t) => {
  const w = await deviceRelay(t, { autoApprove: false, e2ee: true });
  const a = await e2eeDevice(t, w, "alice", { sessions: [], machine: machineId() });
  const n = newDevice(t, w, "alice", { waitMs: 15_000 });
  await askOnly(n);
  const id = n.device();
  await accept(w, a, id, { send: false }); // written, never sent
  // The request ends (removed as an expiry would; the CLI signs with the machine's clock) and the
  // device asks again with the same key.
  w.db.tx((h) => h.run("DELETE FROM device_requests WHERE device_id = ?", id));
  w.clock.advance(60_000);
  await askOnly(n);
  const out = await cli(w, a, ["accept", id]);
  assert.match(out[0], /the request it was made for is gone/, out.join("\n"));
  assert.deepEqual(outbox(a, w), [], "the stale entry is dropped");
  assert.ok(out.some((l) => l.includes(`Device ${id} of yours, accepted before, asks again to be registered`)), out.join("\n"));
  const code = /--set ([0-9a-f]{32})/.exec(out.at(-1))?.[1];
  assert.ok(code, "the renewed request is offered in the same run");
  const done = await cli(w, a, ["accept", id, "--set", code]);
  assert.match(done.at(-1), /the relay recorded it/, done.join("\n"));
  await n.enroll();
  assert.ok(registered(w, "alice").includes(id));
});

test("A12 fix: verify says a failed recording of the own list before refusing for an own device that is not accepted; nothing is confirmed", async (t) => {
  const { w, a, b, id } = await acceptedThenRegistered(t);
  // Another device of alice's, approved by the admin, that a has not accepted: verify refuses.
  const other = await e2eeDevice(t, w, "alice", { sessions: [], onWaiting: (x) => w.adminApprove("alice", x) });
  const connect = hidingConnect(w, "alice", new Set());
  const write = a.contacts.updatePins;
  a.contacts.updatePins = async () => {
    throw Object.assign(new Error("another hoptell process holds the contacts lock"), { code: "busy" });
  };
  const out = await verifyOver(a, b.id, connect);
  const warn = out.findIndex((l) => /^Warning: .*could not be recorded.*contacts lock/.test(l));
  const refused = out.findIndex((l) => l.startsWith("refused: verify refused:") && l.includes(other.device));
  assert.ok(warn >= 0 && refused > warn, out.join("\n"));
  assert.ok(!out.some((l) => /--set/.test(l)));
  await assert.rejects(verifyCommand({ sub: "verify", member: b.id, yes: true, how: "in-person", set: "0".repeat(32), home: a.dir, profile: a.profile, connect, contacts: a.contacts, say: () => {} }));
  assert.equal(awaitingMark(a, w, id), true, "not recorded");
  a.contacts.updatePins = write;
});
