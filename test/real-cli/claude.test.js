// Real-CLI adapter gates for Claude Code headless (design 7.1, "Adapter gates"): MCP isolation
// (--strict-mcp-config with the run's own mcp.json), the task on stdin, and the run marker in the
// MCP process, through the shipped spawn path (spawnAgent -> supervisor -> `claude -p` with
// buildPlan's exact arguments). Opt-in only, and NOT run without the owner's OK:
//   HOPTELL_REAL_CLI=claude npm run test:real-cli
// Sign-in: the run's HOME is temporary, so the CLI signs in only through what the profile passes
// (env.pass): ANTHROPIC_API_KEY, or CLAUDE_CONFIG_DIR pointing at a folder the owner prepared.
// The owner chooses which before this runs; the test never reads or copies ~/.claude.
// Claude Code tmux stays refused until its tmux gates (task through read_task) are written.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readPrivateFile } from "../../lib/agents.js";
import { runPaths } from "../../lib/agentruns.js";
import { spawnAgent } from "../../lib/agentspawn.js";
import { RUN_TOOLS } from "../../lib/mcp.js";
import { DECOY, ended, evidenceDir, gatesUnderTest, realCli, realWorld, requireRealCli, watchProcesses } from "./harness.js";

requireRealCli("claude");
const { command, version } = realCli("claude");
const PASS = ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"].filter((k) => process.env[k]);
if (!PASS.length) throw new Error("the Claude Code gates need a sign-in the owner chose: ANTHROPIC_API_KEY or CLAUDE_CONFIG_DIR (a prepared folder)");
const evidence = evidenceDir(`claude-headless-${version}`);
const summary = { cli: "claude", mode: "headless", version, binaryDigest: crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(command))).digest("hex"), date: new Date().toISOString().slice(0, 10), gates: {} };
const PROFILE = { cli: "claude", env: { pass: PASS }, cliOptions: { effort: "low" }, limits: { lifetimeMinutes: 5, budgetUsd: 1 } };
const RUN_MS = 6 * 60_000;

/** A decoy MCP server everywhere Claude Code would find one: the project's .mcp.json and the user's settings. */
function plantDecoys(s, marker) {
  const server = { command: process.execPath, args: [DECOY, marker] };
  fs.writeFileSync(path.join(s.w.work, ".mcp.json"), JSON.stringify({ mcpServers: { decoy: server } }));
  fs.writeFileSync(path.join(s.w.homedir, ".claude.json"), JSON.stringify({ mcpServers: { decoy: server }, projects: { [s.w.work]: { mcpServers: { decoy: server }, enabledMcpjsonServers: ["decoy"] } } }));
}

/** The process environment values the test hands to the spawner (the run gets env.pass only). */
const passed = () => Object.fromEntries(PASS.map((k) => [k, process.env[k]]));

function keep(label, home, run) {
  const p = runPaths(home, run);
  for (const [f, to] of [[p.output, "output.json"], [p.log, "run.log"], [p.result, "result.txt"]]) {
    try {
      fs.copyFileSync(f, path.join(evidence, `${label}-${to}`));
    } catch {}
  }
}

test.after(() => {
  fs.writeFileSync(path.join(evidence, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`gate evidence: ${evidence}`);
});

test(`claude ${version} headless, MCP isolation, task on stdin and the run marker`, { timeout: RUN_MS + 60_000 }, async (t) => {
  const s = await realWorld(t, { cli: "claude", command, profile: PROFILE, env: passed() });
  const marker = path.join(s.w.base, "decoy-started");
  plantDecoys(s, marker);
  s.ctx.env.HOPTELL_EXPERIMENTAL_E2EE = "1";
  fs.mkdirSync(path.join(s.w.homedir, ".config", "hoptell"), { recursive: true });
  fs.writeFileSync(path.join(s.w.homedir, ".config", "hoptell", ".env"), "HOPTELL_EXPERIMENTAL_E2EE=1\n", { mode: 0o600 });
  s.ctx.deps.gates = gatesUnderTest("claude", "headless", version);
  const stdinNonce = `STDIN-${crypto.randomBytes(6).toString("hex")}`;
  const task = [
    `Gate check. The word ${stdinNonce} is only in this message.`,
    "1. Call the hoptell MCP tool read_task once.",
    `2. Call the hoptell MCP tool send_message once, to "me-owner", with the text: gate ${stdinNonce}`,
    "Then reply with exactly three lines and nothing else:",
    `STDIN=<the STDIN-... word of this message>`,
    "TOOLS=<comma-separated names of every tool the hoptell MCP server offers you>",
    "OTHER=<comma-separated names of MCP tools from any other server, or none>",
  ].join("\n");
  const r = await spawnAgent(s.ctx, { profile: "gate", task });
  assert.equal(r.error, undefined, r.message);
  let done = false;
  const watching = watchProcesses(`mcp --run ${r.run} --home ${s.w.home}`, () => done);
  let rec;
  try {
    rec = await ended(s.w.home, r.run, RUN_MS);
  } finally {
    done = true;
  }
  const servers = await watching;
  keep("headless", s.w.home, r.run);
  const answer = readPrivateFile(runPaths(s.w.home, r.run).result, 65536).bytes?.toString("utf8") ?? "";
  const tools = (answer.match(/^TOOLS=(.*)$/m)?.[1] ?? "").split(",").map((x) => x.trim().replace(/^mcp__hoptell__/, "")).filter(Boolean);
  const g = {
    state: rec.state,
    exit: rec.exit ?? null,
    decoyStarted: fs.existsSync(marker),
    hoptellServer: servers.map((x) => ({ args: x.args.replace(/--home \S+/, "--home <home>"), underAgent: x.ancestry.includes(rec.agent?.pid) })),
    stdinSeen: (answer.match(/^STDIN=(.*)$/m)?.[1] ?? "").includes(stdinNonce),
    // Evidence outside the model's answer: the owner received the message from the run's wire name
    // (the run-only server signed in with the run's settings, so it verified the run).
    sentAsRun: s.inbox.some((m) => m.from === `me-${r.name}` && JSON.stringify(m).includes(stdinNonce)),
    toolsReported: tools,
    otherReported: answer.match(/^OTHER=(.*)$/m)?.[1] ?? null,
    deviceStore: fs.existsSync(path.join(s.w.home, "mls")),
  };
  summary.gates = { mcpIsolation: { ...g, pass: null }, taskOnStdin: { pass: null }, runMarker: { pass: null } };
  assert.equal(rec.state, "exited", `the run ended ${rec.state} (${rec.errorText ?? ""})`);
  assert.equal(g.decoyStarted, false, "a decoy MCP server was started");
  assert.match(g.otherReported ?? "", /^\s*none\s*$/i, "tools of other MCP servers were offered");
  summary.gates.mcpIsolation.pass = true;
  assert.equal(g.stdinSeen, true, "the task did not arrive on stdin");
  summary.gates.taskOnStdin = { pass: true, see: "mcpIsolation run" };
  assert.ok(g.hoptellServer.length >= 1 && g.hoptellServer.every((x) => x.underAgent), `the hoptell server with --run under the agent: ${JSON.stringify(g.hoptellServer)}`);
  assert.equal(g.sentAsRun, true, "no message from the run's wire name reached the owner");
  assert.ok(tools.length > 0 && tools.every((x) => RUN_TOOLS.includes(x)), `tools outside the allow list: ${tools}`);
  assert.equal(g.deviceStore, false, "the device store was opened");
  summary.gates.runMarker = { pass: true, see: "mcpIsolation run", notLive: "test/agents-mcp.test.js: a record that is not live makes `hoptell mcp --run` exit before serving" };
});

test(`claude ${version}, control: without --strict-mcp-config the same CLI starts the decoy server`, { timeout: 5 * 60_000 }, async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-gate-control-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  const marker = path.join(base, "decoy-started");
  const server = { command: process.execPath, args: [DECOY, marker] };
  const cfg = path.join(base, "decoy.json");
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { decoy: server } }));
  const r = spawnSync(command, ["-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", "plan", "--permission-prompts", "none", "--mcp-config", cfg], {
    input: "Reply with the single word OK.",
    cwd: work,
    env: { PATH: process.env.PATH, HOME: base, ...passed() },
    encoding: "utf8",
    timeout: 4 * 60_000,
  });
  summary.gates.isolationControl = { status: r.status, decoyStarted: fs.existsSync(marker) };
  assert.equal(r.status, 0, (r.stderr ?? "").slice(-2000));
  assert.equal(fs.existsSync(marker), true, "the decoy is started when it is configured (otherwise the isolation gate shows nothing)");
});
