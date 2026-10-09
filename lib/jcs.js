// RFC 8785 JSON Canonicalization Scheme (JCS), for the shapes hoptell signs over: objects,
// arrays, strings, finite numbers, booleans and null. Object keys are sorted by their UTF-16 code
// units; strings and numbers use ECMAScript's serialization, which is what JCS specifies.
// Anything JCS cannot represent (lone surrogates, non-finite numbers, other types) is refused.

/** A value that cannot be canonicalized. */
export class JcsError extends Error {}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// Plain code-unit comparison (not localeCompare, not code points): what RFC 8785 3.2.3 asks for.
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function str(s) {
  if (LONE_SURROGATE.test(s)) throw new JcsError("a string holds a lone surrogate");
  return JSON.stringify(s);
}

/** The canonical JSON text of `value`. */
export function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return str(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JcsError("a number is not finite");
    return JSON.stringify(value); // ECMAScript Number serialization; -0 becomes 0
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort(byCodeUnits);
    return `{${keys.map((k) => `${str(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  throw new JcsError("a value is not JSON data");
}
