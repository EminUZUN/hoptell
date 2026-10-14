// Offline restore of the relay's state (design 4.4, "Restore"). Restoring rolls the store back in
// time while clients and peers have seen later state, so it is a resumable procedure with a durable
// intent that fences the state directory until it completes, never a file copy.
//
// `<state dir>/restore/intent.json` = {v, id, backup: {path, manifest, realm, db}, started, phase,
// abort_from?, old: {db, access, empty, marker}, counts}: `phase` is the last completed phase
// ("intent", "evidence", "installed", "reconciled", "access", "broker") or "aborting"; `abort_from`
// (with "aborting" only) the phase recorded when the abort began, never changed afterwards. While
// it exists the relay refuses to start, openRelayDb refuses every opener but this procedure, and
// the offline admin commands are refused except `restore --resume`, `--abort` and `status`.
//
// Phases: 0 check (no change), 1 intent (and, into an empty state directory, the realm), 2 evidence
// (the current store set moved into restore/<id>/before/, the access files copied there), 3 install
// (the backup's store copied in under a temporary name, renamed into place), 4 reconcile the store
// (bounded steps, each one admitted transaction recording its progress: a new instance id,
// revocations merged, devices suspended when the old store is unreadable, KeyPackages cleared, the
// old store's later audit rows copied, restore_id set last), 5
// access state (kept when readable; else rebuilt restrictively with every member pending), 6 broker
// reset, 7 the result row, then the intent is removed. Every phase checks its own result on disk,
// so a rerun after a crash at any point finds it done or does it again with the same effect; the
// evidence is named by the restore id and never overwritten.
//
// Authorization is never rolled back: a grant, revocation or sign-out current before the restore
// stays in force after it, or the affected traffic is held until it is re-established. The members,
// policy and OIDC files are never written.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACCESS_FILES, MANIFEST_FILE, accessDocOk, accessStateReadable, restoreDocOk, writeAccessManifest } from "./access.js";
import { fileDigest, readBackup } from "./backup.js";
import { brokerReset } from "./broker.js";
import { removeDurable, writeDurable } from "./credentials.js";
import { readMembersDoc } from "./members.js";
import { APPLICATION_ID, sqliteApi } from "./relaydb.js";
import { REALM_ID_RE, fencedMessage, loadRealm, lockStateDir, readRestoreIntent } from "./realm.js";
import { GENESIS, appendAudit, newInstanceId, openRelayStore, setStoreMeta, storeMeta } from "./relaystore.js";
import { terminateTransfer } from "./mls/relaytransfers.js";

const SET = ["relay.db", "relay.db-wal", "relay.db-shm"];
const ORDER = ["intent", "evidence", "installed", "reconciled", "access", "broker"];
const at = (phase) => ORDER.indexOf(phase);

/** A restore that stops with the state it found: the intent stays; the owner looks, then resumes. */
export class RestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const stop = (code, message) => {
  throw new RestoreError(code, message);
};

function syncDir(dir) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const exists = (f) => {
  try {
    fs.lstatSync(f);
    return true;
  } catch {
    return false;
  }
};

/** Copy `from` to `to` (a new name) durably: a temporary file, synced, renamed, the folder synced. */
function copySynced(from, to, fault = null, point = null) {
  const tmp = `${to}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, fs.readFileSync(from));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, to);
  if (point) fault?.(point);
  syncDir(path.dirname(to));
}

/**
 * Open a copy of a store set (relay.db and its -wal and -shm, as found in `dir`) in a private
 * temporary folder, run fn(db) on it, and remove the copy: the set itself is never opened (an open
 * could checkpoint or create side files in the evidence). Returns fn's result, or null when the
 * set is missing or not a readable hoptell relay store.
 */
function withStoreCopy(dir, fn) {
  if (!exists(path.join(dir, "relay.db"))) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-restore-"));
  const { DatabaseSync } = sqliteApi();
  let db = null;
  try {
    for (const f of SET) if (exists(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
    db = new DatabaseSync(path.join(tmp, "relay.db"));
    const check = db.prepare("PRAGMA integrity_check").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") return null;
    if (db.prepare("PRAGMA application_id").get().application_id !== APPLICATION_ID) return null;
    if (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema'").get()?.value !== "relay") return null;
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const hasTable = (db, t) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

/**
 * What a readable old store holds for the reconcile: revocations, its instance id, its audit rows
 * after `afterSeq`, and (3.3) its queued encrypted deliveries and its recorded operations. Lists
 * the reconcile copies in slices come in a fixed order, so a resumed reconcile continues each at
 * its recorded place (the evidence it is read from never changes).
 */
function readOldStore(dir, afterSeq) {
  return withStoreCopy(dir, (db) => ({
    // Suspensions are restrictive state like revocations: a device suspended now (an earlier
    // restore lost the record of its revocation, and nobody has reinstated it) stays suspended.
    suspended: hasTable(db, "devices") && db.prepare("SELECT 1 AS x FROM pragma_table_info('devices') WHERE name = 'suspended'").get() ? db.prepare("SELECT member_id, device_id FROM devices WHERE suspended = 1 ORDER BY member_id, device_id").all().map((r) => ({ ...r })) : [],
    deliveries: hasTable(db, "e2ee_queue") ? db.prepare("SELECT delivery FROM e2ee_queue").all().map((r) => r.delivery) : [],
    ops: hasTable(db, "e2ee_ops") ? db.prepare("SELECT requester_member, requester_device, op, kind, digest, result, created FROM e2ee_ops ORDER BY requester_member, requester_device, op").all().map((r) => ({ ...r })) : [],
    revocations: hasTable(db, "device_revocations") ? db.prepare("SELECT member_id, device_id, at, by_kind, by_device, statement FROM device_revocations ORDER BY member_id, device_id").all().map((r) => ({ ...r })) : [],
    instance: hasTable(db, "store_meta") ? (db.prepare("SELECT value FROM store_meta WHERE key = 'instance'").get()?.value ?? null) : null,
    // Transfers (design 6): their keys and states, so a transfer that ended after the backup point
    // is not served again by the restored store.
    transfers: hasTable(db, "transfers") ? db.prepare("SELECT uploader_device, transfer_id, state FROM transfers").all().map((r) => ({ ...r })) : [],
    audit: hasTable(db, "admin_audit") ? db.prepare("SELECT * FROM admin_audit WHERE seq > ? ORDER BY seq").all(afterSeq).map((r) => ({ ...r })) : [],
  }));
}

/**
 * Restore, resume or abort, offline: `mode` "start" (with `backupDir`), "resume" or "abort". The
 * caller has stopped the relay; this takes the state directory's lock. `membersFile` lists the
 * current members (pending when the access state was lost). `fault(point)` is for tests: it may
 * throw (a crash) at the points named in this file. Returns {id, done, counts} or {aborted}.
 */
export async function runRestore({ stateDir, mode, backupDir = null, membersFile = null, fault = null, now = () => Date.now(), log = () => {} }) {
  let release;
  try {
    release = lockStateDir(stateDir);
  } catch (e) {
    throw new RestoreError("running", `${e.message}: restore runs only while the relay is stopped`);
  }
  try {
    if (mode === "start") return await start({ stateDir, backupDir, membersFile, fault, now, log });
    const intent = readRestoreIntent(stateDir);
    if (!intent) stop("no_restore", "there is no unfinished restore");
    if (mode === "abort") return abort(stateDir, intent, fault);
    if (mode === "resume") return intent.phase === "aborting" ? continueAbort(stateDir, intent, fault) : await proceed({ stateDir, intent, membersFile, fault, now, log });
    throw new Error(`unknown restore mode ${mode}`);
  } finally {
    release();
  }
}

const intentFile = (stateDir) => path.join(stateDir, "restore", "intent.json");
/** Write the intent durably (one write, the whole document). */
function writeIntent(stateDir, intent) {
  writeDurable(intentFile(stateDir), `${JSON.stringify(intent)}\n`);
}

// ---- phase 0 and 1 ---------------------------------------------------------------------------------

async function start({ stateDir, backupDir, membersFile, fault, now, log }) {
  const fence = readRestoreIntent(stateDir);
  if (fence) stop("fenced", fencedMessage(fence));
  // Phase 0: check, no changes.
  if (typeof backupDir !== "string") stop("bad_request", "name the backup folder");
  const dir = path.resolve(backupDir);
  const b = readBackup(dir);
  if (b.store.newer) stop("newer", `the backup's store has schema version ${b.store.version}, newer than this hoptell knows; restore it with the newer hoptell`);
  const realmFile = path.join(stateDir, "realm.json");
  let current = null;
  if (exists(realmFile)) {
    try {
      current = JSON.parse(fs.readFileSync(realmFile, "utf8")).id;
    } catch {
      current = null;
    }
    if (!REALM_ID_RE.test(current ?? "")) stop("realm", `${realmFile} cannot be read; fix it before a restore`);
    if (current !== b.manifest.realm) stop("realm", `the backup belongs to realm ${b.manifest.realm}, this state directory to ${current}: a backup of another realm is never restored here`);
  } else if (exists(path.join(stateDir, ".created"))) stop("realm", `${realmFile} is missing from an established state directory; restore it first`);
  const empty = current === null;
  const dbReadable = Boolean(withStoreCopy(stateDir, () => true));
  // The access state is readable when the relay would load it as it is, and no file the backup
  // has is missing (the relay never removes one it wrote: a missing one was lost).
  let accessReadable = accessStateReadable(stateDir);
  for (const name of Object.values(ACCESS_FILES)) if (b.manifest.files[`access/${name}`] && !exists(path.join(stateDir, "access", name))) accessReadable = false;
  // Lost access state holds every current member: they are taken from the members file now and
  // kept in the intent, so a resume without the file still holds them.
  let members = [];
  if (!accessReadable) {
    if (!membersFile) stop("members", "the access state is lost, so every current member is held until it publishes again: name the relay's members file (--members or HOPTELL_MEMBERS; for a relay without one, an empty {\"members\": []} file)");
    try {
      // Strict on purpose: restore runs only offline (hoptell relay admin restore, with the relay
      // stopped) against the members file the operator names, never systemd's credential copy.
      members = readMembersDoc(membersFile).members.map((m) => m.id ?? `name:${m.name}`);
    } catch (e) {
      stop("members", `the members file cannot be read (${e.message}); every current member must be held`);
    }
  }
  // Phase 1: the intent. From here on the directory is fenced.
  const id = crypto.randomBytes(8).toString("hex");
  const intent = {
    v: 1,
    id,
    backup: { path: dir, manifest: b.manifestSha256, realm: b.manifest.realm, db: b.manifest.files["relay.db"] },
    started: now(),
    phase: "intent",
    old: { db: dbReadable, present: exists(path.join(stateDir, "relay.db")), access: accessReadable, empty, marker: exists(path.join(stateDir, ".relay.db.created")) },
    members,
    counts: {},
  };
  fs.mkdirSync(path.join(stateDir, "restore"), { recursive: true, mode: 0o700 });
  syncDir(stateDir);
  writeIntent(stateDir, intent);
  fault?.("intent-written");
  log(`restore ${id}: started from ${dir}; the state directory is fenced until it completes`);
  return proceed({ stateDir, intent, membersFile, fault, now, log });
}

/** The rest of phase 1: an empty directory gets the backup's realm, and the store's creation marker. */
function establish(stateDir, intent, fault) {
  if (intent.old.empty) loadRealm(stateDir, intent.backup.realm); // exclusive create, or the same id found
  const marker = path.join(stateDir, ".relay.db.created");
  if (!exists(marker)) {
    fs.writeFileSync(marker, "", { mode: 0o600, flag: "wx" });
    syncDir(stateDir);
  }
  fault?.("established");
}

// ---- the phases, in resume order ---------------------------------------------------------------------

async function proceed({ stateDir, intent, membersFile, fault, now, log }) {
  const backup = () => {
    const b = readBackup(intent.backup.path);
    if (b.manifestSha256 !== intent.backup.manifest) stop("backup_changed", `the backup in ${intent.backup.path} changed since the restore began; put it back as it was`);
    return b;
  };
  const setPhase = (phase, extra = {}) => {
    intent = { ...intent, ...extra, phase };
    writeIntent(stateDir, intent);
    fault?.(`after:${phase}`);
  };
  if (at(intent.phase) < 0) stop("bad_intent", `the restore intent has an unknown phase "${intent.phase}"`);
  // Phase installed or later: phase 3 is done and never runs again (its checks no longer hold).
  if (at(intent.phase) <= at("intent")) {
    establish(stateDir, intent, fault);
    evidence(stateDir, intent, fault);
    setPhase("evidence");
  }
  if (at(intent.phase) <= at("evidence")) {
    install(stateDir, intent, fault);
    setPhase("installed");
  }
  if (at(intent.phase) < at("reconciled")) {
    reconcile(stateDir, intent, backup, fault);
    setPhase("reconciled");
  }
  if (at(intent.phase) < at("access")) {
    const counts = accessState(stateDir, intent, backup, membersFile, fault);
    setPhase("access", { counts: { ...intent.counts, ...counts } });
  }
  if (at(intent.phase) < at("broker")) {
    const ended = brokerReset(stateDir, { now });
    fault?.("broker-reset");
    setPhase("broker", { counts: { ...intent.counts, broker_families: intent.counts.broker_families ?? ended } });
  }
  // Phase 7: the result row (once), then the fence ends.
  const db = openRelayStore({ dir: stateDir, restoreId: intent.id });
  let counts;
  try {
    counts = { ...JSON.parse(storeMeta(db, "restore_counts") ?? "{}"), ...intent.counts };
    if (!db.get("SELECT 1 AS x FROM admin_audit WHERE ref = ?", `restore:${intent.id}`)) {
      db.tx((h) => appendAudit(h, { time: now(), actor: "offline-cli", action: "store.restore", target: intent.id, state: "result", result: "ok", detail: counts, ref: `restore:${intent.id}` }), { cls: "maintenance" });
    }
    fault?.("result-written");
  } finally {
    db.close();
  }
  removeDurable(intentFile(stateDir));
  fault?.("intent-removed");
  log(`restore ${intent.id}: complete`);
  return { id: intent.id, done: true, counts };
}

/** Phase 2: move the store set into before/ (each member once), copy the access files there. */
function evidence(stateDir, intent, fault) {
  const before = path.join(stateDir, "restore", intent.id, "before");
  // Each new folder's entry is made durable in its parent, in order, before anything is moved into
  // it (a rerun syncs them again: a crash may have come between a mkdir and its sync).
  for (const d of [path.join(stateDir, "restore", intent.id), before, path.join(before, "access")]) {
    if (!exists(d)) fs.mkdirSync(d, { mode: 0o700 });
    syncDir(path.dirname(d));
  }
  for (const f of SET) {
    const here = path.join(stateDir, f);
    const there = path.join(before, f);
    if (exists(here) && exists(there)) stop("both_places", `${f} is both in the state directory and in ${before}: nothing was overwritten; look at both and keep the right one`);
    if (!exists(here)) continue;
    fs.renameSync(here, there);
    fault?.(`evidence-rename:${f}`);
    syncDir(before);
    syncDir(stateDir);
  }
  for (const name of [...Object.values(ACCESS_FILES), "restore.json", MANIFEST_FILE]) {
    const from = path.join(stateDir, "access", name);
    const to = path.join(before, "access", name);
    if (exists(from) && !exists(to)) copySynced(from, to);
  }
  fault?.("evidence-copied");
}

/** Phase 3: the backup's store into place, through a temporary name; never over an existing relay.db. */
function install(stateDir, intent, fault) {
  const target = path.join(stateDir, "relay.db");
  const tmp = path.join(stateDir, `relay.db.restore-${intent.id}.tmp`);
  const sides = ["-wal", "-shm"].filter((s) => exists(target + s));
  if (sides.length) stop("unexpected_files", `relay.db${sides[0]} is present before the installation; the restore stops with the state found`);
  if (exists(target)) {
    // Only this phase's own rename, before the phase was recorded: the backup's bytes.
    if (fileDigest(target) !== intent.backup.db) stop("unexpected_files", `${target} is present and is not the backup's copy; the restore stops with the state found`);
    fs.rmSync(tmp, { force: true });
    return;
  }
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, fs.readFileSync(path.join(intent.backup.path, "relay.db")));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fileDigest(tmp) !== intent.backup.db) stop("backup_changed", "the backup's store does not match its manifest");
  fault?.("install-copied");
  fs.renameSync(tmp, target);
  fault?.("install-rename");
  syncDir(stateDir);
  if (["-wal", "-shm"].some((s) => exists(target + s)) || fileDigest(target) !== intent.backup.db) stop("unexpected_files", "the installed store is not the backup's copy; the restore stops with the state found");
}

/** Rows per reconcile step (each step one admitted maintenance transaction, as the store's sweeps). */
export const RECONCILE_BATCH = 256;
const RECONCILE_TRANSFERS = 16; // transfers ended per step (a termination deletes up to 64 relations)

/**
 * Phase 4 on the installed store opened with the restore's id, as a sequence of bounded steps: each
 * one admitted maintenance transaction (design 6: every write transaction stays under the store's
 * allowance A, so the WAL bound holds offline too) that also records the progress
 * (store_meta.restore_progress: this restore's id, the steps done, each one's cursor, the counts so
 * far). A crash at any step boundary resumes after the last committed step with nothing done
 * twice. The last step writes the counts and store_meta.restore_id; phase 4 is done when
 * restore_id is this restore's id (absent, or another id carried by the backup from an earlier
 * restore, means it has not finished). Returns whether it ran now.
 *
 * Steps, in order: a new instance id; the old store's revocations merged (monotonic); its
 * suspensions kept; with no readable old store every device suspended; KeyPackages and
 * reservations cleared; conversations marked replace_required (3.3); the queue's loss counted; the
 * old store's operations merged; transfers ended (design 6); the old store's audit rows after the
 * backup point; the result.
 */
function reconcile(stateDir, intent, backup, fault) {
  let armed = null;
  const db = openRelayStore({ dir: stateDir, restoreId: intent.id, fault: (p) => armed && fault?.(`${armed}-${p}`) });
  try {
    if (storeMeta(db, "restore_id") === intent.id) return false;
    const b = backup();
    const before = path.join(stateDir, "restore", intent.id, "before");
    const old = intent.old.db ? readOldStore(before, b.manifest.lastAuditSeq ?? 0) : null;
    let p = null;
    try {
      p = JSON.parse(storeMeta(db, "restore_progress") ?? "null");
    } catch {}
    if (p?.id !== intent.id) p = null; // another restore's progress, carried by the backup
    // A store that was readable at the check and is not now: treated as unreadable (fail closed).
    // Once unreadable, never readable again for this restore; the steps whose effect depends on it
    // (suspending every device, ending every transfer) run (again) as for an unreadable store.
    let readable = Boolean(old) && p?.readable !== false;
    if (p && p.readable && !readable) {
      p.readable = false;
      p.done = p.done.filter((x) => x !== "suspend_all" && x !== "transfers");
      delete p.cursor.suspend_all;
      delete p.cursor.transfers;
    }
    p ??= { id: intent.id, readable, done: [], cursor: {}, counts: {} };
    const counts = p.counts;
    const add = (k, n) => (counts[k] = (counts[k] ?? 0) + n);
    /**
     * Run step `name`: fn(h, cursor) does one bounded part and returns {cursor, more}; each part is
     * its own transaction, with the progress written in it. The last step is armed for the
     * "reconcile-" fault points, the others for "reconcile-step-".
     */
    const step = (name, fn, { last = false } = {}) => {
      if (p.done.includes(name)) return;
      for (;;) {
        let more = false;
        armed = last ? "reconcile" : "reconcile-step";
        db.tx((h) => {
          const r = fn(h, p.cursor[name] ?? null) ?? {};
          more = Boolean(r.more);
          if (more) p.cursor[name] = r.cursor;
          else {
            delete p.cursor[name];
            p.done.push(name);
          }
          if (last) h.run("DELETE FROM store_meta WHERE key = 'restore_progress'");
          else setStoreMeta(h, "restore_progress", JSON.stringify(p));
        }, { cls: "maintenance" });
        armed = null;
        fault?.(`reconcile-step:${name}`);
        if (!more) return;
      }
    };
    /** One slice of `list` (an array the old store gave) per transaction, from index `cursor`. */
    const slices = (list, fn) => (h, cursor) => {
      const from = cursor ?? 0;
      for (const x of list.slice(from, from + RECONCILE_BATCH)) fn(h, x);
      return { cursor: from + RECONCILE_BATCH, more: from + RECONCILE_BATCH < list.length };
    };
    /** Change at most RECONCILE_BATCH rows per transaction with `sql` (selecting by rowid) until none is left. */
    const until = (key, sql) => (h) => {
      const n = Number(h.run(sql.replace("$LIMIT", String(RECONCILE_BATCH))).changes);
      add(key, n);
      return { more: n === RECONCILE_BATCH };
    };

    step("instance", (h) => {
      counts.backup_instance = storeMeta(h, "instance");
      counts.old_instance = old?.instance ?? null;
      const instance = newInstanceId();
      setStoreMeta(h, "instance", instance);
      counts.new_instance = instance;
      counts.revocations_merged = 0;
      counts.suspensions_kept = 0;
      counts.devices_suspended = 0;
      counts.key_packages_cleared = 0;
      counts.reservations_cleared = 0;
      counts.conversations_replace_required = 0;
      counts.e2ee_ops_merged = 0;
    });
    // Revocations are monotonic: the old store's are added, never rolled back.
    step("revocations", slices(old?.revocations ?? [], (h, r) => add("revocations_merged", Number(h.run("INSERT OR IGNORE INTO device_revocations (member_id, device_id, at, by_kind, by_device, statement) VALUES (?, ?, ?, ?, ?, ?)", r.member_id, r.device_id, r.at, r.by_kind, r.by_device, r.statement).changes))));
    // Suspensions of the current store are merged, never cleared by the backup's zeros.
    step("suspensions", slices(old?.suspended ?? [], (h, d) => add("suspensions_kept", Number(h.run("UPDATE devices SET suspended = 1 WHERE member_id = ? AND device_id = ? AND suspended = 0", d.member_id, d.device_id).changes))));
    // Revocations made after the backup cannot be known: every device is out of service until reinstated.
    if (!readable) step("suspend_all", until("devices_suspended", "UPDATE devices SET suspended = 1 WHERE rowid IN (SELECT rowid FROM devices WHERE suspended = 0 AND NOT EXISTS (SELECT 1 FROM device_revocations r WHERE r.member_id = devices.member_id AND r.device_id = devices.device_id) LIMIT $LIMIT)"));
    // Consumed packages would reappear: the pool and every reservation go; devices replenish.
    step("key_packages", until("key_packages_cleared", "DELETE FROM key_packages WHERE rowid IN (SELECT rowid FROM key_packages LIMIT $LIMIT)"));
    step("reservations", until("reservations_cleared", "DELETE FROM kp_reservations WHERE rowid IN (SELECT rowid FROM kp_reservations LIMIT $LIMIT)"));
    // 3.3's tables. The commit log rolled back: accepting a different commit for an epoch clients
    // already left would be a fork (3.3 MI6), so every conversation's current group is marked
    // replace_required and refuses commits until a member device runs group_replace. The queue
    // is the backup's: encrypted messages accepted after the backup point are lost (their senders
    // were told "accepted"; a stated loss, counted here). Recorded operations are merged, never
    // rolled back (like revocations): an op id the old store accepted or cancelled keeps its
    // result, so a retry is answered as before and a cancelled one is never accepted (MII3).
    step("replace_required", until("conversations_replace_required", "UPDATE e2ee_groups SET replace_required = 1 WHERE rowid IN (SELECT rowid FROM e2ee_groups WHERE state = 'active' AND replace_required = 0 LIMIT $LIMIT)"));
    step("queue", (h) => {
      counts.e2ee_queue_kept = Number(h.get("SELECT count(*) AS n FROM e2ee_queue").n);
      counts.e2ee_queue_lost = (old?.deliveries ?? []).filter((d) => !h.get("SELECT 1 AS x FROM e2ee_queue WHERE delivery = ?", d)).length;
    });
    step("ops", slices(old?.ops ?? [], (h, o) => add("e2ee_ops_merged", Number(h.run("INSERT OR IGNORE INTO e2ee_ops (requester_member, requester_device, op, kind, digest, result, created) VALUES (?, ?, ?, ?, ?, ?, ?)", o.requester_member, o.requester_device, o.op, o.kind, o.digest, o.result, o.created).changes))));
    // Phase 6's transfers roll back with the store (a stated loss: transfers accepted after the
    // backup point are gone, their senders upload again). Ending is never rolled back: a transfer
    // the old store ended (aborted, expired, or forgotten after its horizon) is ended here too, so
    // a withdrawn file is never served again; with no readable old store every transfer that is
    // not terminal ends (fail closed: an abort after the backup cannot be known). Each step ends
    // at most RECONCILE_TRANSFERS (their terminations delete at most 64 relations each).
    if (db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'transfers'")) {
      const ended = new Map((old?.transfers ?? []).map((r) => [`${r.uploader_device}|${r.transfer_id}`, r.state]));
      step("transfers", (h, cursor) => {
        counts.transfers_ended ??= 0;
        const rows = h.all(`SELECT * FROM transfers WHERE released = 0 AND tid > ? ORDER BY tid LIMIT ${RECONCILE_TRANSFERS}`, cursor ?? 0);
        for (const r of rows) {
          const k = `${r.uploader_device}|${r.transfer_id}`;
          const was = ended.get(k);
          const state = !readable ? "aborted" : was === "aborted" || was === "expired" ? was : !ended.has(k) ? "expired" : null;
          if (state && terminateTransfer(h, r, state, Date.now())) add("transfers_ended", 1);
        }
        return { cursor: rows.at(-1)?.tid ?? cursor, more: rows.length === RECONCILE_TRANSFERS };
      });
    }
    // The old store's audit rows after the backup point; chained on when they continue the
    // backup's last row, else re-anchored at it (rows appended anew) with the gap recorded. The
    // choice is made once, before the first row is copied, and kept in the progress.
    const rows = old?.audit ?? [];
    step("audit", (h, cursor) => {
      if (!cursor) {
        const head = h.get("SELECT hash FROM admin_audit ORDER BY seq DESC LIMIT 1") ?? h.get("SELECT hash FROM admin_audit_anchor WHERE id = 1") ?? { hash: GENESIS };
        const clash = rows.some((r) => r.ref && h.get("SELECT 1 AS x FROM admin_audit WHERE ref = ?", r.ref));
        const chained = rows.length > 0 && rows[0].prev === head.hash && Number(rows[0].seq) === Number(b.manifest.lastAuditSeq ?? 0) + 1 && !clash;
        cursor = { mode: chained ? "chained" : "rechained", at: 0 };
        counts.audit_copied = rows.length;
        counts.audit_rechained = chained ? 0 : rows.length;
      }
      for (const r of rows.slice(cursor.at, cursor.at + RECONCILE_BATCH)) {
        if (cursor.mode === "chained") h.run("INSERT INTO admin_audit (seq, time, actor, action, target, state, result, detail, ref, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", r.seq, r.time, r.actor, r.action, r.target, r.state, r.result, r.detail, r.ref, r.prev, r.hash);
        else {
          const ref = r.ref && h.get("SELECT 1 AS x FROM admin_audit WHERE ref = ?", r.ref) ? null : r.ref;
          appendAudit(h, { time: Number(r.time), actor: r.actor, action: r.action, target: r.target, state: r.state, result: r.result, detail: JSON.parse(r.detail), ref });
        }
      }
      const at = cursor.at + RECONCILE_BATCH;
      return { cursor: { ...cursor, at }, more: at < rows.length };
    });
    step(
      "result",
      (h) => {
        counts.old_store = readable ? "readable" : intent.old.db ? "unreadable_now" : "unreadable";
        setStoreMeta(h, "restore_counts", JSON.stringify(counts));
        setStoreMeta(h, "restore_id", intent.id);
      },
      { last: true },
    );
    fault?.("reconciled");
    return true;
  } finally {
    db.close();
  }
}

/**
 * Phase 5. Readable old access state: kept as it is (restore.json too). Otherwise: the backup's
 * grants with every member pending, its claim views stale, no requests and no allowances. A rerun
 * writes the same content (the times are the restore's start).
 */
function accessState(stateDir, intent, backup, membersFile, fault) {
  if (intent.old.access) return { access: "kept" };
  const b = backup();
  const dir = path.join(stateDir, "access");
  if (!exists(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  syncDir(stateDir); // its entry, durable before the files in it count (a rerun syncs again)
  const fromBackup = (key, empty) => {
    const name = ACCESS_FILES[key];
    if (!b.manifest.files[`access/${name}`]) return empty;
    const d = JSON.parse(fs.readFileSync(path.join(intent.backup.path, "access", name), "utf8"));
    if (!accessDocOk(key, d)) stop("bad_backup", `the backup's ${name} has an unknown shape`);
    return d;
  };
  const grants = fromBackup("grants", { v: 1, members: {} });
  const claims = fromBackup("claims", { v: 1, views: {} });
  const ids = new Set([...Object.keys(grants.members), ...(intent.members ?? [])]);
  if (membersFile) {
    let list;
    try {
      list = readMembersDoc(membersFile).members; // strict: offline only, as in phase 1
    } catch (e) {
      stop("members", `the members file cannot be read (${e.message}); every current member must be listed as pending`);
    }
    for (const m of list) ids.add(m.id ?? `name:${m.name}`);
  }
  // Members already pending stay pending (the union).
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(dir, "restore.json"), "utf8"));
    if (restoreDocOk(cur)) for (const m of Object.keys(cur.pending)) ids.add(m);
  } catch {}
  // A copy taken before this phase (phase 2) holds the pending list as it was.
  try {
    const was = JSON.parse(fs.readFileSync(path.join(stateDir, "restore", intent.id, "before", "access", "restore.json"), "utf8"));
    if (restoreDocOk(was)) for (const m of Object.keys(was.pending)) ids.add(m);
  } catch {}
  const pending = Object.fromEntries([...ids].sort().map((m) => [m, grants.members[m]?.revision ?? null]));
  const write = (name, doc) => {
    writeDurable(path.join(dir, name), `${JSON.stringify(doc)}\n`);
    fault?.(`access-written:${name}`);
  };
  // The manifest first (every file written here is listed before it exists), then the holds: from
  // the first byte written, nobody is decided by the backup's grants.
  writeAccessManifest(dir, [...Object.values(ACCESS_FILES), "restore.json"]);
  fault?.(`access-written:${MANIFEST_FILE}`);
  write("restore.json", { v: 1, restore: intent.id, at: intent.started, pending });
  write(ACCESS_FILES.grants, grants);
  write(ACCESS_FILES.claims, { ...claims, views: Object.fromEntries(Object.entries(claims.views).map(([k, v]) => [k, { ...v, freshUntil: intent.started }])) });
  write(ACCESS_FILES.requests, { v: 1, pending: [], sent: {} });
  write(ACCESS_FILES.allowances, { v: 1, entries: [] });
  return { access: "rebuilt", members_pending: Object.keys(pending).length, claim_views_stale: Object.keys(claims.views).length };
}

// ---- abort -------------------------------------------------------------------------------------------

/** Abort before installation: eligibility first, then {phase: "aborting", abort_from} in one write. */
function abort(stateDir, intent, fault) {
  if (intent.phase === "aborting") return continueAbort(stateDir, intent, fault);
  if (!["intent", "evidence"].includes(intent.phase)) stop("installed", `restore ${intent.id} is at phase ${intent.phase}: the backup is installed, only --resume completes it`);
  const next = { ...intent, phase: "aborting", abort_from: intent.phase };
  writeIntent(stateDir, next);
  fault?.("abort-recorded");
  return continueAbort(stateDir, next, fault);
}

/**
 * The abort, from the intent alone (`abort_from` as written when it began): a store from phase 3's
 * unrecorded rename is removed only when abort_from is "evidence", no -wal or -shm is present and
 * its digest is the manifest's (it was never opened, so never reconciled); then each evidence file
 * goes back unless that name is in the state directory; then the leftovers; the intent last.
 * A relay.db in the state directory is phase 3's only while the original is still in the evidence
 * (or there was none): one already moved back by an earlier attempt of this abort stays.
 */
function continueAbort(stateDir, intent, fault) {
  const from = intent.abort_from;
  if (!["intent", "evidence"].includes(from)) stop("bad_intent", `the restore intent's abort_from is "${from}"; the abort stops with the state found`);
  const before = path.join(stateDir, "restore", intent.id, "before");
  const target = path.join(stateDir, "relay.db");
  const installed = exists(target) && (exists(path.join(before, "relay.db")) || !intent.old.present);
  if (installed && from !== "evidence") stop(exists(path.join(before, "relay.db")) ? "both_places" : "unexpected_files", exists(path.join(before, "relay.db")) ? `relay.db is both in the state directory and in ${before}: nothing was overwritten; the abort stops with the state found` : `${target} is present and phase 3 never ran; the abort stops with the state found`);
  if (installed) {
    const sides = ["-wal", "-shm"].filter((s) => exists(target + s));
    if (sides.length || fileDigest(target) !== intent.backup.db) stop("unexpected_files", `${target} is present and is not an unopened copy of the backup; the abort stops with the state found`);
    fs.rmSync(target);
    fault?.("abort-removed-install");
    syncDir(stateDir);
  }
  for (const f of SET) {
    const here = path.join(stateDir, f);
    const there = path.join(before, f);
    if (!exists(there)) continue;
    if (exists(here)) stop("both_places", `${f} is both in the state directory and in ${before}: nothing was overwritten; the abort stops with the state found`);
    fs.renameSync(there, here);
    fault?.(`abort-moved:${f}`);
    syncDir(stateDir);
    syncDir(before);
  }
  fs.rmSync(path.join(stateDir, `relay.db.restore-${intent.id}.tmp`), { force: true });
  // What phase 1 created goes too: the directory is as it was.
  if (!intent.old.marker) fs.rmSync(path.join(stateDir, ".relay.db.created"), { force: true });
  if (intent.old.empty) for (const f of ["realm.json", ".created"]) fs.rmSync(path.join(stateDir, f), { force: true });
  syncDir(stateDir);
  fs.rmSync(path.join(stateDir, "restore", intent.id), { recursive: true, force: true });
  fault?.("abort-evidence-removed");
  syncDir(path.join(stateDir, "restore"));
  removeDurable(intentFile(stateDir));
  try {
    fs.rmdirSync(path.join(stateDir, "restore")); // only when nothing else is in it
  } catch {}
  return { id: intent.id, aborted: true };
}
