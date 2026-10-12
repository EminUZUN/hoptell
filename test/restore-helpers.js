// Shared setup for the backup and restore tests (design 4.4): a relay state directory with devices,
// KeyPackages, audit rows, access files and a members file; a backup of it; changes made after the
// backup; and a "crash image" of the result (relay.db with its -wal and -shm, as a stopped process
// leaves them) used as the template every test copies.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { BIN } from "../lib/config.js";
import { createAccess } from "../lib/access.js";
import { backupRelay } from "../lib/backup.js";
import { loadRealm, lockStateDir } from "../lib/realm.js";
import { appendAudit, openRelayStore, storeMeta } from "../lib/relaystore.js";
import { createDeviceDirectory } from "../lib/mls/relaydir.js";
import { createDeliveryService } from "../lib/mls/relayds.js";
import { createTransferStore } from "../lib/mls/relaytransfers.js";
import { rootOf } from "../lib/transferwire.js";
import { displayFingerprint, pinIdentity } from "../lib/mls/identity.js";

export const ID = { alice: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", bob: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", carol: "m_cccccccccccccccccccccccccc" };
export const DEV = { a1: `${"a".repeat(25)}a`, a2: `${"b".repeat(25)}a`, b1: `${"c".repeat(25)}a` };
export const SET = ["relay.db", "relay.db-wal", "relay.db-shm"];
export const GROUP = "9".repeat(32);
export const OPS = ["a", "b", "c", "d", "e"].map((x) => `o_${x.repeat(26)}`);
/** Two sealed transfers of alice's a1 at the backup (design 6); the first is aborted after it. */
export const TX = { aborted: "1".repeat(32), sealed: "2".repeat(32) };
const DAY = 86_400_000;

export const tmp = (t, prefix = "hoptell-rs-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(d, 0o700);
  t?.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
export const digest = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
export const exists = (f) => fs.existsSync(f);

/** A members file with alice, bob and carol (hashed tokens). */
export function membersFile(dir) {
  const file = path.join(dir, "members.json");
  const members = Object.entries(ID).map(([name, id]) => ({ name, id, token: `sha256:${crypto.createHash("sha256").update(name).digest("hex")}` }));
  fs.writeFileSync(file, `${JSON.stringify({ members }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Register a device with a fixed key (fill byte `k`); a member's second one approved by the admin first (A12). */
export function enroll(directory, realm, member, device, k) {
  const key = Buffer.alloc(32, k);
  if (directory.request({ member, device, key }).state === "pending") directory.adminApprove({ member, device, fingerprint: displayFingerprint({ realm, member, device, key }) });
  directory.register({ member, device, key, pin: pinIdentity({ realm, member, device, key }) });
}

/**
 * The template: a state directory, a backup of it, then changes after the backup (a device
 * revoked, a deny published, an allowance used, audit rows), left as a crash image. Returns
 * {template, backup, config: {members}, realm, cfgDir}.
 */
export async function buildTemplate(t) {
  const root = tmp(t, "hoptell-rs-tpl-");
  const state = path.join(root, "state");
  const cfgDir = path.join(root, "config");
  fs.mkdirSync(cfgDir, { mode: 0o700 });
  const members = membersFile(cfgDir);
  const policy = path.join(cfgDir, "policy.json");
  fs.writeFileSync(policy, `${JSON.stringify({ v: 1, rules: [], defaultAction: "allow" })}\n`, { mode: 0o600 });
  const release = lockStateDir(state);
  const realm = loadRealm(state);
  const db = openRelayStore({ dir: state, fullfsync: false });
  const directory = createDeviceDirectory({ db, realm });
  enroll(directory, realm, ID.alice, DEV.a1, 1);
  enroll(directory, realm, ID.alice, DEV.a2, 2);
  enroll(directory, realm, ID.bob, DEV.b1, 3);
  for (const [m, d] of [[ID.alice, DEV.a1], [ID.alice, DEV.a2], [ID.bob, DEV.b1]]) directory.upload({ member: m, device: d, packages: [1, 2].map((i) => ({ kp: Buffer.from(`kp-${d}-${i}`), notAfter: Date.now() + DAY })) });
  const r1 = directory.take({ requester: { member: ID.alice, device: DEV.a1 }, request: "req-template-1", target: { member: ID.bob, device: DEV.b1 } });
  // An encrypted conversation (3.3): alice's a1 and bob's b1, a Welcome and a message queued for b1.
  const ds = createDeliveryService({ db, directory, realm });
  const A1 = { member: ID.alice, device: DEV.a1 };
  const blob = () => crypto.randomBytes(48).toString("base64");
  ds.groupCreate({ requester: A1, op: OPS[0], peer: ID.bob, group: GROUP, epoch: 1, welcome: { recipients: [DEV.b1], mls: blob(), ratchet_tree: blob() }, reservations: [r1.reservation] });
  ds.sendApp({ requester: A1, op: OPS[1], group: GROUP, mls: blob(), target: "bob" });
  // Transfers (design 6): two sealed empty transfers (one chunk of 16 bytes each).
  const transfers = createTransferStore({ db });
  for (const id of [TX.aborted, TX.sealed]) {
    const data = crypto.randomBytes(16);
    transfers.begin({ uploader: A1, transferId: id, totalBytes: 0, chunkCount: 1, headerDigest: "3".repeat(64) });
    transfers.chunk({ uploader: A1, transferId: id, index: 0, data });
    transfers.commit({ uploader: A1, transferId: id, root: rootOf([data]).toString("hex") });
  }
  db.tx((h) => appendAudit(h, { actor: "offline-cli", action: "test.before-backup", state: "done" }));
  const access = createAccess({ stateDir: state });
  access.putGrants(ID.alice, 0, { default: "deny", visible: "all", entries: [] });
  access.putGrants(ID.bob, 0, { default: "deny", visible: "all", entries: [] });
  // An allowance bob holds for replying to alice (unused at the backup).
  access.noteRelease(ID.alice, ID.bob, "msg-1");
  const backup = path.join(root, "backup");
  await backupRelay({ db, stateDir: state, dest: backup, realm, config: { members, policy } });
  // After the backup: a revocation, a deny, a used allowance, audit rows.
  directory.revoke({ member: ID.alice, device: DEV.a2, by: { kind: "admin" } });
  access.putGrants(ID.alice, 1, { default: "deny", visible: "all", entries: [{ selector: `member:${ID.carol}`, action: "deny" }] });
  if (access.useAllowance(ID.bob, ID.alice, "msg-1", { op: null, digest: "0".repeat(64), messageId: "msg-2", deliveryId: "dlv-2", ts: Date.now() }).use !== "new") throw new Error("the template's allowance was not used");
  // After the backup: the uploader withdraws one transfer (design 6: never served again after a restore).
  transfers.abort({ uploader: A1, transferId: TX.aborted });
  // After the backup: a commit and a message (lost by a restore), and a cancelled op id (kept).
  ds.sendCommit({ requester: A1, op: OPS[2], group: GROUP, expectedEpoch: 1, mls: blob(), delta: { add: [], remove: [] } });
  ds.sendApp({ requester: A1, op: OPS[3], group: GROUP, mls: blob(), target: "bob" });
  ds.sendApp({ requester: A1, op: OPS[4], group: GROUP, mls: blob(), target: "bob", reconcile: true });
  db.tx((h) => appendAudit(h, { actor: "offline-cli", action: "test.after-backup", state: "done" }));
  db.tx((h) => appendAudit(h, { actor: "relay", action: "test.after-backup", state: "event" }));
  const instance = storeMeta(db, "instance");
  // The crash image: copied while the store is open (relay.db, -wal and -shm as found).
  const template = path.join(root, "template");
  copyState(state, template);
  db.close();
  release();
  for (const f of ["relay.db-wal", "relay.db-shm"]) if (!exists(path.join(template, f))) throw new Error(`the template has no ${f}`);
  return { template, backup, config: { members, policy }, realm, instance, cfgDir };
}

/** Copy a state directory (without its lock). */
export function copyState(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== "relay.lock" });
  fs.chmodSync(to, 0o700);
}

/** A fresh copy of the template to work on. */
export function work(t, tpl) {
  const dir = path.join(tmp(t, "hoptell-rs-w-"), "state");
  copyState(tpl.template, dir);
  return dir;
}

/** The original store set's digests (what the evidence must hold). */
export const setDigests = (dir) => Object.fromEntries(SET.filter((f) => exists(path.join(dir, f))).map((f) => [f, digest(path.join(dir, f))]));

/**
 * A completed restore's state, without what differs by run (instance ids, restore ids, times):
 * devices, revocations, KeyPackages, the access files, the audit actions and the restore's counts.
 */
export function summary(dir) {
  const release = lockStateDir(dir);
  const db = openRelayStore({ dir, fullfsync: false });
  try {
    const out = {
      version: db.version,
      devices: db.all("SELECT member_id, device_id, suspended FROM devices ORDER BY member_id, device_id").map((r) => ({ ...r })),
      revocations: db.all("SELECT member_id, device_id, by_kind FROM device_revocations ORDER BY member_id, device_id").map((r) => ({ ...r })),
      keyPackages: Number(db.get("SELECT count(*) AS n FROM key_packages").n),
      e2ee: {
        groups: db.all("SELECT group_id, epoch, state, replace_required FROM e2ee_groups ORDER BY group_id").map((r) => ({ ...r })),
        queue: db.all("SELECT json_extract(frame, '$.kind') AS kind FROM e2ee_queue ORDER BY seq").map((r) => r.kind),
        ops: db.all("SELECT op, kind FROM e2ee_ops ORDER BY op").map((r) => `${r.op}/${r.kind}`),
      },
      reservations: Number(db.get("SELECT count(*) AS n FROM kp_reservations").n),
      audit: db.all("SELECT action, state FROM admin_audit ORDER BY seq").map((r) => `${r.action}/${r.state}`),
      restoreRows: Number(db.get("SELECT count(*) AS n FROM admin_audit WHERE action = 'store.restore'").n),
      counts: (() => {
        const c = JSON.parse(db.get("SELECT detail FROM admin_audit WHERE action = 'store.restore' ORDER BY seq DESC LIMIT 1")?.detail ?? "{}");
        for (const k of ["backup_instance", "old_instance", "new_instance"]) delete c[k];
        return c;
      })(),
      access: Object.fromEntries(["grants.json", "claims.json", "requests.json", "allowances.json", "restore.json"].map((f) => {
        const p = path.join(dir, "access", f);
        if (!exists(p)) return [f, null];
        const d = JSON.parse(fs.readFileSync(p, "utf8"));
        if (f === "restore.json") return [f, d.pending];
        if (f === "claims.json") return [f, Object.keys(d.views)];
        if (f === "allowances.json") return [f, d.entries.map((e) => ({ ...e, expires: 0, used: e.used ? { ...e.used, at: 0, ts: 0 } : null }))];
        if (f === "grants.json") return [f, Object.fromEntries(Object.entries(d.members).map(([k, g]) => [k, { ...g, updatedAt: 0 }]))];
        return [f, d];
      })),
      brokerRevoked: (() => {
        try {
          return Object.values(JSON.parse(fs.readFileSync(path.join(dir, "broker", "families.json"), "utf8")).families).every((f) => f.revoked);
        } catch {
          return null;
        }
      })(),
      intent: exists(path.join(dir, "restore", "intent.json")),
    };
    return out;
  } finally {
    db.close();
    release();
  }
}

/** Run the CLI with an isolated environment (never the real state directory or settings). */
export function cli(args, { stateDir, env = {} } = {}) {
  const dir = path.dirname(stateDir);
  const envFile = path.join(dir, "empty.env");
  if (!exists(envFile)) fs.writeFileSync(envFile, "");
  const e = { ...process.env, HOPTELL_ENV: envFile, XDG_CONFIG_HOME: path.join(dir, "xdg"), HOPTELL_STATE_DIR: stateDir, HOPTELL_TOKEN: "t".repeat(64), ...env };
  for (const k of ["HOPTELL_MEMBERS", "HOPTELL_POLICY", "HOPTELL_OIDC", "HOPTELL_EXPERIMENTAL_E2EE", "HOPTELL_RESTORE_TEST_CRASH", "HOPTELL_MLS_WASM"]) if (!(k in env)) delete e[k];
  return new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env: e, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.signal ?? err.code ?? 1) : 0, stdout, stderr })));
}

/**
 * A larger template for the bounded reconcile (design 6: every write transaction under A): at the
 * backup 60 devices with 20 KeyPackages of 8 KiB each, 300 reservations, 300 conversations and 40
 * sealed transfers; after it 600 revocations, 700 operations, 600 audit rows and 20 transfers
 * aborted. Each part needs several of the reconcile's steps. Returns what buildTemplate returns.
 */
export async function buildLargeTemplate(t) {
  const root = tmp(t, "hoptell-rs-big-");
  const state = path.join(root, "state");
  const cfgDir = path.join(root, "config");
  fs.mkdirSync(cfgDir, { mode: 0o700 });
  const members = membersFile(cfgDir);
  const release = lockStateDir(state);
  const realm = loadRealm(state);
  const db = openRelayStore({ dir: state, fullfsync: false });
  const directory = createDeviceDirectory({ db, realm });
  const devices = [];
  for (const [mi, member] of [ID.alice, ID.bob, ID.carol].entries()) {
    for (let i = 0; i < 20; i++) {
      const device = `${"abcdefghijklmnopqrstuvwxyz"[i]}${"234567"[mi]}${"q".repeat(23)}a`;
      enroll(directory, realm, member, device, mi * 20 + i + 1);
      directory.upload({ member, device, packages: Array.from({ length: 20 }, () => ({ kp: crypto.randomBytes(8 * 1024), notAfter: Date.now() + DAY })) });
      devices.push({ member, device });
    }
  }
  // 300 reservations (alice's first device takes packages of the others).
  const A1 = devices[0];
  for (const target of devices.slice(1, 16)) for (let i = 0; i < 20; i++) directory.take({ requester: A1, request: `req-big-${target.device}-${i}`, target });
  db.tx((h) => {
    for (let i = 0; i < 300; i++) h.run("INSERT INTO e2ee_groups (group_id, member_a, member_b, generation, state, epoch, created) VALUES (?, ?, ?, 1, 'active', 1, 1)", crypto.randomBytes(16).toString("hex"), ID.alice, ID.bob);
  });
  const transfers = createTransferStore({ db, limits: { open: 100 } });
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const id = crypto.randomBytes(16).toString("hex");
    const data = crypto.randomBytes(16);
    transfers.begin({ uploader: A1, transferId: id, totalBytes: 0, chunkCount: 1, headerDigest: "3".repeat(64) });
    transfers.chunk({ uploader: A1, transferId: id, index: 0, data });
    transfers.commit({ uploader: A1, transferId: id, root: rootOf([data]).toString("hex") });
    ids.push(id);
  }
  db.tx((h) => appendAudit(h, { actor: "offline-cli", action: "test.before-backup", state: "done" }));
  const backup = path.join(root, "backup");
  await backupRelay({ db, stateDir: state, dest: backup, realm, config: { members } });
  // After the backup.
  db.tx((h) => {
    for (let i = 0; i < 600; i++) h.run("INSERT INTO device_revocations (member_id, device_id, at, by_kind, by_device, statement) VALUES (?, ?, ?, 'admin', NULL, NULL)", ID.carol, `r${String(i).padStart(24, "0")}a`, Date.now());
  });
  db.tx((h) => {
    for (let i = 0; i < 700; i++) h.run("INSERT INTO e2ee_ops (requester_member, requester_device, op, kind, digest, result, created) VALUES (?, ?, ?, 'app', ?, '{}', ?)", ID.alice, A1.device, `o_${String(i).padStart(26, "a")}`, "0".repeat(64), Date.now());
  });
  for (let i = 0; i < 600; i++) db.tx((h) => appendAudit(h, { actor: "relay", action: "test.after-backup", state: "event", detail: { i } }));
  for (const id of ids.slice(0, 20)) transfers.abort({ uploader: A1, transferId: id });
  const template = path.join(root, "template");
  copyState(state, template);
  db.close();
  release();
  return { template, backup, config: { members }, realm, ids };
}
