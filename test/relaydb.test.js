// The relay's durable storage (design 3.3): pragmas, migrations, refusals at open, transactions
// that apply whole or not at all, a crash at either side of a commit, and private files.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lockStateDir } from "../lib/realm.js";
import { APPLICATION_ID, openRelayDb } from "../lib/relaydb.js";

const CRASH = fileURLToPath(new URL("./fixtures/relaydb-crash.mjs", import.meta.url));
const V1 = ["CREATE TABLE items (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT"];
const V2 = [...V1, (h) => {
  h.exec("ALTER TABLE items ADD COLUMN size INTEGER NOT NULL DEFAULT 0");
  h.run("UPDATE items SET size = length(body)");
}];

/** A locked state directory, released and removed after the test. */
function stateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-relaydb-"));
  fs.chmodSync(dir, 0o700);
  const release = lockStateDir(dir);
  t.after(() => {
    release();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const rows = (db) => db.all("SELECT id, body FROM items ORDER BY id").map((r) => ({ ...r }));
const put = (db, id, body) => db.tx((h) => h.run("INSERT INTO items (id, body) VALUES (?, ?)", id, body));

test("open creates the database with its pragmas, and reopening finds the data", (t) => {
  const dir = stateDir(t);
  const db = openRelayDb({ dir, migrations: V1 });
  assert.equal(db.path, path.join(dir, "relay.db"));
  assert.equal(db.version, 1);
  assert.equal(db.get("PRAGMA journal_mode").journal_mode, "wal");
  assert.equal(db.get("PRAGMA synchronous").synchronous, 2); // FULL
  assert.equal(db.get("PRAGMA foreign_keys").foreign_keys, 1);
  assert.equal(db.get("PRAGMA trusted_schema").trusted_schema, 0);
  assert.equal(db.get("PRAGMA application_id").application_id, APPLICATION_ID);
  put(db, "a", "first");
  db.close();
  const again = openRelayDb({ dir, migrations: V1 });
  assert.deepEqual(rows(again), [{ id: "a", body: "first" }]);
  again.close();
});

test("the relay's own lock is required: another process's lock, or none, is refused", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-relaydb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  assert.throws(() => openRelayDb({ dir, migrations: V1 }), /state directory's lock/);
  fs.writeFileSync(path.join(dir, "relay.lock"), `${process.ppid}\n`);
  assert.throws(() => openRelayDb({ dir, migrations: V1 }), /state directory's lock/);
  assert.equal(fs.existsSync(path.join(dir, "relay.db")), false);
});

test("migrations run up one version at a time and keep the data", (t) => {
  const dir = stateDir(t);
  const db = openRelayDb({ dir, migrations: V1 });
  put(db, "a", "four");
  db.close();
  const v2 = openRelayDb({ dir, migrations: V2 });
  assert.equal(v2.version, 2);
  assert.deepEqual({ ...v2.get("SELECT size FROM items WHERE id = 'a'") }, { size: 4 });
  assert.equal(v2.get("SELECT value FROM schema_meta WHERE key = 'version'").value, 2);
  v2.close();
  // A migration that fails leaves the last completed version, unchanged.
  const bad = [...V2, (h) => {
    h.exec("CREATE TABLE extra (x INTEGER) STRICT");
    h.exec("INSERT INTO extra (x) VALUES ('not a number')");
  }];
  assert.throws(() => openRelayDb({ dir, migrations: bad }), /could not be brought to schema relay version 3 \(SQLite error \d+\)/);
  const still = openRelayDb({ dir, migrations: V2 });
  assert.equal(still.version, 2);
  assert.equal(still.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 'extra'").n, 0);
  still.close();
});

test("refused at open: a newer version, another schema, a changed schema, a foreign file", (t) => {
  const dir = stateDir(t);
  openRelayDb({ dir, migrations: V2 }).close();
  assert.throws(() => openRelayDb({ dir, migrations: V1 }), /schema relay version 2, newer than this hoptell knows \(1\)/);
  assert.throws(() => openRelayDb({ dir, schema: "transfers", migrations: V2 }), /unexpected schema/);
  // A change made outside hoptell (here through a second connection) is noticed.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const other = new DatabaseSync(path.join(dir, "relay.db"));
  other.exec("ANALYZE"); // statistics are not schema
  other.close();
  openRelayDb({ dir, migrations: V2 }).close();
  const other2 = new DatabaseSync(path.join(dir, "relay.db"));
  other2.exec("CREATE INDEX items_body ON items (body)");
  other2.close();
  assert.throws(() => openRelayDb({ dir, migrations: V2 }), /changed outside hoptell/);
  // A valid SQLite file that is not ours.
  const foreign = new DatabaseSync(path.join(dir, "other.db"));
  foreign.exec("CREATE TABLE t (x)");
  foreign.close();
  fs.chmodSync(path.join(dir, "other.db"), 0o600);
  assert.throws(() => openRelayDb({ dir, file: "other.db", migrations: V1 }), /is not a hoptell relay database/);
});

test("a damaged file is refused with a fixed message and left as it was", (t) => {
  const dir = stateDir(t);
  const db = openRelayDb({ dir, migrations: V1 });
  const secret = "row-data-that-must-not-leak";
  db.tx((h) => {
    for (let i = 0; i < 200; i++) h.run("INSERT INTO items (id, body) VALUES (?, ?)", `id-${i}`, `${secret}-${i}-${"x".repeat(200)}`);
  });
  db.close(); // checkpoints: everything is in relay.db
  const good = fs.readFileSync(path.join(dir, "relay.db"));
  const damage = (mutate) => {
    const copy = Buffer.from(good);
    mutate(copy);
    fs.writeFileSync(path.join(dir, "relay.db"), copy);
    for (const side of ["-wal", "-shm"]) fs.rmSync(path.join(dir, `relay.db${side}`), { force: true });
    return copy;
  };
  const cases = [
    (b) => b.fill(0x41, 0, 16), // the header: not a database at all
    (b) => b.fill(0xff, 4096 * 2, 4096 * 2 + 64), // a page inside the table
  ];
  for (const mutate of cases) {
    const bytes = damage(mutate);
    assert.throws(
      () => openRelayDb({ dir, migrations: V1 }),
      (e) => {
        assert.match(e.message, /^the relay database .*relay\.db is damaged or unreadable( \(SQLite error \d+\))?; restore it from a backup \(it is never reinitialized\)$/);
        assert.doesNotMatch(e.message, new RegExp(secret));
        return true;
      },
    );
    assert.deepEqual(fs.readFileSync(path.join(dir, "relay.db")), bytes, "never rewritten");
  }
});

test("a missing database in an established directory is not recreated empty", (t) => {
  const dir = stateDir(t);
  openRelayDb({ dir, migrations: V1 }).close();
  fs.rmSync(path.join(dir, "relay.db"));
  assert.throws(() => openRelayDb({ dir, migrations: V1 }), /missing from an established state directory; restore it from a backup, or remove .*\.relay\.db\.created to start/);
  assert.equal(fs.existsSync(path.join(dir, "relay.db")), false);
});

test("tx: whole or nothing; no nesting, no async functions, no changes outside it", (t) => {
  const dir = stateDir(t);
  const db = openRelayDb({ dir, migrations: V1 });
  assert.equal(put(db, "a", "first").changes, 1);
  assert.throws(() => db.tx((h) => {
    h.run("INSERT INTO items (id, body) VALUES ('b', 'second')");
    h.run("UPDATE items SET body = 'changed' WHERE id = 'a'");
    throw new Error("boom");
  }), /boom/);
  assert.deepEqual(rows(db), [{ id: "a", body: "first" }]);
  // A constraint failure part way rolls back the earlier statements too.
  assert.throws(() => db.tx((h) => {
    h.run("INSERT INTO items (id, body) VALUES ('c', 'third')");
    h.run("INSERT INTO items (id, body) VALUES ('a', 'duplicate')");
  }), /UNIQUE/);
  assert.deepEqual(rows(db), [{ id: "a", body: "first" }]);
  assert.throws(() => db.tx(() => db.tx(() => {})), /do not nest/);
  assert.throws(() => db.tx(async (h) => h.run("INSERT INTO items (id, body) VALUES ('d', 'x')")), /synchronous function/);
  // A plain function returning a promise: what ran before the promise is rolled back.
  assert.throws(() => db.tx((h) => {
    h.run("INSERT INTO items (id, body) VALUES ('e', 'x')");
    return Promise.resolve();
  }), /returned a promise/);
  assert.throws(() => db.run("INSERT INTO items (id, body) VALUES ('f', 'x')"), /inside tx\(\)/);
  for (const sql of ["DELETE FROM items RETURNING id", "WITH x AS (SELECT 1) DELETE FROM items", "PRAGMA journal_mode = DELETE", "PRAGMA journal_mode(DELETE)"]) assert.throws(() => db.get(sql), /inside tx\(\)|not available/, sql);
  assert.equal(db.get("PRAGMA journal_mode").journal_mode, "wal");
  assert.throws(() => db.tx((h) => h.exec("COMMIT")), /alone begins and ends/);
  assert.deepEqual(rows(db), [{ id: "a", body: "first" }]);
  // Usable afterwards.
  put(db, "g", "after");
  assert.equal(rows(db).length, 2);
  db.close();
});

test("fault injection: before the commit nothing applies; after it everything does", (t) => {
  const dir = stateDir(t);
  let point = null;
  const db = openRelayDb({ dir, migrations: V1, fault: (p) => {
    if (p === point) throw Object.assign(new Error(`fault at ${p}`), { code: "EFAULT" });
  } });
  put(db, "a", "first");
  const change = (h) => {
    h.run("INSERT INTO items (id, body) VALUES ('b', 'second')");
    h.run("UPDATE items SET body = 'changed' WHERE id = 'a'");
  };
  point = "before-commit";
  assert.throws(() => db.tx(change), /fault at before-commit/);
  assert.deepEqual(rows(db), [{ id: "a", body: "first" }]);
  point = "after-commit";
  assert.throws(() => db.tx(change), /fault at after-commit/);
  assert.deepEqual(rows(db), [{ id: "a", body: "changed" }, { id: "b", body: "second" }]);
  db.close();
});

/** Run the crash fixture; it must die by SIGKILL at `point`. */
const crash = (dir, point) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [CRASH, dir, point], { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err?.signal === "SIGKILL") return resolve();
      reject(new Error(`the fixture did not die at ${point}: ${err?.message ?? "exited"} ${stdout}${stderr}`));
    });
  });

test("a crash before the commit keeps the committed data only; after it, the change too", async (t) => {
  for (const [point, expected] of [
    ["before-commit", [{ id: "a", body: "first" }]],
    ["after-commit", [{ id: "a", body: "changed" }, { id: "b", body: "second" }]],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-relaydb-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.chmodSync(dir, 0o700);
    await crash(dir, point);
    assert.equal(fs.existsSync(path.join(dir, "relay.db-wal")), true, "the WAL is left behind");
    const release = lockStateDir(dir); // the dead fixture's lock is taken over
    try {
      const db = openRelayDb({ dir, migrations: V1 });
      assert.deepEqual(rows(db), expected, point);
      assert.equal(db.get("PRAGMA quick_check").quick_check, "ok");
      db.close();
    } finally {
      release();
    }
  }
});

test("files are private: 0600 database, WAL and index; refused when open to others", { skip: process.platform === "win32" }, (t) => {
  const dir = stateDir(t);
  const old = process.umask(0o022);
  let db;
  try {
    db = openRelayDb({ dir, migrations: V1 });
    put(db, "a", "first");
  } finally {
    process.umask(old);
  }
  for (const f of ["relay.db", "relay.db-wal", "relay.db-shm"]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  db.close();
  fs.chmodSync(path.join(dir, "relay.db"), 0o644);
  assert.throws(() => openRelayDb({ dir, migrations: V1 }), /open to other users; run: chmod 600/);
});

test("the SQLite ExperimentalWarning stays out of the log; other warnings do not", async () => {
  const code = `
    import { openRelayDb } from ${JSON.stringify(new URL("../lib/relaydb.js", import.meta.url).href)};
    try { openRelayDb({ dir: "/nonexistent-hoptell" }); } catch {}
    process.emitWarning("another warning", "ExperimentalWarning");
  `;
  const stderr = await new Promise((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", code], (_err, _out, se) => resolve(se));
  });
  assert.doesNotMatch(stderr, /SQLite/);
  assert.match(stderr, /another warning/);
});

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** A file's bytes and journal mode, read without writing to it. */
function snapshot(file) {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const hash = sha(file);
  if (fs.statSync(file).size === 0) return { hash, mode: null };
  const ro = new DatabaseSync(file, { readOnly: true });
  try {
    return { hash, mode: ro.prepare("PRAGMA journal_mode").get().journal_mode };
  } finally {
    ro.close();
  }
}
const markers = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith(".relay.db.")).sort();

test("an established database that is empty or blank is refused and left as it is", (t) => {
  const dir = stateDir(t);
  const file = path.join(dir, "relay.db");
  const db = openRelayDb({ dir, migrations: V1 });
  put(db, "a", "first");
  db.close();
  assert.deepEqual(markers(dir), [".relay.db.created"]);
  const blank = path.join(dir, "blank.db");
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const b = new DatabaseSync(blank); // a valid SQLite file without anything in it
  b.exec("CREATE TABLE t (x); DROP TABLE t");
  b.close();
  for (const replace of [() => fs.truncateSync(file, 0), () => fs.copyFileSync(blank, file)]) {
    replace();
    for (const side of ["-wal", "-shm"]) fs.rmSync(file + side, { force: true });
    fs.chmodSync(file, 0o600);
    const before = snapshot(file);
    assert.throws(() => openRelayDb({ dir, migrations: V1 }), /relay\.db is empty in an established state directory; restore it from a backup, or remove it and .*\.relay\.db\.created to start with an empty database/);
    assert.deepEqual(snapshot(file), before, "never modified");
    for (const side of ["-wal", "-shm"]) assert.equal(fs.existsSync(file + side), false, side);
  }
  assert.equal(snapshot(file).mode, "delete");
});

test("an interrupted first creation resumes at every step; a blank file not ours is refused", (t) => {
  const dir = stateDir(t);
  const file = path.join(dir, "relay.db");
  const creating = path.join(dir, ".relay.db.creating");
  const fresh = () => {
    for (const f of fs.readdirSync(dir)) if (f !== "relay.lock") fs.rmSync(path.join(dir, f));
  };
  // Marked as creating, crashed before the file was created; then before its first commit.
  for (const make of [() => {}, () => fs.writeFileSync(file, "", { mode: 0o600 })]) {
    fresh();
    fs.writeFileSync(creating, "", { mode: 0o600 });
    make();
    const db = openRelayDb({ dir, migrations: V1 });
    assert.equal(db.version, 1);
    db.close();
    assert.deepEqual(markers(dir), [".relay.db.created"]);
  }
  // Crashed after the first commit, before the store was marked established.
  let db = openRelayDb({ dir, migrations: V1 });
  put(db, "a", "first");
  db.close();
  fs.renameSync(path.join(dir, ".relay.db.created"), creating);
  db = openRelayDb({ dir, migrations: V1 });
  assert.deepEqual(rows(db), [{ id: "a", body: "first" }]);
  db.close();
  assert.deepEqual(markers(dir), [".relay.db.created"]);
  // A store of ours without markers (restored from a backup) is adopted.
  fs.rmSync(path.join(dir, ".relay.db.created"));
  db = openRelayDb({ dir, migrations: V1 });
  assert.deepEqual(rows(db), [{ id: "a", body: "first" }]);
  db.close();
  assert.deepEqual(markers(dir), [".relay.db.created"]);
  // An empty file no hoptell created is not initialized.
  fresh();
  fs.writeFileSync(file, "", { mode: 0o600 });
  assert.throws(() => openRelayDb({ dir, migrations: V1 }), /relay\.db is empty and was not created by this hoptell; remove it/);
  assert.equal(fs.statSync(file).size, 0);
  assert.deepEqual(markers(dir), []);
});

test("a refused file is identified before anything writes to it: foreign, changed, newer", (t) => {
  const dir = stateDir(t);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const foreign = path.join(dir, "foreign.db");
  const f = new DatabaseSync(foreign);
  f.exec("CREATE TABLE foreign_data (x TEXT); INSERT INTO foreign_data VALUES ('keep')");
  f.close();
  fs.chmodSync(foreign, 0o600);
  const before = snapshot(foreign);
  assert.equal(before.mode, "delete");
  assert.throws(() => openRelayDb({ dir, file: "foreign.db", migrations: V1 }), /is not a hoptell relay database/);
  assert.deepEqual(snapshot(foreign), before);
  for (const side of ["-wal", "-shm"]) assert.equal(fs.existsSync(foreign + side), false, side);
  // A store of ours, back in rollback mode and then changed outside hoptell, or newer than this code.
  const file = path.join(dir, "relay.db");
  openRelayDb({ dir, migrations: V2 }).close();
  const other = new DatabaseSync(file);
  other.exec("PRAGMA journal_mode = DELETE");
  other.close();
  const newer = snapshot(file);
  assert.throws(() => openRelayDb({ dir, migrations: V1 }), /newer than this hoptell knows/);
  assert.deepEqual(snapshot(file), newer);
  const other2 = new DatabaseSync(file);
  other2.exec("CREATE INDEX items_body ON items (body)");
  other2.close();
  const changed = snapshot(file);
  assert.equal(changed.mode, "delete");
  assert.throws(() => openRelayDb({ dir, migrations: V2 }), /changed outside hoptell/);
  assert.deepEqual(snapshot(file), changed);
});

test("no method controls the transaction: comments, batches and every method are checked", (t) => {
  const dir = stateDir(t);
  const db = openRelayDb({ dir, migrations: V1 });
  t.after(() => db.close());
  const control = /alone begins and ends/;
  const hidden = ["COMMIT", "/* note */ COMMIT", "-- note\nCOMMIT", "  end transaction", "ROLLBACK", "SAVEPOINT s", "RELEASE s", "ROLLBACK TO s", "ATTACH ':memory:' AS x", "DETACH x", "VACUUM"];
  for (const method of ["get", "all", "run", "exec"]) {
    for (const sql of hidden) {
      assert.throws(() => db.tx((h) => {
        h.run("INSERT INTO items (id, body) VALUES ('x', 'should not stay')");
        try {
          h[method](sql);
        } catch (e) {
          assert.match(e.message, control, `${method} ${sql}`);
        }
        throw new Error("caller failure");
      }), /caller failure/);
      assert.deepEqual(rows(db), [], `${method} ${sql}`);
    }
  }
  // A batch is checked whole before any statement of it runs, even when the caller goes on.
  db.tx((h) => {
    assert.throws(() => h.exec("INSERT INTO items (id, body) VALUES ('a', 'first'); COMMIT; BEGIN IMMEDIATE; INSERT INTO items (id, body) VALUES ('b', 'x')"), control);
    assert.throws(() => h.exec("INSERT INTO items (id, body) VALUES ('a', 'first'); /* */ COMMIT"), control);
  });
  assert.deepEqual(rows(db), []);
  // get, all and run take exactly one statement; a trailing comment is not a statement.
  for (const sql of ["SELECT 1; DELETE FROM items", "SELECT 1; COMMIT", "SELECT 1;; SELECT 2", ""]) {
    assert.throws(() => db.get(sql), /one SQL statement|alone begins/, sql);
    assert.throws(() => db.tx((h) => h.run(sql)), /one SQL statement|alone begins/, sql);
  }
  assert.equal(db.get("SELECT 1 AS n; -- a note").n, 1);
  // Words inside strings, quoted names and comments are not statements.
  db.tx((h) => {
    h.run("INSERT INTO items (id, body) VALUES ('a', 'x; COMMIT; it''s fine') -- ; COMMIT");
    h.exec(`INSERT INTO items (id, body) VALUES ('b', 'COMMIT'); /* ; COMMIT; */ INSERT INTO items ("id", [body]) VALUES ('c', '--');`);
  });
  assert.deepEqual(rows(db).map((r) => r.id), ["a", "b", "c"]);
  assert.throws(() => db.get("/* x */ DELETE FROM items"), /inside tx\(\)/);
});

test("a migration of several statements, a trigger among them, applies whole", (t) => {
  const dir = stateDir(t);
  const migrations = [
    V1[0],
    `-- statements with ';' inside strings, comments and a trigger body
     CREATE TABLE log (id TEXT NOT NULL, note TEXT NOT NULL) STRICT;
     CREATE TRIGGER items_log AFTER INSERT ON items BEGIN
       INSERT INTO log (id, note) VALUES (new.id, 'added; ' || CASE WHEN new.body = '' THEN 'empty' ELSE 'body' END);
       UPDATE log SET note = note WHERE id = new.id;
     END;
     INSERT INTO items (id, body) VALUES ('seed', 'a; b');`,
  ];
  const db = openRelayDb({ dir, migrations });
  assert.equal(db.version, 2);
  put(db, "a", "");
  assert.deepEqual(db.all("SELECT id, note FROM log ORDER BY id").map((r) => ({ ...r })), [{ id: "a", note: "added; empty" }, { id: "seed", note: "added; body" }]);
  assert.deepEqual(rows(db), [{ id: "a", body: "" }, { id: "seed", body: "a; b" }]);
  db.close();
});

test("one connection per store in a process: a second open is refused until the first closes", (t) => {
  const dir = stateDir(t);
  const db = openRelayDb({ dir, migrations: V1 });
  for (const d of [dir, fs.realpathSync(dir), path.join(dir, ".", "")]) {
    assert.throws(() => openRelayDb({ dir: d, migrations: V1 }), /is already open in this process/, d);
  }
  const other = openRelayDb({ dir, file: "other.db", migrations: V1 }); // another store: allowed
  other.close();
  db.close();
  openRelayDb({ dir, migrations: V1 }).close();
  // A failed open does not hold the store.
  assert.throws(() => openRelayDb({ dir, migrations: [...V1, "NOT SQL"] }), /could not be brought/);
  openRelayDb({ dir, migrations: V1 }).close();
});

test("a refused statement never changes the connection's settings, also behind EXPLAIN", (t) => {
  const db = openRelayDb({ dir: stateDir(t), migrations: V1 });
  t.after(() => db.close());
  const settings = () => ["synchronous", "fullfsync", "foreign_keys", "trusted_schema", "journal_mode"].map((p) => Object.values(db.get(`PRAGMA ${p}`))[0]);
  const before = settings();
  const attempts = ["PRAGMA synchronous=OFF", "PRAGMA fullfsync=OFF", "PRAGMA foreign_keys=OFF", "PRAGMA trusted_schema=ON", "EXPLAIN PRAGMA synchronous=OFF", "EXPLAIN QUERY PLAN PRAGMA foreign_keys=0", "PRAGMA incremental_vacuum", "PRAGMA optimize", "/* x */ PRAGMA synchronous = 0"];
  for (const sql of attempts) {
    for (const m of ["get", "all"]) assert.throws(() => db[m](sql), /not available|inside tx\(\)/, `${m} ${sql}`);
    assert.throws(() => db.tx((h) => h.run(sql)), /not available/, `run ${sql}`);
    assert.throws(() => db.tx((h) => h.exec(sql)), /not available/, `exec ${sql}`);
    assert.deepEqual(settings(), before, sql);
  }
  assert.ok(db.all("EXPLAIN SELECT 1").length > 0, "EXPLAIN of a read still works");
});
