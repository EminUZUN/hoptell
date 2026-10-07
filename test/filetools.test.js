// send_file and verify_snapshot through real MCP servers and a relay. Sender and reviewer get
// separate state folders and approved folders, as if they were on different machines.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseRoots, supported } from "../lib/files.js";
import { sleep, world } from "./helpers.js";

const skip = !supported() && "file tools need macOS or Linux";

/** A machine: its own state folder and approved folder "app" with the given files. */
function machine(w, label, files = {}) {
  const home = path.join(w.home, label);
  const app = path.join(home, "work", "app");
  fs.mkdirSync(app, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), content);
  }
  const env = { HOPTELL_HOME: path.join(home, "state"), HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: app }]) };
  return { home, app, env };
}

const call = async (peer, tool, args) => {
  const r = await peer.client.callTool({ name: tool, arguments: args });
  return { ...r.structuredContent, isError: r.isError };
};
const tools = async (peer) => (await peer.client.listTools()).tools.map((t) => t.name);
const envelope = (text) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

async function inboxOf(peer, until = /hoptell_snapshot/) {
  let got = "";
  for (let i = 0; i < 40 && !until.test(got); i++) {
    got += await peer.call("read_inbox");
    if (!until.test(got)) await sleep(100);
  }
  return got;
}

test("file tools are off unless approved folders are configured; messaging still works", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const plain = await w.mcp("plain");
  assert.ok(!(await tools(plain)).includes("send_file"));
  const empty = await w.mcp("empty", { HOPTELL_SNAPSHOT_ROOTS: "[]" });
  assert.ok(!(await tools(empty)).includes("send_file"));
  const broken = await w.mcp("broken", { HOPTELL_SNAPSHOT_ROOTS: "{not json SECRET" });
  assert.ok(!(await tools(broken)).includes("send_file"));
  assert.match(await broken.call("send_message", { to: "plain", message: "still works" }), /Delivered to plain/);
  const plainSend = (await plain.client.listTools()).tools.find((x) => x.name === "send_message").description;
  assert.match(plainSend, /Snapshot command: .* snapshot`/); // the CLI fallback
  const m = machine(w, "on");
  const on = await w.mcp("on", m.env);
  assert.deepEqual((await tools(on)).filter((n) => /file|snapshot/.test(n)), ["send_file", "verify_snapshot"]);
  assert.match(on.client.getInstructions(), /call send_file for one named peer/);
});

test("send_file sends the exact bytes with their sha256; verify_snapshot follows the file", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const bytes = Buffer.from("﻿const team = ['Sam'];\r\nconsole.log(team[1]);\n", "utf8");
  const sam = machine(w, "sam", { "src/greet.js": bytes });
  const alex = machine(w, "alex"); // another machine: its own state and its own "app" folder
  const s = await w.mcp("sam", sam.env);
  const a = await w.mcp("alex", alex.env);

  const sent = await call(s, "send_file", { to: "alex", root_id: "app", path: "src/greet.js", request: "Find the bug." });
  assert.equal(sent.state, "accepted", JSON.stringify(sent));
  assert.equal(sent.file, "app:src/greet.js");
  assert.equal(sent.sha256, `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`);
  assert.match(sent.snapshot_id, /^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
  assert.match(sent.message_reference, /^[0-9a-f-]{36}$/);
  assert.equal(sent.expiry_applied, true);

  const got = await inboxOf(a);
  const env = envelope(got);
  assert.ok(Buffer.from(env.content, "utf8").equals(bytes), "the reviewer gets the exact bytes");
  assert.equal(env.sha256, sent.sha256);
  assert.equal(env.review_request_id, sent.review_request_id);
  assert.equal(env.request, "Find the bug.");
  assert.equal(env.file, "app:src/greet.js");
  assert.ok(!got.includes(sam.app), "the sender's absolute path never leaves the machine");

  // The reviewer cannot verify the sender's snapshot: records live only on the sender's machine.
  assert.equal((await call(a, "verify_snapshot", { snapshot_id: sent.snapshot_id })).state, "unknown");

  const file = path.join(sam.app, "src/greet.js");
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id })).state, "match");
  fs.appendFileSync(file, "// edited\n");
  const changed = await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id });
  assert.equal(changed.state, "changed");
  assert.notEqual(changed.current_sha256, changed.expected_sha256);
  // An editor's atomic save with the original bytes is a match again.
  fs.writeFileSync(`${file}.tmp`, bytes);
  fs.renameSync(`${file}.tmp`, file);
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id })).state, "match");
  fs.rmSync(file);
  const gone = await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id });
  assert.deepEqual([gone.state, gone.reason, gone.isError], ["unavailable", "file_missing", true]);

  // Records hold metadata only.
  const records = fs.readdirSync(path.join(sam.env.HOPTELL_HOME, "snapshots"), { recursive: true }).filter((f) => f.endsWith(".json"));
  assert.equal(records.length, 1);
  const raw = fs.readFileSync(path.join(sam.env.HOPTELL_HOME, "snapshots", records[0]), "utf8");
  for (const leak of ["Find the bug", "team", sam.app, w.env.HOPTELL_TOKEN]) assert.ok(!raw.includes(leak), `record contains ${leak}`);
  assert.equal(fs.statSync(path.join(sam.env.HOPTELL_HOME, "snapshots", records[0])).mode & 0o777, 0o600);
});

test("send_file refuses unsafe requests and sends nothing", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const sam = machine(w, "sam", { "ok.txt": "fine", "bin.dat": Buffer.from([0xff, 0xfe, 0x00]), "big.txt": "x".repeat(60_001) });
  fs.writeFileSync(path.join(sam.home, "secret.txt"), "SECRET");
  fs.symlinkSync(path.join(sam.home, "secret.txt"), path.join(sam.app, "link.txt"));
  const s = await w.mcp("sam", sam.env);
  const a = await w.mcp("alex");
  const base = { to: "alex", root_id: "app", path: "ok.txt", request: "review" };
  const cases = [
    [{ ...base, to: "@all" }, "invalid_arguments"],
    [{ ...base, root_id: "elsewhere" }, "invalid_arguments"],
    [{ ...base, path: "../secret.txt" }, "path_unsafe"],
    [{ ...base, path: "/etc/passwd" }, "path_unsafe"],
    [{ ...base, path: "link.txt" }, "path_unsafe"],
    [{ ...base, path: "bin.dat" }, "not_utf8"],
    [{ ...base, path: "big.txt" }, "too_large"],
    [{ ...base, path: "nope.txt" }, "file_missing"],
    [{ ...base, request: "" }, "invalid_arguments"],
    [{ ...base, request: "x".repeat(4001) }, "invalid_arguments"],
    [{ ...base, ttl_seconds: 86401 }, "invalid_arguments"],
    [{ ...base, reply_to: "nope" }, "invalid_arguments"],
    [{ ...base, extra: 1 }, "invalid_arguments"],
  ];
  for (const [args, code] of cases) {
    const r = await call(s, "send_file", args);
    assert.deepEqual([r.state, r.error_code, r.isError], ["error", code, true], JSON.stringify(args).slice(0, 80));
    assert.ok(!JSON.stringify(r).includes("SECRET") && !JSON.stringify(r).includes(sam.home), "no file content or paths in errors");
  }
  assert.equal(await a.call("read_inbox"), "Inbox empty.");

  // Unknown peer: the relay refuses, the record says so, and nothing is retried.
  const refused = await call(s, "send_file", { ...base, to: "nobody" });
  assert.deepEqual([refused.state, refused.error_code], ["rejected", "relay_refused"]);
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: refused.snapshot_id })).send_state, "rejected");
});

test("send_file does not send when its record cannot be saved", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const sam = machine(w, "sam", { "ok.txt": "fine" });
  fs.mkdirSync(sam.env.HOPTELL_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sam.env.HOPTELL_HOME, "snapshots"), "not a folder");
  const s = await w.mcp("sam", sam.env);
  const a = await w.mcp("alex");
  const r = await call(s, "send_file", { to: "alex", root_id: "app", path: "ok.txt", request: "review" });
  assert.deepEqual([r.state, r.error_code], ["error", "storage_error"]);
  await sleep(200);
  assert.equal(await a.call("read_inbox"), "Inbox empty.");
});

test("queued for an offline reviewer: the reviewer gets the captured version; the sender sees the change", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const sam = machine(w, "sam", { "a.js": "version A\n" });
  const alex = machine(w, "alex", { "a.js": "the reviewer's own, different checkout\n" });
  const s = await w.mcp("sam", sam.env);
  const a = await w.mcp("alex", alex.env);
  await a.client.close();
  await sleep(200);
  const sent = await call(s, "send_file", { to: "alex", root_id: "app", path: "a.js", request: "review", ttl_seconds: 600 });
  assert.deepEqual([sent.state, sent.delivery_state], ["accepted", "queued"]);
  fs.writeFileSync(path.join(sam.app, "a.js"), "version B\n");
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id })).state, "changed");
  const back = await w.mcp("alex", alex.env);
  const env = envelope(await inboxOf(back));
  assert.equal(env.content, "version A\n");
  assert.equal(env.sha256, sent.sha256);
});

test("records survive a restart; a remapped folder, an expired or tampered record never reads a file", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const sam = machine(w, "sam", { "a.js": "A\n" });
  await w.mcp("alex");
  let s = await w.mcp("sam", sam.env);
  const sent = await call(s, "send_file", { to: "alex", root_id: "app", path: "a.js", request: "review" });
  await s.client.close();

  s = await w.mcp("sam", sam.env); // a new MCP server instance, same machine and settings
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id })).state, "match");
  await s.client.close();

  // Same id, different folder: never redirected.
  const other = path.join(sam.home, "work", "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "a.js"), "A\n");
  s = await w.mcp("sam", { ...sam.env, HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: other }]) });
  const moved = await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id });
  assert.deepEqual([moved.state, moved.reason], ["unavailable", "root_changed"]);
  await s.client.close();

  s = await w.mcp("sam", sam.env);
  const [session, request] = sent.snapshot_id.split(":");
  const recordFile = path.join(sam.env.HOPTELL_HOME, "snapshots", session, `${request}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const rewrite = (r) => fs.writeFileSync(recordFile, JSON.stringify(r));
  rewrite({ ...record, created_at: Date.now() - 25 * 3600_000, expires_at: Date.now() - 3600_000 });
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id })).state, "expired");
  rewrite({ ...record, path: "../../secret" });
  assert.deepEqual(
    ((r) => [r.state, r.reason])(await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id })),
    ["unavailable", "invalid_record"],
  );
  fs.writeFileSync(recordFile, "{ not json");
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id })).reason, "invalid_record");
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: `${session}:${crypto.randomUUID()}` })).state, "unknown");
  assert.equal((await call(s, "verify_snapshot", { snapshot_id: "../../etc" })).error_code, "invalid_arguments");
});

/** A fake relay: welcomes, lists peers, and answers "send" with whatever `onSend` returns. */
async function fakeRelay(onSend) {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.type === "hello") ws.send(JSON.stringify({ type: "welcome", name: m.name }));
      if (m.type === "list") ws.send(JSON.stringify({ type: "peers", id: m.id, peers: [] }));
      if (m.type === "send") {
        const reply = onSend(m, ws);
        if (reply) ws.send(JSON.stringify(reply));
      }
    }),
  );
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => wss.close() };
}

test("send_file: only a well-formed ack counts as accepted; anything else is unknown, never resent", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const sam = machine(w, "sam", { "a.js": "A\n" });
  const marker = "RETURNED_SENSITIVE_MARKER";
  const replies = [
    (m) => ({ type: "peers", id: m.id, peers: [] }),
    (m) => ({ type: "ack", id: m.id, state: marker }),
    (m) => ({ type: "ack", id: m.id, state: "delivered", expires: 1e100 }),
    (m) => ({ type: "ack", id: m.id, state: "delivered", message_id: ["6a976c97-7664-460a-a5ba-8915ada1c29f"] }),
    (m) => ({ type: "ack", id: m.id, state: "delivered", message_id: "not-a-uuid" }),
    (m) => ({ type: "ack", id: m.id, state: "fanout", count: 1 }),
  ];
  let sends = 0;
  let next = 0;
  const fake = await fakeRelay((m) => (sends++, replies[next](m)));
  t.after(fake.close);
  const s = await w.mcp("sam", { ...sam.env, HOPTELL_RELAY: fake.url });
  for (next = 0; next < replies.length; next++) {
    const before = sends;
    const r = await call(s, "send_file", { to: "alex", root_id: "app", path: "a.js", request: "review" });
    assert.deepEqual([r.state, r.error_code, r.isError], ["unknown", "invalid_confirmation", true], `reply ${next}`);
    assert.ok(!JSON.stringify(r).includes(marker));
    assert.equal(sends, before + 1, "sent exactly once, never retried");
    assert.equal((await call(s, "verify_snapshot", { snapshot_id: r.snapshot_id })).send_state, "unknown");
  }
  // A 0.1.x relay's ack (no reference, no expiry) is fine.
  const old = await fakeRelay((m) => ({ type: "ack", id: m.id, state: "delivered" }));
  t.after(old.close);
  const s2 = await w.mcp("sam2", { ...sam.env, HOPTELL_RELAY: old.url });
  const ok = await call(s2, "send_file", { to: "alex", root_id: "app", path: "a.js", request: "review" });
  assert.deepEqual([ok.state, ok.message_reference, ok.expiry_applied], ["accepted", null, false]);
});

test("send_file: a lost connection after sending is unknown; not connected is rejected", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const sam = machine(w, "sam", { "a.js": "A\n" });
  const dropper = await fakeRelay((_m, ws) => (ws.terminate(), null));
  t.after(dropper.close);
  const s = await w.mcp("sam", { ...sam.env, HOPTELL_RELAY: dropper.url });
  const lost = await call(s, "send_file", { to: "alex", root_id: "app", path: "a.js", request: "review" });
  assert.deepEqual([lost.state, lost.error_code], ["unknown", "no_confirmation"]);
  assert.match(lost.message, /may have been sent; do not automatically resend it/);
  await sleep(300); // now disconnected (the client reconnects with backoff)
  const offline = await call(s, "send_file", { to: "alex", root_id: "app", path: "a.js", request: "review" });
  assert.deepEqual([offline.state, offline.error_code], ["rejected", "relay_refused"]);
  assert.match(offline.message, /not connected to the relay/);
});

test("records: corrupted sizes and times, unsafe stores and bad ids are refused without reading the file", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const sam = machine(w, "sam", { "a.js": "AB" });
  await w.mcp("alex");
  const s = await w.mcp("sam", sam.env);
  const sent = await call(s, "send_file", { to: "alex", root_id: "app", path: "a.js", request: "review" });
  const [session, request] = sent.snapshot_id.split(":");
  const snaps = path.join(sam.env.HOPTELL_HOME, "snapshots");
  const recordFile = path.join(snaps, session, `${request}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const verify = () => call(s, "verify_snapshot", { snapshot_id: sent.snapshot_id });
  const put = (r) => fs.writeFileSync(recordFile, JSON.stringify(r), { mode: 0o600 });

  put({ ...record, bytes: 999_999 });
  assert.deepEqual(((r) => [r.state, r.reason])(await verify()), ["unavailable", "invalid_record"]);
  put({ ...record, created_at: 1e16, expires_at: 1e16 + 3600_000 });
  assert.equal((await verify()).reason, "invalid_record");
  put({ ...record, bytes: 1 }); // same digest, different size: not a match
  assert.equal((await verify()).state, "changed");
  put(record);
  assert.equal((await verify()).state, "match");

  // A store that others could have written to is not trusted.
  fs.chmodSync(recordFile, 0o666);
  assert.equal((await verify()).reason, "invalid_record");
  fs.chmodSync(recordFile, 0o600);
  fs.chmodSync(snaps, 0o777);
  assert.equal((await verify()).reason, "invalid_record");
  fs.chmodSync(snaps, 0o700);
  assert.equal((await verify()).state, "match");

  for (const bad of [`${sent.snapshot_id}\n`, `${sent.snapshot_id}\r`, `${sent.snapshot_id}\u2028`, sent.snapshot_id.toUpperCase()]) {
    assert.equal((await call(s, "verify_snapshot", { snapshot_id: bad })).error_code, "invalid_arguments");
  }
});

test("records: at most 256 live per server, and cleanup never removes another live server's folder", { skip }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const prev = process.env.HOPTELL_HOME;
  process.env.HOPTELL_HOME = path.join(w.home, "cap");
  t.after(() => (prev === undefined ? delete process.env.HOPTELL_HOME : (process.env.HOPTELL_HOME = prev)));
  const { RecordStore, MAX_RECORDS } = await import("../lib/records.js");
  const a = new RecordStore();
  const fields = () => ({ owner_peer: "sam", review_request_id: crypto.randomUUID(), root_id: "app", root_identity: `sha256:${"0".repeat(64)}`, path: "a.js", sha256: `sha256:${"1".repeat(64)}`, bytes: 1, to: "alex" });
  for (let i = 0; i < MAX_RECORDS; i++) a.prepare(fields());
  assert.throws(() => a.prepare(fields()), (e) => e.code === "storage_full");

  const b = new RecordStore();
  b.dir(); // a live server with no records yet
  a.cleanup();
  assert.ok(fs.existsSync(path.join(process.env.HOPTELL_HOME, "snapshots", b.session)), "another live server's empty folder stays");
  b.prepare(fields());
});

test("settings ids: full-string checks reject trailing line breaks", () => {
  for (const id of ["app\n", "app\r", "app\u2028", "app\u2029", "\napp"]) {
    assert.throws(() => parseRoots(JSON.stringify([{ id, path: "/x" }])), (e) => e.code === "invalid_config", JSON.stringify(id));
  }
});
