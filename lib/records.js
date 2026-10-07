// Private records of snapshots sent with send_file, so verify_snapshot can later compare the
// original file with what was sent. A record holds the folder id and identity, the relative
// path, the digest and delivery metadata: never file contents, request text or credentials.
//
// Layout: <state dir>/snapshots/<session uuid>/<review request uuid>.json (0700 folders,
// 0600 files). Each MCP server instance has its own session folder.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REF_RE, ensurePrivateDir, stateDir } from "./config.js";
import { DIGEST_RE, MAX_SNAPSHOT_BYTES } from "./snapshot.js";
import { checkRelPath } from "./files.js";

export const RECORD_TTL_MS = 24 * 3600_000;
export const MAX_RECORDS = 256;
const MAX_RECORD_BYTES = 8192;
const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const STATES = ["prepared", "accepted", "rejected", "unknown"];
const DELIVERY = ["delivered", "queued", "unconfirmed", "fanout"];

export class RecordError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const snapshotsDir = () => path.join(stateDir(), "snapshots");
const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** A plain, private folder of ours; anything else is not trusted (never repaired on the read path). */
function privateDir(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return "missing";
  if (st.isSymbolicLink() || !st.isDirectory() || (ownUid() !== null && st.uid !== ownUid()) || (st.mode & 0o077) !== 0) return "unsafe";
  return "ok";
}

/** The store's folders as they are now: "ok", "missing" or "unsafe". */
function storeState(session) {
  for (const dir of [stateDir(), snapshotsDir(), ...(session ? [path.join(snapshotsDir(), session)] : [])]) {
    const s = privateDir(dir);
    if (s !== "ok") return s;
  }
  return "ok";
}

/** A local snapshot handle: "<session uuid>:<review request uuid>". */
export function parseSnapshotId(id) {
  const m = typeof id === "string" && id.match(/^([0-9a-f-]{36}):([0-9a-f-]{36})$/);
  if (!m || !REF_RE.test(m[1]) || !REF_RE.test(m[2])) throw new RecordError("invalid_snapshot_id", 'snapshot_id must be "<uuid>:<uuid>" as returned by send_file');
  return { session: m[1], request: m[2] };
}

const safePath = (p) => {
  try {
    checkRelPath(p);
    return true;
  } catch {
    return false;
  }
};

function validate(r, session, request) {
  const str = (v, max = 200) => typeof v === "string" && v.length > 0 && v.length <= max;
  const time = (t) => Number.isSafeInteger(t) && t > 0 && t <= 8.64e15; // representable as a Date
  const ok =
    r && typeof r === "object" && !Array.isArray(r) &&
    r.v === 1 && r.session_id === session && r.review_request_id === request &&
    time(r.created_at) && time(r.expires_at) && r.expires_at > r.created_at && r.expires_at - r.created_at <= RECORD_TTL_MS &&
    str(r.owner_peer, 64) && str(r.root_id, 32) && typeof r.root_identity === "string" && DIGEST_RE.test(r.root_identity) &&
    str(r.path, 1024) && safePath(r.path) && typeof r.sha256 === "string" && DIGEST_RE.test(r.sha256) &&
    Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= MAX_SNAPSHOT_BYTES && str(r.to, 64) && STATES.includes(r.send_state) &&
    (r.message_id === null || (typeof r.message_id === "string" && REF_RE.test(r.message_id))) &&
    (r.delivery_state === null || DELIVERY.includes(r.delivery_state)) &&
    (r.relay_expires_at === null || time(r.relay_expires_at));
  if (!ok) throw new RecordError("invalid_record");
  return r;
}

/** The store for one MCP server instance. */
export class RecordStore {
  constructor() {
    this.session = crypto.randomUUID();
    this.temps = new Set();
  }

  dir() {
    ensurePrivateDir(stateDir());
    ensurePrivateDir(snapshotsDir());
    return ensurePrivateDir(path.join(snapshotsDir(), this.session));
  }

  /** Live (unexpired) records of this instance. */
  count(now = Date.now()) {
    let n = 0;
    for (const f of fs.readdirSync(this.dir())) {
      if (!NAME_RE.test(f)) continue;
      try {
        if (this.read(`${this.session}:${f.slice(0, -5)}`).expires_at > now) n++;
      } catch {
        n++; // unreadable: count it rather than risk going over the cap
      }
    }
    return n;
  }

  /** Write a record atomically: exclusive no-follow temp file, fsync, rename. */
  write(record) {
    const dir = this.dir();
    const body = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw new RecordError("storage_error", "the snapshot record is too large");
    const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}`);
    this.temps.add(tmp);
    try {
      const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, body, "utf8"); // writes the whole body, or throws
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, path.join(dir, `${record.review_request_id}.json`));
      // Persist the new directory entry too, not only the file's bytes.
      const dfd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e instanceof RecordError ? e : new RecordError("storage_error", "could not save the snapshot record");
    } finally {
      this.temps.delete(tmp);
    }
  }

  /** Create the record for a new snapshot, before it is sent. Refuses when this instance is full. */
  prepare(fields, now = Date.now()) {
    if (this.count(now) >= MAX_RECORDS) throw new RecordError("storage_full", `at most ${MAX_RECORDS} snapshot records can be kept; wait for older ones to expire`);
    const record = { v: 1, session_id: this.session, created_at: now, expires_at: now + RECORD_TTL_MS, send_state: "prepared", message_id: null, delivery_state: null, relay_expires_at: null, ...fields };
    validate(record, this.session, record.review_request_id);
    this.write(record);
    return record;
  }

  /** Record the outcome of the send. */
  update(record, changes) {
    const next = { ...record, ...changes };
    validate(next, record.session_id, record.review_request_id);
    this.write(next);
    return next;
  }

  /** Read and validate a record by its handle, from any session of this user. */
  read(snapshotId) {
    const { session, request } = parseSnapshotId(snapshotId);
    const file = path.join(snapshotsDir(), session, `${request}.json`);
    // Trust nothing in a store that others could have written to.
    const state = storeState(session);
    if (state === "missing") throw new RecordError("unknown");
    if (state === "unsafe") throw new RecordError("invalid_record");
    const entry = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!entry) throw new RecordError("unknown");
    const plainPrivate = (st) => st.isFile() && st.nlink === 1 && (ownUid() === null || st.uid === ownUid()) && (st.mode & 0o077) === 0;
    if (!plainPrivate(entry)) throw new RecordError("invalid_record");
    let raw;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (opened.ino !== entry.ino || opened.dev !== entry.dev || !plainPrivate(opened)) throw new RecordError("invalid_record");
        const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
        let n = 0;
        let got;
        while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
        if (n > MAX_RECORD_BYTES) throw new RecordError("invalid_record");
        raw = buf.subarray(0, n).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      throw e instanceof RecordError ? e : new RecordError("invalid_record");
    }
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      throw new RecordError("invalid_record");
    }
    return validate(r, session, request);
  }

  /** Remove this instance's leftover temp files and this user's expired, well-formed records. */
  cleanup(now = Date.now()) {
    for (const t of this.temps) fs.rmSync(t, { force: true });
    if (storeState() !== "ok") return; // never traverse or delete in a store others can write to
    let sessions;
    try {
      sessions = fs.readdirSync(snapshotsDir());
    } catch {
      return;
    }
    for (const s of sessions) {
      if (!REF_RE.test(s)) continue;
      const dir = path.join(snapshotsDir(), s);
      if (privateDir(dir) !== "ok") continue;
      const names = fs.readdirSync(dir);
      for (const f of names) {
        if (!NAME_RE.test(f)) continue;
        try {
          if (this.read(`${s}:${f.slice(0, -5)}`).expires_at <= now) fs.rmSync(path.join(dir, f));
        } catch {
          // malformed or unreadable: left alone, never deleted by guesswork
        }
      }
      // Another session's folder is removed only when empty and untouched for longer than a
      // record lives; a server that is still running recreates its folder on its next write.
      if (s !== this.session && fs.readdirSync(dir).length === 0 && now - fs.statSync(dir).mtimeMs > RECORD_TTL_MS) {
        try {
          fs.rmdirSync(dir);
        } catch {}
      }
    }
  }
}
