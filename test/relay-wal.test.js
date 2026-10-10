// WAL admission for the whole store (design 6, "Admission on the actual WAL size", "Every write
// transaction has a bounded size", "Checkpoints are not writes"): a reader pinning a snapshot keeps
// the log from being reset; bulk writes stop at the soft limit, progress writes at the hard limit,
// maintenance at the budget; the WAL never exceeds hard + budget + the allowance A; a checkpoint is
// never refused; terminations obey admission and complete once a checkpoint succeeds. Each kind of
// write transaction's worst case is measured against A. The limits are scaled down here so the
// tests run in seconds; the relay's chunk size is the wire format's (256 KiB).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TRANSACTION_ALLOWANCE } from "../lib/relaydb.js";
import { KP_LIFETIME_MS } from "../lib/mls/policy.js";
import { MAX_MLS_BYTES } from "../lib/mls/relayds.js";
import { SEALED_LIFETIME_MS } from "../lib/mls/relaytransfers.js";
import { TAG_BYTES, rootOf } from "../lib/transferwire.js";
import { deviceRelay, fakeDevice, newOp, refusal } from "./mls-helpers.js";

const MiB = 1024 * 1024;
const CS = 262_144;
const A = TRANSACTION_ALLOWANCE;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const groupId = () => crypto.randomBytes(16).toString("hex");
const b64 = (n) => crypto.randomBytes(n).toString("base64");
let reqN = 0;
const reqId = () => `req-wal-${++reqN}-${crypto.randomBytes(3).toString("hex")}`;

/** A transfer of `count` full chunks (random ciphertext of the expected lengths). */
function plan(total, cs = CS) {
  const count = Math.max(1, Math.ceil(total / cs));
  const chunks = Array.from({ length: count }, (_, i) => crypto.randomBytes((i < count - 1 ? cs : total - (count - 1) * cs) + TAG_BYTES));
  const id = crypto.randomBytes(16).toString("hex");
  return { id, count, chunks, root: rootOf(chunks).toString("hex"), begin: { type: "upload_begin", transfer_id: id, total_bytes: total, chunk_count: count, header_digest: crypto.randomBytes(32).toString("hex") } };
}
const chunkFrame = (p, i) => ({ type: "upload_chunk", transfer_id: p.id, index: i, data: p.chunks[i].toString("base64") });

async function setup(t, { admission = {}, cs = CS, limits = {} } = {}) {
  const w = await deviceRelay(t, { e2ee: true, transfers: { chunkSize: cs, limits }, admission });
  const devs = {};
  const conns = {};
  for (const [name, member] of [["ad", "alice"], ["bd", "bob"]]) {
    const d = await fakeDevice(w.realm, w.members[member].id);
    const c = await w.client(member, { session: `${member}-${name}` });
    await d.registerOn(c); // A9: register and attach with proofs, then KeyPackages
    await d.attachOn(c);
    await c.rpc({ type: "kp_upload", device: d.device, packages: await d.packages(4, w.clock.now() + KP_LIFETIME_MS) });
    devs[name] = d;
    conns[name] = c;
  }
  const res = (await conns.ad.rpc({ type: "kp_take", request: reqId(), device: devs.ad.device, target: { member: w.members.bob.id, device: devs.bd.device } })).reservation;
  const g = await conns.ad.rpc({ type: "group_create", op: newOp(), device: devs.ad.device, peer: w.members.bob.id, group: groupId(), epoch: 1, welcome: { recipients: [devs.bd.device], mls: b64(64) }, kp_reservations: [res] });
  /** A reader holding a snapshot open on the store (another connection, as a long backup read would). */
  const pin = () => {
    const r = new DatabaseSync(w.db.path, { readOnly: true });
    r.exec("BEGIN");
    r.prepare("SELECT count(*) AS n FROM transfers").get();
    return { close: () => (r.exec("COMMIT"), r.close()) };
  };
  const wal = () => w.db.stat().wal;
  return { w, devs, conns, group: g.group, pin, wal };
}

/** Run `fn` until it is refused with "busy"; returns {n, maxWal}, checking each admitted step against the WAL before it. */
async function untilBusy(s, fn, ceiling, max = 10_000) {
  let maxWal = s.wal();
  for (let n = 0; n < max; n++) {
    const before = s.wal();
    try {
      await fn(n);
    } catch (e) {
      if (e.code !== "busy") throw e;
      assert.ok(before > ceiling, `refused only above its threshold (${before} > ${ceiling})`);
      assert.equal(typeof e.retry_after_ms, "number");
      return { n, maxWal };
    }
    assert.ok(before <= ceiling, `admitted only at or below its threshold (${before} <= ${ceiling})`);
    assert.ok(s.wal() - before <= A, "each admitted transaction stays under the allowance");
    maxWal = Math.max(maxWal, s.wal());
  }
  throw new Error("never refused");
}

test("WAL admission: with a pinned reader, bulk stops at the soft limit, progress at the hard limit, maintenance at the budget; the WAL never exceeds the bound; all resumes after the reader ends and a checkpoint succeeds", async (t) => {
  const admission = { soft: 2 * MiB, hard: 4 * MiB, budget: 2 * MiB };
  const s = await setup(t, { admission });
  const reader = s.pin();
  const bound = admission.hard + admission.budget + A;
  // Uploads (bulk) until refused at the soft limit.
  const p = plan(40 * CS);
  await s.conns.ad.rpc(p.begin);
  const bulk = await untilBusy(s, (i) => s.conns.ad.rpc(chunkFrame(p, i)), admission.soft);
  assert.ok(bulk.n > 0);
  // Messages and commits (progress) keep coming after uploads are refused, until the hard limit.
  const mls = b64(MAX_MLS_BYTES - 1024);
  let epoch = 1;
  const progress = await untilBusy(s, async (i) => {
    if (i % 2) await s.conns.ad.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.devs.ad.device, group: s.group, mls, target: "bob" });
    else await s.conns.ad.rpc({ type: "send_e2ee", kind: "commit", op: newOp(), device: s.devs.ad.device, group: s.group, expected_epoch: epoch++, mls, roster_delta: { add: [], remove: [] }, kp_reservations: [] });
  }, admission.hard);
  assert.ok(progress.n > 0, "progress writes went on above the soft limit");
  assert.equal((await refusal(s.conns.ad.rpc(chunkFrame(p, bulk.n)))).code, "busy", "bulk is still refused");
  // Maintenance until the budget.
  const maintenance = await untilBusy(s, async (i) => {
    // Raw maintenance appends (an audit-sized row each) stand in for sweeps and cleanup.
    s.w.db.tx((h) => h.run("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", `wal-test-${i}`, crypto.randomBytes(200 * 1024)), { cls: "maintenance" });
  }, admission.hard + admission.budget);
  assert.ok(maintenance.n > 0);
  const top = Math.max(bulk.maxWal, progress.maxWal, maintenance.maxWal, s.wal());
  assert.ok(top <= bound, `the WAL (${top}) never exceeds hard + budget + A (${bound})`);
  const adm = s.w.db.admission();
  assert.deepEqual(adm.refused, { bulk: true, progress: true, maintenance: true });
  assert.ok(adm.refusals.bulk >= 1 && adm.refusals.progress >= 1 && adm.refusals.maintenance >= 1);
  assert.ok(adm.checkpoints.attempts >= 1, "a checkpoint was attempted when a write was refused above the hard limit");
  assert.ok(adm.checkpoints.busy >= 1, "and was busy while the reader held its snapshot");
  // The reader ends; the next checkpoint succeeds and everything resumes.
  reader.close();
  const cp = s.w.db.checkpoint();
  assert.equal(cp.busy, 0);
  assert.equal(s.wal(), 0, "TRUNCATE reset the log");
  assert.equal((await s.conns.ad.rpc(chunkFrame(p, bulk.n))).index, bulk.n, "uploads resume");
  assert.equal((await s.conns.ad.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.devs.ad.device, group: s.group, mls: b64(64), target: "bob" })).state, "accepted");
});

test("WAL admission: a checkpoint is attempted and succeeds while every append class is refused", async (t) => {
  const admission = { soft: 1 * MiB, hard: 1 * MiB, budget: 512 * 1024 };
  const s = await setup(t, { admission });
  const reader = s.pin();
  for (let i = 0; ; i++) {
    try {
      s.w.db.tx((h) => h.run("INSERT INTO store_meta (key, value) VALUES (?, ?)", `fill-${i}`, crypto.randomBytes(128 * 1024)), { cls: "maintenance" });
    } catch (e) {
      if (e.code === "busy") break;
      throw e;
    }
  }
  assert.deepEqual(s.w.db.admission().refused, { bulk: true, progress: true, maintenance: true });
  assert.ok(s.w.db.refusing());
  assert.equal(s.w.db.checkpoint().busy, 1, "attempted while the reader pins the log (never refused by admission)");
  reader.close();
  // The sweep attempts it: a checkpoint is no write and needs no admission.
  const r = s.w.transfers.sweep();
  assert.equal(r.checkpoint.busy, 0);
  assert.equal(s.wal(), 0);
  assert.deepEqual(s.w.db.admission().refused, { bulk: false, progress: false, maintenance: false }, "refusals clear below the soft limit");
});

test("WAL admission: terminations attempted after every append class has stopped are refused with busy and claim nothing; expired content stays unreadable; they complete once a checkpoint succeeds", async (t) => {
  const admission = { soft: 1 * MiB, hard: 1 * MiB, budget: 512 * 1024 };
  const s = await setup(t, { admission, cs: 64 });
  const p = plan(300, 64);
  await s.conns.ad.rpc(p.begin);
  for (let i = 0; i < p.count; i++) await s.conns.ad.rpc(chunkFrame(p, i));
  await s.conns.ad.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root });
  await s.conns.ad.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.devs.ad.device, group: s.group, mls: b64(64), target: "bob", blobs: [{ uploader_device: s.devs.ad.device, transfer_id: p.id }] });
  const q = plan(100, 64);
  await s.conns.ad.rpc(q.begin);
  const reader = s.pin();
  for (let i = 0; ; i++) {
    try {
      s.w.db.tx((h) => h.run("INSERT INTO store_meta (key, value) VALUES (?, ?)", `fill-${i}`, crypto.randomBytes(128 * 1024)), { cls: "maintenance" });
    } catch (e) {
      if (e.code === "busy") break;
      throw e;
    }
  }
  // The uploader's abort: busy, not a claim that the transfer ended.
  const e = await refusal(s.conns.ad.rpc({ type: "upload_abort", transfer_id: q.id }));
  assert.equal(e.code, "busy");
  assert.equal(s.w.db.get("SELECT state FROM transfers WHERE transfer_id = ?", q.id).state, "open");
  // Expiry waits for a later sweep; meanwhile the expired transfer is already unreadable.
  s.w.clock.advance(SEALED_LIFETIME_MS);
  const sw = s.w.transfers.sweep();
  assert.equal(sw.busy, true);
  assert.equal(sw.expired, 0);
  assert.equal(s.w.db.get("SELECT state FROM transfers WHERE transfer_id = ?", p.id).state, "sealed", "no termination claimed");
  const d = await s.conns.bd.rpc({ type: "download", uploader_device: s.devs.ad.device, transfer_id: p.id, from_index: 0 }).catch((x) => x);
  assert.deepEqual([d.code, d.state], ["gone", "expired"], "expired content is unreadable before its termination");
  // The reader ends: the sweep's checkpoint succeeds and the terminations complete.
  reader.close();
  // The first refused write above the hard limit attempts a checkpoint right away; it succeeds now.
  const done = s.w.transfers.sweep();
  assert.equal(done.expired, 2);
  assert.equal((await s.conns.ad.rpc({ type: "upload_abort", transfer_id: q.id })).state, "expired", "the retried abort answers the final state");
  assert.equal(s.w.db.get("SELECT state FROM transfers WHERE transfer_id = ?", p.id).state, "expired");
  assert.deepEqual(s.w.transfers.recompute().mismatches, []);
});

test("WAL admission: from just below the maintenance threshold with a populated free list and a pinned reader, terminations of 800-chunk transfers, reclamation, vacuum steps, expiry batches and revocation cleanup each stay under A and the WAL under the bound; reclamation resumes after a checkpoint", async (t) => {
  const admission = { soft: 2 * MiB, hard: 3 * MiB, budget: 3 * MiB };
  const s = await setup(t, { admission, cs: 1024, limits: { open: 40 } });
  const bound = admission.hard + admission.budget + A;
  // 800-chunk transfers (1 KiB chunks), sealed; and a populated free list from an earlier delete.
  const big = [];
  for (let k = 0; k < 2; k++) {
    // Through the store directly (the frames' per-connection rate limit is not under test here).
    const p = plan(800 * 1024, 1024);
    const up = { member: s.w.members.alice.id, device: s.devs.ad.device };
    s.w.transfers.begin({ uploader: up, transferId: p.id, totalBytes: 800 * 1024, chunkCount: 800, headerDigest: p.begin.header_digest });
    for (let i = 0; i < p.count; i++) {
      s.w.transfers.chunk({ uploader: up, transferId: p.id, index: i, data: p.chunks[i] });
      if (i % 64 === 0) s.w.db.checkpoint(); // (the sweep's checkpoint, without its other work)
    }
    s.w.transfers.commit({ uploader: up, transferId: p.id, root: p.root });
    big.push(p);
  }
  s.w.db.tx((h) => h.run("INSERT INTO store_meta (key, value) VALUES ('wal-free', ?)", crypto.randomBytes(2 * MiB)), { cls: "maintenance" });
  s.w.db.tx((h) => h.run("DELETE FROM store_meta WHERE key = 'wal-free'"), { cls: "maintenance" });
  s.w.db.checkpoint();
  // Expiring transfers for an expiry batch, and KeyPackages for a revocation's cleanup.
  // Through the store too: this test sends no frame after its setup, so it never depends on a
  // client connection staying up across the long synchronous stretches above (the test relay does
  // not ping, and the client drops a link silent for 45 s of wall-clock time, which slow disks in
  // the full parallel suite can reach).
  const up = { member: s.w.members.alice.id, device: s.devs.ad.device };
  for (let i = 0; i < 20; i++) {
    const b = plan(10, 1024).begin;
    s.w.transfers.begin({ uploader: up, transferId: b.transfer_id, totalBytes: b.total_bytes, chunkCount: b.chunk_count, headerDigest: b.header_digest });
  }
  assert.ok(Number(s.w.db.get("PRAGMA freelist_count").freelist_count) > 0, "a populated free list");
  s.w.db.checkpoint();
  const reader = s.pin();
  // Up to just below the hard limit.
  for (let i = 0; s.wal() < admission.hard - 256 * 1024; i++) s.w.db.tx((h) => h.run("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", `near-${i}`, crypto.randomBytes(64 * 1024)), { cls: "maintenance" });
  const steps = [];
  const step = (name, fn) => {
    const before = s.wal();
    let r;
    try {
      r = fn();
    } catch (e) {
      if (e.code !== "busy") throw e;
      steps.push({ name, busy: true });
      return null;
    }
    const grew = s.wal() - before;
    assert.ok(grew <= A, `${name}: ${grew} bytes of WAL <= A`);
    assert.ok(s.wal() <= bound, `${name}: the WAL stays under the bound`);
    steps.push({ name, grew });
    return r;
  };
  for (const p of big) step("termination of an 800-chunk transfer", () => s.w.transfers.abort({ uploader: { member: s.w.members.alice.id, device: s.devs.ad.device }, transferId: p.id }));
  s.w.clock.advance(2 * 86_400_000);
  for (let i = 0; i < 3; i++) step("expiry batch", () => s.w.transfers.expireBatch());
  for (let i = 0; i < 400; i++) if (step("reclamation batch", () => s.w.transfers.reclaimBatch()) === null) break;
  for (let i = 0; i < 20; i++) if (step("vacuum step", () => s.w.db.vacuumStep()) === null) break;
  step("revocation cleanup", () => s.w.directory.revoke({ member: s.w.members.bob.id, device: s.devs.bd.device, by: { kind: "admin" } }));
  assert.ok(steps.some((x) => x.name === "reclamation batch" && x.grew !== undefined), "reclamation ran");
  assert.ok(s.wal() <= bound);
  const left = Number(s.w.db.get("SELECT count(*) AS n FROM transfer_chunks").n);
  // Reclamation resumes after the reader ends and a checkpoint succeeds.
  reader.close();
  s.w.db.checkpoint();
  for (let i = 0; i < 10 && Number(s.w.db.get("SELECT count(*) AS n FROM transfer_chunks").n); i++) s.w.transfers.sweep();
  assert.ok(left >= 0);
  assert.equal(Number(s.w.db.get("SELECT count(*) AS n FROM transfer_chunks").n), 0, "every chunk reclaimed");
  assert.deepEqual(s.w.transfers.recompute().mismatches, []);
});

test("each kind of write transaction's worst case, measured against the allowance A", async (t) => {
  const s = await setup(t, { limits: { open: 40, relationsPerTransfer: 64, relations: 2000 } });
  const sizes = {};
  const measure = async (name, fn) => {
    s.w.db.checkpoint();
    const reader = s.pin(); // nothing is checkpointed under it: the log only grows by what is written
    const before = s.wal();
    try {
      await fn();
    } finally {
      reader.close();
    }
    sizes[name] = s.wal() - before;
    assert.ok(sizes[name] <= A, `${name}: ${sizes[name]} bytes of WAL <= A (${A})`);
  };
  const me = { member: s.w.members.alice.id, device: s.devs.ad.device };
  // A chunk: about 256 KiB of data.
  const p = plan(20 * CS);
  await s.conns.ad.rpc(p.begin);
  await measure("chunk", () => s.conns.ad.rpc(chunkFrame(p, 0)));
  for (let i = 1; i < p.count; i++) await s.conns.ad.rpc(chunkFrame(p, i));
  await s.conns.ad.rpc({ type: "upload_commit", transfer_id: p.id, root: p.root });
  // A 3.3 commit acceptance at its frame bound (a recipient device's queued copy, the log entry).
  await measure("commit acceptance at the frame bound", () => s.conns.ad.rpc({ type: "send_e2ee", kind: "commit", op: newOp(), device: s.devs.ad.device, group: s.group, expected_epoch: 1, mls: b64(MAX_MLS_BYTES - 1024), roster_delta: { add: [], remove: [] }, kp_reservations: [] }));
  // A publication (a message with a reference: its queue entry and the relation).
  for (let i = 0; i < 63; i++) await s.conns.ad.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.devs.ad.device, group: s.group, mls: b64(64), target: "bob", blobs: [{ uploader_device: s.devs.ad.device, transfer_id: p.id }] });
  await measure("publication", () => s.conns.ad.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.devs.ad.device, group: s.group, mls: b64(MAX_MLS_BYTES - 1024), target: "bob", blobs: [{ uploader_device: s.devs.ad.device, transfer_id: p.id }] }));
  // A termination with its 64 relations (metadata only).
  await measure("termination", () => s.w.transfers.abort({ uploader: me, transferId: p.id }));
  // One reclamation batch: 16 full chunks.
  await measure("reclamation batch", () => s.w.transfers.reclaimBatch());
  // One capped vacuum step.
  s.w.transfers.sweep();
  const free = plan(16 * CS);
  await s.conns.ad.rpc(free.begin);
  for (let i = 0; i < free.count; i++) await s.conns.ad.rpc(chunkFrame(free, i));
  await s.conns.ad.rpc({ type: "upload_abort", transfer_id: free.id });
  while (s.w.transfers.reclaimBatch()) continue;
  assert.ok(Number(s.w.db.get("PRAGMA freelist_count").freelist_count) >= 256);
  await measure("vacuum step", () => s.w.db.vacuumStep());
  // One expiry batch: 16 transfers' metadata.
  for (let i = 0; i < 16; i++) await s.conns.ad.rpc(plan(10).begin);
  s.w.clock.advance(86_400_000);
  await measure("expiry batch", () => s.w.transfers.expireBatch());
  // One cleanup batch of another table: 256 expired KeyPackages (16 KiB each at most) and receipts.
  s.w.db.tx((h) => {
    for (let i = 0; i < 256; i++) h.run("INSERT INTO key_packages (ref, member_id, device_id, kp, not_after, uploaded) VALUES (?, ?, ?, ?, ?, ?)", crypto.randomBytes(32).toString("hex"), s.w.members.bob.id, s.devs.bd.device, crypto.randomBytes(16 * 1024), 1, 1);
  });
  await measure("cleanup batch (KeyPackages)", () => s.w.directory.sweep());
  await measure("3.3 sweep batch", () => s.w.ds.sweep());
  t.diagnostic(`WAL bytes per kind: ${JSON.stringify(sizes)}`);
});

test("an acceptance to a full two-member conversation (40 devices) near the frame bound stays under A: a Welcome to 38 devices with its commit, a commit and an application message, each stored once", async (t) => {
  const s = await setup(t);
  const realm = s.w.realm;
  const A_ID = s.w.members.alice.id;
  const B_ID = s.w.members.bob.id;
  // 19 more devices of each member (20 each, the enrolment cap), enrolled with KeyPackages
  // through the directory (the frames' rate limit would only slow the setup).
  const extra = [];
  for (const [member, n] of [[A_ID, 19], [B_ID, 19]]) {
    for (let i = 0; i < n; i++) {
      const d = await fakeDevice(realm, member);
      const reg = d.register();
      s.w.directory.register({ member, device: d.device, key: Buffer.from(reg.key, "base64"), pin: Buffer.from(reg.pin, "base64") });
      s.w.directory.upload({ member, device: d.device, packages: (await d.packages(1, s.w.clock.now() + KP_LIFETIME_MS)).map((p) => ({ kp: Buffer.from(p.kp, "base64"), notAfter: p.not_after })) });
      extra.push({ member, device: d.device });
    }
  }
  const requester = { member: A_ID, device: s.devs.ad.device };
  const reservations = extra.map((x) => s.w.directory.take({ requester, request: reqId(), target: x }).reservation);
  const sizes = {};
  const measure = async (name, fn) => {
    s.w.db.checkpoint();
    const reader = s.pin();
    const before = s.wal();
    let r;
    try {
      r = await fn();
    } finally {
      reader.close();
    }
    sizes[name] = s.wal() - before;
    assert.ok(sizes[name] <= A, `${name}: ${sizes[name]} bytes of WAL <= A (${A})`);
    return r;
  };
  const payloads = () => s.w.db.get("SELECT count(*) AS n FROM e2ee_payloads").n;
  const half = Math.floor((MAX_MLS_BYTES - 8 * 1024) / 2);
  // One commit adds all 38 devices with a Welcome to each: commit and Welcome together fill the frame.
  const add = extra.map((x) => x.device);
  const welcomed = await measure("commit adding 38 devices with their Welcome", () =>
    s.conns.ad.rpc({ type: "send_e2ee", kind: "commit", op: newOp(), device: s.devs.ad.device, group: s.group, expected_epoch: 1, mls: b64(half), roster_delta: { add, remove: [] }, welcome: { recipients: add, mls: b64(half) }, kp_reservations: reservations }),
  );
  assert.equal(welcomed.state, "accepted");
  assert.equal(s.w.ds.roster(s.group).length, 40, "40 devices: 20 per member");
  assert.equal(s.w.db.get("SELECT count(*) AS n FROM e2ee_queue WHERE json_extract(frame, '$.kind') = 'welcome' AND json_extract(frame, '$.epoch') = 2 AND payload IS NOT NULL").n, 38);
  assert.equal(s.w.db.get("SELECT count(DISTINCT payload) AS n FROM e2ee_queue WHERE json_extract(frame, '$.kind') = 'welcome' AND json_extract(frame, '$.epoch') = 2").n, 1, "the Welcome is stored once");
  // A commit at the frame bound, to the 39 other devices.
  const big = b64(MAX_MLS_BYTES - 1024);
  const before = payloads();
  const commit = await measure("commit at the frame bound to 39 devices", () => s.conns.ad.rpc({ type: "send_e2ee", kind: "commit", op: newOp(), device: s.devs.ad.device, group: s.group, expected_epoch: 2, mls: big, roster_delta: { add: [], remove: [] }, kp_reservations: [] }));
  assert.equal(commit.state, "accepted");
  assert.equal(payloads(), before + 1, "one payload row for 39 queued copies");
  // An application message at the frame bound, to the 39 other devices.
  const app = await measure("application message at the frame bound to 39 devices", () => s.conns.ad.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.devs.ad.device, group: s.group, mls: big, target: "bob" }));
  assert.equal(app.recipients, 39);
  assert.equal(payloads(), before + 2);
  // Stored once, delivered whole: every recipient device's frame carries the message's bytes.
  for (const x of extra.slice(0, 3)) {
    const f = s.w.ds.pending({ member: x.member, device: x.device, limit: 100 }).find((m) => m.kind === "app");
    assert.equal(f.mls, big);
  }
  // Each acceptance writes its large part once: far below what 39 copies would need (~18 MiB).
  for (const [name, n] of Object.entries(sizes)) assert.ok(n < 3 * MiB, `${name}: ${n} bytes`);
  t.diagnostic(`WAL bytes per acceptance with 40 devices: ${JSON.stringify(sizes)}`);
});
