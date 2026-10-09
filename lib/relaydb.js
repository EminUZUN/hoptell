// The relay's durable storage (design 3.3, "Relay: durable storage"): SQLite through node:sqlite
// (DatabaseSync), WAL mode, synchronous=FULL, one transaction per change, committed before its
// answer. One store holds 3.2's tables, 3.3's and phase 6's, as versioned migrations on top of
// this layer.
//
// Opening refuses rather than repairs: a runtime without the API, a pragma that does not hold, a
// damaged file, a file that is not ours, a schema changed outside hoptell or a version newer than
// this code all stop the relay with a fixed message (never row data). An existing file is
// identified through a read-only connection before anything writes to it, so a refused file is left
// byte for byte as it was. A database is never reinitialized silently: a missing, empty or blank
// file in a directory that had one is refused too.
//
// Creation is recorded by two marker files next to the database, `.relay.db.creating` and
// `.relay.db.created`. Each step is made durable (fsync of the directory) before the next:
//   1. `.creating` is written: this process may create the store. A crash here: the next open
//      finds `.creating` without the database and creates it.
//   2. The database file is created empty (0600). A crash here or during step 3 (before its
//      commit): the next open finds `.creating` and an empty or blank file and initializes it.
//   3. One transaction sets the application id and creates schema_meta at version 0.
//   4. `.creating` is renamed to `.created`: the store is established. A crash between 3 and 4:
//      the next open finds `.creating` and a file of ours, opens it and does step 4.
// With `.created` present, a missing, empty or blank database is refused, never recreated. A file
// of ours found with neither marker (restored from a backup) is adopted and marked; an empty or
// blank one is not ours to initialize and is refused.
//
// Single writer: only the process holding the state directory's lock (lib/realm.js lockStateDir)
// opens it, with one connection: a second open of the same store in this process is refused while
// the first is open. DatabaseSync is synchronous, so a transaction blocks the event loop for its
// duration; test/bench-relaydb.mjs measures what that costs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { holdsStateDirLock } from "./realm.js";

const require = createRequire(import.meta.url);

/** PRAGMA application_id of every hoptell relay database ("hopt"). */
export const APPLICATION_ID = 0x686f7074;
const MIN_NODE = [22, 13]; // node:sqlite without a flag
const FILE_RE = /^[a-z][a-z0-9-]{0,31}\.db$/;
// Statements no caller runs, in any method: tx() alone begins and ends transactions (savepoints
// included), and the connection's databases and file stay as opened.
const CONTROL = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH", "VACUUM"]);
const WORD_RE = /[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/y;
/** The stores open in this process, by canonical path. */
const live = new Set();

/** A refusal of ours (as opposed to an SQLite error, which is reported as damage). */
const refusal = (message) => Object.assign(new Error(message), { code: "ERELAYDB" });

let sqlite = null;
/**
 * Load node:sqlite once, checking the runtime and the API. Its ExperimentalWarning, and only that
 * warning, is kept out of the relay's log: every other warning passes through unchanged.
 */
function loadSqlite() {
  if (sqlite) return sqlite;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw refusal(`the relay's storage needs Node.js ${MIN_NODE.join(".")} or later (this is ${process.version})`);
  }
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if ((warning?.name ?? type) === "ExperimentalWarning" && /\bSQLite\b/.test(String(warning?.message ?? warning))) return;
    return emit.call(this, warning, ...rest);
  };
  let mod;
  try {
    mod = require("node:sqlite");
  } catch {
    throw refusal(`node:sqlite is not available in Node.js ${process.version}; the relay's storage needs it`);
  } finally {
    process.emitWarning = emit;
  }
  const proto = mod?.DatabaseSync?.prototype;
  if (typeof mod?.DatabaseSync !== "function" || !["prepare", "exec", "close"].every((m) => typeof proto?.[m] === "function")) {
    throw refusal(`node:sqlite in Node.js ${process.version} lacks the API the relay's storage uses`);
  }
  return (sqlite = mod);
}

/** Refuse a file that is not a private regular file of ours (the same checks as realm.json). */
function checkPrivateFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw refusal(`${file} is not a regular file`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw refusal(`${file} belongs to another user`);
  if (process.platform !== "win32" && st.mode & 0o077) throw refusal(`${file} is open to other users; run: chmod 600 ${file}`);
}

/**
 * Make new directory entries durable. Windows cannot open a directory to fsync it, so there this
 * is skipped (NTFS journals its metadata); everywhere else a failure is an error, not ignored.
 */
function syncDir(dir) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Split SQL text into statements as SQLite does (its sqlite3_complete()): strings, quoted names
 * and comments are skipped, and ";" ends a statement, except inside CREATE TRIGGER, which ends at
 * "; END ;". Returns each statement's tokens: words upper-cased, a string or quoted name as "'",
 * any other character as itself. Comments and empty statements leave nothing.
 */
function sqlStatements(sql) {
  const out = [];
  let words = [];
  let trigger = false;
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? sql.length : e + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let e = i;
      do e = sql.indexOf(close, e + 1);
      while (e >= 0 && close !== "]" && sql[e + 1] === close && ++e);
      i = e < 0 ? sql.length : e + 1;
      words.push("'");
    } else if (c === ";") {
      i++;
      if (trigger && !(words.at(-1) === "END" && words.at(-2) === ";")) {
        words.push(";");
        continue;
      }
      if (words.length) out.push(words);
      words = [];
      trigger = false;
    } else {
      WORD_RE.lastIndex = i;
      const m = WORD_RE.exec(sql);
      words.push(m ? m[0].toUpperCase() : c);
      i += m ? m[0].length : 1;
      if (words[0] === "CREATE" && words.at(-1) === "TRIGGER" && (words.length === 2 || (words.length === 3 && /^TEMP(ORARY)?$/.test(words[1])))) trigger = true;
    }
  }
  if (words.length) out.push(words);
  return out;
}

// PRAGMAs a caller may run, only in their bare reading form ("PRAGMA name"). SQLite runs some
// pragmas while preparing them, so every other pragma (a setting, an argument, or one with side
// effects such as incremental_vacuum or optimize) is refused before SQLite sees it, also behind
// EXPLAIN: the connection's settings are the store's alone (configure()).
const READ_PRAGMAS = new Set(["application_id", "user_version", "schema_version", "journal_mode", "synchronous", "fullfsync", "checkpoint_fullfsync", "foreign_keys", "trusted_schema", "page_size", "page_count", "freelist_count", "auto_vacuum", "data_version", "quick_check", "integrity_check", "foreign_key_check"]);

/**
 * The kind of one statement, decided before it is prepared: whether it controls the transaction,
 * whether it is a refused pragma, and whether it only reads.
 */
function statementKind(words) {
  // EXPLAIN [QUERY PLAN] runs nothing, except that a pragma behind it still acts when prepared.
  let w = words;
  if (w[0] === "EXPLAIN") w = w[1] === "QUERY" && w[2] === "PLAN" ? w.slice(3) : w.slice(1);
  const control = CONTROL.has(w[0]);
  const pragma = w[0] === "PRAGMA";
  const allowedPragma = pragma && w.length === 2 && READ_PRAGMAS.has(String(w[1]).toLowerCase());
  const refused = pragma && !allowedPragma;
  const read = !control && !refused && (words[0] === "EXPLAIN" || w[0] === "SELECT" || allowedPragma);
  return { control, refused, read };
}

/** Set the connection's pragmas and read each one back; one that does not hold refuses. */
function configure(db, { fullfsync }) {
  const pragmas = [
    ["journal_mode", "WAL", "wal"],
    ["synchronous", "FULL", 2],
    // On macOS fsync() does not reach the disk; F_FULLFSYNC does (a no-op elsewhere).
    ["fullfsync", fullfsync ? "ON" : "OFF", fullfsync ? 1 : 0],
    ["foreign_keys", "ON", 1],
    ["trusted_schema", "OFF", 0],
  ];
  for (const [name, value, expected] of pragmas) {
    db.exec(`PRAGMA ${name} = ${value}`);
    const got = Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    if (got !== expected) throw refusal(`the relay database cannot use ${name} = ${value} (it reports ${JSON.stringify(got)}); is its folder on a local file system?`);
  }
}

/** A digest of the schema as stored, to notice a change made outside hoptell. */
const schemaDigest = (db) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_stat%' ESCAPE '\\' ORDER BY type, name").all().map((r) => [r.type, r.name, r.tbl_name, r.sql])))
    .digest("hex");

const damaged = (full, e) => refusal(`the relay database ${full} is damaged or unreadable${Number.isInteger(e?.errcode) ? ` (SQLite error ${e.errcode})` : ""}; restore it from a backup (it is never reinitialized)`);

/**
 * Identify an existing file through a read-only connection, before anything writes to it: null
 * when it is empty or blank (no application id, no schema), its schema_meta when it is a store of
 * this schema this code can open; otherwise a refusal. Reading may recreate a missing -shm index
 * (a side file); the database file itself is not written.
 */
function identify(DatabaseSync, full, { schema, migrations }) {
  let db = null;
  try {
    db = new DatabaseSync(full, { readOnly: true });
    // Damage shows here or on the first statement; the details may quote stored data, so only the
    // fixed message is reported.
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw Object.assign(new Error("quick_check"), { errcode: 11 });
    const appId = db.prepare("PRAGMA application_id").get().application_id;
    if (appId === 0 && db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n === 0) return null;
    return checkMeta(db, full, { schema, migrations });
  } catch (e) {
    if (e.code === "ERELAYDB") throw e;
    throw damaged(full, e);
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/** The schema_meta of a store of ours, of this schema, unchanged since our last step, not newer. */
function checkMeta(db, full, { schema, migrations }) {
  if (db.prepare("PRAGMA application_id").get().application_id !== APPLICATION_ID) {
    throw refusal(`${full} is not a hoptell relay database; restore the right file from a backup (it is never reinitialized)`);
  }
  let meta;
  try {
    meta = Object.fromEntries(db.prepare("SELECT key, value FROM schema_meta").all().map((r) => [r.key, r.value]));
  } catch {
    meta = null;
  }
  const unexpected = `${full} has an unexpected schema; restore it from a backup (it is never reinitialized)`;
  if (!meta || meta.schema !== schema || !Number.isSafeInteger(meta.version) || meta.version < 0 || typeof meta.digest !== "string") throw refusal(unexpected);
  if (meta.version > migrations.length) throw refusal(`${full} has schema ${schema} version ${meta.version}, newer than this hoptell knows (${migrations.length}); run the newer hoptell or restore a backup`);
  if (meta.digest !== schemaDigest(db)) throw refusal(`${unexpected}: it was changed outside hoptell`);
  return meta;
}

/**
 * Open (or create) a relay database `file` in the state directory `dir`, whose lock this process
 * must hold. `migrations[i]` brings the schema from version i to i + 1: SQL text, or a function
 * given the handle (synchronous). Each runs in its own transaction. `schema` names the migration
 * set; a file of another set is refused. `fault(point, file)` is for tests: "before-commit" and
 * "after-commit" in every transaction. `fullfsync: false` exists for the benchmark.
 *
 * Returns {path, version, tx(fn), get(sql, ...params), all(sql, ...params), run(sql, ...params),
 * exec(sql), close()}. run and exec work only inside tx(fn); outside it get and all only read.
 * get, all and run take one statement; exec takes several. None may begin, end or otherwise
 * control a transaction (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE), nor ATTACH, DETACH
 * or VACUUM: every statement is checked before any of them runs, comments notwithstanding.
 */
export function openRelayDb({ dir, file = "relay.db", schema = file.replace(/\.db$/, ""), migrations = [], fault = null, fullfsync = true }) {
  const { DatabaseSync } = loadSqlite();
  if (!FILE_RE.test(file)) throw new Error(`invalid relay database file name ${file}`);
  if (!Array.isArray(migrations) || !migrations.every((m) => typeof m === "string" || (typeof m === "function" && !/^Async/.test(m.constructor?.name)))) {
    throw new Error("migrations must be SQL text or synchronous functions");
  }
  if (!holdsStateDirLock(dir)) throw refusal(`the relay database in ${dir} is opened only by the relay holding the state directory's lock`);
  const full = path.join(dir, file);
  const key = path.join(fs.realpathSync(dir), file);
  if (live.has(key)) throw refusal(`the relay database ${full} is already open in this process; the relay uses one connection`);
  live.add(key);
  try {
    return open(DatabaseSync, { dir, file, full, key, schema, migrations, fault, fullfsync });
  } catch (e) {
    live.delete(key);
    throw e;
  }
}

function open(DatabaseSync, { dir, file, full, key, schema, migrations, fault, fullfsync }) {
  const created = path.join(dir, `.${file}.created`);
  const creating = path.join(dir, `.${file}.creating`);
  const established = fs.existsSync(created);
  let creation = !established && fs.existsSync(creating);

  // A missing file is created only where there never was one, private before SQLite writes to it
  // (SQLite gives its -wal and -shm files the database file's mode).
  if (!fs.existsSync(full) && !isLink(full)) {
    if (established) throw refusal(`${full} is missing from an established state directory; restore it from a backup, or remove ${created} to start with an empty database`);
    for (const side of ["-wal", "-shm"]) if (fs.existsSync(full + side)) throw refusal(`${full}${side} exists without ${full}; restore the database from a backup`);
    if (!creation) {
      fs.writeFileSync(creating, "", { mode: 0o600, flag: "wx" });
      syncDir(dir);
      creation = true;
    }
    fs.closeSync(fs.openSync(full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
    syncDir(dir);
  }
  for (const f of [full, `${full}-wal`, `${full}-shm`]) if (f === full || fs.existsSync(f)) checkPrivateFile(f);

  // Nothing writes to the file until it is known to be ours, or empty and ours to initialize.
  const blank = identify(DatabaseSync, full, { schema, migrations }) === null;
  if (blank && established) throw refusal(`${full} is empty in an established state directory; restore it from a backup, or remove it and ${created} to start with an empty database (it is never reinitialized)`);
  if (blank && !creation) throw refusal(`${full} is empty and was not created by this hoptell; remove it to start with an empty database, or restore it from a backup`);
  /** Record the store as established (step 4 above); also for an adopted or resumed one. */
  const establish = () => {
    if (fs.existsSync(created)) {
      if (!fs.existsSync(creating)) return;
      fs.rmSync(creating);
    } else if (fs.existsSync(creating)) fs.renameSync(creating, created);
    else fs.writeFileSync(created, "", { mode: 0o600, flag: "wx" });
    syncDir(dir);
  };

  let db = null;
  try {
    db = new DatabaseSync(full);
    configure(db, { fullfsync });
  } catch (e) {
    try {
      db?.close();
    } catch {}
    if (e.code === "ERELAYDB") throw e;
    throw damaged(full, e);
  }

  const stmts = new Map();
  /** A prepared statement of `sql`, which must be one statement, and its kind. */
  const stmt = (sql) => {
    let s = stmts.get(sql);
    if (s) return s;
    if (typeof sql !== "string") throw new TypeError("SQL text expected");
    const list = sqlStatements(sql);
    if (list.length !== 1) throw new Error("get, all and run take one SQL statement");
    const kind = statementKind(list[0]);
    if (kind.control) throw new Error("tx() alone begins and ends transactions");
    if (kind.refused) throw new Error("this PRAGMA is not available: the store's connection settings are its own");
    // Outside tx() only reads are prepared at all (preparing can already act).
    if (!inTx && !kind.read) throw new Error("relay database changes run inside tx()");
    const prepared = db.prepare(sql);
    // SQLite's own view: nothing but comments may follow the statement it prepared.
    if (typeof prepared.sourceSQL !== "string" || !sql.startsWith(prepared.sourceSQL) || sqlStatements(sql.slice(prepared.sourceSQL.length)).length) {
      throw new Error("get, all and run take one SQL statement");
    }
    stmts.set(sql, (s = { prepared, ...kind }));
    return s;
  };
  let inTx = false;
  let closed = false;
  const change = () => {
    if (closed) throw new Error("the relay database is closed");
    if (!inTx) throw new Error("relay database changes run inside tx()");
  };
  const read = (sql) => {
    if (closed) throw new Error("the relay database is closed");
    const s = stmt(sql);
    if (!inTx && !s.read) throw new Error("relay database changes run inside tx()");
    return s.prepared;
  };
  /** Run SQL text of any number of statements, each checked before any of them runs. */
  const execAll = (sql) => {
    if (typeof sql !== "string") throw new TypeError("SQL text expected");
    if (sqlStatements(sql).some((words) => statementKind(words).control)) throw new Error("tx() alone begins and ends transactions");
    if (sqlStatements(sql).some((words) => statementKind(words).refused)) throw new Error("this PRAGMA is not available: the store's connection settings are its own");
    // SQLite splits the text; each statement it is about to run is checked again on its own text.
    let rest = sql;
    for (;;) {
      const at = sqlStart(rest);
      if (at < 0) return;
      const s = db.prepare(rest.slice(at));
      const one = s.sourceSQL;
      const words = typeof one === "string" && rest.startsWith(one, at) ? sqlStatements(one) : [];
      if (words.length !== 1 || statementKind(words[0]).control) throw new Error("tx() alone begins and ends transactions");
      if (statementKind(words[0]).refused) throw new Error("this PRAGMA is not available: the store's connection settings are its own");
      s.all();
      rest = rest.slice(at + one.length);
    }
  };

  const handle = {
    path: full,
    version: 0,
    get: (sql, ...params) => read(sql).get(...params),
    all: (sql, ...params) => read(sql).all(...params),
    run: (sql, ...params) => (change(), stmt(sql).prepared.run(...params)),
    exec: (sql) => (change(), execAll(sql)),
    /**
     * Run fn(handle) as one transaction: BEGIN IMMEDIATE, then COMMIT, or ROLLBACK when it throws.
     * fn is synchronous (a promise would let its later statements escape the transaction) and
     * transactions do not nest. Returns fn's result once committed.
     */
    tx(fn) {
      if (closed) throw new Error("the relay database is closed");
      if (typeof fn !== "function") throw new TypeError("tx() takes a function");
      if (/^Async(Generator)?Function$/.test(fn.constructor?.name)) throw new TypeError("tx() takes a synchronous function");
      if (inTx) throw new Error("relay database transactions do not nest");
      inTx = true;
      try {
        db.exec("BEGIN IMMEDIATE");
        let result;
        try {
          result = fn(handle);
          if (typeof result?.then === "function") {
            result.then(undefined, () => {}); // refused below; not an unhandled rejection too
            throw new TypeError("tx() takes a synchronous function (it returned a promise)");
          }
          if (db.isTransaction === false) throw new Error("the transaction ended inside tx()");
          fault?.("before-commit", full);
          db.exec("COMMIT");
        } catch (e) {
          try {
            db.exec("ROLLBACK"); // also after a failed COMMIT; fails harmlessly when none is open
          } catch {}
          throw e;
        }
        fault?.("after-commit", full);
        return result;
      } finally {
        inTx = false;
      }
    },
    close() {
      if (closed) return;
      if (inTx) throw new Error("the relay database cannot close inside tx()");
      closed = true;
      stmts.clear();
      live.delete(key);
      db.close();
    },
  };

  try {
    migrate(db, handle, { full, schema, migrations, blank, establish });
    establish();
  } catch (e) {
    handle.close();
    // An SQLite error is reported by its code only; an error of a migration's own code as is.
    if (e.code === "ERELAYDB" || !Number.isInteger(e.errcode)) throw e;
    throw refusal(`the relay database ${full} could not be brought to schema ${schema} version ${migrations.length} (SQLite error ${e.errcode}); it is unchanged from the last completed step`);
  }
  stmts.clear(); // prepared before the migrations changed the schema
  return handle;
}

/** Where the first statement of `sql` starts (after whitespace, comments and empty ";"), or -1. */
function sqlStart(sql) {
  for (let i = 0; i < sql.length; ) {
    if (/[\s;]/.test(sql[i])) i++;
    else if (sql.startsWith("--", i)) {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? sql.length : e + 1;
    } else if (sql.startsWith("/*", i)) {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else return i;
  }
  return -1;
}

/**
 * Initialize a blank file being created (step 3 in the header), then bring the schema up to date
 * one version per transaction. The file was identified read-only already; it is checked again on
 * this connection.
 */
function migrate(db, handle, { full, schema, migrations, blank, establish }) {
  if (blank) {
    handle.tx((h) => {
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`); // the store's own setting, not a caller's
      h.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value ANY NOT NULL) STRICT");
      h.run("INSERT INTO schema_meta (key, value) VALUES ('schema', ?), ('version', 0), ('digest', ?)", schema, schemaDigest(db));
    });
    establish();
  }
  const meta = checkMeta(db, full, { schema, migrations });
  for (let v = meta.version; v < migrations.length; v++) {
    handle.tx((h) => {
      const m = migrations[v];
      if (typeof m === "string") h.exec(m);
      else if (typeof m(h)?.then === "function") throw new TypeError(`migration ${v + 1} is not synchronous`);
      h.run("UPDATE schema_meta SET value = ? WHERE key = 'version'", v + 1);
      h.run("UPDATE schema_meta SET value = ? WHERE key = 'digest'", schemaDigest(db));
    });
  }
  handle.version = migrations.length;
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
