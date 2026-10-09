// The relay's store as every start opens it (design 4.4): migration 2 appended after 3.2's, a v1
// store migrated with its data, the restore fence in openRelayDb, the audit log's hash chain, its
// anchor after a retention sweep in batches, and table counts in bounded statements.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lockStateDir } from "../lib/realm.js";
import { openRelayDb } from "../lib/relaydb.js";
import { DEVICE_MIGRATIONS } from "../lib/mls/relaydir.js";
import { E2EE_MIGRATIONS } from "../lib/mls/relayds.js";
import { ADMIN_MIGRATION, RELAY_MIGRATIONS, appendAudit, auditOut, countRows, openRelayStore, storeMeta, sweepAudit, verifyAudit } from "../lib/relaystore.js";

function stateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-store-"));
  fs.chmodSync(dir, 0o700);
  const release = lockStateDir(dir);
  t.after(() => {
    release();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const audit = (db, row) => db.tx((h) => appendAudit(h, { actor: "offline-cli", action: "test.row", state: "done", ...row }));

test("migration 4 is appended after 3.2's and 3.3's, one list: a v1 store keeps its devices, gains the DS and admin tables and an instance id", (t) => {
  const dir = stateDir(t);
  const v1 = openRelayDb({ dir, migrations: DEVICE_MIGRATIONS, fullfsync: false });
  v1.tx((h) => h.run("INSERT INTO devices (member_id, device_id, sig_key, pin, seq, created) VALUES ('m_x', 'd', x'00', x'00', 0, 1)"));
  v1.close();
  const db = openRelayStore({ dir, fullfsync: false });
  assert.equal(db.version, 4);
  assert.deepEqual(RELAY_MIGRATIONS.slice(0, 3), [...DEVICE_MIGRATIONS, ...E2EE_MIGRATIONS], "migrations 1 to 3 are 3.2's and 3.3's, unchanged and in their order");
  assert.equal(RELAY_MIGRATIONS[3], ADMIN_MIGRATION);
  assert.equal(Number(db.get("SELECT replace_required FROM e2ee_groups LIMIT 1")?.replace_required ?? 0), 0);
  assert.deepEqual({ ...db.get("SELECT member_id, suspended FROM devices") }, { member_id: "m_x", suspended: 0 });
  assert.match(storeMeta(db, "instance"), /^[0-9a-f]{32}$/);
  for (const t2 of ["admin_audit", "admin_audit_anchor", "store_meta"]) assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = ?", t2), t2);
  const instance = storeMeta(db, "instance");
  db.close();
  const again = openRelayStore({ dir, fullfsync: false });
  assert.equal(storeMeta(again, "instance"), instance, "the instance id is kept across opens");
  again.close();
});

test("a store at next's migration 3 (3.2 and 3.3) upgrades to 4 in place, its conversations kept, none marked", (t) => {
  const dir = stateDir(t);
  const v3 = openRelayDb({ dir, migrations: [...DEVICE_MIGRATIONS, ...E2EE_MIGRATIONS], fullfsync: false });
  v3.tx((h) => h.run("INSERT INTO e2ee_groups (group_id, member_a, member_b, generation, state, epoch, created) VALUES (?, 'm_a', 'm_b', 1, 'active', 3, 1)", "0".repeat(32)));
  v3.close();
  const db = openRelayStore({ dir, fullfsync: false });
  assert.equal(db.version, 4);
  assert.deepEqual({ ...db.get("SELECT epoch, replace_required FROM e2ee_groups") }, { epoch: 3, replace_required: 0 });
  db.close();
});

test("the restore fence: an intent refuses every opener but the restore with its id; a damaged intent refuses all", (t) => {
  const dir = stateDir(t);
  openRelayStore({ dir, fullfsync: false }).close();
  fs.mkdirSync(path.join(dir, "restore"), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "restore", "intent.json"), JSON.stringify({ v: 1, id: "0123456789abcdef", phase: "evidence" }));
  assert.throws(() => openRelayStore({ dir, fullfsync: false }), /unfinished restore \(0123456789abcdef, phase evidence\)/);
  assert.throws(() => openRelayStore({ dir, fullfsync: false, restoreId: "fedcba9876543210" }), /unfinished restore/);
  openRelayStore({ dir, fullfsync: false, restoreId: "0123456789abcdef" }).close();
  fs.writeFileSync(path.join(dir, "restore", "intent.json"), "{not json");
  assert.throws(() => openRelayStore({ dir, fullfsync: false, restoreId: "0123456789abcdef" }), /damaged; an unfinished restore fences/);
});

test("audit rows: a hash chain over every field; a modified row is found; free text and control characters never stored", (t) => {
  const dir = stateDir(t);
  const db = openRelayStore({ dir, fullfsync: false });
  t.after(() => db.close());
  audit(db, { target: "alice\u001b[31m\nforged", detail: { pages: 3, code: "ok" } });
  audit(db, { target: "bob", detail: {} });
  audit(db, { target: "carol", detail: { slow: true } });
  const rows = db.all("SELECT * FROM admin_audit ORDER BY seq").map(auditOut);
  assert.equal(rows[0].target, "alice [31m forged", "control characters are cleaned");
  assert.deepEqual(verifyAudit(db), { ok: true, rows: 3, from: 0, brokenAt: null });
  assert.throws(() => audit(db, { detail: { note: "some free text here" } }), /not a code or a count/);
  assert.throws(() => audit(db, { detail: { "Bad Key": 1 } }), /identifier/);
  assert.throws(() => audit(db, { action: "Not An Action" }), /fixed name/);
  // A casual edit outside hoptell (the store's schema is untouched, so it opens).
  db.close();
  const raw = new DatabaseSync(path.join(dir, "relay.db"));
  raw.exec("UPDATE admin_audit SET target = 'mallory' WHERE seq = 2");
  raw.close();
  const db2 = openRelayStore({ dir, fullfsync: false });
  assert.deepEqual(verifyAudit(db2), { ok: false, rows: 1, from: 0, brokenAt: 2 });
  db2.close();
});

test("retention: oldest rows deleted in batches of 256 with the anchor in the same transaction; the chain verifies from it", (t) => {
  const dir = stateDir(t);
  const db = openRelayStore({ dir, fullfsync: false });
  t.after(() => db.close());
  const now = Date.now();
  db.tx((h) => {
    for (let i = 0; i < 700; i++) appendAudit(h, { actor: "relay", action: "test.row", state: "event", time: now - (i < 300 ? 400 * 86_400_000 : 0) });
  });
  const tx = db.tx;
  let txs = 0;
  db.tx = (fn) => (txs++, tx(fn));
  // 300 rows are past the age limit: a full batch of 256, then one of 44.
  assert.equal(sweepAudit(db, { now }), 300);
  db.tx = tx;
  assert.equal(txs, 2, "one transaction per batch of at most 256");
  const anchor = db.get("SELECT seq, hash FROM admin_audit_anchor");
  assert.equal(Number(anchor.seq), 300);
  assert.deepEqual(verifyAudit(db), { ok: true, rows: 400, from: 300, brokenAt: null });
  // A row count over the limit deletes the oldest beyond it.
  assert.equal(sweepAudit(db, { now, maxRows: 100 }), 300);
  assert.equal(Number(db.get("SELECT count(*) AS n FROM admin_audit").n), 100);
  assert.equal(verifyAudit(db).ok, true);
  // A new row chains on after the anchor even when every row was deleted.
  assert.equal(sweepAudit(db, { now: now + 400 * 86_400_000 }), 100);
  audit(db, {});
  assert.deepEqual(verifyAudit(db), { ok: true, rows: 1, from: 700, brokenAt: null });
});

test("table counts: keyset ranges of at most 10,000 rows, yielding between statements", async (t) => {
  const dir = stateDir(t);
  const db = openRelayStore({ dir, fullfsync: false });
  t.after(() => db.close());
  db.tx((h) => {
    for (let i = 0; i < 25_000; i++) h.run("INSERT INTO admin_audit (seq, time, actor, action, state, detail, prev, hash) VALUES (?, 0, 'relay', 'x', 'event', '{}', '', '')", i + 1);
  });
  let pauses = 0;
  assert.equal(await countRows(db, "admin_audit", { pause: async () => pauses++ }), 25_000);
  assert.equal(pauses, 2, "three statements, two pauses");
  await assert.rejects(countRows(db, "sqlite_master"), /not a counted table/);
});

test("checkpoint and stat are the store's own; checkpoint refuses inside a transaction", (t) => {
  const dir = stateDir(t);
  const db = openRelayStore({ dir, fullfsync: false });
  t.after(() => db.close());
  audit(db, {});
  assert.ok(db.stat().wal > 0);
  const r = db.checkpoint();
  assert.equal(r.busy, 0);
  assert.equal(db.stat().wal, 0, "TRUNCATE empties the -wal file");
  assert.throws(() => db.tx(() => db.checkpoint()), /outside tx/);
  assert.throws(() => db.run("PRAGMA wal_checkpoint(TRUNCATE)"), /PRAGMA is not available|inside tx/);
});
