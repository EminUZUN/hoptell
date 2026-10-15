// The hoptell MCP server over HTTP on this machine (`hoptell mcp-http`, design 2.3): MCP
// Streamable HTTP on 127.0.0.1 for clients that only speak HTTP. stdio stays the default.
//
// Every request needs a client token (`hoptell mcp-http client add`), stored only as its SHA-256.
// Browser pages cannot use it: the Host header must name this loopback address (DNS rebinding),
// any Origin header is refused, there are no CORS headers and OPTIONS is not served. Each MCP
// session has its own engine (its peer name and roles come from the client record) and belongs
// to the client that created it.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { checkName, ensurePrivateDir } from "./config.js";
import { withLock, writeRecord } from "./locks.js";
import { SUPPORTED_PROTOCOL_VERSIONS, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_PORT = 7790;
const BODY_LIMIT = 1024 * 1024;
const IDLE_MS = 30 * 60_000;
const KEEPALIVE_MS = 15_000;
const DRAIN_MS = 2000; // how long a stopping session waits for its calls to answer
export const LIMITS = { sessionsPerClient: 4, sessions: 32, callsPerSession: 4, streamsPerSession: 2, waitsPerSession: 1 };
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const digestOf = (token) => crypto.createHash("sha256").update(token).digest();

export const clientsFile = (home) => path.join(home, "mcp-http", "clients.json");

function readClients(file) {
  let doc;
  try {
    if (process.platform !== "win32" && fs.statSync(file).mode & 0o077) throw new Error(`${file} is readable by other users; chmod 600 it`);
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { v: 1, clients: [] };
    throw new Error(e instanceof SyntaxError ? `${file}: invalid JSON` : e.message);
  }
  if (doc?.v !== 1 || !Array.isArray(doc.clients)) throw new Error(`${file}: unknown format`);
  return doc;
}

/** Add a client; returns {label, token} (the token is shown once and stored as its SHA-256). */
export async function addClient(home, label, { name = null, roles = [], agents = false } = {}) {
  if (!LABEL_RE.test(label ?? "")) throw new Error(`invalid client label "${label}": letters, digits, ".", "_" and "-", up to 64 characters`);
  if (name !== null) checkName(name, "--name");
  const file = clientsFile(home);
  ensurePrivateDir(home);
  ensurePrivateDir(path.dirname(file));
  const token = crypto.randomBytes(32).toString("base64url");
  await withLock(`${file}.lock`, () => {
    const doc = readClients(file);
    if (doc.clients.some((c) => c.label === label)) throw new Error(`a client "${label}" exists; remove it first to issue a new token`);
    doc.clients.push({ label, digest: digestOf(token).toString("hex"), name, roles, ...(agents ? { agents: true } : {}), created: new Date().toISOString() });
    writeRecord(file, doc, 2);
  });
  return { label, token };
}

/** Clients without their token digests. */
export function listClients(home) {
  return readClients(clientsFile(home)).clients.map(({ label, name, roles, agents, created }) => ({ label, name, roles, agents: agents === true, created }));
}

export async function removeClient(home, label) {
  const file = clientsFile(home);
  // No clients file (none was ever added): nothing to lock or remove.
  if (!fs.existsSync(path.dirname(file))) throw new Error(`no client "${label}"`);
  return withLock(`${file}.lock`, () => {
    const doc = readClients(file);
    const before = doc.clients.length;
    doc.clients = doc.clients.filter((c) => c.label !== label);
    if (doc.clients.length === before) throw new Error(`no client "${label}"`);
    writeRecord(file, doc, 2);
  });
}

/** The client a bearer token belongs to, compared in constant time against every record. */
export function clientOf(clients, header) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header ?? "");
  if (!m) return null;
  const d = digestOf(m[1]);
  let found = null;
  for (const c of clients) {
    const cd = Buffer.from(c.digest, "hex");
    if (cd.length === d.length && crypto.timingSafeEqual(cd, d) && !found) found = c;
  }
  return found;
}

/**
 * Checks before any MCP processing; returns null or {status, error}. Browsers are kept out by
 * the Host and Origin rules; everything else needs a client token.
 */
export function refuse(req, { port }) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { status: 403, error: "this server answers only to its loopback address" };
  if (req.headers.origin !== undefined) return { status: 403, error: "requests from web pages are not accepted" };
  if (req.method === "OPTIONS") return { status: 405, error: "not supported" };
  if (!["GET", "POST", "DELETE"].includes(req.method)) return { status: 405, error: "not supported" };
  let url;
  try {
    url = new URL(req.url, `http://${host}`);
  } catch {
    return { status: 400, error: "bad request target" };
  }
  if (url.pathname !== "/mcp") return { status: 404, error: "not found" };
  if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return { status: 415, error: "send JSON" };
  return null;
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("request too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });

/**
 * Serve MCP over HTTP. `engineFor(client)` creates an engine for a new session of `client`
 * (its name and roles); `serve(engine, transport)` connects it (lib/mcp.js). Resolves to
 * {port, close(), sessions()}.
 */
export async function startMcpHttp({ home, port = DEFAULT_PORT, engineFor, serve, log = () => {}, idleMs = IDLE_MS, sweepMs = 30_000, limits = LIMITS, keepaliveMs = KEEPALIVE_MS, hostOf = null }) {
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const sessions = new Map(); // id -> {client, transport, engine, closeServer, last, streams}
  // Initializations in progress hold their place (quotas, hook registration) from the first
  // check on, so that simultaneous ones cannot all pass.
  const starting = []; // {digest, regId}
  let actualPort = port;

  async function end(id, why) {
    const s = sessions.get(id);
    if (!s) return;
    s.ending = true;
    // The engine first: calls in progress (a wait) return their answer while their streams are
    // open; then the session is gone and the MCP server and its streams close.
    await stopEngine(s);
    sessions.delete(id);
    log(`session ${id.slice(0, 8)} of ${s.client.label} ended (${why})`);
    await s.closeServer?.().catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, error) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: error }, id: null }));
    // Everything a request does stays inside this boundary: a malformed request is answered, and
    // the server goes on.
    try {
      await handle(req, res, json);
    } catch (e) {
      if (!res.headersSent) json(e.status ?? 500, e.status ? e.message : "internal error");
      else res.destroy();
      if (!e.status) log("mcp-http request failed:", e.message);
    }
  });

  async function handle(req, res, json) {
    const no = refuse(req, { port: actualPort });
    if (no) return json(no.status, no.error);
    let clients;
    try {
      clients = readClients(clientsFile(home)).clients;
    } catch (e) {
      log("mcp-http clients:", e.message);
      return json(500, "the client list cannot be read");
    }
    const client = clientOf(clients, req.headers.authorization);
    if (!client) return res.writeHead(401, { "www-authenticate": 'Bearer realm="hoptell"' }).end();
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const sid = req.headers["mcp-session-id"];
    if (sid) {
      const s = sessions.get(sid);
      // A session belongs to the client that created it; others do not learn that it exists.
      if (!s || s.client.digest !== client.digest || s.ending) return json(404, "no such session");
      s.last = Date.now();
      if (req.method === "DELETE") return closeSession(sid, s, req, res, json);
      if (req.method === "GET") {
        // Standalone streams (GET). The response stream of a POST lives as long as its calls,
        // which the call quota bounds.
        if (s.streams >= limits.streamsPerSession) return json(429, "too many open streams for this session");
        s.streams++;
        // SSE comments keep idle streams alive and reveal dead ones (a failed write closes it).
        const keep = setInterval(() => res.write(": keepalive\n\n"), keepaliveMs);
        keep.unref();
        res.on("close", () => {
          clearInterval(keep);
          s.streams--;
          s.last = Date.now();
        });
      }
      if (req.method === "POST") {
        // Calls count from their arrival until their handler settles: a dropped connection
        // neither frees the quota nor makes the session idle (explicit cancellation ends the call).
        const calls = [body].flat().filter((m) => m?.method === "tools/call");
        if (calls.length) {
          const ids = calls.map((m) => String(m.id));
          if (ids.some((id) => s.inflight.has(id)) || new Set(ids).size !== ids.length) return json(400, "a request id that is still in use");
          const waits = calls.filter((m) => m.params?.name === "wait_for_message").length;
          if (s.inflight.size + calls.length > limits.callsPerSession) return json(429, "too many calls in progress for this session");
          if ([...s.inflight.values()].filter((c) => c.wait).length + waits > limits.waitsPerSession) return json(429, "a wait_for_message is already in progress for this session");
          for (const m of calls) s.inflight.set(String(m.id), { wait: m.params?.name === "wait_for_message", started: false });
          // A call the SDK refused before its handler ran is released with its request.
          res.on("close", () => {
            for (const id of ids) if (s.inflight.get(id)?.started === false) s.inflight.delete(id);
            s.last = Date.now();
          });
        }
      }
      await s.transport.handleRequest(req, res, body);
      return;
    }
    // A new session: the whole initialize request is valid before anything is allocated.
    const isInit = req.method === "POST" && !Array.isArray(body) && body?.jsonrpc === "2.0" && (typeof body.id === "string" || Number.isInteger(body.id)) && isInitializeRequest(body);
    if (!isInit) return json(400, "start with a valid initialize request");
    const channel = Boolean(body.params.capabilities?.experimental?.["claude/channel"]); // negotiated by this client
    const mine = [...sessions.values(), ...starting].filter((x) => (x.client?.digest ?? x.digest) === client.digest).length;
    if (mine >= limits.sessionsPerClient || sessions.size + starting.length >= limits.sessions) return json(429, "too many sessions; end one first");
    // Hook wake-ups (option B): a registration id from the client's headers helper names a live
    // Claude Code process of this account; it serves one session at a time. Otherwise: no hooks.
    const regId = String(req.headers["x-hoptell-hook-registration"] ?? "") || null;
    const taken = regId && [...sessions.values(), ...starting].some((x) => x.regId === regId);
    const host = regId && !taken ? (hostOf?.(regId) ?? null) : null;
    const hook = !regId ? "none" : taken ? "in use by another session" : host ? "registered" : "not found or ended";
    const place = { digest: client.digest, regId: host ? regId : null };
    starting.push(place);
    const unplace = () => starting.includes(place) && starting.splice(starting.indexOf(place), 1);
    let engine = null;
    let entry = null;
    let closeServer = null;
    const inflight = new Map(); // JSON-RPC id -> {wait, started}
    try {
      engine = await engineFor(client, { host, channel });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: false,
        onsessioninitialized: (id) => {
          entry = { id, client, transport, engine, closeServer, last: Date.now(), streams: 0, inflight, regId: host ? regId : null, hook, channel, ending: false };
          sessions.set(id, entry);
          unplace(); // counted as a session from now on
          log(`session ${id.slice(0, 8)} of ${client.label} started`);
        },
      });
      const onCall = (requestId) => {
        const c = inflight.get(String(requestId));
        if (c) c.started = true;
        return () => inflight.delete(String(requestId));
      };
      closeServer = await serve(engine, transport, { onCall, client });
      await transport.handleRequest(req, res, body);
    } finally {
      unplace();
      // Initialization that did not produce a session releases everything it started.
      if (entry) entry.closeServer = closeServer;
      else {
        await closeServer?.().catch(() => {});
        await engine?.stop().catch(() => {});
      }
    }
  }

  /**
   * DELETE: only a valid request ends the session. The engine stops first, while the streams of
   * calls in progress are still open, so that a pending wait answers; then the SDK closes the
   * transport and replies.
   */
  async function closeSession(sid, s, req, res, json) {
    const v = req.headers["mcp-protocol-version"];
    if (v !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(v)) return json(400, `unsupported protocol version ${String(v).slice(0, 40)}`);
    s.ending = true;
    await stopEngine(s);
    await s.transport.handleRequest(req, res);
    await end(sid, "closed by the client");
  }

  /** Stop a session's engine and wait (briefly) until its calls have answered. */
  async function stopEngine(s) {
    await s.engine.stop().catch(() => {});
    for (let i = 0; i < DRAIN_MS / 20 && [...s.inflight.values()].some((c) => c.started); i++) await new Promise((r) => setTimeout(r, 20));
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    let known = null;
    try {
      known = new Set(readClients(clientsFile(home)).clients.map((c) => c.digest));
    } catch {}
    for (const [id, s] of sessions) {
      if (s.ending) continue;
      if (known && !known.has(s.client.digest)) end(id, "client removed");
      else if (!s.ending && !s.streams && !s.inflight.size && now - s.last > idleMs) end(id, "idle"); // a long wait is not idleness
    }
  }, sweepMs).unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  actualPort = server.address().port;
  return {
    port: actualPort,
    sessions: () => [...sessions.entries()].map(([id, s]) => ({ id, client: s.client.label, hook: s.hook, calls: s.inflight.size })),
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map((id) => end(id, "server stopping")));
      await new Promise((r) => server.close(r));
    },
  };
}
