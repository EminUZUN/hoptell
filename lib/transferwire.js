// Wire format v1 of a larger transfer (design 6, "Wire format v1"). EXPERIMENTAL. A file travels
// as an encrypted blob stored at the relay; its key travels inside an encrypted message (the
// descriptor below), so the relay stores ciphertext chunks it cannot read.
//
//   key      32 random bytes, for one transfer only
//   chunks   chunk_size = 262,144 bytes of plaintext; chunk_count = max(1, ceil(total / size)),
//            so an empty file is one chunk of 0 bytes; the last chunk holds the rest
//   cipher   AES-256-GCM, nonce 00000000 || u64(index), the 16-byte tag appended; a key encrypts
//            each index exactly once (the sender's outbox, lib/transferout.js), so (key, nonce)
//            never repeats
//   header   "hoptell-transfer-v1\0" (20) || transfer_id (16) || u64 total_bytes ||
//            u32 chunk_size || u32 chunk_count || plaintext_sha256 (32): 84 bytes exactly
//   AAD      header_digest (32) || u32 index || u32 plaintext_length || u8 final
//   root     SHA-256("hoptell-transfer-root-v1\0" || u32 count ||
//            for each i: u32 i || u32 ciphertext_length || SHA-256(ciphertext_i))
//
// All integers are unsigned big-endian. Every size is checked before anything is allocated, and
// a decoder refuses any other length, magic, version, chunk size or count. Errors carry the check
// that failed (layout, size_limit, index_range, length, aead, completeness, root, binding).
// The shared vectors in test/vectors/transfer-v1.json pin this format.
import crypto from "node:crypto";
import { DEVICE_ID_RE } from "./mls/identity.js";

export const WIRE_VERSION = 1;
export const CHUNK_SIZE = 262_144;
export const TAG_BYTES = 16;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_CHUNKS = MAX_TOTAL_BYTES / CHUNK_SIZE; // 800
export const HEADER_BYTES = 84;
export const MAX_LABEL_BYTES = 255;
const MAGIC = Buffer.from("hoptell-transfer-v1\0", "latin1");
const ROOT_DOMAIN = Buffer.from("hoptell-transfer-root-v1\0", "latin1");
const DESCRIPTOR_KEYS = ["header", "key", "media_type", "name", "relay_expires", "root", "transfer_id", "uploader_device", "v"];
const MAX_TIME = 8_640_000_000_000_000;

/** A refusal of the format, with the check that failed as its code. */
export class TransferFormatError extends Error {
  constructor(code, message) {
    super(`transfer: ${message}`);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new TransferFormatError(code, message);
};

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const bytesOf = (b) => (b instanceof Uint8Array ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : null);

/** Whether `n` is a size this format accepts: a safe integer from 0 to MAX_TOTAL_BYTES. */
export const validTotal = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_TOTAL_BYTES;

/** The chunk count for `total` bytes (checked first). */
export function chunkCount(total) {
  if (!validTotal(total)) fail("size_limit", `total_bytes must be a whole number from 0 to ${MAX_TOTAL_BYTES}`);
  return Math.max(1, Math.ceil(total / CHUNK_SIZE));
}

/** The plaintext length of chunk `index` of a transfer of `total` bytes. */
export function plainLength(total, index) {
  const count = chunkCount(total);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) fail("index_range", `index must be from 0 to ${count - 1}`);
  return index < count - 1 ? CHUNK_SIZE : total - (count - 1) * CHUNK_SIZE;
}

/** The ciphertext length of chunk `index` (plaintext length + the tag). */
export const cipherLength = (total, index) => plainLength(total, index) + TAG_BYTES;

/** The exact header bytes for a transfer: {transferId (16 bytes), totalBytes, plaintextSha256 (32 bytes)}. */
export function encodeHeader({ transferId, totalBytes, plaintextSha256 }) {
  const id = bytesOf(transferId);
  const digest = bytesOf(plaintextSha256);
  if (!id || id.length !== 16) fail("layout", "transfer_id must be 16 bytes");
  if (!digest || digest.length !== 32) fail("layout", "plaintext_sha256 must be 32 bytes");
  const count = chunkCount(totalBytes);
  return Buffer.concat([MAGIC, id, u64(totalBytes), u32(CHUNK_SIZE), u32(count), digest]);
}

/**
 * Decode and check header bytes: {bytes, transferId, totalBytes, chunkSize, chunkCount,
 * plaintextSha256, digest (header_digest)}. Refuses any other length, magic, chunk size, a count
 * that does not follow from the size, or a size over the limit.
 */
export function decodeHeader(header) {
  const b = bytesOf(header);
  if (!b || b.length !== HEADER_BYTES) fail("layout", `a header has exactly ${HEADER_BYTES} bytes`);
  if (!b.subarray(0, 20).equals(MAGIC)) fail("layout", "not a hoptell-transfer-v1 header");
  const total = b.readBigUInt64BE(36);
  if (total > BigInt(MAX_TOTAL_BYTES)) fail("size_limit", `total_bytes is over the limit of ${MAX_TOTAL_BYTES}`);
  const totalBytes = Number(total);
  const chunkSize = b.readUInt32BE(44);
  const count = b.readUInt32BE(48);
  if (chunkSize !== CHUNK_SIZE) fail("layout", `chunk_size must be ${CHUNK_SIZE}`);
  if (count !== chunkCount(totalBytes)) fail("layout", "chunk_count does not follow from total_bytes");
  const bytes = Buffer.from(b);
  return { bytes, transferId: bytes.subarray(20, 36), totalBytes, chunkSize, chunkCount: count, plaintextSha256: bytes.subarray(52, 84), digest: sha256(bytes) };
}

/** The nonce of chunk `index`: 4 zero bytes and u64(index). */
export const nonceOf = (index) => Buffer.concat([Buffer.alloc(4), u64(index)]);

/** The AAD of chunk `index` of decoded header `h`: header_digest || u32 index || u32 length || u8 final. */
export function aadOf(h, index) {
  const len = plainLength(h.totalBytes, index);
  return Buffer.concat([h.digest, u32(index), u32(len), Buffer.from([index === h.chunkCount - 1 ? 1 : 0])]);
}

const checkKey = (key) => {
  const k = bytesOf(key);
  if (!k || k.length !== 32) fail("layout", "the key must be 32 bytes");
  return k;
};

/** Encrypt chunk `index` (its plaintext must have exactly the length the header derives). */
export function encryptChunk({ key, header, index, plaintext }) {
  const k = checkKey(key);
  const p = bytesOf(plaintext);
  if (!p || p.length !== plainLength(header.totalBytes, index)) fail("length", `chunk ${index} must have ${plainLength(header.totalBytes, index)} bytes of plaintext`);
  const c = crypto.createCipheriv("aes-256-gcm", k, nonceOf(index));
  c.setAAD(aadOf(header, index));
  return Buffer.concat([c.update(p), c.final(), c.getAuthTag()]);
}

/**
 * Decrypt chunk `index`: its length must be the expected ciphertext length, and it must
 * authenticate under the key with its AAD (index, length and final flag derived from the header).
 */
export function decryptChunk({ key, header, index, ciphertext }) {
  const k = checkKey(key);
  const c = bytesOf(ciphertext);
  if (!Number.isSafeInteger(index) || index < 0 || index >= header.chunkCount) fail("index_range", `index must be from 0 to ${header.chunkCount - 1}`);
  const want = cipherLength(header.totalBytes, index);
  if (!c || c.length !== want) fail("length", `chunk ${index} must have ${want} bytes of ciphertext`);
  const d = crypto.createDecipheriv("aes-256-gcm", k, nonceOf(index));
  d.setAAD(aadOf(header, index));
  d.setAuthTag(c.subarray(c.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(c.subarray(0, c.length - TAG_BYTES)), d.final()]);
  } catch {
    return fail("aead", `chunk ${index} does not authenticate`);
  }
}

/**
 * The root over `chunks` ([{index, length, sha256}] or ciphertexts as Buffers, in index order 0 to
 * count - 1, no gaps or repeats): 32 bytes. With `count` (the header's), every chunk must be there.
 */
export function rootOf(chunks, count = null) {
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_CHUNKS) fail("completeness", `a root covers 1 to ${MAX_CHUNKS} chunks`);
  const parts = [ROOT_DOMAIN, u32(chunks.length)];
  chunks.forEach((c, i) => {
    const e = c instanceof Uint8Array ? { index: i, length: c.length, sha256: sha256(c) } : c;
    if (Number.isSafeInteger(e.index) && e.index < i) fail("index", `chunk ${e.index} is repeated`);
    if (e.index !== i) fail("completeness", `chunk ${i} is missing`);
    const d = bytesOf(e.sha256);
    if (!Number.isSafeInteger(e.length) || e.length < TAG_BYTES || e.length > CHUNK_SIZE + TAG_BYTES || !d || d.length !== 32) fail("layout", `chunk ${i} has a bad length or digest`);
    parts.push(u32(i), u32(e.length), d);
  });
  if (count !== null && chunks.length !== count) fail("completeness", `${count - chunks.length} chunk(s) missing`);
  return sha256(Buffer.concat(parts));
}

/**
 * Check a descriptor (the `transfer` map of a kind "file" body) as decoded from authenticated
 * content: exactly its keys and types. Returns it with `h` (the decoded header). `binding`, when
 * given, is {uploaderDevice, transferId (hex), fromDevice, root?}: the outer reference, the
 * authenticated sender's device and, on download, the relay's committed root; all must agree.
 */
export function checkDescriptor(t, binding = null) {
  if (!t || typeof t !== "object" || Array.isArray(t) || t instanceof Uint8Array) fail("layout", "a descriptor is a map");
  for (const k of Object.keys(t)) if (!DESCRIPTOR_KEYS.includes(k)) fail("layout", `a descriptor has an unknown key ${JSON.stringify(k)}`);
  for (const k of DESCRIPTOR_KEYS) if (!(k in t)) fail("layout", `a descriptor lacks ${k}`);
  if (t.v !== WIRE_VERSION) fail("layout", `unknown descriptor version ${t.v}`);
  if (typeof t.uploader_device !== "string" || !DEVICE_ID_RE.test(t.uploader_device)) fail("layout", "uploader_device must be a device id");
  for (const [k, n] of [["transfer_id", 16], ["header", HEADER_BYTES], ["key", 32], ["root", 32]]) {
    if (!(t[k] instanceof Uint8Array) || t[k].length !== n) fail("layout", `${k} must be ${n} bytes`);
  }
  if (!Number.isSafeInteger(t.relay_expires) || t.relay_expires < 0 || t.relay_expires > MAX_TIME) fail("layout", "relay_expires must be a time");
  for (const k of ["name", "media_type"]) {
    if (typeof t[k] !== "string" || Buffer.byteLength(t[k], "utf8") > MAX_LABEL_BYTES) fail("layout", `${k} must be text of at most ${MAX_LABEL_BYTES} bytes`);
  }
  const h = decodeHeader(t.header);
  if (!h.transferId.equals(Buffer.from(t.transfer_id))) fail("binding", "the descriptor's transfer_id differs from its header's");
  if (binding) {
    if (binding.transferId !== undefined && binding.transferId !== Buffer.from(t.transfer_id).toString("hex")) fail("binding", "the descriptor's transfer_id differs from the outer reference");
    if (binding.uploaderDevice !== undefined && binding.uploaderDevice !== t.uploader_device) fail("binding", "the descriptor's uploader_device differs from the outer reference");
    if (binding.fromDevice !== undefined && binding.fromDevice !== t.uploader_device) fail("binding", "the descriptor's uploader_device is not the authenticated sender's device");
    if (binding.root !== undefined && !Buffer.from(binding.root).equals(Buffer.from(t.root))) fail("root", "the relay's committed root differs from the descriptor's");
  }
  return { ...t, h };
}

/** A new transfer id (16 random bytes) and key (32 random bytes). */
export const newTransferId = () => crypto.randomBytes(16);
export const newTransferKey = () => crypto.randomBytes(32);
export const TRANSFER_ID_RE = /^[0-9a-f]{32}$/;
export const ROOT_RE = /^[0-9a-f]{64}$/;
