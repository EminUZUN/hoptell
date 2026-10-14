// The receive pipeline of a protocol-2 session's bound storage (design 1.4): pending messages,
// claimed batches with receipts, acknowledgement tombstones, delivery ids, quotas and durable
// writes. Every state change is a short transaction under store.json.lock; a record found in an
// intermediate state while holding the lock belongs to a transaction that did not finish (a crash
// or an exception), and recovery completes or rolls it back before anything else happens.
//
//   inbox/<ts>-<seq>-<rand>~<delivery id>[.r<n>].json   pending
//   claimed/<receipt>.json + claimed/<receipt>/          a batch handed to a consumer
//   done/<receipt>.json                                   acknowledged receipts (bounded)
//   seen/<delivery id>                                    delivery ids (bounded)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "./config.js";
import { currentBoot, processInfo } from "./host.js";
import { withLock } from "./locks.js";

export const STORAGE_VERSION = 2;
export const BATCH_MAX = 20;
export const BATCH_BYTES = 256 * 1024;
export const QUOTA_MESSAGES = 1000;
export const QUOTA_BYTES = 50 * 1024 * 1024;
export const SEEN_MAX = 10_000;
export const SEEN_MAX_AGE_MS = 8 * 86400_000;
export const DONE_MAX = 256;
export const DONE_MAX_AGE_MS = 24 * 3600_000;

// <ts>-<seq>-<rand>[~<delivery id>][.r<n>][.a].json: .r<n> redelivered n times; .a released by
// the owner (allow-once), which a later "ask" does not quarantine again.
const MSG_RE = /^(\d{13}-\d{8}-[0-9a-f]{8})(?:~([A-Za-z0-9_-]{1,64}))?(?:\.r(\d{1,4}))?(\.a)?\.json$/;
const RECEIPT_RE = /^r_[a-z2-7]{26}$/;
const DELIVERY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const b32 = (n) => [...crypto.randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");
export const newReceipt = () => `r_${b32(26)}`;

/** A storage problem that makes a delivery wait (not confirmed): quota, full disk or I/O. */
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "full" | "storage"
  }
}

// ---- strict durable file operations ---------------------------------------------------------

const DIR_FSYNC = process.platform !== "win32"; // Windows cannot fsync a directory: skipped by design

function fsyncDir(dir, fault) {
  fault?.("dir-fsync", dir);
  if (!DIR_FSYNC) return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncFile(file, fault) {
  fault?.("file-fsync", file);
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write `data` to `file` durably: temporary file, fsync, rename, directory fsync. Errors propagate. */
function durableWrite(file, data, fault) {
  const tmp = path.join(path.dirname(file), `.tmp-${b32(10)}`);
  try {
    fault?.("write", file);
    fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
    fsyncFile(tmp, fault);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(path.dirname(file), fault);
}

/** Rename across folders durably (both folders synced). */
function durableMove(from, to, fault) {
  fault?.("move", from);
  fs.renameSync(from, to);
  fsyncDir(path.dirname(to), fault);
  fsyncDir(path.dirname(from), fault);
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};
// Quota exhaustion is "full" (room returns when messages are acknowledged); a full disk or any
// other I/O error is "storage" (it may clear by itself, so it is retried more slowly).
const storageError = (e) =>
  e instanceof StoreError ? e : new StoreError("storage", ["ENOSPC", "EDQUOT"].includes(e.code) ? `the disk is full (${e.code})` : e.code ? `storage error (${e.code})` : e.message);

/** This process as a consumer identity (pid + start time + boot, so PID reuse cannot hold a claim). */
export function processConsumer(kind, id = null) {
  const info = processInfo(process.pid);
  return { kind, ...(id ? { id } : {}), pid: process.pid, start: info?.start ?? null, boot: currentBoot() };
}

// ---- the store ------------------------------------------------------------------------------

/**
 * Open the pipeline of bound storage `bound` ({dir, inbox, seen}). `receipts` ("on"/"off") is the
 * wanted policy, applied only when no claim is outstanding; null keeps the stored one ("on" for
 * a new store). `leaseMs` is the claim lease. `fault`
 * (tests only) is called at named points and may throw; `now`, `quotaMessages` and `quotaBytes`
 * are adjustable for tests. Returns the store API.
 */
export async function openStore(bound, { managed = false, receipts = null, leaseMs = 30 * 60_000, now = () => Date.now(), fault = null, log = () => {}, quotaMessages = QUOTA_MESSAGES, quotaBytes = QUOTA_BYTES, admit = null, room = null } = {}) {
  // Hosted mode (design 4.5): `admit(bytes)` may refuse a new message (text, or null to allow) at
  // the host's limits, and `room(bytes)` decides when receiving resumes (with its hysteresis).
  const admitted = (bytes) => {
    const why = admit?.(bytes);
    if (why) throw Object.assign(new StoreError("full", why), { bytes });
  };
  const dir = bound.dir;
  const inbox = ensurePrivateDir(bound.inbox);
  const seen = ensurePrivateDir(bound.seen);
  const claimed = ensurePrivateDir(path.join(dir, "claimed"));
  const done = ensurePrivateDir(path.join(dir, "done"));
  ensurePrivateDir(path.join(dir, "quarantine")); // reserved for contacts and quarantine
  ensurePrivateDir(path.join(dir, "decisions"));
  const meta = path.join(dir, "store.json");
  const lockOf = meta;

  const tx = (fn) =>
    withLock(lockOf, () => {
      const m = readMeta();
      recover();
      return fn(m);
    });

  function readMeta() {
    const m = readJson(meta);
    if (!m) return { v: 1, storage: STORAGE_VERSION, receipts: "on", gen: 0 };
    if (m.storage !== STORAGE_VERSION) throw new StoreError("storage", `${dir} uses storage version ${m.storage}; this hoptell supports ${STORAGE_VERSION}`);
    return m;
  }
  const writeMeta = (m) => durableWrite(meta, `${JSON.stringify(m)}\n`, fault);

  const recordFile = (r) => path.join(claimed, `${r}.json`);
  const batchDir = (r) => path.join(claimed, r);
  const records = () =>
    list(claimed)
      .filter((f) => f.endsWith(".json") && RECEIPT_RE.test(f.slice(0, -5)))
      .map((f) => readJson(path.join(claimed, f)))
      .filter(Boolean);
  const writeRecord = (rec) => durableWrite(recordFile(rec.receipt), `${JSON.stringify(rec)}\n`, fault);
  const removeRecord = (rec) => {
    fs.rmSync(batchDir(rec.receipt), { recursive: true, force: true });
    fs.rmSync(recordFile(rec.receipt), { force: true });
    fsyncDir(claimed, fault);
  };

  const parse = (f) => {
    const m = f.match(MSG_RE);
    return m ? { base: m[1], delivery: m[2] ?? null, r: Number(m[3] ?? 0), approved: Boolean(m[4]) } : null;
  };
  const nameOf = ({ base, delivery, r, approved }) => `${base}${delivery ? `~${delivery}` : ""}${r ? `.r${r}` : ""}${approved ? ".a" : ""}.json`;
  const quarantine = path.join(dir, "quarantine");
  const quarantinedFiles = () => list(quarantine).filter((f) => MSG_RE.test(f)).sort();
  const pendingFiles = () => list(inbox).filter((f) => MSG_RE.test(f)).sort();

  /**
   * Make files that were moved into `to` durable: fsync each one that is there, then the folder.
   * Recovery runs this before it removes a journal, so a barrier that failed earlier (the rename
   * happened, its folder sync did not) is always completed first.
   */
  function settle(names, to) {
    for (const f of names) if (fs.existsSync(path.join(to, f))) fsyncFile(path.join(to, f), fault);
    fsyncDir(to, fault);
  }

  /** The inbox name a claimed file returns as: its redelivery count increased once. */
  const requeuedName = (f) => {
    const p = parse(f);
    return nameOf({ ...p, r: p.r + 1 });
  };

  function requeue(rec) {
    if (rec.state !== "requeuing") {
      rec.state = "requeuing"; // from here the receipt can no longer be acknowledged
      writeRecord(rec);
    }
    for (const f of list(batchDir(rec.receipt)).filter((x) => MSG_RE.test(x))) {
      const back = requeuedName(f);
      if (fs.existsSync(path.join(inbox, back))) fs.rmSync(path.join(batchDir(rec.receipt), f), { force: true }); // moved before: keep that copy
      else durableMove(path.join(batchDir(rec.receipt), f), path.join(inbox, back), fault);
    }
    settle(rec.files.map(requeuedName), inbox);
    removeRecord(rec);
  }

  function rollBackTaking(rec) {
    for (const f of list(batchDir(rec.receipt)).filter((x) => MSG_RE.test(x))) {
      if (!fs.existsSync(path.join(inbox, f))) durableMove(path.join(batchDir(rec.receipt), f), path.join(inbox, f), fault);
      else fs.rmSync(path.join(batchDir(rec.receipt), f), { force: true });
    }
    settle(rec.files, inbox);
    removeRecord(rec);
  }

  function finishAck(rec) {
    fs.rmSync(batchDir(rec.receipt), { recursive: true, force: true });
    durableWrite(path.join(done, `${rec.receipt}.json`), `${JSON.stringify({ v: 1, receipt: rec.receipt, consumer: rec.consumer, at: now() })}\n`, fault);
    fs.rmSync(recordFile(rec.receipt), { force: true });
    fsyncDir(claimed, fault);
  }

  const alive = new Map(); // per transaction: consumer identity -> alive
  /**
   * Whether a consumer process has certainly ended: its pid no longer exists, the boot changed,
   * or the pid now belongs to a process with another start time. When liveness cannot be read
   * (no ps, or an identity captured without a start time), the consumer is kept: its batch then
   * waits for acknowledgement, release or the lease.
   */
  function consumerEnded(c) {
    if (c.kind === "manual") return false;
    const key = `${c.pid}|${c.start}|${c.boot}`;
    if (!alive.has(key)) {
      let ended = false;
      if (c.boot && currentBoot() && c.boot !== currentBoot()) ended = true;
      else {
        let exists = true;
        try {
          process.kill(c.pid, 0);
        } catch (e) {
          exists = e.code === "EPERM";
        }
        if (!exists) ended = true;
        else if (c.start) {
          const info = processInfo(c.pid);
          ended = Boolean(info && info.start !== c.start); // reused pid; unreadable: unknown, kept
        }
      }
      alive.set(key, !ended);
    }
    return !alive.get(key);
  }

  /** Complete or roll back unfinished transactions; return expired or orphaned batches. */
  function recover() {
    alive.clear();
    for (const rec of records()) {
      if (rec.state === "taking") rollBackTaking(rec);
      else if (rec.state === "acking") finishAck(rec);
      else if (rec.state === "requeuing") requeue(rec);
      else if (rec.state === "held" && (rec.aside?.length || rec.screened?.length)) finishAside(rec);
      else if (rec.state === "held" && (rec.lease_until <= now() || consumerEnded(rec.consumer))) requeue(rec);
    }
    // Folders without a record are leftovers of a removal that did not finish. Their move intent
    // is recorded first (as a taking record), so a move whose inbox sync fails is completed by the
    // next recovery like any rolled-back take.
    for (const f of list(claimed)) {
      if (RECEIPT_RE.test(f) && !fs.existsSync(recordFile(f))) {
        const names = list(batchDir(f)).filter((y) => MSG_RE.test(y));
        if (!names.length) {
          fs.rmSync(batchDir(f), { recursive: true, force: true });
          fsyncDir(claimed, fault);
          continue;
        }
        const rec = { v: 1, receipt: f, gen: 0, state: "taking", consumer: { kind: "manual", id: "recovery" }, created: now(), lease_until: 0, files: names };
        writeRecord(rec);
        rollBackTaking(rec);
      }
    }
    // Claims left by pre-1.4 consumers (".claimed-<pid>-<file>") return to the inbox.
    for (const f of list(inbox)) {
      const m = f.match(/^\.claimed-(\d+)-(.+)$/);
      if (m && MSG_RE.test(m[2]) && !processInfo(Number(m[1]))) {
        try {
          fs.renameSync(path.join(inbox, f), path.join(inbox, m[2]));
          fsyncDir(inbox, fault);
        } catch {}
      }
    }
  }

  const sameConsumer = (a, b) => a.kind === b.kind && (a.id ?? null) === (b.id ?? null) && (a.kind === "manual" || (a.pid === b.pid && a.start === b.start));

  /**
   * Read a stored message. An I/O error (unreadable, EIO) is thrown as a storage error and the
   * file stays where it is; a file that is not valid JSON is moved to damaged/ (kept, never
   * deleted) and reported, so it cannot block the messages behind it.
   */
  const damagedDir = () => ensurePrivateDir(path.join(dir, "damaged"));

  /** Move a malformed file to damaged/ durably; a file already there counts as moved. */
  function setAside(from, f) {
    if (fs.existsSync(path.join(from, f))) durableMove(path.join(from, f), path.join(damagedDir(), f), fault);
    settle([f], damagedDir());
    return path.join(damagedDir(), f);
  }

  /**
   * Read a stored message. An I/O error (unreadable, EIO) is thrown as a storage error and the
   * file stays where it is; a file that is not valid JSON is reported as {malformed: true} (the
   * caller sets it aside, see setAside()).
   */
  function parseMessage(dirOf, f) {
    let text;
    try {
      text = fs.readFileSync(path.join(dirOf, f), "utf8");
    } catch (e) {
      throw new StoreError("storage", `a stored message could not be read (${e.code || "error"}): ${path.join(dirOf, f)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { malformed: true };
    }
  }

  /** A pending message: malformed ones are set aside at once (no record refers to them). */
  function readMessage(dirOf, f) {
    const m = parseMessage(dirOf, f);
    return m.malformed ? { damaged: setAside(dirOf, f) } : m;
  }

  /**
   * Finish setting aside the malformed files a held record lists in `aside` (recorded before
   * they were moved): move what is still in the batch, complete the barriers, drop the list.
   */
  function finishAside(rec) {
    if (!rec.aside?.length && !rec.screened?.length) return [];
    const at = (rec.aside ?? []).map((f) => setAside(batchDir(rec.receipt), f));
    // Messages the owner's policy now holds (moved to quarantine/) or blocks (deleted).
    for (const { f, verdict } of rec.screened ?? []) {
      const from = path.join(batchDir(rec.receipt), f);
      if (verdict === "ask") {
        if (fs.existsSync(from)) durableMove(from, path.join(quarantine, f), fault);
        settle([f], quarantine);
      } else if (fs.existsSync(from)) {
        fs.rmSync(from, { force: true });
        fsyncDir(batchDir(rec.receipt), fault);
      }
    }
    delete rec.aside;
    delete rec.screened;
    if (!rec.files.length) {
      rec.state = "acking";
      writeRecord(rec);
      finishAck(rec);
    } else writeRecord(rec);
    return at;
  }

  /**
   * The messages of a held batch; throws (keeping the batch) when one cannot be read. A damaged
   * file is set aside and removed from the batch (the record is rewritten); a batch left with
   * nothing to show is closed as acknowledged, so it cannot block the messages behind it.
   * Returns {messages, damaged, closed}.
   */
  /**
   * Apply the owner's current policy to a message about to be shown (design 1.5): "allow" keeps
   * it; "ask" moves it to quarantine/; "block" deletes it. A message the owner released
   * (approval flag) is not quarantined again, but a later block still applies.
   */
  /**
   * A screen's verdict for stored file `f`: "allow" | "ask" | "block". The owner's release
   * (approval flag) lifts "ask", never "policy" (plaintext from a contact whose encryption is
   * required, design 3.3): that stays held like "ask" whatever was approved before.
   */
  function verdictOf(screen, msg, f) {
    const v = screen(msg, f);
    if (v === "policy") return "ask";
    return v === "ask" && parse(f).approved ? "allow" : v;
  }

  function screenOut(screen, from, f, msg, out) {
    if (!screen) return false;
    const verdict = verdictOf(screen, msg, f);
    if (verdict === "allow") return false;
    if (verdict === "ask") {
      durableMove(path.join(from, f), path.join(quarantine, f), fault);
      settle([f], quarantine);
      out.quarantined.push({ file: f, msg });
    } else {
      fs.rmSync(path.join(from, f), { force: true });
      fsyncDir(from, fault);
      out.blocked++;
    }
    return true;
  }

  function readHeld(rec, screen = null, out = { quarantined: [], blocked: 0 }) {
    const messages = [];
    const damaged = [];
    const earlier = finishAside(rec); // a set-aside or screening interrupted before: complete it first
    if (rec.state !== "held") return { messages, damaged: earlier, closed: true };
    const screened = [];
    for (const f of rec.files) {
      const p = parse(f);
      const m = parseMessage(batchDir(rec.receipt), f);
      if (m.malformed) damaged.push({ f });
      else {
        const v = screen ? verdictOf(screen, m, f) : "allow";
        if (v !== "allow") screened.push({ f, verdict: v, msg: m });
        else messages.push({ file: f, msg: m, redelivered: p.r });
      }
    }
    if (damaged.length || screened.length) {
      // Record the intent first (durable), then move: an interruption is completed later.
      const leaving = new Set([...damaged.map((d) => d.f), ...screened.map((x) => x.f)]);
      rec.files = rec.files.filter((f) => !leaving.has(f));
      rec.aside = damaged.map((d) => d.f);
      rec.screened = screened.map((x) => ({ f: x.f, verdict: x.verdict }));
      for (const x of screened) if (x.verdict === "ask") out.quarantined.push({ file: x.f, msg: x.msg });
      else out.blocked++;
      writeRecord(rec);
      const at = finishAside(rec);
      return { messages, damaged: [...earlier, ...at], closed: rec.state !== "held" };
    }
    return { messages, damaged: earlier, closed: false };
  }

  function storedDeliveryIds() {
    const ids = new Map(); // delivery id -> full path
    for (const f of pendingFiles()) {
      const p = parse(f);
      if (p.delivery) ids.set(p.delivery, path.join(inbox, f));
    }
    for (const f of quarantinedFiles()) {
      const p = parse(f);
      if (p.delivery) ids.set(p.delivery, path.join(quarantine, f));
    }
    for (const rec of records()) {
      for (const f of list(batchDir(rec.receipt))) {
        const p = parse(f);
        if (p?.delivery) ids.set(p.delivery, path.join(batchDir(rec.receipt), f));
      }
    }
    return ids;
  }

  function usage() {
    let count = 0;
    let bytes = 0;
    const add = (d, f) => {
      try {
        bytes += fs.statSync(path.join(d, f)).size;
        count++;
      } catch {}
    };
    for (const f of pendingFiles()) add(inbox, f);
    for (const rec of records()) for (const f of list(batchDir(rec.receipt)).filter((x) => MSG_RE.test(x))) add(batchDir(rec.receipt), f);
    return { count, bytes };
  }

  function pruneMeta() {
    const seenFiles = list(seen).filter((f) => DELIVERY_RE.test(f));
    // At most SEEN_MAX ids; ages are checked now and then (and whenever the count is exceeded).
    if (seenFiles.length > SEEN_MAX || Math.random() < 0.01) {
      const aged = seenFiles.map((f) => ({ f, t: fs.statSync(path.join(seen, f)).mtimeMs })).sort((a, b) => a.t - b.t);
      const cut = now() - SEEN_MAX_AGE_MS;
      aged.forEach((x, i) => (x.t < cut || i < aged.length - SEEN_MAX) && fs.rmSync(path.join(seen, x.f), { force: true }));
    }
    // Tombstones: the last DONE_MAX, none older than DONE_MAX_AGE_MS, except that the tombstone of
    // a consumer's previous batch is kept while it holds its next batch.
    const held = new Set(records().map((r) => r.prev).filter(Boolean));
    const aged = list(done)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: readJson(path.join(done, f))?.at ?? 0 }))
      .sort((a, b) => a.t - b.t);
    const cut = now() - DONE_MAX_AGE_MS;
    aged.forEach((x, i) => (x.t < cut || i < aged.length - DONE_MAX) && !held.has(x.f.slice(0, -5)) && fs.rmSync(path.join(done, x.f), { force: true }));
  }

  /** Pending messages that can be shown now: readable and (with `screen`) allowed by the policy. */
  function visible(screen) {
    return pendingFiles().flatMap((f) => {
      let msg;
      try {
        msg = JSON.parse(fs.readFileSync(path.join(inbox, f), "utf8"));
      } catch {
        return [];
      }
      if (screen) {
        if (verdictOf(screen, msg, f) !== "allow") return [];
      }
      return [{ file: f, msg }];
    });
  }

  // Apply the wanted receipt policy (only without outstanding claims).
  await tx((m) => {
    // `managed`: this home's contacts are managed; recorded as a witness (design 1.5) and kept by
    // every later metadata write (they all start from the stored record).
    if (!fs.existsSync(meta)) return writeMeta({ ...m, receipts: receipts ?? "on", ...(managed ? { contacts: "managed" } : {}) });
    const next = { ...m, ...(managed ? { contacts: "managed" } : {}) };
    if (receipts && m.receipts !== receipts) {
      if (records().length) log(`receipts stay ${m.receipts} for this session: messages are still waiting for acknowledgement`);
      else next.receipts = receipts;
    }
    if (next.contacts !== m.contacts || next.receipts !== m.receipts) writeMeta(next);
  });

  return {
    dir,
    inbox,
    seen,
    /**
     * Store a delivery. Returns {state: "stored" | "duplicate", file}; throws StoreError (not
     * confirmed; a quota refusal carries the message's size in `bytes`).
     */
    append(msg) {
      return tx(() => {
        try {
          const id = DELIVERY_RE.test(msg?.id ?? "") ? msg.id : null;
          const marker = id ? path.join(seen, id) : null;
          if (id) {
            // Dedup before quota: a message already stored, or seen, is only confirmed, after
            // completing any durability barrier a failed earlier attempt may have left undone.
            const stored = storedDeliveryIds().get(id);
            if (stored || fs.existsSync(marker)) {
              if (stored) {
                fsyncFile(stored, fault);
                fsyncDir(path.dirname(stored), fault);
              }
              if (!fs.existsSync(marker)) durableWrite(marker, "", fault);
              else {
                fsyncFile(marker, fault);
                fsyncDir(seen, fault);
              }
              // The first durable commit may be this one (an earlier attempt failed after its
              // rename): the caller announces a file it has not announced yet.
              return { state: "duplicate", file: stored ? path.basename(stored) : null };
            }
          }
          const body = JSON.stringify(msg);
          admitted(Buffer.byteLength(body)); // the host's limits first (hosted mode): they say why
          const u = usage();
          if (u.count + 1 > quotaMessages || u.bytes + Buffer.byteLength(body) > quotaBytes) {
            throw Object.assign(new StoreError("full", "inbox full: acknowledge messages to free room"), { bytes: Buffer.byteLength(body) });
          }
          // Arrival order: the timestamp, then a sequence above any stored file with the same
          // timestamp (computed under the lock, so it holds across processes and reopens).
          const ts = String(now()).padStart(13, "0");
          let seq = 0;
          for (const f of [...pendingFiles(), ...records().flatMap((r) => list(batchDir(r.receipt)))]) {
            if (f.startsWith(`${ts}-`)) seq = Math.max(seq, Number(f.slice(14, 22)) + 1);
          }
          const file = nameOf({ base: `${ts}-${String(seq).padStart(8, "0")}-${crypto.randomBytes(4).toString("hex")}`, delivery: id, r: 0 });
          durableWrite(path.join(inbox, file), body, fault);
          if (marker) durableWrite(marker, "", fault);
          pruneMeta();
          return { state: "stored", file };
        } catch (e) {
          throw storageError(e);
        }
      });
    },

    /**
     * Take a batch for `consumer`. Returns {receipt, messages} (receipt null with receipts off,
     * messages already deleted), the consumer's outstanding batch again, or null when nothing waits.
     */
    take(consumer, { max = BATCH_MAX, maxBytes = BATCH_BYTES, signal = null, screen = null, strict = false } = {}) {
      return tx((m) => {
        if (signal?.aborted) return null; // the caller is stopping: no new claim
        let closedDamaged = [];
        // Messages the policy now holds (moved to quarantine) or blocks, for the caller.
        const out = { quarantined: [], blocked: 0 };
        if (m.receipts === "on") {
          const own = records().find((r) => r.state === "held" && sameConsumer(r.consumer, consumer));
          if (own) {
            const held = readHeld(own, screen, out);
            if (!held.closed) {
              // A composed read that already holds messages (strict): a held batch that does not
              // fit stays held for a later read (its receipt and lease are unchanged).
              const heldBytes = held.messages.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x.msg ?? {})), 0);
              if (strict && (held.messages.length > max || heldBytes > maxBytes)) return null;
              return { receipt: own.receipt, messages: held.messages, damaged: held.damaged, leaseUntil: own.lease_until, again: true, ...out };
            }
            closedDamaged = held.damaged; // its only messages were damaged: it is closed; report them below
          }
        }
        // Read before claiming: a message that cannot be read stays pending (and the error is
        // reported); a damaged one is set aside. Nothing is claimed that could not be shown.
        const pick = [];
        const damaged = [];
        let bytes = 0;
        for (const f of pendingFiles()) {
          const size = fs.statSync(path.join(inbox, f)).size;
          // The first always goes, unless `strict` (a composed read that already holds messages).
          if ((pick.length || strict) && (pick.length >= max || bytes + size > maxBytes)) break;
          let msg;
          try {
            msg = readMessage(inbox, f);
          } catch (e) {
            if (pick.length) break;
            throw e;
          }
          if (msg.damaged) {
            damaged.push(msg.damaged);
            continue;
          }
          if (screenOut(screen, inbox, f, msg, out)) continue;
          pick.push({ file: f, msg, redelivered: parse(f).r });
          bytes += size;
        }
        damaged.unshift(...closedDamaged);
        if (!pick.length) return damaged.length || out.quarantined.length || out.blocked ? { receipt: null, messages: [], damaged, ...out } : null;
        if (m.receipts === "off") {
          for (const x of pick) fs.rmSync(path.join(inbox, x.file), { force: true });
          fsyncDir(inbox, fault);
          return { receipt: null, messages: pick, damaged, ...out };
        }
        const gen = m.gen + 1;
        writeMeta({ ...m, gen });
        const prev = list(done)
          .filter((f) => f.endsWith(".json"))
          .map((f) => readJson(path.join(done, f)))
          .filter((d) => d && sameConsumer(d.consumer ?? {}, consumer))
          .sort((a, b) => b.at - a.at)[0]?.receipt;
        const files = pick.map((x) => x.file);
        const rec = { v: 1, receipt: newReceipt(), gen, state: "taking", consumer, created: now(), lease_until: now() + leaseMs, files, ...(prev ? { prev } : {}) };
        writeRecord(rec);
        fs.mkdirSync(batchDir(rec.receipt), { mode: 0o700 });
        fsyncDir(claimed, fault);
        for (const f of files) durableMove(path.join(inbox, f), path.join(batchDir(rec.receipt), f), fault);
        rec.state = "held";
        writeRecord(rec);
        return { receipt: rec.receipt, messages: pick, damaged, leaseUntil: rec.lease_until, again: false, ...out };
      });
    },

    /** Acknowledge a receipt: "ok" (now or before) or "unknown" (expired, evicted or mistyped). */
    ack(receipt) {
      if (!RECEIPT_RE.test(receipt ?? "")) return Promise.resolve("unknown");
      return tx(() => {
        if (fs.existsSync(path.join(done, `${receipt}.json`))) return "ok";
        const rec = readJson(recordFile(receipt));
        if (!rec || rec.state !== "held") return "unknown";
        rec.state = "acking"; // the commit point: from here the batch is acknowledged
        writeRecord(rec);
        finishAck(rec);
        pruneMeta();
        return "ok";
      });
    },

    /** Return the batches held by `consumer` to the inbox (a clean engine stop). */
    release(consumer) {
      return tx(() => {
        for (const rec of records()) if (rec.state === "held" && sameConsumer(rec.consumer, consumer)) requeue(rec);
      });
    },

    /**
     * Retention (hosted mode, design 4.5): delete messages that arrived before `cutoff` (ms),
     * acknowledged or not. A held batch with such a message is first returned to the inbox as a
     * unit through the journal (its receipt can no longer be acknowledged), so no claimed copy is
     * left behind; then expired inbox files are deleted. Returns how many were deleted.
     */
    expire(cutoff) {
      const old = (f) => Number(f.slice(0, 13)) < cutoff;
      return tx(() => {
        for (const rec of records()) if (rec.state === "held" && list(batchDir(rec.receipt)).some((f) => MSG_RE.test(f) && old(f))) requeue(rec);
        let n = 0;
        for (const f of pendingFiles()) {
          if (!old(f)) continue;
          fault?.("delete", f);
          fs.rmSync(path.join(inbox, f), { force: true });
          n++;
        }
        if (n) fsyncDir(inbox, fault);
        return n;
      });
    },

    /** Message files kept in damaged/ (set aside because they were not valid JSON). */
    damagedCount() {
      return tx(() => list(path.join(dir, "damaged")).filter((f) => f.endsWith(".json")).length);
    },

    /** Pending message file names (notices count only these). Runs recovery, so leases expire. */
    pending({ screen = null } = {}) {
      return screen ? tx(() => visible(screen).map((e) => e.file)) : tx(() => pendingFiles());
    },

    /**
     * Pending messages with their sender fields, for notices ({file, from, fromHost}); unreadable
     * ones are skipped, and with `screen` so are those the current policy would not show.
     */
    pendingEntries({ screen = null } = {}) {
      return tx(() => visible(screen).map((e) => ({ file: e.file, from: e.msg.from, fromHost: e.msg.fromHost })));
    },

    // ---- quarantine (design 1.5); callers hold the contacts lock around these --------------

    /** Record that this home's contacts are managed (a witness kept in store.json). */
    markManaged() {
      return tx((m) => {
        if (m.contacts !== "managed") writeMeta({ ...m, contacts: "managed" });
      });
    },

    /**
     * Whether a delivery is already stored (inbox, claimed, quarantine) or was seen: completes its
     * durability barriers and returns {file, where}, or null. Writes nothing new.
     */
    findDelivery(msg) {
      return tx(() => {
        try {
          const id = DELIVERY_RE.test(msg?.id ?? "") ? msg.id : null;
          if (!id) return null;
          const marker = path.join(seen, id);
          const stored = storedDeliveryIds().get(id);
          if (!stored && !fs.existsSync(marker)) return null;
          if (stored) {
            fsyncFile(stored, fault);
            fsyncDir(path.dirname(stored), fault);
          }
          if (!fs.existsSync(marker)) durableWrite(marker, "", fault);
          return { file: stored ? path.basename(stored) : null, where: stored ? path.basename(path.dirname(stored)) : "seen" };
        } catch (e) {
          throw storageError(e);
        }
      });
    },

    /** Store a held-back delivery in quarantine/: dedup and barriers as append. Returns {state, file}. */
    quarantineAppend(msg) {
      return tx(() => {
        try {
          const id = DELIVERY_RE.test(msg?.id ?? "") ? msg.id : null;
          const marker = id ? path.join(seen, id) : null;
          if (id) {
            const stored = storedDeliveryIds().get(id);
            if (stored || fs.existsSync(marker)) {
              if (stored) {
                fsyncFile(stored, fault);
                fsyncDir(path.dirname(stored), fault);
              }
              if (!fs.existsSync(marker)) durableWrite(marker, "", fault);
              else {
                fsyncFile(marker, fault);
                fsyncDir(seen, fault);
              }
              return { state: "duplicate", file: stored ? path.basename(stored) : null, where: stored ? path.basename(path.dirname(stored)) : null };
            }
          }
          admitted(Buffer.byteLength(JSON.stringify(msg)));
          const ts = String(now()).padStart(13, "0");
          let seq = 0;
          for (const f of quarantinedFiles()) if (f.startsWith(`${ts}-`)) seq = Math.max(seq, Number(f.slice(14, 22)) + 1);
          const file = nameOf({ base: `${ts}-${String(seq).padStart(8, "0")}-${crypto.randomBytes(4).toString("hex")}`, delivery: id, r: 0 });
          durableWrite(path.join(quarantine, file), JSON.stringify(msg), fault);
          if (marker) durableWrite(marker, "", fault);
          pruneMeta();
          return { state: "stored", file, where: "quarantine" };
        } catch (e) {
          throw storageError(e);
        }
      });
    },

    /** Quarantined messages: [{file, msg (null if unreadable), bytes, arrived}]. */
    quarantined() {
      return tx(() =>
        quarantinedFiles().map((f) => {
          let msg = null;
          let bytes = 0;
          try {
            bytes = fs.statSync(path.join(quarantine, f)).size;
            msg = JSON.parse(fs.readFileSync(path.join(quarantine, f), "utf8"));
          } catch {}
          return { file: f, msg, bytes, arrived: Number(f.slice(0, 13)) };
        }),
      );
    },

    /**
     * Release quarantined files into the inbox; with `approve` marked as approved by the owner
     * (allow-once), so a later "ask" does not hold them again.
     * Idempotent: a file already released counts as released. Stops at the inbox quota: the rest
     * is returned as waiting. Returns {released: [inbox names], waiting: [files]}.
     */
    releaseQuarantined(files, { approve = true } = {}) {
      return tx(() => {
        const released = [];
        const waiting = [];
        for (const f of files) {
          const p = parse(f);
          if (!p) continue;
          const to = nameOf({ ...p, approved: approve || p.approved });
          if (!fs.existsSync(path.join(quarantine, f))) {
            if (fs.existsSync(path.join(inbox, to))) released.push(to);
            continue;
          }
          const u = usage();
          const size = fs.statSync(path.join(quarantine, f)).size;
          if (waiting.length || u.count + 1 > quotaMessages || u.bytes + size > quotaBytes) {
            waiting.push(f);
            continue;
          }
          durableMove(path.join(quarantine, f), path.join(inbox, to), fault);
          released.push(to);
        }
        if (released.length) settle(released, inbox);
        return { released, waiting };
      });
    },

    /** Delete quarantined files (a block, or expiry). */
    deleteQuarantined(files) {
      return tx(() => {
        for (const f of files) if (MSG_RE.test(f)) fs.rmSync(path.join(quarantine, f), { force: true });
        fsyncDir(quarantine, fault);
      });
    },

    /** Whether a message of `bytes` would fit the quota now. */
    hasRoom(bytes = 1) {
      return tx(() => {
        const u = usage();
        return u.count + 1 <= quotaMessages && u.bytes + bytes <= quotaBytes && (!room || room(bytes));
      });
    },

    /** The stored receipt policy. */
    policy() {
      return tx((m) => m.receipts);
    },

    /**
     * Stored messages that carry an owner-channel nonce (design 7.2): [{nonce, realm, ref}] from
     * the inbox, claimed batches and the quarantine, so the replay store can be completed from
     * them (the message file is the source of truth).
     */
    ownerNonces() {
      return tx(() => {
        const out = [];
        for (const d of [inbox, ...records().map((r) => batchDir(r.receipt)), quarantine]) {
          for (const f of list(d)) {
            if (!MSG_RE.test(f)) continue;
            let m;
            try {
              m = readJson(path.join(d, f));
            } catch {
              continue; // damaged: set aside by a read, never shown
            }
            if (typeof m?.owner?.nonce === "string" && typeof m.owner.realm === "string") out.push({ nonce: m.owner.nonce, realm: m.owner.realm, ref: m.message_id ?? null, ts: Number.isFinite(m.owner.ts) ? m.owner.ts : null });
          }
        }
        return out;
      });
    },
  };
}
