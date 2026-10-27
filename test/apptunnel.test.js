// The relay's side of the owner channel's Mini App (design 7.4, sections 2, 3 and 6; tests of
// section 11, "Tunnel" and "Revocation edges" for registration): durable ownership of app ids,
// the forwarded request, the response checks, the fixed headers and the bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { RelayClient } from "../lib/client.js";
import { parseTrustedProxies, startRelay } from "../lib/relay.js";
import { APP_PATH_RE, OWNER_APP_CAP, appsAdmin, readApps } from "../lib/apptunnel.js";
import { sleep } from "./helpers.js";

const REALM = "f".repeat(32);
const ID = { me: "m_mmmmmmmmmmmmmmmmmmmmmmmmmm", bob: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", hanna: "m_hhhhhhhhhhhhhhhhhhhhhhhhhh" };
const tok = (n) => crypto.createHash("sha256").update(`app-token-${n}`).digest("hex");
const HOSTS = [{ id: "h1", token: tok("host-h1") }];
const MEMBERS = [
  { name: "me", id: ID.me, token: tok("me") },
  { name: "bob", id: ID.bob, token: tok("bob") },
  { name: "hanna", id: ID.hanna, custody: "hosted", host: "h1" },
];
const appId = () => [...crypto.randomBytes(26)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");

async function setup(t, { limits = {}, ownerApp = true, token = null, trustedProxies = null, now = undefined } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-app-relay-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const logs = [];
  const start = () => startRelay({ host: "127.0.0.1", port: 0, token, members: MEMBERS, hosts: HOSTS, realm: { id: REALM }, ownerApp: ownerApp ? { stateDir, limits: { timeoutMs: 1500, ...limits }, now } : null, trustedProxies, log: (...a) => logs.push(a.join(" ")), sweepMs: 100_000 });
  let relay = await start();
  t.after(() => relay.close());
  const clients = [];
  t.after(() => clients.forEach((c) => c.close()));
  const s = {
    stateDir,
    logs,
    get relay() {
      return relay;
    },
    base: () => `http://127.0.0.1:${relay.port}`,
    async open(o) {
      const c = new RelayClient({ url: `ws://127.0.0.1:${relay.port}`, reconnect: false, ...o });
      clients.push(c);
      c.reqs = [];
      c.answer = (m) => ({ status: 200, mime: "text/html", body: `page ${m.path}` });
      c.on("app_req", (m) => {
        c.reqs.push(m);
        const r = c.answer(m);
        if (r) c.frame({ type: "app_res", rid: m.rid, ...r });
      });
      await c.start().ready(5000);
      return c;
    },
    bridge: (name = "me-owner", who = "me") => s.open({ token: tok(who), name }),
    register: (c, app, extra = {}) => c.rpc({ type: "app_register", app, ...extra }).then((r) => ({ ok: true, state: r.state }), (e) => ({ ok: false, code: e.code })),
    async restart() {
      for (const c of clients.splice(0)) c.close();
      await relay.close();
      relay = await start();
    },
  };
  return s;
}

/** A plain HTTP request to the relay: {status, headers, body}. */
function request(base, p, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers: { ...(body !== null ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const post = (base, p, obj, headers = {}) => request(base, p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof obj === "string" ? obj : JSON.stringify(obj) });

const FIXED = ["content-type", "content-length", "content-security-policy", "cache-control", "x-content-type-options", "referrer-policy", "cross-origin-opener-policy"];

test("relay: without HOPTELL_OWNER_APP there is no owner_app capability and /app/ answers 426 as before", async (t) => {
  const s = await setup(t, { ownerApp: false });
  const c = await s.bridge();
  assert.ok(!c.caps.includes(OWNER_APP_CAP));
  const r = await request(s.base(), `/app/${appId()}/`);
  assert.equal(r.status, 426);
  await assert.rejects(c.rpc({ type: "app_register", app: appId() }));
});

test("relay: a registered app is served through the bridge; the forwarded request carries only the listed fields", async (t) => {
  const s = await setup(t);
  const c = await s.bridge();
  assert.ok(c.caps.includes(OWNER_APP_CAP));
  const id = appId();
  assert.deepEqual(await s.register(c, id), { ok: true, state: "on" });
  const r = await request(s.base(), `/app/${id}/?tgWebAppStartParam=x`, { headers: { cookie: "a=b", "x-other": "1", origin: "https://example.test", authorization: "Bearer zzz" } });
  assert.equal(r.status, 200);
  assert.equal(r.body, "page ");
  const m = c.reqs.at(-1);
  assert.deepEqual(Object.keys(m).sort(), ["app", "auth", "body", "client", "ctype", "method", "origin", "path", "rid", "ttl_ms", "type"].sort());
  assert.equal(m.method, "GET");
  assert.equal(m.path, "");
  assert.equal(m.origin, "https://example.test");
  assert.equal(m.auth, "Bearer zzz");
  assert.equal(m.client, "127.0.0.1");
  assert.ok(m.ttl_ms > 0 && m.ttl_ms <= 1500);
  assert.ok(!JSON.stringify(m).includes("a=b"), "no cookie");
  // The fixed header set, and nothing from the bridge.
  for (const h of FIXED) assert.ok(r.headers[h], h);
  assert.match(r.headers["content-security-policy"], /default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
  // Hashed files are immutable; the API is never cached; a bridge's extra fields change nothing.
  c.answer = () => ({ status: 200, mime: "text/javascript", body: "x", headers: { "set-cookie": "evil=1" }, "cache-control": "public" });
  const js = await request(s.base(), `/app/${id}/app.0123456789abcdef.js`);
  assert.equal(js.headers["cache-control"], "max-age=31536000, immutable");
  assert.equal(js.headers["set-cookie"], undefined);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  c.answer = () => ({ status: 200, mime: "application/json", body: "{}" });
  const api = await post(s.base(), `/app/${id}/api/session`, { init_data: "x" }, { origin: "https://h" });
  assert.equal(api.headers["cache-control"], "no-store");
  assert.equal(c.reqs.at(-1).body, JSON.stringify({ init_data: "x" }));
  assert.equal(c.reqs.at(-1).ctype, "application/json");
});

test("relay: unknown, off and retired ids answer 404; an owned id whose bridge is offline 503; a slow bridge 504", async (t) => {
  const s = await setup(t, { limits: { timeoutMs: 400 } });
  assert.equal((await request(s.base(), `/app/${appId()}/`)).status, 404);
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  c.answer = () => null; // never answers
  const slow = await request(s.base(), `/app/${id}/`);
  assert.equal(slow.status, 504);
  assert.deepEqual(JSON.parse(slow.body), { error: "slow" });
  c.close();
  await sleep(100);
  const off = await request(s.base(), `/app/${id}/`);
  assert.equal(off.status, 503);
  assert.deepEqual(JSON.parse(off.body), { error: "offline" });
  const c2 = await s.bridge();
  assert.equal((await c2.rpc({ type: "app_unregister", app: id })).state, "off");
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 404);
  appsAdmin.retire(s.stateDir, id.slice(0, 8));
  assert.equal(readApps(s.stateDir).apps[id].state, "retired");
});

test("relay: the browser opening the app gets a short page for 404, 429, 503 and 504; the app's own requests keep JSON", async (t) => {
  const s = await setup(t, { limits: { timeoutMs: 400, perClient: { max: 5, ms: 60_000 } } });
  const html = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  const page = (r, status, title) => {
    assert.equal(r.status, status);
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(r.body, new RegExp(`<h1>${title.replace(/[.?]/g, "\\$&")}</h1>`));
  };
  page(await request(s.base(), `/app/${appId()}/`, { headers: html }), 404, "This app link isn't available.");
  assert.match((await request(s.base(), `/app/${appId()}/`, { headers: html })).body, /<p>Send \/app in the bot chat to check the current link\.<\/p>/);
  page(await request(s.base(), `/app/${appId()}/`, { headers: { "sec-fetch-dest": "document" } }), 404, "This app link isn't available.");
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  c.answer = () => null; // never answers
  page(await request(s.base(), `/app/${id}/`, { headers: html }), 504, "The app is unavailable right now.");
  // An API call or a file the page's script fetches: JSON as before.
  const api = await request(s.base(), `/app/${id}/api/sessions`, { headers: html });
  assert.deepEqual([api.status, JSON.parse(api.body)], [504, { error: "slow" }]);
  // The bridge goes away while the page request waits for it: the page too, not JSON.
  const forwarded = c.reqs.length;
  const waiting = request(s.base(), `/app/${id}/`, { headers: html });
  for (let i = 0; i < 100 && c.reqs.length === forwarded; i++) await sleep(20);
  assert.equal(c.reqs.length, forwarded + 1, "forwarded to the bridge");
  c.close();
  page(await waiting, 503, "The app is unavailable right now.");
  await sleep(100);
  page(await request(s.base(), `/app/${id}/`, { headers: html }), 503, "The app is unavailable right now.");
  assert.deepEqual(JSON.parse((await request(s.base(), `/app/${id}/app.js`)).body), { error: "offline" });
  page(await request(s.base(), `/app/${id}/`, { headers: html }), 429, "Too many attempts.");
  assert.match((await request(s.base(), `/app/${id}/`, { headers: html })).body, /<p>Wait a minute, then open the app again\.<\/p>/);
});

test("relay: the path grammar, the body bound, the JSON content type and WebSocket upgrades on /app/", async (t) => {
  const s = await setup(t);
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  for (const p of ["..", ".", "a//b", "%2e%2e", "%2E", "Index.html", "index.", "a/../b", "a/./b", "/x", "a/", `${"a".repeat(129)}`]) {
    const r = await request(s.base(), `/app/${id}/${p}`);
    assert.equal(r.status, 404, p);
  }
  for (const p of ["", "index.html", "app.3f9c0a1b2c3d4e5f.js", "tg.0123456789abcdef.js", "api/session", "api/session/abcdefghij", "api/questions/show"]) assert.ok(APP_PATH_RE.test(p), p);
  const n = c.reqs.length;
  assert.equal((await post(s.base(), `/app/${id}/api/session`, "x".repeat(16 * 1024 + 1))).status, 413);
  assert.equal((await post(s.base(), `/app/${id}/api/session`, "{}", { "content-type": "application/json; charset=utf-8" })).status, 415);
  assert.equal((await post(s.base(), `/app/${id}/api/session`, "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(s.base(), `/app/${id}/index.html`, "{}")).status, 405);
  assert.equal((await request(s.base(), `/app/${id}/`, { method: "PUT" })).status, 405);
  assert.equal(c.reqs.length, n, "none of these reached the bridge");
  const upgrade = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.relay.port}/app/${id}/`);
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("error", () => resolve("error"));
    ws.on("open", () => resolve("open"));
  });
  assert.equal(upgrade, 400);
});

test("relay: bad bridge answers are 502 or ignored, and the bridge's connection stays open", async (t) => {
  const s = await setup(t, { limits: { timeoutMs: 400, resBodyMax: 1000 } });
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  c.answer = () => ({ status: 200, mime: "image/svg+xml", body: "<svg/>" });
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 502);
  c.answer = () => ({ status: 200, mime: "text/html", body: "x".repeat(1001) });
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 502);
  c.answer = () => ({ status: 99, mime: "text/html", body: "x" });
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 502);
  assert.equal(c.connected, true);
  // Twice for one rid: the first counts.
  c.answer = (m) => {
    c.frame({ type: "app_res", rid: m.rid, status: 200, mime: "text/html", body: "first" });
    return { status: 200, mime: "text/html", body: "second" };
  };
  assert.equal((await request(s.base(), `/app/${id}/`)).body, "first");
  // From another connection (another member's, or the same bridge's other session): ignored.
  const other = await s.open({ token: tok("bob"), name: "bob-x" });
  c.answer = (m) => {
    other.frame({ type: "app_res", rid: m.rid, status: 200, mime: "text/html", body: "forged" });
    return null;
  };
  const r = await request(s.base(), `/app/${id}/`);
  assert.equal(r.status, 504);
  assert.equal(c.connected, true);
});

test("relay: an answer from an earlier connection of the same bridge is ignored after it registered again", async (t) => {
  const s = await setup(t, { limits: { timeoutMs: 400 } });
  const c1 = await s.bridge("me-owner");
  const id = appId();
  await s.register(c1, id);
  let rid = null;
  c1.answer = (m) => ((rid = m.rid), null);
  const pending = request(s.base(), `/app/${id}/`);
  await until(() => rid);
  // The same bridge registers the id again (a new generation): the old rid's answer no longer counts.
  await s.register(c1, id);
  c1.frame({ type: "app_res", rid, status: 200, mime: "text/html", body: "late" });
  const r = await pending;
  assert.notEqual(r.body, "late");
});

test("relay: registration only from a member-token peer holding its name; the id's owner is kept for good", async (t) => {
  const s = await setup(t, { token: tok("shared") });
  const id = appId();
  // The shared token, a send-only connection and a hosted connection: refused.
  const shared = await s.open({ token: tok("shared"), name: "me-owner2" });
  assert.equal((await s.register(shared, id)).code, "not_allowed");
  const sendOnly = await s.open({ token: tok("me"), name: "me-cli", mode: "send" });
  assert.equal((await s.register(sendOnly, id)).code, "not_allowed");
  const hosted = await s.open({ token: tok("host-h1"), hostMember: ID.hanna, name: "hanna" });
  assert.equal((await s.register(hosted, id)).code, "not_allowed");
  assert.equal(readApps(s.stateDir).apps[id], undefined);
  // The bridge binds it; another member, or the same member under another name, cannot take it.
  const c = await s.bridge();
  assert.ok((await s.register(c, id)).ok);
  const bob = await s.open({ token: tok("bob"), name: "bob-owner" });
  assert.equal((await s.register(bob, id)).code, "app_id_taken");
  const other = await s.open({ token: tok("me"), name: "me-other" });
  assert.equal((await s.register(other, id)).code, "app_id_taken");
  // Off: still owned. After a relay restart: still owned.
  await c.rpc({ type: "app_unregister", app: id });
  assert.equal((await s.register(bob, id)).code, "app_id_taken");
  await s.restart();
  const bob2 = await s.open({ token: tok("bob"), name: "bob-owner" });
  assert.equal((await s.register(bob2, id)).code, "app_id_taken");
  const c2 = await s.bridge();
  assert.deepEqual(await s.register(c2, id), { ok: true, state: "on" });
  // A rotation retires the old id: nobody, not even its owner, can register it again.
  const id2 = appId();
  assert.ok((await s.register(c2, id2, { retire: [id] })).ok);
  assert.equal(readApps(s.stateDir).apps[id].state, "retired");
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 404);
  assert.equal((await s.register(c2, id)).code, "app_id_taken");
  assert.equal((await s.register(bob2, id)).code, "app_id_taken");
  // The operator's --retire makes a tombstone too; only --purge frees an id (the stated case).
  await s.relay.close();
  appsAdmin.retire(s.stateDir, id2.slice(0, 6));
  appsAdmin.purge(s.stateDir, id.slice(0, 6));
  await s.restart();
  const bob3 = await s.open({ token: tok("bob"), name: "bob-owner" });
  assert.equal((await s.register(bob3, id2)).code, "app_id_taken");
  assert.ok((await s.register(bob3, id)).ok, "a purged id is free for anyone");
});

test("relay: at most 10 ids per member (on or off) and 10 new ids a day", async (t) => {
  const s = await setup(t, { limits: { idsPerMember: 2, newIdsPerDay: 3 } });
  const c = await s.bridge();
  const [a, b, x, y] = [appId(), appId(), appId(), appId()];
  assert.ok((await s.register(c, a)).ok);
  assert.ok((await s.register(c, b)).ok);
  assert.equal((await s.register(c, x)).code, "app_limit");
  // Retired ids are not counted, but new ids per day are.
  assert.ok((await s.register(c, x, { retire: [a] })).ok);
  assert.equal((await s.register(c, y, { retire: [b] })).code, "app_limit");
});

test("relay: open requests are bounded per app and in all; requests per client address are limited", async (t) => {
  const s = await setup(t, { limits: { perApp: 2, timeoutMs: 600, perClient: { max: 6, ms: 60_000 }, sessionPerClient: { max: 1, ms: 60_000 } } });
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  c.answer = () => null;
  const slow = [request(s.base(), `/app/${id}/`), request(s.base(), `/app/${id}/`)];
  await until(() => c.reqs.length === 2);
  const third = await request(s.base(), `/app/${id}/`);
  assert.equal(third.status, 503);
  assert.deepEqual(JSON.parse(third.body), { error: "busy" });
  await Promise.all(slow);
  c.answer = () => ({ status: 200, mime: "application/json", body: "{}" });
  assert.equal((await post(s.base(), `/app/${id}/api/session`, {})).status, 200);
  assert.equal((await post(s.base(), `/app/${id}/api/session`, {})).status, 429);
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 200);
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 429);
});

test("relay: the log names an app id's first characters, the status and the duration, never a body or a token", async (t) => {
  const s = await setup(t);
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  c.answer = () => ({ status: 200, mime: "application/json", body: '{"token":"secret-token"}' });
  await post(s.base(), `/app/${id}/api/session`, { init_data: "user=secret-init" }, { authorization: "Bearer secret-bearer" });
  const line = s.logs.find((l) => l.includes(`app ${id.slice(0, 6)}`));
  assert.match(line, /POST 200 \d+ms/);
  for (const l of s.logs) assert.ok(!l.includes("secret") && !l.includes(id), l);
});

async function until(fn, ms = 2000) {
  for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20);
  return fn();
}

/** A POST whose body is announced but not (yet) sent: {req, done (the answer), finish(rest)}. */
function heldPost(base, p, announced = 100) {
  const u = new URL(base);
  let req;
  const done = new Promise((resolve) => {
    req = http.request({ host: u.hostname, port: u.port, method: "POST", path: p, headers: { "content-type": "application/json", "content-length": announced } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (e) => resolve({ status: "error", error: e.message }));
    req.write("{");
  });
  return { req, done, finish: (rest) => req.end(rest) };
}

test("relay: a request holds its slot and its deadline from arrival, also while its body is still coming", async (t) => {
  const s = await setup(t, { limits: { perApp: 2, timeoutMs: 800 } });
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  c.answer = () => ({ status: 200, mime: "application/json", body: "{}" });
  const a = heldPost(s.base(), `/app/${id}/api/session`, 2);
  const b = heldPost(s.base(), `/app/${id}/api/session`, 100);
  await sleep(150);
  const third = await post(s.base(), `/app/${id}/api/sessions`, {});
  assert.equal(third.status, 503, "both slots are taken by unfinished bodies");
  assert.deepEqual(JSON.parse(third.body), { error: "busy" });
  // A body finished later is forwarded with the time that is left, not a fresh 10 seconds.
  await sleep(250);
  a.finish("}");
  assert.equal((await a.done).status, 200);
  assert.ok(c.reqs.at(-1).ttl_ms <= 800 - 350, `ttl_ms ${c.reqs.at(-1).ttl_ms}`);
  // One that never finishes ends at the deadline, and its slot is free again.
  const rb = await b.done;
  assert.ok(rb.status === 504 || rb.status === "error", String(rb.status));
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 200);
});

test("relay: errors are never cached, also for a hashed file", async (t) => {
  const s = await setup(t, { limits: { timeoutMs: 300 } });
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  const file = `/app/${id}/app.0123456789abcdef.js`;
  c.answer = () => ({ status: 404, mime: "application/json", body: "{}" });
  assert.equal((await request(s.base(), file)).headers["cache-control"], "no-store");
  c.answer = () => null;
  const slow = await request(s.base(), file);
  assert.equal(slow.status, 504);
  assert.equal(slow.headers["cache-control"], "no-store");
  c.close();
  await sleep(100);
  const off = await request(s.base(), file);
  assert.equal(off.status, 503);
  assert.equal(off.headers["cache-control"], "no-store");
});

test("relay: a bridge that gives its name back (socket still open) no longer serves its app or answers", async (t) => {
  const s = await setup(t, { limits: { timeoutMs: 400 } });
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  let rid = null;
  c.answer = (m) => ((rid = m.rid), null);
  const pending = request(s.base(), `/app/${id}/`);
  await until(() => rid);
  c.ws.send(JSON.stringify({ type: "release" }));
  await sleep(100);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.frame({ type: "app_res", rid, status: 200, mime: "text/html", body: "after release" });
  const r = await pending;
  assert.notEqual(r.body, "after release");
  assert.equal(r.status, 503);
  const n = c.reqs.length;
  assert.equal((await request(s.base(), `/app/${id}/`)).status, 503);
  assert.equal(c.reqs.length, n, "nothing is forwarded to it");
});

test("relay: apps.json is bounded (a new id past the bound is refused, nothing is pruned); id lists are all or nothing", async (t) => {
  const s = await setup(t, { limits: { entriesMax: 3 } });
  const c = await s.bridge();
  const [a, b, x, y] = [appId(), appId(), appId(), appId()];
  for (const id of [a, b, x]) assert.ok((await s.register(c, id)).ok);
  assert.equal((await s.register(c, y, { retire: [a] })).code, "app_limit");
  assert.equal(readApps(s.stateDir).apps[a].state, "retired", "the retire list still applied");
  assert.equal(Object.keys(readApps(s.stateDir).apps).length, 3);
  // A malformed list changes nothing, also the valid part before it.
  assert.equal((await s.register(c, x, { retire: [b], off: ["NOT-AN-ID"] })).code, "bad_request");
  assert.equal(readApps(s.stateDir).apps[b].state, "on");
  assert.equal((await request(s.base(), `/app/${b}/`)).status, 200);
  await s.restart();
  assert.equal(Object.keys(readApps(s.stateDir).apps).length, 3);
});

test("relay: rate counters of quiet client addresses are swept; new addresses past the bound are refused, live counters kept", async (t) => {
  const clock = { skew: 0 };
  const s = await setup(t, { trustedProxies: parseTrustedProxies("127.0.0.1"), now: () => Date.now() + clock.skew, limits: { clientsMax: 2, perClient: { max: 2, ms: 60_000 } } });
  const c = await s.bridge();
  const id = appId();
  await s.register(c, id);
  const from = (ip) => request(s.base(), `/app/${id}/`, { headers: { "x-forwarded-for": ip } });
  assert.equal((await from("10.0.0.1")).status, 200);
  assert.equal((await from("10.0.0.2")).status, 200);
  assert.equal((await from("10.0.0.3")).status, 429, "a third address while two counters are live");
  assert.equal((await from("10.0.0.1")).status, 200);
  assert.equal((await from("10.0.0.1")).status, 429, "its own limit still counts");
  clock.skew += 61_000;
  assert.equal((await from("10.0.0.3")).status, 200, "quiet counters were swept");
});
