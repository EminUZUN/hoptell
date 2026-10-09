// Backups of the relay's state (design 4.4, "Backups"): the store copied with SQLite's online backup
// API while the relay runs (or by the CLI while it is stopped), the access files, and reference
// copies of the members, policy and OIDC files, with a manifest of digests written last.
//
// The step time is an observed budget, not a deadline: backup() bounds the pages per step and has
// no time limit inside a step; its progress callback runs only after a step. Each step's duration
// is measured (the time between callbacks, so it includes this process's own work in between:
// an over-estimate) and the largest is reported; a step over 1 s gives a warning, and the owner
// lowers the step size with --pages (at least 16).
//
// Not included: the broker's refresh key and families (a restored family could accept a refresh
// token already rotated). Not consistent across files: each file is copied on its own.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACCESS_FILES } from "./access.js";
import { APPLICATION_ID, sqliteApi } from "./relaydb.js";
import { RELAY_MIGRATIONS } from "./relaystore.js";

export const DEFAULT_PAGES = 100;
export const MIN_PAGES = 16;
export const STEP_BUDGET_MS = 1000;
const ID_RE = /^[0-9a-f]{32}$/;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export const fileDigest = (file) => sha256(fs.readFileSync(file));

function syncDir(dir) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write `data` to `file` through a temporary name: written, synced, renamed, folder synced. */
function writeSynced(file, data, fault) {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fault?.("write", file);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}

/**
 * Check a store file read-only: `application_id`, a schema this code knows (relay, at most the
 * newest version), and `PRAGMA integrity_check`. Returns {version, instance, restoreId,
 * lastAuditSeq}; a file in rollback-journal mode is read without creating side files. Throws a
 * fixed message (never row data).
 */
export function checkStoreFile(file) {
  const { DatabaseSync } = sqliteApi();
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const check = db.prepare("PRAGMA integrity_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error("integrity");
    if (db.prepare("PRAGMA application_id").get().application_id !== APPLICATION_ID) throw new Error("application");
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM schema_meta").all().map((r) => [r.key, r.value]));
    if (meta.schema !== "relay" || !Number.isSafeInteger(meta.version) || meta.version < 1) throw new Error("schema");
    if (meta.version > RELAY_MIGRATIONS.length) return { version: meta.version, newer: true };
    const has = (t) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    const metaOf = (k) => (has("store_meta") ? (db.prepare("SELECT value FROM store_meta WHERE key = ?").get(k)?.value ?? null) : null);
    const lastAuditSeq = has("admin_audit") ? Number(db.prepare("SELECT max(seq) AS s FROM admin_audit").get().s ?? 0) : 0;
    return { version: meta.version, newer: false, instance: metaOf("instance"), restoreId: metaOf("restore_id"), lastAuditSeq };
  } catch (e) {
    throw Object.assign(new Error(`${file} is not a sound copy of a hoptell relay store (${["integrity", "application", "schema"].includes(e.message) ? e.message : "unreadable"} check failed)`), { code: "bad_copy" });
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Back up the store `db` (an open relay store, read through its own connection) and the state of
 * `stateDir` into `dest`, a new folder (created 0700; it must not exist). `pages` per step (at
 * least 16). The copy is verified before success: opened read-only, its application id, schema
 * and integrity_check, and every digest recomputed. On any failure the partial folder is removed
 * and the error thrown. Returns {dir, manifest, pages, steps, maxStepMs, warning, bytes}.
 */
export async function backupRelay({ db, stateDir, dest, pages = DEFAULT_PAGES, realm, config = {}, fault = null, now = () => Date.now() }) {
  if (!Number.isSafeInteger(pages) || pages < MIN_PAGES) throw Object.assign(new Error(`--pages must be a whole number of at least ${MIN_PAGES}`), { code: "bad_request" });
  if (typeof dest !== "string" || !path.isAbsolute(dest)) throw Object.assign(new Error("the backup folder must be an absolute path"), { code: "bad_request" });
  if (!ID_RE.test(realm ?? "")) throw new Error("the relay's realm id is unknown");
  try {
    fs.mkdirSync(dest, { mode: 0o700 });
  } catch (e) {
    throw Object.assign(new Error(e.code === "EEXIST" ? `${dest} exists; a backup goes into a new folder` : `${dest} cannot be created (${e.code ?? "error"})`), { code: e.code === "EEXIST" ? "exists" : "bad_request" });
  }
  try {
    fs.chmodSync(dest, 0o700);
    syncDir(path.dirname(dest)); // the new folder's entry, durable before anything is reported
    const files = {};
    // The store: one file, in rollback-journal mode (no -wal or -shm), private.
    const tmp = path.join(dest, ".relay.db.tmp");
    fs.closeSync(fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
    const steps = [];
    let last = Date.now();
    await db.backup(tmp, {
      rate: pages,
      progress: () => {
        fault?.("step", tmp); // tests: a slow destination (counted in the step that just ended)
        const t = Date.now();
        steps.push(t - last);
        last = t;
      },
    });
    steps.push(Date.now() - last); // the last step ends with the call
    fault?.("after-copy", tmp);
    {
      const { DatabaseSync } = sqliteApi();
      const c = new DatabaseSync(tmp);
      try {
        c.exec("PRAGMA journal_mode = DELETE");
      } finally {
        c.close();
      }
    }
    for (const side of ["-wal", "-shm", "-journal"]) fs.rmSync(tmp + side, { force: true });
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const dbFile = path.join(dest, "relay.db");
    fs.renameSync(tmp, dbFile);
    syncDir(dest);
    const store = checkStoreFile(dbFile);
    if (store.newer) throw new Error("the copy has a newer schema than this hoptell");
    files["relay.db"] = fileDigest(dbFile);
    // The access files, as they are now (each on its own).
    fs.mkdirSync(path.join(dest, "access"), { mode: 0o700 });
    for (const name of [...Object.values(ACCESS_FILES), "restore.json"]) {
      let data;
      try {
        data = fs.readFileSync(path.join(stateDir, "access", name));
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      writeSynced(path.join(dest, "access", name), data, fault);
      files[`access/${name}`] = sha256(data);
    }
    // Reference copies of the configuration files (the members file holds token digests).
    fs.mkdirSync(path.join(dest, "config"), { mode: 0o700 });
    const paths = {};
    for (const [kind, file] of Object.entries({ members: config.members ?? null, policy: config.policy ?? null, oidc: config.oidc ?? null })) {
      paths[kind] = file ? path.resolve(file) : null;
      if (!file) continue;
      const data = fs.readFileSync(file);
      writeSynced(path.join(dest, "config", `${kind}.json`), data, fault);
      files[`config/${kind}.json`] = sha256(data);
    }
    const manifest = { v: 1, realm, instance: store.instance, schema: { name: "relay", version: store.version }, created: now(), lastAuditSeq: store.lastAuditSeq, config: paths, files };
    fault?.("before-manifest", dest);
    writeSynced(path.join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, fault);
    // Verification: the manifest as written, and every digest recomputed.
    readBackup(dest);
    const maxStepMs = Math.max(0, ...steps);
    return { dir: dest, manifest, pages, steps: steps.length, maxStepMs, warning: maxStepMs > STEP_BUDGET_MS, bytes: fs.statSync(dbFile).size };
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Read and verify a backup folder: the manifest's shape, every listed digest, and the store copy
 * (application id, schema, integrity_check). Returns {manifest, manifestSha256, store}. Throws
 * with a fixed message on anything unexpected.
 */
export function readBackup(dir) {
  const fail = (why) => Object.assign(new Error(`${dir} is not a usable hoptell relay backup: ${why}`), { code: "bad_backup" });
  let text;
  try {
    text = fs.readFileSync(path.join(dir, "manifest.json"));
  } catch {
    throw fail("no manifest.json");
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw fail("the manifest is not JSON");
  }
  if (m?.v !== 1 || !ID_RE.test(m.realm ?? "") || m.schema?.name !== "relay" || !Number.isSafeInteger(m.schema?.version) || !m.files || typeof m.files !== "object" || typeof m.files["relay.db"] !== "string") throw fail("the manifest has an unknown shape");
  for (const [name, digest] of Object.entries(m.files)) {
    if (!/^(relay\.db|access\/[a-z]+\.json|config\/(members|policy|oidc)\.json)$/.test(name) || !/^[0-9a-f]{64}$/.test(digest)) throw fail("the manifest lists an unexpected file");
    let got;
    try {
      got = fileDigest(path.join(dir, name));
    } catch {
      throw fail(`${name} is missing`);
    }
    if (got !== digest) throw fail(`${name} does not match its digest`);
  }
  for (const side of ["-wal", "-shm"]) if (fs.existsSync(path.join(dir, `relay.db${side}`))) throw fail(`relay.db${side} is present (a backup is one file)`);
  const store = checkStoreFile(path.join(dir, "relay.db"));
  if (store.version !== m.schema.version) throw fail("the store's schema version differs from the manifest's");
  return { manifest: m, manifestSha256: sha256(text), store };
}
