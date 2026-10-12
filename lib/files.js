// File tools support: approved folders and guarded reads.
//
// Approved folders come only from local settings (HOPTELL_SNAPSHOT_ROOTS), never from a peer.
// Each folder is resolved and opened once at startup; reads go through lib/read-helper.mjs, a
// separate process that starts inside that opened folder and checks every step of the path.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "read-helper.mjs");
const ROOT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_ROOTS = 16;
const MAX_CONFIG_BYTES = 8192;
const HELPER_TIMEOUT_MS = 2000;
const MAX_PENDING = 8;
const STDOUT_CAP = 768 * 1024; // a review set may read up to 512 KB (base64 grows it by a third)
const STDERR_CAP = 8 * 1024;
const COPY_BYTES_PER_SECOND = 10 * 1024 * 1024; // a capture's deadline: the base one plus 1 s per 10 MiB

/** A refusal with a fixed reason code; never carries file paths or other untrusted text. */
export class FileToolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/** Can this platform run the guarded reader? */
export const supported = () =>
  (process.platform === "darwin" || process.platform === "linux") && Boolean(fs.constants.O_DIRECTORY) && Boolean(fs.constants.O_NOFOLLOW);

/**
 * Parse HOPTELL_SNAPSHOT_ROOTS: a JSON array of {id, path}. Empty or "[]" means no file tools.
 * Throws FileToolError("invalid_config") with a fixed message; the raw value is never echoed.
 */
export function parseRoots(value) {
  if (value == null || String(value).trim() === "") return [];
  const bad = (why) => new FileToolError("invalid_config", `HOPTELL_SNAPSHOT_ROOTS is invalid: ${why}`);
  if (Buffer.byteLength(String(value), "utf8") > MAX_CONFIG_BYTES) throw bad(`longer than ${MAX_CONFIG_BYTES} bytes`);
  let list;
  try {
    list = JSON.parse(value);
  } catch {
    throw bad('not valid JSON (expected [{"id": "app", "path": "/absolute/folder"}])');
  }
  if (!Array.isArray(list)) throw bad("expected a JSON array");
  if (list.length > MAX_ROOTS) throw bad(`more than ${MAX_ROOTS} folders`);
  const ids = new Set();
  return list.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw bad(`entry ${i + 1} is not an object`);
    const keys = Object.keys(r).sort().join(",");
    if (keys !== "id,path") throw bad(`entry ${i + 1} must have exactly "id" and "path"`);
    if (typeof r.id !== "string" || !ROOT_ID_RE.test(r.id)) throw bad(`entry ${i + 1}: id must be lowercase letters, digits, "_" or "-", starting with a letter (max 32)`);
    if (ids.has(r.id)) throw bad(`duplicate id "${r.id}"`);
    ids.add(r.id);
    if (typeof r.path !== "string" || !path.isAbsolute(r.path) || r.path.includes("\0")) throw bad(`entry ${i + 1}: path must be an absolute folder path`);
    return { id: r.id, path: r.path };
  });
}

const identityOf = (canonical, st) =>
  `sha256:${crypto.createHash("sha256").update(`hoptell-root-v1\0${canonical}\0${st.dev}\0${st.ino}`).digest("hex")}`;

/**
 * Resolve and open each approved folder once. Returns Map id -> {id, canonical, fd, dev, ino, identity}.
 * The descriptors stay open for the life of the process.
 */
export function openRoots(list) {
  const roots = new Map();
  try {
    for (const entry of list) openRoot(roots, entry);
  } catch (e) {
    for (const r of roots.values()) fs.closeSync(r.fd); // no descriptors left behind
    throw e;
  }
  return roots;
}

function openRoot(roots, { id, path: p }) {
  let canonical;
  try {
    canonical = fs.realpathSync(p);
  } catch {
    throw new FileToolError("invalid_config", `approved folder "${id}" does not exist`);
  }
  if (path.parse(canonical).root === canonical) throw new FileToolError("invalid_config", `approved folder "${id}" is a filesystem root`);
  const entry = fs.lstatSync(canonical, { bigint: true });
  if (!entry.isDirectory()) throw new FileToolError("invalid_config", `approved folder "${id}" is not a folder`);
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let opened;
  try {
    opened = fs.fstatSync(fd, { bigint: true });
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
    fs.closeSync(fd);
    throw new FileToolError("invalid_config", `approved folder "${id}" changed while it was opened`);
  }
  roots.set(id, { id, canonical, fd, dev: opened.dev, ino: opened.ino, identity: identityOf(canonical, opened) });
}

/** Check a root-relative path from a tool call; throws FileToolError("path_unsafe"). */
export function checkRelPath(p) {
  const unsafe = () => new FileToolError("path_unsafe", "path must be a relative path inside the approved folder, with / between names");
  if (typeof p !== "string" || !p || Buffer.byteLength(p, "utf8") > 1024) throw unsafe();
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\x00-\x1f\x7f\\:\u2028\u2029]/.test(p) || p.startsWith("/") || p.startsWith("~")) throw unsafe();
  const parts = p.split("/");
  if (parts.length > 32 || parts.some((x) => x === "" || x === "." || x === "..")) throw unsafe();
  return p;
}

/**
 * A guarded file reader with its own queue: one read at a time, at most MAX_PENDING waiting.
 * `barrier` (tests only) is passed to the helper process, which pauses at a named step;
 * `timeoutMs` is the deadline per read (race tests give a paused helper more time).
 */
export function createReader({ barrier = null, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  let queue = Promise.resolve();
  let pending = 0;
  let closed = false;
  const active = new Set(); // running helper processes
  const stopped = () => new FileToolError("helper_failed", "this session is stopping");
  const readEntry = (root, rel, maxBytes) => {
    checkRelPath(rel);
    if (closed) return Promise.reject(stopped());
    if (pending >= MAX_PENDING) return Promise.reject(new FileToolError("helper_failed", "too many file reads waiting"));
    pending++;
    const job = queue.then(() => (closed ? Promise.reject(stopped()) : runHelper(root, rel, maxBytes, barrier, timeoutMs, active)));
    queue = job.catch(() => {});
    return job.finally(() => pending--);
  };
  return {
    /** Read `rel` inside `root` through the guarded helper. Resolves to a Buffer. */
    read: (root, rel, maxBytes) => readEntry(root, rel, maxBytes).then((e) => e.bytes),
    /** The same, with the file's identity: {bytes, dev, ino, mode} (dev and ino as decimal strings). */
    readEntry,
    /**
     * Copy `rel` inside `root` into the open file descriptor `outFd` through the guarded helper (a
     * transfer's capture, design 6: the file is read once). Resolves to {bytes (a count), sha256
     * (hex), dev, ino, mode}. The deadline grows with maxBytes.
     */
    copyEntry: (root, rel, maxBytes, outFd) => {
      checkRelPath(rel);
      if (closed) return Promise.reject(stopped());
      if (pending >= MAX_PENDING) return Promise.reject(new FileToolError("helper_failed", "too many file reads waiting"));
      pending++;
      const deadline = Math.max(timeoutMs, timeoutMs + Math.ceil(maxBytes / COPY_BYTES_PER_SECOND) * 1000);
      const job = queue.then(() => (closed ? Promise.reject(stopped()) : runHelper(root, rel, maxBytes, barrier, deadline, active, outFd)));
      queue = job.catch(() => {});
      return job.finally(() => pending--);
    },
    /** Refuse new and queued reads and end a running helper. Idempotent. */
    close() {
      closed = true;
      for (const child of active) child.kill("SIGKILL");
    },
  };
}

function runHelper(root, rel, maxBytes, barrier, timeoutMs, active, outFd = null) {
  return new Promise((resolve, reject) => {
    // A minimal environment: no NODE_OPTIONS, preloads, tokens or provider credentials.
    const env = { PATH: "/usr/bin:/bin" };
    if (barrier) env.HOPTELL_READER_TEST_BARRIER = barrier;
    let child;
    try {
      child = spawn(process.execPath, [HELPER], { cwd: root.canonical, env, shell: false, stdio: ["pipe", "pipe", "pipe", root.fd, ...(outFd === null ? [] : [outFd])] });
    } catch {
      return reject(new FileToolError("helper_failed"));
    }
    active.add(child);
    child.once("close", () => active.delete(child));
    let out = "";
    let errLen = 0;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new FileToolError("helper_failed", "the file read timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > STDOUT_CAP) {
        child.kill("SIGKILL");
        finish(reject, new FileToolError("helper_failed"));
      }
    });
    child.stderr.on("data", (d) => (errLen += d.length) > STDERR_CAP && child.kill("SIGKILL")); // never forwarded
    child.on("error", () => finish(reject, new FileToolError("helper_failed")));
    child.on("close", () => {
      let r;
      try {
        r = JSON.parse(out);
      } catch {
        return finish(reject, new FileToolError("helper_failed"));
      }
      if (r.ok === true && typeof r.data === "string" && outFd === null && /^\d{1,20}$/.test(r.dev) && /^\d{1,20}$/.test(r.ino) && Number.isInteger(r.mode)) {
        return finish(resolve, { bytes: Buffer.from(r.data, "base64"), dev: r.dev, ino: r.ino, mode: r.mode });
      }
      if (r.ok === true && outFd !== null && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= maxBytes && /^[0-9a-f]{64}$/.test(r.sha256) && /^\d{1,20}$/.test(r.dev) && /^\d{1,20}$/.test(r.ino) && Number.isInteger(r.mode)) {
        return finish(resolve, { bytes: r.bytes, sha256: r.sha256, dev: r.dev, ino: r.ino, mode: r.mode });
      }
      return finish(reject, new FileToolError(typeof r.code === "string" && /^[a-z_]{1,32}$/.test(r.code) ? r.code : "helper_failed"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ path: rel, maxBytes, rootDev: String(root.dev), rootIno: String(root.ino), ...(outFd === null ? {} : { copy: true }) }));
  });
}
