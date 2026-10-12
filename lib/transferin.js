// The receiver's side of a larger transfer (design 6, "6.2 Download and staging"). EXPERIMENTAL.
//
// Before any byte is fetched, the intake checks: the authenticated sender's contacts entry allows
// transfers (`transfers` in contacts.json; the default is not allowed) and its maxBytes, the
// sender may reach this session at all, and the home's caps have room (bytes staged, files staged,
// downloads at once). A review set sent as a transfer needs no transfers entry, but at most 8 MiB.
// Then it reserves a slot in the home's staging ledger, <home>/incoming/ledger.json, written with
// the durable writer under <home>/incoming/.lock:
//   entries   t_<random> -> {key (uploader member, device, transfer_id), bytes, state, ...}
//   states    reserved -> staged -> saved -> removed, or reserved -> removed (failure, cancel)
// Every entry in reserved, staged or saved counts against both caps (bytes and files); reserved
// entries also count as downloads at once. An entry's charge is released only at "removed", which
// is written after its folder was deleted and the deletion synced. Removed entries are dropped from
// the ledger 7 days after removal, in any later write.
//
// Each transfer has a folder named by its local id, <home>/incoming/<t_id>/ (0700): `data` (the
// plaintext at its offsets, 0600), `descriptor.json` (the key, header and root from the descriptor,
// written once at the intake) and `state.json` (each present chunk's plaintext SHA-256, the
// progress). A chunk is recorded only after its plaintext is
// written and synced; on a restart every recorded chunk is read back and checked, and mismatches
// are fetched again. Damaged state, or data shorter than recorded, restarts the download from
// index 0, once. A chunk that fails verification is fetched again once, then the transfer fails.
// Completion needs the plaintext SHA-256 of the whole file to equal the header's; only then is it
// staged. Remote names never choose a local path.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { transferCaps, transferPolicy } from "./contacts.js";
import { writeDurable } from "./credentials.js";
import { tryLock, withLock } from "./locks.js";
import { CHUNK_SIZE, TransferFormatError, decodeHeader, decryptChunk, plainLength } from "./transferwire.js";

export const STAGED_KEEP_MS = 7 * 86_400_000; // staged and never saved: deleted after this
export const REMOVED_KEEP_MS = 7 * 86_400_000; // removed entries stay in the ledger this long
export const MAX_REVIEW_SET_TRANSFER = 8 * 1024 * 1024; // serialized contents of a review set (5.1, raised for this transport)
const IN_FLIGHT = 4;
/** The end of every notice of a transfer refused for a full cap of the home. */
export const RESEND = "It will not be fetched later: the sender has to send it again after space is freed in this home.";
const T_RE = /^t_[0-9a-f]{24}$/;
const LIVE = new Set(["reserved", "staged", "saved"]);

export class StagingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const plainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const STATES = new Set(["reserved", "staged", "saved", "removed"]);
/** Whether `l` is exactly a version 1 staging ledger: {v: 1, entries: {t_...: entry}}. */
function ledgerOk(l) {
  if (!plainObject(l) || l.v !== 1 || !plainObject(l.entries)) return false;
  return Object.entries(l.entries).every(
    ([id, e]) =>
      T_RE.test(id) &&
      plainObject(e) &&
      e.t === id &&
      STATES.has(e.state) &&
      Number.isSafeInteger(e.bytes) &&
      e.bytes >= 0 &&
      plainObject(e.key) &&
      ["uploader_member", "uploader_device", "transfer_id"].every((k) => typeof e.key[k] === "string") &&
      ["file", "review_set"].includes(e.kind) &&
      Number.isFinite(e.created) &&
      Number.isFinite(e.relay_expires) &&
      plainObject(e.from) &&
      plainObject(e.to) &&
      // The times the sweeps compare against: a missing one would read as long past.
      (e.state === "staged" || e.state === "saved" ? Number.isFinite(e.staged_at) : true) &&
      (e.state === "removed" ? Number.isFinite(e.removed_at) : true),
  );
}

export const incomingDir = (home) => path.join(home, "incoming");
export const savesDir = (home) => path.join(home, "saves");
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

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
 * The staging area of home `home`. `contacts()` returns the contacts document (or null);
 * `admitted(sender, session)` whether the contacts gate lets that sender reach that session now
 * (a transfer is fetched only then); `fault(point, ...)` is for tests; `onStaged(entry, file)` is
 * told when a transfer is staged (a review set is handed on from there).
 */
export function createStaging({ home, contacts = () => null, admitted = () => true, now = () => Date.now(), log = () => {}, fault = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onStaged = async () => {} }) {
  const root = incomingDir(home);
  const ledgerFile = path.join(root, "ledger.json");
  const folderOf = (t) => path.join(root, t);
  const stateFile = (t) => path.join(folderOf(t), "state.json");
  const descriptorFile = (t) => path.join(folderOf(t), "descriptor.json");
  const dataFile = (t) => path.join(folderOf(t), "data");
  const ensure = () => fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  /**
   * The ledger: empty only when the file does not exist. Anything else that is not exactly the
   * ledger's shape (unparseable, another version, entries that are not entries) is an error: the
   * startup reconciliation would otherwise take it for an empty ledger and delete every folder.
   */
  function readLedger() {
    let text;
    try {
      text = fs.readFileSync(ledgerFile, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return { v: 1, entries: {} };
      throw new StagingError("ledger", `the staging ledger ${ledgerFile} cannot be read (${e.code ?? "error"}); hoptell doctor reports it`);
    }
    let l;
    try {
      l = JSON.parse(text);
    } catch {
      l = null;
    }
    if (!ledgerOk(l)) throw new StagingError("ledger", `the staging ledger ${ledgerFile} is damaged or of an unknown version; nothing in staging was changed (hoptell doctor reports it)`);
    return l;
  }
  /** Write the ledger durably, dropping removed entries older than REMOVED_KEEP_MS (compaction). */
  function writeLedger(l) {
    const t = now();
    for (const [id, e] of Object.entries(l.entries)) if (e.state === "removed" && t - (e.removed_at ?? 0) >= REMOVED_KEEP_MS) delete l.entries[id];
    fault?.("ledger-write", l);
    writeDurable(ledgerFile, `${JSON.stringify(l)}\n`);
  }
  /** Change the ledger under its lock: fn(ledger) mutates it; returns fn's result. */
  async function change(fn) {
    ensure();
    return withLock(ledgerFile, async () => {
      const l = readLedger();
      const r = await fn(l);
      writeLedger(l);
      return r;
    });
  }
  const keyOf = (k) => `${k.uploader_member}|${k.uploader_device}|${k.transfer_id}`;
  const charged = (l) => {
    const live = Object.values(l.entries).filter((e) => LIVE.has(e.state));
    return { bytes: live.reduce((n, e) => n + e.bytes, 0), files: live.length, downloads: live.filter((e) => e.state === "reserved").length };
  };

  /**
   * The intake of a received transfer (the e2ee layer's onTransfer): every check before any fetch,
   * then the reservation and its folder. Resolves to {note, t_id?, fetch: bool}; a repeated
   * delivery of the same transfer key answers its existing entry.
   */
  async function intake({ descriptor: d, reviewSet = null, sender, to, message_id, verified = false }) {
    const total = d.h.totalBytes;
    const key = { uploader_member: sender.member, uploader_device: d.uploader_device, transfer_id: Buffer.from(d.transfer_id).toString("hex") };
    const doc = contacts();
    return change(async (l) => {
      const prior = Object.values(l.entries).find((e) => keyOf(e.key) === keyOf(key));
      if (prior) return { note: prior.state === "removed" ? "this transfer was received before" : `already received as ${prior.t}`, t_id: prior.t, fetch: prior.state === "reserved" };
      if (reviewSet) {
        if (total > MAX_REVIEW_SET_TRANSFER) return { note: `not fetched: a review set sent as a transfer has at most ${MAX_REVIEW_SET_TRANSFER} bytes of contents`, fetch: false };
      } else {
        const p = transferPolicy(doc, sender.realm, sender.member);
        if (!p.allowed) return { note: "not fetched: your user has not allowed file transfers from this contact (transfers in contacts.json)", fetch: false };
        if (total > p.maxBytes) return { note: `not fetched: it is larger than the ${p.maxBytes} bytes your user allows from this contact`, fetch: false };
      }
      if (!(await admitted(sender, to.session))) return { note: "not fetched: the sender may not reach this session", fetch: false };
      const caps = transferCaps(doc);
      const c = charged(l);
      // A refusal for a full cap is final (nothing is kept to fetch later): the notice says so.
      if (c.bytes + total > caps.stagedBytes) return { note: `not fetched: the home's staging space is full (${c.bytes} of ${caps.stagedBytes} bytes used; hoptell transfers). ${RESEND}`, fetch: false };
      if (c.files + 1 > caps.stagedFiles) return { note: `not fetched: the home holds the most staged files it may (${caps.stagedFiles}; hoptell transfers). ${RESEND}`, fetch: false };
      if (c.downloads + 1 > caps.concurrent) return { note: `not fetched: ${caps.concurrent} downloads are already running in this home. ${RESEND}`, fetch: false };
      const t = `t_${crypto.randomBytes(12).toString("hex")}`;
      const dir = folderOf(t);
      fs.mkdirSync(dir, { mode: 0o700 });
      syncDir(root);
      writeDurable(descriptorFile(t), `${JSON.stringify({ v: 1, t, key: Buffer.from(d.key).toString("base64"), header: Buffer.from(d.header).toString("hex"), root: Buffer.from(d.root).toString("hex") })}\n`);
      writeDurable(stateFile(t), `${JSON.stringify({ v: 1, t, chunks: {} })}\n`);
      fault?.("intake-before-ledger", t);
      l.entries[t] = {
        t, key, bytes: total, state: "reserved", created: now(), from: sender, to, name: String(d.name).slice(0, 255), media_type: String(d.media_type).slice(0, 255), relay_expires: d.relay_expires, message_id,
        kind: reviewSet ? "review_set" : "file", ...(reviewSet ? { review: reviewSet } : {}), restarts: 0, verified: Boolean(verified),
      };
      return { note: `it is being fetched as ${t} (hoptell transfers)`, t_id: t, fetch: true };
    });
  }

  /** Delete a transfer's folder (synced), then mark it removed: its charge goes only then. */
  async function remove(t, error = null) {
    try {
      fault?.("before-folder-delete", t);
      fs.rmSync(folderOf(t), { recursive: true, force: true });
      fault?.("after-folder-delete", t);
      syncDir(root);
    } catch (e) {
      if (e.code === "EFAULT") throw e; // a test's crash
      // The charge stays; hoptell doctor retries the deletion.
      await change((l) => {
        if (l.entries[t]) l.entries[t].error = `the staging copy could not be deleted (${e.code ?? "error"}); hoptell doctor --fix retries`;
      });
      return false;
    }
    await change((l) => {
      const e = l.entries[t];
      if (!e || e.state === "removed") return;
      Object.assign(e, { state: "removed", removed_at: now(), ...(error ? { error } : {}) });
    });
    return true;
  }

  const readJson = (file, ok) => {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      return ok(v) ? v : null;
    } catch {
      return null;
    }
  };
  const readDescriptor = (t) => readJson(descriptorFile(t), (d) => d?.v === 1 && d.t === t && typeof d.key === "string" && typeof d.header === "string" && typeof d.root === "string");
  const readState = (t) => readJson(stateFile(t), (st) => st?.v === 1 && st.t === t && st.chunks && typeof st.chunks === "object" && !Array.isArray(st.chunks));
  const writeState = (t, st) => writeDurable(stateFile(t), `${JSON.stringify({ v: 1, t, chunks: st.chunks })}\n`);
  const entryOf = (t) => readLedger().entries[t] ?? null;

  /** Read `len` bytes at `pos` of an open file (fewer when the file is shorter). */
  function readAt(fd, pos, len) {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, pos + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  }

  /** The reason text for a refusal of the relay during a download. */
  const goneText = (e, entry) =>
    e.state === "expired" || now() >= entry.relay_expires
      ? `the sender's file expired at the relay on ${new Date(entry.relay_expires).toISOString()}`
      : "the sender withdrew the file, or it is no longer available to this device";

  /**
   * Fetch (or resume) reserved transfer `t` with `rpc(frame)` (the device's attached connection),
   * holding <home>/incoming/<t>.lock. Resolves to {state: "staged" | "failed" | "cancelled" |
   * "waiting" (the connection ended: resumed later) | "busy" (another process fetches it)}.
   */
  async function fetch(t, rpc) {
    if (!T_RE.test(t)) throw new StagingError("bad_request", "not a transfer id");
    ensure();
    const release = tryLock(path.join(root, `${t}.lock`));
    if (typeof release !== "function") return { state: "busy" };
    try {
      return await fetchLocked(t, rpc);
    } finally {
      release();
    }
  }

  async function fetchLocked(t, rpc) {
    const entry = entryOf(t);
    if (!entry || entry.state !== "reserved") return { state: entry?.state ?? "unknown" };
    if (entry.cancel) {
      await remove(t, "cancelled by your user");
      return { state: "cancelled" };
    }
    const desc = readDescriptor(t);
    let h;
    try {
      h = desc && decodeHeader(Buffer.from(desc.header, "hex"));
    } catch {
      h = null;
    }
    if (!desc || !h) return fail(t, "the transfer's descriptor in staging was damaged");
    const key = Buffer.from(desc.key, "base64");
    const st = { root: desc.root, chunks: readState(t)?.chunks ?? null };
    // Restart: every recorded chunk is read back and checked; damaged state or a short file
    // starts again from index 0, once.
    const fd = fs.openSync(dataFile(t), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const recorded = Object.keys(st.chunks ?? {}).map(Number);
      const valid = st.chunks !== null && recorded.every((i) => Number.isSafeInteger(i) && i >= 0 && i < h.chunkCount && /^[0-9a-f]{64}$/.test(st.chunks[i]));
      const needed = valid && recorded.length ? Math.max(...recorded.map((i) => i * CHUNK_SIZE + plainLength(h.totalBytes, i))) : 0;
      if (!valid || size < needed) {
        if (entry.restarts >= 1) return fail(t, "the partial download was damaged again");
        await change((l) => void (l.entries[t].restarts = (l.entries[t].restarts ?? 0) + 1));
        fs.ftruncateSync(fd, 0);
        fs.fsyncSync(fd);
        st.chunks = {};
        writeState(t, st);
      } else {
        for (const i of recorded) {
          if (sha256hex(readAt(fd, i * CHUNK_SIZE, plainLength(h.totalBytes, i))) !== st.chunks[i]) delete st.chunks[i];
        }
      }
      const missing = [...Array(h.chunkCount).keys()].filter((i) => st.chunks[i] === undefined);
      const retried = new Set();
      const ask = async (i) => {
        for (let tries = 0; ; tries++) {
          try {
            return { i, r: await rpc({ type: "download", uploader_device: entry.key.uploader_device, transfer_id: entry.key.transfer_id, from_index: i }) };
          } catch (e) {
            if (["busy", "rate_limited"].includes(e.code) && tries < 30) {
              await sleep(Math.min(e.retry_after_ms ?? 1000, 30_000));
              continue;
            }
            return { i, e };
          }
        }
      };
      const window = [];
      let next = 0;
      const fill = () => {
        while (window.length < IN_FLIGHT && next < missing.length) window.push(ask(missing[next++]));
      };
      fill();
      while (window.length) {
        const { i, r, e } = await window.shift();
        if (e) {
          if (e.code === "gone") return fail(t, goneText(e, entry));
          if (["no_answer", "lost", "not_sent", "unavailable", "not_attached"].includes(e.code ?? e.kind)) return { state: "waiting" };
          return fail(t, `the relay refused the download (${e.code ?? "error"})`);
        }
        // The relay's view must match the authenticated descriptor: the root, the count, the index.
        if (r.root !== st.root || r.chunk_count !== h.chunkCount || r.index !== i || typeof r.data !== "string") return fail(t, "the relay's committed transfer differs from the sender's descriptor");
        let plain;
        try {
          plain = decryptChunk({ key, header: h, index: i, ciphertext: Buffer.from(r.data, "base64") });
        } catch (x) {
          if (!(x instanceof TransferFormatError)) throw x;
          if (retried.has(i)) return fail(t, `chunk ${i} failed verification twice`);
          retried.add(i); // fetched again once
          missing.push(i);
          fill();
          continue;
        }
        try {
          fault?.("before-chunk-write", t, i);
          for (let off = 0; off < plain.length; ) off += fs.writeSync(fd, plain, off, plain.length - off, i * CHUNK_SIZE + off);
          fs.fsyncSync(fd);
          fault?.("after-chunk-write", t, i);
          st.chunks[i] = sha256hex(plain);
          writeState(t, st);
        } catch (x) {
          if (x.code === "EFAULT") throw x;
          return fail(t, `the staging copy could not be written (${x.code ?? "error"})`);
        }
        if (entryOf(t)?.cancel) {
          await remove(t, "cancelled by your user");
          return { state: "cancelled" };
        }
        fill();
      }
      // Completion: the whole file's plaintext SHA-256 must be the header's.
      const size2 = fs.fstatSync(fd).size;
      if (size2 !== h.totalBytes) fs.ftruncateSync(fd, h.totalBytes);
      const hash = crypto.createHash("sha256");
      for (let pos = 0; pos < h.totalBytes; pos += CHUNK_SIZE) hash.update(readAt(fd, pos, Math.min(CHUNK_SIZE, h.totalBytes - pos)));
      if (hash.digest("hex") !== h.plaintextSha256.toString("hex")) return fail(t, "the downloaded file does not match the sender's digest");
    } finally {
      fs.closeSync(fd);
    }
    fault?.("before-staged", t);
    await change((l) => {
      const e = l.entries[t];
      if (e?.state === "reserved") Object.assign(e, { state: "staged", staged_at: now() });
    });
    const staged = entryOf(t);
    try {
      await onStaged(staged, dataFile(t));
    } catch (e) {
      log(`transfers: a staged transfer could not be handed on (${e.message})`);
    }
    return { state: "staged" };
  }

  async function fail(t, reason) {
    log(`transfers: ${t} failed: ${reason}`);
    await remove(t, reason);
    return { state: "failed", reason };
  }

  /** The startup reconciliation of the ledger with the folders (and the ledger's compaction). */
  async function reconcile() {
    ensure();
    return change((l) => {
      const out = { foldersDeleted: 0, entriesRemoved: 0, backToReserved: 0 };
      let names = [];
      try {
        names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && T_RE.test(d.name)).map((d) => d.name);
      } catch {}
      for (const n of names) {
        if (!l.entries[n] || l.entries[n].state === "removed") {
          fs.rmSync(folderOf(n), { recursive: true, force: true });
          out.foldersDeleted++;
        }
      }
      if (out.foldersDeleted) syncDir(root);
      for (const e of Object.values(l.entries)) {
        if (!LIVE.has(e.state)) continue;
        if (!names.includes(e.t)) {
          Object.assign(e, { state: "removed", removed_at: now() });
          out.entriesRemoved++;
          continue;
        }
        if (e.state === "staged") {
          let size = -1;
          try {
            size = fs.statSync(dataFile(e.t)).size;
          } catch {}
          if (size < e.bytes) {
            // Shorter than recorded: back to reserved, its chunks re-verified at the next fetch.
            Object.assign(e, { state: "reserved" });
            delete e.staged_at;
            out.backToReserved++;
          }
        }
      }
      return out;
    });
  }

  /** Remove staged transfers never saved within STAGED_KEEP_MS (under each entry's save lock). */
  async function sweep() {
    const out = { removed: 0, kept: 0 };
    for (const e of Object.values(readLedger().entries)) {
      if (e.state !== "staged" || now() - e.staged_at < STAGED_KEEP_MS) continue;
      const release = saveLock(e.t);
      if (typeof release !== "function") {
        out.kept++;
        continue;
      }
      try {
        if (entryOf(e.t)?.state === "staged" && (await remove(e.t, "not saved within 7 days"))) out.removed++;
      } finally {
        release();
      }
    }
    await change(() => {}); // compaction
    return out;
  }

  /** The save lock of an entry (design 6: save, its recovery, cleanup and ledger changes for it). */
  function saveLock(t) {
    fs.mkdirSync(savesDir(home), { recursive: true, mode: 0o700 });
    return tryLock(path.join(savesDir(home), `${t}.lock`));
  }

  /**
   * Cancel a transfer of this device: a reserved one stops at its next chunk (or now, when no
   * process fetches it); a staged one is deleted. Only this device's copy is affected.
   */
  async function cancel(t) {
    const e = entryOf(t);
    if (!e || !LIVE.has(e.state)) throw new StagingError("unknown", `no transfer ${t} is waiting`);
    if (e.state === "saved") throw new StagingError("saved", `${t} was saved; its staging copy goes with the save's completion (hoptell doctor)`);
    if (e.state === "staged") {
      const release = saveLock(t);
      if (typeof release !== "function") throw new StagingError("locked", `a save of ${t} is in progress (process ${release.pid})`);
      try {
        await remove(t, "cancelled by your user");
      } finally {
        release();
      }
      return { state: "removed" };
    }
    await change((l) => void (l.entries[t].cancel = true));
    const release = tryLock(path.join(root, `${t}.lock`));
    if (typeof release === "function") {
      try {
        await remove(t, "cancelled by your user");
      } finally {
        release();
      }
      return { state: "removed" };
    }
    return { state: "cancelling" };
  }

  return {
    intake,
    fetch,
    reconcile,
    sweep,
    cancel,
    remove,
    saveLock,
    change,
    readLedger,
    folderOf,
    dataFile,
    /** The transfers this home has, newest first (never the key). */
    list: () => Object.values(readLedger().entries).sort((a, b) => b.created - a.created),
    /** Reserved transfers to resume (optionally only those for one target session). */
    pending: (session = null) => Object.values(readLedger().entries).filter((e) => e.state === "reserved" && (session === null || e.to?.session === session)).map((e) => e.t),
  };
}

