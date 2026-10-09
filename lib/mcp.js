// hoptell MCP server over stdio: a thin front end for one engine (lib/engine.js).
//
// Delivery of incoming messages: the engine picks one way per session (channel, hook, tmux or
// listener). Messages always go to the local inbox first; a channel or hook notice only
// announces them, and the agent reads them with read_inbox. This front end supplies the
// channel notice (it needs the MCP connection), passes tool calls through unchanged, and owns
// the process: stdin close and signals stop the engine, then exit.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ROOT, defaultHome } from "./config.js";
import { createEngine } from "./engine.js";
import { bootstrap, readSettings } from "./settings.js";

const log = (...a) => console.error("[hoptell]", ...a); // stdout is the MCP stream
const STOP_LIMIT_MS = 2000; // the process exits even if stopping takes longer

/**
 * Connect `engine` to an MCP client over `transport` (stdio or HTTP): the tools, the channel
 * notice and the catalog updates. Returns close(), which detaches and closes the MCP server (the
 * caller stops the engine).
 */
export async function serveEngine(engine, transport, { front = "stdio", onCall = null } = {}) {
  let mcp = null;
  const handle = engine.attach({
    // A channel notification is fire-and-forget: the client may drop it silently (channels
    // disabled, policy), so it only announces the message; read_inbox delivers it. The notice
    // carries no peer text, only the relay-verified sender name and host.
    notify: async (m) => {
      if (engine.delivery.mode !== "channel" || !mcp) return;
      const host = m.fromHost || "unknown";
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: `New hoptell message from "${m.from}" on ${host}. Call the hoptell read_inbox tool to read it.`, meta: { from: m.from, from_host: host } },
        });
      } catch (e) {
        log("channel notice failed; the message waits in the inbox:", e.message);
      }
    },
    onCatalogChanged: () => mcp?.sendToolListChanged().catch(() => {}),
  });
  await engine.start();
  mcp = new Server(
    { name: "hoptell", version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version },
    { capabilities: { tools: { listChanged: true }, experimental: { "claude/channel": {} } }, instructions: engine.instructions() },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await engine.tools() }));
  // The request's cancellation signal goes along (a cancelled read gives its messages back).
  // `onCall(requestId)` (MCP over HTTP: per-session quotas) runs when a call's handler starts and
  // returns the function that runs when it has settled, whatever happens to its connection.
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const settled = onCall?.(extra?.requestId);
    try {
      return await engine.call(params.name, params.arguments ?? {}, { front, signal: extra?.signal ?? null });
    } finally {
      settled?.();
    }
  });
  await mcp.connect(transport);
  return async () => {
    handle.detach();
    await mcp.close().catch(() => {});
  };
}

/** Serve `engine` over stdio until the client goes away. */
export async function runStdio(engine) {
  const close = await serveEngine(engine, new StdioServerTransport());

  // Exit with the client; an orphan would keep the peer name connected. A clean exit gives the
  // name back (protocol 2 release) before the process ends.
  let ending = false;
  const shutdown = () => {
    if (ending) return;
    ending = true;
    setTimeout(() => process.exit(0), STOP_LIMIT_MS).unref();
    close().finally(() => engine.stop().finally(() => process.exit(0)));
  };
  process.stdin.on("close", shutdown);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);
}

/**
 * The session for these settings: one engine (one relay, today's behavior), or a composed
 * session over several relays when a relays file exists (design 2.1). `receiptsAlways` (MCP over
 * HTTP, where a response can be lost with its connection): without a relays file the one relay
 * is composed too, so that every read is held under a receipt until it is acknowledged, on
 * protocol 1 and with receipts off as well.
 */
export async function createSession(settings, boot, deps = {}, { receiptsAlways = false } = {}) {
  const explicit = settings.relaysExplicit;
  if (!explicit && !fs.existsSync(settings.relaysFile)) {
    if (!receiptsAlways || !settings.relay) return createEngine(settings, { log, ...deps });
    const { createComposer } = await import("./composer.js");
    const r = settings.relay;
    const entry = { alias: "default", url: r.url, auth: r.auth, token: r.token, tokenProblem: settings.errors.relay ?? null, profile: r.profile, join: true, name: null, namePrefix: null };
    return createComposer(settings, { relays: [entry], default: "default", problems: [] }, { log, ...deps });
  }
  const { readRelaysFile } = await import("./relays.js");
  const { createComposer } = await import("./composer.js");
  const relays = readRelaysFile(settings.relaysFile, { env: boot.env, homedir: boot.homedir });
  for (const p of relays.problems) log(`relay ${p.alias}: ${p.problem}`);
  return createComposer(settings, relays, { log, ...deps });
}

/** `hoptell mcp` */
export async function runMcp() {
  const boot = bootstrap();
  await runStdio(await createSession(readSettings(boot), boot));
}

/**
 * The session of one MCP-over-HTTP client session. The client record decides the peer name and
 * roles, never the server's own settings: a record without a name gets an automatic one from the
 * relay. Reads are always held under receipts (createSession receiptsAlways). The channel only
 * when the client negotiated it at initialize.
 */
export function httpSessions(boot) {
  return (client, { host = null, channel = false } = {}) => {
    const env = { ...boot.env, HOPTELL_NAME: client.name ?? "", HOPTELL_ROLES: (client.roles ?? []).join(",") };
    // Protocol 1 has no relay-assigned names, and the automatic one (host-pid) is the same for
    // every session of this server: each unnamed session gets its own tag in it, kept for all its
    // links, reconnects and a fallback from protocol 2 (the settings of its engines never change).
    const settings = { ...readSettings({ ...boot, env }), ...(client.name ? {} : { autoTag: crypto.randomBytes(4).toString("hex") }) };
    return createSession(settings, { ...boot, env }, { findHost: () => host, allowChannel: channel }, { receiptsAlways: true });
  };
}

/**
 * `hoptell mcp-http`: MCP over HTTP on 127.0.0.1 (design 2.3). Each session gets its own engine,
 * named and with roles from its client record. Hook wake-ups need the session's Claude Code
 * process, which an HTTP session does not reveal; such sessions use channel notices or polling.
 */
export async function runMcpHttp({ port } = {}) {
  const { startMcpHttp, DEFAULT_PORT } = await import("./httpmcp.js");
  const boot = bootstrap();
  const { hostOfRegistration } = await import("./wake.js");
  const home = defaultHome(boot.env, boot.homedir);
  // Each session's engine finds its Claude Code host only through its registration (option B).
  // One logical session per MCP session: the composed one over several relays when a relays file
  // exists (design 2.1), else the single-relay engine.
  const engineFor = httpSessions(boot);
  const h = await startMcpHttp({ home, port: port ?? DEFAULT_PORT, engineFor, serve: (e, t, o) => serveEngine(e, t, { front: "http", ...o }), log, hostOf: (id) => hostOfRegistration(home, id) });
  log(`MCP over HTTP at http://127.0.0.1:${h.port}/mcp (clients: hoptell mcp-http client add <label>)`);
  let ending = false;
  const shutdown = () => {
    if (ending) return;
    ending = true;
    setTimeout(() => process.exit(0), STOP_LIMIT_MS * 2).unref();
    h.close().finally(() => process.exit(0));
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);
}
