// A narrow deterministic CBOR codec for 3.3's authenticated content (design 3.3, "Authenticated
// content"): RFC 8949 section 4.2.1 core deterministic encoding, for the few types the schema uses.
// EXPERIMENTAL. No maintained CBOR codec is among hoptell's dependencies and none is added for an
// experimental feature, so this file is deliberately small and strict; the shared vectors in
// test/vectors/e2ee-content-v1.json pin its behavior (and any library that replaces it).
//
// Encoded: unsigned integers (major type 0, up to 2^53 - 1), byte strings (2), UTF-8 text strings
// (3), arrays (4) and maps with text keys (5). Nothing else: no negative integers, floats, simple
// values, tags or indefinite lengths. Decoding refuses anything that is not exactly what encode()
// would produce: a head not in its shortest form, an indefinite length, an unsupported major type,
// invalid UTF-8, map keys that are not text or not in deterministic order (bytewise on their
// encodings, which puts shorter keys first) or repeated, nesting deeper than 8, more than the
// bounded number of items or bytes, and anything after the end of the item.
const MAX_DEPTH = 8;
const MAX_ITEMS = 4096; // per array or map
export const MAX_INPUT = 512 * 1024;

export class CborError extends Error {
  constructor(message) {
    super(`cbor: ${message}`);
    this.code = "bad_cbor";
  }
}

function head(major, n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new CborError("integers are whole numbers from 0 to 2^53 - 1");
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = m | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = m | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

/** Encode a value: a safe unsigned integer, a Uint8Array, a string, an array, or a plain object with string keys. */
export function encode(value) {
  const parts = [];
  const walk = (v, depth) => {
    if (depth > MAX_DEPTH) throw new CborError(`nesting deeper than ${MAX_DEPTH}`);
    if (typeof v === "number") return parts.push(head(0, v));
    if (v instanceof Uint8Array) return parts.push(head(2, v.length), Buffer.from(v));
    if (typeof v === "string") {
      const b = Buffer.from(v, "utf8");
      if (b.toString("utf8") !== v) throw new CborError("a text string is not valid Unicode");
      return parts.push(head(3, b.length), b);
    }
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS) throw new CborError(`more than ${MAX_ITEMS} items`);
      parts.push(head(4, v.length));
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (keys.length > MAX_ITEMS) throw new CborError(`more than ${MAX_ITEMS} items`);
      const entries = keys.map((k) => [encode(k), k]).sort((a, b) => Buffer.compare(a[0], b[0]));
      parts.push(head(5, entries.length));
      for (const [kb, k] of entries) {
        parts.push(kb);
        walk(v[k], depth + 1);
      }
      return;
    }
    throw new CborError(`cannot encode ${v === null ? "null" : typeof v}`);
  };
  walk(value, 1);
  const out = Buffer.concat(parts);
  if (out.length > MAX_INPUT) throw new CborError(`more than ${MAX_INPUT} bytes`);
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode exactly one deterministic item filling `bytes`; byte strings decode as Buffers. */
export function decode(bytes) {
  const b = Buffer.from(bytes);
  if (b.length > MAX_INPUT) throw new CborError(`more than ${MAX_INPUT} bytes`);
  let i = 0;
  const need = (n) => {
    if (i + n > b.length) throw new CborError("unexpected end of input");
  };
  const readHead = () => {
    need(1);
    const ib = b[i++];
    const major = ib >> 5;
    const info = ib & 31;
    let n;
    if (info < 24) n = info;
    else if (info === 24) {
      need(1);
      n = b[i];
      i += 1;
      if (n < 24) throw new CborError("an integer not in its shortest form");
    } else if (info === 25) {
      need(2);
      n = b.readUInt16BE(i);
      i += 2;
      if (n < 0x100) throw new CborError("an integer not in its shortest form");
    } else if (info === 26) {
      need(4);
      n = b.readUInt32BE(i);
      i += 4;
      if (n < 0x10000) throw new CborError("an integer not in its shortest form");
    } else if (info === 27) {
      need(8);
      const big = b.readBigUInt64BE(i);
      i += 8;
      if (big < 0x100000000n) throw new CborError("an integer not in its shortest form");
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("an integer above 2^53 - 1");
      n = Number(big);
    } else throw new CborError(info === 31 ? "indefinite lengths are not allowed" : "a reserved head");
    return { major, n };
  };
  const item = (depth) => {
    if (depth > MAX_DEPTH) throw new CborError(`nesting deeper than ${MAX_DEPTH}`);
    const { major, n } = readHead();
    switch (major) {
      case 0:
        return n;
      case 2:
        need(n);
        i += n;
        return Buffer.from(b.subarray(i - n, i));
      case 3: {
        need(n);
        i += n;
        try {
          return utf8.decode(b.subarray(i - n, i));
        } catch {
          throw new CborError("a text string is not valid UTF-8");
        }
      }
      case 4: {
        if (n > MAX_ITEMS) throw new CborError(`more than ${MAX_ITEMS} items`);
        const out = [];
        for (let k = 0; k < n; k++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        if (n > MAX_ITEMS) throw new CborError(`more than ${MAX_ITEMS} items`);
        // Own data properties only (a key "__proto__" stays a key, never a prototype).
        const out = {};
        let prev = null;
        for (let k = 0; k < n; k++) {
          const ks = i;
          if (i >= b.length || b[i] >> 5 !== 3) throw new CborError("map keys are text strings");
          const key = item(depth + 1);
          const kb = b.subarray(ks, i);
          if (prev && Buffer.compare(prev, kb) >= 0) throw new CborError(Buffer.compare(prev, kb) === 0 ? "a repeated map key" : "map keys out of deterministic order");
          prev = kb;
          Object.defineProperty(out, key, { value: item(depth + 1), enumerable: true, writable: true, configurable: true });
        }
        return out;
      }
      default:
        throw new CborError(major === 1 ? "negative integers are not used" : major === 6 ? "tags are not used" : "floats and simple values are not used");
    }
  };
  const value = item(1);
  if (i !== b.length) throw new CborError("bytes after the end of the item");
  return value;
}
