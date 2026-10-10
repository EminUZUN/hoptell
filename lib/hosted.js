// Hosted HTTP MCP mode (design 4.5, EXPERIMENTAL: `hoptell mcp-hosted --experimental`): a relay
// operator hosts MCP endpoints for many people. The host reads everything its tenants send and
// receive; hosted members have no devices and nothing is end-to-end encrypted.
//
// This module is the HTTP side: HTTPS behind the operator's proxy (TLS ends there; the scheme
// comes only from a trusted proxy's X-Forwarded-Proto and must be https), the exact public Host
// authority, an Origin allow list on the MCP route only (empty by default; no CORS: OPTIONS is
// 405), Protected Resource Metadata (RFC 9728) and 401s naming it, access-token validation with
// 1.6's verifier (audience = this endpoint's resource, scope hoptell.mcp, access tokens only), the
// OAuth client taken only from the validated token, the link table, the legacy MCP session era
// from an explicit allow list, and the per-session table of 2.3 owned by (tenant, client_id).
// Tenants, engines and tools are lib/hostedtenants.js; the owner page lib/hostedowner.js.
//
// No token passthrough: a client's token is validated here and never forwarded anywhere.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { esc } from "./loopbackui.js";
import { linkTable } from "./hostedlinks.js";
import { HOST_ID_RE, clientAddress, fromTrustedProxy, parseTrustedProxies } from "./relay.js";

export const MCP_PATH = "/mcp";
export const SCOPE = "hoptell.mcp";
const RELAY_AUDIENCE = "hoptell-relay";
/**
 * The legacy, session-based MCP revisions served (design 4.5, "MCP protocol era"): Streamable HTTP
 * with Mcp-Session-Id assigned at initialize, as the pinned SDK (1.32) serves it. Membership in
 * this list decides; the 2026-07-28 revision and any unknown or older one are refused, with no
 * session. Tested-client matrix: the SDK's own client (2025-11-25), and initialize requests
 * declaring each listed revision (test/hosted.test.js). The SDK client looks up Protected
 * Resource Metadata at the URL a 401 names, else /.well-known/oauth-protected-resource/mcp, then
 * the root; all are served.
 */
export const LEGACY_REVISIONS = Object.freeze(["2025-03-26", "2025-06-18", "2025-11-25"]);
const BODY_LIMIT = 1024 * 1024;
const KEEPALIVE_MS = 15_000;
const DRAIN_MS = 2000;
// Limits (design 4.5, "Rate limits, quotas and storage"). OWNER-OPEN (open point 8): the values
// stand as the design's defaults until the owner decides; each is configurable.
export const DEFAULT_LIMITS = Object.freeze({
  preAuthFailuresPerMinute: 30,
  sessionsPerTenant: 4,
  callsPerSession: 4,
  waitsPerSession: 1,
  streamsPerSession: 2,
  requestsPerMinute: 120,
  sendsPerMinute: 30,
  sessions: 2000,
  liveEngines: 500,
  idleMs: 30 * 60_000,
});

/** A refusal with an HTTP status and a message safe to show the client. */
export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    Object.assign(this, { status, headers });
  }
}

/**
 * Read and check the hosted configuration (a JSON file). Throws with a fixed message. The OIDC part
 * is 1.6's configuration format (`oidc`, resource-mode issuers), enforced for this endpoint: every
 * issuer's audience is the endpoint's resource (or the configured `audience` the provider maps it
 * to, never the relay's), the scope hoptell.mcp is required, and introspection issuers take the
 * client from the response's client_id.
 */
export async function loadHostedConfig(file, { loadOidc = null } = {}) {
  let doc;
  try {
    const st = fs.statSync(file);
    if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${file} is readable by other users; chmod 600 it`);
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `${file}: invalid JSON` : e.message);
  }
  if (doc?.version !== 1) throw new Error(`${file}: version must be 1`);
  const oidcFile = doc.oidc;
  if (typeof oidcFile !== "string") throw new Error(`${file}: oidc must name the identity provider configuration file (1.6 format)`);
  const oidc = (loadOidc ?? (await import("./oidc.js")).loadOidcConfig)(oidcFile);
  return checkHostedConfig({ ...doc, oidc });
}

/** Check a hosted configuration object (oidc already loaded); returns the normalized config. */
export function checkHostedConfig(doc) {
  const authority = String(doc.authority ?? "");
  // A host name and an optional port: no scheme, path, user or brackets games.
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i.test(authority)) throw new Error("authority must be the public host name with an optional port (mcp.example.org or mcp.example.org:8443)");
  const origin = `https://${authority}`;
  const resource = `${origin}${MCP_PATH}`;
  if (!/^[0-9a-f]{32}$/.test(doc.realm ?? "")) throw new Error("realm must be the relay's realm id (32 hex digits; hoptell relay admin status shows it)");
  if (!HOST_ID_RE.test(doc.hostId ?? "")) throw new Error("hostId must be this host's id at the relay (hoptell members host add <id>)");
  if (typeof doc.relay !== "string" || !/^wss?:\/\//.test(doc.relay)) throw new Error("relay must be the relay's ws:// or wss:// URL");
  const trustedProxies = parseTrustedProxies(doc.trustedProxies ?? "");
  if (!trustedProxies) throw new Error("trustedProxies must name the proxy that ends TLS (the endpoint is HTTPS only, behind it)");
  const allow = doc.originAllowList ?? [];
  if (!Array.isArray(allow) || !allow.every((o) => typeof o === "string" && /^https?:\/\/[^/]+$/.test(o))) throw new Error("originAllowList must be a list of origins (https://example.org)");
  const audience = doc.audience ?? resource;
  if (typeof audience !== "string" || !audience || audience === RELAY_AUDIENCE) throw new Error(`audience must be this endpoint's resource (${resource}) or the audience the provider maps it to, never the relay's`);
  const issuers = (doc.oidc?.issuers ?? []).filter((i) => i.mode === "resource");
  if (!issuers.length) throw new Error("oidc must configure at least one resource-mode issuer for this endpoint");
  for (const i of issuers) {
    if (i.audience !== audience) throw new Error(`oidc: issuer ${i.issuer} has audience "${i.audience}"; this endpoint accepts only "${audience}"`);
    if (i.validation === "introspection" && i.clientClaim !== "client_id") throw new Error(`oidc: issuer ${i.issuer} uses introspection, so its clientClaim must be client_id`);
  }
  const oidc = { ...doc.oidc, issuers: doc.oidc.issuers.filter((i) => i.mode === "resource").map((i) => ({ ...i, requiredScopes: [...new Set([...(i.requiredScopes ?? []), SCOPE])] })) };
  const limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(doc.limits ?? {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, k) || !Number.isSafeInteger(v) || v < 1) throw new Error(`limits.${k} must be a positive whole number (known limits: ${Object.keys(DEFAULT_LIMITS).join(", ")})`);
    limits[k] = v;
  }
  // The owner page's own pre-registered OAuth client (design 4.5, "Hosted owner page").
  const owner = doc.owner ?? null;
  if (owner && (typeof owner.issuer !== "string" || !/^https?:\/\//.test(owner.issuer) || typeof owner.clientId !== "string" || !owner.clientId)) throw new Error("owner must be {issuer, clientId, clientSecretFile?}: the owner page's pre-registered client");
  if (doc.elicitation !== undefined && !["off", "read_inbox"].includes(doc.elicitation)) throw new Error('elicitation must be "off" or "read_inbox"');
  return Object.freeze({ elicitation: doc.elicitation ?? "off", authority, origin, resource, audience, realm: doc.realm, hostId: doc.hostId, relay: doc.relay, hostTokenFile: doc.hostTokenFile ?? null, trustedProxies, originAllowList: [...allow], oidc, owner, storage: doc.storage ?? {}, retention: doc.retention ?? {}, limits });
}

/** The tenant id of a hosted member (design 4.5): hex(SHA-256(realm id | member id)). */
export const tenantKey = (realm, memberId) => crypto.createHash("sha256").update(`${realm}|${memberId}`).digest("hex");

/** The unverified `iss` of a JWT, used only to pick the configured issuer that then verifies it. */
function jwtIssuer(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1].length > 16_384) return null;
  try {
    const iss = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.iss;
    return typeof iss === "string" ? iss : null;
  } catch {
    return null;
  }
}

/** A fixed-window counter per key (minute windows), bounded in size. */
function windowCounter(max, windowMs, now) {
  const m = new Map();
  return {
    over(key) {
      const e = m.get(key);
      return Boolean(e && now() - e.start < windowMs && e.n >= max);
    },
    hit(key) {
      const t = now();
      let e = m.get(key);
      if (!e || t - e.start >= windowMs) {
        if (m.size >= 100_000) for (const [k, v] of m) if (t - v.start >= windowMs) m.delete(k);
        e = { start: t, n: 0 };
        m.set(key, e);
      }
      e.n++;
      return e.n <= max;
    },
  };
}

/**
 * Start the hosted endpoint. `config` from loadHostedConfig; `verifier` 1.6's (createVerifier over
 * config.oidc); `tenants` (lib/hostedtenants.js) admits a tenant and creates the logical engine of
 * a new session; `serve(engine, transport, {onCall})` connects it (lib/mcp.js serveEngine);
 * `owner` (optional, lib/hostedowner.js) answers /owner/*. Binds `bind` (default 127.0.0.1: the
 * proxy in front ends TLS). Resolves to {port, close(), sessions()}.
 */
export async function startHosted({ config, stateDir, verifier, tenants, serve, owner = null, bind = "127.0.0.1", port = 0, log = () => {}, now = () => Date.now(), keepaliveMs = KEEPALIVE_MS, sweepMs = 30_000 }) {
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const L = config.limits;
  const links = linkTable(stateDir);
  const prmUrl = `${config.origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
  const prm = JSON.stringify({ resource: config.resource, authorization_servers: config.oidc.issuers.map((i) => i.issuer), scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "hoptell (hosted: the host can read messages)" });
  const failures = windowCounter(L.preAuthFailuresPerMinute, 60_000, now);
  const tenantRequests = windowCounter(L.requestsPerMinute, 60_000, now);
  const tenantSends = windowCounter(L.sendsPerMinute, 60_000, now);
  const introspectionDelay = (config.oidc.maxRevocationDelaySeconds ?? 300) * 1000;
  const sessions = new Map(); // id -> {owner, tenant, clientId, transport, engine, closeServer, last, streams, inflight, ending}
  const starting = []; // {owner, tenant} of initializations in progress (quotas)

  const unauthorized = (error = null) => new HttpError(401, error ? "the access token was refused" : "an access token is required", { "www-authenticate": `Bearer resource_metadata="${prmUrl}", scope="${SCOPE}"${error ? `, error="${error}"` : ""}` });

  /**
   * Validate the request's access token with 1.6's verifier and map it through the link table.
   * Returns {issuer, subject, clientId, deadline, member, generation, tenant}. Throws HttpError:
   * 401 (absent, refused, no client), 403 (not linked; an escaped page for the admin), 503 (the
   * provider or the link table is unavailable: never reported as a bad token).
   */
  async function authenticate(req) {
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? "");
    if (!m) throw unauthorized();
    const token = m[1];
    const byJwt = jwtIssuer(token);
    let issuer = byJwt && config.oidc.issuers.some((i) => i.issuer === byJwt) ? byJwt : null;
    if (!issuer && !byJwt) {
      const opaque = config.oidc.issuers.filter((i) => i.validation === "introspection");
      if (opaque.length === 1) issuer = opaque[0].issuer;
    }
    if (!issuer) throw unauthorized("invalid_token");
    let id;
    try {
      id = await verifier.verify(issuer, token);
    } catch (e) {
      if (e.code === "unavailable") throw new HttpError(503, "the identity provider is not reachable; try again", { "retry-after": "5" });
      throw unauthorized("invalid_token");
    }
    // The OAuth client that owns a session comes only from the validated token (or introspection).
    if (typeof id.client !== "string" || !id.client) throw unauthorized("invalid_token");
    let l;
    let gone = false;
    try {
      l = links.lookup(id.issuer, id.subject);
      gone = Boolean(l) && links.removed(l.member.id);
    } catch (e) {
      log("hosted: the link table cannot be read:", e.message);
      throw new HttpError(503, "the host's link table cannot be read; try again later", { "retry-after": "30" });
    }
    if (gone) throw Object.assign(new HttpError(403, `<!doctype html><meta charset="utf-8"><title>Removed</title><p>This hosted member was removed at the relay. Ask the host's administrator.</p>`, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" }), { html: true });
    if (!l) {
      const page = `<!doctype html><meta charset="utf-8"><title>Not linked</title><p>This identity is not linked to a hosted member. Ask the host's administrator to link it:</p><p>issuer: <code>${esc(id.issuer)}</code><br>subject: <code>${esc(id.subject)}</code></p>`;
      throw Object.assign(new HttpError(403, page, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" }), { html: true });
    }
    const deadline = Math.min(id.deadline, id.opaque ? (id.checkedAt ?? now()) + introspectionDelay : Infinity);
    return { issuer: id.issuer, subject: id.subject, clientId: id.client, deadline, member: l.member, generation: l.generation, tenant: tenantKey(config.realm, l.member.id) };
  }

  /** Checks before any MCP processing: Host, scheme, route, Origin (MCP route only), method, type. */
  function preflight(req) {
    if (!fromTrustedProxy(req, config.trustedProxies)) return new HttpError(403, "this endpoint is served only through its HTTPS proxy");
    const proto = req.headers["x-forwarded-proto"];
    if (proto !== "https") return new HttpError(403, "HTTPS only");
    if (req.headers.host !== config.authority) return new HttpError(403, "unknown host");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, error, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: error }, id: null }));
    try {
      await handle(req, res);
    } catch (e) {
      if (res.headersSent) res.destroy();
      else if (e.html) res.writeHead(e.status, e.headers).end(e.message);
      else json(e.status ?? 500, e.status ? e.message : "internal error", e.headers ?? {});
      if (!e.status) log("hosted request failed:", e.message);
    }
  });

  async function handle(req, res) {
    const client = clientAddress(req, config.trustedProxies).client;
    // Before authentication: a client address that failed too often is refused at once.
    if (failures.over(client)) throw new HttpError(429, "too many failed requests; try again in a minute", { "retry-after": "60" });
    const no = preflight(req);
    if (no) throw no;
    let url;
    try {
      url = new URL(req.url, config.origin);
    } catch {
      throw new HttpError(400, "bad request target");
    }
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`) {
      if (req.method !== "GET") throw new HttpError(405, "not supported");
      return res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" }).end(prm);
    }
    if (url.pathname === "/owner" || url.pathname.startsWith("/owner/")) {
      if (!owner) throw new HttpError(404, "not found");
      return owner.handle(req, res, url);
    }
    if (url.pathname !== MCP_PATH) throw new HttpError(404, "not found");
    // MCP route rules: an Origin only from the allow list (it adds no CORS: OPTIONS stays 405).
    if (req.headers.origin !== undefined && !config.originAllowList.includes(req.headers.origin)) throw new HttpError(403, "requests from web pages are not accepted");
    if (!["GET", "POST", "DELETE"].includes(req.method)) throw new HttpError(405, "not supported");
    if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send JSON");
    const v = req.headers["mcp-protocol-version"];
    if (v !== undefined && !LEGACY_REVISIONS.includes(v)) throw new HttpError(400, `unsupported MCP revision ${String(v).slice(0, 40)}; this endpoint serves ${LEGACY_REVISIONS.join(", ")}`);
    let who;
    try {
      who = await authenticate(req);
    } catch (e) {
      if (e.status === 401 || e.status === 403) failures.hit(client);
      throw e;
    }
    // Per tenant, never per connection.
    if (!tenantRequests.hit(who.tenant)) throw new HttpError(429, "too many requests; slow down", { "retry-after": "60" });
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const owner_ = `${who.tenant}|${who.clientId}`;
    const sid = req.headers["mcp-session-id"];
    if (sid) {
      const s = sessions.get(sid);
      // A session id is a routing handle: another tenant or another OAuth client gets 404.
      if (!s || s.tenant !== who.tenant || s.clientId !== who.clientId || s.ending) throw new HttpError(404, "no such session");
      s.last = now();
      deadlineFor(res, who.deadline);
      tenants.touch?.(who);
      if (req.method === "DELETE") return closeSession(sid, s, req, res);
      if (req.method === "GET") {
        if (s.streams >= L.streamsPerSession) throw new HttpError(429, "too many open streams for this session");
        s.streams++;
        const keep = setInterval(() => res.write(": keepalive\n\n"), keepaliveMs);
        keep.unref();
        res.on("close", () => {
          clearInterval(keep);
          s.streams--;
          s.last = now();
        });
      }
      if (req.method === "POST") {
        const calls = [body].flat().filter((m) => m?.method === "tools/call");
        if (calls.length) {
          const ids = calls.map((m) => String(m.id));
          if (ids.some((id) => s.inflight.has(id)) || new Set(ids).size !== ids.length) throw new HttpError(400, "a request id that is still in use");
          const waits = calls.filter((m) => m.params?.name === "wait_for_message").length;
          if (s.inflight.size + calls.length > L.callsPerSession) throw new HttpError(429, "too many calls in progress for this session");
          if ([...s.inflight.values()].filter((c) => c.wait).length + waits > L.waitsPerSession) throw new HttpError(429, "a wait_for_message is already in progress for this session");
          const sends = calls.filter((m) => m.params?.name === "send_message").length;
          for (let i = 0; i < sends; i++) if (!tenantSends.hit(who.tenant)) throw new HttpError(429, `at most ${L.sendsPerMinute} sends per minute`, { "retry-after": "60" });
          for (const m of calls) s.inflight.set(String(m.id), { wait: m.params?.name === "wait_for_message", started: false });
          res.on("close", () => {
            for (const id of ids) if (s.inflight.get(id)?.started === false) s.inflight.delete(id);
            s.last = now();
          });
        }
      }
      s.who = who; // the latest validated principal of this (tenant, client): for the tools
      await s.transport.handleRequest(req, res, body);
      return;
    }
    // A new session: the whole initialize request, and its revision, are valid before anything is allocated.
    const isInit = req.method === "POST" && !Array.isArray(body) && body?.jsonrpc === "2.0" && (typeof body.id === "string" || Number.isInteger(body.id)) && isInitializeRequest(body);
    if (!isInit) throw new HttpError(400, "start with a valid initialize request");
    const revision = body.params.protocolVersion;
    if (!LEGACY_REVISIONS.includes(revision)) throw new HttpError(400, `unsupported MCP revision ${String(revision).slice(0, 40)}; this endpoint serves ${LEGACY_REVISIONS.join(", ")}`);
    const channel = Boolean(body.params.capabilities?.experimental?.["claude/channel"]);
    const mine = [...sessions.values(), ...starting].filter((x) => x.tenant === who.tenant).length;
    if (mine >= L.sessionsPerTenant) throw new HttpError(429, "too many sessions; end one first");
    if (sessions.size + starting.length >= L.sessions) throw new HttpError(503, "the host is at its session limit; try again later", { "retry-after": "60" });
    const place = { owner: owner_, tenant: who.tenant };
    starting.push(place);
    const unplace = () => starting.includes(place) && starting.splice(starting.indexOf(place), 1);
    let engine = null;
    let entry = null;
    let closeServer = null;
    const inflight = new Map();
    try {
      // Admission of the tenant's live engine (at the cap: park an idle one, else 503).
      engine = await tenants.sessionEngine(who, { channel, sessionOf: () => entry });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: false,
        onsessioninitialized: (id) => {
          entry = { id, owner: owner_, tenant: who.tenant, clientId: who.clientId, who, transport, engine, closeServer, last: now(), streams: 0, inflight, ending: false };
          sessions.set(id, entry);
          unplace();
          log(`hosted session ${id.slice(0, 8)} started (tenant ${who.tenant.slice(0, 12)}, client ${who.clientId})`);
        },
      });
      const onCall = (requestId) => {
        const c = inflight.get(String(requestId));
        if (c) c.started = true;
        return () => inflight.delete(String(requestId));
      };
      closeServer = await serve(engine, transport, { onCall });
      deadlineFor(res, who.deadline);
      await transport.handleRequest(req, res, body);
    } finally {
      unplace();
      if (entry) entry.closeServer = closeServer;
      else {
        await closeServer?.().catch(() => {});
        await engine?.stop().catch(() => {});
      }
    }
  }

  /** A response is served only while its token is valid: it ends at the token's deadline. */
  function deadlineFor(res, deadline) {
    const t = setTimeout(() => (res.headersSent ? res.end() : res.destroy()), Math.max(0, deadline - now()));
    t.unref?.();
    res.on("close", () => clearTimeout(t));
  }

  async function closeSession(sid, s, req, res) {
    s.ending = true;
    await stopEngine(s);
    await s.transport.handleRequest(req, res);
    await end(sid, "closed by the client");
  }

  async function stopEngine(s) {
    await s.engine.stop().catch(() => {});
    for (let i = 0; i < DRAIN_MS / 20 && [...s.inflight.values()].some((c) => c.started); i++) await new Promise((r) => setTimeout(r, 20));
  }

  async function end(id, why) {
    const s = sessions.get(id);
    if (!s) return;
    s.ending = true;
    await stopEngine(s);
    sessions.delete(id);
    log(`hosted session ${id.slice(0, 8)} ended (${why})`);
    await s.closeServer?.().catch(() => {});
  }

  const sweep = setInterval(() => {
    const t = now();
    for (const [id, s] of sessions) {
      if (s.ending) continue;
      let linked = true;
      try {
        linked = links.lookup(s.who.issuer, s.who.subject)?.member.id === s.who.member.id && !links.removed(s.who.member.id);
      } catch {
        // unreadable: decided at the next request
      }
      if (!linked) end(id, "unlinked");
      else if (!s.streams && !s.inflight.size && t - s.last > L.idleMs) end(id, "idle");
    }
  }, sweepMs);
  sweep.unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, resolve);
  });
  const actual = server.address().port;
  log(`hosted MCP endpoint (EXPERIMENTAL) at ${config.resource}, listening on ${bind}:${actual} behind the HTTPS proxy`);
  return {
    port: actual,
    sessions: () => [...sessions.entries()].map(([id, s]) => ({ id, tenant: s.tenant, clientId: s.clientId, calls: s.inflight.size, streams: s.streams })),
    /** End every session of a tenant (unlink, member removal): its engine stops at once. */
    async endTenant(tenant, why = "unlinked") {
      await Promise.all([...sessions.entries()].filter(([, s]) => s.tenant === tenant).map(([id]) => end(id, why)));
    },
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map((id) => end(id, "server stopping")));
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
    },
  };
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, "request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
