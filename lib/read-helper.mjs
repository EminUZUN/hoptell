// Guarded file reader for the hoptell file tools. Started by lib/files.js as a separate
// process with its working directory set to an approved folder and that folder's open
// descriptor as fd 3. It walks the requested relative path one name at a time and refuses
// anything that is not what it checked: symlinks, other devices, hard links, special files,
// or a file or folder replaced while it was being opened or read.
//
// Input (stdin, JSON): {path, maxBytes, rootDev, rootIno, copy?}
// Output (stdout, JSON): {ok: true, data: <base64>, dev, ino, mode} or {ok: false, code: <reason code>}
// With copy: true (a transfer's capture, design 6), the bytes are written to fd 4 (a private file
// the parent opened) instead of stdout, and the output is {ok: true, bytes, sha256, dev, ino, mode}.
import crypto from "node:crypto";
import fs from "node:fs";

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

class Refusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const refuse = (code) => {
  throw new Refusal(code);
};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Race tests only: with HOPTELL_READER_TEST_BARRIER set, announce each step and wait until the
// test allows it, so the test can swap files and folders at exactly that moment. Only lib/files.js
// sets it, in the minimal environment it gives this process, and only from a barrier that
// lib/settings.js reads in a source checkout (config.js testBarrier).
// The test writes the one step to pause at into <barrier>.step; every other step runs through.
const BARRIER = process.env.HOPTELL_READER_TEST_BARRIER;
const PAUSE_AT = BARRIER ? fs.readFileSync(`${BARRIER}.step`, "utf8").trim() : null;
function barrier(step) {
  if (!BARRIER || step !== PAUSE_AT) return;
  fs.writeFileSync(`${BARRIER}.at`, step);
  const until = Date.now() + 5000;
  while (!fs.existsSync(`${BARRIER}.go-${step}`)) {
    if (Date.now() > until) refuse("helper_failed");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function errnoCode(e) {
  if (e instanceof Refusal) return e.code;
  if (e.code === "ENOENT" || e.code === "ENOTDIR") return "file_missing";
  if (e.code === "EACCES" || e.code === "EPERM") return "file_unreadable";
  if (e.code === "ELOOP" || e.code === "EMLINK") return "path_unsafe";
  return "file_unreadable";
}

function readJob() {
  const chunks = [];
  let size = 0;
  const buf = Buffer.alloc(8192);
  let n;
  while ((n = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
    size += n;
    if (size > 8192) refuse("helper_failed");
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

let job = null;
function run() {
  job = readJob();
  const parts = String(job.path).split("/");
  const maxBytes = Number(job.maxBytes);
  const rootDev = BigInt(job.rootDev);
  const rootIno = BigInt(job.rootIno);

  // The folder object we were given must be the one we stand in, and the one approved.
  barrier("start");
  const held = fs.fstatSync(3, { bigint: true });
  const here = fs.statSync(".", { bigint: true });
  if (!same(held, here) || held.dev !== rootDev || held.ino !== rootIno) refuse("root_changed");

  const open = []; // descriptors kept open until the read is done
  for (const name of parts.slice(0, -1)) {
    const entry = fs.lstatSync(name, { bigint: true });
    if (!entry.isDirectory()) refuse(entry.isSymbolicLink() ? "path_unsafe" : "file_missing");
    if (entry.dev !== rootDev) refuse("path_unsafe");
    const fd = fs.openSync(name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    open.push(fd);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!same(opened, entry)) refuse("changed_during_read");
    barrier(`opened-${name}`);
    process.chdir(name);
    if (!same(fs.statSync(".", { bigint: true }), opened)) refuse("changed_during_read");
    barrier(`entered-${name}`);
  }

  const name = parts.at(-1);
  const entry = fs.lstatSync(name, { bigint: true });
  if (entry.isSymbolicLink()) refuse("path_unsafe");
  if (!entry.isFile()) refuse("path_unsafe"); // directory, FIFO, device or socket
  if (entry.nlink !== 1n || entry.dev !== rootDev) refuse("path_unsafe");
  barrier("file-checked");
  const fd = fs.openSync(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  open.push(fd);
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || !same(before, entry)) refuse("changed_during_read");
  if (before.size > BigInt(maxBytes)) refuse("too_large");

  // Read one byte past the limit, so growth is refused instead of cut off. A copy streams in
  // blocks to fd 4, hashing as it goes; otherwise the bytes are kept for stdout.
  let data = null;
  let got = 0;
  let r;
  const hash = job.copy ? crypto.createHash("sha256") : null;
  if (job.copy) {
    const block = Buffer.alloc(1024 * 1024);
    while ((r = fs.readSync(fd, block, 0, Math.min(block.length, maxBytes + 1 - got), null)) > 0) {
      got += r;
      if (got > maxBytes) refuse("too_large");
      hash.update(block.subarray(0, r));
      for (let off = 0; off < r; ) off += fs.writeSync(4, block, off, r - off);
      if (got === maxBytes + 1) break;
    }
  } else {
    data = Buffer.alloc(maxBytes + 1);
    while (got < data.length && (r = fs.readSync(fd, data, got, data.length - got, null)) > 0) got += r;
    if (got > maxBytes) refuse("too_large");
  }
  barrier("file-read");

  const after = fs.fstatSync(fd, { bigint: true });
  const still = fs.lstatSync(name, { bigint: true });
  if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) refuse("changed_during_read");
  if (BigInt(got) !== after.size || !same(still, after)) refuse("changed_during_read");
  for (const d of open) fs.closeSync(d);
  return { data: data?.subarray(0, got) ?? null, got, sha256: hash?.digest("hex") ?? null, st: after };
}

let out;
try {
  const { data, got, sha256, st } = run();
  // The file's identity as it was read (review sets record it, to refuse aliases and later swaps).
  const id = { dev: String(st.dev), ino: String(st.ino), mode: Number(st.mode & 0o7777n) };
  out = data === null ? { ok: true, bytes: got, sha256, ...id } : { ok: true, data: data.toString("base64"), ...id };
} catch (e) {
  out = { ok: false, code: errnoCode(e) };
}
process.stdout.write(JSON.stringify(out));
