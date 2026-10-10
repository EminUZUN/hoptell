// The sender's side of a larger transfer (design 6, "6.1 Upload", "Sender side: encrypt once, then
// send stored bytes"). EXPERIMENTAL.
//
// Each transfer has a private outbox folder, <home>/outgoing/<random>/ (0700, files 0600):
//   capture     the plaintext, read once from the source (the guarded reader); the source file is
//               never read again. Deleted once the ciphertext is synced.
//   ciphertext  every chunk encrypted once, at fixed offsets (index * (chunk size + 16))
//   state.json  {transfer_id, header, key, phase, ...}, written with the durable writer
// Phases: "encrypting" (written and synced before the first chunk is encrypted) -> "encrypted"
// (with each chunk's SHA-256 and the root, after the ciphertext is synced) -> "sealed" (the relay
// committed it) -> "published" (the message carrying the descriptor exists in the encrypted
// messaging's durable state). Uploads send only bytes read back from `ciphertext`, checked against
// the recorded digest: every retry and resume resends those exact bytes, and a key is never used
// with bytes it was not first used with. A restart in "encrypting", a missing or damaged
// ciphertext, or a digest mismatch abandons the transfer (upload_abort if upload_begin was sent;
// the folder is deleted); a new send starts over with a fresh transfer id and key from a new
// capture. The relay's upload policy is live (amendments 3.5, A8): not_allowed or denied (at a
// chunk, the seal or the publication) ends the entry as refused (aborted at the relay, the folder
// deleted); unavailable (a stale view of the uploader's access) is waited out with backoff. The folder goes once its message is accepted, after an abort, or 24 hours after it was
// made (the open-transfer lifetime). The key lives only there and in the encrypted message.
//
// One upload writer per home holds <home>/outgoing/.lock for the whole operation.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "./credentials.js";
import { tryLock } from "./locks.js";
import { MAX_FRAME_BYTES } from "./mls/relayds.js";
import { CHUNK_SIZE, MAX_TOTAL_BYTES, TAG_BYTES, chunkCount, decodeHeader, encodeHeader, encryptChunk, newTransferId, newTransferKey, plainLength, rootOf } from "./transferwire.js";

export const OUTBOX_LIFETIME_MS = 24 * 3_600_000;
const PUBLISH_MIN_REMAINING_MS = 24 * 3_600_000; // the relay refuses a reference with less left
const IN_FLIGHT = 4; // chunks sent before their answers arrive
const SAVE_EVERY = 16; // stored indexes are recorded every this many chunks (a convenience)
const RETRIES = 30; // busy / rate-limited / unavailable answers waited out per step
const UNAVAILABLE_MAX_MS = 30_000; // a stale view of the uploader's access is waited out with backoff up to this
// The relay's upload policy refused the upload (amendments 3.5, A8): final for this upload.
const POLICY_REFUSED = new Set(["not_allowed", "denied"]);
const REFUSED_TEXT = "the relay's policy refused the upload; it has been withdrawn and its encrypted copy deleted (nothing was sent)";
const MAX_MISSING_ROUNDS = 3;
const FOLDER_RE = /^o_[0-9a-f]{24}$/;

/** A refusal or failure of a transfer, with a code. */
export class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const outgoingDir = (home) => path.join(home, "outgoing");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

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
 * The outbox of home `home`. `rpc(frame)` asks the relay on the device's attached connection;
 * `device()` is the uploader device's id; `now()` the clock; `onEncrypt(index)` is called once per
 * chunk encryption (tests count them); `fault(point)` is for tests; `sleep(ms)` waits; `newId()`
 * makes a transfer id (16 random bytes; tests choose one).
 */
export function createOutbox({ home, rpc, device, now = () => Date.now(), onEncrypt = () => {}, fault = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, newId = newTransferId }) {
  const root = outgoingDir(home);
  const stateFile = (dir) => path.join(dir, "state.json");
  const readState = (dir) => {
    try {
      const st = JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));
      return st && st.v === 1 ? st : null;
    } catch {
      return null;
    }
  };
  const writeState = (dir, st) => writeDurable(stateFile(dir), `${JSON.stringify(st)}\n`);

  function lock() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const release = tryLock(path.join(root, ".lock"));
    if (typeof release !== "function") throw new TransferError("busy", `another upload of this home is in progress (process ${release.pid}); try again when it ends`);
    return release;
  }

  /**
   * Ask the relay, waiting out "busy" (its retry_after_ms), "rate_limited" and "unavailable" (the
   * relay cannot check the uploader's access now, a stale claim view: A8; with backoff, as for a
   * lost connection); other refusals throw. Past RETRIES the error goes up and the entry stays for
   * the next recovery.
   */
  async function ask(frame) {
    for (let i = 0, wait = 1000; ; i++) {
      try {
        return await rpc(frame);
      } catch (e) {
        if (i >= RETRIES || !["busy", "rate_limited", "unavailable"].includes(e.code)) throw e;
        if (e.code === "unavailable") {
          await sleep(wait);
          wait = Math.min(wait * 2, UNAVAILABLE_MAX_MS);
        } else await sleep(Math.min(e.retry_after_ms ?? 1000, 30_000));
      }
    }
  }

  /** Abandon a transfer: upload_abort when upload_begin was sent (best effort), then the folder goes. */
  async function abandon(dir, st, why) {
    if (st?.begin_sent) {
      try {
        await ask({ type: "upload_abort", transfer_id: st.transfer_id });
      } catch (e) {
        log(`transfers: the abort of an abandoned upload was not confirmed (${e.code ?? e.message}); the relay ends it within 24 hours`);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    syncDir(root);
    log(`transfers: an upload was abandoned (${why})`);
  }

  /** Read chunk `i`'s bytes back from the ciphertext file and check them against the recorded digest. */
  function storedChunk(fd, h, st, i) {
    const len = plainLength(h.totalBytes, i) + TAG_BYTES;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, i * (CHUNK_SIZE + TAG_BYTES) + got);
      if (n <= 0) throw new TransferError("damaged", "the outbox's ciphertext is shorter than recorded");
      got += n;
    }
    if (sha256(buf).toString("hex") !== st.digests[i]) throw new TransferError("damaged", `chunk ${i} in the outbox does not match its recorded digest`);
    return buf;
  }

  /** Upload the stored chunks the relay may lack (all of `indexes`), up to IN_FLIGHT at a time. */
  async function sendChunks(dir, st, h, indexes) {
    const fd = fs.openSync(path.join(dir, "ciphertext"), "r");
    const stored = new Set(st.stored ?? []);
    let sinceSave = 0;
    try {
      const queue = indexes.filter((i) => !stored.has(i));
      const send = async (i) => {
        const data = storedChunk(fd, h, st, i);
        const frame = { type: "upload_chunk", transfer_id: st.transfer_id, index: i, data: data.toString("base64") };
        // The complete serialized frame, with its metadata, is checked against the relay's bound first.
        if (Buffer.byteLength(JSON.stringify({ ...frame, id: Number.MAX_SAFE_INTEGER })) > MAX_FRAME_BYTES) throw new TransferError("damaged", `chunk ${i} does not fit a relay frame`);
        for (let tries = 0; ; tries++) {
          try {
            await ask(frame);
            return;
          } catch (e) {
            // A lost answer: the same stored bytes again (the relay answers stored or chunk_conflict).
            if (["no_answer", "lost", "not_sent"].includes(e.code ?? e.kind) && tries < 3) continue;
            throw e;
          }
        }
      };
      while (queue.length) {
        const batch = queue.splice(0, IN_FLIGHT);
        await Promise.all(batch.map(send));
        for (const i of batch) stored.add(i);
        sinceSave += batch.length;
        fault?.("upload-chunks", st, stored.size);
        if (sinceSave >= SAVE_EVERY) {
          st.stored = [...stored].sort((a, b) => a - b);
          writeState(dir, st);
          sinceSave = 0;
        }
      }
      st.stored = [...stored].sort((a, b) => a - b);
      writeState(dir, st);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Take an outbox entry as far as it goes: upload, commit and publish (`publish(descriptor,
   * blobs, st)` resolves to the encrypted send's result). Throws TransferError when it is
   * abandoned or refused; returns {state, message_id, transfer_id, relay_expires}.
   */
  async function drive(dir, publish) {
    const st = readState(dir);
    if (!st) {
      await abandon(dir, null, "its state is missing or damaged");
      throw new TransferError("damaged", "the outbox entry was damaged and has been abandoned; send the file again");
    }
    if (now() - st.created >= OUTBOX_LIFETIME_MS && st.phase !== "published") {
      await abandon(dir, st, "older than 24 hours");
      throw new TransferError("expired", "the upload was not finished within 24 hours and has been abandoned; send the file again");
    }
    if (st.phase === "encrypting") {
      await abandon(dir, st, "it was interrupted while encrypting");
      throw new TransferError("abandoned", "the upload was interrupted while encrypting and has been abandoned; send the file again");
    }
    let h;
    try {
      h = decodeHeader(Buffer.from(st.header, "hex"));
      const size = fs.statSync(path.join(dir, "ciphertext")).size;
      if (size !== h.totalBytes + h.chunkCount * TAG_BYTES || !Array.isArray(st.digests) || st.digests.length !== h.chunkCount) throw new Error("short");
    } catch {
      await abandon(dir, st, "its ciphertext is missing or damaged");
      throw new TransferError("damaged", "the outbox's ciphertext was missing or damaged; the upload has been abandoned; send the file again");
    }
    try {
      if (st.phase === "encrypted") await upload(dir, st, h);
      if (st.phase === "sealed") return await publishSealed(dir, st, publish);
      if (st.phase === "published") return await settle(dir, st);
    } catch (e) {
      // The relay's policy refused it (A8): the entry ends as refused; the relay transfer is aborted
      // and the ciphertext deleted.
      if (POLICY_REFUSED.has(e.code) || e.code === "refused") {
        await abandon(dir, st, "refused by the relay's policy");
        throw e instanceof TransferError ? e : new TransferError("refused", REFUSED_TEXT);
      }
      if (e.code === "damaged" || e.code === "gone" || e.code === "chunk_conflict" || e.code === "transfer_conflict" || e.code === "expired") {
        await abandon(dir, st, e.code);
        throw e instanceof TransferError ? e : new TransferError(e.code, `the relay refused the upload (${e.code}); it has been abandoned; send the file again`);
      }
      throw e;
    }
    throw new TransferError("damaged", `unknown outbox phase ${st.phase}`);
  }

  async function upload(dir, st, h) {
    if (!st.begin_sent) {
      st.begin_sent = true; // before the frame: a restart then knows to abort it
      writeState(dir, st);
    }
    const begun = await ask({ type: "upload_begin", transfer_id: st.transfer_id, total_bytes: h.totalBytes, chunk_count: h.chunkCount, header_digest: h.digest.toString("hex") });
    if (begun.state === "aborted" || begun.state === "expired") throw new TransferError("gone", `the relay already ended this upload (${begun.state})`);
    let commit = null;
    if (begun.state === "open") {
      await sendChunks(dir, st, h, [...Array(h.chunkCount).keys()]);
      fault?.("before-commit", st);
      for (let round = 0; ; round++) {
        try {
          commit = await ask({ type: "upload_commit", transfer_id: st.transfer_id, root: st.root });
          break;
        } catch (e) {
          // The relay lacks chunks it reported: the same stored bytes again (never a new encryption).
          if (e.code !== "incomplete" || round >= MAX_MISSING_ROUNDS || !Array.isArray(e.missing)) throw e;
          st.stored = (st.stored ?? []).filter((i) => !e.missing.includes(i));
          await sendChunks(dir, st, h, e.missing.filter((i) => Number.isSafeInteger(i) && i >= 0 && i < h.chunkCount));
        }
      }
    } else commit = await ask({ type: "upload_commit", transfer_id: st.transfer_id, root: st.root }); // sealed: the same answer again
    if (commit.root !== st.root) throw new TransferError("damaged", "the relay sealed another root");
    Object.assign(st, { phase: "sealed", relay_expires: commit.relay_expires });
    delete st.stored;
    writeState(dir, st);
    fault?.("after-commit", st);
  }

  async function publishSealed(dir, st, publish) {
    if (st.relay_expires - now() < PUBLISH_MIN_REMAINING_MS) throw new TransferError("expired", "the upload expires at the relay within 24 hours; send the file again");
    const descriptor = { v: 1, uploader_device: device(), transfer_id: Buffer.from(st.transfer_id, "hex"), header: Buffer.from(st.header, "hex"), key: Buffer.from(st.key, "base64"), root: Buffer.from(st.root, "hex"), relay_expires: st.relay_expires, name: st.name, media_type: st.media_type };
    const blobs = [{ uploader_device: descriptor.uploader_device, transfer_id: st.transfer_id }];
    let r;
    try {
      r = await publish(descriptor, blobs, st);
    } catch (e) {
      // The relay's policy refused the publication (A8, or its access rules for the recipient now):
      // the entry ends as refused.
      if (POLICY_REFUSED.has(e.code)) throw new TransferError("refused", REFUSED_TEXT);
      // The relay refused the reference (blob_expiring, quota, gone): the message failed; the upload is withdrawn.
      if (["blob_expiring", "quota", "gone", "not_sealed"].includes(e.code)) throw new TransferError("expired", `the message carrying the file was refused (${e.code}); the upload has been withdrawn; send the file again`);
      throw e;
    }
    Object.assign(st, { phase: "published", message_id: r.message_id, publish_state: r.state });
    writeState(dir, st);
    fault?.("after-publish", st);
    if (r.state === "accepted") remove(dir);
    return { state: r.state, message_id: r.message_id, transfer_id: st.transfer_id, relay_expires: st.relay_expires, reason: r.reason ?? null };
  }

  /** A published entry: its folder goes once the message is accepted (or gone), or after 24 hours. */
  async function settle(dir, st, messageState = null) {
    const state = messageState ? await messageState(st.message_id) : st.publish_state;
    if (state === "accepted" || state === "sent" || state === null || now() - st.created >= OUTBOX_LIFETIME_MS) remove(dir);
    else if (state === "failed" || state === "expired") await abandon(dir, st, `its message ${state}`);
    return { state: state ?? "gone", message_id: st.message_id, transfer_id: st.transfer_id, relay_expires: st.relay_expires };
  }

  const remove = (dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    syncDir(root);
  };

  /** The outbox folders, oldest first. */
  function folders() {
    let names = [];
    try {
      names = fs.readdirSync(root).filter((n) => FOLDER_RE.test(n));
    } catch {}
    return names.map((n) => path.join(root, n)).sort((a, b) => (readState(a)?.created ?? 0) - (readState(b)?.created ?? 0));
  }

  /**
   * Finish what a restart interrupted, under the lock: each entry is driven on (published by
   * `publish`) or abandoned. `messageState(ref)` gives a published entry's message state. Returns
   * the outcomes.
   */
  async function recoverLocked(publish, messageState) {
    const out = [];
    for (const dir of folders()) {
      const st = readState(dir);
      try {
        if (st?.phase === "published") out.push(await settle(dir, st, messageState));
        else out.push(await drive(dir, publish));
      } catch (e) {
        out.push({ state: "abandoned", transfer_id: st?.transfer_id ?? null, reason: e.message });
      }
    }
    return out;
  }

  return {
    /**
     * Send a new transfer: `capture(fd)` writes the plaintext once to the open capture file and
     * resolves to {bytes, sha256 (hex)}; `publish(descriptor, blobs, st)` sends the encrypted
     * message carrying the descriptor. `meta` ({name, media_type, to, purpose, ...}) is kept in
     * the state for recovery. Entries a restart left are finished (or abandoned) first.
     */
    async send({ capture, publish, messageState = null, name = "", mediaType = "application/octet-stream", meta = {} }) {
      const release = lock();
      try {
        await recoverLocked(publish, messageState);
        const dir = path.join(root, `o_${crypto.randomBytes(12).toString("hex")}`);
        fs.mkdirSync(dir, { mode: 0o700 });
        syncDir(root);
        let st = null;
        try {
          // 1. Capture: the plaintext copy that is encrypted; the source is never read again.
          const capFile = path.join(dir, "capture");
          const fd = fs.openSync(capFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          let cap;
          try {
            cap = await capture(fd);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          if (!Number.isSafeInteger(cap?.bytes) || cap.bytes < 0 || cap.bytes > MAX_TOTAL_BYTES) throw new TransferError("too_large", `a transfer has at most ${MAX_TOTAL_BYTES} bytes`);
          if (fs.statSync(capFile).size !== cap.bytes) throw new TransferError("damaged", "the capture's size differs from what was read");
          // 2. Encrypt everything before anything leaves.
          const transferId = newId();
          const key = newTransferKey();
          const header = encodeHeader({ transferId, totalBytes: cap.bytes, plaintextSha256: Buffer.from(cap.sha256, "hex") });
          const h = decodeHeader(header);
          st = { v: 1, transfer_id: transferId.toString("hex"), header: header.toString("hex"), key: key.toString("base64"), phase: "encrypting", created: now(), name, media_type: mediaType, begin_sent: false, ...meta };
          writeState(dir, st);
          fault?.("after-encrypting", st);
          const inFd = fs.openSync(capFile, "r");
          const outFd = fs.openSync(path.join(dir, "ciphertext"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          const digests = [];
          const check = crypto.createHash("sha256");
          try {
            for (let i = 0; i < chunkCount(cap.bytes); i++) {
              const p = Buffer.alloc(plainLength(cap.bytes, i));
              for (let got = 0; got < p.length; ) {
                const n = fs.readSync(inFd, p, got, p.length - got, i * CHUNK_SIZE + got);
                if (n <= 0) throw new TransferError("damaged", "the capture is shorter than recorded");
                got += n;
              }
              check.update(p);
              const c = encryptChunk({ key, header: h, index: i, plaintext: p });
              onEncrypt(i);
              for (let off = 0; off < c.length; ) off += fs.writeSync(outFd, c, off, c.length - off, i * (CHUNK_SIZE + TAG_BYTES) + off);
              digests.push(sha256(c).toString("hex"));
              fault?.("encrypting-chunk", st, i);
            }
            if (check.digest("hex") !== cap.sha256) throw new TransferError("damaged", "the capture changed while it was encrypted");
            fs.fsyncSync(outFd);
          } finally {
            fs.closeSync(inFd);
            fs.closeSync(outFd);
          }
          const root32 = rootOf(digests.map((d, i) => ({ index: i, length: plainLength(cap.bytes, i) + TAG_BYTES, sha256: Buffer.from(d, "hex") })), h.chunkCount);
          Object.assign(st, { phase: "encrypted", digests, root: root32.toString("hex") });
          writeState(dir, st);
          fs.rmSync(capFile); // the plaintext copy goes once the ciphertext is synced
          syncDir(dir);
          fault?.("after-encrypted", st);
        } catch (e) {
          if (e.code === "EFAULT") throw e; // a test's crash: the folder stays as a crash leaves it
          await abandon(dir, st, e.code ?? "capture failed");
          throw e;
        }
        // 3. Upload, commit, publish.
        return await drive(dir, publish);
      } finally {
        release();
      }
    },
    /** Finish or abandon what a restart left (under the home's upload lock). */
    async recover({ publish, messageState = null }) {
      const release = lock();
      try {
        return await recoverLocked(publish, messageState);
      } finally {
        release();
      }
    },
    /** The outbox entries: {transfer_id, phase, created, name} (no key). */
    list: () => folders().map((d) => readState(d)).filter(Boolean).map((st) => ({ transfer_id: st.transfer_id, phase: st.phase, created: st.created, name: st.name })),
  };
}
