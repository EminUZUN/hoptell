// Client relay profiles: realm pinning as an interprocess compare-and-set.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const home = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-prof-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const realmA = "a".repeat(32);
const realmB = "b".repeat(32);

/** Run commitWelcome in a separate process (a real second client). */
function commitIn(dir, key, realm) {
  const url = new URL("../lib/profiles.js", import.meta.url).href;
  const script = `const p = await import(${JSON.stringify(url)}); try { await p.commitWelcome(${JSON.stringify(dir)}, ${JSON.stringify(key)}, { realm: ${JSON.stringify(realm)}, member: null }); process.stdout.write("ok"); } catch (e) { process.stdout.write("refused"); }`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", () => resolve(out));
  });
}

test("profile keys: explicit names are validated; URLs are normalized", async () => {
  const { profileKey } = await import("../lib/profiles.js");
  assert.equal(profileKey("wss://Relay.Example.com/", ""), profileKey("wss://relay.example.com", ""));
  assert.notEqual(profileKey("wss://relay.example.com", ""), profileKey("wss://other.example.com", ""));
  assert.equal(profileKey("wss://x", "work"), "work");
  assert.throws(() => profileKey("wss://x", "../evil"), /HOPTELL_PROFILE/);
});

test("two first connections with different realms: exactly one pins, the other is refused", async (t) => {
  const dir = home(t);
  for (let round = 0; round < 5; round++) {
    const key = `race${round}`;
    const results = await Promise.all([commitIn(dir, key, realmA), commitIn(dir, key, realmB)]);
    assert.deepEqual(results.sort(), ["ok", "refused"], `round ${round}: ${results}`);
  }
  // Same realm concurrently: both succeed.
  const same = await Promise.all([commitIn(dir, "same", realmA), commitIn(dir, "same", realmA), commitIn(dir, "same", realmA)]);
  assert.deepEqual(same, ["ok", "ok", "ok"]);
});

test("a pinned profile requires protocol 2; a damaged profile is an error, never a fresh start", async (t) => {
  const dir = home(t);
  const p = await import("../lib/profiles.js");
  await p.noteLegacy(dir, "old");
  assert.equal(p.readProfile(dir, "old").require, false);
  const rec = await p.commitWelcome(dir, "new", { realm: realmA, member: { id: "m_x" } });
  assert.equal(rec.require, true);
  await assert.rejects(() => p.noteLegacy(dir, "new"), /requires protocol 2/);
  await assert.rejects(() => p.commitWelcome(dir, "new", { realm: realmB, member: null }), /relay realm changed/);
  const file = path.join(dir, "profiles", "new.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "{oops");
  assert.throws(() => p.readProfile(dir, "new"), /damaged/);
  await assert.rejects(() => p.commitWelcome(dir, "new", { realm: realmA, member: null }), /damaged/);
});
