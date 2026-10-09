// Stored sign-in credentials (lib/credentials.js): keychain commands (faked) and the encrypted file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialStore, encryptedFile, keychain, writeDurable } from "../lib/credentials.js";

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-cred-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test("keychain backends pass secrets on stdin, never in arguments", () => {
  for (const platform of ["darwin", "linux"]) {
    const calls = [];
    const store = new Map();
    const run = (cmd, args, input) => {
      calls.push({ cmd, args, input });
      if (args.includes("-i") && input.startsWith("add-generic-password")) {
        store.set("p", input.trim().split(" ").pop());
        return { status: 0, stdout: "" };
      }
      if (args[0] === "store") return store.set("p", Buffer.from(input).toString("base64")), { status: 0, stdout: "" };
      if (args[0] === "find-generic-password") return { status: store.has("p") ? 0 : 44, stdout: store.get("p") ?? "" };
      if (args[0] === "lookup") return { status: store.has("p") ? 0 : 1, stdout: store.has("p") ? Buffer.from(store.get("p"), "base64").toString() : "" };
      return { status: 0, stdout: "" };
    };
    const k = keychain({ platform, run, service: "hoptell-test" });
    assert.equal(k.set("p", "s3cret-refresh"), true);
    for (const c of calls) assert.ok(!c.args.join(" ").includes("s3cret"), `${platform}: the secret is not an argument`);
    assert.equal(k.get("p"), "s3cret-refresh");
  }
  assert.equal(keychain({ platform: "win32" }), null);
});

test("the encrypted file round-trips, needs the right passphrase and refuses weak ones", (t) => {
  const home = tmp(t);
  const f = encryptedFile(home, { passphrase: "correct horse battery" });
  f.set("relay-1", JSON.stringify({ refresh: "r1" }));
  const raw = fs.readFileSync(path.join(home, "credentials", "relay-1.json"), "utf8");
  assert.doesNotMatch(raw, /r1"/, "stored encrypted");
  assert.equal(fs.statSync(path.join(home, "credentials", "relay-1.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(f.get("relay-1")), { refresh: "r1" });
  assert.throws(() => encryptedFile(home, { passphrase: "wrong passphrase!" }).get("relay-1"), /cannot be decrypted/);
  assert.throws(() => encryptedFile(home, { passphrase: "short" }), /at least 12/);
  // Another format, other parameters or wrong lengths are refused before any key derivation.
  const file = path.join(home, "credentials", "relay-1.json");
  const rec = JSON.parse(raw);
  for (const change of [{ N: 1 << 20 }, { salt: Buffer.alloc(8).toString("base64") }, { iv: Buffer.alloc(16).toString("base64") }, { tag: "" }, { cipher: "aes-128-gcm" }]) {
    fs.writeFileSync(file, JSON.stringify({ ...rec, ...change }));
    assert.throws(() => f.get("relay-1"), /unknown format/, JSON.stringify(change));
  }
});

test("the store uses the keychain when it can, the file only when chosen, and stops otherwise", (t) => {
  const home = tmp(t);
  const none = { kind: "none", available: () => false };
  assert.throws(() => credentialStore(home, "relay-1", { keychainBackend: none }), /no OS keychain/);
  const s = credentialStore(home, "relay-1", { store: "file", passphrase: "correct horse battery", keychainBackend: none });
  s.write({ refresh: "x" });
  assert.equal(s.kind, "encrypted file");
  // Once the file holds this profile, it is used again without asking.
  assert.deepEqual(credentialStore(home, "relay-1", { passphrase: "correct horse battery", keychainBackend: none }).read(), { refresh: "x" });
  assert.throws(() => credentialStore(home, "../x", { keychainBackend: none }), /invalid relay profile/);
});

test("a locked or unavailable keychain is an error, never 'not signed in'", () => {
  const darwin = (status) => keychain({ platform: "darwin", run: () => ({ status, stdout: "", stderr: "" }) });
  assert.equal(darwin(44).get("p"), null, "not stored");
  assert.throws(() => darwin(51).get("p"), /locked or unavailable/);
  assert.throws(() => darwin(-1).get("p"), /locked or unavailable/);
  const linux = (status, stderr = "") => keychain({ platform: "linux", run: () => ({ status, stdout: "", stderr }) });
  assert.equal(linux(1).get("p"), null);
  assert.throws(() => linux(1, "Cannot autolaunch D-Bus without X11").get("p"), /could not be read/);
});

test("a durable write continues after a short write", (t) => {
  const d = tmp(t);
  const real = fs.writeSync;
  // At most 3 bytes per call, for strings and buffers alike (a short write reports what it wrote).
  fs.writeSync = (fd, data, off = 0, len) => {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    const start = typeof data === "string" ? 0 : off;
    const n = Math.min(typeof data === "string" ? buf.length : (len ?? buf.length - start), 3);
    return real(fd, buf, start, n);
  };
  try {
    writeDurable(path.join(d, "x.json"), JSON.stringify({ a: "0123456789" }));
  } finally {
    fs.writeSync = real;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "x.json"), "utf8")), { a: "0123456789" });
});
