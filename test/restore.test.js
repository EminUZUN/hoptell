// Offline restore (design 4.4, "Restore"): a crash injected at every phase and between the renames
// and their directory fsyncs, then the fence (an ordinary start refused, a second restore refused),
// --resume completing to the same result as an uninterrupted restore with the original state kept
// as evidence, and --abort before installation returning the original state. The resume order
// (v2.1), abort_from (v2.3), a backup carrying an earlier restore's id (v2.2), the consequences and
// the authorization rule (access state kept, or rebuilt with every member pending).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAccess } from "../lib/access.js";
import { backupRelay } from "../lib/backup.js";
import { loadRealm, lockStateDir, readRestoreIntent } from "../lib/realm.js";
import { TRANSACTION_ALLOWANCE, openRelayDb } from "../lib/relaydb.js";
import { RELAY_MIGRATIONS, openRelayStore, storeMeta } from "../lib/relaystore.js";
import { createDeviceDirectory } from "../lib/mls/relaydir.js";
import { createDeliveryService } from "../lib/mls/relayds.js";
import { DEVICE_MIGRATIONS } from "../lib/mls/relaydir.js";
import { runRestore } from "../lib/restore.js";
import { createTransferStore } from "../lib/mls/relaytransfers.js";
import { DEV, GROUP, ID, OPS, TX, buildLargeTemplate, buildTemplate, cli, copyState, digest, enroll, exists, membersFile, setDigests, summary, tmp, work } from "./restore-helpers.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
let TPL = null;
const tpl = async () => (TPL ??= await buildTemplate(null));
after(() => TPL && fs.rmSync(path.dirname(TPL.template), { recursive: true, force: true }));
const crashAt = (point) => {
  let fired = false;
  return (p) => {
    if (!fired && p === point) {
      fired = true;
      throw Object.assign(new Error(`crash at ${point}`), { crash: true });
    }
  };
};
const restore = (dir, mode, o = {}) => runRestore({ stateDir: dir, mode, backupDir: o.backupDir ?? TPL.backup, membersFile: TPL.config.members, fault: o.fault ?? null });
const evidenceOf = (dir, id) => setDigests(path.join(dir, "restore", id, "before"));
const accessDigests = (dir) => Object.fromEntries(["grants.json", "claims.json", "requests.json", "allowances.json", "restore.json"].filter((f) => exists(path.join(dir, "access", f))).map((f) => [f, digest(path.join(dir, "access", f))]));
const intentBytes = (dir) => fs.readFileSync(path.join(dir, "restore", "intent.json"), "utf8");

/** The relay refuses to start on a fenced state directory (the real CLI, its own process). */
async function startRefused(dir) {
  const r = await cli(["relay", "--host", "127.0.0.1", "--port", "0"], { stateDir: dir });
  assert.notEqual(r.code, 0, r.stdout);
  assert.match(r.stderr, /unfinished restore \([0-9a-f]{16}, phase [a-z]+\)/);
  assert.equal(exists(path.join(dir, "admin", "admin.sock")), false, "nothing was opened");
}

const START_POINTS = ["intent-written", "established", "evidence-rename:relay.db", "evidence-rename:relay.db-wal", "evidence-rename:relay.db-shm", "evidence-copied", "after:evidence", "install-copied", "install-rename", "after:installed", "reconcile-before-commit", "reconcile-after-commit", "reconciled", "after:reconciled", "after:access", "broker-reset", "after:broker", "result-written"];
const BEFORE_INSTALL = START_POINTS.slice(0, START_POINTS.indexOf("install-rename") + 1);

test("restore: an uninterrupted restore of a readable state", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  const orig = setDigests(dir);
  const access = accessDigests(dir);
  const members = digest(TPL.config.members);
  const r = await restore(dir, "start");
  assert.equal(r.done, true);
  assert.deepEqual(evidenceOf(dir, r.id), orig, "the replaced set is kept as evidence, as it was");
  assert.deepEqual(accessDigests(dir), access, "readable access state is kept as it is");
  assert.equal(digest(TPL.config.members), members, "the members file is never written");
  const s = summary(dir);
  assert.equal(s.intent, false);
  assert.deepEqual(s.revocations, [{ member_id: ID.alice, device_id: DEV.a2, by_kind: "admin" }], "the revocation made after the backup is kept");
  assert.equal(s.devices.every((d) => d.suspended === 0), true, "the old store was readable: no suspension");
  assert.equal(s.keyPackages, 0);
  assert.equal(s.reservations, 0);
  assert.equal(s.restoreRows, 1);
  assert.deepEqual(s.audit.filter((a) => a.startsWith("test.")), ["test.before-backup/done", "test.after-backup/done", "test.after-backup/event"], "the old store's rows after the backup point are carried over");
  assert.equal(s.counts.audit_rechained, 0);
  // 3.3 (phase 4): the conversation must be replaced; the queue is the backup's (the commit and the
  // message accepted after it are a stated loss); operations are merged, the cancellation kept.
  assert.deepEqual(s.e2ee.groups, [{ group_id: GROUP, epoch: 1, state: "active", replace_required: 1 }]);
  assert.deepEqual(s.e2ee.queue, ["welcome", "app"]);
  assert.deepEqual(s.e2ee.ops, [`${OPS[0]}/create`, `${OPS[1]}/app`, `${OPS[2]}/commit`, `${OPS[3]}/app`, `${OPS[4]}/cancelled`]);
  assert.deepEqual([s.counts.conversations_replace_required, s.counts.e2ee_queue_kept, s.counts.e2ee_queue_lost, s.counts.e2ee_ops_merged], [1, 2, 2, 3]);
  // The new instance id differs from both the backup's and the old store's.
  const release = lockStateDir(dir);
  const db = openRelayStore({ dir, fullfsync: false });
  assert.notEqual(storeMeta(db, "instance"), TPL.instance);
  assert.equal(storeMeta(db, "restore_id"), r.id);
  db.close();
  release();
});

test("restore, 3.3: a restored conversation refuses commits until a member device replaces its group; a cancelled op id stays cancelled", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  await restore(dir, "start");
  const release = lockStateDir(dir);
  t.after(release);
  const db = openRelayStore({ dir, fullfsync: false });
  t.after(() => db.close());
  const directory = createDeviceDirectory({ db, realm: TPL.realm });
  const ds = createDeliveryService({ db, directory, realm: TPL.realm });
  const A1 = { member: ID.alice, device: DEV.a1 };
  const B1 = { member: ID.bob, device: DEV.b1 };
  const blob = () => Buffer.alloc(48, 1).toString("base64");
  const op = (c) => `o_${c.repeat(26)}`;
  // The backup's epoch is 1, and alice's device had moved past it: the commit for epoch 1 is refused.
  assert.throws(() => ds.sendCommit({ requester: A1, op: op("f"), group: GROUP, expectedEpoch: 1, mls: blob(), delta: { add: [], remove: [] } }), (e) => e.code === "replace_required" && e.group === GROUP);
  assert.throws(() => ds.sendCommit({ requester: B1, op: op("g"), group: GROUP, expectedEpoch: 1, mls: blob(), delta: { add: [], remove: [] } }), (e) => e.code === "replace_required");
  // The op id of the commit accepted after the backup is merged: it is never accepted anew for other bytes.
  assert.throws(() => ds.sendCommit({ requester: A1, op: OPS[2], group: GROUP, expectedEpoch: 1, mls: Buffer.from("x").toString("base64"), delta: { add: [], remove: [] } }), (e) => e.code === "op_reused");
  assert.throws(() => ds.sendApp({ requester: A1, op: OPS[4], group: GROUP, mls: blob(), target: "bob" }), (e) => e.code === "op_cancelled");
  // A member device replaces the group: the new generation accepts commits.
  const g2 = "8".repeat(32);
  const r = ds.groupReplace({ requester: B1, op: op("h"), peer: ID.alice, expectedGeneration: 1, group: g2, epoch: 1 });
  assert.equal(r.generation, 2);
  assert.equal(ds.sendCommit({ requester: B1, op: op("i"), group: g2, expectedEpoch: 1, mls: blob(), delta: { add: [], remove: [] } }).state, "accepted");
});

test("restore, fault injection: a crash after every phase and every rename; fenced; --resume equals an uninterrupted restore", async (t) => {
  await tpl();
  const refDir = work(t, TPL);
  await restore(refDir, "start");
  const reference = summary(refDir);
  for (const point of START_POINTS) {
    await t.test(point, async (t2) => {
      const dir = work(t2, TPL);
      const orig = setDigests(dir);
      await assert.rejects(restore(dir, "start", { fault: crashAt(point) }), /crash at/);
      const intent = readRestoreIntent(dir);
      assert.ok(intent, "the intent stays");
      await startRefused(dir);
      await assert.rejects(restore(dir, "start"), /unfinished restore/, "a second restore is refused");
      const release = lockStateDir(dir);
      try {
        assert.throws(() => openRelayStore({ dir, fullfsync: false }), /unfinished restore/, "any other opener is refused");
      } finally {
        release();
      }
      const r = await restore(dir, "resume");
      assert.equal(r.id, intent.id);
      assert.deepEqual(evidenceOf(dir, intent.id), orig, "the evidence set is the original current state");
      assert.deepEqual(summary(dir), reference, "the same result as an uninterrupted restore");
    });
  }
});

test("restore, abort: before installation it returns the original state; at installed or later it is refused before any write", async (t) => {
  await tpl();
  for (const point of BEFORE_INSTALL) {
    await t.test(point, async (t2) => {
      const dir = work(t2, TPL);
      const orig = setDigests(dir);
      const access = accessDigests(dir);
      await assert.rejects(restore(dir, "start", { fault: crashAt(point) }), /crash at/);
      const r = await restore(dir, "abort");
      assert.equal(r.aborted, true);
      assert.deepEqual(setDigests(dir), orig, "relay.db, -wal and -shm are back");
      assert.deepEqual(accessDigests(dir), access);
      assert.equal(exists(path.join(dir, "restore")), false, "no intent, no evidence left");
      assert.equal(exists(path.join(dir, `relay.db.restore-${r.id}.tmp`)), false);
      // An ordinary open works again, on the original data.
      const release = lockStateDir(dir);
      const db = openRelayStore({ dir, fullfsync: false });
      assert.equal(storeMeta(db, "instance"), TPL.instance);
      db.close();
      release();
    });
  }
  for (const point of ["after:installed", "reconcile-after-commit", "after:access"]) {
    await t.test(`refused at ${point}`, async (t2) => {
      const dir = work(t2, TPL);
      await assert.rejects(restore(dir, "start", { fault: crashAt(point) }), /crash at/);
      const before = intentBytes(dir);
      await assert.rejects(restore(dir, "abort"), /the backup is installed, only --resume/);
      assert.equal(intentBytes(dir), before, "nothing was written");
      await restore(dir, "resume");
    });
  }
});

test("restore, resume order: partial evidence sets complete or return; a name in both places stops with nothing overwritten", async (t) => {
  await tpl();
  // relay.db moved, -wal and -shm not; relay.db and -wal moved, -shm not.
  for (const point of ["evidence-rename:relay.db", "evidence-rename:relay.db-wal"]) {
    const dir = work(t, TPL);
    const orig = setDigests(dir);
    await assert.rejects(restore(dir, "start", { fault: crashAt(point) }), /crash at/);
    const id = readRestoreIntent(dir).id;
    assert.ok(exists(path.join(dir, "restore", id, "before", "relay.db")));
    assert.ok(exists(path.join(dir, "relay.db-shm")), "the set is partial");
    await restore(dir, "resume");
    assert.deepEqual(evidenceOf(dir, id), orig);
  }
  const dir = work(t, TPL);
  await assert.rejects(restore(dir, "start", { fault: crashAt("evidence-rename:relay.db") }), /crash at/);
  const id = readRestoreIntent(dir).id;
  fs.writeFileSync(path.join(dir, "relay.db"), "someone put a file here");
  const both = digest(path.join(dir, "restore", id, "before", "relay.db"));
  await assert.rejects(restore(dir, "resume"), /both in the state directory and in/);
  await assert.rejects(restore(dir, "abort"), /both in the state directory and in/);
  assert.equal(fs.readFileSync(path.join(dir, "relay.db"), "utf8"), "someone put a file here", "nothing overwritten");
  assert.equal(digest(path.join(dir, "restore", id, "before", "relay.db")), both, "nothing discarded");
});

test("restore, resume order: after phase 4 commits, resume finds restore_id, keeps the reconciled store and its instance id", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  await assert.rejects(restore(dir, "start", { fault: crashAt("reconcile-after-commit") }), /crash at/);
  const intent = readRestoreIntent(dir);
  assert.equal(intent.phase, "installed", "the commit is not recorded yet");
  const db = openRelayStore({ dir, fullfsync: false, restoreId: intent.id, ...lockFor(t, dir) });
  const instance = storeMeta(db, "instance");
  assert.equal(storeMeta(db, "restore_id"), intent.id);
  db.close();
  unlock(dir);
  const r = await restore(dir, "resume");
  assert.equal(r.counts.new_instance, instance, "the reconciled instance id is kept: the backup was not installed again");
  assert.equal(summary(dir).restoreRows, 1);
});

/** Hold the state directory's lock for an inspection in this process (released by unlock). */
const locks = new Map();
function lockFor(t, dir) {
  locks.set(dir, lockStateDir(dir));
  t.after(() => unlock(dir));
  return {};
}
const unlock = (dir) => {
  locks.get(dir)?.();
  locks.delete(dir);
};

test("restore, real crashes (SIGKILL) inside phase 4: -wal and -shm present at phase installed are accepted", async (t) => {
  await tpl();
  for (const point of ["reconcile-before-commit", "reconcile-after-commit", "install-rename", "evidence-rename:relay.db-wal"]) {
    const dir = work(t, TPL);
    const orig = setDigests(dir);
    const r = await cli(["relay", "admin", "restore", TPL.backup], { stateDir: dir, env: { HOPTELL_MEMBERS: TPL.config.members, HOPTELL_RESTORE_TEST_CRASH: point } });
    assert.equal(r.code, "SIGKILL", `killed at ${point}: ${r.stderr}`);
    const intent = readRestoreIntent(dir);
    if (point.startsWith("reconcile")) assert.ok(exists(path.join(dir, "relay.db-wal")) || exists(path.join(dir, "relay.db-shm")), "the killed process left its -wal or -shm");
    await startRefused(dir);
    const status = await cli(["relay", "admin", "status"], { stateDir: dir });
    assert.match(status.stdout, new RegExp(`unfinished ${intent.id} at ${intent.phase}`));
    const refused = await cli(["relay", "admin", "members"], { stateDir: dir, env: { HOPTELL_MEMBERS: TPL.config.members } });
    assert.match(refused.stderr, /unfinished restore/);
    const done = await cli(["relay", "admin", "restore", "--resume"], { stateDir: dir, env: { HOPTELL_MEMBERS: TPL.config.members } });
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /complete/);
    assert.deepEqual(evidenceOf(dir, intent.id), orig);
  }
});

test("restore, abort_from: a crash right after {aborting, abort_from} is persisted; resume or abort finish it; abort_from never changes", async (t) => {
  await tpl();
  for (const finish of ["resume", "abort"]) {
    const dir = work(t, TPL);
    const orig = setDigests(dir);
    await assert.rejects(restore(dir, "start", { fault: crashAt("install-rename") }), /crash at/);
    assert.equal(readRestoreIntent(dir).phase, "evidence", "the rename happened; installed is not recorded");
    assert.ok(exists(path.join(dir, "relay.db")), "the unrecorded installed copy is present");
    await assert.rejects(restore(dir, "abort", { fault: crashAt("abort-recorded") }), /crash at/);
    const i1 = readRestoreIntent(dir);
    assert.deepEqual([i1.phase, i1.abort_from], ["aborting", "evidence"]);
    assert.ok(exists(path.join(dir, "relay.db")), "not yet inspected or removed");
    // A crash after the installed copy is removed, then one after each file moved back.
    await assert.rejects(restore(dir, finish, { fault: crashAt("abort-removed-install") }), /crash at/);
    assert.equal(readRestoreIntent(dir).abort_from, "evidence");
    await assert.rejects(restore(dir, finish, { fault: crashAt("abort-moved:relay.db") }), /crash at/);
    assert.equal(readRestoreIntent(dir).abort_from, "evidence");
    await assert.rejects(restore(dir, finish === "resume" ? "abort" : "resume", { fault: crashAt("abort-moved:relay.db-wal") }), /crash at/);
    const last = readRestoreIntent(dir);
    assert.deepEqual([last.phase, last.abort_from], ["aborting", "evidence"], "abort_from is unchanged after every retry");
    const r = await restore(dir, finish);
    assert.equal(r.aborted, true, "resume of an aborting intent only continues the abort");
    assert.deepEqual(setDigests(dir), orig, "the original relay.db, -wal and -shm set");
    assert.equal(exists(path.join(dir, "restore")), false);
  }
});

test("restore, abort guards: a store that is not the backup's unopened copy is never removed", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  await assert.rejects(restore(dir, "start", { fault: crashAt("install-rename") }), /crash at/);
  // Someone opened the installed copy: it has a -wal now (and could have been changed).
  fs.writeFileSync(path.join(dir, "relay.db-wal"), "");
  await assert.rejects(restore(dir, "abort"), /not an unopened copy of the backup/);
  const i = readRestoreIntent(dir);
  assert.deepEqual([i.phase, i.abort_from], ["aborting", "evidence"]);
  assert.ok(exists(path.join(dir, "relay.db")), "kept");
  // abort_from is the only authority: an intent claiming the abort began at "installed" stops.
  fs.rmSync(path.join(dir, "relay.db-wal"));
  fs.writeFileSync(path.join(dir, "restore", "intent.json"), JSON.stringify({ ...i, abort_from: "installed" }));
  await assert.rejects(restore(dir, "resume"), /abort_from is "installed"/);
  assert.ok(exists(path.join(dir, "relay.db")), "a store is never deleted outside abort_from evidence");
});

test("restore, a backup carrying an earlier restore's id (R1) restored as R2", async (t) => {
  await tpl();
  // R1: a completed restore; then a backup of the result.
  const base = work(t, TPL);
  const r1 = await restore(base, "start");
  const b1 = path.join(tmp(t), "backup-after-r1");
  {
    const release = lockStateDir(base);
    const db = openRelayStore({ dir: base, fullfsync: false });
    await backupRelay({ db, stateDir: base, dest: b1, realm: TPL.realm, config: TPL.config });
    db.close();
    release();
  }
  const copy = (t2) => {
    const d = path.join(tmp(t2), "state");
    copyState(base, d);
    return d;
  };
  const r2 = (d, mode, fault = null) => runRestore({ stateDir: d, mode, backupDir: b1, membersFile: TPL.config.members, fault });
  const restoreIdOf = (d, id) => {
    const release = lockStateDir(d);
    const db = openRelayStore({ dir: d, fullfsync: false, restoreId: id });
    try {
      return [storeMeta(db, "restore_id"), storeMeta(db, "instance")];
    } finally {
      db.close();
      release();
    }
  };
  // Interrupted just after the install's rename: resume runs phase 4 (R2); abort removes the copy.
  {
    const d = copy(t);
    await assert.rejects(r2(d, "start", crashAt("install-rename")), /crash at/);
    const id = readRestoreIntent(d).id;
    assert.equal(restoreIdOf(d, id)[0], r1.id, "the installed copy carries R1");
    // (that look opened it: put it back as the unopened copy for the abort case below)
    fs.rmSync(path.join(d, "relay.db-wal"), { force: true });
    fs.rmSync(path.join(d, "relay.db-shm"), { force: true });
    fs.copyFileSync(path.join(b1, "relay.db"), path.join(d, "relay.db"));
    const d2 = copy(t);
    fs.rmSync(d2, { recursive: true });
    copyState(d, d2);
    const done = await r2(d, "resume");
    assert.equal(restoreIdOf(d, null)[0], id, "phase 4 set R2");
    assert.equal(done.id, id);
    const orig = setDigests(path.join(d2, "restore", id, "before"));
    const ab = await r2(d2, "abort");
    assert.equal(ab.aborted, true, "R1 in the installed copy does not block the abort");
    assert.deepEqual(setDigests(d2), orig);
  }
  // Interrupted at installed, before phase 4: R1 is not taken as completion.
  {
    const d = copy(t);
    await assert.rejects(r2(d, "start", crashAt("after:installed")), /crash at/);
    const id = readRestoreIntent(d).id;
    const done = await r2(d, "resume");
    assert.equal(restoreIdOf(d, null)[0], id);
    assert.equal(done.counts.key_packages_cleared >= 0, true);
    assert.notEqual(done.counts.new_instance, done.counts.backup_instance, "phase 4 ran: a new instance id");
  }
  // Interrupted after phase 4 committed: resume keeps R2's store; abort is refused and deletes nothing.
  {
    const d = copy(t);
    await assert.rejects(r2(d, "start", crashAt("reconcile-after-commit")), /crash at/);
    const id = readRestoreIntent(d).id;
    const [rid, instance] = restoreIdOf(d, id);
    assert.equal(rid, id);
    await assert.rejects(r2(d, "abort"), /only --resume/);
    assert.ok(exists(path.join(d, "relay.db")), "the R2 store is not deleted");
    const done = await r2(d, "resume");
    assert.equal(done.counts.new_instance, instance);
  }
});

/** The transfers' states in a restored store, by id (design 6). */
function transferStates(dir) {
  const release = lockStateDir(dir);
  const db = openRelayStore({ dir, fullfsync: false });
  try {
    // The relay starts on the restored store: its transfer accounting is recomputed and must match.
    const store = createTransferStore({ db });
    assert.deepEqual(store.recompute().mismatches, []);
    return Object.fromEntries(db.all("SELECT transfer_id, state FROM transfers ORDER BY transfer_id").map((r) => [r.transfer_id, r.state]));
  } finally {
    db.close();
    release();
  }
}

test("restore, transfers: they roll back with the store, but one the old store ended stays ended; with an unreadable old store every open or sealed transfer ends", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  const r = await restore(dir, "start");
  assert.equal(r.counts.transfers_ended, 1);
  assert.deepEqual(transferStates(dir), { [TX.aborted]: "aborted", [TX.sealed]: "sealed" }, "the withdrawal after the backup point is kept; the other is served as before");
  const lost = work(t, TPL);
  fs.writeFileSync(path.join(lost, "relay.db"), Buffer.alloc(8192, 7));
  fs.writeFileSync(path.join(lost, "relay.db-wal"), Buffer.alloc(4096, 7));
  const r2 = await restore(lost, "start");
  assert.equal(r2.counts.old_store, "unreadable");
  assert.equal(r2.counts.transfers_ended, 2);
  assert.deepEqual(transferStates(lost), { [TX.aborted]: "aborted", [TX.sealed]: "aborted" }, "fail closed: an abort after the backup cannot be known");
});

test("restore, consequences: an unreadable old store suspends every device; they serve nothing until reinstated", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  // Damaged: the store and its -wal (whose frames would otherwise still hold a sound page 1).
  fs.writeFileSync(path.join(dir, "relay.db"), Buffer.alloc(8192, 7));
  fs.writeFileSync(path.join(dir, "relay.db-wal"), Buffer.alloc(4096, 7));
  const r = await restore(dir, "start");
  assert.equal(r.counts.old_store, "unreadable");
  const s = summary(dir);
  // a2 was revoked after the backup, and that record is lost with the old store: suspended too.
  assert.deepEqual(s.devices.map((d) => [d.device_id, d.suspended]), [[DEV.a1, 1], [DEV.a2, 1], [DEV.b1, 1]]);
  assert.equal(r.counts.devices_suspended, 3);
  const release = lockStateDir(dir);
  const db = openRelayStore({ dir, fullfsync: false });
  const directory = createDeviceDirectory({ db, realm: TPL.realm });
  assert.throws(() => directory.status({ member: ID.alice, device: DEV.a1 }), /suspended/);
  assert.throws(() => directory.upload({ member: ID.bob, device: DEV.b1, packages: [{ kp: Buffer.from("x"), notAfter: Date.now() + 1000 }] }), /suspended/);
  assert.equal(directory.list(ID.alice).every((d) => !d.key), true, "no directory entry");
  enroll(directory, TPL.realm, ID.alice, `${"d".repeat(25)}a`, 9); // a new device id enrolls
  assert.equal(directory.reinstate({ member: ID.alice, device: DEV.a1 }).state, "reinstated");
  assert.equal(directory.status({ member: ID.alice, device: DEV.a1 }).available, 0);
  db.close();
  release();
});

test("restore, consequences: broker families revoked, another realm refused, an older schema migrated, a newer one refused, an empty state directory", async (t) => {
  await tpl();
  // Broker: a live family before, revoked after, with a new refresh key.
  const dir = work(t, TPL);
  fs.mkdirSync(path.join(dir, "broker"), { mode: 0o700 });
  const fam = { memberId: ID.alice, issuer: "https://idp.example", issuerId: "b1", subject: "alice", configId: "c", generation: 1, created: 1, idleUntil: Date.now() + 1e9, maxUntil: Date.now() + 1e9, reverifyAt: Date.now() + 1e9, verifiedAt: 1, digest: "0".repeat(64), revoked: null };
  fs.writeFileSync(path.join(dir, "broker", "families.json"), JSON.stringify({ v: 1, families: { [Buffer.alloc(16, 1).toString("base64url")]: fam } }));
  fs.writeFileSync(path.join(dir, "broker", "refresh.key"), "old-key\n");
  const r = await restore(dir, "start");
  assert.equal(r.counts.broker_families, 1);
  assert.equal(summary(dir).brokerRevoked, true);
  assert.notEqual(fs.readFileSync(path.join(dir, "broker", "refresh.key"), "utf8"), "old-key\n");
  // Another realm's backup.
  const other = work(t, TPL);
  fs.writeFileSync(path.join(other, "realm.json"), `${JSON.stringify({ v: 1, id: "f".repeat(32) })}\n`, { mode: 0o600 });
  await assert.rejects(restore(other, "start"), /another realm is never restored here/);
  assert.equal(readRestoreIntent(other), null, "refused at the check: no intent");
  // An older schema (3.2's only) is migrated at phase 4; a newer one is refused.
  const v1dir = path.join(tmp(t), "v1");
  {
    const release = lockStateDir(v1dir);
    fs.writeFileSync(path.join(v1dir, "realm.json"), `${JSON.stringify({ v: 1, id: TPL.realm })}\n`, { mode: 0o600 });
    const db = openRelayDb({ dir: v1dir, migrations: DEVICE_MIGRATIONS, fullfsync: false });
    db.tx((h) => h.run("INSERT INTO devices (member_id, device_id, sig_key, pin, seq, created) VALUES (?, ?, ?, ?, 0, 1)", ID.carol, DEV.b1, Buffer.alloc(32, 5), Buffer.alloc(32, 5)));
    db.close();
    release();
  }
  const oldBackup = path.join(tmp(t), "old-backup");
  fs.mkdirSync(oldBackup, { mode: 0o700 });
  fs.copyFileSync(path.join(v1dir, "relay.db"), path.join(oldBackup, "relay.db"));
  {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path.join(oldBackup, "relay.db"));
    raw.exec("PRAGMA journal_mode = DELETE"); // a backup is one file, as backupRelay leaves it
    raw.close();
  }
  const manifest = (dbDigest, version) => `${JSON.stringify({ v: 1, realm: TPL.realm, instance: null, schema: { name: "relay", version }, created: 1, lastAuditSeq: 0, config: {}, files: { "relay.db": dbDigest } })}\n`;
  fs.writeFileSync(path.join(oldBackup, "manifest.json"), manifest(digest(path.join(oldBackup, "relay.db")), 1));
  const dOld = work(t, TPL);
  const rOld = await runRestore({ stateDir: dOld, mode: "start", backupDir: oldBackup, membersFile: TPL.config.members });
  assert.equal(summary(dOld).version, RELAY_MIGRATIONS.length, "migrated to this hoptell's schema");
  assert.match(rOld.counts.new_instance, /^[0-9a-f]{32}$/);
  const newer = path.join(tmp(t), "newer");
  fs.cpSync(oldBackup, newer, { recursive: true });
  {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path.join(newer, "relay.db"));
    raw.exec("UPDATE schema_meta SET value = 99 WHERE key = 'version'");
    raw.exec("PRAGMA journal_mode = DELETE");
    raw.close();
  }
  fs.writeFileSync(path.join(newer, "manifest.json"), manifest(digest(path.join(newer, "relay.db")), 99));
  await assert.rejects(runRestore({ stateDir: work(t, TPL), mode: "start", backupDir: newer }), /newer than this hoptell knows/);
  // An empty state directory: the realm comes from the backup.
  const empty = path.join(tmp(t), "empty");
  const re = await restore(empty, "start");
  assert.equal(JSON.parse(fs.readFileSync(path.join(empty, "realm.json"), "utf8")).id, TPL.realm);
  assert.ok(exists(path.join(empty, ".created")) && exists(path.join(empty, ".relay.db.created")));
  assert.equal(re.counts.old_store, "unreadable");
  assert.equal(re.counts.access, "rebuilt", "nothing to keep: every member pending");
  // An abort into an empty directory leaves it empty again.
  const empty2 = path.join(tmp(t), "empty2");
  await assert.rejects(restore(empty2, "start", { fault: crashAt("after:evidence") }), /crash at/);
  await restore(empty2, "abort");
  assert.deepEqual(fs.readdirSync(empty2).filter((f) => f !== "relay.lock"), []);
});

test("restore, authorization: readable access state is kept (deny, used allowance, revisions)", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  await restore(dir, "start");
  const a = createAccess({ stateDir: dir });
  assert.equal(a.decide({ memberId: ID.carol }, { memberId: ID.alice }), "deny", "the deny published after the backup still refuses, before alice reconnects");
  assert.equal(a.useAllowance(ID.bob, ID.alice, "msg-1", { op: null, digest: "1".repeat(64), messageId: "msg-3", deliveryId: "dlv-3", ts: Date.now() }).use, "refused", "a used allowance stays used");
  assert.deepEqual(a.putGrants(ID.alice, 2, { default: "deny", visible: "all", entries: [] }), { revision: 3 }, "a client's CAS against the current revision succeeds");
  assert.deepEqual(a.pendingRecipients(), []);
});

test("restore, authorization: lost access state holds every member until it publishes; old revisions, no allowance, stale views", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  fs.rmSync(path.join(dir, "access"), { recursive: true });
  const r = await restore(dir, "start");
  assert.equal(r.counts.access, "rebuilt");
  const a = createAccess({ stateDir: dir });
  assert.deepEqual(a.pendingRecipients().map((p) => p.memberId).sort(), [ID.alice, ID.bob, ID.carol]);
  for (const to of [ID.alice, ID.bob, ID.carol]) {
    assert.equal(a.decide({ memberId: ID.alice }, { memberId: to }), "hold", `to ${to}`);
    assert.equal(a.decide({ memberId: ID.alice }, { memberId: to }, { send: true }), "retry");
  }
  assert.equal(a.decide({ memberId: ID.bob }, { memberId: ID.alice }, { replyTo: "msg-1" }), "hold", "no allowance passes a pending recipient");
  // The backup's revision (1) is current: a client holding 2 fails, re-reads and publishes.
  assert.throws(() => a.putGrants(ID.alice, 2, { default: "deny", visible: "all", entries: [] }), (e) => e.code === "stale" && e.revision === 1);
  assert.deepEqual(a.putGrants(ID.alice, 1, { default: "allow", visible: "all", entries: [] }), { revision: 2 });
  assert.equal(a.decide({ memberId: ID.bob }, { memberId: ID.alice }), "allow", "alice published: no longer held");
  assert.equal(a.decide({ memberId: ID.alice }, { memberId: ID.bob }), "hold", "bob still pending");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "access", "allowances.json"), "utf8")).entries.length, 0, "no allowance survives");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "access", "requests.json"), "utf8")).pending, []);
});

test("restore, pending recipients across restores: readable state keeps restore.json byte for byte; lost state lists the union", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  fs.rmSync(path.join(dir, "access"), { recursive: true });
  await restore(dir, "start");
  // A member pending from the first restore that is in neither the grants nor the members file.
  const ghost = "m_dddddddddddddddddddddddddd";
  const rfile = path.join(dir, "access", "restore.json");
  const doc = JSON.parse(fs.readFileSync(rfile, "utf8"));
  fs.writeFileSync(rfile, JSON.stringify({ ...doc, pending: { ...doc.pending, [ghost]: null } }));
  const bytes = fs.readFileSync(rfile);
  // A second restore with the access state readable: restore.json is kept as it is.
  await restore(dir, "start");
  assert.deepEqual(fs.readFileSync(rfile), bytes, "kept byte for byte");
  assert.ok(createAccess({ stateDir: dir }).pendingRecipients().some((p) => p.memberId === ghost), "still held until it publishes");
  // A third with the access state lost (grants.json gone, the backup has one): the union.
  fs.rmSync(path.join(dir, "access", "grants.json"));
  await restore(dir, "start");
  const pending = Object.keys(JSON.parse(fs.readFileSync(rfile, "utf8")).pending).sort();
  assert.deepEqual(pending, [ID.alice, ID.bob, ID.carol, ghost].sort());
});

test("the startup fence acts before anything is opened: a fenced empty state directory gets no realm of its own", async (t) => {
  await tpl();
  const empty = path.join(tmp(t), "state");
  await assert.rejects(restore(empty, "start", { fault: crashAt("intent-written") }), /crash at/);
  assert.equal(exists(path.join(empty, "realm.json")), false, "phase 1 had not created the realm yet");
  await startRefused(empty);
  // A start that went further would have stored a new realm id, and the backup's could never be restored.
  assert.equal(exists(path.join(empty, "realm.json")), false);
  assert.equal(exists(path.join(empty, "access")), false);
  await restore(empty, "resume");
  assert.equal(JSON.parse(fs.readFileSync(path.join(empty, "realm.json"), "utf8")).id, TPL.realm);
});

test("restore is offline only, and never writes the members, policy or OIDC files", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  const members = digest(TPL.config.members);
  const policy = digest(TPL.config.policy);
  // A live lock holder (this test process stands in for the running relay).
  const release = lockStateDir(dir);
  await assert.rejects(restore(dir, "start"), /restore runs only while the relay is stopped/);
  release();
  const extra = membersFile(tmp(t));
  await runRestore({ stateDir: dir, mode: "start", backupDir: TPL.backup, membersFile: extra });
  assert.equal(digest(TPL.config.members), members);
  assert.equal(digest(TPL.config.policy), policy);
});

test("restore with lost access state needs the members file; its members are held even when a resume does not name it", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  fs.rmSync(path.join(dir, "access"), { recursive: true });
  await assert.rejects(runRestore({ stateDir: dir, mode: "start", backupDir: TPL.backup }), /name the relay's members file/);
  assert.equal(readRestoreIntent(dir), null, "refused at the check");
  // carol has no grants in the backup: only the members file names her.
  await assert.rejects(restore(dir, "start", { fault: crashAt("after:reconciled") }), /crash at/);
  await runRestore({ stateDir: dir, mode: "resume" });
  assert.ok(createAccess({ stateDir: dir }).pendingRecipients().some((p) => p.memberId === ID.carol));
});

test("restore again: suspensions in the current store are kept (a lost revocation stays protected); a reinstated device stays in service", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  fs.writeFileSync(path.join(dir, "relay.db"), Buffer.alloc(8192, 7));
  fs.writeFileSync(path.join(dir, "relay.db-wal"), Buffer.alloc(4096, 7));
  const r1 = await restore(dir, "start");
  assert.equal(r1.counts.devices_suspended, 3, "a2's revocation after the backup is lost: every device suspended");
  // The owner checked with alice: a1 is hers and in service; a2 and b1 are not looked at yet.
  {
    const release = lockStateDir(dir);
    const db = openRelayStore({ dir, fullfsync: false });
    createDeviceDirectory({ db, realm: TPL.realm }).reinstate({ member: ID.alice, device: DEV.a1 });
    db.close();
    release();
  }
  // The same backup again: the current store is readable now, and its suspensions are restrictive state.
  const r2 = await restore(dir, "start");
  assert.equal(r2.counts.old_store, "readable");
  assert.equal(r2.counts.suspensions_kept, 2);
  assert.deepEqual(summary(dir).devices.map((d) => [d.device_id, d.suspended]), [[DEV.a1, 0], [DEV.a2, 1], [DEV.b1, 1]]);
  const release = lockStateDir(dir);
  t.after(release);
  const db = openRelayStore({ dir, fullfsync: false });
  t.after(() => db.close());
  const directory = createDeviceDirectory({ db, realm: TPL.realm });
  assert.throws(() => directory.status({ member: ID.alice, device: DEV.a2 }), (e) => e.code === "device_suspended", "no reinstate was performed for a2");
  assert.equal(directory.status({ member: ID.alice, device: DEV.a1 }).available, 0, "a1 stays reinstated");
});

test("restore, access files created after the backup and then lost, the access folder intact: lost state, every member held", async (t) => {
  // A backup taken before any grants were published (the backup has no grants.json).
  const root = tmp(t);
  const dir = path.join(root, "s");
  const members = membersFile(root);
  const backup = path.join(root, "backup");
  {
    const release = lockStateDir(dir);
    const realm = loadRealm(dir);
    const db = openRelayStore({ dir, fullfsync: false });
    const a = createAccess({ stateDir: dir });
    await backupRelay({ db, stateDir: dir, dest: backup, realm, config: { members } });
    a.putGrants(ID.alice, 0, { default: "deny", visible: "all", entries: [] }); // the first grants.json, after the backup
    assert.equal(a.decide({ memberId: ID.bob }, { memberId: ID.alice }), "deny");
    db.close();
    release();
  }
  fs.rmSync(path.join(dir, "access", "grants.json")); // lost; the folder and the other files stay
  const r = await runRestore({ stateDir: dir, mode: "start", backupDir: backup, membersFile: members });
  assert.equal(r.counts.access, "rebuilt");
  const a = createAccess({ stateDir: dir });
  assert.equal(a.decide({ memberId: ID.bob }, { memberId: ID.alice }), "hold", "the deny published after the backup is not replaced by an allow");
  assert.ok(a.pendingRecipients().some((p) => p.memberId === ID.alice));
});

test("restore, access state without its manifest (older hoptell): a missing file cannot be proven never written, so it is lost", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  fs.rmSync(path.join(dir, "access", "manifest.json"), { force: true });
  fs.rmSync(path.join(dir, "access", "requests.json"), { force: true });
  assert.equal((await restore(dir, "start")).counts.access, "rebuilt");
  // With the manifest and every file present, the state is kept.
  const kept = work(t, TPL);
  assert.ok(exists(path.join(kept, "access", "manifest.json")));
  assert.equal((await restore(kept, "start")).counts.access, "kept");
});

/** Run fn while recording each directory this process fsyncs, in order (absolute paths). */
async function dirSyncs(fn, synced = [], events = []) {
  const fds = new Map();
  const { openSync, fsyncSync, closeSync, mkdirSync } = fs;
  fs.mkdirSync = function (p, ...a) {
    const r = mkdirSync.call(this, p, ...a);
    events.push(["mkdir", path.resolve(String(p))]);
    return r;
  };
  fs.openSync = function (p, ...a) {
    const fd = openSync.call(this, p, ...a);
    fds.set(fd, path.resolve(String(p)));
    return fd;
  };
  fs.fsyncSync = function (fd, ...a) {
    if (fds.has(fd) && fs.fstatSync(fd).isDirectory()) {
      synced.push(fds.get(fd));
      events.push(["fsync", fds.get(fd)]);
    }
    return fsyncSync.call(this, fd, ...a);
  };
  fs.closeSync = function (fd, ...a) {
    fds.delete(fd);
    return closeSync.call(this, fd, ...a);
  };
  try {
    await fn();
  } finally {
    Object.assign(fs, { openSync, fsyncSync, closeSync, mkdirSync });
  }
  return synced;
}

test("restore, durability: every new evidence folder's entry is synced in its parent before the store set is moved", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  let moved = null;
  const synced = [];
  await dirSyncs(() =>
    assert.rejects(
      restore(dir, "start", {
        fault: (p) => {
          if (p === "evidence-rename:relay.db") moved ??= synced.length;
          if (p === "after:evidence") throw new Error("stop after evidence");
        },
      }),
      /stop after evidence/,
    ),
  synced);
  const id = readRestoreIntent(dir).id;
  const before = synced.slice(0, moved).map((p) => path.relative(fs.realpathSync(dir), fs.realpathSync(p)));
  for (const d of ["", "restore", path.join("restore", id), path.join("restore", id, "before")]) assert.ok(before.includes(d), `${d || "the state directory"} synced before the first move (${JSON.stringify(before)})`);
});

test("backup, durability: the new backup folder's entry is synced in its parent", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  const dest = path.join(tmp(t), "bk");
  const release = lockStateDir(dir);
  t.after(release);
  const db = openRelayStore({ dir, fullfsync: false });
  t.after(() => db.close());
  const synced = await dirSyncs(() => backupRelay({ db, stateDir: dir, dest, realm: TPL.realm, config: {} }));
  assert.ok(synced.map((p) => fs.realpathSync(p)).includes(fs.realpathSync(path.dirname(dest))), "the parent of the backup folder is synced");
});

test("restore, access readability is the start's: a missing or damaged restore.json, or an unreadable manifest, is lost state", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  fs.rmSync(path.join(dir, "access"), { recursive: true });
  await restore(dir, "start"); // rebuilt: every member pending, restore.json listed in the manifest
  fs.rmSync(path.join(dir, "access", "restore.json"));
  assert.throws(() => createAccess({ stateDir: dir }), /restore\.json cannot be read/, "the relay would refuse to start");
  const again = await restore(dir, "start");
  assert.equal(again.counts.access, "rebuilt", "so the restore treats it as lost and holds everyone");
  assert.ok(createAccess({ stateDir: dir }).pendingRecipients().length >= 3);
  // A damaged restore.json, likewise.
  fs.writeFileSync(path.join(dir, "access", "restore.json"), "{oops");
  assert.equal((await restore(dir, "start")).counts.access, "rebuilt");
  // An unreadable manifest with all four files present: lost, never readable.
  const other = work(t, TPL);
  fs.writeFileSync(path.join(other, "access", "manifest.json"), "{oops");
  assert.throws(() => createAccess({ stateDir: other }), /manifest\.json cannot be read/);
  assert.equal((await restore(other, "start")).counts.access, "rebuilt");
});

test("restore, durability: a newly created access/ and broker/ are synced in the state directory before the restore completes", async (t) => {
  await tpl();
  const dir = work(t, TPL);
  fs.rmSync(path.join(dir, "access"), { recursive: true });
  fs.rmSync(path.join(dir, "broker"), { recursive: true, force: true });
  const events = [];
  let done = -1;
  await dirSyncs(() => restore(dir, "start", { fault: (p) => p === "result-written" && (done = events.length) }), [], events);
  const real = (p) => fs.realpathSync(p);
  for (const sub of ["access", "broker"]) {
    const made = events.findIndex(([k, p]) => k === "mkdir" && real(p) === real(path.join(dir, sub)));
    assert.ok(made >= 0, `${sub}/ was created`);
    const synced = events.findIndex(([k, p], i) => i > made && k === "fsync" && real(p) === real(dir));
    assert.ok(synced > made && synced < done, `the state directory is synced after ${sub}/ is created and before the result (${JSON.stringify(events.map(([k, p]) => `${k} ${path.relative(dir, p)}`))})`);
  }
});

test("restore, phase 4 in bounded steps: on a larger store every reconcile transaction stays under A (a reader pinned, so the WAL only grows), and a crash at every step boundary resumes to the same result", async (t) => {
  const big = await buildLargeTemplate(t);
  const run = (dir, mode, fault = null) => runRestore({ stateDir: dir, mode, backupDir: big.backup, membersFile: big.config.members, fault });
  // Uninterrupted, with a reader holding a snapshot of the installed store from before the reconcile's writes.
  const ref = work(t, big);
  let reader = null;
  let last = 0;
  const sizes = [];
  const wal = () => (exists(path.join(ref, "relay.db-wal")) ? fs.statSync(path.join(ref, "relay.db-wal")).size : 0);
  const r = await run(ref, "start", (p) => {
    // Opened inside the first step's transaction (the restore's own open must find no reader).
    if (!reader && (p === "reconcile-step-before-commit" || p === "reconcile-before-commit")) {
      reader = new DatabaseSync(path.join(ref, "relay.db"));
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM devices").get();
      last = wal();
    }
    if (p === "reconcile-step-after-commit" || p === "reconcile-after-commit") {
      sizes.push(wal() - last);
      last = wal();
    }
    if (p === "reconciled") {
      reader.exec("COMMIT");
      reader.close();
    }
  });
  assert.equal(r.done, true);
  assert.ok(sizes.length >= 20, `the reconcile ran in ${sizes.length} transactions`);
  for (const n of sizes) assert.ok(n <= TRANSACTION_ALLOWANCE, `a reconcile transaction appended ${n} bytes <= A`);
  t.diagnostic(`reconcile: ${sizes.length} transactions, the largest ${Math.max(...sizes)} bytes of WAL, in all ${sizes.reduce((a, b) => a + b, 0)}`);
  const reference = summary(ref);
  assert.equal(reference.keyPackages, 0);
  assert.equal(reference.reservations, 0);
  assert.equal(reference.revocations.length, 600);
  assert.equal(reference.e2ee.groups.filter((g) => g.replace_required === 1).length, 300);
  assert.deepEqual([reference.counts.key_packages_cleared, reference.counts.reservations_cleared, reference.counts.revocations_merged, reference.counts.e2ee_ops_merged, reference.counts.audit_copied, reference.counts.transfers_ended], [1200 - 300, 300, 600, 700, 600, 20]);
  // A crash after each committed step (every transaction but the last), then --resume: the same result.
  for (let i = 1; i < sizes.length; i++) {
    const dir = work(t, big);
    let n = 0;
    await assert.rejects(
      run(dir, "start", (p) => {
        if (p === "reconcile-step-after-commit" && ++n === i) throw Object.assign(new Error(`crash at step ${i}`), { crash: true });
      }),
      /crash at step/,
    );
    assert.equal(readRestoreIntent(dir).phase, "installed");
    const done = await run(dir, "resume");
    assert.equal(done.done, true);
    assert.deepEqual(summary(dir), reference, `crash after transaction ${i}: the same result as an uninterrupted restore`);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
