// The relay owner's view and controls (design 4.4): read views, the audit log's intent and result
// protocol, reload, checkpoint, backup, device reinstatement and evidence removal, as operations
// over the relay's store and state directory. The same operations serve the running relay (asked
// over its admin socket) and the stopped one (run by the CLI holding the state directory's lock):
// one owner of the store at a time.
//
// The admin sees metadata the relay already holds; never message text, never tokens or token
// digests, never key material. Grants entries (who allows whom) only on explicit request, audited.
// Fail closed: an operation whose audit row cannot be written is refused before it changes
// anything; where a change is already durable when a later step fails, the outcome is "unknown".
//
// The admin socket (`<state dir>/admin/admin.sock`): created by the relay process in a 0700
// folder, the socket 0600; the folder's mode is the check (some BSD-derived systems ignore a
// socket's own mode). One JSON request per line {v: 1, id, op, args}, one answer {id, ok, result |
// error}; requests at most 16 KB, answers paged (256 rows, a cursor), at most 4 connections, 60 s
// idle. Node.js does not expose a socket's peer credentials, so the actor is "socket".
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { ACCESS_FILES, accessDocOk, explainPolicy, loadPolicy, restoreDocOk } from "./access.js";
import { backupRelay } from "./backup.js";
import { readMembersDoc, tokenKind } from "./members.js";
import { DEVICE_ID_RE, displayFingerprint } from "./mls/identity.js";
import { DEFAULT_LIMITS as TRANSFER_LIMITS } from "./mls/relaytransfers.js";
import { createDeviceDirectory, DirectoryError } from "./mls/relaydir.js";
import { readRestoreIntent } from "./realm.js";
import { AUDIT_MAX_ROWS, COUNT_TABLES, appendAudit, auditOut, countRows, storeMeta, sweepAudit, verifyAudit } from "./relaystore.js";
import { KP_MAX_PER_DEVICE } from "./mls/policy.js";
import { LOG_KEEP_EPOCHS, LOG_KEEP_MS, OPS_KEEP_MS, QUEUE_MAX_BYTES, QUEUE_MAX_MESSAGES } from "./mls/relayds.js";

const require = createRequire(import.meta.url);
export const VERSION = require("../package.json").version;

export const PAGE_ROWS = 256;
export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_CONNECTIONS = 4;
export const IDLE_MS = 60_000;
export const COUNTS_EVERY_MS = 5 * 60_000;
const MEMBER_ACTIONS = {
  "members.add": "present",
  "members.revoke": "absent",
  "members.signout": "signed_out",
  "members.link": "present",
  "members.unlink": "present",
  "members.device-revoke": "device_revoked",
  "members.migrate": "all_ids",
  "members.add-hosted": "present",
  "members.host-add": "host_present",
  "members.host-remove": "host_absent",
  "relay.broker-reset": "none",
};
const READ_OPS = new Set(["status", "members", "devices", "policy", "policy_check", "grants", "revocations", "metrics", "store", "audit"]);

/** An admin refusal with a code for the answer. */
export class AdminError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const refuse = (code, message) => {
  throw new AdminError(code, message);
};

/** A page of `rows` from offset `cursor`: {rows, next} (next is null on the last page). */
function page(rows, cursor) {
  const from = cursor === undefined || cursor === null ? 0 : /^\d{1,9}$/.test(String(cursor)) ? Number(cursor) : refuse("bad_request", "cursor must be one an earlier page gave");
  const out = rows.slice(from, from + PAGE_ROWS);
  return { rows: out, next: from + PAGE_ROWS < rows.length ? String(from + PAGE_ROWS) : null };
}
const since = (v) => (v === undefined || v === null ? 0 : Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : refuse("bad_request", "since must be a time in milliseconds"));
const optString = (v, what) => (v === undefined || v === null ? null : typeof v === "string" && v.length <= 256 ? v : refuse("bad_request", `${what} must be a string`));

/** The identity of a members file for the CLI's check: SHA-256 of its real path (resolved when it is missing). */
export function membersFileDigest(file) {
  let p;
  try {
    p = fs.realpathSync(file);
  } catch {
    p = path.resolve(file);
  }
  return crypto.createHash("sha256").update(p).digest("hex");
}

/** A short digest of a file's bytes, as its revision for the views (null when absent). */
const fileRevision = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
};

/** The size of a folder's files, recursively (evidence of a restore: a handful of files). */
function treeBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += treeBytes(p);
    else if (e.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

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
 * The admin operations over an open store `db` in `stateDir` (whose lock this process holds).
 * `relay` (the running relay's handle) and `access` (its access state) are given when the relay
 * runs; offline, the views read the files. `apply` ({members(list), policy(p)}) applies a reload.
 * `config` = {members, policy, oidc} file paths; `realm` the realm id; `flags` = {e2ee}.
 */
export function createAdmin({ stateDir, db, realm, relay = null, access = null, config = {}, flags = {}, apply = null, log = () => {}, now = () => Date.now(), startedAt = Date.now(), backupFault = null }) {
  const offline = !relay;
  const directory = createDeviceDirectory({ db, realm, now });
  const counts = new Map(); // table -> {count, at}
  let lastCheckpoint = null;
  let busyCheckpoints = 0;
  let lastBackup = null;
  let auditDropped = 0;
  let membersSeen = readMembersSafe(); // for unannounced changes found at reload
  let policySeen = config.policy ? fileRevision(config.policy) : null;

  function readMembersSafe() {
    if (!config.members) return null;
    try {
      return readMembersDoc(config.members).members;
    } catch {
      return null;
    }
  }
  const members = () => {
    if (!config.members) return [];
    try {
      return readMembersDoc(config.members).members;
    } catch (e) {
      refuse("unavailable", e.message);
    }
  };
  /** A member id from a name or an id. */
  const memberIdOf = (who) => {
    if (typeof who !== "string" || !who) refuse("bad_request", "name a member");
    if (/^m_[a-z2-7]{26}$/.test(who)) return who;
    const m = members().find((x) => x.name === who);
    if (!m) refuse("not_found", `no member named "${who}"`);
    return m.id ?? `name:${m.name}`;
  };
  /** Member names by id, read once for a view. */
  const namesNow = () => new Map((readMembersSafe() ?? []).map((m) => [m.id ?? `name:${m.name}`, m.name]));
  const nameOf = (id, names = namesNow()) => names.get(id) ?? null;

  /** Write one audit row in its own transaction; returns its seq. */
  const record = (row) => db.tx((h) => appendAudit(h, { time: now(), ...row }), { cls: "maintenance" });

  // ---- views -------------------------------------------------------------------------------------

  function status() {
    let intent = null;
    try {
      intent = readRestoreIntent(stateDir);
    } catch (e) {
      intent = { damaged: e.message };
    }
    const view = relay?.adminView?.() ?? null;
    return {
      realm,
      version: VERSION,
      running: !offline,
      auth: view?.auth ?? null,
      caps: view?.caps ?? null,
      hosted: view?.hosted ?? null,
      uptimeSeconds: offline ? null : Math.round((now() - startedAt) / 1000),
      flags: { e2ee: Boolean(flags.e2ee) },
      instance: storeMeta(db, "instance"),
      // Which members file the relay applies, as a digest of its real path (no path is shown):
      // a CLI edits a members file only when it is this one.
      membersFile: config.members ? membersFileDigest(config.members) : null,
      restore: intent ? { id: intent.id ?? null, phase: intent.phase ?? null, ...(intent.damaged ? { damaged: true } : {}) } : null,
    };
  }

  /** Broker families per member: active counts and revocations (from the families file). */
  function families() {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(stateDir, "broker", "families.json"), "utf8"));
      return Object.values(d?.families ?? {});
    } catch {
      return [];
    }
  }

  function membersView({ member = null, cursor } = {}) {
    const t = now();
    const view = relay?.adminView?.() ?? null;
    const fams = families();
    const rows = members()
      .filter((m) => !member || m.name === member || m.id === member)
      .map((m) => {
        const id = m.id ?? `name:${m.name}`;
        const dev = db.get("SELECT count(*) AS n, coalesce(sum(suspended), 0) AS s FROM devices d WHERE member_id = ? AND NOT EXISTS (SELECT 1 FROM device_revocations r WHERE r.member_id = d.member_id AND r.device_id = d.device_id)", id);
        // Never the token or its digest: whether there is one, and how the file stores it.
        return {
          name: m.name,
          id: m.id ?? null,
          tokenPresent: typeof m.token === "string" && m.token.length > 0,
          tokenFormat: typeof m.token === "string" && m.token.length > 0 ? tokenKind(m.token) : null,
          linked: (m.oidc ?? []).map((l) => ({ issuer: l.issuer, subject: l.subject })),
          brokerFamilies: fams.filter((f) => f.memberId === id && !f.revoked && t < f.idleUntil && t < f.maxUntil).length,
          devices: Number(dev.n),
          suspended: Number(dev.s),
          sessions: view ? (view.sessions[id] ?? 0) : null,
          quota: view ? { ...(view.quota[id] ?? { queued: 0, bytes: 0 }), limits: view.limits } : null,
          ...(m.signedOutAt ? { signedOutAt: m.signedOutAt } : {}),
        };
      });
    return page(rows, cursor);
  }

  function devicesView({ member = null, cursor } = {}) {
    const id = member ? memberIdOf(member) : null;
    const t = now();
    const names = namesNow();
    const rows = db
      .all(
        `SELECT d.member_id, d.device_id, d.sig_key, d.created, d.suspended, r.at AS revoked_at, r.by_kind,
           (SELECT count(*) FROM key_packages k WHERE k.member_id = d.member_id AND k.device_id = d.device_id AND k.not_after > ?) AS available,
           (SELECT count(*) FROM kp_reservations x WHERE x.target_member = d.member_id AND x.target_device = d.device_id AND x.state = 'reserved') AS reserved,
           (SELECT count(*) FROM kp_reservations x WHERE x.target_member = d.member_id AND x.target_device = d.device_id AND x.state = 'burned') AS burned
         FROM devices d LEFT JOIN device_revocations r ON r.member_id = d.member_id AND r.device_id = d.device_id
         WHERE ? IS NULL OR d.member_id = ? ORDER BY d.member_id, d.created, d.device_id`,
        t,
        id,
        id,
      )
      .map((r) => {
        let fingerprint = null;
        try {
          fingerprint = displayFingerprint({ realm, member: r.member_id, device: r.device_id, key: Buffer.from(r.sig_key) });
        } catch {}
        return { member: r.member_id, name: nameOf(r.member_id, names), device: r.device_id, fingerprint, enrolled: Number(r.created), revoked: r.revoked_at === null ? null : { at: Number(r.revoked_at), by: r.by_kind }, suspended: Boolean(r.suspended), keyPackages: { available: Number(r.available), reserved: Number(r.reserved), burned: Number(r.burned) } };
      });
    return page(rows, cursor);
  }

  function currentPolicy() {
    if (access) return { loaded: access.policy(), error: null };
    if (!config.policy) return { loaded: null, error: null };
    try {
      return { loaded: loadPolicy(config.policy), error: null };
    } catch (e) {
      return { loaded: null, error: e.message };
    }
  }
  function policyView() {
    const p = currentPolicy();
    // The file as it is now; with the relay running, `loaded` is what it applies (the last reload).
    let fileResult = null;
    if (config.policy) {
      try {
        loadPolicy(config.policy);
        fileResult = "ok";
      } catch (e) {
        fileResult = e.message;
      }
    }
    return { file: config.policy ?? null, revision: config.policy ? fileRevision(config.policy) : null, fileResult, loaded: p.loaded, error: p.error };
  }
  /**
   * Gate 1 for two members by their ids: a static check. A signed-in session also matches groups
   * by its provider's groups (its claim view), which no static check knows: where a rule names a
   * group with provider groups, the answer is marked not certain.
   */
  function policyCheck({ from, to }) {
    const p = currentPolicy().loaded;
    const [a, b] = [memberIdOf(from), memberIdOf(to)];
    if (!p) return { from: a, to: b, action: "allow", rule: "no policy", basis: "member ids", certain: true };
    const signIn = new Set(Object.entries(p.groups).filter(([, g]) => (g.oidcGroups ?? []).length).map(([n]) => `group:${n}`));
    const certain = !p.rules.some((r) => signIn.has(r.from) || signIn.has(r.to));
    return { from: a, to: b, ...explainPolicy(p, a, b), basis: "member ids", certain };
  }

  /** The published grants: from the running relay's access state, else the files (never created here). */
  function grantsState() {
    if (access) return { grants: access.allGrants(), pending: Object.fromEntries(access.pendingRecipients().map((p) => [p.memberId, p.revision])) };
    const read = (name, ok) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(stateDir, "access", name), "utf8"));
        if (!ok(d)) refuse("unavailable", `${name} has an unknown shape`);
        return d;
      } catch (e) {
        if (e.code === "ENOENT") return null;
        if (e instanceof AdminError) throw e;
        refuse("unavailable", `${name} cannot be read`);
      }
    };
    const g = read(ACCESS_FILES.grants, (d) => accessDocOk("grants", d));
    const r = read("restore.json", restoreDocOk);
    return { grants: g?.members ?? {}, pending: r?.pending ?? {} };
  }
  function grantsView({ member = null, cursor } = {}) {
    const { grants, pending } = grantsState();
    const ids = new Set([...Object.keys(grants), ...Object.keys(pending)]);
    const only = member ? memberIdOf(member) : null;
    const names = namesNow();
    const rows = [...ids]
      .filter((id) => !only || id === only)
      .sort()
      .map((id) => {
        const g = grants[id];
        return { member: id, name: nameOf(id, names), default: g?.default ?? null, visible: g?.visible ?? null, entries: g ? g.entries.length : 0, revision: g?.revision ?? 0, updated: g?.updatedAt ?? null, pending: Object.hasOwn(pending, id) };
      });
    return page(rows, cursor);
  }
  /** The entries themselves: recorded in the audit log first; if that fails, refused. */
  function grantsEntries({ member }, actor) {
    const id = memberIdOf(member);
    record({ actor, action: "grants.entries-read", target: nameOf(id) ?? id, state: "done", result: "ok" });
    const g = grantsState().grants[id];
    return { member: id, revision: g?.revision ?? 0, entries: g ? g.entries.map((e) => ({ ...e })) : [] };
  }

  function revocationsView({ since: s, cursor } = {}) {
    const from = since(s);
    const rows = [];
    const names = namesNow();
    for (const r of db.all("SELECT member_id, device_id, at, by_kind FROM device_revocations WHERE at >= ? ORDER BY at", from)) rows.push({ kind: "device", member: r.member_id, name: nameOf(r.member_id, names), device: r.device_id, at: Number(r.at), actor: r.by_kind });
    // A member revocation leaves no record in the members file: the audit log's results say it.
    for (const r of db.all("SELECT time, actor, target FROM admin_audit WHERE action = 'members.revoke' AND state IN ('result', 'unknown') AND result = 'ok' AND time >= ? ORDER BY seq", from)) rows.push({ kind: "member", name: r.target, at: Number(r.time), actor: r.actor });
    for (const f of families()) if (f.revoked && f.revoked.at >= from) rows.push({ kind: "broker_family", member: f.memberId, name: nameOf(f.memberId, names), at: f.revoked.at, actor: "relay", why: f.revoked.why });
    for (const m of (() => {
      try {
        return members();
      } catch {
        return [];
      }
    })()) {
      if (m.signedOutAt && m.signedOutAt >= from) rows.push({ kind: "signout", member: m.id ?? null, name: m.name, at: m.signedOutAt, actor: "members file" });
    }
    rows.sort((a, b) => a.at - b.at);
    return page(rows, cursor);
  }

  function storeView() {
    const st = db.stat();
    const markers = { created: fs.existsSync(path.join(stateDir, ".relay.db.created")), realm: fs.existsSync(path.join(stateDir, ".created")) };
    let intent = null;
    try {
      intent = readRestoreIntent(stateDir);
    } catch {
      intent = { id: null, phase: "damaged" };
    }
    const evidence = [];
    try {
      for (const id of fs.readdirSync(path.join(stateDir, "restore"))) {
        const d = path.join(stateDir, "restore", id, "before");
        if (/^[0-9a-f]{16}$/.test(id) && fs.existsSync(d)) evidence.push({ id, bytes: treeBytes(d), current: intent?.id === id });
      }
    } catch {}
    const t = now();
    const adm = db.admission();
    return {
      schema: { name: "relay", version: db.version, applicationId: db.get("PRAGMA application_id").application_id, pageSize: st.pageSize },
      markers,
      instance: storeMeta(db, "instance"),
      restoreId: storeMeta(db, "restore_id"),
      restore: intent ? { id: intent.id, phase: intent.phase } : null,
      size: { file: st.file, wal: st.wal, pages: st.pages, freelist: st.freelist, autoVacuum: db.get("PRAGMA auto_vacuum").auto_vacuum },
      // Every checkpoint of the store (the sweep's, the admission's and the admin's own) is counted.
      checkpoint: { last: lastCheckpoint ?? adm.checkpoints.last, busySinceStart: Math.max(busyCheckpoints, adm.checkpoints.busy) },
      // WAL admission (design 6): the limits in force, which classes are refused now, refusals by class.
      admission: { limits: { soft: adm.limits.soft, hard: adm.limits.hard, maintenanceBudget: adm.limits.budget }, refused: adm.refused, refusals: adm.refusals, lastRefusal: adm.lastRefusal },
      counts: Object.fromEntries(COUNT_TABLES.map((tb) => [tb, counts.has(tb) ? { count: counts.get(tb).count, ageSeconds: Math.round((t - counts.get(tb).at) / 1000), cap: CAPS[tb] ?? null } : { count: null, ageSeconds: null, cap: CAPS[tb] ?? null }])),
      lastBackup,
      doctor: null,
      evidence,
    };
  }
  const CAPS = { admin_audit: AUDIT_MAX_ROWS, key_packages: `${KP_MAX_PER_DEVICE} per device`, e2ee_queue: `${QUEUE_MAX_MESSAGES} messages and ${QUEUE_MAX_BYTES} bytes per device`, e2ee_log: `${LOG_KEEP_EPOCHS} epochs or ${LOG_KEEP_MS / 86_400_000} days per group`, e2ee_ops: `${OPS_KEEP_MS / 86_400_000} days`, transfers: `${TRANSFER_LIMITS.slots} per member (tombstones included)`, transfer_relations: `${TRANSFER_LIMITS.relations} per member` };

  function metricsView() {
    const st = db.stat();
    const adm = db.admission();
    return { relay: relay ? relay.stats() : null, store: { fileBytes: st.file, walBytes: st.wal, freelistPages: st.freelist, auditDropped, checkpointBusy: adm.checkpoints.busy, writesRefused: adm.refusals } };
  }

  function auditView({ since: s, cursor } = {}) {
    const from = since(s);
    const after = cursor === undefined || cursor === null ? 0 : /^\d{1,15}$/.test(String(cursor)) ? Number(cursor) : refuse("bad_request", "cursor must be one an earlier page gave");
    const rows = db.all("SELECT * FROM admin_audit WHERE seq > ? AND time >= ? ORDER BY seq LIMIT ?", after, from, PAGE_ROWS + 1).map(auditOut);
    const more = rows.length > PAGE_ROWS;
    const out = rows.slice(0, PAGE_ROWS);
    return { rows: out, next: more ? String(out.at(-1).seq) : null, ...(cursor ? {} : { chain: verifyAudit(db) }) };
  }

  // ---- changes -----------------------------------------------------------------------------------

  function checkpoint(actor) {
    let r;
    try {
      r = db.checkpoint();
    } finally {
      lastCheckpoint = { at: now(), result: r ? (r.busy ? "busy" : "ok") : "failed", pages: r?.checkpointed ?? null };
      if (r?.busy) busyCheckpoints++;
    }
    // It changes no data: its row follows it.
    record({ actor, action: "store.checkpoint", state: "done", result: r.busy ? "busy" : "ok", detail: { pages: r.checkpointed, log: r.log } });
    return lastCheckpoint;
  }

  async function backup({ dir, pages }, actor) {
    if (typeof dir !== "string") refuse("bad_request", "name the backup folder");
    let r;
    try {
      r = await backupRelay({ db, stateDir, dest: dir, pages: pages === undefined || pages === null ? undefined : Number(pages), realm, config, fault: backupFault, now });
    } catch (e) {
      lastBackup = { at: now(), result: "failed", error: e.code ?? "error" };
      throw e;
    }
    lastBackup = { at: now(), result: "ok", pages: r.pages, steps: r.steps, maxStepMs: r.maxStepMs, warning: r.warning };
    // The backup changed nothing in the store: a refused row is reported, not a failed backup.
    let auditMissing = false;
    try {
      record({ actor, action: "store.backup", state: "done", result: "ok", detail: { pages: r.pages, steps: r.steps, max_step_ms: r.maxStepMs, slow: r.warning, instance: r.manifest.instance ?? null } });
    } catch {
      auditMissing = true;
    }
    return { dir: r.dir, pages: r.pages, steps: r.steps, maxStepMs: r.maxStepMs, warning: r.warning, bytes: r.bytes, files: Object.keys(r.manifest.files).length, auditMissing };
  }

  function reinstate({ member, device }, actor) {
    const id = memberIdOf(member);
    if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) refuse("bad_request", "name a device id");
    try {
      const r = directory.reinstate({ member: id, device, record: (h, state) => appendAudit(h, { time: now(), actor, action: "devices.reinstate", target: `${nameOf(id) ?? id}/${device}`, state: "done", result: state }) });
      relay?.devicesChanged?.(); // frames held for it, or from it, are dispatched now
      return r;
    } catch (e) {
      if (e instanceof DirectoryError) refuse(e.code, e.message);
      throw e;
    }
  }

  /** Remove a completed restore's evidence: the row first, then the files (rerun completes). */
  function discardEvidence({ id }, actor) {
    if (!/^[0-9a-f]{16}$/.test(id ?? "")) refuse("bad_request", "name a restore id");
    let intent = null;
    try {
      intent = readRestoreIntent(stateDir);
    } catch {
      refuse("fenced", "the restore intent cannot be read; evidence is kept");
    }
    if (intent?.id === id) refuse("fenced", "that restore is unfinished: its evidence is kept");
    const d = path.join(stateDir, "restore", id);
    if (!fs.existsSync(d)) refuse("not_found", `no evidence of restore ${id}`);
    const bytes = treeBytes(d);
    record({ actor, action: "restore.discard-evidence", target: id, state: "done", result: "ok", detail: { bytes } });
    fs.rmSync(d, { recursive: true, force: true });
    syncDir(path.join(stateDir, "restore"));
    return { id, bytes };
  }

  // ---- intents and results -----------------------------------------------------------------------

  function intent({ action, target = null }, actor) {
    if (!Object.hasOwn(MEMBER_ACTIONS, action)) refuse("bad_request", "not an action with an intent");
    const seq = record({ actor, action, target: optString(target, "target"), state: "intent", detail: { expect: MEMBER_ACTIONS[action] } });
    return { intent: seq };
  }
  const intentRow = (seq) => {
    const r = Number.isSafeInteger(Number(seq)) ? db.get("SELECT * FROM admin_audit WHERE seq = ? AND state = 'intent'", Number(seq)) : null;
    return r ?? refuse("not_found", `no intent ${seq}`);
  };
  /** The result of an intent: once (a second result for it is refused by the store). */
  function result({ intent: seq, result: res, detail = {} }, actor) {
    const r = intentRow(seq);
    if (!["ok", "failed"].includes(res)) refuse("bad_request", "result is ok or failed");
    // One outcome per intent: one already settled (unknown, by a reload or a start that found it
    // open) stays, and the caller learns which outcome stands, never that its own was recorded.
    const settled = db.get("SELECT state, result FROM admin_audit WHERE ref = ?", `intent:${r.seq}`);
    if (settled) return { recorded: false, already: true, outcome: settled.state === "result" ? settled.result : "unknown" };
    record({ actor, action: r.action, target: r.target, state: "result", result: res, detail, ref: `intent:${r.seq}` });
    return { recorded: true };
  }
  /** What the members file shows now for an intent: whether the target is as the intent describes. */
  function observe(r) {
    const expect = JSON.parse(r.detail).expect;
    if (expect === "none" || !config.members) return "unobservable";
    let doc;
    let hosts;
    try {
      ({ members: doc, hosts = [] } = readMembersDoc(config.members));
    } catch {
      return "unreadable";
    }
    if (expect === "host_present" || expect === "host_absent") return hosts.some((h) => h.id === r.target) === (expect === "host_present") ? "as_intended" : "not_as_intended";
    const [name, device] = String(r.target ?? "").split("/");
    const m = doc.find((x) => x.name === name);
    const ok = expect === "present" ? Boolean(m) : expect === "absent" ? !m : expect === "signed_out" ? Boolean(m?.signedOutAt && m.signedOutAt >= Number(r.time)) : expect === "device_revoked" ? Boolean(m?.devicesRevoked?.includes(device)) : doc.every((x) => x.id !== undefined);
    return ok ? "as_intended" : "not_as_intended";
  }
  /** Intents without a result (a CLI or relay stopped between its steps): `unknown`, with what is seen. */
  function settleOpenIntents(actor, except = null) {
    const open = db.all("SELECT * FROM admin_audit a WHERE state = 'intent' AND NOT EXISTS (SELECT 1 FROM admin_audit b WHERE b.ref = 'intent:' || a.seq) ORDER BY seq LIMIT ?", PAGE_ROWS);
    let n = 0;
    for (const r of open) {
      if (Number(r.seq) === except) continue;
      record({ actor, action: r.action, target: r.target, state: "unknown", detail: { intent: Number(r.seq), observed: observe(r) }, ref: `intent:${r.seq}` });
      n++;
    }
    return n;
  }

  /** Added, removed and changed entries between two members lists (by id, else name). */
  function membersDiff(before, after) {
    const key = (m) => m.id ?? `name:${m.name}`;
    const a = new Map((before ?? []).map((m) => [key(m), JSON.stringify(m)]));
    const b = new Map((after ?? []).map((m) => [key(m), JSON.stringify(m)]));
    let added = 0;
    let changed = 0;
    for (const [k, v] of b) {
      if (!a.has(k)) added++;
      else if (a.get(k) !== v) changed++;
    }
    let removed = 0;
    for (const k of a.keys()) if (!b.has(k)) removed++;
    return { added, removed, changed };
  }

  /**
   * Reload the members file and the policy (the socket's `reload`, and SIGHUP), and write the
   * result of `intent` if given: ok with the counts, or failed with a code. Changes no admin
   * command announced are recorded as events with counts; load failures too. Open intents of
   * others become `unknown`. The OIDC configuration is read at start only (as before 4.4).
   */
  function reload({ intent: seq = null } = {}, actor = "relay") {
    if (!apply) refuse("not_running", "reload needs the running relay");
    const out = { members: null, policy: null, oidc: "read at start only: restart the relay to change it" };
    const announced = seq !== null && seq !== undefined ? intentRow(seq) : null;
    if (config.policy) {
      const rev = fileRevision(config.policy);
      try {
        apply.policy(loadPolicy(config.policy));
        out.policy = { ok: true, revision: rev };
        if (rev !== policySeen) securityEvent("policy.changed", { unannounced: true }, actor);
        policySeen = rev;
      } catch (e) {
        out.policy = { ok: false, error: e.message };
        securityEvent("config.load-failed", { file: "policy" }, actor);
      }
    }
    if (config.members) {
      let list = null;
      try {
        list = apply.readMembers();
        apply.members(list);
        const diff = membersDiff(membersSeen, list);
        membersSeen = list;
        out.members = { ok: true, ...diff, count: list.length };
      } catch (e) {
        if (e.membersApplied) membersSeen = list;
        out.members = { ok: false, applied: Boolean(e.membersApplied), error: e.message };
      }
      const counts = { added: out.members.added ?? 0, removed: out.members.removed ?? 0, changed: out.members.changed ?? 0 };
      if (announced) {
        try {
          const r = result({ intent: announced.seq, result: out.members.ok ? "ok" : "failed", detail: out.members.ok ? counts : { code: out.members.applied ? "devices_not_stored" : "invalid_members" } }, actor);
          out.result = r.recorded ? (out.members.ok ? "ok" : "failed") : r.outcome;
        } catch {
          out.result = "unknown";
        }
      } else if (out.members.ok && (counts.added || counts.removed || counts.changed)) securityEvent("members.unannounced", counts, actor);
      if (!out.members.ok) securityEvent("config.load-failed", { file: "members" }, actor);
    }
    try {
      out.unknown = settleOpenIntents(actor, announced ? Number(announced.seq) : null);
    } catch {
      out.unknown = null;
    }
    return out;
  }

  /** A security event the relay acts on regardless: recorded if it can be, else counted and logged. */
  function securityEvent(action, detail = {}, actor = "relay") {
    try {
      record({ actor, action, state: "event", detail });
    } catch (e) {
      auditDropped++;
      log(`audit: a security event (${action}) could not be recorded:`, e.message);
    }
  }

  // ---- maintenance -------------------------------------------------------------------------------

  /** The sweep's work: table counts (bounded statements) and audit retention, at most every 5 minutes. */
  async function maintain() {
    for (const tb of COUNT_TABLES) counts.set(tb, { count: await countRows(db, tb), at: now() });
    sweepAudit(db, { now: now() });
  }

  // ---- dispatch ----------------------------------------------------------------------------------

  async function call(op, args = {}, { actor = offline ? "offline-cli" : "socket" } = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) refuse("bad_request", "args must be an object");
    switch (op) {
      case "status":
        return status();
      case "members":
        return membersView(args);
      case "devices":
        return devicesView(args);
      case "policy":
        return policyView();
      case "policy_check":
        return policyCheck(args);
      case "grants":
        return grantsView(args);
      case "grants_entries":
        return grantsEntries(args, actor);
      case "revocations":
        return revocationsView(args);
      case "metrics":
        return metricsView();
      case "store":
        return storeView();
      case "audit":
        return auditView(args);
      case "checkpoint":
        return checkpoint(actor);
      case "backup":
        return backup(args, actor);
      case "reinstate":
        return reinstate(args, actor);
      case "discard_evidence":
        return discardEvidence(args, actor);
      case "audit_intent":
        return intent(args, actor);
      case "audit_result":
        return result(args, actor);
      case "reload":
        return reload(args, actor);
      default:
        refuse("bad_request", `unknown operation "${String(op).slice(0, 40)}"`);
    }
  }

  return { call, reload, settleOpenIntents, securityEvent, maintain, auditDropped: () => auditDropped, isRead: (op) => READ_OPS.has(op) };
}

// ---- the admin socket ------------------------------------------------------------------------------

export const socketPath = (stateDir) => path.join(stateDir, "admin", "admin.sock");
const REQUEST_KEYS = new Set(["v", "id", "op", "args"]);

/**
 * Serve `admin` on the state directory's admin socket. The relay holds the state directory's
 * lock, so a socket file left by an earlier process is removed. Returns {close()}.
 */
export async function startAdminSocket({ stateDir, admin, log = () => {}, idleMs = IDLE_MS }) {
  const dir = path.join(stateDir, "admin");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${dir} is open to other users; run: chmod 700 ${dir}`);
  const file = socketPath(stateDir);
  if (Buffer.byteLength(file) > 103) throw new Error(`the admin socket's path ${file} is too long for a Unix socket; use a shorter state directory`);
  fs.rmSync(file, { force: true });
  const server = net.createServer({ allowHalfOpen: false });
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (sock) => {
    sock.setEncoding("utf8");
    sock.setTimeout(idleMs, () => sock.destroy());
    let buf = "";
    let chain = Promise.resolve();
    // Idle means no request outstanding: the timer is off while one runs (a backup can take long).
    let running = 0;
    const answer = (o) => sock.writable && sock.write(`${JSON.stringify(o)}\n`);
    sock.on("data", (d) => {
      buf += d;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        running++;
        sock.setTimeout(0);
        chain = chain
          .then(() => handleLine(line))
          .finally(() => --running || sock.setTimeout(idleMs));
      }
      if (Buffer.byteLength(buf) > MAX_REQUEST_BYTES) {
        answer({ id: null, ok: false, error: { code: "too_large", message: `a request has at most ${MAX_REQUEST_BYTES} bytes` } });
        sock.end();
        sock.destroy();
      }
    });
    sock.on("error", () => {});
    async function handleLine(line) {
      if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return answer({ id: null, ok: false, error: { code: "too_large", message: `a request has at most ${MAX_REQUEST_BYTES} bytes` } });
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return answer({ id: null, ok: false, error: { code: "bad_request", message: "one JSON request per line" } });
      }
      const id = typeof m?.id === "string" || Number.isSafeInteger(m?.id) ? m.id : null;
      // A strict shape: no credentials ride along (the socket's folder is the authentication).
      if (!m || typeof m !== "object" || m.v !== 1 || id === null || typeof m.op !== "string" || Object.keys(m).some((k) => !REQUEST_KEYS.has(k))) {
        return answer({ id, ok: false, error: { code: "bad_request", message: "a request is {v: 1, id, op, args}" } });
      }
      try {
        answer({ id, ok: true, result: await admin.call(m.op, m.args ?? {}, { actor: "socket" }) });
      } catch (e) {
        if (!(e instanceof AdminError) && !e.code) log("admin: an operation failed:", e.message);
        answer({ id, ok: false, error: { code: e instanceof AdminError || /^[a-z_]+$/.test(e.code ?? "") ? e.code : "failed", message: e.message } });
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => {
      server.off("error", reject);
      try {
        fs.chmodSync(file, 0o600);
      } catch (e) {
        server.close();
        return reject(e);
      }
      resolve({
        path: file,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            fs.rmSync(file, { force: true });
          }),
      });
    });
  });
}

/**
 * Ask the running relay over its admin socket: resolves to the result, rejects with the answer's
 * {code, message}, or with code "not_running" when nothing listens on the socket.
 */
export function adminRequest(stateDir, op, args = {}, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath(stateDir));
    const id = crypto.randomBytes(6).toString("hex");
    let buf = "";
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new AdminError("not_answering", "the relay is not answering on its admin socket")), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ v: 1, id, op, args })}\n`));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let m;
      try {
        m = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(reject, new AdminError("bad_answer", "the relay's answer is not JSON"));
      }
      if (m.ok) finish(resolve, m.result);
      else finish(reject, new AdminError(m.error?.code ?? "failed", m.error?.message ?? "refused"));
    });
    sock.on("error", (e) => finish(reject, ["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(e.code) ? new AdminError("not_running", "the relay is not running (no admin socket)") : new AdminError("not_answering", `the admin socket failed (${e.code ?? "error"})`)));
    sock.on("close", () => finish(reject, new AdminError("not_answering", "the relay closed the admin connection without an answer")));
  });
}
