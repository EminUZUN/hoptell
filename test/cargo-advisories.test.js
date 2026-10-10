// The release gate's Cargo.lock advisory check (design 3.5, entry criterion 1), on fixture locks.
// The real lock (the bake-off's) is checked by hand: node scripts/cargo-advisories.mjs <Cargo.lock>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLock, compareVersions } from "../scripts/cargo-advisories.mjs";

test("advisory check: the fixes must be in the transitive lock; below, missing or pre-release fails", () => {
  const lock = (kem, drbg) => `${kem ? `[[package]]\nname = "libcrux-kem"\nversion = "${kem}"\n` : ""}\n${drbg ? `[[package]]\nname = "libcrux-hmac-drbg"\nversion = "${drbg}"\n` : ""}`;
  const ok = (text) => checkLock(text).map((r) => r.ok);
  assert.deepEqual(ok(lock("0.0.9", "0.0.1")), [false, false], "the bake-off's lock today");
  assert.deepEqual(ok(lock("0.0.10", "0.0.2")), [true, true]);
  assert.deepEqual(ok(lock("0.1.0", "1.0.0")), [true, true]);
  assert.deepEqual(ok(lock(null, "0.0.2")), [false, true]);
  assert.deepEqual(ok(lock("0.0.10-pre.1", "0.0.2")), [false, true]);
  assert.deepEqual(ok(lock("0.0.10", "0.0.2") + `\n[[package]]\nname = "libcrux-kem"\nversion = "0.0.9"\n`), [false, true], "every locked version counts");
  assert.equal(compareVersions("0.0.10", "0.0.9"), 1);
  assert.equal(checkLock(lock("0.0.9", "0.0.1"))[0].why, "0.0.9 is below 0.0.10");
});
