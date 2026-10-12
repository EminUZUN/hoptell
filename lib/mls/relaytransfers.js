// The relay's store of larger transfers (design 6, "Relay: transfers and their states", "Publication:
// the relay-visible reference", "Retention"), on the relay's durable storage (lib/relaydb.js) next
// to 3.2's device directory and 3.3's Delivery Service: one database, so a message's acceptance and
// the download relation it creates are one transaction. EXPERIMENTAL: the relay uses it only when
// started with --experimental-e2ee.
//
// The relay stores ciphertext chunks it cannot read (lib/transferwire.js is the format). A transfer
// is identified by (uploader device, transfer_id); the uploader member is recorded with it. Its
// states: open -> sealed (commit), open -> aborted | expired (24 hours after begin), sealed ->
// aborted (the uploader's abort) | expired (7 days after the seal), and open | sealed -> denied
// (amendments 3.5, A8: the relay's upload policy refused new work after the begin; stored as an
// aborted row flagged `denied`). aborted, expired and denied are terminal and never reopen.
//
// Upload authorization is live (A8): the uploader's policy is asked whenever the relay would accept
// new work (a chunk not stored yet, a seal not done yet, a publication). Until a denial an accepted
// chunk or seal keeps its exact idempotent answer; after it every chunk, seal and publication of
// that transfer answers "denied" (upload_status reports it). A denial is committed as the
// transaction's outcome and answered after the commit (outcome()); a stale view answers
// "unavailable" and changes nothing.
//
// Accounting (charged bytes, fixed per-row amounts that bound each row and its index entries):
//   transfer row   1 KiB + 512 bytes for its future tombstone while it is not terminal
//   chunk          its ciphertext length + 128 bytes (carried by the row while not terminal)
//   relation       256 bytes + 64 bytes per allowed device + 1 KiB for the uploader's principal
//   tombstone      512 bytes + reclaiming (the remaining chunks' charges, until reclaimed)
// upload_begin reserves the transfer row, every chunk at its expected length (reserved_remaining)
// and the future tombstone, computed from the begin parameters. Storing a chunk moves its charge
// from reserved_remaining to the chunk row. A member's total is the sum over its live rows of their
// own charges plus each transfer's reserved_remaining and reclaiming; startup recomputes it and
// refuses to start when the stored totals differ.
//
// Every write is one transaction of a bounded size (design 6, v6), admitted by the store against
// the WAL's size: begin and chunks are "bulk", a commit and a publication "progress", termination,
// reclamation, tombstone removal and vacuum steps "maintenance". Termination is separate from
// reclamation: the terminating transaction sets the state and the tombstone, deletes the relations
// (at most 64) and moves the chunks' charge to the tombstone's `reclaiming`; it deletes no chunk.
// Reclamation then deletes chunks 16 per transaction, releasing each batch's charge with it. A
// tombstone goes, with its charge and slot, once its 30-day replay horizon has passed and its last
// chunk is gone.
import crypto from "node:crypto";
import { DirectoryError } from "./relaydir.js";
import { DAY } from "./policy.js";
import { CHUNK_SIZE, MAX_CHUNKS, MAX_TOTAL_BYTES, TAG_BYTES, TRANSFER_ID_RE, ROOT_RE, rootOf } from "../transferwire.js";

export const OPEN_LIFETIME_MS = DAY; // an uncommitted transfer expires 24 hours after begin
export const SEALED_LIFETIME_MS = 7 * DAY; // a sealed one 7 days after the seal
export const PUBLISH_MIN_REMAINING_MS = DAY; // a reference needs at least this much time left
export const REPLAY_HORIZON_MS = 30 * DAY; // a tombstone keeps its key this long after the end
export const CHARGE = Object.freeze({ transfer: 1024, tombstone: 512, chunk: 128, relation: 256, relationDevice: 64, relationSender: 1024 });
/** The longest uploader principal a relation keeps (JSON {memberId, identity, family}). */
export const MAX_SENDER_BYTES = CHARGE.relationSender;
export const MAX_RELATION_DEVICES = 64;
export const DEFAULT_LIMITS = Object.freeze({
  open: 20, // open transfers per member
  memberQuota: 1024 * 1024 * 1024, // charged bytes per member (--transfer-member-quota)
  slots: 1000, // terminal slots per member: tombstones plus every non-terminal transfer
  relations: 2000, // relations per member
  relationsPerTransfer: 64,
  totalQuota: 20 * 1024 * 1024 * 1024, // charged bytes in all (--transfer-quota)
});
const BATCH = 16; // transfers per expiry or tombstone transaction, chunks per reclamation transaction
const BATCHES = 64; // transactions of each kind per sweep call (the next sweep resumes)
const VACUUM_STEPS = 64; // capped vacuum steps per sweep call
const TERMINAL = new Set(["aborted", "expired"]);

/** Migration 5 of the relay's store (design 6): after 3.2's, 3.3's and 4.4's. */
export const TRANSFER_MIGRATION = `CREATE TABLE transfers (
     tid INTEGER PRIMARY KEY,
     uploader_member TEXT NOT NULL CHECK (length(uploader_member) BETWEEN 1 AND 70),
     uploader_device TEXT NOT NULL CHECK (length(uploader_device) = 26),
     transfer_id TEXT NOT NULL CHECK (length(transfer_id) = 32),
     total_bytes INTEGER NOT NULL CHECK (total_bytes BETWEEN 0 AND ${MAX_TOTAL_BYTES}),
     chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND ${MAX_CHUNKS}),
     params BLOB NOT NULL CHECK (length(params) = 32),
     header_digest BLOB CHECK (header_digest IS NULL OR length(header_digest) = 32),
     state TEXT NOT NULL CHECK (state IN ('open', 'sealed', 'aborted', 'expired')),
     created INTEGER NOT NULL,
     open_expires INTEGER NOT NULL,
     sealed_at INTEGER,
     relay_expires INTEGER,
     root BLOB CHECK (root IS NULL OR length(root) = 32),
     terminal_at INTEGER,
     charge INTEGER NOT NULL CHECK (charge IN (${CHARGE.transfer + CHARGE.tombstone}, ${CHARGE.tombstone})),
     reserved_remaining INTEGER NOT NULL CHECK (reserved_remaining >= 0),
     reclaiming INTEGER NOT NULL DEFAULT 0 CHECK (reclaiming >= 0),
     released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
     CHECK ((state IN ('aborted', 'expired')) = (released = 1)),
     UNIQUE (uploader_device, transfer_id)
   ) STRICT;
   CREATE INDEX transfers_open ON transfers (open_expires) WHERE state = 'open';
   CREATE INDEX transfers_sealed ON transfers (relay_expires) WHERE state = 'sealed';
   CREATE INDEX transfers_ended ON transfers (terminal_at) WHERE released = 1;
   CREATE TABLE transfer_chunks (
     tid INTEGER NOT NULL REFERENCES transfers (tid),
     idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND ${MAX_CHUNKS - 1}),
     len INTEGER NOT NULL CHECK (len BETWEEN ${TAG_BYTES} AND ${CHUNK_SIZE + TAG_BYTES}),
     digest BLOB NOT NULL CHECK (length(digest) = 32),
     data BLOB NOT NULL CHECK (length(data) = len),
     PRIMARY KEY (tid, idx)
   ) STRICT;
   CREATE TABLE transfer_relations (
     rid INTEGER PRIMARY KEY,
     tid INTEGER NOT NULL REFERENCES transfers (tid),
     op TEXT NOT NULL CHECK (length(op) = 28),
     recipient_member TEXT NOT NULL CHECK (length(recipient_member) BETWEEN 1 AND 70),
     devices TEXT NOT NULL CHECK (length(devices) <= ${2 + MAX_RELATION_DEVICES * 29}),
     charge INTEGER NOT NULL,
     created INTEGER NOT NULL,
     UNIQUE (tid, op)
   ) STRICT;
   CREATE TABLE transfer_members (
     member_id TEXT PRIMARY KEY CHECK (length(member_id) BETWEEN 1 AND 70),
     charged INTEGER NOT NULL DEFAULT 0 CHECK (charged >= 0),
     open INTEGER NOT NULL DEFAULT 0 CHECK (open >= 0),
     slots INTEGER NOT NULL DEFAULT 0 CHECK (slots >= 0),
     relations INTEGER NOT NULL DEFAULT 0 CHECK (relations >= 0)
   ) STRICT;`;

/**
 * Migration 6 (design 6, review fix): the principal that published a reference, kept with its
 * relation ({memberId, identity, family} as the access gates see it), so that every download is
 * rechecked against that sign-in's current claim view and broker family. Bounded, and charged with
 * the relation. Relations from before it have none (NULL) and serve no other member.
 */
export const RELATION_SENDER_MIGRATION = `ALTER TABLE transfer_relations ADD COLUMN sender TEXT CHECK (sender IS NULL OR length(sender) <= ${MAX_SENDER_BYTES});`;

/**
 * Migration 8 (amendments 3.5, A8): a transfer the relay's upload policy refused after its begin
 * is `denied`, a terminal state like `aborted`. It is kept as an aborted row with this flag (the
 * reservation, the tombstone and the reclamation are an abort's), and answered as "denied".
 */
export const TRANSFER_DENIED_MIGRATION = "ALTER TABLE transfers ADD COLUMN denied INTEGER NOT NULL DEFAULT 0 CHECK (denied = 0 OR (denied = 1 AND state = 'aborted'));";

const refuse = (code, message, extra) => {
  throw Object.assign(new DirectoryError(code, message), extra ?? {});
};
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const DENIED = "this upload was refused by the relay's policy and has ended; upload it again as a new transfer";
/** A transaction's result, or its committed structured refusal raised now, after the commit (A8). */
export const outcome = (r) => {
  if (r?.refusal) refuse(r.refusal.code, r.refusal.message);
  return r;
};
/** The begin parameters' digest: a tombstone answers a retried begin by it. */
const paramsDigest = (transferId, total, count, headerDigest) => sha(Buffer.from(JSON.stringify(["begin", transferId, total, count, headerDigest])));
const chunkCharge = (len) => len + CHARGE.chunk;
/** The charge reserved at begin for every chunk of a transfer of `total` bytes. */
export function chunksCharge(total, chunkSize = CHUNK_SIZE) {
  const count = Math.max(1, Math.ceil(total / chunkSize));
  return count * (CHARGE.chunk + TAG_BYTES) + total;
}
/** The whole reservation of upload_begin: the transfer row, its future tombstone and every chunk. */
export const beginCharge = (total, chunkSize = CHUNK_SIZE) => CHARGE.transfer + CHARGE.tombstone + chunksCharge(total, chunkSize);
export const relationCharge = (devices) => CHARGE.relation + CHARGE.relationDevice * devices + CHARGE.relationSender;

/** Change a member's totals by the deltas given, inside transaction `h` (creating its row). */
function adjustMember(h, id, d) {
  h.run("INSERT INTO transfer_members (member_id) VALUES (?) ON CONFLICT (member_id) DO NOTHING", id);
  h.run("UPDATE transfer_members SET charged = charged + ?, open = open + ?, slots = slots + ?, relations = relations + ? WHERE member_id = ?", d.charged ?? 0, d.open ?? 0, d.slots ?? 0, d.relations ?? 0, id);
}

/**
 * Make transfer row `r` terminal (`state`: "aborted" or "expired") inside transaction `h`, at time
 * `t`: the state and the tombstone, its relations deleted and their charges released,
 * reserved_remaining released, the remaining chunks' charge moved to `reclaiming`. Deletes no
 * chunk, and is a no-op for a row already terminal (the reservation is released exactly once).
 * Also used by the restore of a store (lib/restore.js).
 */
export function terminateTransfer(h, r, state, t) {
  if (r.released) return false;
  const rel = h.get("SELECT count(*) AS n, coalesce(sum(charge), 0) AS c FROM transfer_relations WHERE tid = ?", r.tid);
  h.run("DELETE FROM transfer_relations WHERE tid = ?", r.tid);
  const chunks = h.get("SELECT count(*) AS n, coalesce(sum(len), 0) AS b FROM transfer_chunks WHERE tid = ?", r.tid);
  const reclaiming = Number(chunks.b) + CHARGE.chunk * Number(chunks.n);
  h.run("UPDATE transfers SET state = ?, terminal_at = ?, released = 1, reserved_remaining = 0, reclaiming = ?, charge = ?, header_digest = NULL, root = NULL WHERE tid = ? AND released = 0", state, t, reclaiming, CHARGE.tombstone, r.tid);
  adjustMember(h, r.uploader_member, { charged: -(Number(rel.c) + r.reserved_remaining + (r.charge - CHARGE.tombstone)), open: r.state === "open" ? -1 : 0, relations: -Number(rel.n) });
  return true;
}

/**
 * The transfer store over an open relay database `db` (with TRANSFER_MIGRATION) and the device
 * directory's tables of the same store. `now()` is the clock; `limits` overrides DEFAULT_LIMITS;
 * `chunkSize` is for tests only (the relay's length checks with small chunks; the wire format's
 * chunk size is fixed). Construction checks the accounting (see recompute) and throws on a
 * mismatch: the relay does not start.
 */
export function createTransferStore({ db, now = () => Date.now(), limits: over = {}, chunkSize = CHUNK_SIZE, log = () => {} }) {
  const limits = { ...DEFAULT_LIMITS, ...over };
  const countOf = (total) => Math.max(1, Math.ceil(total / chunkSize));
  const expectedLength = (total, count, index) => (index < count - 1 ? chunkSize : total - (count - 1) * chunkSize) + TAG_BYTES;
  const chunksReserved = (total) => countOf(total) * (CHARGE.chunk + TAG_BYTES) + total;

  const row = (h, device, transferId) => h.get("SELECT * FROM transfers WHERE uploader_device = ? AND transfer_id = ?", device, transferId);
  const member = (h, id) => h.get("SELECT * FROM transfer_members WHERE member_id = ?", id) ?? { member_id: id, charged: 0, open: 0, slots: 0, relations: 0 };
  const adjust = adjustMember;
  const totalCharged = (h) => Number(h.get("SELECT coalesce(sum(charged), 0) AS n FROM transfer_members").n);
  const checkId = (id) => (typeof id === "string" && TRANSFER_ID_RE.test(id)) || refuse("bad_request", "transfer_id must be 32 hex digits");
  /** The state a row has now: an open or sealed transfer past its expiry is expired (every read compares the times). */
  const stateNow = (r, t = now()) => (r.state === "open" && r.open_expires <= t) || (r.state === "sealed" && r.relay_expires <= t) ? "expired" : r.state;
  const answerOf = (r, t = now()) => {
    if (r.denied) return { state: "denied" };
    const state = stateNow(r, t);
    if (state === "open") return { state, open_expires: r.open_expires };
    if (state === "sealed") return { state, relay_expires: r.relay_expires, root: Buffer.from(r.root).toString("hex") };
    return { state };
  };

  /**
   * Begin an upload: {uploader: {member, device}, transferId, totalBytes, chunkCount, headerDigest
   * (hex)}. The same key with identical parameters returns the original answer (or the current
   * state); different parameters are refused with transfer_conflict. Quota is reserved in the same
   * transaction, computed from the parameters.
   */
  function begin({ uploader, transferId, totalBytes, chunkCount, headerDigest }) {
    checkId(transferId);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_TOTAL_BYTES) refuse("too_large", `total_bytes must be a whole number from 0 to ${MAX_TOTAL_BYTES}`);
    if (!Number.isSafeInteger(chunkCount) || chunkCount !== countOf(totalBytes)) refuse("bad_request", "chunk_count does not follow from total_bytes");
    if (typeof headerDigest !== "string" || !ROOT_RE.test(headerDigest)) refuse("bad_request", "header_digest must be 64 hex digits");
    const params = paramsDigest(transferId, totalBytes, chunkCount, headerDigest);
    return db.tx((h) => {
      const t = now();
      const r = row(h, uploader.device, transferId);
      if (r) {
        if (r.uploader_member !== uploader.member || !Buffer.from(r.params).equals(params)) refuse("transfer_conflict", "this transfer id was begun with other parameters");
        return { repeated: true, ...answerOf(r, t) };
      }
      const m = member(h, uploader.member);
      const charge = CHARGE.transfer + CHARGE.tombstone + chunksReserved(totalBytes);
      if (m.open >= limits.open) refuse("quota", `at most ${limits.open} open transfers per member`, { limit: "open" });
      if (m.slots >= limits.slots) refuse("quota", `at most ${limits.slots} transfers and tombstones per member; wait for old ones to be forgotten`, { limit: "slots" });
      if (m.charged + charge > limits.memberQuota) refuse("quota", "this member's transfer quota is used up", { limit: "member" });
      if (totalCharged(h) + charge > limits.totalQuota) refuse("quota", "the relay's transfer storage is full", { limit: "total" });
      h.run(
        "INSERT INTO transfers (uploader_member, uploader_device, transfer_id, total_bytes, chunk_count, params, header_digest, state, created, open_expires, charge, reserved_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
        uploader.member, uploader.device, transferId, totalBytes, chunkCount, params, Buffer.from(headerDigest, "hex"), t, t + OPEN_LIFETIME_MS, CHARGE.transfer + CHARGE.tombstone, chunksReserved(totalBytes),
      );
      adjust(h, uploader.member, { charged: charge, open: 1, slots: 1 });
      return { state: "open", open_expires: t + OPEN_LIFETIME_MS };
    }, { cls: "bulk" });
  }

  /** The uploader's own transfer, or a refusal ("gone" for one it does not have). */
  const own = (h, uploader, transferId) => {
    checkId(transferId);
    const r = row(h, uploader.device, transferId);
    if (!r || r.uploader_member !== uploader.member) refuse("gone", "no such transfer");
    return r;
  };

  /**
   * Store chunk `index` ({uploader, transferId, index, data (Buffer)}), only while the transfer is
   * open. The same bytes again answer "stored"; different bytes at a stored index chunk_conflict.
   */
  function chunk({ uploader, transferId, index, data, authorize = () => "allow" }) {
    if (!Buffer.isBuffer(data)) refuse("bad_request", "data must be base64");
    return outcome(db.tx((h) => {
      const r = own(h, uploader, transferId);
      if (r.denied) refuse("denied", DENIED);
      const state = stateNow(r);
      if (state === "sealed") refuse("sealed", "this transfer is sealed");
      if (state !== "open") refuse("gone", `this transfer is ${state}`, { state });
      if (!Number.isSafeInteger(index) || index < 0 || index >= r.chunk_count) refuse("bad_request", `index must be from 0 to ${r.chunk_count - 1}`);
      const want = expectedLength(r.total_bytes, r.chunk_count, index);
      if (data.length !== want) refuse("bad_request", `chunk ${index} must have ${want} bytes`);
      const digest = sha(data);
      const prior = h.get("SELECT digest FROM transfer_chunks WHERE tid = ? AND idx = ?", r.tid, index);
      if (prior) {
        if (!Buffer.from(prior.digest).equals(digest)) refuse("chunk_conflict", `chunk ${index} was stored with other bytes`);
        return { index, repeated: true };
      }
      // New work: the uploader's policy now (A8), before anything is accepted.
      const verdict = checkAuthorized(h, r, authorize);
      if (verdict) return verdict;
      h.run("INSERT INTO transfer_chunks (tid, idx, len, digest, data) VALUES (?, ?, ?, ?, ?)", r.tid, index, data.length, digest, data);
      // The chunk's charge moves from the reservation to its row: the member's total is unchanged.
      h.run("UPDATE transfers SET reserved_remaining = reserved_remaining - ? WHERE tid = ? AND reserved_remaining >= ?", chunkCharge(data.length), r.tid, chunkCharge(data.length));
      return { index };
    }, { cls: "bulk" }));
  }

  /** The state, the stored indexes and the expiry of an own transfer (a convenience: clients resend from their records). */
  function status({ uploader, transferId }) {
    const r = own(db, uploader, transferId);
    const stored = TERMINAL.has(stateNow(r)) ? [] : db.all("SELECT idx FROM transfer_chunks WHERE tid = ? ORDER BY idx", r.tid).map((c) => c.idx);
    return { ...answerOf(r), chunk_count: r.chunk_count, stored };
  }

  /**
   * Commit: only from open, with every index stored and the root the relay computes equal to
   * `root` (hex). sealed {relay_expires = seal time + 7 days, root}; a retry with the same root the
   * same answer; another root transfer_conflict; terminal "gone"; missing chunks incomplete.
   */
  function commit({ uploader, transferId, root, authorize = () => "allow" }) {
    if (typeof root !== "string" || !ROOT_RE.test(root)) refuse("bad_request", "root must be 64 hex digits");
    return outcome(db.tx((h) => {
      const r = own(h, uploader, transferId);
      if (r.denied) refuse("denied", DENIED);
      const state = stateNow(r);
      if (state === "sealed") {
        if (Buffer.from(r.root).toString("hex") !== root) refuse("transfer_conflict", "this transfer was sealed with another root");
        return { repeated: true, ...answerOf(r) };
      }
      if (state !== "open") refuse("gone", `this transfer is ${state}`, { state });
      // A seal not done yet is new work: the uploader's policy now (A8).
      const verdict = checkAuthorized(h, r, authorize);
      if (verdict) return verdict;
      const chunks = h.all("SELECT idx, len, digest FROM transfer_chunks WHERE tid = ? ORDER BY idx", r.tid);
      if (chunks.length !== r.chunk_count) {
        const have = new Set(chunks.map((c) => c.idx));
        const missing = [];
        for (let i = 0; i < r.chunk_count; i++) if (!have.has(i)) missing.push(i);
        refuse("incomplete", `${missing.length} chunk(s) missing`, { missing });
      }
      const computed = rootOf(chunks.map((c) => ({ index: c.idx, length: c.len, sha256: Buffer.from(c.digest) })), r.chunk_count);
      if (computed.toString("hex") !== root) refuse("root_mismatch", "the root of the stored chunks differs");
      const t = now();
      h.run("UPDATE transfers SET state = 'sealed', sealed_at = ?, relay_expires = ?, root = ? WHERE tid = ?", t, t + SEALED_LIFETIME_MS, computed, r.tid);
      adjust(h, r.uploader_member, { open: -1 });
      return { state: "sealed", relay_expires: t + SEALED_LIFETIME_MS, root };
    }, { cls: "progress" }));
  }

  const terminate = (h, r, state) => terminateTransfer(h, r, state, now());

  /**
   * The upload policy's verdict for new work on transfer row `r` inside transaction `h` (A8):
   * null when allowed. A denial makes the transfer denied (terminal, as an abort: its reservation
   * released, its chunks reclaimed) and returns a structured refusal, which the transaction
   * commits; the caller answers not_allowed only after the commit (outcome), so the marker is never
   * rolled back. A stale view ("retry") refuses with unavailable and changes nothing.
   */
  function checkAuthorized(h, r, authorize) {
    const v = authorize();
    if (v === "allow") return null;
    if (v !== "deny") refuse("unavailable", "the relay cannot check your access right now; renew your sign-in or try again shortly");
    terminate(h, r, "aborted");
    h.run("UPDATE transfers SET denied = 1 WHERE tid = ?", r.tid);
    return { refusal: { code: "not_allowed", message: "the relay's access policy no longer lets you upload transfers; this upload has ended (a new one is needed)" } };
  }

  /**
   * The uploader's abort: an open or sealed transfer becomes aborted (one already past its expiry
   * becomes expired). A retry answers the recorded final state. Admitted as maintenance: when the
   * store refuses, the error is "busy" and nothing is claimed.
   */
  function abort({ uploader, transferId }) {
    return db.tx((h) => {
      const r = own(h, uploader, transferId);
      if (TERMINAL.has(r.state)) return { state: r.denied ? "denied" : r.state, repeated: true };
      const state = stateNow(r) === "expired" ? "expired" : "aborted";
      terminate(h, r, state);
      return { state };
    }, { cls: "maintenance" });
  }

  /**
   * The publication of a reference inside 3.3's acceptance transaction `h` (relayds.sendApp):
   * `blobs` [{uploader_device, transfer_id}] (at most one in v1) of the sending device, sealed, with
   * at least 24 hours left; one download relation per blob for the recipient member's devices in
   * the group's roster at acceptance (the sender's own devices are not included in v1). `sender`:
   * the publishing principal ({memberId, identity, family}), kept with each relation for the
   * recheck at every download. Refusals throw and refuse the whole message. `authorize()` is the
   * uploader's upload policy now (A8: "allow", "deny" or "retry"): a denial returns {refusal}
   * instead of the references, with the transfer made denied in `h` and nothing else written; the
   * caller commits that and answers the refusal after the commit, accepting no message.
   */
  function publish(h, { requester, op, blobs, roster, sender = null, authorize = () => "allow" }) {
    if (!Array.isArray(blobs) || blobs.length > 1) refuse("bad_request", "blobs lists at most one transfer per message");
    const principal = sender === null ? null : JSON.stringify({ memberId: sender.memberId ?? null, identity: sender.identity ?? null, family: sender.family ?? null });
    if (principal !== null && Buffer.byteLength(principal) > MAX_SENDER_BYTES) refuse("not_allowed", "this sign-in's identity is too long to be kept with a transfer reference");
    // Every blob is checked, and the uploader's policy asked (A8), before anything is written: a
    // denial then writes only its marker, which the caller's transaction commits with no message.
    const checked = [];
    for (const b of blobs) {
      if (!b || typeof b !== "object" || typeof b.uploader_device !== "string" || typeof b.transfer_id !== "string") refuse("bad_request", "a blob is {uploader_device, transfer_id}");
      checkId(b.transfer_id);
      if (b.uploader_device !== requester.device) refuse("not_allowed", "a device publishes only its own uploads");
      const r = row(h, b.uploader_device, b.transfer_id);
      if (!r || r.uploader_member !== requester.member) refuse("gone", "no such transfer");
      if (r.denied) refuse("denied", DENIED);
      const state = stateNow(r);
      if (state === "open") refuse("not_sealed", "the transfer is not sealed yet (upload_commit)");
      if (state !== "sealed") refuse("gone", `the transfer is ${state}`, { state });
      if (r.relay_expires - now() < PUBLISH_MIN_REMAINING_MS) refuse("blob_expiring", "the transfer expires at the relay within 24 hours; upload it again", { relay_expires: r.relay_expires });
      checked.push({ b, r });
    }
    for (const { r } of checked) {
      const verdict = checkAuthorized(h, r, authorize);
      if (verdict) return verdict;
    }
    const out = [];
    for (const { b, r } of checked) {
      const recipients = roster.filter((d) => d.member !== requester.member);
      const devices = [...new Set(recipients.map((d) => d.device))].sort();
      if (devices.length > MAX_RELATION_DEVICES) refuse("quota", `a reference allows at most ${MAX_RELATION_DEVICES} devices`, { limit: "devices" });
      const recipient = recipients[0]?.member ?? null;
      if (!recipient) refuse("bad_request", "the group has no recipient devices");
      const m = member(h, requester.member);
      const charge = relationCharge(devices.length);
      const perTransfer = Number(h.get("SELECT count(*) AS n FROM transfer_relations WHERE tid = ?", r.tid).n);
      if (perTransfer >= limits.relationsPerTransfer) refuse("quota", `a transfer is referenced at most ${limits.relationsPerTransfer} times`, { limit: "relations_per_transfer" });
      if (m.relations >= limits.relations) refuse("quota", `at most ${limits.relations} references per member`, { limit: "relations" });
      if (m.charged + charge > limits.memberQuota) refuse("quota", "this member's transfer quota is used up", { limit: "member" });
      if (totalCharged(h) + charge > limits.totalQuota) refuse("quota", "the relay's transfer storage is full", { limit: "total" });
      h.run("INSERT INTO transfer_relations (tid, op, recipient_member, devices, charge, created, sender) VALUES (?, ?, ?, ?, ?, ?, ?)", r.tid, op, recipient, JSON.stringify(devices), charge, now(), principal);
      adjust(h, requester.member, { charged: charge, relations: 1 });
      out.push({ uploader_device: b.uploader_device, transfer_id: b.transfer_id });
    }
    return out;
  }

  /**
   * Download authorization and one chunk (design 6, "Download authorization"): the requesting device
   * ({member, device}, an active device the caller checked) must be in a relation for the transfer,
   * the transfer neither terminal nor past relay_expires, and `reach(uploaderMember, member,
   * sender)` must still let the sender reach the recipient, for the principal that published the
   * relation as it is signed in now (its claim view, its broker family): "allow", "deny" or "hold".
   * One relation that allows is enough. An unknown and an unauthorized transfer get the same
   * "gone"; an authorized device learns "gone {state}" for an expired or aborted one, and
   * "unavailable" (try again later) while the sender's claim view is stale. One statement reads one
   * chunk.
   */
  function download({ requester, uploaderDevice, transferId, index, reach = () => "allow" }) {
    checkId(transferId);
    if (typeof uploaderDevice !== "string") refuse("gone", "no such transfer");
    const r = row(db, uploaderDevice, transferId);
    const relations = r ? db.all("SELECT devices, sender FROM transfer_relations WHERE tid = ? AND recipient_member = ?", r.tid, requester.member).filter((x) => JSON.parse(x.devices).includes(requester.device)) : [];
    if (!relations.length) refuse("gone", "no such transfer");
    const state = stateNow(r);
    if (state !== "sealed") refuse("gone", `the transfer is ${state}`, { state, ...(state === "expired" && r.relay_expires ? { relay_expires: r.relay_expires } : {}) });
    const verdicts = relations.map((x) => {
      const v = reach(r.uploader_member, requester.member, x.sender === null ? null : JSON.parse(x.sender));
      return v === true ? "allow" : v === false ? "deny" : v;
    });
    if (!verdicts.includes("allow")) {
      if (verdicts.includes("hold")) refuse("unavailable", "the relay cannot check the sender's access right now; try again later");
      refuse("gone", "no such transfer");
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= r.chunk_count) refuse("bad_request", `index must be from 0 to ${r.chunk_count - 1}`);
    const c = db.get("SELECT data FROM transfer_chunks WHERE tid = ? AND idx = ?", r.tid, index);
    if (!c) refuse("gone", "no such transfer");
    return { uploader_member: r.uploader_member, index, data: Buffer.from(c.data), chunk_count: r.chunk_count, total_bytes: r.total_bytes, root: Buffer.from(r.root).toString("hex"), relay_expires: r.relay_expires };
  }

  /**
   * The accounting from the rows (design 6: recomputed at startup): per member, the live rows' own
   * charges plus reserved_remaining and reclaiming, open transfers, slots and relations; and each
   * terminal transfer's reclaiming against its remaining chunks. Returns {members, mismatches}.
   */
  function recompute(h = db) {
    const members = new Map();
    const of = (id) => members.get(id) ?? members.set(id, { charged: 0, open: 0, slots: 0, relations: 0 }).get(id);
    for (const r of h.all("SELECT uploader_member AS m, count(*) AS n, sum(charge + reserved_remaining + reclaiming) AS c, sum(state = 'open') AS o FROM transfers GROUP BY uploader_member")) {
      Object.assign(of(r.m), { charged: Number(r.c), slots: Number(r.n), open: Number(r.o) });
    }
    for (const r of h.all("SELECT t.uploader_member AS m, sum(c.len) + ? * count(*) AS c FROM transfer_chunks c JOIN transfers t ON t.tid = c.tid WHERE t.released = 0 GROUP BY t.uploader_member", CHARGE.chunk)) of(r.m).charged += Number(r.c);
    for (const r of h.all("SELECT t.uploader_member AS m, count(*) AS n, sum(x.charge) AS c FROM transfer_relations x JOIN transfers t ON t.tid = x.tid GROUP BY t.uploader_member")) {
      of(r.m).charged += Number(r.c);
      of(r.m).relations = Number(r.n);
    }
    const mismatches = [];
    const reclaim = h.all("SELECT t.tid, t.reclaiming AS stored, coalesce((SELECT sum(len) + ? * count(*) FROM transfer_chunks c WHERE c.tid = t.tid), 0) AS actual FROM transfers t WHERE t.released = 1 AND (t.reclaiming > 0 OR EXISTS (SELECT 1 FROM transfer_chunks c WHERE c.tid = t.tid))", CHARGE.chunk);
    for (const r of reclaim) if (Number(r.stored) !== Number(r.actual)) mismatches.push({ kind: "reclaiming", tid: Number(r.tid) });
    for (const s of h.all("SELECT * FROM transfer_members")) {
      const c = members.get(s.member_id) ?? { charged: 0, open: 0, slots: 0, relations: 0 };
      if (["charged", "open", "slots", "relations"].some((k) => Number(s[k]) !== c[k])) mismatches.push({ kind: "member", member: s.member_id });
      members.delete(s.member_id);
    }
    for (const [id, c] of members) if (c.charged || c.open || c.slots || c.relations) mismatches.push({ kind: "member", member: id });
    return { mismatches };
  }

  const startup = recompute();
  if (startup.mismatches.length) {
    throw Object.assign(new Error(`the relay's transfer accounting does not match its rows (${startup.mismatches.length} difference(s)); restore the store from a backup`), { code: "ERELAYDB" });
  }

  /** Terminate expired transfers, at most BATCH per transaction. Returns how many. */
  function expireBatch() {
    return db.tx((h) => {
      const t = now();
      const due = h.all(`SELECT * FROM transfers WHERE (state = 'open' AND open_expires <= ?) OR (state = 'sealed' AND relay_expires <= ?) LIMIT ${BATCH}`, t, t);
      for (const r of due) terminate(h, r, "expired");
      return due.length;
    }, { cls: "maintenance" });
  }

  /** Delete at most BATCH chunks of terminal transfers, releasing their charge in the same transaction. */
  function reclaimBatch() {
    return db.tx((h) => {
      const rows = h.all(`SELECT c.tid, c.idx, c.len, t.uploader_member FROM transfer_chunks c JOIN transfers t ON t.tid = c.tid WHERE t.released = 1 ORDER BY c.tid, c.idx LIMIT ${BATCH}`);
      for (const c of rows) {
        h.run("DELETE FROM transfer_chunks WHERE tid = ? AND idx = ?", c.tid, c.idx);
        h.run("UPDATE transfers SET reclaiming = reclaiming - ? WHERE tid = ?", chunkCharge(c.len), c.tid);
        adjust(h, c.uploader_member, { charged: -chunkCharge(c.len) });
      }
      return rows.length;
    }, { cls: "maintenance" });
  }

  /** Remove tombstones past the replay horizon whose reclamation is finished, at most BATCH per transaction. */
  function forgetBatch() {
    return db.tx((h) => {
      const rows = h.all(`SELECT tid, uploader_member, charge FROM transfers t WHERE released = 1 AND terminal_at <= ? AND reclaiming = 0 AND NOT EXISTS (SELECT 1 FROM transfer_chunks c WHERE c.tid = t.tid) LIMIT ${BATCH}`, now() - REPLAY_HORIZON_MS);
      for (const r of rows) {
        h.run("DELETE FROM transfers WHERE tid = ?", r.tid);
        adjust(h, r.uploader_member, { charged: -r.charge, slots: -1 });
      }
      return rows.length;
    }, { cls: "maintenance" });
  }

  /**
   * The sweep: expiry, reclamation and tombstone removal in bounded transactions while admission
   * allows, capped vacuum steps, then a checkpoint attempt (never refused). A refused step ("busy")
   * ends that part of the sweep; the next sweep resumes. Returns what was done.
   */
  function sweep() {
    const out = { expired: 0, reclaimed: 0, forgotten: 0, vacuumed: 0, busy: false, checkpoint: null };
    const loop = (fn, key) => {
      for (let i = 0; i < BATCHES; i++) {
        let n;
        try {
          n = fn();
        } catch (e) {
          if (e.code !== "busy") throw e;
          out.busy = true;
          return;
        }
        out[key] += n;
        if (n < BATCH) return;
      }
    };
    loop(expireBatch, "expired");
    loop(reclaimBatch, "reclaimed");
    loop(forgetBatch, "forgotten");
    for (let i = 0; i < VACUUM_STEPS && Number(db.get("PRAGMA freelist_count").freelist_count) > 0; i++) {
      try {
        const n = db.vacuumStep();
        out.vacuumed += n;
        if (!n) break;
      } catch (e) {
        if (e.code !== "busy") throw e;
        out.busy = true;
        break;
      }
    }
    try {
      out.checkpoint = db.checkpoint();
      if (out.checkpoint.busy) log("transfers: the WAL checkpoint was busy (a reader holds the log); retried at the next sweep");
    } catch (e) {
      log("transfers: the WAL checkpoint failed:", e.message);
    }
    return out;
  }

  /** Counts for monitoring: no names, no ids. */
  function stats() {
    const r = db.get("SELECT count(*) AS n, coalesce(sum(state = 'open'), 0) AS open, coalesce(sum(state = 'sealed'), 0) AS sealed, coalesce(sum(released), 0) AS tombstones FROM transfers");
    return { transfers: Number(r.n), open: Number(r.open), sealed: Number(r.sealed), tombstones: Number(r.tombstones), charged: totalCharged(db) };
  }

  return { begin, chunk, status, commit, abort, publish, download, sweep, stats, recompute: () => recompute(db), expireBatch, reclaimBatch, forgetBatch, limits, usage: (id) => member(db, id) };
}

