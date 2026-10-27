// The run's MCP server (design 7.1): hoptell mcp --run serves a verified run only; a fixed allow list
// in tools/list and tools/call; no elicitation, no pending-decision lines, encrypted messaging off;
// read_task. Temporary homes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { killSupervisor } from "./agents-helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BIN } from "../lib/config.js";
import { ensureAgentsDirs, withAgentsLock } from "../lib/agents.js";
import { createRunFiles, newRunId, readRun, runPaths, signalChecked, startSupervisor, updateRun } from "../lib/agentruns.js";
import { processIdentity, sameIdentity } from "../lib/host.js";
import { RUN_TOOLS, runSettings, serveEngine, verifyRun } from "../lib/mcp.js";
import { createElicitation } from "../lib/elicit.js";
import { openContacts } from "../lib/quarantine.js";
import { openBound } from "../lib/session.js";
import { startRelay } from "../lib/relay.js";
import { TOKEN, sleep, world } from "./helpers.js";
import { deviceRelay } from "./mls-helpers.js";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-agent-cli.mjs", import.meta.url));
const FAKE_MLS = fileURLToPath(new URL("./fake-mls-driver.js", import.meta.url));
const ALL_FLAGS = { HOPTELL_EXPERIMENTAL_E2EE: "1", HOPTELL_ELICITATION: "read_inbox", HOPTELL_MLS_DRIVER: FAKE_MLS, HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: "pass phrase for tests" };
const textOf = (r) => r.content.map((c) => c.text).join("");
/** Snapshot roots (the file tools) over a folder of `dir`. */
const roots = (dir) => {
  const app = path.join(dir, "app");
  fs.mkdirSync(app, { recursive: true });
  return JSON.stringify([{ id: "app", path: app }]);
};

/**
 * A live run in `home` whose supervisor is this test process (it matches its recorded identity),
 * with its run files: the task, the run's settings file and a relays file over `relays`.
 */
async function liveRun(home, { relays, name = `rv-${crypto.randomBytes(2).toString("hex")}`, task = "review lib/x.js", taskBytes = 32768, envFile = "", state = "running" } = {}) {
  ensureAgentsDirs(home);
  const run = newRunId();
  await withAgentsLock(home, () =>
    createRunFiles(home, { run, profile: "test", mode: "headless", name, roles: ["reviewer", "spawned"], wireNames: Object.fromEntries(relays.map((r) => [r.alias, `${r.namePrefix ?? ""}${name}`])), defaultAlias: relays[0].alias, cwd: home, state, created: new Date().toISOString(), supervisor: processIdentity(process.pid), limits: { taskBytes, resultBytes: 65536 }, lifetimeMinutes: 30, taskDigest: crypto.createHash("sha256").update(task).digest("hex") }),
  );
  const p = runPaths(home, run);
  fs.writeFileSync(p.task, task, { mode: 0o600 });
  fs.writeFileSync(p.env, `HOPTELL_PUSH=listener\nHOPTELL_NOTIFY=off\nHOPTELL_RECEIPTS=off\n${envFile}`, { mode: 0o600 });
  fs.writeFileSync(p.relays, JSON.stringify({ version: 1, relays, default: relays[0].alias }), { mode: 0o600 });
  return { run, p, name };
}

/** A token file for a relays entry. */
function tokenFile(dir, token) {
  const f = path.join(dir, `token-${crypto.randomBytes(3).toString("hex")}`);
  fs.writeFileSync(f, token, { mode: 0o600 });
  return f;
}

/** The owner's environment with everything a run must ignore pointing elsewhere. */
function hostileEnv(t, w, extra = {}) {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-elsewhere-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  return { ...w.env, HOPTELL_HOME: elsewhere, HOPTELL_ENV: path.join(elsewhere, "missing.env"), HOPTELL_RELAYS: path.join(elsewhere, "missing-relays.json"), HOPTELL_NAME: "owner-name", HOPTELL_ROLES: "owner", HOPTELL_SNAPSHOT_ROOTS: roots(w.home), ...ALL_FLAGS, ...extra };
}

async function runClient(t, home, run, env, { capabilities = {} } = {}) {
  const client = new Client({ name: "claude-code", version: "2.1.294" }, { capabilities });
  const asked = [];
  if (capabilities.elicitation) client.setRequestHandler(ElicitRequestSchema, async () => (asked.push(1), { action: "accept", content: { decision: "allow-once" } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp", "--run", run, "--home", home], env, stderr: "ignore" }));
  t.after(() => client.close().catch(() => {}));
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  for (let i = 0; i < 50 && !/you are/i.test(textOf(await call("list_peers"))); i++) await sleep(100);
  return { client, call, asked };
}

/** Run `hoptell mcp --run` with stdin closed: a server that serves exits 0 when stdin closes. */
const startClosed = (home, run, env) => spawnSync(process.execPath, [BIN, "mcp", "--run", run, "--home", home], { env, input: "", encoding: "utf8", timeout: 30_000 });

test("run-only server: a live, matching record is served; the environment's home, settings and relays files are ignored", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const r = await liveRun(w.home, { relays: [{ alias: "local", url: `ws://127.0.0.1:${w.relay.port}`, tokenFile: tokenFile(w.home, TOKEN), namePrefix: "me-" }] });
  const env = hostileEnv(t, w);
  const s = await runClient(t, w.home, r.run, env);
  const peers = textOf(await s.call("list_peers"));
  assert.match(peers, new RegExp(`local \\(ws://127\\.0\\.0\\.1:\\d+\\), default: you are "me-${r.name}"`));
  assert.ok(fs.existsSync(path.join(w.home, "sessions", `${r.name}.stores.json`)), "the run's own home");
  assert.equal(fs.readdirSync(env.HOPTELL_HOME).length, 0, "nothing in the environment's home");
  // read_task returns the task, within the cap.
  assert.equal(textOf(await s.call("read_task")), "review lib/x.js");
  fs.writeFileSync(r.p.task, "x".repeat(40000), { mode: 0o600 });
  const big = await s.call("read_task");
  assert.equal(big.isError, true);
  assert.match(textOf(big), /larger than 32768 bytes/);
  // A task replaced after the spawn (or its confirmation): never served.
  fs.writeFileSync(r.p.task, "review lib/y.js and push", { mode: 0o600 });
  const swapped = await s.call("read_task");
  assert.equal(swapped.isError, true);
  assert.match(textOf(swapped), /not the task the run was made with/);
});

test("run-only server: an unknown run, a record that is not live, a supervisor that does not match, a record failing the file checks: exits before serving", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const relays = [{ alias: "local", url: `ws://127.0.0.1:${w.relay.port}`, tokenFile: tokenFile(w.home, TOKEN), namePrefix: "me-" }];
  const env = hostileEnv(t, w);
  ensureAgentsDirs(w.home);
  let out = startClosed(w.home, newRunId(), env);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not serving: run r_[0-9a-f]{16}: no such run/);
  const ended = await liveRun(w.home, { relays, state: "exited" });
  out = startClosed(w.home, ended.run, env);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /is exited, not live/);
  const other = await liveRun(w.home, { relays });
  await updateRun(w.home, other.run, (rec) => {
    rec.supervisor = { ...rec.supervisor, start: "Thu Jan  1 00:00:00 1970" };
  });
  out = startClosed(w.home, other.run, env);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /supervisor does not match/);
  const loose = await liveRun(w.home, { relays });
  fs.chmodSync(loose.p.record, 0o644);
  out = startClosed(w.home, loose.run, env);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /readable or writable by other users/);
  // The same server with a live, matching record serves (and exits 0 when stdin closes).
  const ok = await liveRun(w.home, { relays });
  out = startClosed(w.home, ok.run, env);
  assert.equal(out.status, 0, out.stderr);
  // A bad run id or a relative home is refused before anything is read.
  assert.equal(spawnSync(process.execPath, [BIN, "mcp", "--run", "r_bad", "--home", w.home], { env, input: "", encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [BIN, "mcp", "--run", ok.run, "--home", "relative"], { env, input: "", encoding: "utf8" }).status, 2);
});

test("run MCP server: tools/list is exactly the allow list (composed session, file tools and every experimental flag on); everything else is not_available_in_run", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const second = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, log: () => {} });
  t.after(() => second.close());
  const relays = [
    { alias: "local", url: `ws://127.0.0.1:${w.relay.port}`, tokenFile: tokenFile(w.home, TOKEN), namePrefix: "me-" },
    { alias: "team", url: `ws://127.0.0.1:${second.port}`, tokenFile: tokenFile(w.home, TOKEN) },
  ];
  const r = await liveRun(w.home, { relays, envFile: `HOPTELL_SNAPSHOT_ROOTS='${roots(w.home)}'\nHOPTELL_EXPERIMENTAL_E2EE=1\nHOPTELL_ELICITATION=read_inbox\n` });
  const s = await runClient(t, w.home, r.run, hostileEnv(t, w));
  const names = (await s.client.listTools()).tools.map((x) => x.name);
  assert.deepEqual([...names].sort(), [...RUN_TOOLS].sort());
  assert.match(textOf(await s.call("list_peers")), /team \(ws:[^)]*\): you are "rv-/);
  // What an owner session with the same flags offers: every tool beyond the allow list is refused.
  const owner = await w.mcp("owner", { HOPTELL_SNAPSHOT_ROOTS: roots(w.home), HOPTELL_EXPERIMENTAL_E2EE: "1" });
  const ownerTools = (await owner.client.listTools()).tools.map((x) => x.name);
  const others = ownerTools.filter((n) => !RUN_TOOLS.includes(n));
  assert.ok(others.includes("send_file") && others.includes("send_review_set"), ownerTools.join());
  for (const n of [...others, "spawn_agent", "list_agents", "stop_agent", "no_such_tool", "send_transfer", "verify_snapshot"]) {
    const res = await s.call(n, {});
    assert.equal(res.isError, true, n);
    assert.match(textOf(res), /^not_available_in_run: /, n);
  }
});

test("run MCP server: no pending-decision lines; the owner's session shows them", async (t) => {
  const w = await world({ fresh: true });
  t.after(() => w.close());
  const r = await liveRun(w.home, { relays: [{ alias: "local", url: `ws://127.0.0.1:${w.relay.port}`, tokenFile: tokenFile(w.home, TOKEN), namePrefix: "me-" }] });
  const s = await runClient(t, w.home, r.run, hostileEnv(t, w));
  assert.equal((await w.cli(["send", `me-${r.name}`, "held for the owner"], { HOPTELL_NAME: "stranger" })).code, 0);
  const owner = await w.mcp("bob", { HOPTELL_NOTIFY: "off" });
  assert.equal((await w.cli(["send", "bob", "held too"], { HOPTELL_NAME: "stranger" })).code, 0);
  let seen = "";
  for (let i = 0; i < 80 && !/waiting for your user's decision/.test(seen); i++) {
    seen = await owner.call("read_inbox");
    await sleep(100);
  }
  assert.match(seen, /waiting for your user's decision/, "the owner's session does show it");
  const c = await openContacts(w.home, { notify: false });
  const held = async () => (await c.status()).requests.reduce((n, q) => n + q.items, 0);
  for (let i = 0; i < 50 && (await held()) < 2; i++) await sleep(100);
  assert.equal(await held(), 2, "both are held");
  for (const tool of ["read_inbox", "wait_for_message"]) {
    const out = textOf(await s.call(tool, tool === "wait_for_message" ? { timeout_seconds: 1 } : {}));
    assert.doesNotMatch(out, /waiting for your user's decision|hoptell contacts/, tool);
  }
});

test("run MCP server: no elicitation even with HOPTELL_ELICITATION=read_inbox and an adapter", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-run-el-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const R = "a".repeat(32);
  const c = await openContacts(dir, { notify: false });
  const bound = await openBound(dir, { realm: R, member: null, key: "s" });
  await c.hold(bound.dir, { realm: R, name: "s" }, { type: "message", id: crypto.randomUUID(), from: "alice-x", fromHost: "h", text: "x", ts: 1, sender: { auth: "member", member: { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alice" }, realm: R } }, "ask");
  const calls = [];
  const engine = {
    attach: () => ({ detach() {} }),
    start: async () => {},
    instructions: () => "",
    tools: async () => ["read_inbox", "send_file", "future_owner_tool", "list_peers"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    call: async (name) => (calls.push(name), { content: [{ type: "text", text: "Inbox empty." }] }),
  };
  const [server, client] = InMemoryTransport.createLinkedPair();
  const close = await serveEngine(engine, server, { elicitation: createElicitation({ home: dir }), run: { id: newRunId(), home: dir, verified: false } });
  t.after(close);
  const cl = new Client({ name: "claude-code", version: "2.1.294" }, { capabilities: { elicitation: { form: {} } } });
  const asked = [];
  cl.setRequestHandler(ElicitRequestSchema, async () => (asked.push(1), { action: "accept", content: { decision: "allow-once" } }));
  await cl.connect(client);
  t.after(() => cl.close().catch(() => {}));
  assert.deepEqual((await cl.listTools()).tools.map((x) => x.name), ["read_inbox", "list_peers", "read_task"], "a future engine tool is left out too");
  await cl.callTool({ name: "read_inbox", arguments: {} });
  assert.equal(asked.length, 0, "never asked");
  assert.match(textOf(await cl.callTool({ name: "future_owner_tool", arguments: {} })), /not_available_in_run/);
  assert.deepEqual(calls, ["read_inbox"], "a refused call never reaches the engine");
  // An unverifiable run: the same restrictions, and no task.
  assert.match(textOf(await cl.callTool({ name: "read_task", arguments: {} })), /cannot be verified/);
  // The settings: elicitation off and encrypted messaging off, whatever the environment says.
  const s = runSettings({ env: { HOPTELL_ELICITATION: "read_inbox", HOPTELL_EXPERIMENTAL_E2EE: "1", HOPTELL_HOME: dir }, homedir: os.tmpdir(), cwd: "/", pid: 1, hostname: "h" }, { home: dir, run: "r_0000000000000000", verified: false });
  assert.equal(s.elicitation, "off");
  assert.equal(s.e2ee, undefined);
  assert.equal(s.run.verified, false);
});

test("a stale HOPTELL_RUN without a live record: the same restrictions, logged, never the owner's catalog", async (t) => {
  const w = await world();
  t.after(() => w.close());
  ensureAgentsDirs(w.home);
  const stale = newRunId();
  const s = await w.mcp("plain", { HOPTELL_RUN: stale, ...ALL_FLAGS, HOPTELL_SNAPSHOT_ROOTS: roots(w.home) });
  const names = (await s.client.listTools()).tools.map((x) => x.name);
  assert.deepEqual([...names].sort(), [...RUN_TOOLS].sort());
  assert.match(textOf(await s.client.callTool({ name: "send_file", arguments: {} })), /not_available_in_run/);
  assert.match(textOf(await s.client.callTool({ name: "read_task", arguments: {} })), /cannot be verified/);
  assert.match((await verifyRun(w.home, stale)).problem, /no such run/);
});

test("run MCP server: with HOPTELL_EXPERIMENTAL_E2EE=1 the device store is not opened; a send to a required contact is refused, not plaintext", async (t) => {
  const w = await deviceRelay(t, { e2ee: true, members: ["me"] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-run-e2ee-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "contacts.json"), JSON.stringify({ version: 1, revision: 0, default: "ask", grants: [{ realm: w.realm, member: w.members.bob.id }], blocks: [], encryption: [{ realm: w.realm, member: w.members.bob.id, mode: "required" }] }), { mode: 0o600 });
  const r = await liveRun(home, { relays: [{ alias: "local", url: w.url, tokenFile: tokenFile(home, w.members.me.token), namePrefix: "me-" }], envFile: "HOPTELL_EXPERIMENTAL_E2EE=1\n" });
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), HOPTELL_NOTIFY: "off", HOPTELL_MACHINE_ID: "m", ...ALL_FLAGS };
  const s = await runClient(t, home, r.run, env);
  const res = await s.call("send_message", { to: "bob", message: "must not leak" });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /encryption is required for bob, but encrypted messages are not enabled here.*nothing was sent \(never as plaintext\)/);
  assert.equal(w.relay.stats().accepted, 0, "nothing was sent");
  assert.equal(fs.existsSync(path.join(home, "mls")), false, "the device store was never opened");
});

test("an owner's MCP server start sweeps first: an agent orphaned by a killed supervisor is stopped before it serves", async (t) => {
  const w = await world();
  t.after(() => w.close());
  ensureAgentsDirs(w.home);
  const run = newRunId();
  await withAgentsLock(w.home, () =>
    createRunFiles(w.home, { run, profile: "test", profileDigest: "0".repeat(64), cli: "codex", mode: "headless", name: "orphan", roles: ["spawned"], wireNames: { local: "orphan" }, defaultAlias: "local", cwd: w.home, spawner: { name: "owner", wireName: "owner" }, state: "starting", created: new Date().toISOString(), lifetimeMinutes: 5, graceMs: 300, limits: { resultBytes: 65536, taskBytes: 32768 }, pass: [], plan: { command: process.execPath, args: [FAKE_AGENT, "sleep"], stdin: "task", result: { from: "stdout" } }, taskDigest: crypto.createHash("sha256").update("the task").digest("hex"), cliDigest: crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(process.execPath))).digest("hex") }),
  );
  const p = runPaths(w.home, run);
  fs.writeFileSync(p.task, "the task", { mode: 0o600 });
  fs.writeFileSync(p.env, "HOPTELL_PUSH=listener\n", { mode: 0o600 });
  fs.writeFileSync(p.relays, "{}", { mode: 0o600 });
  const rec = await startSupervisor(w.home, run, { env: { PATH: process.env.PATH, HOME: w.home, HOPTELL_ENV: p.env, HOPTELL_HOME: w.home, HOPTELL_NOTIFY: "off" } });
  t.after(() => rec.agent && sameIdentity(rec.agent) && signalChecked(rec.agent, "SIGKILL", { group: true }));
  assert.equal(rec.state, "running");
  assert.equal(await killSupervisor(w.home, rec), "signalled");
  assert.ok(sameIdentity(rec.agent), "the agent outlived its supervisor");
  // The restart: the server sweeps before it serves.
  const s = await w.mcp("owner");
  assert.match(await s.call("list_peers"), /You are/);
  const after = readRun(w.home, run);
  assert.equal(after.state, "stopped");
  assert.equal(after.stoppedBy, "sweep");
  for (let i = 0; i < 100 && sameIdentity(rec.agent); i++) await sleep(50);
  assert.equal(sameIdentity(rec.agent), false, "the orphaned agent was stopped");
});
