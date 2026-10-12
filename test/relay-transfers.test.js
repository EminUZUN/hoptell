// The relay's larger transfers (design 6, experimental): the upload states and their frames,
// bounds and quotas, idempotent retries, races serialized by the single writer, crash injection
// at each transaction boundary, accounting recomputed at startup, tombstones and reclamation, the
// relay-visible reference created with the message's acceptance, download authorization (TR4,
// TR8) and retention (TR5). Chunks are opaque ciphertext to the relay, so they are random bytes
// of the expected lengths here; most tests use a small relay chunk size (the relay's length check
// only; the wire format's own chunk size is fixed and tested in transfer-wire.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAccess } from "../lib/access.js";
import { lockStateDir } from "../lib/realm.js";
import { openRelayDb } from "../lib/relaydb.js";
import { TRANSFER_CAP } from "../lib/relay.js";
import { KP_LIFETIME_MS, DAY } from "../lib/mls/policy.js";
import { CHARGE, MAX_SENDER_BYTES, RELATION_SENDER_MIGRATION, OPEN_LIFETIME_MS, REPLAY_HORIZON_MS, SEALED_LIFETIME_MS, TRANSFER_MIGRATION, beginCharge, createTransferStore, relationCharge } from "../lib/mls/relaytransfers.js";
import { RELAY_MIGRATIONS } from "../lib/relaystore.js";
import { MAX_TOTAL_BYTES, TAG_BYTES, rootOf } from "../lib/transferwire.js";
import { deviceRelay, fakeDevice, newOp, refusal, tmpDir } from "./mls-helpers.js";

const CS = 64; // the relay's chunk size in these tests
const groupId = () => crypto.randomBytes(16).toString("hex");
const blob = (n = 64) => crypto.randomBytes(n).toString("base64");
const tidOf = () => crypto.randomBytes(16).toString("hex");
let reqN = 0;
const reqId = () => `req-${process.pid}-${++reqN}-${crypto.randomBytes(3).toString("hex")}`;

/** A transfer's ciphertext chunks of the relay's expected lengths, its root and begin frame. */
function plan(total, { cs = CS, id = tidOf() } = {}) {
  const count = Math.max(1, Math.ceil(total / cs));
  const chunks = Array.from({ length: count }, (_, i) => crypto.randomBytes((i < count - 1 ? cs : total - (count - 1) * cs) + TAG_BYTES));
  return { id, total, count, chunks, root: rootOf(chunks).toString("hex"), begin: { type: "upload_begin", transfer_id: id, total_bytes: total, chunk_count: count, header_digest: crypto.randomBytes(32).toString("hex") } };
}
const chunkFrame = (p, i, data = p.chunks[i]) => ({ type: "upload_chunk", transfer_id: p.id, index: i, data: data.toString("base64") });

/**
 * A relay with transfers: alice (devices ad, ad2), bob (bd, bd2), carol (cd), each device with
 * KeyPackages; one connection per device, attached to it (transfers use the attachment's device).
 */
async function setup(t, { limits = {}, cs = CS, access = null, admission = {} } = {}) {
  const w = await deviceRelay(t, { e2ee: true, transfers: { limits, chunkSize: cs }, access, admission });
  const reg = await w.client("alice");
  const devs = {};
  const conns = {};
  for (const [name, member] of [["ad", "alice"], ["ad2", "alice"], ["bd", "bob"], ["bd2", "bob"], ["cd", "carol"]]) {
    const d = await fakeDevice(w.realm, w.members[member].id);
    const c = await w.client(member, { session: `${member}-${name}` });
    await d.registerOn(c); // A9: register and attach with proofs, then KeyPackages
    await d.attachOn(c);
    await c.rpc({ type: "kp_upload", device: d.device, packages: await d.packages(4, w.clock.now() + KP_LIFETIME_MS) });
    devs[name] = d;
    conns[name] = c;
  }
  reg.close();
  const A = w.members.alice.id;
  const B = w.members.bob.id;
  const C = w.members.carol.id;
  /** Upload plan `p` from connection `c` (all chunks), committing unless told not to. */
  const upload = async (c, p, { commit = true } = {}) => {
    await c.rpc(p.begin);
    for (let i = 0; i < p.count; i++) await c.rpc(chunkFrame(p, i));
    return commit ? c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }) : null;
  };
  /** alice's device ad creates the conversation with bob's devices; returns the group id. */
  const conversation = async (targets = ["bd", "bd2"], { by = "ad", peer = B, member = B } = {}) => {
    const res = [];
    for (const d of targets) res.push((await conns[by].rpc({ type: "kp_take", request: reqId(), device: devs[by].device, target: { member, device: devs[d].device } })).reservation);
    const r = await conns[by].rpc({ type: "group_create", op: newOp(), device: devs[by].device, peer, group: groupId(), epoch: 1, welcome: { recipients: targets.map((d) => devs[d].device), mls: blob(), ratchet_tree: blob(32) }, kp_reservations: res });
    return r.group;
  };
  /** An application message from `by` into `group` publishing `p`'s reference. */
  const sealedFor = new Map(); // op -> its MLS bytes, so a retry of an op is the same payload
  const publish = (group, p, { by = "ad", op = newOp(), device = devs[by].device, blobs = [{ uploader_device: devs[by].device, transfer_id: p.id }] } = {}) => {
    if (!sealedFor.has(op)) sealedFor.set(op, blob());
    return conns[by].rpc({ type: "send_e2ee", kind: "app", op, device, group, mls: sealedFor.get(op), target: "bob", blobs });
  };
  const download = (who, p, index = 0, uploader = devs.ad.device) => conns[who].rpc({ type: "download", uploader_device: uploader, transfer_id: p.id, from_index: index });
  const accounting = () => w.transfers.recompute().mismatches;
  return { w, devs, conns, A, B, C, upload, conversation, publish, download, accounting };
}

const rows = (w, sql, ...a) => w.db.all(sql, ...a).map((r) => ({ ...r }));
const tstate = (w, id) => w.db.get("SELECT state FROM transfers WHERE transfer_id = ?", id)?.state ?? null;

test("upload: begin, chunks, status, commit; sealed with relay_expires 7 days after the seal; the capability is announced", async (t) => {
  const s = await setup(t);
  assert.ok(s.conns.ad.caps.includes(TRANSFER_CAP));
  const p = plan(150); // 3 chunks: 64, 64, 22
  const b = await s.conns.ad.rpc(p.begin);
  assert.deepEqual([b.type, b.state, b.open_expires], ["begun", "open", s.w.clock.now() + OPEN_LIFETIME_MS]);
  const st = await s.conns.ad.rpc(chunkFrame(p, 1));
  assert.deepEqual([st.type, st.index], ["stored", 1]);
  const status = await s.conns.ad.rpc({ type: "upload_status", transfer_id: p.id });
  assert.deepEqual([status.state, status.stored, status.chunk_count], ["open", [1], 3]);
  for (const i of [0, 2]) await s.conns.ad.rpc(chunkFrame(p, i));
  s.w.clock.advance(1000);
  const sealed = await s.conns.ad.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root });
  assert.deepEqual([sealed.type, sealed.state, sealed.root, sealed.relay_expires], ["sealed", "sealed", p.root, s.w.clock.now() + SEALED_LIFETIME_MS]);
  assert.deepEqual(s.accounting(), []);
  // Not attached: refused. The uploader is the attachment's device, never a frame field.
  const plain = await s.w.client("alice");
  assert.equal((await refusal(plain.rpc(plan(10).begin))).code, "not_attached");
});

test("upload: false sizes and counts at begin and per chunk are refused", async (t) => {
  const s = await setup(t);
  const p = plan(150);
  const c = s.conns.ad;
  assert.equal((await refusal(c.rpc({ ...p.begin, chunk_count: 4 }))).code, "bad_request", "a count that does not follow from the size");
  assert.equal((await refusal(c.rpc({ ...p.begin, total_bytes: MAX_TOTAL_BYTES + 1, chunk_count: 1 }))).code, "too_large");
  assert.equal((await refusal(c.rpc({ ...p.begin, total_bytes: -1 }))).code, "too_large");
  assert.equal((await refusal(c.rpc({ ...p.begin, transfer_id: "zz" }))).code, "bad_request");
  assert.equal((await refusal(c.rpc({ ...p.begin, header_digest: "00" }))).code, "bad_request");
  await c.rpc(p.begin);
  assert.equal((await refusal(c.rpc(chunkFrame(p, 0, crypto.randomBytes(CS + TAG_BYTES + 1))))).code, "bad_request", "a chunk longer than expected");
  assert.equal((await refusal(c.rpc(chunkFrame(p, 2, crypto.randomBytes(CS + TAG_BYTES))))).code, "bad_request", "a full chunk at the short last index");
  assert.equal((await refusal(c.rpc(chunkFrame(p, 3, p.chunks[2])))).code, "bad_request", "an index past the count");
  assert.equal((await refusal(c.rpc({ type: "upload_chunk", transfer_id: p.id, index: 0, data: "not base64!" }))).code, "bad_request");
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM transfer_chunks").n, 0);
  assert.deepEqual(s.accounting(), []);
});

test("upload: duplicate chunks with the same bytes are idempotent, changed bytes chunk_conflict; sealed and terminal transfers refuse chunks", async (t) => {
  const s = await setup(t);
  const p = plan(100);
  const c = s.conns.ad;
  await c.rpc(p.begin);
  assert.equal((await c.rpc(chunkFrame(p, 0))).index, 0);
  const again = await c.rpc(chunkFrame(p, 0));
  assert.deepEqual([again.type, again.repeated], ["stored", true], "the same bytes: stored again");
  const changed = Buffer.from(p.chunks[0]);
  changed[0] ^= 1;
  assert.equal((await refusal(c.rpc(chunkFrame(p, 0, changed)))).code, "chunk_conflict");
  await c.rpc(chunkFrame(p, 1));
  await c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root });
  assert.equal((await refusal(c.rpc(chunkFrame(p, 1)))).code, "sealed");
  await c.rpc({ type: "upload_abort", transfer_id: p.id });
  assert.equal((await refusal(c.rpc(chunkFrame(p, 1)))).code, "gone");
  assert.deepEqual(s.accounting(), []);
});

test("upload: a commit with chunks missing answers incomplete with the missing indexes; a wrong root is refused", async (t) => {
  const s = await setup(t);
  const p = plan(300); // 5 chunks
  const c = s.conns.ad;
  await c.rpc(p.begin);
  for (const i of [0, 2, 4]) await c.rpc(chunkFrame(p, i));
  const inc = await refusal(c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }));
  assert.equal(inc.code, "incomplete");
  const e = await c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }).catch((x) => x);
  assert.deepEqual(e.frame?.missing ?? e.missing, [1, 3]);
  for (const i of [1, 3]) await c.rpc(chunkFrame(p, i));
  assert.equal((await refusal(c.rpc({ type: "upload_commit", transfer_id: p.id, root: "0".repeat(64) }))).code, "root_mismatch");
  assert.equal(tstate(s.w, p.id), "open");
  assert.equal((await c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root })).state, "sealed");
});

test("upload: lost commit and abort answers, retried, get the same answer; another root transfer_conflict; a tombstone answers retries", async (t) => {
  const s = await setup(t);
  const p = plan(100);
  const c = s.conns.ad;
  await s.upload(c, p, { commit: false });
  // The commit's answer is lost after its transaction committed (after-commit fault).
  s.w.fault.arm("after-commit");
  assert.equal((await refusal(c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }))).code, "unavailable");
  assert.equal(tstate(s.w, p.id), "sealed", "the commit is durable");
  const retry = await c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root });
  assert.deepEqual([retry.state, retry.repeated, retry.root], ["sealed", true, p.root]);
  assert.equal((await refusal(c.rpc({ type: "upload_commit", transfer_id: p.id, root: "1".repeat(64) }))).code, "transfer_conflict");
  s.w.fault.arm("after-commit");
  assert.equal((await refusal(c.rpc({ type: "upload_abort", transfer_id: p.id }))).code, "unavailable");
  assert.equal(tstate(s.w, p.id), "aborted");
  assert.deepEqual([(await c.rpc({ type: "upload_abort", transfer_id: p.id })).state], ["aborted"]);
  assert.equal((await refusal(c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }))).code, "gone", "a commit on a terminal transfer");
  assert.equal((await c.rpc(p.begin)).state, "aborted", "a retried begin gets the recorded final state");
  assert.equal((await refusal(c.rpc({ ...p.begin, header_digest: "2".repeat(64) }))).code, "transfer_conflict", "other parameters");
  assert.deepEqual(s.accounting(), []);
});

test("upload: commit against chunk, abort and expiry races are serialized by the single writer", async (t) => {
  const s = await setup(t);
  const c = s.conns.ad;
  // A commit racing the last chunk: either incomplete then sealed, or sealed; never half.
  const p = plan(130);
  await c.rpc(p.begin);
  for (let i = 0; i < p.count - 1; i++) await c.rpc(chunkFrame(p, i));
  const [chunk, commit] = await Promise.allSettled([c.rpc(chunkFrame(p, p.count - 1)), c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root })]);
  assert.equal(chunk.status, "fulfilled");
  if (commit.status === "rejected") assert.equal(commit.reason.code, "incomplete");
  // A commit racing an abort from the device's second connection: one of them wins, the other sees its state.
  const q = plan(64);
  await s.upload(c, q, { commit: false });
  const second = await s.w.client("alice", { session: "alice-ad-2" });
  await s.devs.ad.attachOn(second);
  const [cm, ab] = await Promise.allSettled([c.rpc({ type: "upload_commit", transfer_id: q.id, root: q.root }), second.rpc({ type: "upload_abort", transfer_id: q.id })]);
  assert.equal(ab.status, "fulfilled");
  assert.equal(ab.value.state, "aborted");
  assert.ok(cm.status === "fulfilled" ? cm.value.state === "sealed" : cm.reason.code === "gone");
  assert.equal(tstate(s.w, q.id), "aborted");
  // Expiry: past open_expires a chunk and a commit get gone before any sweep ran; the sweep terminates it.
  const r = plan(100);
  await c.rpc(r.begin);
  await c.rpc(chunkFrame(r, 0));
  s.w.clock.advance(OPEN_LIFETIME_MS);
  assert.equal((await refusal(c.rpc(chunkFrame(r, 1)))).code, "gone");
  assert.equal((await refusal(c.rpc({ type: "upload_commit", transfer_id: r.id, root: r.root }))).code, "gone");
  assert.equal(tstate(s.w, r.id), "open", "not terminated yet: every read compares the times");
  s.w.transfers.sweep();
  assert.equal(tstate(s.w, r.id), "expired");
  assert.equal((await c.rpc({ type: "upload_abort", transfer_id: r.id })).state, "expired");
  assert.deepEqual(s.accounting(), []);
});

test("quota: concurrent begins at the last slot; exactly one wins", async (t) => {
  const s = await setup(t, { limits: { open: 3 } });
  const second = await s.w.client("alice", { session: "alice-ad2-b" });
  await s.devs.ad2.attachOn(second);
  await s.conns.ad.rpc(plan(10).begin);
  await s.conns.ad.rpc(plan(10).begin);
  const results = await Promise.allSettled([s.conns.ad.rpc(plan(10).begin), second.rpc(plan(10).begin), s.conns.ad2.rpc(plan(10).begin)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((x) => x.status === "rejected")) assert.deepEqual([r.reason.code, r.reason.frame?.limit ?? r.reason.limit], ["quota", "open"]);
  assert.equal(s.w.transfers.usage(s.A).open, 3);
  assert.deepEqual(s.accounting(), []);
});

test("quota: repeated empty begin/abort cycles stop at the tombstone (terminal slot) limit", async (t) => {
  const s = await setup(t, { limits: { slots: 5 } });
  for (let i = 0; i < 5; i++) {
    const p = plan(0);
    await s.conns.ad.rpc(p.begin);
    assert.equal((await s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id })).state, "aborted");
  }
  const e = await refusal(s.conns.ad.rpc(plan(0).begin));
  assert.equal(e.code, "quota");
  assert.equal(s.w.transfers.usage(s.A).slots, 5);
  assert.equal(s.w.transfers.usage(s.A).charged, 5 * CHARGE.tombstone, "each tombstone keeps its 512 bytes");
  // Past the horizon the tombstones go, and a begin is possible again.
  s.w.clock.advance(REPLAY_HORIZON_MS + 1);
  s.w.transfers.sweep();
  assert.equal(s.w.transfers.usage(s.A).slots, 0);
  assert.equal((await s.conns.ad.rpc(plan(0).begin)).state, "open");
  assert.deepEqual(s.accounting(), []);
});

test("quota: repeated publication of one blob stops at the relation limits (whole message refused)", async (t) => {
  const s = await setup(t, { limits: { relationsPerTransfer: 3, relations: 4 } });
  const g = await s.conversation();
  const p = plan(100);
  await s.upload(s.conns.ad, p);
  for (let i = 0; i < 3; i++) assert.equal((await s.publish(g, p)).state, "accepted");
  const queued = s.w.db.get("SELECT count(*) AS n FROM e2ee_queue WHERE json_extract(frame, '$.kind') = 'app'").n;
  const e = await refusal(s.publish(g, p));
  assert.equal(e.code, "quota");
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_queue WHERE json_extract(frame, '$.kind') = 'app'").n, queued, "the refused message queued nothing");
  const q = plan(10);
  await s.upload(s.conns.ad, q);
  assert.equal((await s.publish(g, q)).state, "accepted");
  assert.equal((await refusal(s.publish(g, q))).code, "quota", "the member's relation limit");
  assert.equal(s.w.transfers.usage(s.A).relations, 4);
  assert.equal(s.w.db.get("SELECT charge FROM transfer_relations LIMIT 1").charge, relationCharge(2), "256 + 64 per allowed device (bob's two) + 1 KiB for the publishing principal");
  assert.deepEqual(s.accounting(), []);
});

test("tombstones: a retried begin, commit or abort is answered consistently within the horizon; after it a begin is a new transfer", async (t) => {
  const s = await setup(t);
  const c = s.conns.ad;
  const p = plan(100);
  await s.upload(c, p);
  await c.rpc({ type: "upload_abort", transfer_id: p.id });
  s.w.transfers.sweep(); // reclamation: the chunks go, the tombstone stays
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM transfer_chunks").n, 0);
  s.w.clock.advance(REPLAY_HORIZON_MS - 1);
  s.w.transfers.sweep();
  assert.equal((await c.rpc(p.begin)).state, "aborted");
  assert.equal((await refusal(c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }))).code, "gone");
  assert.equal((await c.rpc({ type: "upload_abort", transfer_id: p.id })).state, "aborted");
  assert.equal((await refusal(c.rpc(chunkFrame(p, 0)))).code, "gone");
  s.w.clock.advance(2);
  s.w.transfers.sweep();
  assert.equal(tstate(s.w, p.id), null, "forgotten after the horizon");
  const again = await c.rpc(p.begin);
  assert.deepEqual([again.state, again.repeated], ["open", undefined], "a new transfer");
  assert.deepEqual(s.accounting(), []);
});

test("accounting: an 800-chunk transfer's metadata charge is within its reservation", async (t) => {
  const s = await setup(t, { cs: 262_144 });
  const p = { id: tidOf() };
  const r = await s.conns.ad.rpc({ type: "upload_begin", transfer_id: p.id, total_bytes: MAX_TOTAL_BYTES, chunk_count: 800, header_digest: "a".repeat(64) });
  assert.equal(r.state, "open");
  const want = CHARGE.transfer + CHARGE.tombstone + 800 * (CHARGE.chunk + TAG_BYTES) + MAX_TOTAL_BYTES;
  assert.equal(beginCharge(MAX_TOTAL_BYTES), want);
  assert.equal(s.w.transfers.usage(s.A).charged, want, "1 KiB + 800 * 128 bytes + the ciphertext + 512 bytes");
  const row = s.w.db.get("SELECT charge, reserved_remaining FROM transfers WHERE transfer_id = ?", p.id);
  assert.equal(row.charge + row.reserved_remaining, want);
  // Every chunk's own charge (ciphertext + 128) moves out of reserved_remaining as it arrives; their sum is the reservation's.
  assert.equal(row.reserved_remaining, 800 * (CHARGE.chunk + TAG_BYTES) + MAX_TOTAL_BYTES);
  // A member quota smaller than one full transfer refuses it at begin.
  const small = await setup(t, { cs: 262_144, limits: { memberQuota: want - 1 } });
  assert.equal((await refusal(small.conns.ad.rpc({ type: "upload_begin", transfer_id: tidOf(), total_bytes: MAX_TOTAL_BYTES, chunk_count: 800, header_digest: "a".repeat(64) }))).code, "quota");
});

test("quota: near-full terminal slots with outstanding sealed transfers, then simultaneous expiries: every termination completes, slots never exceed the limit", async (t) => {
  const s = await setup(t, { limits: { slots: 40, open: 40 } });
  const g = await s.conversation();
  const ids = [];
  for (let i = 0; i < 39; i++) {
    const p = plan(64 * (1 + (i % 3)));
    await s.upload(s.conns.ad, p);
    if (i % 2) await s.publish(g, p);
    ids.push(p.id);
  }
  assert.equal(s.w.transfers.usage(s.A).slots, 39);
  await s.conns.ad.rpc(plan(10).begin); // the 40th slot: open
  assert.equal((await refusal(s.conns.ad.rpc(plan(10).begin))).code, "quota");
  s.w.clock.advance(SEALED_LIFETIME_MS);
  const before = s.w.transfers.usage(s.A);
  s.w.transfers.sweep();
  const after = s.w.transfers.usage(s.A);
  assert.equal(after.slots, 40, "termination turns each slot into its tombstone, no new slot");
  assert.ok(after.slots <= 40 && before.slots <= 40);
  for (const id of ids) assert.equal(tstate(s.w, id), "expired");
  assert.equal(after.relations, 0);
  assert.equal(after.charged, 40 * CHARGE.tombstone, "all chunks reclaimed; 40 tombstones (the open one expired too)");
  assert.deepEqual(s.accounting(), []);
});

test("accounting: startup recomputation with partly received transfers; after restart it equals the sum of the stored rows, and a mismatch stops the start", async (t) => {
  const s = await setup(t);
  const p = plan(300);
  await s.conns.ad.rpc(p.begin);
  for (const i of [0, 3]) await s.conns.ad.rpc(chunkFrame(p, i));
  const q = plan(130);
  await s.upload(s.conns.ad, q);
  await s.conns.ad.rpc({ type: "upload_abort", transfer_id: q.id });
  const usage = s.w.transfers.usage(s.A);
  const row = s.w.db.get("SELECT reserved_remaining FROM transfers WHERE transfer_id = ?", p.id);
  assert.equal(row.reserved_remaining, beginCharge(300, CS) - CHARGE.transfer - CHARGE.tombstone - 2 * (CS + TAG_BYTES + CHARGE.chunk));
  await s.w.restart();
  assert.deepEqual(s.w.transfers.usage(s.A), usage, "recomputed and equal");
  assert.deepEqual(s.w.transfers.recompute().mismatches, []);
  // A stored total that differs from the rows: the transfer store refuses to start.
  s.w.db.tx((h) => h.run("UPDATE transfer_members SET charged = charged + 1 WHERE member_id = ?", s.A));
  await assert.rejects(s.w.restart(), /accounting does not match/);
});

test("accounting: a reservation is released once, including after a failed termination", async (t) => {
  const s = await setup(t);
  const g = await s.conversation();
  const p = plan(200);
  await s.upload(s.conns.ad, p);
  await s.publish(g, p);
  const live = s.w.transfers.usage(s.A).charged;
  s.w.fault.arm("before-commit");
  assert.equal((await refusal(s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id }))).code, "unavailable");
  assert.equal(tstate(s.w, p.id), "sealed", "nothing changed");
  assert.equal(s.w.transfers.usage(s.A).charged, live);
  assert.equal((await s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id })).state, "aborted");
  const ended = s.w.transfers.usage(s.A).charged;
  assert.equal(ended, CHARGE.tombstone + s.w.db.get("SELECT reclaiming FROM transfers WHERE transfer_id = ?", p.id).reclaiming);
  assert.equal((await s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id })).state, "aborted");
  s.w.clock.advance(SEALED_LIFETIME_MS);
  s.w.transfers.expireBatch();
  assert.equal(s.w.transfers.usage(s.A).charged, ended, "neither a retry nor the sweep releases it again");
  assert.equal(s.w.db.get("SELECT released FROM transfers WHERE transfer_id = ?", p.id).released, 1);
  assert.deepEqual(s.accounting(), []);
});

test("crash injection at each transaction boundary: before the commit nothing changes, after it the change is whole; the accounting always matches", async (t) => {
  const s = await setup(t);
  const g = await s.conversation();
  const c = s.conns.ad;
  const p = plan(130);
  const steps = [
    ["begin", () => c.rpc(p.begin)],
    ["chunk 0", () => c.rpc(chunkFrame(p, 0))],
    ["chunk 1", () => c.rpc(chunkFrame(p, 1))],
    ["chunk 2", () => c.rpc(chunkFrame(p, 2))],
    ["commit", () => c.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root })],
    ["publish", () => s.publish(g, p, { op: "o_" + "a".repeat(26) })],
    ["abort", () => c.rpc({ type: "upload_abort", transfer_id: p.id })],
  ];
  for (const [name, step] of steps) {
    const snapshot = JSON.stringify(rows(s.w, "SELECT * FROM transfers")) + JSON.stringify(rows(s.w, "SELECT member_id, charged, open, slots, relations FROM transfer_members"));
    s.w.fault.arm("before-commit");
    assert.equal((await refusal(step())).code, "unavailable", name);
    assert.equal(JSON.stringify(rows(s.w, "SELECT * FROM transfers")) + JSON.stringify(rows(s.w, "SELECT member_id, charged, open, slots, relations FROM transfer_members")), snapshot, `${name}: nothing changed`);
    s.w.fault.arm("after-commit");
    assert.equal((await refusal(step())).code, "unavailable", name);
    assert.deepEqual(s.accounting(), [], name);
    await step(); // the retry is answered from what was committed
  }
  // The sweep's own transactions: expiry, reclamation, tombstone removal.
  const q = plan(130);
  await s.upload(c, q);
  s.w.clock.advance(SEALED_LIFETIME_MS);
  s.w.fault.arm("before-commit");
  assert.throws(() => s.w.transfers.expireBatch(), /fault/);
  assert.equal(tstate(s.w, q.id), "sealed");
  s.w.transfers.expireBatch();
  s.w.fault.arm("before-commit");
  assert.throws(() => s.w.transfers.reclaimBatch(), /fault/);
  assert.ok(s.w.db.get("SELECT count(*) AS n FROM transfer_chunks").n > 0);
  s.w.transfers.reclaimBatch();
  s.w.clock.advance(REPLAY_HORIZON_MS);
  s.w.fault.arm("before-commit");
  assert.throws(() => s.w.transfers.forgetBatch(), /fault/);
  assert.equal(s.w.transfers.forgetBatch(), 2);
  assert.deepEqual(s.accounting(), []);
  assert.equal(s.w.transfers.usage(s.A).charged, 0);
});

test("one database: a message acceptance and its relation survive or vanish together under crash injection; a lost answer retried leaves exactly one relation", async (t) => {
  const s = await setup(t);
  const g = await s.conversation();
  const p = plan(100);
  await s.upload(s.conns.ad, p);
  const apps = () => s.w.db.get("SELECT count(*) AS n FROM e2ee_queue WHERE json_extract(frame, '$.kind') = 'app'").n;
  const rels = () => s.w.db.get("SELECT count(*) AS n FROM transfer_relations").n;
  const op = newOp();
  s.w.fault.arm("before-commit");
  assert.equal((await refusal(s.publish(g, p, { op }))).code, "unavailable");
  assert.deepEqual([apps(), rels()], [0, 0], "neither");
  s.w.fault.arm("after-commit");
  assert.equal((await refusal(s.publish(g, p, { op }))).code, "unavailable");
  assert.deepEqual([apps(), rels()], [2, 1], "both (one queue entry per recipient device, one relation)");
  const retry = await s.publish(g, p, { op });
  assert.deepEqual([retry.state, retry.repeated], ["accepted", true]);
  assert.deepEqual([apps(), rels()], [2, 1], "the op-id retry returns the original result: exactly one relation");
  // The same op id with other references is another payload.
  assert.equal((await refusal(s.publish(g, p, { op, blobs: [{ uploader_device: s.devs.ad.device, transfer_id: tidOf() }] }))).code, "op_reused");
  const frame = JSON.parse(s.w.db.get("SELECT frame FROM e2ee_queue WHERE json_extract(frame, '$.kind') = 'app' LIMIT 1").frame);
  assert.deepEqual(frame.blobs, [{ uploader_device: s.devs.ad.device, transfer_id: p.id }], "the reference travels with the message");
});

test("publication: own sealed uploads only, at most one per message, at least 24 hours left (exactly at and just below the boundary), no extension on retry", async (t) => {
  const s = await setup(t);
  const g = await s.conversation();
  const p = plan(100);
  await s.upload(s.conns.ad, p, { commit: false });
  assert.equal((await refusal(s.publish(g, p))).code, "not_sealed");
  await s.conns.ad.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root });
  assert.equal((await refusal(s.publish(g, p, { blobs: [{ uploader_device: s.devs.ad2.device, transfer_id: p.id }] }))).code, "not_allowed", "another device's upload");
  assert.equal((await refusal(s.publish(g, p, { blobs: [{ uploader_device: s.devs.ad.device, transfer_id: p.id }, { uploader_device: s.devs.ad.device, transfer_id: tidOf() }] }))).code, "bad_request");
  assert.equal((await refusal(s.publish(g, p, { blobs: [{ uploader_device: s.devs.ad.device, transfer_id: tidOf() }] }))).code, "gone");
  const expires = s.w.db.get("SELECT relay_expires FROM transfers WHERE transfer_id = ?", p.id).relay_expires;
  s.w.clock.set(expires - DAY); // exactly 24 hours left: accepted
  assert.equal((await s.publish(g, p)).state, "accepted");
  s.w.clock.set(expires - DAY + 1); // just below
  const e = await refusal(s.publish(g, p));
  assert.equal(e.code, "blob_expiring");
  assert.equal((await refusal(s.publish(g, p))).code, "blob_expiring", "a retry does not extend it");
  assert.equal(s.w.db.get("SELECT relay_expires FROM transfers WHERE transfer_id = ?", p.id).relay_expires, expires, "retention is fixed");
  // Another member's message never references it: carol's device is not the uploader.
  const gc = await s.conversation(["cd"], { by: "ad", peer: s.C, member: s.C });
  assert.equal((await refusal(s.publish(gc, p, { by: "cd", blobs: [{ uploader_device: s.devs.ad.device, transfer_id: p.id }] }))).code, "not_allowed");
});

test("authorization: unrelated member, the sender's own other device, a revoked device and unknown ids get the same gone; the recipient's devices download", async (t) => {
  const s = await setup(t);
  const g = await s.conversation();
  const p = plan(150);
  await s.upload(s.conns.ad, p);
  await s.publish(g, p);
  const c0 = await s.download("bd", p, 0);
  assert.equal(Buffer.from(c0.data, "base64").toString("hex"), p.chunks[0].toString("hex"));
  assert.deepEqual([c0.chunk_count, c0.root, c0.index], [3, p.root, 0]);
  assert.equal((await s.download("bd2", p, 2)).index, 2);
  const unknown = await refusal(s.download("bd", { id: tidOf() }));
  const carol = await refusal(s.download("cd", p));
  const own = await refusal(s.download("ad2", p));
  const uploader = await refusal(s.download("ad", p));
  for (const e of [carol, own, uploader]) assert.deepEqual(e, unknown, "the same answer as an unknown id");
  assert.equal(unknown.code, "gone");
  // A device of the same group that is not the recipient: the sender's own (v1 excludes them), above.
  // Revoked after publication: refused from then on.
  s.w.directory.revoke({ member: s.B, device: s.devs.bd2.device, by: { kind: "admin" } });
  // (The device check comes first, so its answer is the same whatever transfer it names.)
  const revoked = await refusal(s.download("bd2", p, 0));
  assert.equal(revoked.code, "device_revoked");
  assert.deepEqual(await refusal(s.download("bd2", { id: tidOf() }, 0)), revoked);
  assert.equal((await s.download("bd", p, 1)).index, 1, "the other device still downloads");
});

test("authorization: a group replaced after publication keeps the old relation; a device added later cannot download an earlier blob", async (t) => {
  const s = await setup(t);
  const g = await s.conversation(["bd"]);
  const p = plan(100);
  await s.upload(s.conns.ad, p);
  await s.publish(g, p);
  // Replace the conversation's group with both of bob's devices.
  const res = [];
  for (const d of ["bd", "bd2"]) res.push((await s.conns.ad.rpc({ type: "kp_take", request: reqId(), device: s.devs.ad.device, target: { member: s.B, device: s.devs[d].device } })).reservation);
  const r = await s.conns.ad.rpc({ type: "group_replace", op: newOp(), device: s.devs.ad.device, peer: s.B, expected_generation: 1, group: groupId(), epoch: 1, welcome: { recipients: [s.devs.bd.device, s.devs.bd2.device], mls: blob(), ratchet_tree: blob(32) }, kp_reservations: res });
  assert.equal(r.generation, 2);
  assert.equal((await s.download("bd", p, 0)).index, 0, "an allowed device keeps its access");
  assert.equal((await refusal(s.download("bd2", p, 0))).code, "gone", "the new group's devices are not added");
});

test("authorization: a grant withdrawn between chunks stops further downloads", async (t) => {
  let acc;
  const s = await setup(t, { access: () => (acc = createAccess({ stateDir: tmpDir(t), policy: null })) });
  acc.putGrants(s.B, 0, { default: "deny", visible: "all", entries: [{ selector: `member:${s.A}`, action: "allow" }] });
  const g = await s.conversation(["bd"]);
  const p = plan(150);
  await s.upload(s.conns.ad, p);
  await s.publish(g, p);
  assert.equal((await s.download("bd", p, 0)).index, 0);
  acc.putGrants(s.B, 1, { default: "deny", visible: "all", entries: [] });
  assert.equal((await refusal(s.download("bd", p, 1))).code, "gone");
});

test("upload: the relay's access policy can refuse a member transfers (4.1 gate 1); others upload as before", async (t) => {
  const s = await setup(t, { access: (members) => createAccess({ stateDir: tmpDir(t), policy: { groups: { ops: { members: [members.bob.id] } }, rules: [], defaultAction: "allow", requireGrants: false, transfers: [{ from: `member:${members.alice.id}`, action: "deny" }, { from: "group:ops", action: "allow" }] } }) });
  const e = await refusal(s.conns.ad.rpc(plan(10).begin));
  assert.equal(e.code, "not_allowed");
  assert.equal((await s.conns.bd.rpc(plan(10).begin)).state, "open");
  assert.equal((await s.conns.cd.rpc(plan(10).begin)).state, "open", "no rule: allowed");
});

test("TR8: two uploader devices choosing the same transfer_id: each reference and download selects exactly its own transfer", async (t) => {
  const s = await setup(t);
  const g = await s.conversation(["bd"]);
  const gc = await s.conversation(["cd"], { peer: s.C, member: s.C });
  const id = tidOf();
  const pa = plan(100, { id });
  const pb = plan(70, { id }); // bob's device, the same id
  await s.upload(s.conns.ad, pa);
  await s.upload(s.conns.bd, pb);
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM transfers WHERE transfer_id = ?", id).n, 2, "no conflict between uploaders");
  await s.publish(g, pa);
  const mine = await s.download("bd", pa, 0, s.devs.ad.device);
  assert.equal(Buffer.from(mine.data, "base64").toString("hex"), pa.chunks[0].toString("hex"));
  // carol is allowed for nothing: neither uploader's transfer.
  assert.equal((await refusal(s.download("cd", pa, 0, s.devs.ad.device))).code, "gone");
  assert.equal((await refusal(s.download("cd", pb, 0, s.devs.bd.device))).code, "gone");
  // bob is allowed for alice's, not for one of his own device's transfers with the same id.
  assert.equal((await refusal(s.download("bd", pb, 0, s.devs.bd.device))).code, "gone");
  await s.publish(gc, pa, {});
  assert.equal((await s.download("cd", pa, 0, s.devs.ad.device)).index, 0);
  assert.equal((await refusal(s.download("cd", pb, 0, s.devs.bd.device))).code, "gone", "still not bob's");
});

test("retention: expiry in the middle of a download ends it at the next chunk with gone {expired}; the abort ends it for every recipient", async (t) => {
  const s = await setup(t);
  const g = await s.conversation();
  const p = plan(200);
  await s.upload(s.conns.ad, p);
  await s.publish(g, p);
  assert.equal((await s.download("bd", p, 0)).index, 0);
  const expires = s.w.db.get("SELECT relay_expires FROM transfers WHERE transfer_id = ?", p.id).relay_expires;
  s.w.clock.set(expires);
  const e = await s.conns.bd.rpc({ type: "download", uploader_device: s.devs.ad.device, transfer_id: p.id, from_index: 1 }).catch((x) => x);
  assert.equal(e.code, "gone");
  assert.equal(e.frame?.state ?? e.state, "expired");
  s.w.transfers.sweep();
  assert.equal(tstate(s.w, p.id), "expired");
  assert.equal((await refusal(s.download("bd", p, 1))).code, "gone");
  // An abort of a sealed, referenced transfer ends it for every recipient.
  const q = plan(100);
  await s.upload(s.conns.ad, q);
  await s.publish(g, q);
  assert.equal((await s.download("bd2", q, 0)).index, 0);
  await s.conns.ad.rpc({ type: "upload_abort", transfer_id: q.id });
  assert.equal((await refusal(s.download("bd", q, 1))).code, "gone");
  assert.equal((await refusal(s.download("bd2", q, 1))).code, "gone");
});

test("tombstones: unreclaimed chunk bytes stay charged until deleted, and a crash during reclamation resumes without a double release", async (t) => {
  const s = await setup(t);
  const p = plan(64 * 40); // 40 chunks: three reclamation batches
  await s.upload(s.conns.ad, p);
  await s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id });
  const chunkBytes = p.chunks.reduce((n, c) => n + c.length + CHARGE.chunk, 0);
  assert.equal(s.w.transfers.usage(s.A).charged, CHARGE.tombstone + chunkBytes, "the chunks stay charged, as the tombstone's reclaiming");
  assert.equal(s.w.transfers.reclaimBatch(), 16);
  s.w.fault.arm("before-commit");
  assert.throws(() => s.w.transfers.reclaimBatch(), /fault/);
  const mid = s.w.transfers.usage(s.A).charged;
  assert.equal(mid, CHARGE.tombstone + chunkBytes - 16 * (CS + TAG_BYTES + CHARGE.chunk));
  await s.w.restart(); // recomputed at startup: equal
  assert.equal(s.w.transfers.usage(s.A).charged, mid);
  s.w.transfers.sweep();
  assert.equal(s.w.transfers.usage(s.A).charged, CHARGE.tombstone, "each batch released exactly once");
  assert.deepEqual(s.accounting(), []);
});

test("tombstones: startup after the horizon with reclamation pending keeps the tombstone and its key; reclaiming recomputed once; it goes after its last chunk", async (t) => {
  const s = await setup(t);
  const p = plan(64 * 20);
  await s.upload(s.conns.ad, p);
  await s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id });
  s.w.transfers.reclaimBatch(); // 16 of 20
  s.w.clock.advance(REPLAY_HORIZON_MS + DAY);
  await s.w.restart();
  assert.equal(s.w.db.get("SELECT reclaiming FROM transfers WHERE transfer_id = ?", p.id).reclaiming, 4 * (CS + TAG_BYTES + CHARGE.chunk), "recomputed equal to the remaining chunks");
  assert.equal(s.w.transfers.forgetBatch(), 0, "chunks remain: the tombstone stays past its horizon");
  const conns = await (async () => {
    const c = await s.w.client("alice", { session: "alice-ad-r" });
    await s.devs.ad.attachOn(c);
    return c;
  })();
  assert.equal((await conns.rpc(p.begin)).state, "aborted", "a begin with that key is answered from the tombstone");
  s.w.transfers.reclaimBatch();
  assert.equal(s.w.transfers.usage(s.A).charged, CHARGE.tombstone);
  assert.equal(s.w.transfers.forgetBatch(), 1, "gone after its last chunk");
  assert.equal(s.w.transfers.usage(s.A).charged, 0);
  assert.deepEqual(s.accounting(), []);
});

test("store: a store with another page size is refused", (t) => {
  const dir = tmpDir(t);
  const release = lockStateDir(dir);
  t.after(() => release());
  // A store created by hand with 8 KiB pages, as a foreign tool might.
  const db = openRelayDb({ dir, migrations: RELAY_MIGRATIONS, fullfsync: false });
  assert.equal(Number(db.get("PRAGMA page_size").page_size), 4096);
  assert.equal(Number(db.get("PRAGMA auto_vacuum").auto_vacuum), 2, "incremental");
  db.close();
  const other = tmpDir(t);
  const rel2 = lockStateDir(other);
  t.after(() => rel2());
  const file = path.join(other, "relay.db");
  fs.copyFileSync(path.join(dir, "relay.db"), file);
  fs.chmodSync(file, 0o600);
  // Rewrite the copy with another page size (VACUUM outside WAL mode applies it).
  {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA journal_mode = DELETE");
    raw.exec("PRAGMA page_size = 8192");
    raw.exec("VACUUM");
    assert.equal(Number(raw.prepare("PRAGMA page_size").get().page_size), 8192);
    raw.close();
  }
  fs.writeFileSync(path.join(other, ".relay.db.created"), "", { mode: 0o600 });
  assert.throws(() => openRelayDb({ dir: other, migrations: RELAY_MIGRATIONS, fullfsync: false }), /page size of 8192/);
});

/**
 * The largest serialized record of a row (SQLite's record format): a header of one varint per
 * column type plus its own length, then the values. `cols` gives each column's largest value as
 * {int} (an 8-byte integer at most), {text: n} or {blob: n}. A rowid table's entry adds the rowid.
 */
function recordBytes(cols, { rowid = true } = {}) {
  const varint = (n) => (n < 128 ? 1 : n < 16384 ? 2 : n < 2097152 ? 3 : n < 268435456 ? 4 : 9);
  let header = 0;
  let body = 0;
  for (const c of cols) {
    if (c.int) {
      header += 1;
      body += 8;
    } else {
      const n = c.text ?? c.blob;
      header += varint(n * 2 + 13);
      body += n;
    }
  }
  header += varint(header + 1);
  return header + body + (rowid ? 9 : 0) + 9; // + the cell's payload-size varint
}

test("accounting: the per-row charges bound the schema's largest rows and their index entries", () => {
  // Bounded columns, from the migration's CHECKs.
  assert.match(TRANSFER_MIGRATION, /length\(uploader_member\) BETWEEN 1 AND 70/);
  assert.match(TRANSFER_MIGRATION, /length\(devices\) <= 1858/);
  const I = { int: true };
  const member = { text: 70 };
  const device = { text: 26 };
  const tid = { text: 32 };
  const d32 = { blob: 32 };
  const state = { text: 7 };
  // transfers: tid, member, device, transfer_id, total, count, params, header_digest, state, created,
  // open_expires, sealed_at, relay_expires, root, terminal_at, charge, reserved_remaining, reclaiming, released,
  // denied (migration 8, A8)
  const live = recordBytes([I, member, device, tid, I, I, d32, d32, state, I, I, I, I, d32, I, I, I, I, I, I]);
  const tomb = recordBytes([I, member, device, tid, I, I, d32, { blob: 0 }, state, I, I, I, I, { blob: 0 }, I, I, I, I, I, I]);
  // The unique key's entry, and one partial index entry: open or sealed (live), ended (tombstone).
  const transferIndexes = recordBytes([device, tid, I], { rowid: false }) + recordBytes([I, I], { rowid: false });
  assert.ok(live + transferIndexes <= CHARGE.transfer, `a live transfer row and its index entries: ${live + transferIndexes} <= ${CHARGE.transfer}`);
  assert.ok(tomb + transferIndexes <= CHARGE.tombstone, `a tombstone and its index entries: ${tomb + transferIndexes} <= ${CHARGE.tombstone}`);
  assert.match(TRANSFER_MIGRATION, /transfers_open ON transfers \(open_expires\) WHERE state = 'open'/, "partial indexes: a tombstone has an entry in the ended index only");
  // transfer_chunks: tid, idx, len, digest, data (+ the primary key's index on (tid, idx)).
  const chunk = recordBytes([I, I, I, d32, { blob: 0 }]) + recordBytes([I, I, I], { rowid: false });
  assert.ok(chunk <= CHARGE.chunk, `a chunk row's own bytes beside its ciphertext: ${chunk} <= ${CHARGE.chunk}`);
  // transfer_relations: rid, tid, op, recipient, devices (29 bytes per device in JSON), charge, created,
  // sender (the publishing principal, migration 6); UNIQUE (tid, op).
  assert.match(RELATION_SENDER_MIGRATION, new RegExp(`length\\(sender\\) <= ${MAX_SENDER_BYTES}`));
  for (const n of [0, 1, 64]) {
    const rel = recordBytes([I, I, { text: 28 }, member, { text: 2 + 29 * n }, I, I, { text: MAX_SENDER_BYTES }]) + recordBytes([I, { text: 28 }, I], { rowid: false });
    assert.ok(rel <= relationCharge(n), `a relation with ${n} devices: ${rel} <= ${relationCharge(n)}`);
  }
});

test("a transfer store over a store at migration 4 is refused (its tables do not exist), and the relay without the store announces no transfers", async (t) => {
  const dir = tmpDir(t);
  const release = lockStateDir(dir);
  t.after(() => release());
  const db = openRelayDb({ dir, migrations: RELAY_MIGRATIONS.slice(0, 4), fullfsync: false });
  t.after(() => db.close());
  assert.throws(() => createTransferStore({ db }), /no such table/);
  const w = await deviceRelay(t, { e2ee: true });
  assert.equal((await w.client("alice")).caps.includes(TRANSFER_CAP), false);
});

// ---- A8 (amendments 3.5 v4.1, N11): upload authorization is live --------------------------------

/**
 * An access service whose upload verdict a test sets: "allow" (the policy decides, as before),
 * "deny" (the policy now refuses this member) or "retry" (a stale claim view). The relay asks it
 * at every acceptance of new upload work.
 */
function switchableAccess(t) {
  const ctl = { mode: "allow" };
  ctl.make = () => {
    const a = createAccess({ stateDir: tmpDir(t), policy: null });
    return new Proxy(a, { get: (o, k) => (k === "mayUpload" ? (from) => (ctl.mode === "allow" ? o.mayUpload(from) : ctl.mode) : o[k]) });
  };
  return ctl;
}
const statusOf = (c, p) => c.rpc({ type: "upload_status", transfer_id: p.id });
const opsWith = (w, op) => w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE op = ?", op).n;

test("A8: a deny after begin: the next new chunk, the seal and the publication are refused (not_allowed); each transfer is denied, still after a restart", async (t) => {
  const ctl = switchableAccess(t);
  const s = await setup(t, { access: ctl.make });
  const g = await s.conversation(["bd"]);
  const p1 = plan(150); // begun, chunk 0 stored
  await s.conns.ad.rpc(p1.begin);
  await s.conns.ad.rpc(chunkFrame(p1, 0));
  const p2 = plan(150); // every chunk stored, not sealed
  await s.upload(s.conns.ad, p2, { commit: false });
  const p3 = plan(150); // sealed, not published
  await s.upload(s.conns.ad, p3);
  ctl.mode = "deny";
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p1, 1)))).code, "not_allowed", "a new chunk");
  assert.equal((await refusal(s.conns.ad.rpc({ type: "upload_commit", transfer_id: p2.id, root: p2.root }))).code, "not_allowed", "a seal");
  const op = newOp();
  assert.equal((await refusal(s.publish(g, p3, { op }))).code, "not_allowed", "a publication");
  assert.equal(opsWith(s.w, op), 0, "the publication's op is not recorded");
  for (const p of [p1, p2, p3]) assert.equal((await statusOf(s.conns.ad, p)).state, "denied");
  // The marker was committed: a restarted relay still has every one denied.
  await s.w.restart();
  const c = await s.w.client("alice", { session: "alice-ad-again" });
  await s.devs.ad.attachOn(c);
  for (const p of [p1, p2, p3]) assert.equal((await statusOf(c, p)).state, "denied", "after a restart");
  assert.deepEqual(s.accounting(), []);
});

test("A8: after a denial every chunk and seal request answers denied (a chunk stored before it too, and after a re-allow); upload_status reports it; abort works", async (t) => {
  const ctl = switchableAccess(t);
  const s = await setup(t, { access: ctl.make });
  const p = plan(150);
  await s.conns.ad.rpc(p.begin);
  assert.equal((await s.conns.ad.rpc(chunkFrame(p, 0))).index, 0);
  // Until a denial, an accepted chunk keeps its exact idempotent answer.
  assert.equal((await s.conns.ad.rpc(chunkFrame(p, 0))).repeated, true);
  ctl.mode = "deny";
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p, 1)))).code, "not_allowed");
  ctl.mode = "allow"; // a re-allow does not reopen it
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p, 0)))).code, "denied", "a retry of a chunk stored before the denial");
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p, 2)))).code, "denied");
  assert.equal((await refusal(s.conns.ad.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }))).code, "denied");
  const st = await statusOf(s.conns.ad, p);
  assert.deepEqual([st.state, st.stored], ["denied", []]);
  assert.equal((await s.conns.ad.rpc(p.begin)).state, "denied", "a retried begin answers the terminal state");
  assert.equal((await s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id })).state, "denied");
  assert.equal((await s.conns.ad.rpc({ type: "upload_abort", transfer_id: p.id })).state, "denied", "again");
});

test("A8: a publication op accepted before the denial still answers its recorded result; a new publication of it is refused", async (t) => {
  const ctl = switchableAccess(t);
  const s = await setup(t, { access: ctl.make });
  const g = await s.conversation(["bd"]);
  const p = plan(150);
  await s.upload(s.conns.ad, p);
  const op = newOp();
  const first = await s.publish(g, p, { op });
  assert.equal(first.state, "accepted");
  ctl.mode = "deny";
  const again = await s.publish(g, p, { op });
  assert.deepEqual([again.state, again.recipients, again.repeated], [first.state, first.recipients, true], "the exact recorded result (e2ee_ops)");
  assert.equal((await refusal(s.publish(g, p))).code, "not_allowed", "a new publication op");
  const after = await s.publish(g, p, { op });
  assert.deepEqual([after.state, after.recipients], [first.state, first.recipients], "still after the denial");
});

test("A8: a publication denied after the seal leaves no accepted op; the denied transfer is reclaimed like an aborted one (counted once) and its slot released", async (t) => {
  const ctl = switchableAccess(t);
  const s = await setup(t, { access: ctl.make });
  const g = await s.conversation(["bd"]);
  const p = plan(150);
  await s.upload(s.conns.ad, p);
  const queued = () => s.w.ds.usage({ member: s.B, device: s.devs.bd.device }).messages;
  const before = queued(); // the conversation's Welcome
  ctl.mode = "deny";
  const op = newOp();
  assert.equal((await refusal(s.publish(g, p, { op }))).code, "not_allowed");
  assert.equal(opsWith(s.w, op), 0, "no accepted op");
  assert.equal(queued(), before, "nothing queued for the recipient");
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM transfer_relations").n, 0, "no relation");
  assert.deepEqual(s.accounting(), []);
  s.w.transfers.sweep();
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM transfer_chunks").n, 0, "its chunks reclaimed");
  assert.equal(s.w.transfers.usage(s.A).charged, CHARGE.tombstone, "only the tombstone stays charged");
  assert.deepEqual(s.accounting(), []);
  s.w.clock.advance(REPLAY_HORIZON_MS + 1);
  s.w.transfers.sweep();
  assert.deepEqual([s.w.transfers.usage(s.A).slots, s.w.transfers.usage(s.A).charged], [0, 0], "slot and quota released");
});

test("A8: a stale claim view pauses an upload (unavailable, never denied) at chunks, the seal and the publication; it resumes when the view is fresh", async (t) => {
  const ctl = switchableAccess(t);
  const s = await setup(t, { access: ctl.make });
  const g = await s.conversation(["bd"]);
  const p = plan(150);
  await s.conns.ad.rpc(p.begin);
  ctl.mode = "retry";
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p, 0)))).code, "unavailable");
  assert.equal((await statusOf(s.conns.ad, p)).state, "open");
  ctl.mode = "allow";
  for (let i = 0; i < p.count; i++) await s.conns.ad.rpc(chunkFrame(p, i));
  ctl.mode = "retry";
  assert.equal((await refusal(s.conns.ad.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root }))).code, "unavailable");
  assert.equal((await statusOf(s.conns.ad, p)).state, "open");
  ctl.mode = "allow";
  assert.equal((await s.conns.ad.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root })).state, "sealed");
  ctl.mode = "retry";
  const op = newOp();
  assert.equal((await refusal(s.publish(g, p, { op }))).code, "unavailable");
  assert.equal(opsWith(s.w, op), 0);
  assert.equal((await statusOf(s.conns.ad, p)).state, "sealed");
  ctl.mode = "allow";
  assert.equal((await s.publish(g, p, { op })).state, "accepted", "the same op, once the view is fresh");
});

test("A8: after a re-allow a denied upload stays denied, and a new upload proceeds", async (t) => {
  const ctl = switchableAccess(t);
  const s = await setup(t, { access: ctl.make });
  const p = plan(150);
  await s.conns.ad.rpc(p.begin);
  ctl.mode = "deny";
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p, 0)))).code, "not_allowed");
  ctl.mode = "allow";
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p, 0)))).code, "denied");
  const q = plan(150);
  assert.equal((await s.upload(s.conns.ad, q)).state, "sealed");
});
