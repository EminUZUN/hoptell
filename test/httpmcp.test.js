// MCP over HTTP on 127.0.0.1 (lib/httpmcp.js): browser defenses, client tokens, session binding,
// one engine per session, and sessions of removed clients ending.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { addClient, removeClient, startMcpHttp } from "../lib/httpmcp.js";
import { httpSessions, serveEngine } from "../lib/mcp.js";
import { currentBoot, hostKey, processInfo } from "../lib/host.js";
import { RelayClient } from "../lib/client.js";
import { hostOfRegistration } from "../lib/wake.js";
import { TOKEN, sleep, world } from "./helpers.js";

/** A SessionStart registration as wake.js writes it, for `host` ({pid, start, uid, boot}). */
const register = (home, host, id, extra = {}) => {
  const wake = path.join(home, "wake");
  fs.mkdirSync(wake, { recursive: true, mode: 0o700 });
  const key = extra.key ?? hostKey(host);
  fs.writeFileSync(path.join(wake, `${extra.file ?? key}.reg.json`), JSON.stringify({ v: 1, key, host, http_reg: id, at: Date.now() }), { mode: 0o600 });
};
const thisHost = () => {
  const me = processInfo(process.pid);
  return { pid: process.pid, start: me.start, uid: me.uid, boot: currentBoot() };
};

// The server as `hoptell mcp-http` runs it (lib/mcp.js httpSessions), in a test world. `env`
// adds to the world's settings (the server's own environment).
async function setup(t, { env = {}, ...options } = {}) {
  const w = await world();
  t.after(() => w.close());
  const hosts = []; // the host each session's engine was given (hook registration)
  const sessions = httpSessions({ env: { ...w.env, ...env }, homedir: w.home, cwd: w.home, pid: process.pid, hostname: "testhost" });
  const engineFor = (client, o = {}) => (hosts.push(o.host ?? null), sessions(client, o));
  const h = await startMcpHttp({ home: w.home, port: 0, engineFor, serve: (e, tr, o) => serveEngine(e, tr, { front: "http", ...o }), hostOf: (id) => hostOfRegistration(w.home, id), ...options });
  t.after(() => h.close());
  const base = `http://127.0.0.1:${h.port}/mcp`;
  const connect = async (token, extraHeaders = {}) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer ${token}`, ...extraHeaders } } });
    await client.connect(transport);
    t.after(() => client.close().catch(() => {}));
    return { client, transport };
  };
  return { w, h, base, connect, hosts };
}
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } });

test("browser defenses and client tokens come before any MCP processing", async (t) => {
  const { w, h, base } = await setup(t);
  const { token } = await addClient(w.home, "editor", { name: "alice-ed" });
  const post = (headers, body = init, url = base) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });
  assert.equal((await post({})).status, 401, "no token");
  assert.equal((await post({ authorization: "Bearer wrong-token-wrong-token-wrong" })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${token}`, origin: "https://evil.example" })).status, 403, "any Origin is refused");
  // DNS rebinding: a page on evil.example resolved to 127.0.0.1 sends Host: evil.example (fetch cannot set Host).
  const rebound = await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: h.port, path: "/mcp", method: "POST", headers: { host: `evil.example:${h.port}`, "content-type": "application/json", authorization: `Bearer ${token}` } }, (res) => resolve(res.statusCode));
    r.end(init);
  });
  assert.equal(rebound, 403, "DNS rebinding: wrong Host");
  assert.equal((await fetch(base, { method: "OPTIONS" })).status, 405);
  assert.equal((await post({ authorization: `Bearer ${token}` }, init, base.replace("/mcp", "/other"))).status, 404);
  assert.equal((await post({ authorization: `Bearer ${token}`, "content-type": "text/plain" })).status, 415);
  assert.equal((await post({ authorization: `Bearer ${token}` }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status, 400, "a session starts with initialize");
  const ok = await post({ authorization: `Bearer ${token}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), null, "no CORS headers");
});

test("one engine per session: two clients talk; a session belongs to its client; DELETE ends it", async (t) => {
  const { w, h, connect } = await setup(t);
  const a = await addClient(w.home, "a", { name: "alice-http" });
  const b = await addClient(w.home, "b", { name: "bob-http" });
  const alice = await connect(a.token);
  const bob = await connect(b.token);
  assert.equal(h.sessions().length, 2);
  const text = (r) => r.content[0].text;
  let peers = "";
  for (let i = 0; i < 50 && !/bob-http/.test(peers); i++, await sleep(100)) peers = text(await alice.client.callTool({ name: "list_peers", arguments: {} }));
  assert.match(peers, /bob-http/);
  await alice.client.callTool({ name: "send_message", arguments: { to: "bob-http", message: "over http" } });
  let got = "";
  for (let i = 0; i < 50 && !/over http/.test(got); i++, await sleep(100)) got = text(await bob.client.callTool({ name: "read_inbox", arguments: {} }));
  assert.match(got, /over http/);
  // Bob's token with Alice's session: not found (sessions are not shared between clients).
  const stolen = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${b.token}`, "mcp-session-id": alice.transport.sessionId }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
  assert.equal(stolen.status, 404);
  await alice.transport.terminateSession();
  for (let i = 0; i < 50 && h.sessions().length !== 1; i++) await sleep(50);
  assert.deepEqual(h.sessions().map((s) => s.client), ["b"]);
});

test("a removed client's sessions end; its token stops working", async (t) => {
  const { w, h, connect } = await setup(t, { sweepMs: 100 });
  const c = await addClient(w.home, "gone", { name: "gone-http" });
  await connect(c.token);
  assert.equal(h.sessions().length, 1);
  await removeClient(w.home, "gone");
  for (let i = 0; i < 50 && h.sessions().length; i++) await sleep(50);
  assert.equal(h.sessions().length, 0);
  await assert.rejects(connect(c.token));
});

test("hook registration (option B): bound to one session, only for a live process of this account", async (t) => {
  const { w, h, connect, hosts } = await setup(t);
  const c = await addClient(w.home, "claude", { name: "alice-hook" });
  // A SessionStart registration naming this (live) process, and one naming a process that ended.
  const live = crypto.randomBytes(16).toString("hex");
  const dead = crypto.randomBytes(16).toString("hex");
  register(w.home, thisHost(), live);
  register(w.home, { ...thisHost(), pid: 999_999, start: "gone" }, dead);
  await connect(c.token, { "x-hoptell-hook-registration": live });
  await connect(c.token, { "x-hoptell-hook-registration": live }); // the same id again: refused for this one
  await connect(c.token, { "x-hoptell-hook-registration": dead });
  await connect(c.token);
  assert.deepEqual(h.sessions().map((s) => s.hook), ["registered", "in use by another session", "not found or ended", "none"]);
  assert.equal(hosts[0]?.pid, process.pid, "the first session's engine got the registered host");
  assert.deepEqual(hosts.slice(1), [null, null, null]);
});

const rawInit = (port, token, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers }, body: init });

test("quotas: simultaneous initializations cannot exceed the session limits; streams, calls and waits are limited", async (t) => {
  // A slow engine start keeps all initializations in progress at once.
  const { w, h, connect } = await setup(t, { limits: { sessionsPerClient: 2, sessions: 3, callsPerSession: 2, streamsPerSession: 1, waitsPerSession: 1 } });
  const a = await addClient(w.home, "a", { name: "alice-q" });
  const b = await addClient(w.home, "b", { name: "bob-q" });
  const statuses = (await Promise.all([1, 2, 3, 4].map(() => rawInit(h.port, a.token)))).map((r) => (r.body?.cancel(), r.status));
  assert.deepEqual(statuses.toSorted(), [200, 200, 429, 429], "two per client, even when they start together");
  const more = (await Promise.all([1, 2].map(() => rawInit(h.port, b.token)))).map((r) => (r.body?.cancel(), r.status));
  assert.deepEqual(more.toSorted(), [200, 429], "three in all");
  for (let i = 0; i < 50 && h.sessions().length !== 3; i++) await sleep(20);
  assert.equal(h.sessions().length, 3);
  for (const s of h.sessions()) await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${s.client === "a" ? a.token : b.token}`, "mcp-session-id": s.id, "mcp-protocol-version": "2025-06-18" } });
  for (let i = 0; i < 50 && h.sessions().length; i++) await sleep(20);
  // Per session: one stream, one wait, two calls.
  const { client, transport } = await connect(a.token);
  const sid = transport.sessionId;
  const hdr = { authorization: `Bearer ${a.token}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" };
  const get = () => fetch(`http://127.0.0.1:${h.port}/mcp`, { headers: { ...hdr, accept: "text/event-stream" } });
  const second = await get(); // the SDK client already holds the session's one stream
  assert.equal(second.status, 429);
  const call = (name, args, id) => fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { ...hdr, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
  const w1 = client.callTool({ name: "wait_for_message", arguments: { timeout_seconds: 3 } });
  await sleep(200);
  assert.equal((await call("wait_for_message", { timeout_seconds: 1 }, 77)).status, 429, "one wait per session");
  const r2 = await call("list_peers", {}, 78);
  assert.equal(r2.status, 200, "the second call fits");
  const batch = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { ...hdr, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify([1, 2].map((id) => ({ jsonrpc: "2.0", id: 80 + id, method: "tools/call", params: { name: "list_peers", arguments: {} } }))) });
  assert.equal(batch.status, 429, "calls in progress are counted, batches included");
  await r2.text();
  await w1;
});

test("an idle session expires (404 afterwards); an engine start or connect that fails leaves nothing running", async (t) => {
  const { w, h, connect } = await setup(t, { idleMs: 200, sweepMs: 50 });
  const c = await addClient(w.home, "idle", { name: "idle-http" });
  const { transport } = await connect(c.token);
  const sid = transport.sessionId;
  await transport.close(); // no stream, no requests
  for (let i = 0; i < 60 && h.sessions().length; i++) await sleep(50);
  assert.equal(h.sessions().length, 0);
  const r = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${c.token}`, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.equal(r.status, 404);

  // Failures during initialize: the engine that was created is stopped, and no session remains.
  const w2 = await world();
  t.after(() => w2.close());
  const stopped = [];
  const engine = () => ({ stop: async () => stopped.push(1) });
  const failing = [
    { engineFor: async () => { throw new Error("no relay"); }, serve: async () => () => {} },
    { engineFor: async () => engine(), serve: async () => { throw new Error("connect failed"); } },
  ];
  const k = await addClient(w2.home, "k");
  for (const f of failing) {
    const hh = await startMcpHttp({ home: w2.home, port: 0, ...f });
    t.after(() => hh.close());
    const res = await rawInit(hh.port, k.token);
    assert.equal(res.status, 500);
    assert.equal(hh.sessions().length, 0);
  }
  assert.equal(stopped.length, 1, "the engine of the failed connect was stopped");
});

test("removing a client ends its pending wait with an answer; a long wait is not idleness", async (t) => {
  const { w, h, connect } = await setup(t, { sweepMs: 100, idleMs: 300 });
  const c = await addClient(w.home, "rm", { name: "rm-http" });
  const { client } = await connect(c.token);
  const wait = client.callTool({ name: "wait_for_message", arguments: { timeout_seconds: 60 } }).then(() => "returned", () => "ended");
  await sleep(700); // longer than idleMs: the wait keeps the session
  assert.equal(h.sessions().length, 1, "a session with a call in progress is not idle");
  const t0 = Date.now();
  await removeClient(w.home, "rm");
  const outcome = await wait;
  assert.equal(outcome, "returned", "the wait answers (no messages) instead of hanging until the client gives up");
  assert.ok(Date.now() - t0 < 2000, "it ends with the session");
  for (let i = 0; i < 50 && h.sessions().length; i++) await sleep(50);
  assert.equal(h.sessions().length, 0);
});

test("simultaneous initializations with one hook registration: only one gets it", async (t) => {
  const { w, h, hosts } = await setup(t);
  const c = await addClient(w.home, "claude2", { name: "alice-hook2" });
  const id = crypto.randomBytes(16).toString("hex");
  register(w.home, thisHost(), id);
  const rs = await Promise.all([1, 2, 3].map(() => rawInit(h.port, c.token, { "x-hoptell-hook-registration": id })));
  for (const r of rs) await r.body?.cancel();
  for (let i = 0; i < 50 && h.sessions().length !== 3; i++) await sleep(20);
  assert.deepEqual(h.sessions().map((s) => s.hook).toSorted(), ["in use by another session", "in use by another session", "registered"]);
  assert.equal(hosts.filter(Boolean).length, 1);
});

test("without a registration an HTTP session never uses channel notices (automatic delivery)", async (t) => {
  const { w, connect } = await setup(t, { env: { HOPTELL_PUSH: "" } });
  const c = await addClient(w.home, "plain", { name: "plain-http" });
  const { client } = await connect(c.token);
  assert.doesNotMatch(client.getInstructions() ?? "", /channel/i);
  const peers = (await client.callTool({ name: "list_peers", arguments: {} })).content[0].text;
  assert.doesNotMatch(peers, /delivery: channel/);
});

// A tool call whose response the client never receives: the request is sent, then the connection
// is dropped (no MCP cancellation).
const droppedCall = (port, token, sid, name, args = {}, id = 900) =>
  new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18", "content-length": Buffer.byteLength(body) } });
    r.on("error", () => {});
    r.end(body, () => setTimeout(() => (r.destroy(), resolve()), 50));
  });
const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("a read whose response is lost keeps its messages: protocol 1 and receipts off too", async (t) => {
  for (const env of [{ HOPTELL_RECEIPTS: "off" }, { HOPTELL_PROTOCOL: "1" }, { HOPTELL_RECEIPTS: "on" }]) {
    const { w, h, connect } = await setup(t, { env });
    const c = await addClient(w.home, "reader", { name: "reader-http" });
    const { client, transport } = await connect(c.token);
    await client.callTool({ name: "list_peers", arguments: {} }); // connected
    const sender = new RelayClient({ url: `ws://127.0.0.1:${w.relay.port}`, token: TOKEN, name: "sender-x", mode: "send", reconnect: false });
    t.after(() => sender.close());
    await sender.start().ready(5000);
    await sender.send("reader-http", `kept ${JSON.stringify(env)}`);
    await sleep(300);
    await droppedCall(h.port, c.token, transport.sessionId, "read_inbox");
    await sleep(300); // the dropped read has run
    const again = textOf(await client.callTool({ name: "read_inbox", arguments: {} }));
    assert.match(again, /kept/, `${JSON.stringify(env)}: the message is shown again`);
    assert.match(again, /Receipt: /, "with a receipt to acknowledge it");
  }
});

test("a dropped connection neither frees the call quota nor makes the session idle", async (t) => {
  const { w, h, connect } = await setup(t, { idleMs: 200, sweepMs: 50 });
  const c = await addClient(w.home, "q", { name: "q-http" });
  const { transport } = await connect(c.token);
  const sid = transport.sessionId;
  await transport.close(); // no stream of its own: only the call keeps the session busy
  await droppedCall(h.port, c.token, sid, "wait_for_message", { timeout_seconds: 2 }, 901);
  // A barrier, not a delay: the second call goes only once the server holds the first one.
  for (let i = 0; i < 200 && h.sessions()[0]?.calls !== 1; i++) await sleep(10);
  assert.equal(h.sessions()[0]?.calls, 1, "the dropped call is in progress");
  // The first wait's handler still runs: a second one is refused, and the session stays.
  const second = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${c.token}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 902, method: "tools/call", params: { name: "wait_for_message", arguments: { timeout_seconds: 1 } } }) });
  assert.equal(second.status, 429);
  await sleep(600); // past idleMs
  assert.equal(h.sessions().length, 1, "a session with a call in progress is not idle");
  await sleep(2000); // the first wait ends: quota free, and then idleness counts
  // The first wait ends (its 2 s timeout), then idleness counts: polled, so a loaded machine has time.
  for (let i = 0; i < 200 && h.sessions().length; i++) await sleep(50);
  assert.equal(h.sessions().length, 0, "idle once no call is in progress");
});

test("DELETE answers a pending wait before closing; an invalid DELETE leaves the session alone", async (t) => {
  const { w, h, connect } = await setup(t);
  const c = await addClient(w.home, "d", { name: "d-http" });
  const { client, transport } = await connect(c.token);
  const sid = transport.sessionId;
  const del = (headers) => fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${c.token}`, "mcp-session-id": sid, ...headers } });
  assert.equal((await del({ "mcp-protocol-version": "1999-01-01" })).status, 400);
  assert.equal(h.sessions().length, 1, "the session is still there");
  assert.match(textOf(await client.callTool({ name: "list_peers", arguments: {} })), /d-http/);
  const wait = client.callTool({ name: "wait_for_message", arguments: { timeout_seconds: 60 } }).then(() => "answered", () => "failed");
  await sleep(200);
  const t0 = Date.now();
  assert.equal((await del({ "mcp-protocol-version": "2025-06-18" })).status, 200);
  assert.equal(await wait, "answered");
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(h.sessions().length, 0);
});

test("a malformed request target is answered and the server goes on", async (t) => {
  const { w, h, connect } = await setup(t);
  const c = await addClient(w.home, "m", { name: "m-http" });
  const raw = await new Promise((resolve) => {
    const sock = net.connect(h.port, "127.0.0.1", () => sock.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nConnection: close\r\n\r\n`));
    let got = "";
    sock.on("data", (d) => (got += d));
    sock.on("close", () => resolve(got));
    sock.on("error", () => resolve(got));
  });
  assert.match(raw, /^HTTP\/1\.1 4\d\d/);
  await connect(c.token); // still serving
  assert.equal(h.sessions().length, 1);
});

test("client records decide name and roles: unnamed clients get their own automatic names", async (t) => {
  const { w, connect } = await setup(t, { env: { HOPTELL_NAME: "server-default", HOPTELL_ROLES: "server-role" } });
  const a = await addClient(w.home, "a");
  const b = await addClient(w.home, "b");
  const ca = await connect(a.token);
  const cb = await connect(b.token);
  const who = async (cl) => {
    for (let i = 0; i < 50; i++) {
      const m = /you are "([^"]+)"([^\n]*)/i.exec(textOf(await cl.client.callTool({ name: "list_peers", arguments: {} })));
      if (m) return m;
      await sleep(100);
    }
    return null;
  };
  const [na, nb] = [await who(ca), await who(cb)];
  assert.ok(na && nb, "both connected");
  assert.notEqual(na[1], "server-default");
  assert.notEqual(nb[1], "server-default");
  assert.notEqual(na[1], nb[1], "each its own automatic name");
  assert.doesNotMatch(na[2] + nb[2], /server-role/);
});

test("an invalid initialize allocates nothing", async (t) => {
  const engines = [];
  const w = await world();
  t.after(() => w.close());
  const h = await startMcpHttp({ home: w.home, port: 0, engineFor: async () => (engines.push(1), { stop: async () => {} }), serve: async () => async () => {} });
  t.after(() => h.close());
  const c = await addClient(w.home, "i");
  const good = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } };
  const bad = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { ...good, clientInfo: undefined } },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { ...good, protocolVersion: 7 } },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { ...good, capabilities: "none" } },
    { jsonrpc: "2.0", method: "initialize", params: good }, // no id
    { jsonrpc: "2.0", id: { x: 1 }, method: "initialize", params: good },
  ];
  for (const b of bad) {
    const r = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${c.token}` }, body: JSON.stringify(b) });
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal(engines.length, 0);
});

test("channel delivery only for a client that negotiated it", async (t) => {
  // A registered host started with the channel flag; automatic delivery.
  const host = { ...thisHost(), args: "claude --dangerously-load-development-channels server:hoptell" };
  const { w, base } = await setup(t, { env: { HOPTELL_PUSH: "" }, hostOf: () => host });
  const c = await addClient(w.home, "ch", { name: "ch-http" });
  const open = async (capabilities, name) => {
    const client = new Client({ name: "test", version: "0" }, { capabilities });
    const transport = new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer ${c.token}`, "x-hoptell-hook-registration": crypto.randomBytes(16).toString("hex") } } });
    await client.connect(transport);
    t.after(() => client.close().catch(() => {}));
    void name;
    return client;
  };
  const plain = await open({});
  assert.doesNotMatch(plain.getInstructions() ?? "", /channel/i, "not negotiated: no channel");
  await plain.close();
  const negotiated = await open({ experimental: { "claude/channel": {} } });
  assert.match(negotiated.getInstructions() ?? "", /channel/i, "negotiated: channel");
});

test("a registration of another boot, or an id in two records, binds no hooks", async (t) => {
  const { w, h, connect, hosts } = await setup(t);
  const c = await addClient(w.home, "hb", { name: "hb-http" });
  const otherBoot = crypto.randomBytes(16).toString("hex");
  register(w.home, { ...thisHost(), boot: "another-boot" }, otherBoot);
  const twice = crypto.randomBytes(16).toString("hex");
  register(w.home, thisHost(), twice);
  register(w.home, { ...thisHost(), pid: process.ppid, start: processInfo(process.ppid).start }, twice);
  const misnamed = crypto.randomBytes(16).toString("hex");
  register(w.home, thisHost(), misnamed, { key: "f".repeat(32), file: "f".repeat(32) }); // a key that is not this host's
  for (const id of [otherBoot, twice, misnamed]) await connect(c.token, { "x-hoptell-hook-registration": id });
  assert.deepEqual(h.sessions().map((s) => s.hook), ["not found or ended", "not found or ended", "not found or ended"]);
  assert.deepEqual(hosts, [null, null, null]);
});

test("protocol 1: every unnamed session has its own name, also for labels that normalize alike", async (t) => {
  const { w, connect } = await setup(t, { env: { HOPTELL_PROTOCOL: "1" } });
  const long = "x".repeat(60);
  const clients = [await addClient(w.home, "a.b"), await addClient(w.home, "a-b"), await addClient(w.home, `${long}1`), await addClient(w.home, `${long}2`)];
  const sessions = [];
  for (const c of [...clients, clients[0]]) sessions.push(await connect(c.token)); // two sessions of "a.b"
  const names = [];
  for (const s of sessions) {
    let m = null;
    for (let i = 0; i < 50 && !m; i++) {
      m = /you are "([^"]+)"/i.exec(textOf(await s.client.callTool({ name: "list_peers", arguments: {} })));
      if (!m) await sleep(100);
    }
    names.push(m?.[1]);
  }
  assert.equal(new Set(names).size, names.length, `distinct names: ${names.join(", ")}`);
  for (const n of names) assert.ok(n.length <= 64);
  await sleep(500);
  // Nobody displaced anybody: every session still answers as itself.
  for (const [i, s] of sessions.entries()) assert.match(textOf(await s.client.callTool({ name: "list_peers", arguments: {} })), new RegExp(`you are "${names[i]}"`, "i"));
});

test("a registration must name its own file, and uniqueness is proven over every record", async (t) => {
  const { w } = await setup(t);
  const host = thisHost();
  const a = crypto.randomBytes(16).toString("hex");
  const b = crypto.randomBytes(16).toString("hex");
  register(w.home, host, a); // <key>.reg.json for this host, id a
  register(w.home, host, b, { file: "wrong-filename" }); // the same host and key, in another file, id b
  assert.ok(hostOfRegistration(w.home, a), "the correctly named record binds");
  assert.equal(hostOfRegistration(w.home, b), null, "a record in a file not named for its key does not");
  // One id in two valid, correctly named records of two live processes, far apart in a long listing.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-reg-"));
  t.after(() => fs.rmSync(home2, { recursive: true, force: true }));
  const dup = crypto.randomBytes(16).toString("hex");
  register(home2, host, dup);
  assert.ok(hostOfRegistration(home2, dup), "alone it binds");
  for (let i = 0; i < 300; i++) register(home2, { ...host, pid: 900_000 + i }, crypto.randomBytes(16).toString("hex"));
  register(home2, { ...host, pid: process.ppid, start: processInfo(process.ppid).start }, dup);
  assert.equal(hostOfRegistration(home2, dup), null, "twice it is ambiguous");
  // Beyond the bound uniqueness cannot be proven: no binding at all.
  for (let i = 0; i < 1030; i++) register(w.home, { ...host, pid: 800_000 + i }, crypto.randomBytes(16).toString("hex"));
  assert.equal(hostOfRegistration(w.home, a), null);
});

/** The names of `sessions` as they report themselves (list_peers "you are ..."). */
async function namesOf(sessions) {
  const names = [];
  for (const s of sessions) {
    let m = null;
    for (let i = 0; i < 80 && !m; i++) {
      m = /you are "([^"]+)"/i.exec(textOf(await s.client.callTool({ name: "list_peers", arguments: {} })));
      if (!m) await sleep(100);
    }
    names.push(m?.[1] ?? null);
  }
  return names;
}
async function stillThemselves(sessions, names) {
  await sleep(500);
  for (const [i, s] of sessions.entries()) assert.match(textOf(await s.client.callTool({ name: "list_peers", arguments: {} })), new RegExp(`you are "${names[i]}"`, "i"), `session ${i} was not displaced`);
}

test("protocol 1 through a relays file only, with a long name prefix: unnamed sessions stay distinct", async (t) => {
  const w0 = await world();
  t.after(() => w0.close());
  const relaysFile = path.join(w0.home, "relays.json");
  fs.writeFileSync(relaysFile, JSON.stringify({ version: 1, relays: [{ alias: "r", url: `ws://127.0.0.1:${w0.relay.port}`, tokenEnv: "T", namePrefix: "a-rather-long-name-prefix-" }] }), { mode: 0o600 });
  const { w, connect } = await setup(t, { env: { HOPTELL_RELAY: "", HOPTELL_TOKEN: "", T: TOKEN, HOPTELL_RELAYS: relaysFile, HOPTELL_PROTOCOL: "1" } });
  const long = "y".repeat(60);
  const a = await addClient(w.home, `${long}1`);
  const b = await addClient(w.home, `${long}2`);
  const sessions = [await connect(a.token), await connect(b.token), await connect(a.token)];
  const names = await namesOf(sessions);
  assert.ok(names.every(Boolean), `all connected: ${names}`);
  assert.equal(new Set(names).size, 3, `distinct: ${names.join(", ")}`);
  await stillThemselves(sessions, names);
});

test("a protocol-2 session falling back to a protocol-1 relay keeps a name of its own", async (t) => {
  const { WebSocketServer, default: WS } = await import("ws");
  const w0 = await world();
  t.after(() => w0.close());
  // A relay that refuses protocol 2 (4005) and passes protocol-1 connections to a real relay.
  const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => proxy.close());
  await new Promise((r) => proxy.once("listening", r));
  proxy.on("connection", (down) => {
    down.once("message", (first) => {
      if (JSON.parse(first).v === 2) return down.close(4005, "unsupported protocol version");
      const up = new WS(`ws://127.0.0.1:${w0.relay.port}`);
      up.on("open", () => up.send(first.toString()));
      up.on("message", (d) => down.readyState === 1 && down.send(d.toString()));
      down.on("message", (d) => up.readyState === 1 && up.send(d.toString()));
      up.on("close", (c, r) => down.readyState === 1 && down.close(c >= 4000 ? c : 1000, r.toString()));
      down.on("close", () => up.close());
    });
  });
  const { w, connect } = await setup(t, { env: { HOPTELL_RELAY: `ws://127.0.0.1:${proxy.address().port}` } });
  const c = await addClient(w.home, "fb");
  const d = await addClient(w.home, "fb2");
  const sessions = [await connect(c.token), await connect(d.token), await connect(c.token)];
  const names = await namesOf(sessions);
  assert.ok(names.every(Boolean), `all connected: ${names}`);
  assert.equal(new Set(names).size, 3, `distinct: ${names.join(", ")}`);
  await stillThemselves(sessions, names);
});
