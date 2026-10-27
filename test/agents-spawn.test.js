// Spawning agents (design 7.1): spawn_agent's checks and error codes, the run's files and
// environment, the supervisor's name probe and result delivery, limits under the agents lock,
// owner confirmation (decision kind "spawn"), list_agents / stop_agent, the audit, and where the
// tools are registered. Temporary homes only; the agent is a stand-in for codex
// (fixtures/fake-codex.mjs); real CLIs are never run here.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BIN } from "../lib/config.js";
import { RelayClient } from "../lib/client.js";
import { agentsPaths, ensureAgentsDirs, readAudit, readProfile, withAgentsLock, writeApproved } from "../lib/agents.js";
import { createRunFiles } from "../lib/agentruns.js";
import { ENDED, newRunId, readRun, runPaths, signalChecked, sweep, updateRun } from "../lib/agentruns.js";
import { agentTools, discardPending, listAgents, spawnAgent, startConfirmed, stopAgent, supervisorEnv } from "../lib/agentspawn.js";
import { agentsCommand } from "../lib/agentscli.js";
import * as decisions from "../lib/decisions.js";
import { addClient, startMcpHttp } from "../lib/httpmcp.js";
import { RUN_TOOLS, httpServe, httpSessions, serveEngine } from "../lib/mcp.js";
import { gateShape } from "../lib/agentadapters.js";
import { contactsFile, freshContacts, validateContacts } from "../lib/contacts.js";
import { processIdentity, sameIdentity } from "../lib/host.js";
import { agentsWorld, gatedStart, profileDoc, writeProfile } from "./agents-helpers.js";
import { sleep, world } from "./helpers.js";
import { deviceRelay } from "./mls-helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
/**
 * The Codex headless gates as if they had passed on the test's fake codex (its launcher digest;
 * no native binary) as 0.162.1 and 0.162.9, with the read-only argument shape.
 */
const passedFor = (command) => {
  const launcher = crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(command))).digest("hex");
  const shape = gateShape({ cli: "codex", sandbox: "read-only", limits: {} }, "headless");
  return { codex: { headless: { passed: { binaries: ["0.162.1", "0.162.9"].map((version) => ({ version, launcher, native: null })), shapes: [shape] }, family: "0.162", refusal: "adapter_gate_unverified" }, tmux: { passed: null, refusal: "mcp_isolation_unverified" } } };
};
const SPAWN_TOOLS = ["spawn_agent", "list_agents", "stop_agent"];

async function approve(w, id) {
  const digest = readProfile(w.home, id, { homedir: w.homedir }).digest;
  await withAgentsLock(w.home, () => writeApproved(w.home, id, digest));
}

/**
 * A run that counts as live without a real agent: its "supervisor" is a sleeping process of this
 * test (never the test process itself, which a stop or a sweep would signal).
 */
async function fakeStart(home, run) {
  const child = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
  child.unref();
  let id = null;
  for (let i = 0; i < 100 && !(id = processIdentity(child.pid)); i++) await sleep(10);
  return updateRun(home, run, (r) => {
    r.state = "running";
    r.supervisor = id;
  });
}

/**
 * A home with an approved codex profile whose command is the stand-in, a relay with member "me",
 * the owner's relays file (the local entry with namePrefix "me-", and a "lab" entry that is not
 * granted), and the owner's session "me-owner" on the relay.
 */
async function spawnWorld(t, { profile = {}, entry = {}, approved = true } = {}) {
  let w = null;
  // Registered first, so it runs before the home is removed: stop any agent a test left running,
  // by exact pid after the identity check.
  t.after(() => {
    for (const f of fs.readdirSync(agentsPaths(w.home).runs).filter((x) => x.endsWith(".json"))) {
      const r = readRun(w.home, f.slice(0, -5));
      for (const id of [r?.agent, r?.supervisor]) if (id && id.pid !== process.pid && sameIdentity(id)) signalChecked(id, "SIGKILL", { group: true });
    }
  });
  const relay = await deviceRelay(t, { members: ["me"], devices: false });
  w = agentsWorld(t);
  const token = path.join(w.base, "me.token");
  fs.writeFileSync(token, relay.members.me.token, { mode: 0o600 });
  const relaysFile = path.join(w.base, "relays.json");
  fs.writeFileSync(relaysFile, JSON.stringify({ version: 1, relays: [{ alias: "local", url: relay.url, tokenFile: "me.token", namePrefix: "me-", installId: "i-test", ...entry }, { alias: "lab", url: relay.url, tokenFile: token, name: "fixed-name" }], default: "local" }), { mode: 0o600 });
  const logs = path.join(w.base, "calls");
  fs.mkdirSync(logs);
  fs.mkdirSync(path.join(w.base, "bin"));
  const codex = path.join(w.base, "bin", "codex");
  fs.writeFileSync(codex, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${logs}' "$@"\n`, { mode: 0o755 });
  writeProfile(w.home, profileDoc(w.work, { command: codex, ...profile }));
  if (approved) await approve(w, "codex-reviewer");
  const owner = new RelayClient({ url: relay.url, token: relay.members.me.token, name: "me-owner", mode: "peer", reconnect: false });
  const inbox = [];
  owner.on("message", (m, confirm) => {
    inbox.push(m);
    confirm();
  });
  owner.start();
  await owner.ready();
  t.after(() => owner.close());
  const links = new Map([["local", { wireName: "me-owner", peers: () => owner.list() }]]);
  const ctx = {
    caller: "test-caller", // the spawning tools' capability (agentTools makes a random one)
    home: w.home,
    homedir: w.homedir,
    env: { PATH: process.env.PATH, HOME: w.homedir, HOPTELL_TOKEN: "never-for-a-run", HOPTELL_RELAY: "ws://never.example", OTHER_SECRET: "never-either" },
    relaysFile,
    agentsMax: 4,
    spawner: { name: "owner", roles: ["lead"], front: "stdio", client: null },
    links,
    deps: { check: () => ({ version: "0.162.1", untested: false }), gates: passedFor(codex), hoptell: { node: process.execPath, bin: BIN } },
  };
  ctx.deps.start = gatedStart(w.home, ctx.deps.gates);
  return { w, relay, ctx, inbox, owner, logs, codex, token, relaysFile, gates: ctx.deps.gates };
}

async function ended(home, run, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const r = readRun(home, run);
    if (r && ENDED.includes(r.state) && !(r.supervisor && sameIdentity(r.supervisor))) return r;
  }
  throw new Error(`run ${run} did not end: ${readRun(home, run)?.state}`);
}
const calls = (logs) => fs.readdirSync(logs).map((f) => JSON.parse(fs.readFileSync(path.join(logs, f), "utf8")));

test("spawn, headless: the stand-in gets the task on stdin only; the result comes back from the run's wire name, is kept and listed", async (t) => {
  const s = await spawnWorld(t);
  const task = `review lib/x.js ${crypto.randomBytes(4).toString("hex")}`;
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task });
  assert.equal(r.error, undefined, r.message);
  assert.match(r.name, /^codex-rev-[0-9a-f]{4}$/);
  assert.equal(r.mode, "headless");
  assert.equal(r.resultTo, "me-owner");
  assert.ok(["running", "exited"].includes(r.state), r.state);
  const rec = await ended(s.ctx.home, r.run);
  assert.equal(rec.state, "exited");
  assert.deepEqual(rec.wireNames, { local: `me-${r.name}` });
  assert.deepEqual(rec.roles, ["reviewer", "spawned"]);
  assert.equal(fs.readFileSync(runPaths(s.ctx.home, r.run).result, "utf8"), `answer: ${task}`);
  // Delivered from the run's wire name, with the fixed header.
  for (let i = 0; i < 100 && !s.inbox.length; i++) await sleep(50);
  const m = s.inbox.find((x) => x.from === `me-${r.name}`);
  assert.ok(m, JSON.stringify(s.inbox));
  assert.match(m.text, new RegExp(`^hoptell agent run ${r.run}, profile codex-reviewer: exited \\(exit code 0\\)\\.`));
  assert.match(m.text, /never your user's approval/);
  assert.ok(m.text.endsWith(`answer: ${task}`));
  assert.equal(readRun(s.ctx.home, r.run).delivery.to, "me-owner");
  // The stand-in: the task never in its arguments; the run-only server with --run; no caller settings.
  const [call] = calls(s.logs);
  assert.ok(!JSON.stringify(call.args).includes(task));
  assert.deepEqual(call.args.slice(0, 2), ["exec", "--ignore-user-config"]);
  assert.ok(call.args.some((a) => a.includes(`"--run", "${r.run}"`)));
  assert.equal(call.args.at(-1), "-");
  assert.equal(call.cwd, fs.realpathSync(s.w.work));
  assert.equal(call.env.HOPTELL_RUN, r.run);
  for (const k of ["HOPTELL_TOKEN", "HOPTELL_RELAY", "OTHER_SECRET"]) assert.equal(call.env[k], undefined, k);
  // The run's settings files are gone; task, result, output and log stay.
  const p = runPaths(s.ctx.home, r.run);
  for (const f of [p.relays, p.env, p.mcp]) assert.equal(fs.existsSync(f), false, f);
  for (const f of [p.task, p.result, p.output, p.log]) assert.ok(fs.existsSync(f), f);
  // list_agents and the audit.
  assert.deepEqual((await listAgents(s.ctx.home)).map((x) => x.run), []);
  const all = await listAgents(s.ctx.home, { state: "all" });
  assert.equal(all[0].resultBytes, `answer: ${task}`.length);
  assert.deepEqual(all[0].exit, { code: 0, signal: null });
  const events = readAudit(s.ctx.home, { run: r.run }).map((e) => e.event);
  assert.deepEqual(events, ["spawn-requested", "started", "ended"]);
  const requested = readAudit(s.ctx.home).find((e) => e.event === "spawn-requested");
  assert.equal(requested.taskDigest, crypto.createHash("sha256").update(task).digest("hex"));
  assert.equal(requested.spawner.name, "owner");
  assert.ok(!fs.readFileSync(agentsPaths(s.ctx.home).audit, "utf8").includes(task), "no task text in the audit");
});

test("spawn: the run's relays file has only the granted aliases; the supervisor's environment has no caller settings; an unreachable spawner keeps the result", async (t) => {
  const s = await spawnWorld(t);
  const gate = path.join(s.w.base, "go");
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: `WAIT:${gate}` });
  assert.equal(r.error, undefined, r.message);
  const p = runPaths(s.ctx.home, r.run);
  const relays = JSON.parse(fs.readFileSync(p.relays, "utf8"));
  assert.deepEqual(relays, { version: 1, relays: [{ alias: "local", url: s.relay.url, tokenFile: s.token, namePrefix: "me-", join: true }], default: "local" });
  assert.equal(fs.statSync(p.relays).mode & 0o777, 0o600);
  const env = fs.readFileSync(p.env, "utf8");
  assert.doesNotMatch(env, /TOKEN|never/);
  assert.match(env, new RegExp(`HOPTELL_NAME="${r.name}"`));
  assert.match(env, /^HOPTELL_CONTACTS_SELF=allow$/m, "the spawner's own-member setting (the default)");
  const sup = supervisorEnv(s.ctx.env, s.ctx.home, { run: r.run, name: r.name, roles: ["spawned"], pass: [] });
  for (const k of ["HOPTELL_TOKEN", "HOPTELL_RELAY", "OTHER_SECRET"]) assert.equal(sup[k], undefined, k);
  assert.equal(sup.HOPTELL_RELAYS, p.relays);
  // The spawner becomes unreachable: the relay token goes away before the run answers.
  fs.rmSync(s.token);
  fs.writeFileSync(gate, "");
  const rec = await ended(s.ctx.home, r.run);
  assert.equal(rec.state, "exited");
  assert.equal(rec.delivery.state, "undelivered");
  const listed = (await listAgents(s.ctx.home, { state: "all" })).find((x) => x.run === r.run);
  assert.equal(listed.delivery.state, "undelivered");
  const out = [];
  await agentsCommand({ args: ["result", r.run], home: s.ctx.home, env: {}, homedir: s.w.homedir, out: (l) => out.push(l), fail: (m) => assert.fail(m) });
  assert.match(out[0], /exited \(exit code 0\).*delivery: undelivered/);
  assert.equal(out[1], `answer: WAIT:${gate}`);
});

test("spawn: a wire name the relay's member rule refuses fails the spawn with name_not_allowed before the agent starts", async (t) => {
  const s = await spawnWorld(t, { entry: { namePrefix: undefined } });
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "x" });
  assert.equal(r.error, "name_not_allowed", JSON.stringify(r));
  assert.match(r.message, /relay "local" refused the name "codex-rev-[0-9a-f]{4}"/);
  assert.deepEqual(calls(s.logs), [], "the agent never started");
  const rec = (await listAgents(s.ctx.home, { state: "all" }))[0];
  assert.equal(rec.state, "failed");
  assert.equal(rec.error, "name_not_allowed");
});

test("spawn: each refusal has its own code and is audited without the task", async (t) => {
  const s = await spawnWorld(t);
  const ctx = { ...s.ctx, deps: { ...s.ctx.deps, start: fakeStart } };
  const code = async (args, c = ctx) => (await spawnAgent(c, { profile: "codex-reviewer", task: "secret task text", ...args })).error;
  assert.equal(await code({ profile: "nope" }), "unknown_profile");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "broken", sandbox: "full" }));
  assert.equal(await code({ profile: "broken" }), "profile_invalid");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "fresh", command: s.codex }));
  assert.equal(await code({ profile: "fresh" }), "profile_not_approved");
  await approve(s.w, "fresh");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "fresh", command: s.codex, description: "edited" }));
  assert.equal(await code({ profile: "fresh" }), "profile_not_approved", "changed since approved");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "bosses", command: s.codex, spawners: { names: ["boss"], roles: ["admin"] } }));
  await approve(s.w, "bosses");
  assert.equal(await code({ profile: "bosses" }), "not_allowed_spawner");
  assert.equal(await code({ profile: "bosses" }, { ...ctx, spawner: { ...ctx.spawner, name: "boss" } }), undefined, "by name");
  assert.equal(await code({ profile: "bosses" }, { ...ctx, spawner: { ...ctx.spawner, roles: ["admin"] } }), undefined, "by role");
  assert.equal(await code({ mode: "tmux" }), "mode_not_in_profile");
  assert.equal(await code({ cwd: s.w.base }), "cwd_outside_roots");
  assert.equal(await code({ cwd: "work" }), "cwd_outside_roots", "relative");
  fs.symlinkSync(s.w.base, path.join(s.w.work, "out"));
  assert.equal(await code({ cwd: path.join(s.w.work, "out") }), "cwd_outside_roots", "a symlink out of the root");
  assert.equal(await code({ roles: ["admin"] }), "profile_invalid", "roles beyond the profile's");
  assert.equal(await code({ name: "other-1" }), "name_invalid");
  assert.equal(await code({ name: "codex-rev-" }), "name_invalid");
  assert.equal(await code({ name: `codex-rev-${"x".repeat(54)}` }), "name_invalid", "65+ characters on the wire: no truncation");
  const squatter = new RelayClient({ url: s.relay.url, token: s.relay.members.me.token, name: "me-codex-rev-used", mode: "peer", reconnect: false });
  squatter.start();
  await squatter.ready();
  t.after(() => squatter.close());
  assert.equal(await code({ name: "codex-rev-used" }), "name_in_use");
  assert.equal(await code({ task: "x".repeat(32769) }), "task_too_large");
  assert.equal(await code({}, { ...ctx, links: new Map() }), "spawner_not_local");
  assert.equal(await code({}, { ...ctx, relaysFile: path.join(s.w.base, "none.json") }), "local_relay_missing");
  const other = path.join(s.w.base, "other.json");
  fs.writeFileSync(other, JSON.stringify({ version: 1, relays: [{ alias: "lab", url: s.relay.url, tokenFile: s.token }] }), { mode: 0o600 });
  assert.equal(await code({}, { ...ctx, relaysFile: other }), "local_relay_missing");
  assert.equal(await code({}, { ...ctx, env: { ...ctx.env, PATH: "/nowhere" } }), undefined, "an absolute command does not need PATH");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "nobin", command: path.join(s.w.base, "missing") }));
  await approve(s.w, "nobin");
  assert.equal(await code({ profile: "nobin" }), "cli_missing");
  assert.equal(await code({}, { ...ctx, deps: { ...ctx.deps, check: () => ({ code: "cli_flags_changed", missing: ["-o"], version: "0.163.0" }) } }), "cli_flags_changed");
  assert.equal(await code({}, { ...ctx, deps: { ...ctx.deps, gates: undefined, check: () => ({ version: "0.161.0", untested: true }) } }), "adapter_gate_unverified", "the shipped gates: a family that has not passed");
  assert.equal(await code({}, { ...ctx, deps: { ...ctx.deps, check: () => ({ version: "0.170.0", untested: true }) } }), "adapter_gate_unverified", "another version family");
  // Bound to the gated binary and arguments: another launcher digest, another native binary, or
  // an argument shape the gates did not run with is refused, whatever the version says.
  assert.equal(await code({}, { ...ctx, deps: { ...ctx.deps, gates: undefined } }), "adapter_gate_unverified", "the shipped gates: not the recorded launcher");
  const moved = structuredClone(ctx.deps.gates);
  moved.codex.headless.passed.binaries = moved.codex.headless.passed.binaries.map((b) => ({ ...b, launcher: "0".repeat(64) }));
  assert.equal(await code({}, { ...ctx, deps: { ...ctx.deps, gates: moved } }), "adapter_gate_unverified", "the launcher digest differs");
  assert.equal(await code({}, { ...ctx, deps: { ...ctx.deps, check: () => ({ version: "0.162.1", native: "f".repeat(64), untested: false }) } }), "adapter_gate_unverified", "the native binary differs");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "writer", command: s.codex, sandbox: "workspace-write", name: { prefix: "writer" } }));
  await approve(s.w, "writer");
  assert.equal(await code({ profile: "writer" }), "adapter_gate_unverified", "workspace-write: an argument shape that was not gated");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "tuned", command: s.codex, cliOptions: { model: "gpt-x", effort: "high" }, name: { prefix: "tuned" } }));
  await approve(s.w, "tuned");
  assert.equal(await code({ profile: "tuned" }), undefined, "model and effort are gate-neutral slots");
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "tmuxed", command: s.codex, modes: ["tmux"] }));
  await approve(s.w, "tmuxed");
  assert.equal(await code({ profile: "tmuxed" }), "mcp_isolation_unverified");
  // Every refusal is audited, without the task text.
  const refused = readAudit(s.w.home).filter((e) => e.event === "spawn-refused");
  assert.ok(refused.length >= 20);
  assert.ok(refused.every((e) => e.error && e.taskDigest !== undefined));
  assert.ok(!fs.readFileSync(agentsPaths(s.w.home).audit, "utf8").includes("secret task text"));
});

test("spawn: a failure while writing the run's files ends the record failed; nothing is left live", async (t) => {
  const s = await spawnWorld(t);
  const ctx = { ...s.ctx, deps: { ...s.ctx.deps, start: fakeStart, writeRunFiles: () => assert.fail("disk full") } };
  const r = await spawnAgent(ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, "failed");
  assert.match(r.message, /disk full/);
  const [rec] = await listAgents(s.w.home, { state: "all" });
  assert.equal(rec.state, "failed");
  assert.deepEqual(await listAgents(s.w.home), []);
});

test("limits: concurrent spawns racing for the last slot (exactly one wins); the home's limit; the hourly rate across a restart", async (t) => {
  const s = await spawnWorld(t, { profile: { limits: { concurrent: 1, perHour: 3 } } });
  const ctx = { ...s.ctx, deps: { ...s.ctx.deps, start: fakeStart } };
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => spawnAgent(ctx, { profile: "codex-reviewer", task: "t" })));
  assert.equal(all.filter((r) => !r.error).length, 1, JSON.stringify(all));
  assert.ok(all.filter((r) => r.error).every((r) => r.error === "limit_concurrent"));
  const first = all.find((r) => !r.error);
  // A live run with the same name (the relay does not know it yet): name_in_use.
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "second", command: s.codex, name: { prefix: "codex-rev" } }));
  await approve(s.w, "second");
  assert.equal((await spawnAgent(ctx, { profile: "second", task: "t", name: first.name })).error, "name_in_use");
  // The home's limit (HOPTELL_AGENTS_MAX).
  assert.equal((await spawnAgent({ ...ctx, agentsMax: 1 }, { profile: "second", task: "t" })).error, "limit_concurrent");
  // An invalid HOPTELL_AGENTS_MAX refuses the spawn (it is not replaced by the default limit).
  const invalidMax = await spawnAgent({ ...ctx, agentsMax: null, agentsMaxProblem: 'HOPTELL_AGENTS_MAX must be a whole number from 1 to 16, not "0"' }, { profile: "second", task: "t" });
  assert.equal(invalidMax.error, "limit_concurrent");
  assert.match(invalidMax.message, /HOPTELL_AGENTS_MAX must be a whole number from 1 to 16, not "0"; nothing was started/);
  // The hourly rate counts records, also ended ones, and holds for a new server (a new context).
  await updateRun(s.w.home, first.run, (r) => {
    r.state = "stopped";
  });
  for (let i = 0; i < 2; i++) {
    const r = await spawnAgent(ctx, { profile: "codex-reviewer", task: "t" });
    assert.equal(r.error, undefined, r.message);
    await updateRun(s.w.home, r.run, (x) => void (x.state = "exited"));
  }
  const restarted = { ...ctx, links: new Map(ctx.links) };
  assert.equal((await spawnAgent(restarted, { profile: "codex-reviewer", task: "t" })).error, "limit_rate");
  // An hour later the rate allows again.
  assert.equal((await spawnAgent({ ...restarted, deps: { ...restarted.deps, now: () => Date.now() + 3_601_000 } }, { profile: "codex-reviewer", task: "t" })).error, undefined);
});

test("spawn: the run's settings file carries the spawner's HOPTELL_CONTACTS_SELF, not the environment's; an invalid value starts nothing", async (t) => {
  const s = await spawnWorld(t, { profile: { confirm: "always" } });
  const r = await spawnAgent({ ...s.ctx, contactsSelf: "hold", env: { ...s.ctx.env, HOPTELL_CONTACTS_SELF: "allow" } }, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.state, "pending-confirmation", r.message);
  const p = runPaths(s.ctx.home, r.run);
  assert.match(fs.readFileSync(p.env, "utf8"), /^HOPTELL_CONTACTS_SELF=hold$/m);
  assert.equal(supervisorEnv({ ...s.ctx.env, HOPTELL_CONTACTS_SELF: "allow" }, s.ctx.home, { run: r.run, name: r.name, roles: ["spawned"], pass: [] }).HOPTELL_CONTACTS_SELF, undefined, "never from the spawner's environment");
  const bad = await spawnAgent({ ...s.ctx, contactsSelf: "maybe" }, { profile: "codex-reviewer", task: "t" });
  assert.equal(bad.error, "failed");
  assert.match(bad.message, /HOPTELL_CONTACTS_SELF must be allow or hold/);
});

test("confirmation: pending-confirmation, the view, a stale token after a profile edit, discard, start, expiry", async (t) => {
  const s = await spawnWorld(t, { profile: { confirm: "always" } });
  const sources = { agents: { homedir: s.w.homedir, env: s.ctx.env, surface: "test", deps: { start: fakeStart, gates: s.gates, check: s.ctx.deps.check } } };
  const task = "a task for the owner to read\nsecond line";
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task });
  assert.equal(r.state, "pending-confirmation");
  assert.deepEqual(calls(s.logs), []);
  const listed = await decisions.list({ home: s.w.home, kinds: ["spawn"] });
  assert.deepEqual(listed.map((x) => x.id), [`spawn:${r.run}`]);
  let shown = await decisions.show({ home: s.w.home, id: `spawn:${r.run}`, sources });
  assert.equal(shown.view.task, task, "the task in full");
  assert.match(shown.view.commandLine, /codex exec --ignore-user-config .* - < task$/);
  assert.equal(shown.view.spawner, "owner");
  assert.deepEqual(shown.actions.map((a) => a.action), ["start", "discard"]);
  // The profile is edited (and approved again): the old token is stale, and this spawn cannot start.
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, confirm: "always", description: "edited" }));
  await approve(s.w, "codex-reviewer");
  const stale = await decisions.decide({ home: s.w.home, id: `spawn:${r.run}`, action: "start", token: shown.token, sources });
  assert.equal(stale.stale, true);
  shown = await decisions.show({ home: s.w.home, id: `spawn:${r.run}`, sources });
  assert.deepEqual(shown.actions.map((a) => a.action), ["discard"]);
  assert.match((await decisions.decide({ home: s.w.home, id: `spawn:${r.run}`, action: "start", token: shown.token, sources })).reason, /cannot start/);
  const d = await decisions.decide({ home: s.w.home, id: `spawn:${r.run}`, action: "discard", token: shown.token, sources });
  assert.equal(d.done, true);
  assert.equal(readRun(s.w.home, r.run).state, "discarded");
  assert.equal(fs.existsSync(runPaths(s.w.home, r.run).relays), false);
  // Start from the CLI.
  const r2 = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "second" });
  const out = [];
  const cli = (args) => agentsCommand({ args, home: s.w.home, env: s.ctx.env, homedir: s.w.homedir, out: (l) => out.push(l), fail: (m) => assert.fail(m), sources: { deps: { start: fakeStart, gates: s.gates, check: s.ctx.deps.check } } });
  await cli(["confirm", r2.run]);
  assert.ok(out.includes("second"), "the CLI shows the task");
  assert.ok(out.some((l) => l.startsWith("Command line: ")));
  assert.equal(readRun(s.w.home, r2.run).state, "pending-confirmation", "showing decides nothing");
  await cli(["confirm", r2.run, "--start"]);
  assert.equal(readRun(s.w.home, r2.run).state, "running");
  const ev = readAudit(s.w.home).filter((e) => ["confirmed", "discarded"].includes(e.event)).map((e) => [e.event, e.run, e.surface]);
  assert.deepEqual(ev, [["discarded", r.run, "test"], ["confirmed", r2.run, "cli"]]);
  await stopAgent(s.w.home, r2.run, "test", { caller: s.ctx.caller });
  // Expiry: refused once expired; the sweep discards it after an hour.
  const r3 = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "third" });
  await updateRun(s.w.home, r3.run, (x) => {
    x.pendingUntil = new Date(Date.now() - 1000).toISOString();
    x.created = new Date(Date.now() - 3_700_000).toISOString();
  });
  shown = await decisions.show({ home: s.w.home, id: `spawn:${r3.run}`, sources });
  assert.match((await decisions.decide({ home: s.w.home, id: `spawn:${r3.run}`, action: "start", token: shown.token, sources })).reason, /expired/);
  assert.equal(fs.existsSync(runPaths(s.w.home, r3.run).relays), true, "a pending run keeps its relays file");
  await sweep(s.w.home);
  assert.equal(readRun(s.w.home, r3.run).state, "discarded");
  assert.equal(fs.existsSync(runPaths(s.w.home, r3.run).relays), false, "an expired pending run's settings files are removed");
  // A pending run stopped (stop_agent, hoptell agents stop) is discarded and its settings files go too.
  const r4 = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "fourth" });
  assert.equal(fs.existsSync(runPaths(s.w.home, r4.run).relays), true);
  await stopAgent(s.w.home, r4.run, "test", { caller: s.ctx.caller });
  assert.equal(readRun(s.w.home, r4.run).state, "discarded");
  assert.equal(fs.existsSync(runPaths(s.w.home, r4.run).relays), false, "a stopped pending run's settings files are removed");
  // An expired run that another process moves on first (under the lock) is not claimed by the sweep.
  const r5 = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "fifth" });
  await updateRun(s.w.home, r5.run, (x) => {
    x.created = new Date(Date.now() - 3_700_000).toISOString();
  });
  let swept;
  await withAgentsLock(s.w.home, async () => {
    swept = sweep(s.w.home); // it lists the run as pending, then waits for the lock
    const file = runPaths(s.w.home, r5.run).record;
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), state: "discarded", stoppedBy: "other" }));
  });
  const changed = await swept;
  assert.equal(changed.some((c) => c.run === r5.run), false, "a lost race is not reported as a discard");
  assert.equal(readRun(s.w.home, r5.run).stoppedBy, "other");
  assert.equal(readAudit(s.w.home).some((e) => e.event === "discarded" && e.run === r5.run && e.by === "expiry"), false, "nor audited as an expiry");
});

test("confirmation: the start rechecks under the lock what the owner saw: profile digest and approval, expiry, the gate and the task bytes", async (t) => {
  const s = await spawnWorld(t, { profile: { confirm: "always" } });
  let started = 0;
  const start = async (home, run) => {
    started++;
    return fakeStart(home, run);
  };
  const go = (run, deps = {}) => startConfirmed(s.w.home, run, { env: s.ctx.env, homedir: s.w.homedir, deps: { start, gates: s.gates, check: s.ctx.deps.check, ...deps } });
  const pending = async () => {
    const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "the task the owner read" });
    assert.equal(r.state, "pending-confirmation", r.message);
    return r.run;
  };
  const refusedWith = async (run, code, message, deps) => {
    const r = await go(run, deps);
    assert.equal(r.error, code, r.message);
    assert.match(r.message, message);
    assert.equal(readRun(s.w.home, run).state, "pending-confirmation", "nothing moved");
    await discardPending(s.w.home, run);
  };
  // The profile edited and approved again after the owner's view: the old plan never starts.
  let run = await pending();
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, confirm: "always", description: "edited" }));
  await approve(s.w, "codex-reviewer");
  await refusedWith(run, "profile_not_approved", /changed or is no longer approved/);
  // Its approval withdrawn (another digest approved).
  run = await pending();
  await withAgentsLock(s.w.home, () => writeApproved(s.w.home, "codex-reviewer", "0".repeat(64)));
  await refusedWith(run, "profile_not_approved", /changed or is no longer approved/);
  await approve(s.w, "codex-reviewer");
  // Past pendingUntil.
  run = await pending();
  await updateRun(s.w.home, run, (x) => {
    x.pendingUntil = new Date(Date.now() - 1).toISOString();
  });
  await refusedWith(run, "failed", /expired/);
  // A gate rolled back (the shipped gates) after the spawn was recorded.
  run = await pending();
  await refusedWith(run, "adapter_gate_unverified", /adapter gates have not passed/, { gates: { codex: { headless: { passed: null, refusal: "adapter_gate_unverified" }, tmux: { passed: null, refusal: "mcp_isolation_unverified" } } } });
  // The task replaced after the owner read it.
  run = await pending();
  fs.writeFileSync(runPaths(s.w.home, run).task, "another task", { mode: 0o600 });
  await refusedWith(run, "failed", /not the one the spawn was made with/);
  assert.equal(started, 0, "nothing was started");
  // The owner's view never shows a replaced task.
  run = await pending();
  fs.writeFileSync(runPaths(s.w.home, run).task, "another task", { mode: 0o600 });
  const sources = { agents: { homedir: s.w.homedir, env: s.ctx.env, surface: "test", deps: { start, gates: s.gates, check: s.ctx.deps.check } } };
  const shown = await decisions.show({ home: s.w.home, id: `spawn:${run}`, sources });
  assert.equal(shown.view.task, null);
  assert.match(shown.view.taskProblem, /not the one the spawn was made with/);
  assert.deepEqual(shown.actions.map((a) => a.action), ["discard"]);
  await discardPending(s.w.home, run);
  // Everything as it was: it starts.
  run = await pending();
  const ok = await go(run);
  assert.equal(ok.error, undefined, ok.message);
  assert.equal(started, 1);
  await stopAgent(s.w.home, run, "test", { caller: s.ctx.caller });
});

test("confirmation: the CLI is checked again (version, help, digest) and bound to the run; the audit writes confirmed only after the start moved, confirm-refused otherwise", async (t) => {
  const s = await spawnWorld(t, { profile: { confirm: "always" } });
  let started = 0;
  const start = async (home, run) => {
    started++;
    return fakeStart(home, run);
  };
  let seen = { version: "0.162.1", untested: false };
  const sources = { agents: { homedir: s.w.homedir, env: s.ctx.env, surface: "test", deps: { start, gates: s.gates, check: () => seen } } };
  const decide = async (run) => {
    const shown = await decisions.show({ home: s.w.home, id: `spawn:${run}`, sources });
    return decisions.decide({ home: s.w.home, id: `spawn:${run}`, action: "start", token: shown.token, sources });
  };
  const digestOf = () => crypto.createHash("sha256").update(fs.readFileSync(s.codex)).digest("hex");
  const events = (run) => readAudit(s.w.home, { run }).filter((e) => ["confirmed", "confirm-refused"].includes(e.event));
  const pending = async () => {
    const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "the task" });
    assert.equal(r.state, "pending-confirmation", r.message);
    assert.equal(readRun(s.w.home, r.run).cliDigest, digestOf(), "the checked file's digest is recorded at the request");
    return r.run;
  };
  // Upgraded out of the gated version family while the spawn waited: refused, audited with the reason.
  let run = await pending();
  seen = { version: "0.170.0", untested: true };
  let d = await decide(run);
  assert.match(d.reason, /adapter_gate_unverified/);
  assert.equal(readRun(s.w.home, run).state, "pending-confirmation");
  assert.deepEqual(events(run).map((e) => [e.event, e.error, e.surface]), [["confirm-refused", "adapter_gate_unverified", "test"]]);
  assert.match(events(run)[0].reason, /version 0\.170\.0/);
  // A flag the adapter relies on is gone from the new binary's help.
  seen = { code: "cli_flags_changed", missing: ["--sandbox"], version: "0.162.2" };
  d = await decide(run);
  assert.match(d.reason, /cli_flags_changed: codex no longer lists --sandbox/);
  assert.deepEqual(events(run).map((e) => e.error), ["adapter_gate_unverified", "cli_flags_changed"]);
  await discardPending(s.w.home, run);
  // The file replaced by another one with the same version and help: not the gated binary (its
  // launcher digest), so refused.
  run = await pending();
  fs.appendFileSync(s.codex, "# replaced\n");
  seen = { version: "0.162.1", untested: false };
  d = await decide(run);
  assert.match(d.reason, /adapter_gate_unverified: codex in headless mode is not available on this binary/);
  // Once the gates name that binary, the run is bound to what was checked now.
  sources.agents.deps.gates = passedFor(s.codex);
  seen = { version: "0.162.9", untested: true };
  d = await decide(run);
  assert.equal(d.done, true, d.reason);
  const rec = readRun(s.w.home, run);
  assert.equal(rec.cliDigest, digestOf(), "the digest of the file checked at the confirmation");
  assert.equal(rec.cliVersion, "0.162.9");
  assert.equal(rec.cliVersionUntested, true);
  assert.deepEqual(events(run).map((e) => [e.event, e.error ?? e.decision, e.surface]), [["confirm-refused", "adapter_gate_unverified", "test"], ["confirmed", `spawn:${run}`, "test"]]);
  assert.equal(started, 1);
  await stopAgent(s.w.home, run, "test", { caller: s.ctx.caller });
});

test("the CLI file checked at the spawn is the one that runs: replaced before the supervisor starts it, the run fails cli_changed and nothing runs", async (t) => {
  const s = await spawnWorld(t);
  const r = await spawnAgent({ ...s.ctx, deps: { ...s.ctx.deps, start: async (home, run) => readRun(home, run) } }, { profile: "codex-reviewer", task: "x" });
  assert.equal(r.error, undefined, r.message);
  const rec = readRun(s.w.home, r.run);
  assert.equal(rec.cliDigest, crypto.createHash("sha256").update(fs.readFileSync(s.codex)).digest("hex"));
  fs.appendFileSync(s.codex, "# replaced after the check\n");
  const started = await s.ctx.deps.start(s.w.home, r.run, { env: supervisorEnv(s.ctx.env, s.w.home, { ...rec, pass: rec.pass ?? [] }) });
  const end = started.state === "failed" ? started : await ended(s.w.home, r.run);
  assert.equal(end.state, "failed");
  assert.equal(end.error, "cli_changed");
  assert.match(end.errorText, /changed since it was checked/);
  assert.deepEqual(calls(s.logs), [], "the CLI never ran");
});

test("spawn: a Codex run outside a Git work tree is refused up front (cwd_not_git_repo); hoptell never passes --skip-git-repo-check", async (t) => {
  const s = await spawnWorld(t);
  const plain = path.join(s.w.base, "plain");
  fs.mkdirSync(path.join(plain, "sub"), { recursive: true });
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "two-roots", command: s.codex, folders: { roots: [s.w.work, plain], default: s.w.work } }));
  await approve(s.w, "two-roots");
  const r = await spawnAgent(s.ctx, { profile: "two-roots", task: "x", cwd: path.join(plain, "sub") });
  assert.equal(r.error, "cwd_not_git_repo");
  assert.match(r.message, /not in one/);
  assert.deepEqual(calls(s.logs), [], "the CLI never ran");
  // A bare ".git" folder is not a work tree to Git, so it is still refused.
  fs.mkdirSync(path.join(plain, ".git"));
  assert.equal((await spawnAgent(s.ctx, { profile: "two-roots", task: "x", cwd: path.join(plain, "sub") })).error, "cwd_not_git_repo");
  fs.rmSync(path.join(plain, ".git"), { recursive: true });
  // Inside a work tree (git init in a parent folder) it starts.
  execFileSync("git", ["init", "-q", plain], { stdio: "ignore" });
  const ok = await spawnAgent({ ...s.ctx, deps: { ...s.ctx.deps, start: fakeStart } }, { profile: "two-roots", task: "x", cwd: path.join(plain, "sub") });
  assert.equal(ok.error, undefined, ok.message);
  await stopAgent(s.w.home, ok.run, "test", { caller: s.ctx.caller });
  for (const a of Object.values(JSON.parse(fs.readFileSync(new URL("./fixtures/agent-adapter-plans.json", import.meta.url), "utf8")))) assert.ok(!JSON.stringify(a).includes("--skip-git-repo-check"));
});

test("an untested CLI version of a passed family starts with the warning: the run log, the audit and list_agents", async (t) => {
  const s = await spawnWorld(t);
  const ctx = { ...s.ctx, deps: { ...s.ctx.deps, check: () => ({ version: "0.162.9", untested: true }) } };
  const r = await spawnAgent(ctx, { profile: "codex-reviewer", task: "x" });
  assert.equal(r.error, undefined, r.message);
  await ended(s.w.home, r.run);
  const listed = (await listAgents(s.w.home, { state: "all" }))[0];
  assert.equal(listed.cliVersionUntested, true);
  assert.equal(listed.cliVersion, "0.162.9");
  assert.equal(readAudit(s.w.home, { run: r.run }).find((e) => e.event === "started").cliVersionUntested, true);
  assert.match(fs.readFileSync(runPaths(s.w.home, r.run).log, "utf8"), /warning: codex 0\.162\.9 is a version the adapter's tests have not covered/);
});

test("stop_agent and list_agents: a stop goes through the identity check; only the spawning session's runs", async (t) => {
  const s = await spawnWorld(t);
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "SLEEP" });
  assert.equal(r.error, undefined, r.message);
  assert.deepEqual((await listAgents(s.w.home)).map((x) => [x.run, x.state, x.spawner]), [[r.run, "running", "owner"]]);
  // Another session (another capability), none, or a record without one: refused, nothing signalled.
  for (const caller of ["other-session", undefined]) {
    const no = await stopAgent(s.w.home, r.run, "other", { caller });
    assert.equal(no.error, "not_spawner", JSON.stringify(no));
    assert.match(no.message, /was not started by this session; your user can stop it with hoptell agents stop r_/);
  }
  assert.equal(readRun(s.w.home, r.run).state, "running");
  const st = await stopAgent(s.w.home, r.run, "owner", { caller: s.ctx.caller });
  assert.ok(["stopping", "stopped"].includes(st.state), st.state);
  const rec = await ended(s.w.home, r.run);
  assert.equal(rec.state, "stopped");
  assert.equal(rec.stoppedBy, "owner");
  assert.equal(sameIdentity(rec.agent), false);
  assert.equal((await stopAgent(s.w.home, "r_0000000000000000", "owner", { caller: s.ctx.caller })).error, "failed");
});

// ---- where the tools are registered ----------------------------------------------------------------

const toolNames = async (client) => (await client.listTools()).tools.map((x) => x.name);

test("registration: stdio only with a profile at start; never in a run's server, even with profiles", async (t) => {
  const w = await world();
  t.after(() => w.close());
  let s = await w.mcp("plain");
  assert.ok(!(await toolNames(s.client)).some((n) => SPAWN_TOOLS.includes(n)), "no profile: no spawn tools");
  ensureAgentsDirs(w.home);
  writeProfile(w.home, profileDoc(w.home, { folders: { roots: ["/tmp"], default: "/tmp" } }));
  s = await w.mcp("owner");
  const names = await toolNames(s.client);
  for (const n of SPAWN_TOOLS) assert.ok(names.includes(n), n);
  assert.equal(await s.call("list_agents"), "[]");
  assert.match(await s.call("spawn_agent", { profile: "codex-reviewer", task: "x" }), /profile_not_approved/);
  const run = await w.mcp("in-run", { HOPTELL_RUN: newRunId() });
  assert.deepEqual((await toolNames(run.client)).sort(), [...RUN_TOOLS].sort());
  assert.match((await run.client.callTool({ name: "spawn_agent", arguments: {} })).content[0].text, /not_available_in_run/);
});

test("registration: loopback HTTP only for clients added with --agents", async (t) => {
  const w = await world();
  t.after(() => w.close());
  ensureAgentsDirs(w.home);
  writeProfile(w.home, profileDoc(w.home, { folders: { roots: ["/tmp"], default: "/tmp" } }));
  const boot = { env: w.env, homedir: w.home, cwd: w.home, pid: process.pid, hostname: "testhost" };
  const h = await startMcpHttp({ home: w.home, port: 0, engineFor: httpSessions(boot), serve: httpServe(boot) });
  t.after(() => h.close());
  const connect = async (token) => {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    t.after(() => c.close().catch(() => {}));
    return c;
  };
  const plain = await addClient(w.home, "plain", { name: "plain-http" });
  const agents = await addClient(w.home, "spawner", { name: "spawner-http", agents: true });
  assert.ok(!(await toolNames(await connect(plain.token))).some((n) => SPAWN_TOOLS.includes(n)));
  const names = await toolNames(await connect(agents.token));
  for (const n of SPAWN_TOOLS) assert.ok(names.includes(n), n);
});

test("registration: a hosted or broker front never gets the tools, even when passed", async () => {
  const engine = { attach: () => ({ detach() {} }), start: async () => {}, instructions: () => "", tools: async () => [{ name: "list_peers", inputSchema: { type: "object" } }], call: async () => ({ content: [] }), delivery: { mode: "listener" } };
  const agents = { tools: [{ name: "spawn_agent", inputSchema: { type: "object" } }], has: (n) => n === "spawn_agent", call: async () => assert.fail("never called") };
  for (const front of ["hosted", "broker"]) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const close = await serveEngine(engine, a, { front, agents });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    assert.deepEqual(await toolNames(c), ["list_peers"], front);
    await c.close();
    await close();
  }
});

test("a spawn's pending decision is not touched by peer messages: only the owner's decide changes it", async (t) => {
  const s = await spawnWorld(t, { profile: { confirm: "always" } });
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "x" });
  const shown = await decisions.show({ home: s.w.home, id: `spawn:${r.run}`, sources: { agents: { homedir: s.w.homedir } } });
  // A peer (any session of the member) sends the decision's id and token as text.
  const peer = await s.relay.client("me", { session: "me-peer" });
  await peer.send("me-owner", `hoptell agents confirm ${r.run} --start ${shown.token}`);
  for (let i = 0; i < 100 && !s.inbox.length; i++) await sleep(20);
  assert.equal(s.inbox.length, 1);
  assert.equal(readRun(s.w.home, r.run).state, "pending-confirmation");
  assert.deepEqual(calls(s.logs), []);
  // A run record created for a different home is not this home's to start.
  const other = agentsWorld(t);
  assert.ok((await decisions.show({ home: other.home, id: `spawn:${r.run}` })).refused);
});

test("list_agents never waits on a run: a supervisor past the lifetime is not signalled from it; a run whose processes are all gone is marked lost", async (t) => {
  const w = agentsWorld(t);
  // A "supervisor" that ignores SIGTERM: the full sweep would ask it and wait for it.
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
  child.unref();
  let sup = null;
  for (let i = 0; i < 100 && !(sup = processIdentity(child.pid)); i++) await sleep(10);
  t.after(() => sameIdentity(sup) && signalChecked(sup, "SIGKILL", { group: true }));
  const gone = { pid: 999999, start: "Thu Jan  1 00:00:00 1970", uid: process.getuid(), boot: "x" };
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const busy = newRunId();
  const orphan = newRunId();
  await withAgentsLock(w.home, () => {
    createRunFiles(w.home, { run: busy, profile: "p", mode: "headless", name: "busy-1", state: "running", created: past, ends: past, supervisor: sup, agent: gone });
    createRunFiles(w.home, { run: orphan, profile: "p", mode: "headless", name: "orphan-1", state: "running", created: past, ends: past, supervisor: gone, agent: gone });
  });
  const t0 = Date.now();
  const listed = await listAgents(w.home, { state: "all" });
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(listed.find((x) => x.run === busy).state, "running", "left to the full sweep");
  assert.equal(listed.find((x) => x.run === orphan).state, "lost");
  assert.ok(sameIdentity(sup), "not signalled");
});

test("the run's relays file: a granted entry's fixed name is not copied; the run's own wire name is used", async (t) => {
  const s = await spawnWorld(t, { profile: { relays: ["local", "lab"] } });
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.state, "pending-confirmation", "a remote relay: confirm by default");
  const doc = JSON.parse(fs.readFileSync(runPaths(s.w.home, r.run).relays, "utf8"));
  assert.deepEqual(doc.relays.map((e) => e.alias), ["local", "lab"]);
  const lab = doc.relays.find((e) => e.alias === "lab");
  assert.equal(lab.name, undefined, "the owner's fixed name is not copied");
  assert.deepEqual(Object.keys(lab).sort(), ["alias", "join", "tokenFile", "url"]);
  assert.deepEqual(readRun(s.w.home, r.run).wireNames, { local: `me-${r.name}`, lab: r.name });
});

// ---- the encryption policy for the own member (design 7.1, "Encryption policy") -------------------

/** The home's contacts policy with these encryption entries (a new file: every reader sees it). */
function writeEncryption(home, encryption) {
  const doc = { ...freshContacts(), revision: Date.now(), encryption };
  assert.deepEqual(validateContacts(doc), []);
  const f = contactsFile(home);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}
/** spawnWorld with the spawner's link scope (realm, member) filled in, as linksOf gives it. */
async function scopedWorld(t, opts) {
  const s = await spawnWorld(t, opts);
  Object.assign(s.ctx.links.get("local"), { realm: s.owner.realm.id, member: s.owner.member.id });
  s.required = () => writeEncryption(s.w.home, [{ realm: s.owner.realm.id, mode: "required" }]);
  s.override = () => writeEncryption(s.w.home, [{ realm: s.owner.realm.id, mode: "required" }, { realm: s.owner.realm.id, member: s.owner.member.id, mode: "off" }]);
  return s;
}

test("encryption required for the own member: spawn_agent is refused (encryption_required, audited, nothing started); the member's off entry restores it", async (t) => {
  const s = await scopedWorld(t);
  s.required();
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "under required" });
  assert.equal(r.error, "encryption_required", JSON.stringify(r));
  assert.match(r.message, /plaintext peer message through the relay, and your encryption policy for your own member requires end-to-end encryption; nothing was started/);
  assert.deepEqual(await listAgents(s.w.home, { state: "all" }), [], "no record");
  assert.equal(readAudit(s.w.home).at(-1).event, "spawn-refused");
  assert.equal(readAudit(s.w.home).at(-1).error, "encryption_required");
  s.override();
  const ok = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "with the override" });
  assert.equal(ok.error, undefined, ok.message);
  const rec = await ended(s.w.home, ok.run);
  assert.equal(rec.resultScope.member, s.owner.member.id);
  for (let i = 0; i < 100 && !s.inbox.some((m) => m.from === `me-${ok.name}`); i++) await sleep(50);
  assert.ok(s.inbox.some((m) => m.from === `me-${ok.name}` && m.text.endsWith("answer: with the override")), "delivered");
});

test("encryption required set while a spawn waits for confirmation: the confirmation refuses; a record without its scope is stopped at the start, before the agent runs", async (t) => {
  const s = await scopedWorld(t, { profile: { confirm: "always" } });
  const go = (run) => startConfirmed(s.w.home, run, { env: s.ctx.env, homedir: s.w.homedir, deps: { start: s.ctx.deps.start, gates: s.gates, check: s.ctx.deps.check } });
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "confirm me" });
  assert.equal(r.state, "pending-confirmation", r.message);
  s.required();
  const refused = await go(r.run);
  assert.equal(refused.error, "encryption_required", JSON.stringify(refused));
  assert.match(refused.message, /the run was not started/);
  assert.equal(readRun(s.w.home, r.run).state, "pending-confirmation", "nothing moved");
  // The start's own check (the run's token signed in on the result's relay): a record that does
  // not carry the scope passes the confirmation, and the supervisor fails it before the agent.
  await updateRun(s.w.home, r.run, (x) => void delete x.resultScope);
  const started = await go(r.run);
  assert.equal(started.error, "encryption_required", JSON.stringify(started));
  const rec = await ended(s.w.home, r.run);
  assert.equal(rec.state, "failed");
  assert.equal(rec.error, "encryption_required");
  assert.deepEqual(calls(s.logs), [], "the agent never started");
  // The override: a new pending spawn starts.
  s.override();
  const again = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "confirm me again" });
  const ok = await go(again.run);
  assert.equal(ok.error, undefined, ok.message);
  await ended(s.w.home, again.run);
});

test("encryption required set during a run: the result is not sent; the record, the audit and the result's notes give the reason; hoptell agents result reads it", async (t) => {
  const s = await scopedWorld(t);
  const gate = path.join(s.w.base, "go");
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: `WAIT:${gate}` });
  assert.equal(r.error, undefined, r.message);
  s.required();
  fs.writeFileSync(gate, "");
  const rec = await ended(s.w.home, r.run);
  await sleep(300);
  assert.equal(rec.state, "exited");
  assert.deepEqual(readRun(s.w.home, r.run).delivery, { state: "suppressed", to: "me-owner", reason: "encryption_required" });
  assert.equal(s.inbox.some((m) => m.from === `me-${r.name}`), false, "nothing reached the spawner");
  const audited = readAudit(s.w.home, { run: r.run }).find((e) => e.event === "delivery-suppressed");
  assert.equal(audited?.reason, "encryption_required");
  assert.ok(readRun(s.w.home, r.run).result.notes.some((n) => /not sent: .*requires end-to-end encryption; read it with hoptell agents result/.test(n)));
  const out = [];
  await agentsCommand({ args: ["result", r.run], home: s.w.home, env: {}, homedir: s.w.homedir, out: (l) => out.push(l), fail: (m) => assert.fail(m) });
  assert.match(out[0], /notes: .*requires end-to-end encryption.*; delivery: suppressed \(encryption_required\)/);
  assert.equal(out[1], `answer: WAIT:${gate}`);
});

test("a managed contacts policy that cannot be read: spawn_agent is refused (fail closed) and a running run's result is not sent", async (t) => {
  const s = await scopedWorld(t);
  writeEncryption(s.w.home, []);
  fs.writeFileSync(contactsFile(s.w.home), "{invalid JSON", { mode: 0o600 });
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "under a broken policy" });
  assert.equal(r.error, "encryption_required", JSON.stringify(r));
  assert.match(r.message, /^the contacts cannot be read \(.*contacts\.json is not valid JSON\), so the encryption policy for a run's plaintext result cannot be checked; nothing was started$/);
  assert.deepEqual(await listAgents(s.w.home, { state: "all" }), [], "no record");
  writeEncryption(s.w.home, []);
  const gate = path.join(s.w.base, "go-broken");
  const ok = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: `WAIT:${gate}` });
  assert.equal(ok.error, undefined, ok.message);
  fs.writeFileSync(contactsFile(s.w.home), "{invalid JSON", { mode: 0o600 });
  fs.writeFileSync(gate, "");
  await ended(s.w.home, ok.run);
  await sleep(300);
  assert.equal(readRun(s.w.home, ok.run).delivery?.state, "suppressed");
  assert.equal(s.inbox.some((m) => m.from === `me-${ok.name}`), false, "nothing reached the spawner");
  assert.ok(readRun(s.w.home, ok.run).result.notes.some((n) => /not sent: the contacts cannot be read \(.*contacts\.json is not valid JSON\)/.test(n)));
});

test("stop_agent through the tools: each session's capability is its own; hoptell agents stop stops any run", async (t) => {
  const s = await spawnWorld(t);
  // Two owner sessions' tools over the same relay links (a stand-in for the engine's session).
  const session = { links: [...s.ctx.links].map(([alias, l]) => ({ alias, engine: { link: { status: () => ({ name: l.wireName, realm: l.realm ? { id: l.realm } : null }), scope: () => ({ realm: l.realm, member: l.member }), list: l.peers } } })) };
  const a = agentTools({ ...s.ctx, caller: undefined, session });
  const b = agentTools({ ...s.ctx, caller: undefined, session });
  const spawned = await a.call("spawn_agent", { profile: "codex-reviewer", task: "SLEEP" });
  assert.equal(spawned.isError, undefined, spawned.content[0].text);
  const { run } = JSON.parse(spawned.content[0].text);
  assert.match(readRun(s.w.home, run).spawner.caller, /^[0-9a-f]{64}$/, "a digest, not the capability");
  const other = await b.call("stop_agent", { run });
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /^not_spawner: run r_\w+ was not started by this session/);
  assert.equal(readRun(s.w.home, run).state, "running", "nothing signalled");
  const own = await a.call("stop_agent", { run });
  assert.equal(own.isError, undefined, own.content[0].text);
  assert.equal((await ended(s.w.home, run)).state, "stopped");
  // A run recorded without a capability (spawned before this version): only the CLI stops it.
  const old = await spawnAgent({ ...s.ctx, caller: undefined }, { profile: "codex-reviewer", task: "SLEEP" });
  assert.equal((await a.call("stop_agent", { run: old.run })).isError, true);
  await agentsCommand({ args: ["stop", old.run], home: s.w.home, env: {}, homedir: s.w.homedir, out: () => {}, fail: (m) => assert.fail(m) });
  assert.equal((await ended(s.w.home, old.run)).state, "stopped");
});
