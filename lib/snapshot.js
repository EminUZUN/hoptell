// `hoptell snapshot`: capture a text file once and print it with the SHA-256 of its exact
// bytes, so a reviewer elsewhere can say which version it saw, and the sender can later check
// whether the file still matches before applying a suggestion. Runs locally; reads only the
// file it is given, with the permissions of whoever runs it.
import crypto from "node:crypto";
import fs from "node:fs";
import { MAX_TEXT } from "./relay.js";

export const MAX_SNAPSHOT_BYTES = 60_000;

/** A snapshot that cannot be built; `code` is a fixed reason. */
export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Read a regular file once, from one descriptor; returns its bytes and their SHA-256. */
export function capture(file) {
  // O_NONBLOCK: opening a FIFO must not hang; the fstat below rejects it anyway.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    const tooBig = () => new Error(`${file} is larger than ${MAX_SNAPSHOT_BYTES} bytes; send a smaller excerpt or a diff instead`);
    if (st.size > MAX_SNAPSHOT_BYTES) throw tooBig();
    // Read up to one byte past the limit, so a file that grows while being read is refused, not cut.
    const buf = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n > MAX_SNAPSHOT_BYTES) throw tooBig();
    const bytes = buf.subarray(0, n);
    return { bytes, sha256: sha256Of(bytes) };
  } finally {
    fs.closeSync(fd);
  }
}

export const sha256Of = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

/** The message text for a snapshot of a file (CLI). */
export function snapshotMessage(file) {
  return snapshotFromBytes(capture(file).bytes, file).text;
}

/**
 * Build a snapshot message from captured bytes: a short instruction and a JSON envelope whose
 * content decodes to exactly those bytes. `label` names the file for the reader; `extra` adds
 * fields such as the review request. Returns {text, review_request_id, sha256, bytes}.
 */
export function snapshotFromBytes(bytes, label, extra = {}) {
  const sha256 = sha256Of(bytes);
  const file = label;
  let content;
  try {
    // fatal: refuse invalid UTF-8 instead of replacing it, so the content matches the hash.
    // ignoreBOM: keep a byte order mark in the content, so it re-encodes to the same bytes.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SnapshotError("not_utf8", `${file} is not valid UTF-8 text; only text files can be sent as snapshots`);
  }
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new SnapshotError("not_utf8", `${file} does not round-trip as UTF-8 text`);
  const review_request_id = crypto.randomUUID();
  const envelope = { hoptell_snapshot: 1, review_request_id, file, bytes: bytes.length, sha256, ...extra, content };
  const text =
    "hoptell file snapshot. Review the content below. When you reply, quote review_request_id, " +
    "and give the sha256 as based_on.\n" +
    JSON.stringify(envelope, null, 2);
  if (text.length > MAX_TEXT) throw new SnapshotError("too_large", `the encoded snapshot of ${file} exceeds the message limit of ${MAX_TEXT} characters; send a smaller excerpt or a diff instead`);
  return { text, review_request_id, sha256, bytes: bytes.length };
}

/** Compare a file with a recorded digest; returns {matches, current}. */
export function checkSnapshot(digest, file) {
  const expected = String(digest).trim().toLowerCase();
  if (!DIGEST_RE.test(expected)) throw new Error(`invalid digest "${String(digest).slice(0, 80)}": expected sha256: followed by 64 hex digits`);
  const { sha256 } = capture(file);
  return { matches: sha256 === expected, current: sha256, expected };
}
