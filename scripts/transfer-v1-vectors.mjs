// Generates the shared vectors of transfer wire format v1 (design 6, "Vectors"): with --json it
// prints test/vectors/transfer-v1.json; without, a readable summary. Independent of lib/ on purpose.
import crypto from "node:crypto";
const CS = 262144;
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const key = Buffer.from([...Array(32).keys()]);
const tid = Buffer.from([...Array(16).keys()].map((i) => 0xa0 + i));
const out = { v: 1, chunk_size: CS, key: key.toString("hex"), transfer_id: tid.toString("hex"), pattern: "byte i = i mod 251", vectors: [] };
const json = process.argv.includes("--json");
function vec(name, pt) {
  const count = Math.max(1, Math.ceil(pt.length / CS));
  const header = Buffer.concat([Buffer.from("hoptell-transfer-v1\0"), tid, u64(pt.length), u32(CS), u32(count), sha(pt)]);
  const hd = sha(header);
  const cts = [];
  for (let i = 0; i < count; i++) {
    const p = pt.subarray(i * CS, Math.min(pt.length, (i + 1) * CS));
    const nonce = Buffer.concat([Buffer.alloc(4), u64(i)]);
    const aad = Buffer.concat([hd, u32(i), u32(p.length), Buffer.from([i === count - 1 ? 1 : 0])]);
    const c = crypto.createCipheriv("aes-256-gcm", key, nonce); c.setAAD(aad);
    cts.push(Buffer.concat([c.update(p), c.final(), c.getAuthTag()]));
  }
  const root = sha(Buffer.concat([Buffer.from("hoptell-transfer-root-v1\0"), u32(count), ...cts.flatMap((c, i) => [u32(i), u32(c.length), sha(c)])]));
  out.vectors.push({ name, total_bytes: pt.length, chunk_count: count, plaintext: pt.length <= 3 ? pt.toString("hex") : null, plaintext_sha256: sha(pt).toString("hex"), header: header.toString("hex"), header_length: header.length, header_digest: hd.toString("hex"), chunks: cts.map((c, i) => ({ index: i, ciphertext_length: c.length, ciphertext: c.length <= 48 ? c.toString("hex") : null, ciphertext_sha256: sha(c).toString("hex"), final: i === count - 1 })), root: root.toString("hex") });
  if (json) return;
  console.log(`### ${name}: ${pt.length} bytes, ${count} chunk(s), header ${header.length} bytes`);
  console.log(`plaintext_sha256 ${sha(pt).toString("hex")}`);
  console.log(`header_digest    ${hd.toString("hex")}`);
  cts.forEach((c, i) => console.log(`chunk ${i}: ${c.length} bytes, ${c.length <= 48 ? "ciphertext||tag " + c.toString("hex") : "sha256 " + sha(c).toString("hex")}`));
  console.log(`root             ${root.toString("hex")}\n`);
}
const pat = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));
vec("V1 empty", Buffer.alloc(0));
vec("V2 abc", Buffer.from("abc"));
vec("V3 exactly one chunk", pat(CS));
vec("V4 one chunk + 1 byte", pat(CS + 1));
vec("V5 exactly two chunks", pat(2 * CS));
if (json) console.log(JSON.stringify(out, null, 1));
