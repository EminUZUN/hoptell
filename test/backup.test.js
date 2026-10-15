// Online backups (design 4.4, "Backups"): under concurrent writes through the same connection with
// small steps and a slowed destination (the largest step time measured and warned about, the -wal
// size observed, every write still accepted), verification of the copy, a disk-full failure, an
// existing target, and the folder's contents (one private store file, access/, config copies, the
// manifest written last). Design 6's admission classes are not on this branch: there are no
// admission refusals to count yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createAccess } from "../lib/access.js";
import { MIN_PAGES, backupRelay, readBackup } from "../lib/backup.js";
import { loadRealm, lockStateDir } from "../lib/realm.js";
import { RELAY_MIGRATIONS, appendAudit, openRelayStore } from "../lib/relaystore.js";
import { ID, membersFile, tmp } from "./restore-helpers.js";

async function store(t, { rows = 0 } = {}) {
  const root = tmp(t, "hoptell-bk-");
  const state = path.join(root, "state");
  const release = lockStateDir(state);
  t.after(release);
  const realm = loadRealm(state);
  const db = openRelayStore({ dir: state, fullfsync: false });
  t.after(() => db.close());
  if (rows) {
    db.tx((h) => {
      for (let i = 0; i < rows; i++) h.run("INSERT INTO admin_audit (seq, time, actor, action, state, detail, prev, hash) VALUES (?, 0, 'relay', 'bulk', 'event', ?, '', '')", i + 1, JSON.stringify({ pad: "x".repeat(200) }));
    });
  }
  const members = membersFile(root);
  return { root, state, db, realm, members };
}

test("backup under concurrent writes with small steps and a slowed destination: valid, the largest step reported with a warning", async (t) => {
  const s = await store(t, { rows: 20_000 });
  let writes = 0;
  let maxWal = 0;
  const writer = setInterval(() => {
    s.db.tx((h) => appendAudit(h, { actor: "relay", action: "test.during-backup", state: "event" }));
    writes++;
    maxWal = Math.max(maxWal, s.db.stat().wal);
  }, 2);
  let slowed = false;
  const dest = path.join(s.root, "bk");
  const r = await backupRelay({
    db: s.db,
    stateDir: s.state,
    dest,
    pages: MIN_PAGES,
    realm: s.realm,
    config: { members: s.members },
    fault: (p) => {
      if (p !== "step" || slowed) return;
      slowed = true;
      const until = Date.now() + 1100; // one step on a slow disk
      while (Date.now() < until);
    },
  });
  clearInterval(writer);
  assert.ok(r.steps > 50, `${r.steps} steps of ${MIN_PAGES} pages`);
  assert.ok(r.maxStepMs >= 1000, `the largest step is measured (${r.maxStepMs} ms)`);
  assert.equal(r.warning, true, "a step over 1 s gives a warning; the copy is still valid");
  assert.ok(writes > 0, "the relay's writes went on during the backup");
  assert.ok(maxWal > 0, `the -wal grew to ${maxWal} bytes while the backup read`);
  const b = readBackup(dest);
  assert.equal(b.store.version, RELAY_MIGRATIONS.length);
  const copy = new DatabaseSync(path.join(dest, "relay.db"), { readOnly: true });
  assert.ok(Number(copy.prepare("SELECT count(*) AS n FROM admin_audit").get().n) >= 20_000);
  copy.close();
});

test("the backup folder: 0700, a private single-file store, access/, config copies with their paths, the manifest last", { skip: process.platform === "win32" }, async (t) => {
  const s = await store(t);
  const access = createAccess({ stateDir: s.state });
  access.putGrants(ID.alice, 0, { default: "deny", visible: "all", entries: [] });
  const policy = path.join(s.root, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ v: 1, rules: [] }));
  s.db.tx((h) => appendAudit(h, { actor: "offline-cli", action: "test.row", state: "done" }));
  const dest = path.join(s.root, "bk");
  const r = await backupRelay({ db: s.db, stateDir: s.state, dest, realm: s.realm, config: { members: s.members, policy } });
  assert.equal(fs.statSync(dest).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dest).sort(), ["access", "config", "manifest.json", "relay.db"], "one store file: no -wal, no -shm");
  for (const f of ["relay.db", "access/grants.json", "config/members.json", "config/policy.json", "manifest.json"]) assert.equal(fs.statSync(path.join(dest, f)).mode & 0o777, 0o600, f);
  const m = r.manifest;
  assert.deepEqual(Object.keys(m.files).sort(), ["access/grants.json", "config/members.json", "config/policy.json", "relay.db"]);
  assert.deepEqual(m.config, { members: path.resolve(s.members), policy: path.resolve(policy), oidc: null });
  assert.equal(m.realm, s.realm);
  assert.equal(m.lastAuditSeq, 1);
  assert.match(m.instance, /^[0-9a-f]{32}$/);
  assert.deepEqual(readBackup(dest).manifest, m);
  // The copy opens read-only without creating side files (rollback-journal mode).
  readBackup(dest);
  assert.deepEqual(fs.readdirSync(dest).sort(), ["access", "config", "manifest.json", "relay.db"]);
});

test("backup refusals: an existing target, too small a step, a corrupted copy, a full disk; the partial folder is removed", async (t) => {
  const s = await store(t, { rows: 500 });
  const o = { db: s.db, stateDir: s.state, realm: s.realm, config: { members: s.members } };
  const existing = path.join(s.root, "exists");
  fs.mkdirSync(existing);
  await assert.rejects(backupRelay({ ...o, dest: existing }), /exists; a backup goes into a new folder/);
  assert.deepEqual(fs.readdirSync(existing), [], "untouched");
  await assert.rejects(backupRelay({ ...o, dest: path.join(s.root, "small"), pages: 8 }), /at least 16/);
  await assert.rejects(backupRelay({ ...o, dest: "relative/dir" }), /absolute path/);
  const corrupt = path.join(s.root, "corrupt");
  await assert.rejects(
    backupRelay({
      ...o,
      dest: corrupt,
      fault: (p, f) => {
        if (p !== "after-copy") return;
        const fd = fs.openSync(f, "r+");
        fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 4096 * 3);
        fs.closeSync(fd);
      },
    }),
    /not a sound copy of a hoptell relay store/,
  );
  assert.equal(fs.existsSync(corrupt), false, "nothing reported as backed up, nothing left");
  const full = path.join(s.root, "full");
  await assert.rejects(backupRelay({ ...o, dest: full, fault: (p) => { if (p === "write") throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } }), /ENOSPC/);
  assert.equal(fs.existsSync(full), false);
  // A folder whose digest no longer matches is not a usable backup.
  const good = path.join(s.root, "good");
  await backupRelay({ ...o, dest: good });
  fs.appendFileSync(path.join(good, "config", "members.json"), " ");
  assert.throws(() => readBackup(good), /config\/members\.json does not match its digest/);
});

test("a runtime without node:sqlite backup() refuses the backup", async (t) => {
  const s = await store(t);
  const sqlite = createRequire(import.meta.url)("node:sqlite");
  const original = sqlite.backup;
  sqlite.backup = undefined;
  t.after(() => (sqlite.backup = original));
  await assert.rejects(backupRelay({ db: s.db, stateDir: s.state, dest: path.join(s.root, "none"), realm: s.realm }), /has no backup\(\)/);
  assert.equal(fs.existsSync(path.join(s.root, "none")), false);
});

/**
 * The rejection node:sqlite's backup() gives when its first step meets a lock: a raw database
 * whose write transaction stays open until the backup settles (no timing assumption). Null when
 * this runtime retries such a step instead (the backup then completes once the write ends).
 */
async function firstStepLockedRejection() {
  const raw = new DatabaseSync(":memory:");
  try {
    raw.exec("CREATE TABLE t (x BLOB)");
    raw.exec("BEGIN IMMEDIATE");
    raw.prepare("INSERT INTO t VALUES (randomblob(4000))").run();
    const job = createRequire(import.meta.url)("node:sqlite").backup(raw, ":memory:").then(() => null, (e) => e);
    const settled = await Promise.race([job, new Promise((r) => setTimeout(() => r("pending"), 3000))]);
    raw.exec("ROLLBACK");
    return settled === "pending" ? await job : settled;
  } finally {
    raw.close();
  }
}

test("node:sqlite's rejection for a first step that met a lock is retried, and the backup succeeds", async (t) => {
  const real = await firstStepLockedRejection();
  if (real) assert.deepEqual([real.code, real.errcode, real.message], ["ERR_SQLITE_ERROR", 0, "not an error"], "the rejection lib/relaydb.js retries");
  else t.diagnostic("this runtime retries a first step that met a lock; the rejection is simulated");
  const s = await store(t, { rows: 500 });
  const sqlite = createRequire(import.meta.url)("node:sqlite");
  const original = sqlite.backup;
  let calls = 0;
  sqlite.backup = (...args) => (++calls === 1 ? Promise.reject(real ?? Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR", errcode: 0 })) : original(...args));
  t.after(() => (sqlite.backup = original));
  const dest = path.join(s.root, "retried");
  const r = await backupRelay({ db: s.db, stateDir: s.state, dest, realm: s.realm, config: { members: s.members } });
  assert.equal(calls, 2);
  assert.equal(readBackup(dest).manifest.schema.name, "relay");
  assert.ok(r.pages > 0);
});

test("a backup that cannot start: bounded tries, each into an empty destination, then a clear error; other errors are not retried", async (t) => {
  const s = await store(t);
  const sqlite = createRequire(import.meta.url)("node:sqlite");
  const original = sqlite.backup;
  t.after(() => (sqlite.backup = original));
  const sizes = [];
  // Node's rejection when the first step meets SQLITE_BUSY or SQLITE_LOCKED.
  sqlite.backup = async (_db, dest) => {
    sizes.push(fs.statSync(dest).size);
    fs.writeFileSync(dest, "partial");
    fs.writeFileSync(`${dest}-journal`, "x");
    throw Object.assign(new Error("not an error"), { code: "ERR_SQLITE_ERROR", errcode: 0, errstr: "not an error" });
  };
  const dest = path.join(s.root, "busy");
  await assert.rejects(backupRelay({ db: s.db, stateDir: s.state, dest, realm: s.realm }), /^Error: the relay database stayed busy; the backup did not start after 20 tries; try again$/);
  assert.equal(sizes.length, 20);
  assert.deepEqual([...new Set(sizes)], [0], "every try starts from an empty destination");
  assert.equal(fs.existsSync(dest), false, "the partial folder is removed");
  // Any other SQLite error fails at once.
  let tries = 0;
  sqlite.backup = async () => {
    tries++;
    throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10, errstr: "disk I/O error" });
  };
  await assert.rejects(backupRelay({ db: s.db, stateDir: s.state, dest: path.join(s.root, "io"), realm: s.realm }), /disk I\/O error/);
  assert.equal(tries, 1);
  // The store closes normally afterwards (no backup is counted as still running).
  assert.doesNotThrow(() => s.db.stat());
});
