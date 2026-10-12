// The relay's device directory and KeyPackage store (design 3.2, "Relay changes", "KeyPackages",
// "Loss and revocation"), on the relay's durable storage (lib/relaydb.js). EXPERIMENTAL: the relay
// uses it only when started with --experimental-e2ee.
//
// The relay is not trusted for keys: it records (member, device, signature key, pin identity) under
// the member it authenticated, and serves that with KeyPackages and revocation records, so that it
// can route and bound. Peers pin what they verified. It never parses MLS (no library here): a
// KeyPackage is opaque bytes with the expiry its uploader declared, and devices check the real one.
//
// Every change is one transaction, committed before its answer. KeyPackages are single use: a take
// moves the package out of the pool into a reservation in the same transaction; a retry of the
// same request (same requester device, same target) returns the same package; a reservation ends
// once, as used (by 3.3's accepted commit), burned (abandoned: never back to the pool) or expired.
//
// Suspension (design 4.4, "Device suspension"): a restore that could not read the store it replaced
// suspends every device, since revocations made after the backup may be lost. A suspended device
// is out of service here until the relay owner reinstates it: every lookup of an active device
// refuses it (uploads, takes, its own revocations of others, reservations it uses), re-registration
// of the same id refuses it and leaves the flag set, and it has no directory entry and serves no
// KeyPackage. It still counts toward the member's device limit; revoking it is allowed. (3.3's
// Delivery Service, attach and queued dispatch are not on this branch; they check it too when they
// arrive.)
import crypto from "node:crypto";
import { APPROVAL_MAX_S, APPROVAL_SKEW_S, DEVICE_ID_RE, checkApproval, displayFingerprint, pinIdentity, readApproval, readRotation, checkRevocation, b64 } from "./identity.js";
import { DEVICES_PER_MEMBER, KP_LIFETIME_MS, KP_MAX_PER_DEVICE, RESERVATION_ABANDON_MS, WELCOME_REPLAY_KEEP_MS } from "./policy.js";

export const MAX_KP_BYTES = 16 * 1024;
const MAX_REVOKED_PER_MEMBER = 1000; // revoked ids are kept forever (never reused), within a bound
const ROTATIONS_KEPT = 10; // a longer gap is a key change for peers anyway
const REQUEST_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LIFETIME_SLACK_MS = 5 * 60_000; // clock skew between a device and the relay
export const SWEEP_BATCH = 256; // rows per statement in one sweep transaction (design 6)
const SWEEP_BATCHES = 64; // transactions per sweep call

/** 3.2's tables: migration 1 of the relay's store (3.3 appends its own). */
export const DEVICE_MIGRATIONS = [
  `CREATE TABLE devices (
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     sig_key BLOB NOT NULL,
     pin BLOB NOT NULL,
     seq INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL,
     PRIMARY KEY (member_id, device_id)
   ) STRICT;
   CREATE TABLE device_rotations (
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     statement TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (member_id, device_id, seq),
     FOREIGN KEY (member_id, device_id) REFERENCES devices (member_id, device_id)
   ) STRICT;
   CREATE TABLE device_revocations (
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     by_kind TEXT NOT NULL CHECK (by_kind IN ('device', 'admin')),
     by_device TEXT,
     statement TEXT,
     PRIMARY KEY (member_id, device_id)
   ) STRICT;
   CREATE TABLE key_packages (
     ref TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     kp BLOB NOT NULL,
     not_after INTEGER NOT NULL,
     uploaded INTEGER NOT NULL,
     FOREIGN KEY (member_id, device_id) REFERENCES devices (member_id, device_id)
   ) STRICT;
   CREATE INDEX key_packages_pool ON key_packages (member_id, device_id, not_after);
   CREATE TABLE kp_reservations (
     reservation TEXT PRIMARY KEY,
     requester_member TEXT NOT NULL,
     requester_device TEXT NOT NULL,
     request TEXT NOT NULL,
     target_member TEXT NOT NULL,
     target_device TEXT NOT NULL,
     ref TEXT NOT NULL UNIQUE,
     kp BLOB,
     not_after INTEGER NOT NULL,
     taken_at INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('reserved', 'used', 'burned', 'expired')),
     ended_at INTEGER,
     UNIQUE (requester_member, requester_device, request)
   ) STRICT;
   CREATE INDEX kp_reservations_state ON kp_reservations (state, taken_at);`,
];

// A12 (amendments 3.5 part 3): a new device of a member that already has an enrolled, unrevoked
// device (suspended ones included) registers only with an approval, by one of that member's
// devices or by the relay admin, of a pending request the new device made first.
export const PENDING_ORDINARY = 4; // ordinary pending requests per member
export const PENDING_RESERVED = 1; // plus one slot only for a request a device of the member expected
export const PENDING_MS = 24 * 3_600_000; // a pending request, a cancelled request's block and an expectation
const APPROVAL_FIELDS = ["realm", "member", "approver", "device", "key", "issued_at", "expiry", "sig"];

/**
 * A12's tables, a migration appended after the others (lib/relaystore.js): pending requests (one
 * per device id; the approval recorded on it until the new device's registration consumes both),
 * the 24-hour blocks of cancelled (device, key) pairs, and each member's one expectation (device
 * id and pin identity) for the reserved slot. Nothing here is a device: no guard, directory entry,
 * KeyPackage or delivery reads these tables.
 */
export const APPROVAL_MIGRATION = `CREATE TABLE device_requests (
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     sig_key BLOB NOT NULL,
     pin BLOB NOT NULL,
     reserved INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL,
     expires INTEGER NOT NULL,
     approver_kind TEXT CHECK (approver_kind IN ('device', 'admin')),
     approver_device TEXT,
     approver_key BLOB,
     approval TEXT,
     approval_expires INTEGER,
     PRIMARY KEY (member_id, device_id)
   ) STRICT;
   CREATE INDEX device_requests_expires ON device_requests (expires);
   CREATE TABLE device_request_blocks (
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     sig_key BLOB NOT NULL,
     until INTEGER NOT NULL,
     PRIMARY KEY (member_id, device_id, sig_key)
   ) STRICT;
   CREATE INDEX device_request_blocks_until ON device_request_blocks (until);
   CREATE TABLE device_expectations (
     member_id TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     pin BLOB NOT NULL,
     by_device TEXT,
     expires INTEGER NOT NULL
   ) STRICT;`;

/** Whether the store has A12's tables (a store opened before that migration, in tests, has not). */
export const hasRequests = (db) => Boolean(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'device_requests'"));

/** Whether the store has the device suspension column (design 4.4, migration 4). */
export const hasSuspension = (db) => Number(db.get("SELECT count(*) AS n FROM pragma_table_info('devices') WHERE name = 'suspended'").n) > 0;

/** A refusal with a code for the frame's answer. */
export class DirectoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const refuse = (code, message) => {
  throw new DirectoryError(code, message);
};

const newReservationId = () => `r_${crypto.randomBytes(16).toString("hex")}`;
export const packageRef = (kp) => crypto.createHash("sha256").update(kp).digest("hex");

/**
 * The directory over an open relay database `db` (openRelayDb with DEVICE_MIGRATIONS), for realm
 * `realm`. `now()` is the clock (tests move it).
 */
export function createDeviceDirectory({ db, realm, now = () => Date.now() }) {
  // A store not yet at the relay admin's migration (4.4) has no suspension column; only a restore,
  // which needs that migration, suspends devices, so none there is suspended.
  const SUSPENDED = hasSuspension(db) ? "suspended" : "0 AS suspended";
  // Before A12's migration there is no pending request to consume: a second device is refused.
  const REQUESTS = hasRequests(db);
  const deviceRow = (h, member, device) => h.get(`SELECT member_id, device_id, sig_key, pin, seq, created, ${SUSPENDED} FROM devices WHERE member_id = ? AND device_id = ?`, member, device);
  const revocationRow = (h, member, device) => h.get("SELECT at, by_kind, by_device, statement FROM device_revocations WHERE member_id = ? AND device_id = ?", member, device);
  const checkDeviceId = (d) => (typeof d === "string" && DEVICE_ID_RE.test(d)) || refuse("bad_request", "device must be a device id");

  const suspendedMessage = (what, device) => `${what} ${device} is suspended after a restore of the relay's store; the relay owner reinstates it (hoptell relay admin devices reinstate), or enroll a new device`;
  /** An enrolled device of `member`, neither revoked nor suspended, or a refusal. */
  function activeDevice(h, member, device, what = "device") {
    checkDeviceId(device);
    if (revocationRow(h, member, device)) refuse("device_revoked", `${what} ${device} is revoked`);
    const row = deviceRow(h, member, device) ?? refuse("no_device", `${what} ${device} is not enrolled`);
    if (row.suspended) refuse("device_suspended", suspendedMessage(what, device));
    return row;
  }

  /**
   * Enroll a device (or confirm it, idempotently), or rotate its key with a statement signed by
   * the current key and the new one. A revoked id is refused; another key without a valid
   * rotation is refused (a replacement is a new device).
   */
  function register({ member, device, key, pin, rotation = null }) {
    checkDeviceId(device);
    const k = Buffer.from(key ?? []);
    if (k.length !== 32) refuse("bad_request", "key must be a 32-byte signature public key");
    const expected = pinIdentity({ realm, member, device, key: k });
    if (!pin || !Buffer.from(pin).equals(expected)) refuse("bad_pin", "the pin identity does not match (realm, member, device, key)");
    return db.tx((h) => {
      if (revocationRow(h, member, device)) refuse("device_revoked", `device ${device} was revoked; a revoked device id is never used again: enroll a new device`);
      const row = deviceRow(h, member, device);
      const t = now();
      // Neither the idempotent answer nor a rotation reinstates a suspended device.
      if (row?.suspended) refuse("device_suspended", suspendedMessage("device", device));
      if (!row) {
        if (rotation) refuse("no_device", `device ${device} is not enrolled`);
        const n = enrolledCount(h, member);
        if (n >= DEVICES_PER_MEMBER) refuse("too_many_devices", `a member has at most ${DEVICES_PER_MEMBER} enrolled devices; revoke one first`);
        // A12: only a member with no enrolled, unrevoked device at all (suspended ones count)
        // registers without an approval (the bootstrap). Otherwise the approval recorded on this
        // device's pending request is consumed here, with the request, in this transaction.
        const approvedBy = n > 0 ? consumeApproval(h, member, device, k, t) : null;
        if (REQUESTS) {
          h.run("DELETE FROM device_requests WHERE member_id = ? AND device_id = ?", member, device);
          h.run("DELETE FROM device_expectations WHERE member_id = ? AND device_id = ?", member, device);
        }
        h.run("INSERT INTO devices (member_id, device_id, sig_key, pin, seq, created) VALUES (?, ?, ?, ?, 0, ?)", member, device, k, expected, t);
        return { state: "enrolled", seq: 0, ...(approvedBy ? { approvedBy } : {}) };
      }
      if (Buffer.from(row.sig_key).equals(k)) return { state: "unchanged", seq: row.seq };
      if (!rotation) refuse("key_mismatch", `device ${device} is enrolled with another key; rotate with a statement from the current key, or enroll a new device`);
      const s = readRotation(rotation);
      if (!s || s.realm !== realm || s.member !== member || s.device !== device || !s.oldKey.equals(Buffer.from(row.sig_key)) || !s.newKey.equals(k) || s.sequence !== row.seq + 1) {
        refuse("bad_rotation", "the rotation statement does not chain from the enrolled key");
      }
      h.run("UPDATE devices SET sig_key = ?, pin = ?, seq = ? WHERE member_id = ? AND device_id = ?", k, expected, s.sequence, member, device);
      h.run("INSERT INTO device_rotations (member_id, device_id, seq, statement, at) VALUES (?, ?, ?, ?, ?)", member, device, s.sequence, JSON.stringify(rotation), t);
      h.run("DELETE FROM device_rotations WHERE member_id = ? AND device_id = ? AND seq <= ?", member, device, s.sequence - ROTATIONS_KEPT);
      // Packages of the old key are no longer served (they would bind the retired key), and open
      // reservations of them burn.
      h.run("DELETE FROM key_packages WHERE member_id = ? AND device_id = ?", member, device);
      h.run("UPDATE kp_reservations SET state = 'burned', ended_at = ?, kp = NULL WHERE target_member = ? AND target_device = ? AND state = 'reserved'", t, member, device);
      return { state: "rotated", seq: s.sequence };
    });
  }

  // ---- A12: pending requests and approvals --------------------------------------------------------

  /** A member's enrolled devices that are not revoked, suspended ones included. */
  const enrolledCount = (h, member) => h.get("SELECT count(*) AS n FROM devices d WHERE member_id = ? AND NOT EXISTS (SELECT 1 FROM device_revocations r WHERE r.member_id = d.member_id AND r.device_id = d.device_id)", member).n;
  /** The live (unexpired) pending request of a device id, or null. */
  const requestRow = (h, member, device, t) => h.get("SELECT * FROM device_requests WHERE member_id = ? AND device_id = ? AND expires > ?", member, device, t) ?? null;
  const approverMessage = "a new device of a member that already has a device needs an approval: the new device asks (device_request), then one of the member's devices accepts it (hoptell device accept <device>), or the relay admin approves it (hoptell members device-approve)";

  /**
   * Inside register's transaction: the approval on `device`'s live pending request for key `k`,
   * checked again (unexpired; a device approver still enrolled, unrevoked, unsuspended and with
   * the key it was verified against). Returns who approved ("device" or "admin"), or refuses.
   */
  function consumeApproval(h, member, device, k, t) {
    const req = REQUESTS ? requestRow(h, member, device, t) : null;
    if (!req || !req.approver_kind) refuse("approval_required", `device ${device} is not approved: ${approverMessage}`);
    if (!Buffer.from(req.sig_key).equals(k)) refuse("key_mismatch", `the pending request of device ${device} is for another key`);
    const why = approvalProblem(h, member, req, t);
    if (why) refuse(why.code, why.message);
    return req.approver_kind;
  }

  /**
   * Why the approval recorded on pending request `req` no longer holds, or null: expired, or a
   * device approver now revoked, unenrolled, suspended or with another key than the one its
   * approval was verified against.
   */
  function approvalProblem(h, member, req, t) {
    if (req.approval_expires <= t) return { code: "approval_expired", message: `the approval of device ${req.device_id} expired; approve it again` };
    if (req.approver_kind !== "device") return null;
    const by = req.approver_device;
    const row = deviceRow(h, member, by);
    const why = revocationRow(h, member, by) ? "is revoked" : !row ? "is not enrolled" : row.suspended ? "is suspended" : !Buffer.from(row.sig_key).equals(Buffer.from(req.approver_key)) ? "has another key than the one its approval was verified against" : null;
    return why ? { code: "approval_invalid", message: `the device that approved ${req.device_id} (${by}) ${why} now; approve it again from an active device` } : null;
  }

  /**
   * The state a pending request is reported in: "approved" only while its approval still holds.
   * An approval that no longer does is dropped here (`h` a write transaction), so the request is
   * pending again and a fresh approval can be recorded; read-only callers pass `drop` false.
   */
  function reportedState(h, member, req, t, drop = true) {
    if (!req.approver_kind) return "pending";
    if (!approvalProblem(h, member, req, t)) return "approved";
    if (drop) h.run("UPDATE device_requests SET approver_kind = NULL, approver_device = NULL, approver_key = NULL, approval = NULL, approval_expires = NULL WHERE member_id = ? AND device_id = ?", member, req.device_id);
    return "pending";
  }

  /**
   * A new device asks to be registered (the caller proved possession of `key`): a pending request,
   * inactive, at most PENDING_ORDINARY per member plus PENDING_RESERVED for a request matching the
   * member's expectation (device id and pin identity), one per device id, for 24 hours. A request
   * for a (device, key) already registered or pending is answered with its state:
   * {state: "not_required" | "registered" | "pending" | "approved", expires?}.
   */
  function request({ member, device, key }) {
    checkDeviceId(device);
    const k = Buffer.from(key ?? []);
    if (k.length !== 32) refuse("bad_request", "key must be a 32-byte signature public key");
    const pin = pinIdentity({ realm, member, device, key: k });
    return db.tx((h) => {
      const t = now();
      if (revocationRow(h, member, device)) refuse("device_revoked", `device ${device} was revoked; a revoked device id is never used again: enroll a new device`);
      const row = deviceRow(h, member, device);
      if (row) {
        if (Buffer.from(row.sig_key).equals(k)) return { state: "registered" };
        refuse("key_mismatch", `device ${device} is enrolled with another key; a new key for it needs a rotation statement, not a request`);
      }
      // The bootstrap: nothing to approve, the device registers directly.
      if (enrolledCount(h, member) === 0) return { state: "not_required" };
      h.run("DELETE FROM device_requests WHERE member_id = ? AND expires <= ?", member, t);
      const live = requestRow(h, member, device, t);
      if (live) {
        if (!Buffer.from(live.sig_key).equals(k)) refuse("request_pending", `a request for device ${device} with another key is pending; a device id has one pending request (it expires, or one of the member's devices cancels it: hoptell device pending --cancel ${device})`);
        return { state: reportedState(h, member, live, t), expires: live.expires };
      }
      const block = h.get("SELECT until FROM device_request_blocks WHERE member_id = ? AND device_id = ? AND sig_key = ? AND until > ?", member, device, k, t);
      if (block) refuse("request_blocked", `this request for device ${device} was cancelled; it cannot be made again before ${new Date(block.until).toISOString()}`);
      const ex = h.get("SELECT device_id, pin FROM device_expectations WHERE member_id = ? AND expires > ?", member, t);
      const expected = Boolean(ex && ex.device_id === device && Buffer.from(ex.pin).equals(pin));
      const used = h.get("SELECT sum(reserved = 0) AS ordinary, sum(reserved = 1) AS reserved FROM device_requests WHERE member_id = ?", member);
      let reserved;
      if (expected && Number(used.reserved ?? 0) < PENDING_RESERVED) reserved = 1;
      else if (Number(used.ordinary ?? 0) < PENDING_ORDINARY) reserved = 0;
      else refuse("too_many_requests", `this member has ${PENDING_ORDINARY} pending device requests${expected ? " and its reserved one" : ""}; its devices can list and cancel them (hoptell device pending), or a device expects this one (hoptell device expect)`);
      const expires = t + PENDING_MS;
      h.run("INSERT INTO device_requests (member_id, device_id, sig_key, pin, reserved, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)", member, device, k, pin, reserved, t, expires);
      return { state: "pending", expires };
    });
  }

  /**
   * A member's live pending requests: [{member, device, key, requested, expires, approved,
   * approvedBy}] (only for its own devices and the admin); `approved` says an approval that still
   * holds waits for the device's registration.
   */
  function pending(member, { drop = true } = {}) {
    const read = (h) => {
      const t = now();
      return h.all("SELECT * FROM device_requests WHERE (? IS NULL OR member_id = ?) AND expires > ? ORDER BY member_id, created, device_id", member, member, t).map((r) => {
        const approved = reportedState(h, r.member_id, r, t, drop) === "approved";
        return { member: r.member_id, device: r.device_id, key: b64(r.sig_key), requested: r.created, expires: r.expires, approved, approvedBy: approved ? r.approver_kind : null };
      });
    };
    // The admin's view reads only (`drop` false, any member with `member` null); the member's
    // devices' view drops an approval that no longer holds, as device_request does.
    return drop ? db.tx(read) : read(db);
  }

  /**
   * Cancel a pending request (by a proven device of the member, or the admin: `by`); its (device,
   * key) cannot be requested again for 24 hours. `record(h, state)` writes an audit row in the
   * same transaction. {state: "cancelled" | "none"}.
   */
  function cancel({ member, device, by, record = () => {} }) {
    checkDeviceId(device);
    return db.tx((h) => {
      const t = now();
      if (by.kind === "device") activeDevice(h, member, by.device, "your device");
      const req = requestRow(h, member, device, t);
      if (req) {
        h.run("DELETE FROM device_requests WHERE member_id = ? AND device_id = ?", member, device);
        h.run("INSERT INTO device_request_blocks (member_id, device_id, sig_key, until) VALUES (?, ?, ?, ?) ON CONFLICT (member_id, device_id, sig_key) DO UPDATE SET until = excluded.until", member, device, req.sig_key, t + PENDING_MS);
      }
      const state = req ? "cancelled" : "none";
      record(h, state);
      return { state };
    }, { cls: "maintenance" });
  }

  /**
   * A proven device of the member expects new device `device` with pin identity `pin` (32 bytes):
   * for 24 hours, a request for exactly that device id whose key gives that pin may use the
   * reserved slot. One expectation per member; a new one replaces it.
   */
  function expect({ member, device, pin, by }) {
    checkDeviceId(device);
    const p = Buffer.from(pin ?? []);
    if (p.length !== 32) refuse("bad_request", "pin must be a 32-byte pin identity");
    return db.tx((h) => {
      const t = now();
      activeDevice(h, member, by, "your device");
      const expires = t + PENDING_MS;
      h.run("INSERT INTO device_expectations (member_id, device_id, pin, by_device, expires) VALUES (?, ?, ?, ?, ?) ON CONFLICT (member_id) DO UPDATE SET device_id = excluded.device_id, pin = excluded.pin, by_device = excluded.by_device, expires = excluded.expires", member, device, p, by, expires);
      return { expires };
    });
  }

  /**
   * Record an approval (wire form, see identity.js makeApproval) by device `by` of `member` on the
   * new device's live pending request: signed by the approver's currently registered key, not by
   * the new device itself, issued at most 5 minutes in the relay's future, valid at most 24 hours
   * and not expired. The registration consumes it. An identical approval again is success.
   * {state: "approved" | "registered"} ("registered": the device already is, with that key).
   */
  function approve({ member, approval, by, requested }) {
    const a = readApproval(approval) ?? refuse("bad_approval", "the approval is malformed");
    if (a.realm !== realm || a.member !== member) refuse("bad_approval", "the approval is for another realm or member");
    if (a.approver !== by) refuse("bad_approval", "the approval names another approving device than this connection's");
    if (a.approver === a.device) refuse("bad_approval", "a device cannot approve itself");
    const t = now();
    const ts = Math.floor(t / 1000);
    if (a.issuedAt > ts + APPROVAL_SKEW_S) refuse("bad_approval", "the approval is issued more than 5 minutes in the relay's future");
    if (a.expiry > a.issuedAt + APPROVAL_MAX_S) refuse("bad_approval", "an approval is valid for at most 24 hours");
    if (a.expiry <= ts) refuse("approval_expired", "the approval expired");
    const wire = JSON.stringify(Object.fromEntries(APPROVAL_FIELDS.map((f) => [f, approval[f]])));
    return db.tx((h) => {
      const signer = activeDevice(h, member, a.approver, "the approving device");
      if (!checkApproval(a, Buffer.from(signer.sig_key))) refuse("bad_approval", "the approval is not signed by the approving device's registered key");
      if (revocationRow(h, member, a.device)) refuse("device_revoked", `device ${a.device} is revoked`);
      const row = deviceRow(h, member, a.device);
      if (row) {
        if (Buffer.from(row.sig_key).equals(a.key)) return { state: "registered" };
        refuse("key_mismatch", `device ${a.device} is enrolled with another key`);
      }
      const req = requestRow(h, member, a.device, t) ?? refuse("no_request", `no pending request of device ${a.device}: it expired, was cancelled or was never made`);
      if (!Buffer.from(req.sig_key).equals(a.key)) refuse("key_mismatch", `the pending request of device ${a.device} is for another key than the approved one`);
      // A12: only for the request instance the owner accepted: `requested` (its creation time as
      // device_pending reported it, sent unsigned next to the approval by the member's proven
      // device) must be the live request's, checked in this transaction. A request renewed after
      // an expiry or cancellation needs a fresh hoptell device accept.
      if (!Number.isSafeInteger(requested) || Number(req.created) !== requested) refuse("request_gone", `the request of device ${a.device} this approval was made for is gone (it expired or was cancelled, and the device asked again): approve the new request with hoptell device accept ${a.device}`);
      if (req.approval === wire) return { state: "approved" };
      h.run("UPDATE device_requests SET approver_kind = 'device', approver_device = ?, approver_key = ?, approval = ?, approval_expires = ? WHERE member_id = ? AND device_id = ?", a.approver, Buffer.from(signer.sig_key), wire, a.expiry * 1000, member, a.device);
      return { state: "approved" };
    });
  }

  /**
   * The relay admin approves a pending request (no device can: all suspended, or all lost), named
   * by member, device and the display fingerprint of its key as the new device shows it; valid for
   * 24 hours and consumed by the registration like a device's. `record(h)` writes the audit row in
   * the same transaction. {state: "approved", expires}.
   */
  function adminApprove({ member, device, fingerprint, record = () => {} }) {
    checkDeviceId(device);
    const norm = (x) => String(x ?? "").replace(/\s+/g, "");
    return db.tx((h) => {
      const t = now();
      const req = requestRow(h, member, device, t) ?? refuse("no_request", `no pending request of device ${device}`);
      if (norm(displayFingerprint({ realm, member, device, key: Buffer.from(req.sig_key) })) !== norm(fingerprint)) refuse("fingerprint_mismatch", `the fingerprint does not match the pending request of device ${device}: compare it with what the new device shows`);
      const expires = t + PENDING_MS;
      h.run("UPDATE device_requests SET approver_kind = 'admin', approver_device = NULL, approver_key = NULL, approval = NULL, approval_expires = ? WHERE member_id = ? AND device_id = ?", expires, member, device);
      record(h);
      return { state: "approved", expires };
    }, { cls: "maintenance" });
  }

  /** A member's devices, with their pin identities, recent rotations and revocation records. */
  function list(member) {
    const devices = db.all(`SELECT device_id, sig_key, pin, seq, created, ${SUSPENDED} FROM devices WHERE member_id = ? ORDER BY created, device_id`, member);
    const revoked = new Map(db.all("SELECT device_id, at, by_kind, by_device, statement FROM device_revocations WHERE member_id = ?", member).map((r) => [r.device_id, r]));
    const out = devices.map((d) => {
      const r = revoked.get(d.device_id);
      revoked.delete(d.device_id);
      return {
        device: d.device_id,
        // A revoked device's directory entry is no longer served: only its revocation record. A
        // suspended one has none either until it is reinstated.
        ...(r || d.suspended ? {} : { key: b64(d.sig_key), pin: b64(d.pin), seq: d.seq, rotations: db.all("SELECT statement FROM device_rotations WHERE member_id = ? AND device_id = ? ORDER BY seq", member, d.device_id).map((x) => JSON.parse(x.statement)) }),
        created: d.created,
        ...(r ? { revoked: revocationOut(r) } : d.suspended ? { suspended: true } : {}),
      };
    });
    for (const r of revoked.values()) out.push({ device: r.device_id, revoked: revocationOut(r) });
    return out;
  }
  const revocationOut = (r) => ({ at: r.at, by: r.by_kind, ...(r.by_device ? { device: r.by_device } : {}), ...(r.statement ? { statement: JSON.parse(r.statement) } : {}) });

  /** Publish KeyPackages of an enrolled device ({kp: bytes, notAfter: ms}); duplicates are ignored. */
  function upload({ member, device, packages }) {
    if (!Array.isArray(packages) || !packages.length || packages.length > KP_MAX_PER_DEVICE) refuse("bad_request", `upload 1 to ${KP_MAX_PER_DEVICE} KeyPackages`);
    const t = now();
    for (const p of packages) {
      if (!(p.kp instanceof Uint8Array) || !p.kp.length || p.kp.length > MAX_KP_BYTES) refuse("bad_request", `a KeyPackage has 1 to ${MAX_KP_BYTES} bytes`);
      if (!Number.isSafeInteger(p.notAfter) || p.notAfter <= t || p.notAfter > t + KP_LIFETIME_MS + LIFETIME_SLACK_MS) refuse("bad_request", "a KeyPackage's not_after must be in the future and within 14 days");
    }
    return db.tx((h) => {
      activeDevice(h, member, device);
      dropExpired(h, member, device, t);
      let accepted = 0;
      for (const p of packages) {
        const ref = packageRef(p.kp);
        // Single use: a package that was ever taken (its reservation is kept past its expiry) never returns.
        if (h.get("SELECT 1 AS x FROM key_packages WHERE ref = ? UNION ALL SELECT 1 FROM kp_reservations WHERE ref = ?", ref, ref)) continue;
        const outstanding = h.get("SELECT (SELECT count(*) FROM key_packages WHERE member_id = ? AND device_id = ?) + (SELECT count(*) FROM kp_reservations WHERE target_member = ? AND target_device = ? AND state = 'reserved') AS n", member, device, member, device).n;
        if (outstanding >= KP_MAX_PER_DEVICE) refuse("too_many_key_packages", `a device has at most ${KP_MAX_PER_DEVICE} outstanding KeyPackages`);
        h.run("INSERT INTO key_packages (ref, member_id, device_id, kp, not_after, uploaded) VALUES (?, ?, ?, ?, ?, ?)", ref, member, device, Buffer.from(p.kp), p.notAfter, t);
        accepted++;
      }
      return { accepted, ...poolOf(h, member, device, t) };
    });
  }

  function poolOf(h, member, device, t) {
    const p = h.get("SELECT count(*) AS n, min(not_after) AS oldest FROM key_packages WHERE member_id = ? AND device_id = ? AND not_after > ?", member, device, t);
    const r = h.get("SELECT count(*) AS n FROM kp_reservations WHERE target_member = ? AND target_device = ? AND state = 'reserved'", member, device);
    return { available: p.n, reserved: r.n, oldestExpires: p.oldest ?? null };
  }
  /** The pool of one of the caller's own devices, for replenishment. */
  function status({ member, device }) {
    checkDeviceId(device);
    const t = now();
    activeDevice(db, member, device);
    return poolOf(db, member, device, t);
  }

  /**
   * Take a KeyPackage of `target` ({member, device}) for `requester` ({member, device}, one of the
   * caller's own enrolled devices) under request id `request`. The same request with the same
   * target returns the same reservation while it is open; a changed target, or a reservation that
   * already ended (used, burned, expired), is refused. An empty pool: "no KeyPackage available".
   */
  function take({ requester, request, target }) {
    if (typeof request !== "string" || !REQUEST_RE.test(request)) refuse("bad_request", "request must be a request id (8 to 64 letters, digits, '_' or '-')");
    checkDeviceId(target?.device);
    return db.tx((h) => {
      activeDevice(h, requester.member, requester.device, "your device");
      const t = now();
      const prior = h.get("SELECT * FROM kp_reservations WHERE requester_member = ? AND requester_device = ? AND request = ?", requester.member, requester.device, request);
      if (prior) {
        if (prior.target_member !== target.member || prior.target_device !== target.device) refuse("request_reused", "this request id was used for another target");
        // (an open one past its package's expiry is ended by the sweep; it is refused already)
        const state = prior.state === "reserved" && prior.not_after <= t ? "expired" : prior.state;
        if (state !== "reserved") refuse("reservation_ended", `this request's reservation is ${state}; take a new one with a new request id`);
        return reservationOut(prior);
      }
      // A revoked, suspended or unknown target device looks the same: nothing is served for it.
      if (revocationRow(h, target.member, target.device) || !deviceRow(h, target.member, target.device) || deviceRow(h, target.member, target.device).suspended) refuse("no_device", "no such device");
      dropExpired(h, target.member, target.device, t);
      const kp = h.get("SELECT ref, kp, not_after FROM key_packages WHERE member_id = ? AND device_id = ? AND not_after > ? ORDER BY not_after, ref LIMIT 1", target.member, target.device, t);
      if (!kp) refuse("no_key_package", "no KeyPackage available for that device, try later");
      h.run("DELETE FROM key_packages WHERE ref = ?", kp.ref);
      const row = { reservation: newReservationId(), requester_member: requester.member, requester_device: requester.device, request, target_member: target.member, target_device: target.device, ref: kp.ref, kp: kp.kp, not_after: kp.not_after, taken_at: t };
      h.run(
        "INSERT INTO kp_reservations (reservation, requester_member, requester_device, request, target_member, target_device, ref, kp, not_after, taken_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')",
        row.reservation, row.requester_member, row.requester_device, row.request, row.target_member, row.target_device, row.ref, row.kp, row.not_after, row.taken_at,
      );
      return reservationOut(row);
    });
  }
  const reservationOut = (r) => {
    const d = deviceRow(db, r.target_member, r.target_device);
    return { reservation: r.reservation, ref: r.ref, kp: Buffer.from(r.kp), notAfter: r.not_after, takenAt: r.taken_at, member: r.target_member, device: r.target_device, ...(d ? { key: b64(d.sig_key), pin: b64(d.pin), seq: d.seq } : {}) };
  };

  /** End an open reservation; its package is never returned to the pool. */
  function endReservation(h, reservation, state, t) {
    h.run("UPDATE kp_reservations SET state = ?, ended_at = ?, kp = NULL WHERE reservation = ? AND state = 'reserved'", state, t, reservation);
  }

  /** The requester gives up a reservation (its candidate lost): the package burns. */
  function abandon({ requester, reservation }) {
    return db.tx((h) => {
      const r = h.get("SELECT state FROM kp_reservations WHERE reservation = ? AND requester_member = ? AND requester_device = ?", reservation, requester.member, requester.device);
      if (!r) refuse("no_reservation", "no such reservation of yours");
      if (r.state === "reserved") endReservation(h, reservation, "burned", now());
      return { state: r.state === "reserved" ? "burned" : r.state };
    }, { cls: "maintenance" });
  }

  /**
   * For 3.3's commit acceptance, inside its transaction `h`: mark the requester's reservations
   * used. Only open (reserved, unexpired) reservations of this requester device, for the targets
   * the commit adds, authorize an addition; anything else refuses the whole acceptance.
   */
  function useReservations(h, { requester, reservations, targets = null }) {
    const t = now();
    activeDevice(h, requester.member, requester.device, "your device");
    for (const id of reservations) {
      const r = h.get("SELECT * FROM kp_reservations WHERE reservation = ?", id);
      if (!r || r.requester_member !== requester.member || r.requester_device !== requester.device) refuse("no_reservation", "a referenced reservation is not this device's");
      if (r.state !== "reserved" || r.not_after <= t) refuse("reservation_ended", `reservation ${id} is ${r.state === "reserved" ? "expired" : r.state}`);
      if (targets && !targets.some((x) => x.member === r.target_member && x.device === r.target_device)) refuse("no_reservation", `reservation ${id} is for another device`);
      endReservation(h, id, "used", t);
    }
  }

  /**
   * Revoke a device: at once, its KeyPackages are no longer served (the pool is emptied and open
   * reservations burn) and its directory entry gives way to the revocation record. By another
   * enrolled device of the member (or itself) with a signed statement, or by the relay admin.
   */
  function revoke({ member, device, by, statement = null }) {
    checkDeviceId(device);
    return db.tx((h) => {
      const t = now();
      const existing = revocationRow(h, member, device);
      if (existing) return { state: "already", at: existing.at };
      if (by.kind === "device") {
        const signer = activeDevice(h, member, by.device, "the revoking device");
        if (!deviceRow(h, member, device)) refuse("no_device", `device ${device} is not enrolled`);
        if (!statement || statement.realm !== realm || statement.member !== member || statement.device !== device || statement.by !== by.device || !checkRevocation(statement, Buffer.from(signer.sig_key))) {
          refuse("bad_statement", "the revocation statement is not signed by the revoking device");
        }
      } else if (by.kind !== "admin") refuse("bad_request", "revocation by a device or the admin");
      const n = h.get("SELECT count(*) AS n FROM device_revocations WHERE member_id = ?", member).n;
      if (n >= MAX_REVOKED_PER_MEMBER) refuse("too_many_devices", "this member has too many revoked devices");
      h.run("INSERT INTO device_revocations (member_id, device_id, at, by_kind, by_device, statement) VALUES (?, ?, ?, ?, ?, ?)", member, device, t, by.kind, by.kind === "device" ? by.device : null, statement ? JSON.stringify(statement) : null);
      h.run("DELETE FROM key_packages WHERE member_id = ? AND device_id = ?", member, device);
      h.run("UPDATE kp_reservations SET state = 'burned', ended_at = ?, kp = NULL WHERE target_member = ? AND target_device = ? AND state = 'reserved'", t, member, device);
      return { state: "revoked", at: t };
    }, { cls: "maintenance" });
  }

  /** A device's expired pool packages (at most KP_MAX_PER_DEVICE rows: a bounded change). */
  function dropExpired(h, member, device, t) {
    h.run("DELETE FROM key_packages WHERE member_id = ? AND device_id = ? AND not_after <= ?", member, device, t);
  }

  /**
   * The timers: expired pool packages are dropped; open reservations burn after an hour without an
   * accepted commit, or expire with their package; ended reservations are forgotten once their
   * package expired and WELCOME_REPLAY_KEEP_MS passed (until then a re-upload cannot revive them).
   */
  function sweep() {
    const t = now();
    const out = { expired: 0, burned: 0, forgotten: 0 };
    // Batches of at most SWEEP_BATCH rows per statement, each its own maintenance transaction
    // (design 6: every write transaction stays under the store's allowance); at most SWEEP_BATCHES
    // per call, the next sweep resumes.
    for (let i = 0; i < SWEEP_BATCHES; i++) {
      const r = db.tx((h) => {
        const dropped = Number(h.run(`DELETE FROM key_packages WHERE rowid IN (SELECT rowid FROM key_packages WHERE not_after <= ? LIMIT ${SWEEP_BATCH})`, t).changes);
        const expired = Number(h.run(`UPDATE kp_reservations SET state = 'expired', ended_at = ?, kp = NULL WHERE rowid IN (SELECT rowid FROM kp_reservations WHERE state = 'reserved' AND not_after <= ? LIMIT ${SWEEP_BATCH})`, t, t).changes);
        const burned = Number(h.run(`UPDATE kp_reservations SET state = 'burned', ended_at = ?, kp = NULL WHERE rowid IN (SELECT rowid FROM kp_reservations WHERE state = 'reserved' AND taken_at <= ? LIMIT ${SWEEP_BATCH})`, t, t - RESERVATION_ABANDON_MS).changes);
        const forgotten = Number(h.run(`DELETE FROM kp_reservations WHERE rowid IN (SELECT rowid FROM kp_reservations WHERE state <> 'reserved' AND not_after <= ? AND ended_at <= ? LIMIT ${SWEEP_BATCH})`, t, t - WELCOME_REPLAY_KEEP_MS).changes);
        // A12: expired pending requests, blocks and expectations (reads treat them as absent already).
        const requests = !REQUESTS ? 0 : Number(h.run(`DELETE FROM device_requests WHERE rowid IN (SELECT rowid FROM device_requests WHERE expires <= ? LIMIT ${SWEEP_BATCH})`, t).changes) + Number(h.run(`DELETE FROM device_request_blocks WHERE rowid IN (SELECT rowid FROM device_request_blocks WHERE until <= ? LIMIT ${SWEEP_BATCH})`, t).changes) + Number(h.run(`DELETE FROM device_expectations WHERE rowid IN (SELECT rowid FROM device_expectations WHERE expires <= ? LIMIT ${SWEEP_BATCH})`, t).changes);
        return { dropped, expired, burned, forgotten, requests };
      }, { cls: "maintenance" });
      out.expired += r.expired;
      out.burned += r.burned;
      out.forgotten += r.forgotten;
      if (Math.max(r.dropped, r.expired, r.burned, r.forgotten, r.requests) < SWEEP_BATCH) break;
    }
    return out;
  }

  /**
   * The relay admin's revocations from the members file (applied at start, on reload, and again
   * at the sweep until they all are). Each device is its own transaction and a failure does not
   * stop the others; returns the number newly revoked, or throws once all were tried, naming how
   * many failed (`failed`: [{member, device}]).
   */
  function applyAdminRevocations(list) {
    let n = 0;
    const failed = [];
    let first = null;
    for (const { member, device } of list) {
      try {
        if (revoke({ member, device, by: { kind: "admin" } }).state === "revoked") n++;
      } catch (e) {
        failed.push({ member, device });
        first ??= e;
      }
    }
    if (failed.length) throw Object.assign(new Error(`${failed.length} of ${list.length} device revocation(s) not stored (${first.message})`), { code: first.code, failed, applied: n });
    return n;
  }

  /**
   * End a device's suspension (design 4.4 `devices reinstate`), after the relay owner checked with
   * the member that it was not revoked after the backup. `record(h)` writes the audit row in the
   * same transaction: if it throws, nothing changes. {state: "reinstated" | "not_suspended"}.
   */
  function reinstate({ member, device, record = () => {} }) {
    checkDeviceId(device);
    return db.tx((h) => {
      if (revocationRow(h, member, device)) refuse("device_revoked", `device ${device} is revoked; a revoked device is never reinstated`);
      const row = deviceRow(h, member, device) ?? refuse("no_device", `device ${device} is not enrolled`);
      const state = row.suspended ? "reinstated" : "not_suspended";
      if (row.suspended) h.run("UPDATE devices SET suspended = 0 WHERE member_id = ? AND device_id = ?", member, device);
      record(h, state);
      return { state };
    }, { cls: "maintenance" });
  }

  /**
   * The registered signature key and sequence of an enrolled device of `member`, neither revoked
   * nor suspended (A9: proofs are checked against it, and an attachment stays valid only while it
   * is unchanged), or a refusal.
   */
  function current({ member, device }) {
    const row = activeDevice(db, member, device);
    return { key: Buffer.from(row.sig_key), seq: row.seq };
  }

  return { register, list, upload, status, take, abandon, useReservations, revoke, sweep, applyAdminRevocations, reinstate, current, request, pending, cancel, expect, approve, adminApprove };
}
