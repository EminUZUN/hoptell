// The relay's store as every start opens it (design 4.4, "Prerequisites"), as one ordered list:
// migration 1 holds 3.2's device tables, migrations 2 and 3 3.3's Delivery Service tables, and
// migration 4 the relay admin's (audit log, its anchor, the store's own metadata, the device
// suspension flag, and the replace_required mark of a restored conversation), and migration 5 phase
// 6's transfers (lib/mls/relaytransfers.js); A12's pending device requests come last
// (lib/mls/relaydir.js APPROVAL_MIGRATION). Later designs append
// theirs after these; an applied migration is never edited or renumbered. The device and
// encrypted-message services stay behind --experimental-e2ee; the tables exist in every store.
//
// The audit log (design 4.4, "Audit log") records what the relay owner did and what the relay did
// on its own for security, without content: fixed action names, member names and device ids as
// targets, and a detail of fixed codes and counts. Each row carries the SHA-256 of the previous
// row (a hash chain); the retention sweep keeps the last deleted row's seq and hash as the anchor
// verification starts from. This notices a casual edit, not a rewrite by whoever can write the
// store: it is an operational record, not evidence.
import crypto from "node:crypto";
import { clean } from "./metrics.js";
import { APPROVAL_MIGRATION, DEVICE_MIGRATIONS } from "./mls/relaydir.js";
import { E2EE_MIGRATIONS, E2EE_PAYLOAD_MIGRATION } from "./mls/relayds.js";
import { RELATION_SENDER_MIGRATION, TRANSFER_DENIED_MIGRATION, TRANSFER_MIGRATION } from "./mls/relaytransfers.js";
import { openRelayDb } from "./relaydb.js";

/** Migration 4 (design 4.4): appended after 3.2's migration 1 and 3.3's migrations 2 and 3. */
export const ADMIN_MIGRATION = (h) => {
  h.exec(`ALTER TABLE devices ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE e2ee_groups ADD COLUMN replace_required INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE admin_audit (
      seq INTEGER PRIMARY KEY,
      time INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      state TEXT NOT NULL CHECK (state IN ('done', 'intent', 'result', 'unknown', 'event')),
      result TEXT,
      detail TEXT NOT NULL,
      ref TEXT UNIQUE,
      prev TEXT NOT NULL,
      hash TEXT NOT NULL
    ) STRICT;
    CREATE INDEX admin_audit_time ON admin_audit (time);
    CREATE TABLE admin_audit_anchor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seq INTEGER NOT NULL,
      hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE store_meta (key TEXT PRIMARY KEY, value ANY NOT NULL) STRICT;`);
  h.run("INSERT INTO store_meta (key, value) VALUES ('instance', ?)", newInstanceId());
};

/** Every migration of the relay's store, in order. */
export const RELAY_MIGRATIONS = [...DEVICE_MIGRATIONS, ...E2EE_MIGRATIONS, ADMIN_MIGRATION, TRANSFER_MIGRATION, RELATION_SENDER_MIGRATION, E2EE_PAYLOAD_MIGRATION, TRANSFER_DENIED_MIGRATION, APPROVAL_MIGRATION];

export const newInstanceId = () => crypto.randomBytes(16).toString("hex");

/** Open the relay's store in `dir` (the caller holds the state directory's lock). */
export const openRelayStore = ({ dir, fault = null, fullfsync = true, restoreId = null, admission = {} }) => openRelayDb({ dir, migrations: RELAY_MIGRATIONS, fault, fullfsync, restoreId, admission });

/** A value of store_meta, or null. */
export function storeMeta(h, key) {
  const r = h.get("SELECT value FROM store_meta WHERE key = ?", key);
  return r ? r.value : null;
}
export function setStoreMeta(h, key, value) {
  h.run("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}

// ---- audit ---------------------------------------------------------------------------------------

export const GENESIS = "0".repeat(64);
export const AUDIT_MAX_ROWS = 100_000; // open point 4: placeholders
export const AUDIT_MAX_AGE_MS = 365 * 86_400_000;
const AUDIT_BATCH = 256;
const ACTION_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const DETAIL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DETAIL_CODE_RE = /^[A-Za-z0-9_.:-]{0,128}$/;
const STATES = new Set(["done", "intent", "result", "unknown", "event"]);

/**
 * A detail as stored: a fixed code and counts, never free text. Keys are identifiers; values are
 * integers, booleans, null, or codes (letters, digits, `_.:-`). Anything else refuses the write.
 */
export function detailText(detail = {}) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) throw new Error("an audit detail is an object of codes and counts");
  const out = {};
  for (const k of Object.keys(detail).sort()) {
    const v = detail[k];
    if (!DETAIL_KEY_RE.test(k)) throw new Error("an audit detail key is an identifier");
    if (!(v === null || typeof v === "boolean" || Number.isSafeInteger(v) || (typeof v === "string" && DETAIL_CODE_RE.test(v)))) throw new Error(`audit detail ${k} is not a code or a count`);
    out[k] = v;
  }
  return JSON.stringify(out);
}

const rowHash = (prev, r) => crypto.createHash("sha256").update(`${prev}\n${JSON.stringify([r.seq, r.time, r.actor, r.action, r.target, r.state, r.result, r.detail, r.ref])}`).digest("hex");

/** The newest row's {seq, hash}, else the anchor's, else the genesis. */
function chainHead(h) {
  return h.get("SELECT seq, hash FROM admin_audit ORDER BY seq DESC LIMIT 1") ?? h.get("SELECT seq, hash FROM admin_audit_anchor WHERE id = 1") ?? { seq: 0, hash: GENESIS };
}

/**
 * Append an audit row inside transaction `h`; returns its seq. `actor`: "socket", "offline-cli"
 * or "relay"; `state`: done (one-step operation), intent, result, unknown, or event (the relay's
 * own); `ref`: a unique reference (a result's intent, a restore's id), so a rerun inserts it once.
 * Every text value passes the log's control-character cleaning.
 */
export function appendAudit(h, { actor, action, target = null, state, result = null, detail = {}, ref = null, time = Date.now() }) {
  if (!ACTION_RE.test(action ?? "")) throw new Error("an audit action is a fixed name");
  if (!STATES.has(state)) throw new Error("unknown audit state");
  if (result !== null && !DETAIL_CODE_RE.test(result)) throw new Error("an audit result is a code");
  const head = chainHead(h);
  const row = { seq: Number(head.seq) + 1, time, actor: clean(actor).slice(0, 64), action, target: target === null ? null : clean(target).slice(0, 256), state, result, detail: detailText(detail), ref: ref === null ? null : clean(ref).slice(0, 128) };
  const hash = rowHash(head.hash, row);
  h.run("INSERT INTO admin_audit (seq, time, actor, action, target, state, result, detail, ref, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", row.seq, row.time, row.actor, row.action, row.target, row.state, row.result, row.detail, row.ref, head.hash, hash);
  return row.seq;
}

/** Rows as views show them (detail parsed). */
export const auditOut = (r) => ({ seq: Number(r.seq), time: Number(r.time), actor: r.actor, action: r.action, target: r.target, state: r.state, result: r.result, detail: JSON.parse(r.detail), ...(r.ref ? { ref: r.ref } : {}) });

/**
 * Verify the chain from the anchor (or the genesis): every row's prev is the previous row's hash
 * and its own hash matches its fields. Reads in pages of 1,000. {ok, rows, from, brokenAt}.
 */
export function verifyAudit(db) {
  const anchor = db.get("SELECT seq, hash FROM admin_audit_anchor WHERE id = 1");
  let prev = anchor?.hash ?? GENESIS;
  let after = anchor ? Number(anchor.seq) : 0;
  let rows = 0;
  for (;;) {
    const page = db.all("SELECT * FROM admin_audit WHERE seq > ? ORDER BY seq LIMIT 1000", after);
    for (const r of page) {
      if (r.prev !== prev || rowHash(prev, r) !== r.hash) return { ok: false, rows, from: anchor ? Number(anchor.seq) : 0, brokenAt: Number(r.seq) };
      prev = r.hash;
      after = Number(r.seq);
      rows++;
    }
    if (page.length < 1000) return { ok: true, rows, from: anchor ? Number(anchor.seq) : 0, brokenAt: null };
  }
}

/**
 * Retention: delete the oldest rows past `maxAgeMs` or beyond `maxRows`, in batches of 256 rows,
 * each with the anchor update in its transaction. At most `batches` per call (the sweep comes
 * again). Returns the number of rows deleted.
 */
export function sweepAudit(db, { now = Date.now(), maxRows = AUDIT_MAX_ROWS, maxAgeMs = AUDIT_MAX_AGE_MS, batches = 16 } = {}) {
  let deleted = 0;
  for (let i = 0; i < batches; i++) {
    const n = db.tx((h) => {
      const count = Number(h.get("SELECT count(*) AS n FROM admin_audit").n);
      const over = Math.max(0, count - maxRows);
      const old = h.all("SELECT seq, hash, time FROM admin_audit ORDER BY seq LIMIT ?", AUDIT_BATCH);
      const drop = old.filter((r, j) => j < over || Number(r.time) < now - maxAgeMs);
      // Only a prefix: the anchor is the last row deleted, and every row after it stays.
      let k = 0;
      while (k < drop.length && drop[k] === old[k]) k++;
      if (!k) return 0;
      const last = old[k - 1];
      h.run("DELETE FROM admin_audit WHERE seq <= ?", last.seq);
      h.run("INSERT INTO admin_audit_anchor (id, seq, hash) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash", last.seq, last.hash);
      return k;
    }, { cls: "maintenance" });
    deleted += n;
    if (n < AUDIT_BATCH) break;
  }
  return deleted;
}

// ---- table counts ---------------------------------------------------------------------------------

export const COUNT_TABLES = ["devices", "key_packages", "kp_reservations", "admin_audit", "e2ee_groups", "e2ee_log", "e2ee_queue", "e2ee_payloads", "e2ee_ops", "transfers", "transfer_chunks", "transfer_relations"];
const COUNT_RANGE = 10_000;

/**
 * Count `table` in keyset ranges of at most 10,000 rows, one statement each, yielding between
 * statements (`pause`), so no single read holds the store long. The sweep's maintenance work,
 * never run for a view.
 */
export async function countRows(db, table, { pause = () => new Promise((r) => setImmediate(r)) } = {}) {
  if (!COUNT_TABLES.includes(table)) throw new Error("not a counted table");
  let n = 0;
  let after = -1;
  for (;;) {
    const r = db.get(`SELECT count(*) AS n, max(rowid) AS last FROM (SELECT rowid FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${COUNT_RANGE})`, after);
    n += Number(r.n);
    if (Number(r.n) < COUNT_RANGE) return n;
    after = Number(r.last);
    await pause();
  }
}
