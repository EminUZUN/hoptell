// The relay's Delivery Service role for encrypted direct messages (design 3.3, "Conversations
// and groups", "Relay: Delivery Service", "Limits"), on the relay's durable storage
// (lib/relaydb.js) next to 3.2's device directory. EXPERIMENTAL: the relay uses it only when
// started with --experimental-e2ee.
//
// The relay sequences; clients accept cryptographically. It never parses MLS: a commit, a Welcome
// or an application message is opaque bytes. What it keeps:
//   conversations  the realm's canonical member pairs (member A < member B), each mapped to its
//                  current group by an atomic create-if-absent; a replacement (generation + 1)
//                  is explicit and makes the old group stop accepting messages
//   commit log     one accepted commit per (group, epoch), in positions 1, 2, ...; kept 30 days
//                  or 1,000 epochs per group, then a device that fell further behind replaces
//   routing roster the devices per group, changed only by accepted roster deltas; it routes,
//                  it is not membership (clients act on the authenticated MLS membership)
//   queue          message_e2ee frames per recipient device, durable until acknowledged. A
//                  message's MLS bytes (and a Welcome's ratchet tree) are stored once, in a payload
//                  row that each device's queue entry references (migration 7): a commit or message
//                  to many devices writes its large part once, so an acceptance's write transaction
//                  stays under the store's allowance A (design 6) at any roster size. A payload goes
//                  in the transaction that removes its last reference. Entries queued before
//                  migration 7 carry their frame whole and are delivered as they are
//   operations     every accepted operation by (requester member, device, op id): the digest of
//                  its exact payload and its result, so a retry after a lost answer or a restart
//                  returns the original result, and the same op id with another payload is refused
//   cancellations  an application message's op id that a reconciliation found unknown is recorded
//                  as cancelled (an operation of kind "cancelled") in the reconciliation's own
//                  transaction (MII3): the original request arriving later (a delayed or replayed
//                  frame) is refused with "op_cancelled" whatever its payload, so the client may
//                  seal the message again. At most CANCELLED_MAX per device (then the
//                  reconciliation is refused with "quota" and the client keeps its entry); they
//                  expire with the operations after OPS_KEEP_MS (30 days), well past the longest
//                  life of an application message (APP_QUEUE_MS): an original older than that
//                  carries content every receiver refuses by its acceptance window
//
// Every acceptance is one transaction: the commit-log entry, the roster delta, the Welcome
// recipients and their queue entries, the consumption of the referenced KeyPackage reservations
// (3.2's directory.useReservations inside it), the queue and quota changes, and the operation's
// result. Nothing is answered before it commits.
//
// A commit's `expected_epoch` E is the epoch it was made in (it moves the group to E + 1):
//   E equals the group's epoch                    accepted at the next position
//   E is below it, its accepted commit is another operation        conflict {winner}
//   (the same op id of the same requester)        the original result, whatever happened since
//   anything else (E ahead, or the winner no longer in the log)    stale_epoch
import crypto from "node:crypto";
import { DirectoryError, hasSuspension } from "./relaydir.js";
import { DAY } from "./policy.js";
import { outcome } from "./relaytransfers.js";

export const MAX_FRAME_BYTES = 512 * 1024; // a complete serialized frame (UTF-8 JSON as sent)
export const MAX_MLS_BYTES = 360 * 1024; // one decoded MLS message (480 KiB in base64)
export const MAX_GROUP_DEVICES = 100;
export const QUEUE_MAX_MESSAGES = 1000; // pending encrypted messages per device ...
export const QUEUE_MAX_BYTES = 20 * 1024 * 1024; // ... and their bytes, then "quota"
export const LOG_KEEP_MS = 30 * DAY;
export const LOG_KEEP_EPOCHS = 1000;
export const APP_QUEUE_MS = 7 * DAY + 5 * 60_000; // an application message's longest life, with the skew allowance
export const OPS_KEEP_MS = 30 * DAY; // as long as the log: a retry can always learn its result
export const CANCELLED_MAX = 1000; // cancelled op ids kept per requester device (MII3)
const INVALID_KEPT = 1000; // commit_invalid reports kept per group
const SWEEP_BATCH = 256; // rows per kind in one sweep transaction (design 6) ...
const SWEEP_BATCH_BYTES = 4 * 1024 * 1024; // ... and at most this much of their data
const SWEEP_BATCHES = 64; // transactions per sweep call
export const GROUP_RE = /^[0-9a-f]{32}$/;
export const OP_RE = /^o_[a-z2-7]{26}$/;
const RES_RE = /^r_[0-9a-f]{32}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 3.3's tables: migrations 2 and 3 of the relay's store, after DEVICE_MIGRATIONS. */
export const E2EE_MIGRATIONS = [
  `CREATE TABLE e2ee_conversations (
     member_a TEXT NOT NULL,
     member_b TEXT NOT NULL,
     group_id TEXT NOT NULL,
     generation INTEGER NOT NULL,
     PRIMARY KEY (member_a, member_b),
     CHECK (member_a < member_b)
   ) STRICT;
   CREATE TABLE e2ee_groups (
     group_id TEXT PRIMARY KEY,
     member_a TEXT NOT NULL,
     member_b TEXT NOT NULL,
     generation INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('active', 'replaced')),
     epoch INTEGER NOT NULL,
     last_position INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL,
     replaced_at INTEGER
   ) STRICT;
   CREATE TABLE e2ee_log (
     group_id TEXT NOT NULL REFERENCES e2ee_groups (group_id),
     position INTEGER NOT NULL,
     epoch INTEGER NOT NULL,
     op TEXT NOT NULL,
     requester_member TEXT NOT NULL,
     requester_device TEXT NOT NULL,
     mls BLOB NOT NULL,
     roster_delta TEXT NOT NULL,
     created INTEGER NOT NULL,
     PRIMARY KEY (group_id, position),
     UNIQUE (group_id, epoch)
   ) STRICT;
   CREATE TABLE e2ee_roster (
     group_id TEXT NOT NULL REFERENCES e2ee_groups (group_id),
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     PRIMARY KEY (group_id, device_id)
   ) STRICT;
   CREATE TABLE e2ee_ops (
     requester_member TEXT NOT NULL,
     requester_device TEXT NOT NULL,
     op TEXT NOT NULL,
     kind TEXT NOT NULL,
     digest TEXT NOT NULL,
     result TEXT NOT NULL,
     created INTEGER NOT NULL,
     PRIMARY KEY (requester_member, requester_device, op)
   ) STRICT;
   CREATE INDEX e2ee_ops_age ON e2ee_ops (created);
   CREATE TABLE e2ee_queue (
     delivery TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     group_id TEXT NOT NULL,
     target TEXT,
     frame TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     created INTEGER NOT NULL,
     expires INTEGER NOT NULL,
     seq INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX e2ee_queue_device ON e2ee_queue (member_id, device_id, seq);
   CREATE INDEX e2ee_queue_expiry ON e2ee_queue (expires);
   CREATE TABLE e2ee_invalid (
     group_id TEXT NOT NULL,
     epoch INTEGER NOT NULL,
     member_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     reason TEXT,
     at INTEGER NOT NULL,
     PRIMARY KEY (group_id, epoch, device_id)
   ) STRICT;`,
  // Migration 3: the principal that sent an application message, for the access recheck at
  // dispatch (JSON {memberId, identity, family}). Rows queued before it have none (NULL).
  `ALTER TABLE e2ee_queue ADD COLUMN sender TEXT;`,
];

/**
 * Migration 7 of the relay's store (design 6 review, after phase 6's 5 and 6): a queued frame's
 * large fields stored once per message. `e2ee_payloads.body` is JSON of the fields the frames of
 * one message share ({mls} or {mls, ratchet_tree}); `e2ee_queue.payload` references it, and the
 * entry's `frame` holds the rest. Existing entries keep payload NULL and their whole frame: they
 * stay deliverable unchanged, and nothing is rewritten (the migration is bounded).
 */
export const E2EE_PAYLOAD_MIGRATION = `CREATE TABLE e2ee_payloads (
     pid INTEGER PRIMARY KEY,
     body TEXT NOT NULL
   ) STRICT;
   ALTER TABLE e2ee_queue ADD COLUMN payload INTEGER REFERENCES e2ee_payloads (pid);
   CREATE INDEX e2ee_queue_payload ON e2ee_queue (payload) WHERE payload IS NOT NULL;`;

const refuse = (code, message, extra) => {
  throw Object.assign(new DirectoryError(code, message), extra ?? {});
};
const newDelivery = () => `e_${crypto.randomBytes(16).toString("hex")}`;
/** The digest an operation is bound to: its kind and the exact payload fields, in a fixed order. */
export const opDigest = (kind, fields) => crypto.createHash("sha256").update(JSON.stringify([kind, ...fields])).digest("hex");
const frameBytes = (frame) => Buffer.byteLength(JSON.stringify(frame), "utf8");
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** An MLS message in base64: at most MAX_MLS_BYTES once decoded. */
function checkMls(mls, what = "mls") {
  if (typeof mls !== "string" || !mls.length || mls.length % 4 !== 0 || !B64_RE.test(mls)) refuse("bad_request", `${what} must be base64`);
  if (mls.length > Math.ceil(MAX_MLS_BYTES / 3) * 4) refuse("too_large", `${what} is larger than ${MAX_MLS_BYTES} bytes`);
}

/** The canonical pair of a conversation: {a, b} with a < b (bytewise on the member ids). */
export function canonicalPair(x, y) {
  if (typeof x !== "string" || typeof y !== "string" || x === y) refuse("bad_request", "a conversation is two distinct members");
  return Buffer.compare(Buffer.from(x), Buffer.from(y)) < 0 ? { a: x, b: y } : { a: y, b: x };
}

/**
 * The Delivery Service over an open relay database `db` (openRelayDb with DEVICE_MIGRATIONS and
 * E2EE_MIGRATIONS) and the device directory `directory` of the same store. `now()` is the clock;
 * `limits` overrides the queue quota and the cancellation bound (tests). `transfers`: phase 6's
 * transfer store of the same database (lib/mls/relaytransfers.js), whose references an
 * application message may publish (`blobs`); without it a message with blobs is refused.
 */
export function createDeliveryService({ db, directory, realm, now = () => Date.now(), limits = {}, transfers = null, compat = {} }) {
  // `compat` exists only for tests that simulate a relay older than A4 (amendments-3.5-prep):
  // {recipientCheck: false} accepts an op with no device of the other member, {peerRecipients:
  // false} answers without the peerRecipients field. Nothing outside test/ sets it.
  const recipientCheck = compat.recipientCheck !== false;
  const answerPeers = compat.peerRecipients !== false;
  const quota = { messages: limits.messages ?? QUEUE_MAX_MESSAGES, bytes: limits.bytes ?? QUEUE_MAX_BYTES, cancelled: limits.cancelled ?? CANCELLED_MAX };
  let seq = Number(db.get("SELECT coalesce(max(seq), 0) AS s FROM e2ee_queue").s);
  // Suspension and the restore's replace_required mark (design 4.4) exist from migration 4 on; a
  // store before it has neither (only a restore, which needs that migration, sets them).
  const admin44 = hasSuspension(db);
  const SUSPENDED = admin44 ? "suspended" : "0 AS suspended";
  const REPLACE_REQUIRED = admin44 ? "replace_required" : "0 AS replace_required";
  // Shared payloads exist from migration 7 on; on a store before it every frame is stored whole.
  const payloads = Boolean(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'e2ee_payloads'"));

  /**
   * An enrolled device of `member`, neither revoked nor suspended (the requester of any operation,
   * an attaching device, a device added to a group). This is the Delivery Service's own check,
   * apart from the directory's: a suspended device attaches, publishes and reads nothing.
   */
  function activeDevice(h, member, device) {
    if (h.get("SELECT 1 AS x FROM device_revocations WHERE member_id = ? AND device_id = ?", member, device)) refuse("device_revoked", `device ${device} is revoked`);
    const d = h.get(`SELECT ${SUSPENDED} FROM devices WHERE member_id = ? AND device_id = ?`, member, device);
    if (!d) refuse("no_device", `device ${device} is not enrolled`);
    if (d.suspended) refuse("device_suspended", `device ${device} is suspended after a restore of the relay's store; the relay owner reinstates it, or enroll a new device`);
  }
  const groupRow = (h, group) => h.get(`SELECT *, ${REPLACE_REQUIRED} FROM e2ee_groups WHERE group_id = ?`, group);
  const inRoster = (h, group, device) => Boolean(h.get("SELECT 1 AS x FROM e2ee_roster WHERE group_id = ? AND device_id = ?", group, device));
  const roster = (h, group) => h.all("SELECT member_id, device_id FROM e2ee_roster WHERE group_id = ? ORDER BY member_id, device_id", group).map((r) => ({ member: r.member_id, device: r.device_id }));

  /**
   * The recorded operation of a requester: its result when the digest matches; a refusal otherwise;
   * null when new. A cancelled op id refuses every request with it but a reconciliation (MII3).
   */
  function priorOp(h, requester, op, digest, { reconcile = false } = {}) {
    const r = h.get("SELECT kind, digest, result FROM e2ee_ops WHERE requester_member = ? AND requester_device = ? AND op = ?", requester.member, requester.device, op);
    if (!r) return null;
    if (r.kind === "cancelled") {
      if (!reconcile) refuse("op_cancelled", "this operation id was cancelled by a reconciliation; nothing was accepted");
      return { ...JSON.parse(r.result), repeated: true };
    }
    if (r.digest !== digest) refuse("op_reused", "this operation id was used for a different payload");
    return { ...JSON.parse(r.result), repeated: true };
  }
  const recordOp = (h, requester, op, kind, digest, result) =>
    h.run("INSERT INTO e2ee_ops (requester_member, requester_device, op, kind, digest, result, created) VALUES (?, ?, ?, ?, ?, ?, ?)", requester.member, requester.device, op, kind, digest, JSON.stringify(result), now());

  /** The large fields one message's frames share ({mls, ratchet_tree?}), stored once (see enqueue). */
  const sharedOf = (body) => ({ body, pid: null, extra: null });

  /**
   * Queue a message_e2ee frame (without its delivery id) for one device; the frame bound is checked
   * here, on the frame as it will be sent. `shared` (sharedOf): its fields complete the frame;
   * they are stored once per message, in a payload row written with the first entry that uses it,
   * which every later entry of that message references. `sender`: the sender's principal as the
   * relay's access gates see it, kept beside the frame (never sent with it) for the recheck at
   * dispatch.
   */
  function enqueue(h, to, group, frame, { target = null, sender = null, expires, enforceQuota, shared = null }) {
    const delivery = newDelivery();
    if (shared && !payloads) {
      frame = { ...frame, ...shared.body };
      shared = null;
    }
    const env = { type: "message_e2ee", delivery, ...frame };
    // The shared fields add the same bytes to every frame of the message: counted once.
    if (shared) shared.extra ??= frameBytes({ ...env, ...shared.body }) - frameBytes(env);
    const bytes = frameBytes(env) + (shared ? shared.extra : 0);
    if (bytes > MAX_FRAME_BYTES) refuse("too_large", `the frame would have ${bytes} bytes; at most ${MAX_FRAME_BYTES}`);
    if (enforceQuota) {
      const q = h.get("SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM e2ee_queue WHERE member_id = ? AND device_id = ?", to.member, to.device);
      if (q.n + 1 > quota.messages || q.b + bytes > quota.bytes) refuse("quota", `device ${to.device} has too many pending encrypted messages; try later`);
    }
    if (shared && shared.pid === null) shared.pid = Number(h.run("INSERT INTO e2ee_payloads (body) VALUES (?)", JSON.stringify(shared.body)).lastInsertRowid);
    if (shared) h.run("INSERT INTO e2ee_queue (delivery, member_id, device_id, group_id, target, frame, sender, bytes, created, expires, seq, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", delivery, to.member, to.device, group, target, JSON.stringify(env), sender === null ? null : JSON.stringify(sender), bytes, now(), expires, ++seq, shared.pid);
    else h.run("INSERT INTO e2ee_queue (delivery, member_id, device_id, group_id, target, frame, sender, bytes, created, expires, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", delivery, to.member, to.device, group, target, JSON.stringify(env), sender === null ? null : JSON.stringify(sender), bytes, now(), expires, ++seq);
    return delivery;
  }

  /** Remove the payload rows of `pids` that no queue entry references any more (inside `h`). */
  function unref(h, pids) {
    if (!payloads) return;
    for (const pid of new Set(pids)) if (pid !== null && pid !== undefined) h.run("DELETE FROM e2ee_payloads WHERE pid = ? AND NOT EXISTS (SELECT 1 FROM e2ee_queue WHERE payload = ?)", pid, pid);
  }
  /** Delete the queue entries `where` selects (inside `h`), and the payloads they referenced last. Returns how many. */
  function dropQueued(h, where, ...args) {
    const pids = payloads ? h.all(`SELECT DISTINCT payload FROM e2ee_queue WHERE payload IS NOT NULL AND ${where}`, ...args).map((r) => r.payload) : [];
    const n = Number(h.run(`DELETE FROM e2ee_queue WHERE ${where}`, ...args).changes);
    unref(h, pids);
    return n;
  }

  /**
   * The control budget of a device (MII8): a commit is never refused for a full queue (that would
   * make a required removal impossible), and needs no queue entry of its own beyond the newest per
   * group: a device that gets the newest commit of a group catches up on the older ones from the
   * log (commits_since; too far behind, it recovers by replacement). So once the device's queue is
   * at its limits, its queued commits of that group are dropped before the new one is queued.
   * Welcomes: one queued per device and conversation, the newest (queueWelcome). A replacement
   * drops the queued control frames (commits and Welcomes) of the conversation's superseded
   * generations (groupReplace): their devices recover through the current Welcome, or the
   * conversation's current group. So per device and conversation at most one Welcome plus the
   * current group's commits, which past the queue limits are its newest one only.
   */
  function coalesceCommits(h, to, group) {
    const q = h.get("SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM e2ee_queue WHERE member_id = ? AND device_id = ?", to.member, to.device);
    if (q.n + 1 <= quota.messages && q.b < quota.bytes) return;
    dropQueued(h, "member_id = ? AND device_id = ? AND group_id = ? AND target IS NULL AND json_extract(frame, '$.kind') = 'commit'", to.member, to.device, group);
  }

  /** Check a roster delta's shape: {add: [devices], remove: [devices]}, each a device id once. */
  function checkDelta(delta) {
    if (!delta || typeof delta !== "object" || !Array.isArray(delta.add) || !Array.isArray(delta.remove)) refuse("bad_request", "roster_delta is {add: [device ids], remove: [device ids]}");
    const all = [...delta.add, ...delta.remove];
    if (all.length > MAX_GROUP_DEVICES || all.some((d) => typeof d !== "string" || !/^[a-z2-7]{25}[aeimquy4]$/.test(d)) || new Set(all).size !== all.length) refuse("bad_request", "roster_delta lists device ids, each once");
  }

  /**
   * The member of each added device and the reservations that authorize it: every added device
   * must be an active device of one of the conversation's members, covered by a reservation of the
   * requester for that device. Consumes the reservations (inside `h`).
   */
  function authorizeAdds(h, { requester, members, add, reservations }) {
    if (!Array.isArray(reservations) || reservations.length !== add.length || reservations.some((r) => typeof r !== "string" || !RES_RE.test(r)) || new Set(reservations).size !== reservations.length) {
      refuse("bad_request", "every added device needs exactly one KeyPackage reservation (kp_reservations)");
    }
    const targets = [];
    for (const id of reservations) {
      const r = h.get("SELECT target_member, target_device, ref FROM kp_reservations WHERE reservation = ?", id);
      if (r) targets.push({ member: r.target_member, device: r.target_device, ref: r.ref });
    }
    const out = [];
    for (const device of add) {
      const t = targets.find((x) => x.device === device);
      if (!t) refuse("no_reservation", `no reservation of yours covers device ${device}`);
      if (!members.includes(t.member)) refuse("not_allowed", `device ${device} belongs to neither member of the conversation`);
      activeDevice(h, t.member, device);
      out.push(t);
    }
    // Only open reservations of this requester for these devices; anything else refuses it all.
    directory.useReservations(h, { requester, reservations, targets: out });
    return out;
  }

  /** The Welcome's recipients must be exactly the added devices; queue it to each. */
  function queueWelcome(h, { group, generation, conversation, requester, welcome, added, extra = {} }) {
    if (!added.length) {
      if (welcome) refuse("bad_request", "a Welcome without added devices");
      return [];
    }
    if (!welcome || typeof welcome.mls !== "string" || !Array.isArray(welcome.recipients)) refuse("bad_request", "added devices need welcome {recipients, mls}");
    checkMls(welcome.mls, "welcome.mls");
    if (welcome.ratchet_tree !== undefined && welcome.ratchet_tree !== null) checkMls(welcome.ratchet_tree, "welcome.ratchet_tree");
    const want = added.map((x) => x.device).sort();
    const got = [...welcome.recipients].sort();
    if (want.length !== got.length || want.some((d, i) => d !== got[i])) refuse("bad_request", "the Welcome's recipients must be exactly the added devices");
    // Each recipient learns which of its KeyPackages the Welcome uses (its replay record's key).
    // One queued Welcome per device and conversation: the newest wins (MII8). The Welcome's bytes
    // (and its ratchet tree) are stored once for all its recipients.
    const shared = sharedOf({ mls: welcome.mls, ...(welcome.ratchet_tree ? { ratchet_tree: welcome.ratchet_tree } : {}) });
    return added.map((to) => {
      dropQueued(h, "member_id = ? AND device_id = ? AND target IS NULL AND json_extract(frame, '$.kind') = 'welcome' AND group_id IN (SELECT group_id FROM e2ee_groups WHERE member_a = ? AND member_b = ?)", to.member, to.device, conversation.a, conversation.b);
      return enqueue(h, to, group, { group, generation, conversation, kind: "welcome", kp_ref: to.ref, from_member: requester.member, from_device: requester.device, ...extra }, { expires: now() + LOG_KEEP_MS, enforceQuota: false, shared });
    });
  }

  const conversationOut = (c) => ({ realm, a: c.a, b: c.b });

  /**
   * Create a group for a conversation, or return the existing mapping. `conversation` names the
   * other member; the requester's member is the other side. A fresh group starts with the
   * requester's device and the devices its Welcome adds, at `epoch` (the epoch the Welcome joins).
   */
  function groupCreate({ requester, op, peer, group, epoch, welcome = null, reservations = [] }) {
    const digest = opDigest("create", [peer, group, epoch, welcome?.mls ?? null, welcome?.ratchet_tree ?? null, welcome?.recipients ?? [], reservations]);
    const c = canonicalPair(requester.member, peer);
    if (!GROUP_RE.test(group ?? "")) refuse("bad_request", "group must be a group id (32 hex digits)");
    if (!Number.isSafeInteger(epoch) || epoch < 0) refuse("bad_request", "epoch must be a whole number");
    return db.tx((h) => {
      activeDevice(h, requester.member, requester.device);
      const prior = priorOp(h, requester, op, digest);
      if (prior) return prior;
      const existing = h.get("SELECT group_id, generation FROM e2ee_conversations WHERE member_a = ? AND member_b = ?", c.a, c.b);
      if (existing) {
        // A later contender never replaces a group that exists; its reservations stay unused (they burn).
        const g = groupRow(h, existing.group_id);
        const result = { conversation: conversationOut(c), group: g.group_id, generation: g.generation, epoch: g.epoch, created: false };
        recordOp(h, requester, op, "create", digest, result);
        return result;
      }
      if (groupRow(h, group)) refuse("bad_request", "that group id is taken");
      const result = createGroup(h, { requester, c, group, generation: 1, epoch, welcome, reservations });
      recordOp(h, requester, op, "create", digest, result);
      return result;
    });
  }

  function createGroup(h, { requester, c, group, generation, epoch, welcome, reservations }) {
    if (welcome) checkDelta({ add: welcome.recipients, remove: [] });
    const added = authorizeAdds(h, { requester, members: [c.a, c.b], add: welcome?.recipients ?? [], reservations });
    if (added.length + 1 > MAX_GROUP_DEVICES) refuse("too_many_devices", `a group has at most ${MAX_GROUP_DEVICES} devices`);
    h.run("INSERT INTO e2ee_groups (group_id, member_a, member_b, generation, state, epoch, created) VALUES (?, ?, ?, ?, 'active', ?, ?)", group, c.a, c.b, generation, epoch, now());
    h.run("INSERT INTO e2ee_conversations (member_a, member_b, group_id, generation) VALUES (?, ?, ?, ?) ON CONFLICT (member_a, member_b) DO UPDATE SET group_id = excluded.group_id, generation = excluded.generation", c.a, c.b, group, generation);
    h.run("INSERT INTO e2ee_roster (group_id, member_id, device_id) VALUES (?, ?, ?)", group, requester.member, requester.device);
    for (const d of added) h.run("INSERT INTO e2ee_roster (group_id, member_id, device_id) VALUES (?, ?, ?)", group, d.member, d.device);
    queueWelcome(h, { group, generation, conversation: conversationOut(c), requester, welcome, added, extra: { epoch } });
    return { conversation: conversationOut(c), group, generation, epoch, created: true };
  }

  /**
   * Replace a conversation's group (a broken group, a fork recovery, a rejoin after falling too far
   * behind): by a device in the current group's roster, for the expected generation only.
   */
  function groupReplace({ requester, op, peer, expectedGeneration, group, epoch, welcome = null, reservations = [] }) {
    const digest = opDigest("replace", [peer, expectedGeneration, group, epoch, welcome?.mls ?? null, welcome?.ratchet_tree ?? null, welcome?.recipients ?? [], reservations]);
    const c = canonicalPair(requester.member, peer);
    if (!GROUP_RE.test(group ?? "")) refuse("bad_request", "group must be a group id (32 hex digits)");
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(expectedGeneration)) refuse("bad_request", "epoch and expected_generation must be whole numbers");
    return db.tx((h) => {
      activeDevice(h, requester.member, requester.device);
      const prior = priorOp(h, requester, op, digest);
      if (prior) return prior;
      const cur = h.get("SELECT group_id, generation FROM e2ee_conversations WHERE member_a = ? AND member_b = ?", c.a, c.b);
      if (!cur) refuse("no_group", "this conversation has no group yet: group_create");
      if (cur.generation !== expectedGeneration) refuse("stale_generation", `the conversation is at generation ${cur.generation}`, { generation: cur.generation, group: cur.group_id });
      if (!inRoster(h, cur.group_id, requester.device)) refuse("not_member", "only a device of the current group replaces it");
      if (groupRow(h, group)) refuse("bad_request", "that group id is taken");
      h.run("UPDATE e2ee_groups SET state = 'replaced', replaced_at = ? WHERE group_id = ?", now(), cur.group_id);
      // The control frames of superseded generations go (MII8); their application messages stay
      // (a device that never joined such a group refuses them once it holds a newer generation;
      // their senders seal them again in the current group).
      dropQueued(h, "target IS NULL AND group_id IN (SELECT group_id FROM e2ee_groups WHERE member_a = ? AND member_b = ? AND state = 'replaced')", c.a, c.b);
      const result = createGroup(h, { requester, c, group, generation: cur.generation + 1, epoch, welcome, reservations });
      recordOp(h, requester, op, "replace", digest, result);
      return result;
    });
  }

  /** The current group of a conversation (null when there is none). */
  function conversation({ member, peer }) {
    const c = canonicalPair(member, peer);
    const cur = db.get("SELECT group_id, generation FROM e2ee_conversations WHERE member_a = ? AND member_b = ?", c.a, c.b);
    if (!cur) return null;
    const g = groupRow(db, cur.group_id);
    // replace_required (design 4.4): the relay's store was restored; clients replace the group.
    return { conversation: conversationOut(c), group: g.group_id, generation: g.generation, epoch: g.epoch, roster: roster(db, g.group_id), replace_required: Boolean(g.replace_required) };
  }

  /** The active group `group` for a sender in its roster, or a refusal. */
  function senderGroup(h, requester, group) {
    if (!GROUP_RE.test(group ?? "")) refuse("bad_request", "group must be a group id");
    const g = groupRow(h, group);
    if (!g) refuse("no_group", "no such group");
    if (!inRoster(h, group, requester.device)) refuse("not_member", "this device is not in the group's roster");
    if (g.state !== "active") {
      const cur = h.get("SELECT group_id, generation FROM e2ee_conversations WHERE member_a = ? AND member_b = ?", g.member_a, g.member_b);
      refuse("group_replaced", "this group was replaced; use the conversation's current group", { group: cur.group_id, generation: cur.generation });
    }
    return g;
  }

  /**
   * Publish a commit: {requester, op, group, expectedEpoch, mls (base64), delta, welcome?,
   * reservations}. Returns {state: "accepted", position, epoch} | {state: "conflict", winner}.
   * Refusals (stale_epoch and others) throw and record nothing.
   */
  function sendCommit({ requester, op, group, expectedEpoch, mls, delta, welcome = null, reservations = [] }) {
    checkDelta(delta);
    checkMls(mls);
    const digest = opDigest("commit", [group, expectedEpoch, mls, delta.add, delta.remove, welcome?.mls ?? null, welcome?.ratchet_tree ?? null, welcome?.recipients ?? [], reservations]);
    return db.tx((h) => {
      activeDevice(h, requester.member, requester.device);
      const prior = priorOp(h, requester, op, digest);
      if (prior) return prior;
      const g = senderGroup(h, requester, group);
      // After a restore the log was rolled back: a different commit for an epoch the clients already
      // left would fork the group (3.3 MI6), so no commit is accepted until a device replaces it.
      if (g.replace_required) refuse("replace_required", "the relay's store was restored from a backup: replace this group (group_replace) before committing", { group: g.group_id, generation: g.generation });
      if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) refuse("bad_request", "expected_epoch must be a whole number");
      if (expectedEpoch < g.epoch) {
        const w = h.get("SELECT position, op, requester_device, epoch FROM e2ee_log WHERE group_id = ? AND epoch = ?", group, expectedEpoch);
        if (!w) refuse("stale_epoch", `the group is at epoch ${g.epoch} and the commit for epoch ${expectedEpoch} is no longer in the log`, { epoch: g.epoch });
        const result = { state: "conflict", winner: { position: w.position, op: w.op, device: w.requester_device, epoch: w.epoch } };
        recordOp(h, requester, op, "commit", digest, result);
        return result;
      }
      if (expectedEpoch > g.epoch) refuse("stale_epoch", `the group is at epoch ${g.epoch}`, { epoch: g.epoch });
      // The delta: removals of roster devices (any roster device may remove one, itself included);
      // additions only through the requester's reservations, for devices of the two members.
      for (const d of delta.remove) if (!inRoster(h, group, d)) refuse("bad_request", `device ${d} is not in the roster`);
      for (const d of delta.add) if (inRoster(h, group, d)) refuse("bad_request", `device ${d} is already in the roster`);
      const added = authorizeAdds(h, { requester, members: [g.member_a, g.member_b], add: delta.add, reservations });
      const before = roster(h, group);
      if (before.length - delta.remove.length + added.length > MAX_GROUP_DEVICES) refuse("too_many_devices", `a group has at most ${MAX_GROUP_DEVICES} devices`);
      const position = g.last_position + 1;
      const t = now();
      const deltaJson = JSON.stringify({ add: delta.add, remove: delta.remove });
      h.run("INSERT INTO e2ee_log (group_id, position, epoch, op, requester_member, requester_device, mls, roster_delta, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", group, position, expectedEpoch, op, requester.member, requester.device, Buffer.from(mls, "base64"), deltaJson, t);
      h.run("UPDATE e2ee_groups SET epoch = ?, last_position = ? WHERE group_id = ?", expectedEpoch + 1, position, group);
      // The commit goes to every device of the roster before the delta but the committer (removed
      // devices learn of their removal); exactly this log entry's fields travel with it.
      const log = { position, op, expected_epoch: expectedEpoch, roster_delta: { add: delta.add, remove: delta.remove } };
      const conv = conversationOut({ a: g.member_a, b: g.member_b });
      const shared = sharedOf({ mls }); // the commit's bytes, once for every recipient device
      for (const to of before) {
        if (to.device === requester.device) continue;
        coalesceCommits(h, to, group);
        enqueue(h, to, group, { group, generation: g.generation, conversation: conv, kind: "commit", from_member: requester.member, from_device: requester.device, log }, { expires: t + LOG_KEEP_MS, enforceQuota: false, shared });
      }
      for (const d of delta.remove) h.run("DELETE FROM e2ee_roster WHERE group_id = ? AND device_id = ?", group, d);
      for (const d of added) h.run("INSERT INTO e2ee_roster (group_id, member_id, device_id) VALUES (?, ?, ?)", group, d.member, d.device);
      queueWelcome(h, { group, generation: g.generation, conversation: conv, requester, welcome, added, extra: { epoch: expectedEpoch + 1, log } });
      const result = { state: "accepted", position, epoch: expectedEpoch + 1 };
      recordOp(h, requester, op, "commit", digest, result);
      return result;
    });
  }

  /**
   * Publish an application message: {requester, op, group, mls, target: session name}. Queued to
   * every other roster device of the group; refused with "quota" when one of them is full. With
   * `reconcile`, the original result of that op id and payload; for an op id never accepted,
   * {state: "cancelled"}, recorded in the same transaction so that the op id can never be accepted
   * afterwards (MII3); nothing new is accepted. `sender`: the principal that sent it
   * ({memberId, identity, family}), queued with it for the access recheck at dispatch. `blobs`
   * (design 6): the relay-visible references of transfers this message publishes; their download
   * relations are created in this acceptance's transaction (or the whole message is refused), and
   * the references travel with the queued frames for the receivers' cross-check.
   * `authorize()`: the uploader's upload policy now, asked before a publication is accepted (A8).
   */
  function sendApp({ requester, op, group, mls, target, reconcile = false, sender = null, blobs = null, authorize = () => "allow" }) {
    if (typeof target !== "string" || !SESSION_RE.test(target)) refuse("bad_request", "target must be a session name");
    checkMls(mls);
    if (blobs !== null && (!Array.isArray(blobs) || !blobs.length)) refuse("bad_request", "blobs is a non-empty list");
    if (blobs && !transfers) refuse("bad_request", "this relay does not carry transfers");
    // The digest of a message without blobs is as before; with them, the references are bound too.
    const digest = blobs ? opDigest("app", [group, mls, target, blobs.map((b) => [b?.uploader_device ?? null, b?.transfer_id ?? null])]) : opDigest("app", [group, mls, target]);
    // A publication the upload policy denies (A8) is a committed outcome: the transfer's change to
    // denied is written and the transaction commits with no op accepted; the refusal is answered
    // after the commit (outcome).
    return outcome(db.tx((h) => {
      activeDevice(h, requester.member, requester.device);
      const prior = priorOp(h, requester, op, digest, { reconcile });
      if (prior) return prior;
      // Reconciliation only (a client recovering an entry it may have published): nothing new is
      // accepted, and the op id is cancelled with this answer (reconcile-or-cancel, MII3).
      if (reconcile) {
        const n = h.get("SELECT count(*) AS n FROM e2ee_ops WHERE requester_member = ? AND requester_device = ? AND kind = 'cancelled'", requester.member, requester.device).n;
        if (n >= quota.cancelled) refuse("quota", "this device has too many cancelled operations; try later");
        const result = { state: "cancelled" };
        recordOp(h, requester, op, "cancelled", digest, result);
        return result;
      }
      const g = senderGroup(h, requester, group);
      // After a restore, the clients' epochs may have diverged from the rolled-back log: a new
      // message sealed in this group may be unreadable for its recipients, so none is accepted
      // until a member device replaces the group (earlier operations keep their answers above).
      if (g.replace_required) refuse("replace_required", "the relay's store was restored from a backup: replace this group (group_replace) before sending", { group: g.group_id, generation: g.generation });
      const conv = conversationOut({ a: g.member_a, b: g.member_b });
      const t = now();
      const members = roster(h, group);
      // A4: an op that would reach no device of another member is refused before acceptance
      // (nothing recorded: the sender holds it); the sender's own other devices do not count.
      if (recipientCheck && !members.some((m) => m.member !== requester.member)) refuse("no_recipient", "the conversation's roster holds no device of the other member; nothing was accepted");
      const refs = blobs ? transfers.publish(h, { requester, op, blobs, roster: members, sender, authorize }) : null;
      if (refs?.refusal) return refs;
      let n = 0;
      const shared = sharedOf({ mls }); // the message's bytes, once for every recipient device
      for (const to of members) {
        if (to.device === requester.device) continue;
        enqueue(h, to, group, { group, generation: g.generation, conversation: conv, kind: "app", from_member: requester.member, from_device: requester.device, target, epoch: g.epoch, ...(refs ? { blobs: refs } : {}) }, { target, sender, expires: t + APP_QUEUE_MS, enforceQuota: true, shared });
        n++;
      }
      // peerRecipients (protocol 2, A4): the roster devices not of the sender's member, which the
      // sender reads as delivery evidence (never the total).
      const result = { state: "accepted", recipients: n, ...(answerPeers ? { peerRecipients: members.filter((m) => m.member !== requester.member).length } : {}) };
      recordOp(h, requester, op, "app", digest, result);
      return result;
    }));
  }

  /** The log of `group` from epoch `epoch` on (at most `limit` entries), for a device of its roster. */
  function commitsSince({ requester, group, epoch, limit = 100 }) {
    if (!GROUP_RE.test(group ?? "") || !Number.isSafeInteger(epoch) || epoch < 0) refuse("bad_request", "commits_since needs group and epoch");
    activeDevice(db, requester.member, requester.device);
    const g = groupRow(db, group);
    if (!g) refuse("no_group", "no such group");
    if (!inRoster(db, group, requester.device)) refuse("not_member", "this device is not in the group's roster");
    const first = db.get("SELECT min(epoch) AS e FROM e2ee_log WHERE group_id = ?", group).e;
    if (epoch < g.epoch && (first === null || epoch < first)) refuse("too_far_behind", "the log no longer reaches back to that epoch; recover by group_replace", { epoch: g.epoch, generation: g.generation });
    const rows = db.all("SELECT position, epoch, op, requester_member, requester_device, mls, roster_delta FROM e2ee_log WHERE group_id = ? AND epoch >= ? ORDER BY position LIMIT ?", group, epoch, limit + 1);
    const entries = [];
    let bytes = 0;
    for (const r of rows.slice(0, limit)) {
      const e = { position: r.position, epoch: r.epoch, op: r.op, from_member: r.requester_member, from_device: r.requester_device, mls: Buffer.from(r.mls).toString("base64"), roster_delta: JSON.parse(r.roster_delta) };
      bytes += frameBytes(e);
      if (entries.length && bytes > MAX_FRAME_BYTES - 4096) break;
      entries.push(e);
    }
    return { group, generation: g.generation, state: g.state, epoch: g.epoch, entries, more: entries.length < rows.length, replace_required: Boolean(g.replace_required) };
  }

  /** A member device reports a commit it refused (a delta that disagrees, or one that does not validate). */
  function commitInvalid({ requester, group, epoch, reason = null }) {
    if (!GROUP_RE.test(group ?? "") || !Number.isSafeInteger(epoch) || epoch < 0) refuse("bad_request", "commit_invalid needs group and epoch");
    return db.tx((h) => {
      activeDevice(h, requester.member, requester.device);
      if (!groupRow(h, group)) refuse("no_group", "no such group");
      if (!inRoster(h, group, requester.device)) refuse("not_member", "this device is not in the group's roster");
      h.run("INSERT INTO e2ee_invalid (group_id, epoch, member_id, device_id, reason, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", group, epoch, requester.member, requester.device, typeof reason === "string" ? reason.slice(0, 200) : null, now());
      h.run("DELETE FROM e2ee_invalid WHERE group_id = ? AND rowid NOT IN (SELECT rowid FROM e2ee_invalid WHERE group_id = ? ORDER BY at DESC LIMIT ?)", group, group, INVALID_KEPT);
      return { recorded: true };
    }, { cls: "maintenance" });
  }

  /**
   * The queued frames of a device, oldest first, skipping deliveries in `except`. `targets`
   * (session names) and `control` select in the store what can be delivered now (MII7):
   * application messages for those targets (at most `limit`), and control frames (commits,
   * Welcomes) when `control` is true (at most `controlLimit`). The two are separate queries, so
   * frames waiting for an offline session never hide later deliverable ones, and any number of
   * queued application messages never hides a control frame (MII8: a replacement's Welcome is
   * reachable behind the superseded generations' messages). Without `targets`, every frame, at
   * most `limit` (tests and tools). `appsAfter`: only application messages queued after that seq
   * (the relay's dispatch reads the queue a page at a time). With `withSender`, each entry is
   * {frame, sender, seq}: the frame as sent, the principal queued with it (null when none was) and
   * its place in the queue.
   */
  function pending({ member, device, limit = 50, except = new Set(), targets = null, control = true, controlLimit = limit, appsAfter = 0, withSender = false }) {
    const t = now();
    // Suspension (design 4.4): frames for a suspended device, or sent by one, are not dispatched.
    // They stay queued under their own expiry and quotas, and go after a reinstatement.
    if (admin44 && db.get("SELECT suspended FROM devices WHERE member_id = ? AND device_id = ?", member, device)?.suspended) return [];
    const held = admin44 ? " AND NOT EXISTS (SELECT 1 FROM devices s WHERE s.suspended = 1 AND s.member_id = json_extract(q.frame, '$.from_member') AND s.device_id = json_extract(q.frame, '$.from_device'))" : "";
    // The entry's frame, completed by its message's shared payload (none for entries queued before migration 7).
    const from = payloads ? "q.delivery, q.frame, q.sender, q.seq, p.body FROM e2ee_queue q LEFT JOIN e2ee_payloads p ON p.pid = q.payload" : "q.delivery, q.frame, q.sender, q.seq, NULL AS body FROM e2ee_queue q";
    const pick = (where, args, n) => (n > 0 ? db.all(`SELECT ${from} WHERE q.member_id = ? AND q.device_id = ? AND q.expires > ?${held}${where} ORDER BY q.seq LIMIT ?`, member, device, t, ...args, n + except.size).filter((r) => !except.has(r.delivery)).slice(0, n) : []);
    let rows;
    if (!targets) rows = pick("", [], limit);
    else {
      const names = [...new Set(targets)].slice(0, 1000);
      rows = [...(control ? pick(" AND q.target IS NULL", [], controlLimit) : []), ...(names.length ? pick(` AND q.seq > ? AND q.target IN (${names.map(() => "?").join(", ")})`, [appsAfter, ...names], limit) : [])].sort((x, y) => x.seq - y.seq);
    }
    const frameOf = (r) => (r.body === null ? JSON.parse(r.frame) : { ...JSON.parse(r.frame), ...JSON.parse(r.body) });
    return rows.map((r) => (withSender ? { frame: frameOf(r), sender: r.sender === null ? null : JSON.parse(r.sender), seq: r.seq } : frameOf(r)));
  }

  /** Which of a device's `deliveries` are still queued (a replacement or a newer Welcome removes control frames). */
  function queued({ member, device, deliveries }) {
    const out = new Set();
    const list = [...deliveries];
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      for (const r of db.all(`SELECT delivery FROM e2ee_queue WHERE member_id = ? AND device_id = ? AND expires > ? AND delivery IN (${part.map(() => "?").join(", ")})`, member, device, now(), ...part)) out.add(r.delivery);
    }
    return out;
  }

  /** The device acknowledged a delivery (delivered, or refused by its checks): it leaves the queue. */
  function ack({ member, device, delivery }) {
    return db.tx((h) => dropQueued(h, "delivery = ? AND member_id = ? AND device_id = ?", delivery, member, device) > 0, { cls: "maintenance" });
  }

  /** Queue usage of a device (for monitoring and tests). */
  const usage = ({ member, device }) => {
    const q = db.get("SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM e2ee_queue WHERE member_id = ? AND device_id = ?", member, device);
    return { messages: q.n, bytes: q.b };
  };

  /**
   * Delete the rows `select` names ({rowid, bytes}), at most SWEEP_BATCH and SWEEP_BATCH_BYTES of
   * them (at least one); returns how many, and whether more may wait.
   */
  function deleteBatch(h, table, select, args) {
    let bytes = 0;
    const ids = [];
    const pids = [];
    for (const r of h.all(`${select} LIMIT ${SWEEP_BATCH}`, ...args)) {
      if (ids.length && bytes + Number(r.bytes) > SWEEP_BATCH_BYTES) break;
      bytes += Number(r.bytes);
      ids.push(r.rowid);
      if (r.payload !== undefined) pids.push(r.payload);
    }
    for (const id of ids) h.run(`DELETE FROM ${table} WHERE rowid = ?`, id);
    unref(h, pids); // a queue entry's payload goes with its last reference
    return ids.length;
  }

  /**
   * The timers: expired queue entries, the log beyond 30 days or 1,000 epochs, old operations. In
   * batches of at most SWEEP_BATCH rows and SWEEP_BATCH_BYTES of data per kind, each its own
   * maintenance transaction (design 6: every write transaction stays under the store's allowance);
   * at most SWEEP_BATCHES per call, the next sweep resumes.
   */
  function sweep() {
    const t = now();
    const out = { queue: 0, log: 0, ops: 0 };
    for (let i = 0; i < SWEEP_BATCHES; i++) {
      const r = db.tx((h) => {
        // A queue entry's bytes count its whole frame, the shared payload too (an upper bound).
        const queue = deleteBatch(h, "e2ee_queue", `SELECT rowid, bytes${payloads ? ", payload" : ""} FROM e2ee_queue WHERE expires <= ? ORDER BY expires`, [t]);
        let log = deleteBatch(h, "e2ee_log", "SELECT rowid, length(mls) AS bytes FROM e2ee_log WHERE created <= ?", [t - LOG_KEEP_MS]);
        log += deleteBatch(h, "e2ee_log", "SELECT l.rowid AS rowid, length(l.mls) AS bytes FROM e2ee_log l JOIN e2ee_groups g ON g.group_id = l.group_id WHERE l.epoch < g.epoch - ?", [LOG_KEEP_EPOCHS]);
        const ops = Number(h.run(`DELETE FROM e2ee_ops WHERE rowid IN (SELECT rowid FROM e2ee_ops WHERE created <= ? LIMIT ${SWEEP_BATCH})`, t - OPS_KEEP_MS).changes);
        return { queue, log, ops };
      }, { cls: "maintenance" });
      out.queue += r.queue;
      out.log += r.log;
      out.ops += r.ops;
      if (!r.queue && !r.log && r.ops < SWEEP_BATCH) break;
    }
    return out;
  }

  return { checkDevice: (r) => activeDevice(db, r.member, r.device), groupCreate, groupReplace, conversation, sendCommit, sendApp, commitsSince, commitInvalid, pending, queued, ack, usage, sweep, roster: (group) => roster(db, group) };
}
