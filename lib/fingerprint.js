// Opt-in keyed fingerprints of message text in relay logs (HOPTELL_LOG_FINGERPRINTS=on).
// HMAC-SHA-256 with a private key from a local file; the relay-assigned message reference is
// the nonce, so equal texts sent separately get different tags. Errors are fixed codes: they
// never contain the key, the file's contents or its path.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FORMAT = "hmac-sha256-text-v1";
const DOMAIN = Buffer.from("hoptell/relay-text-fingerprint/v1\0", "ascii");
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
const MAX_FILE = 512;

export class FingerprintError extends Error {
  constructor(code) {
    super(`fingerprint key file could not be used (${code})`);
    this.code = code;
  }
}
const fail = (code) => {
  throw new FingerprintError(code);
};

/** Parse HOPTELL_LOG_FINGERPRINTS: "on" -> true; "off" or unset/empty -> false; else throws. */
export function fingerprintsEnabled(value) {
  const v = String(value ?? "").trim();
  if (v === "" || v === "off") return false;
  if (v === "on") return true;
  throw new Error("HOPTELL_LOG_FINGERPRINTS must be on or off");
}

/** Load {id, key} from a private key file: {"v":1,"id":"...","key_hex":"<64 hex>"}. */
export function loadFingerprintKey(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("invalid_path");
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (!(process.platform === "darwin" || process.platform === "linux") || !O_NOFOLLOW) fail("unsupported_platform");
  let entry;
  try {
    entry = fs.lstatSync(file, { bigint: true });
  } catch (e) {
    fail(e.code === "ENOENT" ? "missing_key_file" : "unreadable");
  }
  if (!entry.isFile()) fail("unsafe_file");
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | (O_NONBLOCK ?? 0));
  } catch (e) {
    fail(e.code === "ELOOP" ? "unsafe_file" : "unreadable");
  }
  let raw;
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (st.dev !== entry.dev || st.ino !== entry.ino) fail("changed_during_read");
    const uid = BigInt(process.geteuid());
    const mode = Number(st.mode & 0o7777n);
    if (!st.isFile() || st.nlink !== 1n || (st.uid !== uid && st.uid !== 0n) || (mode !== 0o400 && mode !== 0o600)) fail("unsafe_file");
    const buf = Buffer.alloc(MAX_FILE + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n > MAX_FILE) fail("too_large");
    const after = fs.fstatSync(fd, { bigint: true });
    const still = fs.lstatSync(file, { bigint: true });
    if (after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs || still.ino !== st.ino || still.dev !== st.dev || BigInt(n) !== st.size) fail("changed_during_read");
    raw = buf.subarray(0, n);
  } catch (e) {
    if (e instanceof FingerprintError) throw e;
    fail("unreadable");
  } finally {
    fs.closeSync(fd);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail("invalid_utf8");
  } finally {
    raw.fill(0);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail("invalid_json");
  }
  if (!json || typeof json !== "object" || Array.isArray(json) || Object.keys(json).sort().join(",") !== "id,key_hex,v") fail("invalid_fields");
  if (json.v !== 1 || typeof json.id !== "string" || !ID_RE.test(json.id)) fail("invalid_fields");
  if (typeof json.key_hex !== "string" || !KEY_RE.test(json.key_hex)) fail("invalid_key");
  const bytes = Buffer.from(json.key_hex, "hex");
  let key;
  try {
    key = crypto.createSecretKey(bytes);
  } catch {
    fail("crypto_unavailable");
  } finally {
    bytes.fill(0);
  }
  return { id: json.id, key };
}

/**
 * Check a fingerprint setting passed to startRelay: a real 32-byte secret KeyObject that can
 * compute an HMAC. Returns a frozen copy, so later changes to the caller's object do nothing.
 */
export function checkFingerprint(fp) {
  if (fp == null) return null;
  const bad = () => new Error("fingerprint must be {id, key} with a 32-byte secret crypto.KeyObject");
  if (typeof fp !== "object" || typeof fp.id !== "string" || !ID_RE.test(fp.id)) throw bad();
  const { id, key } = fp;
  if (!(key instanceof crypto.KeyObject) || key.type !== "secret" || key.symmetricKeySize !== 32) throw bad();
  try {
    crypto.createHmac("sha256", key).update(DOMAIN).digest();
  } catch {
    throw bad();
  }
  return Object.freeze({ id, key });
}

/** The log suffix for `text` accepted under message reference `ref`. */
export function fingerprintSuffix({ id, key }, ref, text) {
  const idBytes = Buffer.from(id, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(text.length);
  const mac = crypto
    .createHmac("sha256", key)
    .update(DOMAIN)
    .update(Buffer.from([idBytes.length]))
    .update(idBytes)
    .update(Buffer.from(ref.replace(/-/g, ""), "hex"))
    .update(length)
    .update(Buffer.from(text, "utf16le"))
    .digest("hex");
  return `fp=${FORMAT}:${id}:${mac}`;
}
