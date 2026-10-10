// Wire format v1 of a larger transfer (design 6, "Wire format v1", "Vectors"): V1-V5 against the
// encoder and the decoder, and each negative vector failing at its stated check.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHUNK_SIZE, HEADER_BYTES, MAX_TOTAL_BYTES, TransferFormatError, checkDescriptor, chunkCount, cipherLength, decodeHeader, decryptChunk, encodeHeader, encryptChunk, plainLength, rootOf } from "../lib/transferwire.js";

const V = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors", "transfer-v1.json"), "utf8"));
const key = Buffer.from(V.key, "hex");
const tid = Buffer.from(V.transfer_id, "hex");
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));
const plaintextOf = (v) => (v.plaintext !== null ? Buffer.from(v.plaintext, "hex") : pattern(v.total_bytes));
const vec = (name) => V.vectors.find((v) => v.name.startsWith(name));
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TransferFormatError, `not a format error: ${e.message}`);
    return e.code;
  }
  assert.fail("expected a refusal");
};

/** Encrypt a vector's plaintext with the encoder: {header, h, chunks}. */
function encrypt(v) {
  const pt = plaintextOf(v);
  const header = encodeHeader({ transferId: tid, totalBytes: pt.length, plaintextSha256: sha(pt) });
  const h = decodeHeader(header);
  const chunks = [];
  for (let i = 0; i < h.chunkCount; i++) chunks.push(encryptChunk({ key, header: h, index: i, plaintext: pt.subarray(i * CHUNK_SIZE, i * CHUNK_SIZE + plainLength(pt.length, i)) }));
  return { pt, header, h, chunks };
}

test("vectors V1-V5: the encoder produces the exact header, digest, chunks and root", () => {
  assert.equal(V.chunk_size, CHUNK_SIZE);
  assert.equal(V.vectors.length, 5);
  for (const v of V.vectors) {
    const { header, h, chunks } = encrypt(v);
    assert.equal(header.length, HEADER_BYTES, v.name);
    assert.equal(header.toString("hex"), v.header, v.name);
    assert.equal(v.header_length, 84);
    assert.equal(h.digest.toString("hex"), v.header_digest, v.name);
    assert.equal(h.chunkCount, v.chunk_count, v.name);
    assert.equal(chunks.length, v.chunks.length);
    v.chunks.forEach((c, i) => {
      assert.equal(chunks[i].length, c.ciphertext_length, `${v.name} chunk ${i}`);
      assert.equal(cipherLength(v.total_bytes, i), c.ciphertext_length);
      assert.equal(sha(chunks[i]).toString("hex"), c.ciphertext_sha256, `${v.name} chunk ${i}`);
      if (c.ciphertext !== null) assert.equal(chunks[i].toString("hex"), c.ciphertext);
      assert.equal(c.final, i === v.chunk_count - 1);
    });
    assert.equal(rootOf(chunks, h.chunkCount).toString("hex"), v.root, v.name);
    assert.equal(rootOf(chunks.map((c, i) => ({ index: i, length: c.length, sha256: sha(c) }))).toString("hex"), v.root);
  }
});

test("vectors V1-V5: the decoder accepts each header and decrypts each chunk back to the plaintext", () => {
  // The design's own numbers, as written in design 6 (not only the generated file).
  assert.equal(vec("V1").header_digest, "89313339e7258d5db9b1d74f0787d4d02026db01f71762f3fca0649e3f153a74");
  assert.equal(vec("V2").chunks[0].ciphertext, "6fded69db59a4214e015f5ad791a2171b00435");
  assert.equal(vec("V5").root, "7c41897a5e4a0fa10855616cdd1060f8574887607b925361d986cc1b9900c2ed");
  for (const v of V.vectors) {
    const h = decodeHeader(Buffer.from(v.header, "hex"));
    assert.equal(h.totalBytes, v.total_bytes);
    assert.equal(h.transferId.toString("hex"), V.transfer_id);
    assert.equal(h.plaintextSha256.toString("hex"), v.plaintext_sha256);
    const { chunks, pt } = encrypt(v);
    const back = Buffer.concat(chunks.map((c, i) => decryptChunk({ key, header: h, index: i, ciphertext: c })));
    assert.ok(back.equals(pt), v.name);
    assert.equal(sha(back).toString("hex"), v.plaintext_sha256);
  }
  assert.equal(chunkCount(0), 1);
  assert.equal(plainLength(0, 0), 0);
  assert.equal(chunkCount(MAX_TOTAL_BYTES), 800);
  assert.equal(plainLength(2 * CHUNK_SIZE, 1), CHUNK_SIZE, "an exact multiple keeps a full last chunk");
});

test("negative vectors fail at their stated check", () => {
  const v4 = encrypt(vec("V4"));
  const v5 = encrypt(vec("V5"));
  // A wrong final flag: chunk 0 of V4 encrypted as if it were the last one.
  const lying = { ...v4.h, chunkCount: 1 };
  const c = crypto.createCipheriv("aes-256-gcm", key, Buffer.concat([Buffer.alloc(4), Buffer.alloc(8)]));
  c.setAAD(Buffer.concat([lying.digest, Buffer.from([0, 0, 0, 0]), Buffer.from([0, 4, 0, 0]), Buffer.from([1])]));
  const finalFlag = Buffer.concat([c.update(v4.pt.subarray(0, CHUNK_SIZE)), c.final(), c.getAuthTag()]);
  assert.equal(code(() => decryptChunk({ key, header: v4.h, index: 0, ciphertext: finalFlag })), "aead", "wrong final flag");
  assert.equal(code(() => decryptChunk({ key, header: v4.h, index: 2, ciphertext: v4.chunks[1] })), "index_range", "the last index declared as count");
  assert.equal(code(() => decryptChunk({ key, header: v5.h, index: 0, ciphertext: v5.chunks[1] })), "aead", "chunk 1 of V5 sent as index 0");
  assert.equal(code(() => rootOf([v4.chunks[0]], v4.h.chunkCount)), "completeness", "a missing chunk 1");
  const d0 = { index: 0, length: v5.chunks[0].length, sha256: sha(v5.chunks[0]) };
  assert.equal(code(() => rootOf([d0, d0])), "index", "a repeated chunk 0");
  // V4's chunk 0 has V5's length (a full chunk), so it reaches the AEAD check under V5's header.
  assert.equal(code(() => decryptChunk({ key, header: v5.h, index: 0, ciphertext: v4.chunks[0] })), "aead", "the chunks of V4 under the V5 header");
  const desc = (over = {}) => ({ v: 1, uploader_device: "a".repeat(25) + "e", transfer_id: tid, header: v4.header, key, root: Buffer.from(vec("V4").root, "hex"), relay_expires: 1, name: "x.bin", media_type: "application/octet-stream", ...over });
  assert.equal(checkDescriptor(desc()).h.totalBytes, vec("V4").total_bytes);
  assert.equal(code(() => checkDescriptor(desc(), { root: Buffer.from(vec("V5").root, "hex") })), "root", "the descriptor of V4 with the root of V5");
  const count3 = Buffer.from(v4.header);
  count3.writeUInt32BE(3, 48);
  assert.equal(code(() => decodeHeader(count3)), "layout", "chunk_count 3 for V4's size");
  const big = Buffer.from(v4.header);
  big.writeBigUInt64BE(BigInt(MAX_TOTAL_BYTES + 1), 36);
  assert.equal(code(() => decodeHeader(big)), "size_limit", "total_bytes 200 MiB + 1");
  assert.equal(code(() => decodeHeader(v4.header.subarray(0, 83))), "layout", "83 bytes");
  assert.equal(code(() => decodeHeader(Buffer.concat([v4.header, Buffer.alloc(1)]))), "layout", "85 bytes");
  const magic = Buffer.from(v4.header);
  magic[0] ^= 1;
  assert.equal(code(() => decodeHeader(magic)), "layout", "another magic");
  const size = Buffer.from(v4.header);
  size.writeUInt32BE(CHUNK_SIZE * 2, 44);
  assert.equal(code(() => decodeHeader(size)), "layout", "another chunk size");
  const other = Buffer.from(tid);
  other[0] ^= 1;
  assert.equal(code(() => checkDescriptor(desc({ transfer_id: other }))), "binding", "a descriptor whose transfer_id differs from the header's");
  assert.equal(code(() => checkDescriptor(desc(), { transferId: other.toString("hex") })), "binding", "the outer reference's transfer_id");
  assert.equal(code(() => checkDescriptor(desc(), { fromDevice: "b".repeat(25) + "e" })), "binding", "another sender device");
  assert.equal(code(() => checkDescriptor(desc({ extra: 1 }))), "layout");
  assert.equal(code(() => checkDescriptor(desc({ name: "n".repeat(256) }))), "layout", "a label over 255 bytes");
  assert.equal(code(() => decryptChunk({ key, header: v4.h, index: 1, ciphertext: Buffer.concat([v4.chunks[1], Buffer.alloc(1)]) })), "length", "more data than declared");
  assert.equal(code(() => encryptChunk({ key, header: v4.h, index: 1, plaintext: Buffer.alloc(2) })), "length");
});
