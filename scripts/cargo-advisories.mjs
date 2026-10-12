#!/usr/bin/env node
// The advisory part of the release gate's entry criterion 1 (design 3.5): the fixes are checked in
// the build's transitive Cargo.lock, not through a top-level version. Reads the lock only (no
// cargo command runs, nothing is fetched or written); `cargo audit` on the same lock is the second
// half of the criterion and is run separately.
//
//   node scripts/cargo-advisories.mjs <Cargo.lock>     exit 0 only when every required fix is locked
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseCargoLock } from "./gate-lib.mjs";

/** The minimum versions the advisories name as patched. */
export const REQUIRED = [
  { crate: "libcrux-kem", min: "0.0.10", advisories: ["RUSTSEC-2026-0330", "RUSTSEC-2026-0331"] },
  { crate: "libcrux-hmac-drbg", min: "0.0.2", advisories: ["RUSTSEC-2026-0329"] },
];

/** -1, 0 or 1; a pre-release or build suffix sorts below its release (fail closed). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
    if (!m) throw new Error(`not a version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * Check a lock's text: [{crate, min, advisories, versions, ok, why}]. Every locked version of a
 * crate must be at least the minimum; a crate missing from the lock fails (the build is expected to
 * use both; an absent crate means the lock is not the build's).
 */
export function checkLock(text) {
  const pkgs = parseCargoLock(text);
  return REQUIRED.map((r) => {
    const versions = pkgs.filter((p) => p.name === r.crate).map((p) => p.version);
    let ok = versions.length > 0;
    let why = ok ? "" : "not in the lock";
    for (const v of versions) {
      let below;
      try {
        below = compareVersions(v, r.min) < 0;
      } catch (e) {
        below = true;
        why = e.message;
      }
      if (below) {
        ok = false;
        why ||= `${v} is below ${r.min}`;
      }
    }
    return { ...r, versions, ok, why };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/cargo-advisories.mjs <Cargo.lock>");
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    console.error(`cargo advisories: cannot open ${file}: ${e.code ?? e.message}`);
    process.exit(2);
  }
  const results = checkLock(text);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.crate} >= ${r.min} (${r.advisories.join(", ")}): locked ${r.versions.join(", ") || "none"}${r.ok ? "" : ` (${r.why})`}`);
  if (results.some((r) => !r.ok)) process.exit(1);
}
