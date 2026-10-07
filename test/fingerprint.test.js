// Opt-in keyed fingerprints in relay logs: the HMAC encoding, the key-file loader, relay log
// events, CLI startup and doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import WebSocket from "ws";
import { BIN, REF_RE } from "../lib/config.js";
import { FingerprintError, fingerprintSuffix, fingerprintsEnabled, loadFingerprintKey } from "../lib/fingerprint.js";
import { startRelay } from "../lib/relay.js";
import { TOKEN, sleep } from "./helpers.js";

const skip = !(process.platform === "darwin" || process.platform === "linux") && "key files need macOS or Linux";
const testKey = () => crypto.createSecretKey(crypto.randomBytes(32));
const REF = "00000000-0000-4000-8000-000000000001";

test("fingerprint: matches the independently computed vector, full length", () => {
  const key = crypto.createSecretKey(Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
  const text = "A\r\n\u{1F44B}\uD800\u0000";
  assert.equal(text.length, 7);
  assert.equal(fingerprintSuffix({ id: "test", key }, REF, text), "fp=hmac-sha256-text-v1:test:bbeede30a33fd2d4458e00d0f1e649e7629cdefe01522eec59147891fe5361f4");
});

test("fingerprint: any change of key, id, reference or exact text changes the tag", () => {
  const key = testKey();
  const fp = (t, o = {}) => fingerprintSuffix({ id: o.id ?? "k1", key: o.key ?? key }, o.ref ?? REF, t);
  const base = fp("hello\n");
  assert.match(base, /^fp=hmac-sha256-text-v1:k1:[0-9a-f]{64}$/);
  assert.equal(fp("hello\n"), base, "same inputs, same tag");
  const variants = [
    fp("hello\n", { key: testKey() }),
    fp("hello\n", { id: "k2" }),
    fp("hello\n", { ref: "00000000-0000-4000-8000-000000000002" }),
    fp("hello\r\n"),
    fp("hello"),
    fp("﻿hello\n"),
    fp("hello\n\uD800"),
    fp("hello\n�"),
    fp("café"),
  ];
  assert.notEqual(fp("café"), fp("café"), "composed and decomposed differ");
  assert.notEqual(fp("x\uD800"), fp("x�"), "a lone surrogate is not U+FFFD");
  for (const v of variants) assert.notEqual(v, base);
  // The same decoded string, however it was escaped on the wire, has one tag.
  assert.equal(fp(JSON.parse('"\\u0068ello\\n"')), base);
});

test("fingerprint setting: on, off or unset; anything else is an error", () => {
  assert.equal(fingerprintsEnabled(undefined), false);
  assert.equal(fingerprintsEnabled(""), false);
  assert.equal(fingerprintsEnabled("off"), false);
  assert.equal(fingerprintsEnabled("on"), true);
  for (const v of ["ON", "yes", "1", "true"]) assert.throws(() => fingerprintsEnabled(v), /must be on or off/);
});

/** A private folder for key files; returns {dir, write(name, content, mode)}. */
function keyDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-fp-")));
  return {
    dir,
    write(name, content, mode = 0o600) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content, { mode });
      fs.chmodSync(file, mode);
      return file;
    },
    close: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
const keyJson = (o = {}) => JSON.stringify({ v: 1, id: "relay-1", key_hex: crypto.randomBytes(32).toString("hex"), ...o });

test("key file: strict format, private permissions, refused links and special files, no leaks", { skip }, (t) => {
  const k = keyDir();
  t.after(k.close);
  const ok600 = k.write("ok600.json", `${keyJson()}\n`);
  const loaded = loadFingerprintKey(ok600);
  assert.equal(loaded.id, "relay-1");
  assert.equal(loaded.key.symmetricKeySize, 32);
  assert.equal(loadFingerprintKey(k.write("ok400.json", keyJson(), 0o400)).id, "relay-1");

  const secretHex = crypto.randomBytes(32).toString("hex");
  const cases = {
    "relative/path.json": "invalid_path",
    [path.join(k.dir, "missing.json")]: "missing_key_file",
    [k.write("open644.json", keyJson(), 0o644)]: "unsafe_file",
    [k.write("open640.json", keyJson(), 0o640)]: "unsafe_file",
    [k.write("exec700.json", keyJson(), 0o700)]: "unsafe_file",
    [k.write("badutf8.json", Buffer.from([0x7b, 0xff, 0x7d]))]: "invalid_utf8",
    [k.write("notjson.json", `{ "key_hex": "${secretHex}"`)]: "invalid_json",
    [k.write("extra.json", keyJson({ extra: 1 }))]: "invalid_fields",
    [k.write("v2.json", keyJson({ v: 2 }))]: "invalid_fields",
    [k.write("badid.json", keyJson({ id: "-x" }))]: "invalid_fields",
    [k.write("newlineid.json", keyJson({ id: "relay\n" }))]: "invalid_fields",
    [k.write("upper.json", keyJson({ key_hex: secretHex.toUpperCase() }))]: "invalid_key",
    [k.write("short.json", keyJson({ key_hex: "ab" }))]: "invalid_key",
    [k.write("newlinekey.json", keyJson({ key_hex: `${secretHex}\n` }))]: "invalid_key",
    [k.write("big.json", `${keyJson()}${" ".repeat(600)}`)]: "too_large",
    [k.dir]: "unsafe_file",
  };
  fs.symlinkSync(ok600, path.join(k.dir, "link.json"));
  cases[path.join(k.dir, "link.json")] = "unsafe_file";
  fs.linkSync(ok600, path.join(k.dir, "hard.json"));
  cases[path.join(k.dir, "hard.json")] = "unsafe_file";
  spawnSync("mkfifo", ["-m", "600", path.join(k.dir, "fifo.json")]);
  cases[path.join(k.dir, "fifo.json")] = "unsafe_file";
  for (const [file, code] of Object.entries(cases)) {
    assert.throws(
      () => loadFingerprintKey(file),
      (e) => e instanceof FingerprintError && e.code === code && !e.message.includes(k.dir) && !e.message.includes(secretHex),
      `${path.basename(file)} -> ${code}`,
    );
  }
});

test("relay logs: tags on routing, queue, forward, requeue, receipt and expiry; none in frames", { skip }, async (t) => {
  const logs = [];
  const fp = { id: "relay-1", key: testKey() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, fingerprint: fp, sweepMs: 200, log: (...a) => logs.push(a.join(" ")) });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const frames = [];
  const peer = (name, roles = [], confirm = true) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, name, token: TOKEN, mode: "peer", roles })));
      ws.on("message", (d) => {
        frames.push(String(d));
        const m = JSON.parse(d);
        if (m.type === "welcome") resolve(ws);
        if (m.type === "message" && confirm) ws.send(JSON.stringify({ type: "got", id: m.id }));
      });
      ws.on("error", () => {});
    });
  const sender = await peer("alice");
  const send = (to, text, extra = {}) =>
    new Promise((resolve) => {
      const id = crypto.randomInt(1e9);
      const on = (d) => {
        const m = JSON.parse(d);
        if (m.id === id) {
          sender.off("message", on);
          resolve(m);
        }
      };
      sender.on("message", on);
      sender.send(JSON.stringify({ type: "send", id, to, text, ...extra }));
    });
  const tagOf = (ref, text) => fingerprintSuffix(fp, ref, text);
  const lines = (ref) => logs.filter((l) => l.includes(`ref ${ref}`));
  assert.match(logs.join("\n"), /fingerprint logging enabled key-id relay-1 format hmac-sha256-text-v1/);

  // Direct delivery: summary, forward attempt and receipt carry the same tag.
  const bob = await peer("bob", ["rev"]);
  const direct = await send("bob", "hello bob");
  await sleep(100);
  const tag = tagOf(direct.message_id, "hello bob");
  const d = lines(direct.message_id);
  assert.ok(d.some((l) => l.startsWith("alice -> bob (9 chars)") && l.endsWith(tag)));
  assert.ok(d.some((l) => l.startsWith("forward attempt") && l.endsWith(tag)));
  assert.ok(d.some((l) => l.startsWith("receipt acknowledged") && l.endsWith(tag)));

  // The same text sent again gets a fresh reference and a different tag.
  const again = await send("bob", "hello bob");
  assert.notEqual(tagOf(again.message_id, "hello bob"), tag);

  // Fan-out: one tag, a forward attempt per recipient.
  const carol = await peer("carol", ["rev"]);
  const fan = await send("@rev", "both");
  await sleep(100);
  const ft = tagOf(fan.message_id, "both");
  assert.equal(lines(fan.message_id).filter((l) => l.startsWith("forward attempt") && l.endsWith(ft)).length, 2);

  // Queued for an offline peer, then delivered: queue admission line, later forward and receipt.
  carol.close();
  await sleep(100);
  const queued = await send("carol", "later");
  const qt = tagOf(queued.message_id, "later");
  assert.ok(lines(queued.message_id).some((l) => /^queued ref \S+ delivery \S+ for carol /.test(l) && l.endsWith(qt)));
  const carol2 = await peer("carol", ["rev"], false); // receives but never confirms
  await sleep(150);
  carol2.close(); // unconfirmed: requeued
  await sleep(150);
  assert.ok(lines(queued.message_id).some((l) => l.startsWith("requeued") && l.endsWith(qt)));

  // Expiry: the dropped message's tag is logged.
  const short = await send("carol", "brief", { ttl: 1 });
  await sleep(1500);
  assert.ok(lines(short.message_id).some((l) => l.startsWith("expired") && l.endsWith(tagOf(short.message_id, "brief"))));

  // Refused sends get no tag, and nothing reaches clients.
  await send("nobody", "refused");
  assert.ok(!logs.some((l) => l.includes("nobody") && l.includes("fp=")));
  assert.ok(frames.length > 5 && frames.every((f) => !f.includes("fp=") && !f.includes("relay-1") && !f.includes("hmac")));
  for (const ws of [sender, bob]) ws.terminate();
});

test("relay logs: off means no tags and no key file read", async (t) => {
  const logs = [];
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, log: (...a) => logs.push(a.join(" ")) });
  t.after(() => relay.close());
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", v: 1, name: "bob", token: TOKEN }));
  await sleep(50);
  ws.terminate();
  assert.ok(!logs.join("\n").includes("fp=") && !logs.join("\n").includes("fingerprint"));
});

/** Start `hoptell relay` with extra settings; resolves to {code, out} when it exits or after 1.5s. */
function relayCli(env) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-fpcli-"));
    fs.writeFileSync(path.join(dir, "empty.env"), "");
    const p = spawn(process.execPath, [BIN, "relay", "--host", "127.0.0.1", "--port", "0"], { env: { ...process.env, HOPTELL_ENV: path.join(dir, "empty.env"), HOPTELL_TOKEN: TOKEN, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill(), 1500);
    p.on("exit", (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, out });
    });
  });
}

test("relay CLI: a bad switch or key stops it before listening; off ignores the key path", { skip }, async (t) => {
  const k = keyDir();
  t.after(k.close);
  const good = k.write("key.json", keyJson());
  const bad = await relayCli({ HOPTELL_LOG_FINGERPRINTS: "maybe" });
  assert.notEqual(bad.code, null);
  assert.match(bad.out, /must be on or off/);
  assert.doesNotMatch(bad.out, /listening/);
  const missing = await relayCli({ HOPTELL_LOG_FINGERPRINTS: "on", HOPTELL_LOG_FINGERPRINT_KEY_FILE: path.join(k.dir, "nope.json") });
  assert.match(missing.out, /fingerprint key file could not be used \(missing_key_file\)/);
  assert.doesNotMatch(missing.out, /listening/);
  assert.ok(!missing.out.includes(k.dir), "the key path is not printed");
  const off = await relayCli({ HOPTELL_LOG_FINGERPRINTS: "off", HOPTELL_LOG_FINGERPRINT_KEY_FILE: path.join(k.dir, "nope.json") });
  assert.match(off.out, /listening/);
  const on = await relayCli({ HOPTELL_LOG_FINGERPRINTS: "on", HOPTELL_LOG_FINGERPRINT_KEY_FILE: good });
  assert.match(on.out, /fingerprint logging enabled key-id relay-1 format hmac-sha256-text-v1/);
  assert.ok(!on.out.includes(JSON.parse(fs.readFileSync(good, "utf8")).key_hex));
});

test("doctor: reports the local fingerprint setting without paths or keys", { skip }, async (t) => {
  const k = keyDir();
  t.after(k.close);
  const good = k.write("key.json", keyJson({ id: "relay-7" }));
  const run = (env) =>
    new Promise((resolve) =>
      execFile(process.execPath, [BIN, "doctor"], { env: { ...process.env, HOPTELL_ENV: path.join(k.dir, "none.env"), HOPTELL_RELAY: "", HOPTELL_TOKEN: "", ...env } }, (_e, stdout) => resolve(stdout)),
    );
  fs.writeFileSync(path.join(k.dir, "none.env"), "");
  assert.match(await run({}), /info +relay fingerprints: disabled in these local settings/);
  const ok = await run({ HOPTELL_LOG_FINGERPRINTS: "on", HOPTELL_LOG_FINGERPRINT_KEY_FILE: good });
  assert.match(ok, /ok +relay fingerprints: local key file is valid \(id relay-7\); the running relay was not checked/);
  const bad = await run({ HOPTELL_LOG_FINGERPRINTS: "on", HOPTELL_LOG_FINGERPRINT_KEY_FILE: k.write("open.json", keyJson(), 0o644) });
  assert.match(bad, /FAIL +relay fingerprints: local key file could not be used \(unsafe_file\)/);
  // The settings file's own path appears in its line; the key file's path never does.
  for (const out of [ok, bad]) assert.ok(!out.includes("key.json") && !out.includes("open.json"), out);
});

test("relay API: only a real 32-byte KeyObject, checked before listening; the caller cannot change it later", async (t) => {
  const net = await import("node:net");
  const free = await new Promise((r) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => r(port));
    });
  });
  for (const fingerprint of [
    { id: "k1", key: { type: "secret", symmetricKeySize: 32 } },
    { id: "k1", key: crypto.createSecretKey(crypto.randomBytes(16)) },
    { id: "bad id", key: testKey() },
    { key: testKey() },
  ]) {
    await assert.rejects(async () => startRelay({ host: "127.0.0.1", port: free, token: TOKEN, fingerprint, log: () => {} }), /32-byte secret crypto.KeyObject/);
  }
  // Nothing is listening on that port after the refusals.
  await assert.rejects(new Promise((resolve, reject) => net.connect(free, "127.0.0.1").on("connect", resolve).on("error", reject)));

  const logs = [];
  const mine = { id: "relay-1", key: testKey() };
  const original = { ...mine };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, fingerprint: mine, log: (...a) => logs.push(a.join(" ")) });
  t.after(() => relay.close());
  mine.id = "changed";
  mine.key = testKey();
  const login = async (name) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", v: 1, name, token: TOKEN }));
    await new Promise((r) => ws.once("message", r));
    return ws;
  };
  const ws = await login("bob");
  ws.send(JSON.stringify({ type: "send", id: 1, to: "bob-x", text: "x" })); // refused: unknown peer, no tag
  ws.send(JSON.stringify({ type: "send", id: 2, to: "@all", text: "x" })); // refused: nobody else online
  await sleep(100);
  assert.ok(!logs.some((l) => l.includes("fp=")), "refused sends carry no fingerprint");

  // An accepted send after the caller's object changed is still tagged with the original id and key.
  const carol = await login("carol");
  ws.send(JSON.stringify({ type: "send", id: 3, to: "carol", text: "accepted text" }));
  for (let i = 0; i < 50 && !logs.some((l) => l.includes("fp=")); i++) await sleep(20);
  const ref = logs.join("\n").match(/ ref (\S+)/)?.[1];
  assert.match(ref ?? "", REF_RE);
  ws.terminate();
  carol.terminate();
  const tagged = logs.filter((l) => l.includes("fp="));
  assert.ok(tagged.length > 0, "the accepted send is fingerprinted");
  const expected = fingerprintSuffix(original, ref, "accepted text");
  for (const l of tagged) assert.ok(l.endsWith(expected), l);
  assert.ok(!logs.some((l) => l.includes(":changed:")));
});

test("relay logs: a fan-out where no copy is admitted carries no fingerprint", async (t) => {
  const logs = [];
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, fingerprint: { id: "relay-1", key: testKey() }, log: (...a) => logs.push(a.join(" ")) });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const open = (name, roles = []) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, name, token: TOKEN, roles, mode: name === "busy" ? "peer" : "send" })));
      ws.once("message", () => resolve(ws));
      ws.on("error", () => {});
    });
  const busy = await open("busy", ["w"]); // receives but never confirms
  // Fill busy's unconfirmed window (50) and queue (50), 25 messages per sender connection.
  const senders = await Promise.all([0, 1, 2, 3].map((i) => open(`s${i}`)));
  for (const s of senders) for (let i = 0; i < 25; i++) s.send(JSON.stringify({ type: "send", id: i, to: "busy", text: `m${i}` }));
  await sleep(400);
  const last = await open("s9");
  const reply = await new Promise((resolve) => {
    last.on("message", (d) => JSON.parse(d).id === 99 && resolve(JSON.parse(d)));
    last.send(JSON.stringify({ type: "send", id: 99, to: "@w", text: "nobody gets this" }));
  });
  assert.equal(reply.type, "error");
  assert.match(reply.error, /busy and its queue is full/);
  const summary = logs.find((l) => l.startsWith("s9 -> @w"));
  assert.ok(summary && !summary.includes("fp="), summary);
  for (const ws of [busy, last, ...senders]) ws.terminate();
});
