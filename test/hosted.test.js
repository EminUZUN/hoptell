// Hosted HTTP MCP mode (design 4.5), the HTTP side: the proxy and Host rules, the MCP route's
// Origin allow list, Protected Resource Metadata and 401s, token validation through 1.6's
// verifier (audience, scope, access tokens only, client from the token), the link table, the
// legacy protocol era and session ownership by (tenant, client_id). The tenant layer is a stub
// here; test/hosted-tenants.test.js runs real engines against a relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LEGACY_REVISIONS, checkHostedConfig, startHosted, tenantKey } from "../lib/hosted.js";
import { link, readLinks, unlink } from "../lib/hostedlinks.js";
import { createVerifier } from "../lib/oidc.js";
import { serveEngine } from "../lib/mcp.js";
import { startProvider } from "./fixtures/oidc-provider.mjs";
import { AUTHORITY, HANNA, HUGO, REALM, RESOURCE, oidcConfigFor, proxyFetch } from "./hosted-helpers.js";
import { sleep } from "./helpers.js";

/** A stub tenant layer: each session gets a tiny engine that answers `whoami`. */
function stubTenants() {
  const created = [];
  return {
    created,
    async sessionEngine(who) {
      created.push(who);
      const engine = {
        delivery: { mode: "listener" },
        attach: () => ({ detach() {} }),
        start: async () => {},
        stop: async () => {},
        instructions: () => "hosted test",
        tools: async () => [{ name: "whoami", description: "who", inputSchema: { type: "object", properties: {} } }],
        call: async () => ({ content: [{ type: "text", text: `${who.member.name}|${who.clientId}` }] }),
      };
      return engine;
    },
  };
}

async function setup(t, { limits = {}, originAllowList = [], providerOpts = {}, oidcExtra = {}, oidcTop = {}, trustedProxies = "127.0.0.1" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hosted-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = await startProvider({ audience: RESOURCE, ...providerOpts });
  t.after(() => provider.close());
  const oidc = oidcConfigFor(dir, typeof oidcExtra === "function" ? provider : provider, typeof oidcExtra === "function" ? oidcExtra(dir) : oidcExtra, oidcTop);
  const config = checkHostedConfig({ version: 1, authority: AUTHORITY, realm: REALM, hostId: "h1", relay: "ws://127.0.0.1:1", trustedProxies, originAllowList, oidc, limits });
  const verifier = await createVerifier(config.oidc);
  const state = path.join(dir, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  await link(state, { issuer: provider.issuer, subject: "hanna-sub", member: HANNA });
  await link(state, { issuer: provider.issuer, subject: "hugo-sub", member: HUGO });
  const tenants = stubTenants();
  const logs = [];
  const h = await startHosted({ config, stateDir: state, verifier, tenants, serve: (e, tr, o) => serveEngine(e, tr, { front: "hosted", ...o }), log: (...a) => logs.push(a.join(" ")) });
  t.after(() => h.close());
  const token = (sub, o = {}) => provider.issue({ sub, client: "client-a", scope: "openid hoptell.mcp", ...o });
  /** A raw request through the proxy (Host and X-Forwarded-Proto set). */
  const raw = async (method, p, { headers = {}, body, proxy = {} } = {}) => {
    const r = await proxyFetch(h.port, proxy)(`https://${AUTHORITY}${p}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json", accept: "application/json, text/event-stream" } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text };
  };
  const connect = async (bearer) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), { fetch: proxyFetch(h.port), requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
    await client.connect(transport);
    t.after(() => client.close().catch(() => {}));
    return { client, transport };
  };
  return { dir, state, provider, config, h, tenants, token, raw, connect, logs };
}
const init = (v = "2025-06-18", clientInfo = { name: "x", version: "0" }) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo } });
const whoami = async (client) => (await client.callTool({ name: "whoami", arguments: {} })).content[0].text;

test("config: the audience is this endpoint's, never the relay's; the scope hoptell.mcp is always required", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hosted-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = { issuer: "https://idp.example" };
  const base = { version: 1, authority: AUTHORITY, realm: REALM, hostId: "h1", relay: "wss://relay.example", trustedProxies: "10.0.0.1" };
  const ok = checkHostedConfig({ ...base, oidc: oidcConfigFor(dir, provider) });
  assert.deepEqual(ok.oidc.issuers[0].requiredScopes, ["hoptell.mcp"]);
  assert.equal(ok.resource, RESOURCE);
  assert.throws(() => checkHostedConfig({ ...base, oidc: oidcConfigFor(dir, provider, { audience: "hoptell-relay" }) }), /accepts only/);
  assert.throws(() => checkHostedConfig({ ...base, audience: "hoptell-relay", oidc: oidcConfigFor(dir, provider, { audience: "hoptell-relay" }) }), /never the relay's/);
  assert.throws(() => checkHostedConfig({ ...base, trustedProxies: "", oidc: oidcConfigFor(dir, provider) }), /trustedProxies/);
  assert.throws(() => checkHostedConfig({ ...base, authority: "https://x", oidc: oidcConfigFor(dir, provider) }), /authority/);
  assert.throws(() => checkHostedConfig({ ...base, limits: { nope: 1 }, oidc: oidcConfigFor(dir, provider) }), /limits.nope/);
});

test("HTTP rules: proxy-only, https, exact Host; Origin refused on MCP unless listed (no CORS: OPTIONS 405); PRM served", async (t) => {
  const s = await setup(t, { originAllowList: ["https://allowed.example"] });
  const bearer = await s.token("hanna-sub");
  const auth = { authorization: `Bearer ${bearer}` };
  assert.equal((await s.raw("POST", "/mcp", { headers: auth, body: init(), proxy: { proto: "http" } })).status, 403, "http scheme");
  assert.equal((await s.raw("POST", "/mcp", { headers: auth, body: init(), proxy: { host: "evil.example" } })).status, 403, "other Host");
  assert.equal((await s.raw("POST", "/mcp", { headers: auth, body: init(), proxy: { host: `${AUTHORITY}:443` } })).status, 403, "Host must match exactly");
  assert.equal((await s.raw("POST", "/mcp", { headers: { ...auth, origin: "https://evil.example" }, body: init() })).status, 403);
  assert.equal((await s.raw("OPTIONS", "/mcp", { headers: { origin: "https://allowed.example" } })).status, 405);
  const listed = await s.raw("POST", "/mcp", { headers: { ...auth, origin: "https://allowed.example" }, body: init() });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("access-control-allow-origin"), null, "no CORS headers");
  assert.equal((await s.raw("POST", "/mcp", { headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: "a=b" })).status, 415, "form POST to MCP");
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const r = await s.raw("GET", p);
    assert.equal(r.status, 200);
    const doc = JSON.parse(r.text);
    assert.equal(doc.resource, RESOURCE);
    assert.deepEqual(doc.authorization_servers, [s.provider.issuer]);
    assert.deepEqual(doc.scopes_supported, ["hoptell.mcp"]);
  }
});

test("a request whose peer is not a trusted proxy is refused (no trustworthy scheme)", async (t) => {
  const s = await setup(t, { trustedProxies: "10.9.9.9" });
  assert.equal((await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${await s.token("hanna-sub")}` }, body: init() })).status, 403);
  assert.equal((await s.raw("GET", "/.well-known/oauth-protected-resource")).status, 403);
});

test("OAuth: 401 names the resource metadata; relay-audience, ID, wrong-scope and client-less tokens are refused with no session", async (t) => {
  const s = await setup(t);
  const none = await s.raw("POST", "/mcp", { body: init() });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate"), new RegExp(`^Bearer resource_metadata="https://${AUTHORITY}/.well-known/oauth-protected-resource/mcp"`));
  const bad = [
    ["relay audience", await s.token("hanna-sub", { aud: "hoptell-relay" })],
    ["ID token", await s.token("hanna-sub", { typ: "JWT", extra: { nonce: "n" } })],
    ["no scope", await s.token("hanna-sub", { scope: "openid" })],
    ["client_id and azp differ", await s.token("hanna-sub", { extra: { azp: "client-b" } })],
    ["expired", await s.token("hanna-sub", { exp: -120 })],
  ];
  for (const [why, tk] of bad) {
    const r = await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${tk}` }, body: init() });
    assert.equal(r.status, 401, why);
    assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/, why);
  }
  assert.equal(s.tenants.created.length, 0, "no session or engine for any of them");
  assert.equal(s.h.sessions().length, 0);
});

test("OAuth: a token without a client claim gets 401 (rfc9068 needs client_id; a claims profile with azp configured and absent too)", async (t) => {
  const s = await setup(t, { oidcExtra: { profile: "claims", clientClaim: "azp", requiredClaims: { typ: "Bearer" } } });
  const tk = await s.token("hanna-sub", { typ: "JWT", extra: { typ: "Bearer" } }); // client_id only, no azp
  const r = await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${tk}` }, body: init() });
  assert.equal(r.status, 401);
  assert.equal(s.tenants.created.length, 0);
  const withAzp = await s.token("hanna-sub", { typ: "JWT", extra: { typ: "Bearer", azp: "client-a" } });
  assert.equal((await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${withAzp}` }, body: init() })).status, 200);
});

test("links: an unlinked identity gets 403 with an escaped page; the link table is re-read when it changes; generations are never reused", async (t) => {
  const s = await setup(t);
  const r = await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${await s.token("<script>x</script>")}` }, body: init() });
  assert.equal(r.status, 403);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.ok(r.text.includes("&#60;script&#62;x&#60;/script&#62;") && !r.text.includes("<script>"), "escaped");
  const g1 = readLinks(s.state).links.find((l) => l.member.id === HANNA.id).generation;
  await unlink(s.state, { issuer: s.provider.issuer, subject: "hanna-sub" });
  assert.equal((await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${await s.token("hanna-sub")}` }, body: init() })).status, 403);
  await link(s.state, { issuer: s.provider.issuer, subject: "hanna-sub", member: HANNA });
  const g2 = readLinks(s.state).links.find((l) => l.member.id === HANNA.id).generation;
  assert.ok(g2 > g1, "a relink gets a new generation");
  // A relink of the member to another subject moves it (one link per member), with a new generation.
  await link(s.state, { issuer: s.provider.issuer, subject: "hanna-new", member: HANNA });
  assert.equal(readLinks(s.state).links.filter((l) => l.member.id === HANNA.id).length, 1);
  assert.ok(readLinks(s.state).links.find((l) => l.member.id === HANNA.id).generation > g2);
  // An unreadable table is 503, never "not linked".
  fs.writeFileSync(path.join(s.state, "links.json"), "{", { mode: 0o600 });
  assert.equal((await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${await s.token("hanna-new")}` }, body: init() })).status, 503);
});

test("protocol era: 2026-07-28, unknown and pre-session revisions are refused with no session; every listed revision is accepted", async (t) => {
  const s = await setup(t, { limits: { sessionsPerTenant: 10 } });
  const auth = { authorization: `Bearer ${await s.token("hanna-sub")}` };
  for (const v of ["2026-07-28", "2099-01-01", "2024-11-05", "2024-10-07"]) {
    const r = await s.raw("POST", "/mcp", { headers: auth, body: init(v) });
    assert.equal(r.status, 400, v);
    assert.equal(r.headers.get("mcp-session-id"), null, v);
  }
  assert.equal(s.tenants.created.length, 0, "no engine started");
  for (const v of LEGACY_REVISIONS) {
    const r = await s.raw("POST", "/mcp", { headers: auth, body: init(v) });
    assert.equal(r.status, 200, v);
    assert.ok(r.headers.get("mcp-session-id"), v);
  }
  // A later request declaring another revision is refused.
  const sid = (await s.raw("POST", "/mcp", { headers: auth, body: init() })).headers.get("mcp-session-id");
  const later = await s.raw("POST", "/mcp", { headers: { ...auth, "mcp-session-id": sid, "mcp-protocol-version": "2026-07-28" }, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(later.status, 400);
});

test("isolation: a session id with another tenant's token, or the same tenant's token from another client, is 404; clientInfo changes nothing", async (t) => {
  const s = await setup(t);
  const { client, transport } = await s.connect(await s.token("hanna-sub"));
  assert.equal(await whoami(client), "hanna|client-a");
  const sid = transport.sessionId;
  const call = (bearer) => s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${bearer}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, body: { jsonrpc: "2.0", id: 9, method: "tools/list" } });
  assert.equal((await call(await s.token("hugo-sub"))).status, 404, "another tenant");
  assert.equal((await call(await s.token("hanna-sub", { client: "client-b" }))).status, 404, "another client of the same tenant");
  assert.equal((await call(await s.token("hanna-sub"))).status, 200, "the owner");
  // clientInfo naming another client has no effect: the session belongs to the token's client.
  const r = await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${await s.token("hanna-sub")}` }, body: init("2025-06-18", { name: "client-b", version: "0" }) });
  const sid2 = r.headers.get("mcp-session-id");
  const other = await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${await s.token("hanna-sub", { client: "client-b" })}`, "mcp-session-id": sid2, "mcp-protocol-version": "2025-06-18" }, body: { jsonrpc: "2.0", id: 9, method: "tools/list" } });
  assert.equal(other.status, 404);
  assert.equal(s.tenants.created.at(-1).clientId, "client-a");
  assert.equal(s.tenants.created.at(-1).tenant, tenantKey(REALM, HANNA.id));
});

test("deadlines: an SSE stream ends at its token's deadline (exp + the one skew)", async (t) => {
  const s = await setup(t);
  // A token valid for 3 s past the 60 s skew already spent: exp = now - 57 s, deadline now + 3 s
  // (enough for the session and the stream to open on a loaded machine).
  const short = await s.token("hanna-sub", { exp: -57 });
  const r = await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${short}` }, body: init() });
  const sid = r.headers.get("mcp-session-id");
  const t0 = Date.now();
  const res = await proxyFetch(s.h.port)(`https://${AUTHORITY}/mcp`, { method: "GET", headers: { authorization: `Bearer ${short}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18", accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  await res.text().catch(() => {});
  const took = Date.now() - t0;
  assert.ok(took < 7000, `closed at the deadline (${took} ms)`);
});

test("pre-auth limit: 30 failed requests per minute per client address, then 429", async (t) => {
  const s = await setup(t, { limits: { preAuthFailuresPerMinute: 5 } });
  for (let i = 0; i < 5; i++) assert.equal((await s.raw("POST", "/mcp", { body: init() })).status, 401);
  assert.equal((await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${await s.token("hanna-sub")}` }, body: init() })).status, 429, "even with a valid token now");
  // Another client address (through the proxy) is not affected.
  assert.equal((await s.raw("POST", "/mcp", { body: init(), proxy: { extra: { "x-forwarded-for": "203.0.113.9" } } })).status, 401);
});

test("per-tenant limits: sessions across connections, requests per minute", async (t) => {
  const s = await setup(t, { limits: { sessionsPerTenant: 2, requestsPerMinute: 6 } });
  const a = { authorization: `Bearer ${await s.token("hanna-sub")}` };
  const b = { authorization: `Bearer ${await s.token("hanna-sub", { client: "client-b" })}` };
  assert.equal((await s.raw("POST", "/mcp", { headers: a, body: init() })).status, 200);
  assert.equal((await s.raw("POST", "/mcp", { headers: b, body: init() })).status, 200);
  assert.equal((await s.raw("POST", "/mcp", { headers: a, body: init() })).status, 429, "the tenant's sessions, whatever the client");
  const hugo = { authorization: `Bearer ${await s.token("hugo-sub")}` };
  assert.equal((await s.raw("POST", "/mcp", { headers: hugo, body: init() })).status, 200, "another tenant is not affected");
  for (let i = 0; i < 3; i++) await s.raw("GET", "/mcp", { headers: a });
  assert.equal((await s.raw("GET", "/mcp", { headers: a })).status, 429);
  await sleep(1);
});

test("introspection: a revoked opaque token ends an open SSE stream at its freshness bound (the last answer + maxRevocationDelaySeconds)", async (t) => {
  const s = await setup(t, {
    providerOpts: { opaque: true, clients: { "hoptell-host": { secret: "introspection-secret-0123" } } },
    oidcTop: { maxRevocationDelaySeconds: 10 },
    oidcExtra: (dir) => {
      const secretFile = path.join(dir, "introspection.secret");
      fs.writeFileSync(secretFile, "introspection-secret-0123", { mode: 0o600 });
      return { validation: "introspection", introspection: { clientId: "hoptell-host", clientSecretFile: secretFile }, requiredClaims: { typ: "Bearer" }, clientClaim: "client_id" };
    },
  });
  const opaque = await s.token("hanna-sub");
  assert.ok(!opaque.includes("."), "an opaque token");
  const auth = { authorization: `Bearer ${opaque}` };
  const init0 = await s.raw("POST", "/mcp", { headers: auth, body: init() });
  assert.equal(init0.status, 200);
  const sid = init0.headers.get("mcp-session-id");
  const t0 = Date.now();
  const stream = await proxyFetch(s.h.port)(`https://${AUTHORITY}/mcp`, { method: "GET", headers: { ...auth, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18", accept: "text/event-stream" } });
  assert.equal(stream.status, 200);
  s.provider.revoke("hanna-sub");
  await stream.text().catch(() => {});
  const took = Date.now() - t0;
  assert.ok(took >= 5000 && took < 13_000, `the stream ended at the bound, after ${took} ms`);
  // The next request asks the provider again: refused.
  assert.equal((await s.raw("POST", "/mcp", { headers: { ...auth, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, body: { jsonrpc: "2.0", id: 5, method: "tools/list" } })).status, 401);
});

test("header fuzzing: the tenant comes only from the token and the link table, never a header", async (t) => {
  const s = await setup(t, { limits: { sessionsPerTenant: 100, requestsPerMinute: 100_000 } });
  const hanna = await s.token("hanna-sub");
  const hostile = [
    { "x-hoptell-tenant": tenantKey(REALM, HUGO.id) },
    { "x-hoptell-member": HUGO.id, "x-forwarded-user": "hugo-sub", "x-remote-user": "hugo" },
    { "x-forwarded-for": "../../etc", "x-forwarded-host": "evil.example", forwarded: "for=1.2.3.4;host=evil" },
    { "mcp-session-id": "../../tenants/x", "x-client-id": "client-b" },
    { authorization: `Bearer ${hanna}`, "x-authorization": `Bearer ${await s.token("hugo-sub")}` },
  ];
  for (const h of hostile) {
    const r = await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${hanna}`, ...h }, body: init() });
    if (h["mcp-session-id"]) assert.equal(r.status, 404, "an unknown session id");
    else assert.equal(r.status, 200, JSON.stringify(h));
  }
  // A scheme other than exactly "https" from the proxy is refused.
  assert.equal((await s.raw("POST", "/mcp", { headers: { authorization: `Bearer ${hanna}` }, body: init(), proxy: { proto: "https, http" } })).status, 403);
  // Every session created belongs to hanna and client-a, whatever the headers said.
  assert.ok(s.tenants.created.length > 0);
  for (const w of s.tenants.created) {
    assert.equal(w.tenant, tenantKey(REALM, HANNA.id));
    assert.equal(w.clientId, "client-a");
    assert.equal(w.member.id, HANNA.id);
  }
  // Nothing was created in the state directory but the link table.
  assert.deepEqual(fs.readdirSync(s.state).sort(), ["links.json"]);
});
