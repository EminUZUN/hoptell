// Path-deny hardening of spawned Codex headless runs (design-7.1-read-containment.md, draft 6.1):
// the hardened argument shape, the deny-set resolver, the local managed-source detection, the
// preflight, the per-mode gates and the profile's mode, the binding of a run to its mode, the
// start-time revalidation, the per-tick check and the cloud stream audit. No real CLI: a stand-in
// codex, an injected preflight runner and an injected managed-source detector. The supervisor runs
// in this process (its hooks carry the test's gates), and is awaited.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIN } from "../lib/config.js";
import { CODEX_APPROVAL_WARNING, HARDENING_APPROVAL_TEXT, readAudit, readProfile, validateProfile, withAgentsLock, writeApproved } from "../lib/agents.js";
import { GATES, PROFILE_ID_RE, buildPlan, checkHardenedArgs, commandLines, gateShape, helpNeeds, parseDenyTable, storedShape } from "../lib/agentadapters.js";
import { CLOUD_NOTE, checkHardening, cloudLineClass, compactDeny, managedSources, ownerRelaysFile, preflight, rawRelays, resolveDeny, sameFile, spellings } from "../lib/agentdeny.js";
import { readRun, runPaths, supervise, updateRun } from "../lib/agentruns.js";
import { spawnAgent, startConfirmed } from "../lib/agentspawn.js";
import { agentsCommand } from "../lib/agentscli.js";
import { agentsWorld, profileDoc, writeProfile } from "./agents-helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const RUN = "r_0123456789abcdef";
const HARD = { codex: { headlessMode: "hardening" } };
/** The shipped table with hardening ungated (plain as shipped): for the ungated cases, whatever the shipped state. */
const UNGATED = { ...GATES, codex: { ...GATES.codex, headless: { modes: { plain: GATES.codex.headless.modes.plain } } } };

// ---- shared setup -----------------------------------------------------------------------------------

const writeRelays = (file, relays) => fs.writeFileSync(file, JSON.stringify({ version: 1, relays, default: relays[0]?.alias ?? "local" }), { mode: 0o600 });

async function approve(w, id) {
  const digest = readProfile(w.home, id, { homedir: w.homedir }).digest;
  await withAgentsLock(w.home, () => writeApproved(w.home, id, digest));
}

/** The gates as if plain and hardening had passed on the stand-in codex (its launcher digest). */
function gatesFor(command, profile) {
  const launcher = crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(command))).digest("hex");
  const binaries = [{ version: "0.162.1", launcher, native: null }];
  const plainShape = gateShape({ ...profile, codex: undefined }, "headless");
  return { codex: { headless: { modes: { plain: { passed: { binaries, shapes: [plainShape] }, family: "0.162", refusal: "adapter_gate_unverified" }, hardening: { passed: { binaries, shapes: [gateShape({ ...profile, ...HARD }, "headless")] }, family: "0.162", refusal: "adapter_gate_unverified" } } } } };
}

/**
 * A home with an approved hardened codex profile (the stand-in codex), the owner's relays file
 * (the local entry's tokenFile me.token), the spawner's context, and the in-process supervisor's
 * hooks: the test's gates, no managed source, a preflight runner that denies every path but the
 * cwd (it records its calls), and a spawn that records its options.
 */
async function hardWorld(t, { profile = {}, relays = null, confirm = undefined } = {}) {
  const w = agentsWorld(t);
  fs.writeFileSync(path.join(w.base, "me.token"), "a-token", { mode: 0o600 });
  const relaysFile = path.join(w.base, "relays.json");
  writeRelays(relaysFile, relays ?? [{ alias: "local", url: "ws://127.0.0.1:9", tokenFile: "me.token", namePrefix: "me-", installId: "i-test" }]);
  const logs = path.join(w.base, "calls");
  fs.mkdirSync(logs);
  fs.mkdirSync(path.join(w.base, "bin"));
  const codex = path.join(w.base, "bin", "codex");
  fs.writeFileSync(codex, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${logs}' "$@"\n`, { mode: 0o755 });
  const doc = profileDoc(w.work, { command: codex, ...HARD, limits: { concurrent: 8, perHour: 60 }, ...(confirm ? { confirm } : {}), ...profile });
  writeProfile(w.home, doc);
  await approve(w, "codex-reviewer");
  const gates = gatesFor(codex, readProfile(w.home, "codex-reviewer", { homedir: w.homedir, gates: { codex: { headless: { modes: { hardening: { passed: { binaries: [], shapes: [] } } } } } } }).profile ?? { cli: "codex", modes: ["headless"], sandbox: "read-only", limits: {} });
  const pf = { calls: [], allow: new Set() };
  const spawned = [];
  const managed = { value: null };
  const hooks = {
    gates,
    managed: () => managed.value,
    preflightRun: (command, args, opts) => {
      pf.calls.push({ command, args, env: opts.env });
      const target = args.at(-1);
      return target === w.work || pf.allow.has(target) ? { status: 0, stdout: "123\n", stderr: "", error: null } : { status: 1, stdout: "", stderr: `stat: ${target}: stat: Operation not permitted\n`, error: null };
    },
    spawn: (...a) => {
      spawned.push(a);
      return (hooks.realSpawn ?? null)(...a);
    },
    deliver: async () => {},
    containPollMs: 50,
  };
  const { spawn } = await import("node:child_process");
  hooks.realSpawn = spawn;
  const env = { PATH: process.env.PATH, HOME: w.homedir, HOPTELL_RELAYS: relaysFile };
  const ctx = {
    home: w.home,
    homedir: w.homedir,
    env,
    relaysFile,
    agentsMax: 4,
    spawner: { name: "owner", roles: ["lead"], front: "stdio", client: null },
    links: new Map([["local", { wireName: "me-owner", realm: null, member: null, peers: async () => [] }]]),
    deps: { check: () => ({ version: "0.162.1", untested: false }), gates, managed: () => managed.value, hoptell: { node: process.execPath, bin: BIN }, start: (home, run, o) => supervised(home, run, hooks, o) },
  };
  return { w, ctx, hooks, pf, spawned, managed, logs, codex, relaysFile, gates };
}

/** The supervisor in this process (its hooks carry the test's gates): resolves with the ended record. */
async function supervised(home, run, hooks, { env }) {
  await supervise(home, run, hooks, { env });
  return readRun(home, run);
}

const calls = (logs) => fs.readdirSync(logs).map((f) => JSON.parse(fs.readFileSync(path.join(logs, f), "utf8")));
const planCtx = (profile, over = {}) => ({ profile, mode: "headless", run: RUN, home: "/h", cwd: "/w", name: "n", command: "/bin/codex", hoptell: { node: "/node", bin: "/b.js" }, paths: { result: `/h/agents/runs/${RUN}/result`, env: `/h/agents/runs/${RUN}/env`, relays: `/h/agents/runs/${RUN}/relays.json`, mcp: `/h/agents/runs/${RUN}/mcp.json` }, resultTo: "me-owner", lifetimeMinutes: 30, ...over });
const ro = (over = {}) => ({ cli: "codex", modes: ["headless"], sandbox: "read-only", limits: {}, ...over });

// ---- the shape -------------------------------------------------------------------------------------

test("hardening shape: no -s/--sandbox/sandbox_mode; the sandbox maps to extends; one deny-only table slot; the ignore flags stay; commandLines shows the placeholders", () => {
  const id = `hoptell_${"a".repeat(32)}`;
  const { plan } = buildPlan(planCtx(ro(HARD), { profileId: id, deny: ["/h", "/t/tok"] }));
  assert.ok(!plan.args.includes("-s") && !plan.args.includes("--sandbox"));
  assert.ok(!plan.args.some((a) => /sandbox_mode/.test(a)));
  assert.ok(plan.args.includes("--ignore-user-config") && plan.args.includes("--ignore-rules"));
  assert.ok(plan.args.includes("agents.enabled=false") && plan.args.includes("features.multi_agent_v2=false"), "sub-agents off");
  assert.ok(!buildPlan(planCtx(ro())).plan.args.includes("agents.enabled=false"), "the plain shape is unchanged");
  assert.ok(plan.args.includes(`default_permissions="${id}"`));
  assert.ok(plan.args.includes(`permissions.${id}.extends=":read-only"`));
  const tables = plan.args.filter((a) => a.includes(".filesystem="));
  assert.deepEqual(tables, [`permissions.${id}.filesystem={"/h"="deny", "/t/tok"="deny"}`]);
  assert.deepEqual(parseDenyTable(tables[0].split("=").slice(1).join("=")), ["/h", "/t/tok"]);
  assert.equal(plan.mode, "hardening");
  assert.equal(plan.profileId, id);
  assert.deepEqual(plan.deny, ["/h", "/t/tok"]);
  // The approval view: placeholders, never this install's paths.
  const line = commandLines(ro({ ...HARD, folders: { roots: ["/w"], default: "/w" } }), { gates: { codex: { headless: { modes: { hardening: { passed: { binaries: [{ version: "0.162.1", launcher: "x", native: null }], shapes: [gateShape(ro(HARD), "headless")] }, refusal: "adapter_gate_unverified" } } } } } }).headless;
  assert.match(line, /default_permissions="<PROFILE_ID>"/);
  assert.match(line, /permissions\.<PROFILE_ID>\.filesystem=<DENY_TABLE>/);
  assert.doesNotMatch(line, /containment/i);
  // The shipped gates: hardening is recorded (0.162.1), so the view does not say it is refused;
  // a table without the hardening entry does.
  assert.doesNotMatch(commandLines(ro({ ...HARD, folders: { roots: ["/w"], default: "/w" } })).headless, /refused for now/);
  assert.match(commandLines(ro({ ...HARD, folders: { roots: ["/w"], default: "/w" } }), { gates: UNGATED }).headless, /refused for now: adapter_gate_unverified/);
  // A plain profile: today's plan (-s read-only), mode plain.
  const p = buildPlan(planCtx(ro())).plan;
  assert.equal(p.args[p.args.indexOf("-s") + 1], "read-only");
  assert.equal(p.mode, "plain");
  // Containment is not offered: no plan is built for it.
  assert.throws(() => buildPlan(planCtx(ro({ codex: { headlessMode: "containment" } }))), /not offered/);
  assert.match(commandLines(ro({ codex: { headlessMode: "containment" }, folders: { roots: ["/w"], default: "/w" } })).headless, /not offered: adapter_gate_unverified/);
  // The help check: no -s; codex sandbox --help must list -P, --permission-profile.
  const needs = helpNeeds(ro(HARD), "headless");
  assert.ok(!needs.flags.includes("-s"));
  assert.deepEqual(needs.extraHelp[0].helpArgs, ["sandbox", "--help"]);
  assert.ok(needs.extraHelp[0].flags.includes("-P") && needs.extraHelp[0].flags.includes("--permission-profile"));
});

test("hardening shape: the structural check refuses a non-deny value, a missing or extra entry, another id, -s, sandbox_mode; the stored shape is the profile's", () => {
  const id = `hoptell_${"b".repeat(32)}`;
  const { plan } = buildPlan(planCtx(ro(HARD), { profileId: id, deny: ["/h", "/t"] }));
  assert.equal(checkHardenedArgs(plan, ["/t", "/h"]), null);
  assert.match(checkHardenedArgs(plan, ["/h"]), /no longer resolved: \/t/);
  assert.match(checkHardenedArgs(plan, ["/h", "/t", "/x"]), /missing: \/x/);
  const swap = (from, to) => ({ ...plan, args: plan.args.map((a) => a.replace(from, to)) });
  assert.match(checkHardenedArgs(swap('"/t"="deny"', '"/t"="read"'), ["/h", "/t"]), /not an inline table of deny entries/);
  assert.match(checkHardenedArgs({ ...plan, profileId: "hoptell_run" }, ["/h", "/t"]), /no valid profile id/);
  assert.match(checkHardenedArgs(swap(`default_permissions="${id}"`, `default_permissions="hoptell_${"c".repeat(32)}"`), ["/h", "/t"]), /permission slots/);
  assert.match(checkHardenedArgs({ ...plan, args: [...plan.args.slice(0, -1), "-s", "read-only", "-"] }, ["/h", "/t"]), /-s/);
  assert.match(checkHardenedArgs({ ...plan, args: [...plan.args.slice(0, -1), "-c", 'sandbox_mode="danger-full-access"', "-"] }, ["/h", "/t"]), /sandbox_mode/);
  assert.match(checkHardenedArgs({ ...plan, args: plan.args.filter((a, i) => a !== "agents.enabled=false" && plan.args[i + 1] !== "agents.enabled=false") }, ["/h", "/t"]), /sub-agents/);
  assert.match(checkHardenedArgs({ ...plan, args: [...plan.args.slice(0, -1), "-c", "agents.enabled=true", "-"] }, ["/h", "/t"]), /sub-agents/);
  assert.equal(parseDenyTable('{"a"="deny","b"="deny"}'), null, "another spacing");
  assert.equal(parseDenyTable('{"a"="deny", "a"="deny"}'), null, "a duplicate");
  assert.deepEqual(parseDenyTable("{}"), []);
  // The stored plan's shape, read back from its own arguments, is the profile's gate shape.
  const real = buildPlan(planCtx(ro(HARD), { profileId: id, deny: ["/h"] })).plan;
  assert.equal(storedShape("codex", real, { home: "/h", run: RUN, cwd: "/w" }), gateShape(ro(HARD), "headless"));
  assert.notEqual(storedShape("codex", { ...real, args: [...real.args.slice(0, -1), "--extra", "-"] }, { home: "/h", run: RUN, cwd: "/w" }), gateShape(ro(HARD), "headless"));
  assert.equal(storedShape("codex", { args: "nope" }, { home: "/h", run: RUN, cwd: "/w" }), null);
});

// ---- the resolver ----------------------------------------------------------------------------------

test("resolver: configured spelling and realpath, a symlinked token directory, a missing token file (ancestor + rest), the firmlinked spelling only on a matching inode, dedupe, nesting, order", (t) => {
  const w = agentsWorld(t);
  const real = path.join(w.base, "real-tokens");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "a.token"), "x", { mode: 0o600 });
  fs.symlinkSync(real, path.join(w.base, "linked"));
  const relaysFile = path.join(w.base, "relays.json");
  writeRelays(relaysFile, [
    { alias: "a", url: "ws://x", tokenFile: "linked/a.token" },
    // the same alias twice, different token files: both denied
    { alias: "a", url: "ws://x", tokenFile: path.join(w.base, "dup.token") },
    // no alias at all; a token file that does not exist yet
    { url: "ws://x", tokenFile: path.join(w.base, "later", "b.token"), tokenEnv: "LAB_TOKEN" },
    // inside the home: nested, dropped
    { alias: "c", url: "ws://x", tokenFile: path.join(w.home, "local-relay", "token") },
  ]);
  const env = { HOME: w.homedir };
  const d = resolveDeny({ home: w.home, relaysFile, homedir: w.homedir, env });
  assert.equal(d.problem, undefined, d.problem);
  assert.ok(d.deny.includes(path.join(w.base, "linked", "a.token")), "the configured spelling");
  assert.ok(d.deny.includes(path.join(real, "a.token")), "the realpath through the symlinked directory");
  assert.ok(d.deny.includes(path.join(w.base, "dup.token")), "a duplicate alias's token file");
  assert.ok(d.deny.includes(path.join(w.base, "later", "b.token")), "a token file that does not exist yet");
  assert.ok(d.deny.includes(w.home) && !d.deny.some((x) => x !== w.home && x.startsWith(`${w.home}/`)), "nested entries are dropped");
  assert.ok(d.deny.includes(relaysFile), "R: the file (its folder is not hoptell's own)");
  assert.ok(d.deny.includes(path.join(w.homedir, ".codex")), "C: $HOME/.codex");
  assert.deepEqual(d.deny, [...d.deny].sort(), "stable order");
  assert.deepEqual(d.tokenEnvs, ["LAB_TOKEN"]);
  assert.deepEqual(compactDeny(["/b", "/a/x", "/a", "/b"]), ["/a", "/b"]);
  // The tmp folder's spelling under /private: both spellings.
  if (fs.existsSync("/private/tmp")) assert.deepEqual(spellings("/tmp/hoptell-none/x"), ["/tmp/hoptell-none/x", "/private/tmp/hoptell-none/x"]);
  // A /System/Volumes/Data spelling: the firmlinked one too, when it is the same inode.
  if (fs.existsSync(`/System/Volumes/Data${w.base}`)) {
    const s = spellings(`/System/Volumes/Data${w.base}/nope/x`);
    assert.ok(s.includes(`${w.base}/nope/x`), JSON.stringify(s));
  }
  // ... and not when the inode differs (an injected file system).
  const fake = {
    lstatSync: () => ({ isFile: () => true }),
    statSync: (p) => ({ dev: 1, ino: p.startsWith("/System/Volumes/Data") ? 2 : 3, nlink: 1 }),
    realpathSync: (p) => p,
  };
  assert.deepEqual(spellings("/System/Volumes/Data/Users/x", { fsx: fake }), ["/System/Volumes/Data/Users/x"]);
  // CODEX_HOME from the environment object (when env.pass gave it to the run).
  assert.ok(resolveDeny({ home: w.home, relaysFile, homedir: w.homedir, env: { HOME: w.homedir, CODEX_HOME: path.join(w.base, "ch") } }).deny.includes(path.join(w.base, "ch")));
  assert.match(resolveDeny({ home: w.home, relaysFile, homedir: w.homedir, env: {} }).problem, /CODEX_HOME nor HOME/);
  // A relative CODEX_HOME: Codex resolves it against its own working folder, not HOME: refused.
  assert.match(resolveDeny({ home: w.home, relaysFile, homedir: w.homedir, env: { HOME: w.homedir, CODEX_HOME: "auth" } }).problem, /CODEX_HOME is not an absolute path/);
  assert.match(checkHardening({ home: w.home, relaysFile, homedir: w.homedir, env: { HOME: w.homedir, CODEX_HOME: "./ch" }, cwd: w.work }, { managed: () => null }).problem, /not an absolute path/);
});

test("resolver: an invalid element, a non-string tokenFile or an unreadable relays file cannot be resolved; a hard-linked token file is reported", (t) => {
  const w = agentsWorld(t);
  const relaysFile = path.join(w.base, "relays.json");
  const r = (relays) => {
    writeRelays(relaysFile, relays);
    return resolveDeny({ home: w.home, relaysFile, homedir: w.homedir, env: { HOME: w.homedir } });
  };
  assert.match(r([{ alias: "a", tokenFile: 7 }]).problem, /tokenFile is not a string/);
  assert.match(r([null]).problem, /not an object/);
  assert.match(r([{ alias: "a", tokenEnv: ["X"] }]).problem, /tokenEnv is not a string/);
  writeRelays(relaysFile, []);
  fs.chmodSync(relaysFile, 0o644);
  assert.match(resolveDeny({ home: w.home, relaysFile, homedir: w.homedir, env: { HOME: w.homedir } }).problem, /not a private regular file/);
  fs.writeFileSync(relaysFile, "{", { mode: 0o600 });
  fs.chmodSync(relaysFile, 0o600);
  assert.match(rawRelays(relaysFile, w.homedir).problem, /cannot be read/);
  const tok = path.join(w.base, "t.token");
  fs.writeFileSync(tok, "x", { mode: 0o600 });
  fs.linkSync(tok, path.join(w.base, "second-name"));
  assert.deepEqual(r([{ alias: "a", tokenFile: tok }]).hardlinked, [tok]);
  const h = checkHardening({ home: w.home, relaysFile, homedir: w.homedir, env: { HOME: w.homedir }, cwd: w.work }, { managed: () => null });
  assert.equal(h.kind, "hardlink");
});

test("overlap: a cwd or root equal to or inside the home, a token file's folder or CODEX_HOME is refused in both spellings; a cwd containing the home is accepted; tokenEnv in env.pass is refused", (t) => {
  const w = agentsWorld(t);
  const relaysFile = path.join(w.base, "relays.json");
  const tokDir = path.join(w.base, "tokdir");
  fs.mkdirSync(tokDir);
  writeRelays(relaysFile, [{ alias: "a", tokenFile: tokDir, tokenEnv: "A_TOKEN" }]);
  const chk = (cwd, more = {}) => checkHardening({ home: w.home, relaysFile, homedir: w.homedir, env: { HOME: w.homedir }, cwd, ...more }, { managed: () => null });
  fs.mkdirSync(path.join(w.home, "sub"), { recursive: true });
  assert.equal(chk(w.home).kind, "overlap");
  assert.equal(chk(path.join(w.home, "sub")).kind, "overlap");
  assert.equal(chk(tokDir).kind, "overlap");
  fs.mkdirSync(path.join(w.homedir, ".codex", "x"), { recursive: true });
  assert.equal(chk(path.join(w.homedir, ".codex", "x")).kind, "overlap");
  if (fs.existsSync(`/System/Volumes/Data${w.home}`)) assert.equal(chk(`/System/Volumes/Data${w.home}`).kind, "overlap", "the firmlinked spelling");
  assert.equal(chk(w.base).problem, undefined, "a cwd that contains the home: the deny is more specific");
  assert.equal(chk(w.work, { roots: [w.work, path.join(w.home, "sub")] }).kind, "overlap", "a root inside the home");
  assert.equal(chk(w.work, { pass: ["A_TOKEN"] }).kind, "env");
});

// ---- managed sources --------------------------------------------------------------------------------

test("managed sources: /etc/codex files, the managed preferences (present or forced) and the plists refuse; an undeterminable state refuses; nothing present passes", () => {
  const ok = () => ({ status: 0, stdout: "config_toml_base64=absent forced=false\nrequirements_toml_base64=absent forced=false\n", error: null });
  const fsOf = (present = [], errors = {}) => ({
    lstatSync: (p) => {
      if (errors[p]) throw Object.assign(new Error("x"), { code: errors[p] });
      if (present.includes(p)) return {};
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    },
  });
  const m = (o) => managedSources({ platform: "darwin", user: "u", osascript: ok, fsx: fsOf(), ...o });
  assert.equal(m({}), null);
  for (const f of ["/etc/codex/requirements.toml", "/etc/codex/managed_config.toml", "/etc/codex/config.toml", "/Library/Managed Preferences/com.openai.codex.plist", "/Library/Managed Preferences/u/com.openai.codex.plist"]) assert.deepEqual(m({ fsx: fsOf([f]) }).present, [f]);
  assert.match(m({ fsx: fsOf([], { "/etc/codex/requirements.toml": "EACCES" }) }).problem, /EACCES/);
  assert.match(m({ fsx: fsOf([], { "/etc/codex/config.toml": "ELOOP" }) }).problem, /ELOOP/);
  assert.match(m({ fsx: fsOf([], { "/etc/codex/config.toml": "ENOTDIR" }) }).problem, /ENOTDIR/, "only ENOENT is absence");
  assert.equal(m({ osascript: () => ({ status: 0, stdout: "config_toml_base64=present forced=false\nrequirements_toml_base64=absent forced=false", error: null }) }).present.length, 1);
  assert.equal(m({ osascript: () => ({ status: 0, stdout: "config_toml_base64=absent forced=true\nrequirements_toml_base64=absent forced=false", error: null }) }).present.length, 1);
  assert.match(m({ osascript: () => ({ status: null, stdout: "", error: "ETIMEDOUT" }) }).problem, /ETIMEDOUT/);
  assert.match(m({ osascript: () => ({ status: 1, stdout: "", error: null }) }).problem, /exit 1/);
  assert.match(m({ osascript: () => ({ status: 0, stdout: "something else", error: null }) }).problem, /unexpected/);
  assert.match(m({ osascript: () => ({ status: 0, stdout: "", error: "ENOENT" }) }).problem, /ENOENT/, "osascript missing");
  assert.match(managedSources({ platform: "linux" }).problem, /macOS only/);
});

// ---- the preflight ----------------------------------------------------------------------------------

test("preflight: a denied path that stats, a cwd that fails, a timeout or missing permission slots refuse; an empty temporary CODEX_HOME, removed afterwards; never cached", (t) => {
  const w = agentsWorld(t);
  const id = `hoptell_${"d".repeat(32)}`;
  const { plan } = buildPlan(planCtx(ro(HARD), { profileId: id, deny: [w.home] }));
  const seen = [];
  const runner = (deny = "denied", cwd = 0) => (command, args, opts) => {
    seen.push({ args, home: opts.env.CODEX_HOME, existed: fs.existsSync(opts.env.CODEX_HOME), mode: fs.statSync(opts.env.CODEX_HOME).mode & 0o777, files: fs.readdirSync(opts.env.CODEX_HOME).length });
    if (args.at(-1) === w.work) return cwd === "timeout" ? { error: "ETIMEDOUT" } : { status: cwd, stdout: "", stderr: "" };
    return deny === "denied" ? { status: 1, stdout: "", stderr: "Operation not permitted" } : deny === "timeout" ? { error: "ETIMEDOUT" } : { status: 0, stdout: "1", stderr: "" };
  };
  const pf = (run) => preflight({ command: "/bin/codex", plan, cwd: w.work, env: { PATH: "/usr/bin", CODEX_HOME: "/real" }, targets: [w.home] }, { run });
  assert.equal(pf(runner()), null);
  assert.deepEqual(seen[0].args.slice(0, 9), ["sandbox", "-c", `default_permissions="${id}"`, "-c", `permissions.${id}.extends=":read-only"`, "-c", `permissions.${id}.filesystem={${JSON.stringify(w.home)}="deny"}`, "-P", id]);
  assert.deepEqual(seen[0].args.slice(9), ["-C", w.work, "--", "/usr/bin/stat", "-f", "%i", w.work]);
  assert.ok(seen.every((s) => s.existed && s.mode === 0o700 && s.files === 0 && s.home !== "/real"), "an empty private CODEX_HOME");
  assert.equal(fs.existsSync(seen[0].home), false, "removed afterwards");
  assert.match(pf(runner("stats")).problem, /could stat/);
  assert.match(pf(runner("denied", 1)).problem, /run's folder/);
  assert.match(pf(runner("timeout")).problem, /ETIMEDOUT/);
  assert.match(pf(runner("denied", "timeout")).problem, /ETIMEDOUT/);
  assert.match(preflight({ command: "/bin/codex", plan: { ...plan, args: ["exec"] }, cwd: w.work, env: {}, targets: [] }, { run: runner() }).problem, /slots/);
  const before = seen.length;
  pf(runner());
  pf(runner());
  assert.equal(seen.length, before + 4, "every call runs again: nothing is cached");
});

// ---- the cloud stream line classes ------------------------------------------------------------------

test("cloud lines: (none), a loaded bundle with counts, a cached bundle and any other codex_cloud_config line; other lines are not cloud lines", () => {
  assert.deepEqual(cloudLineClass("x INFO codex_cloud_config::service: Cloud config bundle load completed (none) elapsed_ms=0"), { cls: "none" });
  assert.deepEqual(cloudLineClass("x INFO codex_cloud_config::service: Cloud config bundle load completed config_fragments=2 requirements_fragments=1 elapsed_ms=3"), { cls: "loaded", counts: { config_fragments: 2, requirements_fragments: 1 } });
  assert.deepEqual(cloudLineClass("x INFO codex_cloud_config: Using cached cloud config bundle"), { cls: "cached" });
  assert.deepEqual(cloudLineClass("x WARN codex_cloud_config: refresh failed"), { cls: "other" });
  assert.equal(cloudLineClass("x INFO codex_core: something"), null);
});

// ---- the profile's mode -------------------------------------------------------------------------------

test("profiles: codex.headlessMode absent is plain (digest unchanged); a change changes the digest; only a read-only Codex headless profile may name a mode other than plain", (t) => {
  const w = agentsWorld(t);
  const base = profileDoc(w.work);
  writeProfile(w.home, base);
  const plain = readProfile(w.home, "codex-reviewer");
  assert.deepEqual(plain.problems, []);
  assert.equal(plain.profile.codex.headlessMode, "plain");
  assert.equal(plain.digest, crypto.createHash("sha256").update(JSON.stringify(base, null, 2)).digest("hex"), "the file's digest: no field is added");
  writeProfile(w.home, { ...base, ...HARD });
  assert.notEqual(readProfile(w.home, "codex-reviewer").digest, plain.digest);
  const v = (doc) => validateProfile(doc, { id: doc.id, home: w.home });
  assert.deepEqual(v({ ...base, codex: { headlessMode: "plain" } }), []);
  assert.deepEqual(v({ ...base, cli: "claude", codex: { headlessMode: "plain" } }), []);
  for (const bad of [{ cli: "claude" }, { sandbox: "workspace-write" }, { modes: ["headless", "tmux"] }, { modes: ["tmux"] }]) assert.match(v({ ...base, ...bad, ...HARD }).join("; "), /only for codex profiles with modes \["headless"\] and sandbox read-only/, JSON.stringify(bad));
  assert.match(v({ ...base, codex: { headlessMode: "contained" } }).join(), /must be one of plain, hardening, containment/);
  assert.match(v({ ...base, codex: { other: 1 } }).join(), /codex must be/);
});

test("checkFolders by mode: a gated hardening profile accepts a root containing the home and refuses one inside a denied path; ungated, plain, workspace-write and Claude keep today's rule", (t) => {
  const w = agentsWorld(t);
  const relaysFile = path.join(w.base, "relays.json");
  writeRelays(relaysFile, [{ alias: "local", tokenFile: path.join(w.base, "tok", "me.token"), tokenEnv: "ME_TOKEN" }]);
  fs.mkdirSync(path.join(w.base, "tok"));
  const gated = { codex: { headless: { modes: { hardening: { passed: { binaries: [], shapes: [] }, refusal: "adapter_gate_unverified" } } } } };
  const doc = (over) => profileDoc(w.work, { folders: { roots: [w.base], default: w.base }, ...over });
  const v = (d, gates) => validateProfile(d, { id: d.id, home: w.home, homedir: w.homedir, env: { HOME: w.homedir }, relaysFile, ...(gates ? { gates } : {}) });
  assert.deepEqual(v(doc(HARD), gated), [], "a root that contains the home: accepted");
  assert.deepEqual(v(doc({ ...HARD, folders: { roots: [path.join(w.base, "tok")], default: path.join(w.base, "tok") } }), gated), [], "a root that contains a token file");
  const inC = path.join(w.homedir, ".codex", "proj");
  fs.mkdirSync(inC, { recursive: true });
  assert.match(v(doc({ ...HARD, folders: { roots: [inC], default: inC } }), gated).join(), /lies inside .*which a hardened run denies/);
  assert.match(v(doc({ ...HARD, folders: { roots: [w.home], default: w.home } }), gated).join(), /is or lies inside .*which a hardened run denies/);
  assert.match(v(doc({ ...HARD, env: { pass: ["ME_TOKEN"] } }), gated).join(), /ME_TOKEN is a relay token variable/);
  const today = /is, contains or lies inside the hoptell home/;
  assert.match(v(doc(HARD), UNGATED).join(), today, "hardening not gated: today's rule");
  assert.match(v(doc({})).join(), today, "plain");
  assert.match(v(doc({ sandbox: "workspace-write" }), gated).join(), today, "workspace-write");
  assert.match(v(doc({ cli: "claude" }), gated).join(), today, "claude");
});

test("approval: the view names the mode and lists only gated modes; hardening shows its text then R7, and never says containment; an ungated mode is refused at approval (adapter_gate_unverified)", async (t) => {
  const s = await hardWorld(t);
  // A hardened profile not approved yet, with hardening gated (the test's gates).
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "hard", name: { prefix: "hard" }, command: s.codex, ...HARD }));
  const out = [];
  const cli = (args, deps = { gates: s.gates }) => agentsCommand({ args, home: s.w.home, env: s.ctx.env, homedir: s.w.homedir, out: (l) => out.push(l), fail: (m, code) => {
    throw Object.assign(new Error(m), { exitCode: code });
  }, sources: { deps } });
  await assert.rejects(cli(["profile", "approve", "hard"]), /Not approved: read the warning above/);
  const text = out.join("\n");
  assert.match(text, /Headless mode: hardening: path-deny hardening/);
  assert.match(text, /Headless modes available on this hoptell: plain, hardening/);
  const h4 = out.indexOf(HARDENING_APPROVAL_TEXT);
  const r7 = out.indexOf(`WARNING: ${CODEX_APPROVAL_WARNING}`);
  assert.ok(h4 >= 0 && r7 > h4, "the H4 text, then R7, verbatim");
  assert.doesNotMatch(text, /containment/i);
  out.length = 0;
  await cli(["profile", "approve", "hard", "--accept-read-risk"]);
  assert.match(out.at(-1), /^Approved/);
  // Hardening not gated: a hardened profile is not approvable.
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "hard2", name: { prefix: "hard2" }, command: s.codex, ...HARD, folders: { roots: [s.w.work], default: s.w.work } }));
  out.length = 0;
  await assert.rejects(cli(["profile", "approve", "hard2", "--accept-read-risk"], { gates: UNGATED }), /adapter_gate_unverified: headless mode hardening is not available/);
  assert.match(out.join("\n"), /Headless modes available on this hoptell: plain$/m);
  // A hand-edited containment profile: refused at approval, with no label for it.
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "cont", name: { prefix: "cont" }, command: s.codex, codex: { headlessMode: "containment" } }));
  out.length = 0;
  await assert.rejects(cli(["profile", "approve", "cont", "--accept-read-risk"]), /adapter_gate_unverified/);
  assert.match(out.join("\n"), /Headless mode: containment \(not offered\)/);
  assert.doesNotMatch(out.join("\n"), /Headless modes available on this hoptell: .*containment/);
  // ... and refused at spawn.
  await withAgentsLock(s.w.home, () => writeApproved(s.w.home, "cont", readProfile(s.w.home, "cont").digest));
  assert.equal((await spawnAgent(s.ctx, { profile: "cont", task: "t" })).error, "adapter_gate_unverified");
  // A plain profile: its label, and R7 alone.
  writeProfile(s.w.home, profileDoc(s.w.work, { id: "plainp", name: { prefix: "plainp" }, command: s.codex, folders: { roots: [s.w.work], default: s.w.work } }));
  out.length = 0;
  await assert.rejects(cli(["profile", "approve", "plainp"]), /Not approved/);
  assert.match(out.join("\n"), /Headless mode: plain: read-only \(direct shell writes and network access denied; reads not contained\)/);
  assert.ok(!out.includes(HARDENING_APPROVAL_TEXT));
  assert.ok(out.includes(`WARNING: ${CODEX_APPROVAL_WARNING}`));
});

// ---- spawn, start, tick ------------------------------------------------------------------------------

test("hardened run: spawned and started in its mode; one environment object for C, the preflight and the CLI (with RUST_LOG); the preflight runs once per start; the stream is split into output and log", async (t) => {
  const s = await hardWorld(t);
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "review CLOUD:none,none" });
  assert.equal(r.error, undefined, r.message);
  const rec = readRun(s.w.home, r.run);
  assert.equal(rec.state, "exited", rec.errorText);
  assert.equal(rec.plan.mode, "hardening");
  assert.match(rec.plan.profileId, PROFILE_ID_RE);
  assert.ok(rec.plan.deny.includes(s.w.home) && rec.plan.deny.includes(path.join(s.w.base, "me.token")) && rec.plan.deny.includes(s.relaysFile) && rec.plan.deny.includes(path.join(s.w.homedir, ".codex")));
  assert.equal(rec.ownerRelays, s.relaysFile);
  const [call] = calls(s.logs);
  assert.ok(!call.args.includes("-s"));
  assert.equal(call.env.RUST_LOG, "codex_cloud_config=info");
  // The same environment: the CLI's, and the preflight's but for its own empty CODEX_HOME.
  const [spawnArgs] = s.spawned;
  const env1 = spawnArgs[2].env;
  assert.equal(env1.RUST_LOG, "codex_cloud_config=info");
  for (const c of s.pf.calls) assert.deepEqual({ ...c.env, CODEX_HOME: undefined }, { ...env1, CODEX_HOME: undefined });
  assert.ok(s.pf.calls.some((c) => c.args.at(-1) === s.w.work), "the cwd");
  assert.ok(s.pf.calls.some((c) => c.args.at(-1) === s.w.home), "a deny root");
  assert.ok(s.pf.calls.some((c) => c.args.at(-1) === path.join(s.w.base, "me.token")), "a token file");
  const n = s.pf.calls.length;
  // A second start runs it again.
  const r2 = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "again CLOUD:none,none" });
  assert.equal(readRun(s.w.home, r2.run).state, "exited");
  assert.ok(s.pf.calls.length >= 2 * n, "no preflight result is reused");
  // The stream: JSON lines to output, the rest (the cloud lines) to the log.
  const p = runPaths(s.w.home, r.run);
  assert.equal(fs.readFileSync(p.output, "utf8"), '{"type":"done"}\n');
  assert.match(fs.readFileSync(p.log, "utf8"), /Cloud config bundle load completed \(none\)/);
  assert.ok(!readAudit(s.w.home, { run: r.run }).some((e) => e.event === "codex_cloud_config_observed"), "two (none) lines: no audit event");
  assert.ok(!(rec.result.notes ?? []).includes(CLOUD_NOTE));
  assert.equal(readAudit(s.w.home, { run: r.run }).find((e) => e.event === "started").headlessMode, "hardening");
});

/** Spawn with a start that first changes something, then runs the in-process supervisor. */
async function changedBeforeStart(s, change, { task = "t", env = null } = {}) {
  const before = s.spawned.length;
  let id = null;
  const r = await spawnAgent({ ...s.ctx, deps: { ...s.ctx.deps, start: async (home, run, o) => {
    id = run;
    await change(run);
    return supervised(home, run, s.hooks, env ? { env: env(o.env) } : o);
  } } }, { profile: "codex-reviewer", task });
  return { r, rec: id ? readRun(s.w.home, id) : null, spawnedNow: s.spawned.length - before, error: r.error };
}

test("start-time revalidation: each change between the plan and the start ends the run failed with read_containment_unverified, and the CLI is never started", async (t) => {
  const s = await hardWorld(t, { profile: { env: { pass: ["CODEX_HOME", "LAB_TOKEN"] } } });
  const relays = (list) => writeRelays(s.relaysFile, list);
  const local = { alias: "local", url: "ws://127.0.0.1:9", tokenFile: "me.token", namePrefix: "me-", installId: "i-test" };
  const reset = () => {
    relays([local]);
    s.managed.value = null;
    s.pf.allow.clear();
  };
  const cases = {
    "a token file's path changed": () => relays([{ ...local, tokenFile: "other.token" }]),
    "a new entry with a duplicate alias": () => relays([local, { ...local, tokenFile: "dup.token" }]),
    "the relays file made unreadable": () => fs.chmodSync(s.relaysFile, 0o644),
    "the relays file made invalid": () => fs.writeFileSync(s.relaysFile, "{", { mode: 0o600 }),
    "a token file that gained a hard link": () => fs.linkSync(path.join(s.w.base, "me.token"), path.join(s.w.base, `me-link-${crypto.randomBytes(2).toString("hex")}`)),
    "a new tokenEnv named in env.pass": () => relays([local, { alias: "lab", url: "ws://x", tokenEnv: "LAB_TOKEN" }]),
    "a managed source present": () => (s.managed.value = { present: ["/etc/codex/config.toml"] }),
    "a preflight stat that succeeds": () => s.pf.allow.add(s.w.home),
  };
  for (const [name, change] of Object.entries(cases)) {
    reset();
    for (const f of fs.readdirSync(s.w.base)) if (f.startsWith("me-link-")) fs.rmSync(path.join(s.w.base, f));
    const x = await changedBeforeStart(s, change);
    assert.ok(x.rec, `${name}: ${JSON.stringify(x.r)}`);
    assert.equal(x.error, "read_containment_unverified", `${name}: ${x.error} ${JSON.stringify(x.r)}`);
    assert.equal(x.rec.state, "failed", name);
    assert.equal(x.rec.error, "read_containment_unverified", name);
    assert.equal(x.spawnedNow, 0, `${name}: the CLI was started`);
    fs.chmodSync(s.relaysFile, 0o600);
  }
  reset();
  // A symlinked token file retargeted.
  fs.writeFileSync(path.join(s.w.base, "t1.token"), "x", { mode: 0o600 });
  fs.writeFileSync(path.join(s.w.base, "t2.token"), "x", { mode: 0o600 });
  fs.symlinkSync(path.join(s.w.base, "t1.token"), path.join(s.w.base, "link.token"));
  relays([local, { alias: "l2", url: "ws://x", tokenFile: "link.token" }]);
  let x = await changedBeforeStart(s, () => {
    fs.rmSync(path.join(s.w.base, "link.token"));
    fs.symlinkSync(path.join(s.w.base, "t2.token"), path.join(s.w.base, "link.token"));
  });
  assert.equal(x.rec.error, "read_containment_unverified", "a retargeted symlink");
  assert.equal(x.spawnedNow, 0);
  // CODEX_HOME changed through env.pass (the supervisor's environment differs from the spawn's).
  reset();
  x = await changedBeforeStart(s, () => {}, { env: (e) => ({ ...e, CODEX_HOME: path.join(s.w.base, "moved-codex-home") }) });
  assert.equal(x.rec.error, "read_containment_unverified", "CODEX_HOME moved");
  assert.match(x.rec.errorText, /deny table differs/);
  // The profile re-read at start: changed, unapproved.
  reset();
  x = await changedBeforeStart(s, () => writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, ...HARD, limits: { concurrent: 8, perHour: 60 }, env: { pass: ["CODEX_HOME", "LAB_TOKEN"] }, description: "changed" })));
  assert.equal(x.rec.error, "read_containment_unverified", "a changed profile");
  assert.equal(x.spawnedNow, 0);
});

test("confirmation: a hardened pending run is refused when its inputs changed or the confirming surface resolves another relays file; the plan is never rebuilt", async (t) => {
  const s = await hardWorld(t, { confirm: "always" });
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.state, "pending-confirmation", r.message);
  const plan0 = JSON.stringify(readRun(s.w.home, r.run).plan);
  const go = (env = s.ctx.env) => startConfirmed(s.w.home, r.run, { env, homedir: s.w.homedir, deps: { ...s.ctx.deps } });
  writeRelays(s.relaysFile, [{ alias: "local", url: "ws://127.0.0.1:9", tokenFile: "other.token", namePrefix: "me-", installId: "i-test" }]);
  const a = await go();
  assert.equal(a.error, "read_containment_unverified");
  assert.match(a.message, /deny table differs/);
  writeRelays(s.relaysFile, [{ alias: "local", url: "ws://127.0.0.1:9", tokenFile: "me.token", namePrefix: "me-", installId: "i-test" }]);
  const b = await go({ ...s.ctx.env, HOPTELL_RELAYS: path.join(s.w.base, "other-relays.json") });
  assert.equal(b.error, "read_containment_unverified");
  assert.match(b.message, /resolves the relays file/);
  s.managed.value = { problem: "osascript: exit 1" };
  assert.equal((await go()).error, "read_containment_unverified");
  s.managed.value = null;
  assert.equal(JSON.stringify(readRun(s.w.home, r.run).plan), plan0, "the plan was not rebuilt");
  const ok = await go();
  assert.equal(ok.error, undefined, ok.message);
  assert.equal(readRun(s.w.home, r.run).state, "exited");
});

test("binding: a plan whose mode differs from the profile's, a mode that became ungated, or a shape that is not its mode's is refused at confirmation and at start; a record without a mode starts only with a gated plain shape", async (t) => {
  const s = await hardWorld(t, { confirm: "always" });
  const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(r.state, "pending-confirmation");
  const go = (deps = {}) => startConfirmed(s.w.home, r.run, { env: s.ctx.env, homedir: s.w.homedir, deps: { ...s.ctx.deps, ...deps } });
  // The mode became ungated (hardening not recorded).
  assert.equal((await go({ gates: { codex: { headless: { modes: { plain: s.gates.codex.headless.modes.plain } } } } })).error, "adapter_gate_unverified");
  // The stored plan's mode altered: it no longer matches the profile's.
  await updateRun(s.w.home, r.run, (x) => void (x.plan.mode = "plain"));
  assert.equal((await go()).error, "adapter_gate_unverified");
  // A stored argument added: not the shape of its mode.
  await updateRun(s.w.home, r.run, (x) => {
    x.plan.mode = "hardening";
    x.plan.args.splice(-1, 0, "--extra");
  });
  assert.equal((await go()).error, "adapter_gate_unverified");
  assert.equal(s.spawned.length, 0);
  // At start: a plan made for hardening whose profile is now plain (re-approved) is refused, and
  // never run as plain.
  const y = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  assert.equal(y.state, "pending-confirmation");
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, confirm: "always" }));
  await approve(s.w, "codex-reviewer");
  const pending = readRun(s.w.home, y.run);
  await updateRun(s.w.home, y.run, (z) => void (z.state = "starting"));
  await supervise(s.w.home, y.run, s.hooks, { env: s.ctx.env });
  const ended = readRun(s.w.home, y.run);
  assert.equal(ended.state, "failed");
  assert.equal(ended.error, "read_containment_unverified");
  assert.match(ended.errorText, /changed or no longer approved/);
  assert.equal(s.spawned.length, 0, "no spawn with another mode's shape");
  // A hardened plan relabelled plain in its record, its profile still hardening: refused at start,
  // never run as plain.
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, ...HARD, limits: { concurrent: 8, perHour: 60 }, confirm: "always" }));
  await approve(s.w, "codex-reviewer");
  const z = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
  await updateRun(s.w.home, z.run, (q) => {
    q.plan.mode = "plain";
    q.state = "starting";
  });
  await supervise(s.w.home, z.run, s.hooks, { env: s.ctx.env });
  const relabelled = readRun(s.w.home, z.run);
  assert.equal(relabelled.state, "failed");
  assert.equal(relabelled.error, "adapter_gate_unverified");
  assert.match(relabelled.errorText, /made for headless mode plain, and its profile now asks for hardening/);
  assert.equal(s.spawned.length, 0);
  assert.equal(pending.plan.mode, "hardening");
});

test("migration: a pending record without plan.mode starts as plain only with a gated plain shape; any other is refused (adapter_gate_unverified)", async (t) => {
  const s = await hardWorld(t, { confirm: "always", profile: { codex: undefined, folders: undefined } });
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, confirm: "always", limits: { concurrent: 8 } }));
  await approve(s.w, "codex-reviewer");
  const make = async () => {
    const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
    assert.equal(r.state, "pending-confirmation", r.message);
    return r.run;
  };
  const go = (run) => startConfirmed(s.w.home, run, { env: s.ctx.env, homedir: s.w.homedir, deps: { ...s.ctx.deps, start: async (home, id) => readRun(home, id) } });
  const a = await make();
  await updateRun(s.w.home, a, (x) => void delete x.plan.mode);
  assert.equal((await go(a)).error, undefined, "a recorded plain shape: started as plain");
  const b = await make();
  await updateRun(s.w.home, b, (x) => {
    delete x.plan.mode;
    x.plan.args.splice(-1, 0, "--extra");
  });
  assert.equal((await go(b)).error, "adapter_gate_unverified", "an unrecorded shape");
  const c = await make();
  await updateRun(s.w.home, c, (x) => {
    delete x.plan.mode;
    x.plan.args = "not a list";
  });
  assert.equal((await go(c)).error, "adapter_gate_unverified", "an unparsable plan");
});

test("per tick: a change during the run stops it within a tick with read_containment_changed (100 ms grace), marked partial and 'stopped after start'; with no change it never stops", async (t) => {
  const s = await hardWorld(t);
  const local = { alias: "local", url: "ws://127.0.0.1:9", tokenFile: "me.token", namePrefix: "me-", installId: "i-test" };
  const during = async (change) => {
    let id = null;
    await spawnAgent({ ...s.ctx, deps: { ...s.ctx.deps, start: async (home, run, o) => {
      id = run;
      const done = supervised(home, run, s.hooks, o);
      for (let i = 0; i < 200 && readRun(home, run)?.state !== "running"; i++) await new Promise((res) => setTimeout(res, 25));
      await new Promise((res) => setTimeout(res, 150));
      await change();
      return done;
    } } }, { profile: "codex-reviewer", task: "SLEEP" });
    return readRun(s.w.home, id);
  };
  const cases = {
    "the relays file made invalid": () => fs.writeFileSync(s.relaysFile, "{", { mode: 0o600 }),
    "a token file path changed": () => writeRelays(s.relaysFile, [{ ...local, tokenFile: "else.token" }]),
    "a token file gained a hard link": () => fs.linkSync(path.join(s.w.base, "me.token"), path.join(s.w.base, "tick-link")),
    "the profile unapproved": () => withAgentsLock(s.w.home, () => writeApproved(s.w.home, "codex-reviewer", "0".repeat(64))),
    "a managed source appeared": () => (s.managed.value = { present: ["/etc/codex/requirements.toml"] }),
  };
  for (const [name, change] of Object.entries(cases)) {
    writeRelays(s.relaysFile, [local]);
    fs.rmSync(path.join(s.w.base, "tick-link"), { force: true });
    s.managed.value = null;
    await approve(s.w, "codex-reviewer");
    const t0 = Date.now();
    const rec = await during(change);
    assert.equal(rec.state, "failed", `${name}: ${rec.state}`);
    assert.equal(rec.error, "read_containment_changed", name);
    assert.match(rec.errorText, /stopped after start/);
    assert.ok(rec.result.notes.some((n) => /^stopped after start: .*the result is partial$/.test(n)), name);
    assert.ok(!rec.result.notes.some((n) => /refus/.test(n)), "never called a refusal");
    assert.ok(Date.now() - t0 < 15_000, `${name}: stopped within a tick, not after the run's grace`);
    assert.ok(readAudit(s.w.home, { run: rec.run }).some((e) => e.event === "read_containment_changed"), name);
  }
  // A new entry whose tokenEnv is in env.pass, with the deny table unchanged.
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, ...HARD, limits: { concurrent: 8, perHour: 60 }, env: { pass: ["LAB_TOKEN"] } }));
  await approve(s.w, "codex-reviewer");
  writeRelays(s.relaysFile, [local]);
  s.managed.value = null;
  const rec = await during(() => writeRelays(s.relaysFile, [local, { alias: "lab", url: "ws://x", tokenEnv: "LAB_TOKEN" }]));
  assert.equal(rec.error, "read_containment_changed");
  assert.match(rec.errorText, /LAB_TOKEN/);
  // No change: runs to its end.
  writeRelays(s.relaysFile, [local]);
  setTimeout(() => fs.writeFileSync(path.join(s.w.base, "go"), ""), 600);
  let quietId = null;
  await spawnAgent({ ...s.ctx, deps: { ...s.ctx.deps, start: (home, run, o) => supervised(home, (quietId = run), s.hooks, o) } }, { profile: "codex-reviewer", task: `WAIT:${path.join(s.w.base, "go")} CLOUD:none,none` });
  const quiet = readRun(s.w.home, quietId);
  assert.equal(quiet.state, "exited", "several ticks with no change: never stopped");
  assert.ok(!readAudit(s.w.home, { run: quietId }).some((e) => e.event === "read_containment_changed"));
});

test("cloud stream, hardening (audit only): fewer than two (none) lines, a loaded, cached or other line, before or after the first event: the run continues, one audit event per observation with its class, the run note; no line content is stored", async (t) => {
  const s = await hardWorld(t);
  // One generic note for every class: it names no cause (an `other` line has none known).
  assert.equal(CLOUD_NOTE, "Codex's cloud-config stream was unexpected. Path denial may not have applied as configured.");
  const cases = [
    ["CLOUD:none", ["missing_none"]],
    ["CLOUD:none,none,loaded", ["loaded"]],
    ["CLOUD:none,none,cached", ["cached"]],
    ["CLOUD:none,none,other", ["other"]],
    ["CLOUD:none,none LATE:loaded", ["loaded"]],
  ];
  for (const [task, classes] of cases) {
    const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task });
    const rec = readRun(s.w.home, r.run);
    assert.equal(rec.state, "exited", `${task}: the run continues`);
    const events = readAudit(s.w.home, { run: r.run }).filter((e) => e.event === "codex_cloud_config_observed");
    assert.deepEqual(events.map((e) => e.class), classes, task);
    if (classes[0] === "loaded") assert.deepEqual(events[0].counts, { config_fragments: 2, requirements_fragments: 1 });
    assert.ok(!JSON.stringify(events).includes("secret-looking-text"), "no line content");
    assert.ok(rec.result.notes.includes(CLOUD_NOTE), task);
    assert.equal(fs.readFileSync(runPaths(s.w.home, r.run).output, "utf8"), '{"type":"done"}\n', "only the JSON line in output");
  }
});

test("plain at start: a plain plan whose profile became hardening, or whose stored arguments carry the hardened slots or lost -s, is refused before the CLI starts; an unchanged one starts", async (t) => {
  const s = await hardWorld(t, { confirm: "always" });
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, confirm: "always", limits: { concurrent: 8, perHour: 60 } }));
  await approve(s.w, "codex-reviewer");
  const pending = async (edit = () => {}) => {
    const r = await spawnAgent(s.ctx, { profile: "codex-reviewer", task: "t" });
    assert.equal(r.state, "pending-confirmation", r.message);
    assert.equal(readRun(s.w.home, r.run).plan.mode, "plain");
    await updateRun(s.w.home, r.run, (x) => {
      edit(x);
      x.state = "starting";
    });
    return r.run;
  };
  const started = async (run) => {
    await supervise(s.w.home, run, s.hooks, { env: s.ctx.env });
    return readRun(s.w.home, run);
  };
  const id = `hoptell_${"e".repeat(32)}`;
  const hardSlots = (x) => {
    const i = x.plan.args.indexOf("-s");
    x.plan.args.splice(i, 2, "-c", `default_permissions="${id}"`, "-c", `permissions.${id}.extends=":read-only"`, "-c", `permissions.${id}.filesystem={}`);
  };
  let rec = await started(await pending(hardSlots));
  assert.equal(rec.state, "failed");
  assert.equal(rec.error, "adapter_gate_unverified");
  assert.match(rec.errorText, /not the shape of its profile's mode/);
  rec = await started(await pending((x) => x.plan.args.splice(x.plan.args.indexOf("-s"), 2)));
  assert.equal(rec.error, "adapter_gate_unverified", "-s removed");
  const a = await pending();
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, ...HARD, confirm: "always", limits: { concurrent: 8, perHour: 60 } }));
  await approve(s.w, "codex-reviewer");
  rec = await started(a);
  assert.equal(rec.state, "failed", "the profile became hardening (re-approved)");
  assert.match(rec.errorText, /changed or no longer approved/);
  assert.equal(s.spawned.length, 0, "the CLI never started");
  writeProfile(s.w.home, profileDoc(s.w.work, { command: s.codex, confirm: "always", limits: { concurrent: 8, perHour: 60 } }));
  await approve(s.w, "codex-reviewer");
  rec = await started(await pending());
  assert.equal(rec.state, "exited", rec.errorText);
  // The plain gate revoked after the spawn (an update): refused at start, before the CLI.
  const revoked = await pending();
  const before = s.spawned.length;
  await supervise(s.w.home, revoked, { ...s.hooks, gates: { codex: { headless: { modes: { plain: { passed: null, refusal: "adapter_gate_unverified" } } } } } }, { env: s.ctx.env });
  rec = readRun(s.w.home, revoked);
  assert.equal(rec.error, "adapter_gate_unverified");
  assert.match(rec.errorText, /adapter gates have not passed/);
  assert.equal(s.spawned.length, before);
});

test("the confirming surface's relays file: a relative HOPTELL_RELAYS resolves against the surface's working folder (settings.js's rule) and names the recorded file", (t) => {
  const w = agentsWorld(t);
  const f = path.join(w.base, "relays.json");
  fs.writeFileSync(f, "{}", { mode: 0o600 });
  assert.equal(ownerRelaysFile({ HOPTELL_RELAYS: "relays.json" }, w.homedir, w.base), f);
  assert.ok(sameFile(ownerRelaysFile({ HOPTELL_RELAYS: path.relative(process.cwd(), f) }, w.homedir), f));
  assert.ok(!sameFile(path.join(w.base, "other.json"), f));
  if (fs.existsSync("/private/tmp")) assert.ok(sameFile(f.replace(/^\/private/, ""), f) || !f.startsWith("/private"), "another spelling of the same file");
});
