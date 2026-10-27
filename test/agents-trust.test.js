// The owner's approval of an untested Codex binary (lib/agenttrust.js): plain headless only, with a
// gated argument shape; the automatic checks at every spawn; the approval bound to the exact
// binary; written only by `hoptell agents trust-cli` in a terminal. Temporary homes only; the
// agent is a stand-in for codex (fixtures/fake-codex.mjs) and never starts here.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIN } from "../lib/config.js";
import { RelayClient } from "../lib/client.js";
import { readAudit, readProfile, withAgentsLock, writeApproved } from "../lib/agents.js";
import { CODEX_FEATURES_OFF, GATES, TESTED, checkCli, gateShape } from "../lib/agentadapters.js";
import { REVIEWED_ON, TESTED_FEATURES, featureCheck, isTrusted, readTrusted, revokeTrustedCli, trustedPath, untestedGate, writeTrustedCli } from "../lib/agenttrust.js";
import { planBinding, readRun, updateRun } from "../lib/agentruns.js";
import { listAgents, spawnAgent } from "../lib/agentspawn.js";
import { agentsCommand } from "../lib/agentscli.js";
import { agentsWorld, profileDoc, writeProfile } from "./agents-helpers.js";
import { deviceRelay } from "./mls-helpers.js";

const FIX = fileURLToPath(new URL("./fixtures/help/", import.meta.url));
const FEATURES = fs.readFileSync(path.join(FIX, "codex-features-0.164.0.txt"), "utf8");
const EXEC_HELP = fs.readFileSync(path.join(FIX, "codex-exec-0.164.0.txt"), "utf8");
const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const NATIVE = "e".repeat(64);
const SHAPE = gateShape({ cli: "codex", sandbox: "read-only", limits: {} }, "headless");

/** Gates passed for one other binary (0.164.0, native "b"...) with the read-only shape. */
const gatesFor = (launcher) => ({ codex: { headless: { modes: { plain: { passed: { binaries: [{ version: "0.164.0", launcher, native: "b".repeat(64) }], shapes: [SHAPE] }, family: ["0.164"], refusal: "adapter_gate_unverified" }, hardening: { passed: null, refusal: "adapter_gate_unverified" } } }, tmux: { passed: null, refusal: "mcp_isolation_unverified" } } });

/** A home with an approved read-only codex profile (the stand-in) and the owner's session. */
async function trustWorld(t, { profile = {} } = {}) {
  const relay = await deviceRelay(t, { members: ["me"], devices: false });
  const w = agentsWorld(t);
  fs.writeFileSync(path.join(w.base, "me.token"), relay.members.me.token, { mode: 0o600 });
  const relaysFile = path.join(w.base, "relays.json");
  fs.writeFileSync(relaysFile, JSON.stringify({ version: 1, relays: [{ alias: "local", url: relay.url, tokenFile: "me.token", namePrefix: "me-", installId: "i-test" }], default: "local" }), { mode: 0o600 });
  fs.mkdirSync(path.join(w.base, "bin"));
  const codex = path.join(w.base, "bin", "codex");
  fs.writeFileSync(codex, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${w.base}' "$@"\n`, { mode: 0o755 });
  writeProfile(w.home, profileDoc(w.work, { command: codex, ...profile }));
  const digest = readProfile(w.home, "codex-reviewer", { homedir: w.homedir }).digest;
  await withAgentsLock(w.home, () => writeApproved(w.home, "codex-reviewer", digest));
  const launcher = crypto.createHash("sha256").update(fs.readFileSync(codex)).digest("hex");
  const owner = new RelayClient({ url: relay.url, token: relay.members.me.token, name: "me-owner", mode: "peer", reconnect: false });
  owner.on("message", (_m, confirm) => confirm());
  owner.start();
  await owner.ready();
  t.after(() => owner.close());
  const seen = { version: "0.165.0", digest: launcher, native: NATIVE, untested: true, features: FEATURES };
  const managed = { value: null };
  const ctx = {
    caller: "test-caller",
    home: w.home,
    homedir: w.homedir,
    env: { PATH: process.env.PATH, HOME: w.homedir },
    relaysFile,
    agentsMax: 4,
    spawner: { name: "owner", roles: ["lead"], front: "stdio", client: null },
    links: new Map([["local", { wireName: "me-owner", peers: () => owner.list() }]]),
    // The run never starts: the record is marked running by the test (no agent, no supervisor).
    deps: { check: () => ({ ...seen }), gates: gatesFor(launcher), managed: () => managed.value, hoptell: { node: process.execPath, bin: BIN }, start: (home, run) => updateRun(home, run, (r) => void (r.state = "running")) },
  };
  return { w, ctx, seen, managed, launcher, binary: { cli: "codex", version: "0.165.0", launcher, native: NATIVE } };
}

const approveBinary = (s, b = s.binary) => withAgentsLock(s.w.home, () => writeTrustedCli(s.w.home, b));

test("trust: the feature check passes the tested build; a feature on outside the gated builds, or a turned-off one on or missing, fails; new features that are off only show", () => {
  assert.deepEqual(featureCheck(FEATURES), { problems: [], added: [], changed: [] });
  assert.deepEqual(featureCheck(fs.readFileSync(path.join(FIX, "codex-features-0.162.1.txt"), "utf8")).problems, [], "0.162.1 (gated with its own arguments)");
  const fresh = featureCheck(`${FEATURES}brand_new_thing                          under development  false\n`);
  assert.deepEqual(fresh.problems, []);
  assert.deepEqual(fresh.added, ["brand_new_thing (off)"]);
  assert.match(featureCheck(`${FEATURES}brand_new_thing                          stable             true\n`).problems.join(), /brand_new_thing is on/, "a new feature on");
  assert.match(featureCheck(FEATURES.replace(/^(code_mode +under development +)false/m, "$1true")).problems.join(), /code_mode is on/, "a known feature turned on");
  assert.deepEqual(featureCheck(FEATURES.replace(/^(code_mode +under development +)false/m, "$1true")).changed, ["code_mode (off -> on)"]);
  assert.match(featureCheck(FEATURES.replace(/^apps .*\n/m, "")).problems.join(), /feature apps \(not in the feature list\)/, "a turned-off feature missing");
  assert.match(featureCheck(FEATURES.replace(/^(goals +stable +)false/m, "$1true")).problems.join(), /goals stays on/);
  assert.equal(featureCheck("garbage\n").problems.length > 0, true, "an unreadable list");
  // The table is the fixture of the newest tested build; it lists every feature hoptell turns off.
  assert.equal(TESTED_FEATURES.version, TESTED.codex.at(-1));
  for (const f of CODEX_FEATURES_OFF) assert.ok(TESTED_FEATURES.off.includes(f), f);
  assert.ok(!CODEX_FEATURES_OFF.some((f) => REVIEWED_ON.includes(f)));
});

test("trust: an untested binary is refused with the command to approve it; once approved it spawns, marked as such; another digest voids the approval", async (t) => {
  const s = await trustWorld(t);
  let r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, "adapter_gate_unverified");
  assert.match(r.message, /hoptell agents trust-cli codex-reviewer/);
  assert.match(r.message, /0\.165\.0/);
  await approveBinary(s);
  r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, undefined, r.message);
  const rec = readRun(s.w.home, r.run);
  assert.equal(rec.cliTrusted, true);
  assert.equal(rec.cliVersionUntested, true);
  assert.ok(readAudit(s.w.home).some((e) => e.event === "spawn-requested" && e.run === r.run && e.cliTrusted === true));
  const listed = (await listAgents(s.w.home, { state: "all" })).find((x) => x.run === r.run);
  assert.equal(listed?.cliTrusted, true);
  const out = [];
  await agentsCommand({ args: ["list", "--all"], home: s.w.home, env: {}, homedir: s.w.homedir, out: (l) => out.push(l), fail: (m) => assert.fail(m) });
  assert.match(out.join("\n"), new RegExp(`${r.run}.*untested CLI, approved by you`));
  // Another native binary, launcher or version: not this approval.
  for (const other of [{ native: "f".repeat(64) }, { digest: "0".repeat(64) }, { version: "0.165.1" }]) {
    Object.assign(s.seen, { native: NATIVE, digest: s.launcher, version: "0.165.0" }, other);
    const x = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
    assert.equal(x.error, "adapter_gate_unverified", JSON.stringify(other));
  }
});

test("trust: with the real CLI check, a native binary swapped behind the same launcher and version is not covered by the approval, and its own feature list decides", async (t) => {
  const s = await trustWorld(t);
  const pkg = path.join(s.w.base, "npm", "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  const launcher = path.join(pkg, "bin", "codex.js");
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  const vendor = path.join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin");
  fs.mkdirSync(vendor, { recursive: true });
  const native = path.join(vendor, "codex");
  fs.writeFileSync(native, "native-A", { mode: 0o755 });
  let features = FEATURES;
  const run = (_command, args) => (args[0] === "--version" ? "codex-cli 0.165.0\n" : args[0] === "features" ? features : EXEC_HELP);
  const check = (home, profile, mode, _command, opts) => checkCli(home, profile, mode, launcher, { ...opts, run });
  s.ctx.deps.check = check;
  const cliRun = (args) => trustCli({ ...s, seen: null, check }, args);
  let r = await cliRun(["codex-reviewer"]);
  assert.equal(r.failed, null, r.failed?.m);
  r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, undefined, r.message);
  // Native B: same launcher, same version, a new feature on.
  fs.writeFileSync(native, "native-B", { mode: 0o755 });
  features = `${FEATURES}new_unreviewed_capability                under development  true\n`;
  r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, "adapter_gate_unverified", "the approval named native A");
  assert.match(r.message, /hoptell agents trust-cli codex-reviewer/);
  r = await cliRun(["codex-reviewer"]);
  assert.match(r.failed?.m ?? "", /new_unreviewed_capability is on/, "B's own feature list, not A's");
  assert.equal(readTrusted(s.w.home).binaries.length, 1, "only A stays approved");
});

test("trust: an approved binary is still refused when a check fails (a feature on, local managed configuration), and hardening is never unlocked", async (t) => {
  const s = await trustWorld(t);
  await approveBinary(s);
  s.seen.features = `${FEATURES}brand_new_thing                          stable             true\n`;
  let r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, "cli_flags_changed");
  assert.match(r.message, /brand_new_thing is on/);
  s.seen.features = FEATURES;
  s.managed.value = { present: ["/etc/codex/config.toml"] };
  r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, "adapter_gate_unverified");
  assert.match(r.message, /managed Codex configuration is present/);
  s.managed.value = { problem: "cannot be read" };
  assert.equal((await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" })).error, "adapter_gate_unverified");
  s.managed.value = null;
  // The gate's own decision about hardening, tmux or another shape is never replaced.
  const facts = { version: "0.165.0", digest: s.launcher, native: NATIVE, shape: SHAPE };
  for (const [cli, mode, hm] of [["codex", "headless", "hardening"], ["codex", "tmux", "plain"], ["claude", "headless", "plain"]]) assert.equal(untestedGate(s.w.home, { cli, mode, headlessMode: hm, facts, gates: s.ctx.deps.gates, managed: () => null }), null, `${cli} ${mode} ${hm}`);
  assert.equal(untestedGate(s.w.home, { cli: "codex", mode: "headless", headlessMode: "plain", facts: { ...facts, shape: "other" }, gates: s.ctx.deps.gates, managed: () => null }), null, "another argument shape");
  // The shipped table: the same holds for its hardening entry.
  assert.equal(untestedGate(s.w.home, { cli: "codex", mode: "headless", headlessMode: "hardening", facts, gates: GATES, managed: () => null }), null, "shipped hardening");
  writeProfile(s.w.home, profileDoc(s.w.work, { command: path.join(s.w.base, "bin", "codex"), codex: { headlessMode: "hardening" } }));
  const digest = readProfile(s.w.home, "codex-reviewer", { homedir: s.w.homedir }).digest;
  await withAgentsLock(s.w.home, () => writeApproved(s.w.home, "codex-reviewer", digest));
  r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.ok(r.error, "a hardened profile on an approved untested binary is refused");
  assert.doesNotMatch(r.message ?? "", /trust-cli/);
});

test("trust: a revoked approval stops a recorded run at its start-time check", async (t) => {
  const s = await trustWorld(t);
  await approveBinary(s);
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.error, undefined, r.message);
  const rec = readRun(s.w.home, r.run);
  const at = { homedir: s.w.homedir, env: s.ctx.env, gates: s.ctx.deps.gates, managed: () => null, gate: { version: rec.cliVersion, digest: rec.cliDigest, native: rec.nativeDigest } };
  assert.equal(planBinding(s.w.home, rec, at).code, undefined);
  assert.deepEqual(revokeTrustedCli(s.w.home, NATIVE.slice(0, 12)).map((b) => b.version), ["0.165.0"]);
  assert.equal(isTrusted(s.w.home, "codex", { version: "0.165.0", digest: s.launcher, native: NATIVE }), false);
  const b = planBinding(s.w.home, rec, at);
  assert.equal(b.code, "adapter_gate_unverified");
  assert.match(b.message, /trust-cli/);
});

/** `hoptell agents trust-cli` with a scripted terminal. */
function trustCli(s, args, { isTTY = true, answer = "trust", env = {} } = {}) {
  const out = [];
  const asked = [];
  let failed = null;
  const run = agentsCommand({
    args: ["trust-cli", ...args],
    home: s.w.home,
    env: { PATH: process.env.PATH, HOME: s.w.homedir, ...env },
    homedir: s.w.homedir,
    out: (l) => out.push(l),
    fail: (m, code = 1) => {
      failed = { m, code };
      throw Object.assign(new Error(m), { failed: true });
    },
    sources: { deps: { check: s.check ?? (() => ({ ...s.seen })), gates: s.ctx.deps.gates, managed: () => s.managed.value }, tty: { isTTY, ask: async (q) => (asked.push(q), answer) } },
  }).catch((e) => {
    if (!e.failed) throw e;
  });
  return run.then(() => ({ out: out.join("\n"), asked, failed }));
}

test("trust-cli: shows the binary, its checks and what changed, and approves it only after the owner types trust in a terminal", async (t) => {
  const s = await trustWorld(t);
  s.seen.features = FEATURES.replace(/^(code_mode_interrupt +stable +)true/m, "$1false") + "brand_new_thing                          under development  false\n";
  let r = await trustCli(s, ["codex-reviewer"], { answer: "no" });
  assert.match(r.out, /0\.165\.0/);
  assert.match(r.out, new RegExp(s.launcher));
  assert.match(r.out, new RegExp(NATIVE));
  assert.match(r.out, /brand_new_thing \(off\)/, "new features");
  assert.match(r.out, /code_mode_interrupt \(on -> off\)/, "changed defaults");
  assert.match(r.out, /cloud-delivered/i, "says what plain mode does not check");
  assert.equal(r.asked.length, 1);
  assert.ok(r.failed, "not approved without the word");
  assert.equal(fs.existsSync(trustedPath(s.w.home)), false);
  r = await trustCli(s, ["codex-reviewer"]);
  assert.equal(r.failed, null, r.failed?.m);
  assert.equal(isTrusted(s.w.home, "codex", { version: "0.165.0", digest: s.launcher, native: NATIVE }), true);
  assert.equal(fs.statSync(trustedPath(s.w.home)).mode & 0o777, 0o600);
  r = await trustCli(s, ["--list"]);
  assert.match(r.out, /0\.165\.0/);
  r = await trustCli(s, ["--revoke", NATIVE.slice(0, 12)], { isTTY: false });
  assert.equal(r.failed, null);
  assert.deepEqual(readTrusted(s.w.home).binaries, []);
});

test("trust-cli: refuses outside a terminal, inside an agent run, and when a check fails; writes nothing", async (t) => {
  const s = await trustWorld(t);
  for (const [opts, re] of [[{ isTTY: false }, /terminal/], [{ env: { HOPTELL_RUN: "r_0123456789abcdef" } }, /agent run/]]) {
    const r = await trustCli(s, ["codex-reviewer"], opts);
    assert.match(r.failed?.m ?? "", re);
    assert.equal(r.asked.length, 0, "nothing asked");
  }
  s.seen.features = `${FEATURES}brand_new_thing                          stable             true\n`;
  let r = await trustCli(s, ["codex-reviewer"]);
  assert.match(r.failed?.m ?? "", /brand_new_thing is on/);
  s.seen.features = FEATURES;
  s.managed.value = { present: ["/etc/codex/config.toml"] };
  r = await trustCli(s, ["codex-reviewer"]);
  assert.match(r.failed?.m ?? "", /managed/);
  assert.equal(fs.existsSync(trustedPath(s.w.home)), false);
});

test("trust: only the owner's terminal command writes approvals (no MCP, peer, UI or settings path imports the writers)", () => {
  const lib = fileURLToPath(new URL("../lib/", import.meta.url));
  const writers = [];
  for (const f of fs.readdirSync(lib).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(lib, f), "utf8");
    if (f !== "agenttrust.js" && /\b(writeTrustedCli|revokeTrustedCli)\b/.test(src)) writers.push(f);
    if (f !== "agenttrust.js" && /trusted-cli\.json/.test(src)) writers.push(`${f} (path)`);
  }
  assert.deepEqual(writers, ["agentscli.js"]);
  const bin = fs.readFileSync(fileURLToPath(new URL("../bin/hoptell.js", import.meta.url)), "utf8");
  assert.doesNotMatch(bin, /writeTrustedCli|revokeTrustedCli|agenttrust/);
});
