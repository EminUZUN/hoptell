// CLI adapters of spawned agents (design 7.1, "Per-CLI mapping", "Adapter gates", Tests:
// "Adapters"): the generated argument lists against fixtures, refused flags, the run-only server
// in each CLI's own configuration, the per-spawn help check, the version warning, the approval
// view's command lines. No real CLI is run here; the help texts are fixtures captured from
// codex-cli 0.164.0 and Claude Code 2.1.296.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentsWorld, profileDoc, writeProfile } from "./agents-helpers.js";
import { CLIS, CODEX_FEATURES_OFF, GATES, REFUSED, buildPlan, checkCli, commandLines, featuresNotOff, gateRefusal, gateShape, helpNeeds, missingInHelp, nativeBinary, nativeDigest, resolveCommand, shapeArgs } from "../lib/agentadapters.js";
import { cliProblem } from "../lib/agentruns.js";
import { profileView } from "../lib/agents.js";
import * as decisions from "../lib/decisions.js";
import { agentsCommand } from "../lib/agentscli.js";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const HELP = {
  codexExec: fs.readFileSync(path.join(FIX, "help", "codex-exec-0.164.0.txt"), "utf8"),
  codex: fs.readFileSync(path.join(FIX, "help", "codex-0.164.0.txt"), "utf8"),
  claude: fs.readFileSync(path.join(FIX, "help", "claude-2.1.296.txt"), "utf8"),
  // `codex features list` with the run's -c features.<name>=false overrides (0.164.0).
  codexFeatures: fs.readFileSync(path.join(FIX, "help", "codex-features-0.164.0.txt"), "utf8"),
};
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIX, "agent-adapter-plans.json"), "utf8"));

/** A checked profile of `cli` with both modes, as a spawn sees it. */
function profileOf(cli, sandbox, extra = {}) {
  const doc = { version: 1, id: `${cli}-p`, cli, modes: ["headless", "tmux"], sandbox, folders: { roots: ["/work"], default: "/work" }, name: { prefix: cli }, ...extra };
  return { ...doc, limits: { lifetimeMinutes: 30, ...(extra.limits ?? {}) }, cliOptions: extra.cliOptions ?? {} };
}
const RUN = "r-0123456789abcdef";
const ctxOf = (profile, mode) => {
  const dir = `/h/agents/runs/${RUN}`;
  return {
    profile,
    mode,
    run: RUN,
    home: "/h",
    cwd: "/work/sub",
    name: "agent-1a2b",
    command: `/bin/${profile.cli}`,
    hoptell: { node: "/node", bin: "/hoptell/bin/hoptell.js" },
    paths: { env: `${dir}/env`, relays: `${dir}/relays.json`, mcp: `${dir}/mcp.json`, result: `${dir}/result` },
    resultTo: "me-owner",
    lifetimeMinutes: 30,
  };
};
const everyPlan = (extra = {}) =>
  CLIS.flatMap((cli) =>
    ["read-only", "workspace-write"].flatMap((sb) =>
      ["headless", "tmux"].map((mode) => {
        const profile = profileOf(cli, sb, extra[cli] ?? {});
        const { plan, files } = buildPlan(ctxOf(profile, mode));
        return { key: `${cli}/${mode}/${sb}`, cli, mode, sb, plan, files, args: mode === "headless" ? plan.args : plan.cli.args };
      }),
    ),
  );

/** The digest checkCli reports: the file the command resolves to. */
const digestOf = (command) => crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(command))).digest("hex");

test("adapters: the argument list for every CLI, mode and sandbox level matches its fixture", () => {
  const got = Object.fromEntries(everyPlan().map((p) => [p.key, p.plan]));
  assert.deepEqual(Object.keys(got).sort(), Object.keys(EXPECTED).sort());
  for (const [k, v] of Object.entries(EXPECTED)) assert.deepEqual(got[k], v, k);
});

test("adapters: options map as the CLI names them; refused flags and extra directories never appear; the task is never an argument", () => {
  const opts = {
    codex: { cliOptions: { model: "gpt-5.5", effort: "max" } },
    claude: { cliOptions: { model: "opus", effort: "minimal", allowedTools: ["Read", "Bash(git diff:*)"], disallowedTools: ["WebFetch"] }, limits: { budgetUsd: 2 } },
    gemini: { cliOptions: { model: "gemini-3" } },
    agy: { cliOptions: { model: "m1" } },
  };
  const all = [...everyPlan(), ...everyPlan(opts)];
  for (const p of all) {
    const words = [...p.args, ...(p.plan.command ? [p.plan.command] : [])];
    for (const bad of [...REFUSED.all, ...REFUSED[p.cli]]) assert.ok(!words.includes(bad), `${p.key}: ${bad}`);
    assert.ok(!words.some((w) => /^--(add-dir|include-directories)(=|$)/.test(w)), p.key);
    assert.ok(!words.some((w) => /dangerously|yolo|bypassPermissions|full-access/.test(w)), p.key);
    if (p.cli === "codex" && p.mode === "tmux") assert.equal(p.args[p.args.indexOf("-a") + 1], "on-request");
    if (p.mode === "headless") assert.equal(p.plan.stdin, "task", `${p.key}: the task goes on stdin`);
    else assert.match(p.args.at(-1), /^Call the hoptell read_task tool for your task\. When you are done, send the result to me-owner with send_message\.$/);
  }
  const codex = everyPlan(opts).find((p) => p.key === "codex/headless/read-only").args;
  assert.deepEqual(codex.slice(codex.indexOf("-m"), codex.indexOf("-m") + 4), ["-m", "gpt-5.5", "-c", 'model_reasoning_effort="xhigh"']);
  const claude = everyPlan(opts).find((p) => p.key === "claude/headless/workspace-write").args;
  for (const pair of [["--max-budget-usd", "2"], ["--effort", "low"], ["--model", "opus"], ["--allowedTools", "Bash(git diff:*)"], ["--disallowedTools", "WebFetch"], ["--permission-prompts", "none"], ["--permission-mode", "acceptEdits"]]) {
    assert.ok(claude.some((w, i) => w === pair[0] && claude[i + 1] === pair[1]), pair.join(" "));
  }
  // The variadic options never take the positional prompt: a single-value option comes last.
  const tmux = everyPlan(opts).find((p) => p.key === "claude/tmux/read-only").args;
  assert.deepEqual(tmux.slice(-3, -1), ["-n", "agent-1a2b"]);
  assert.ok(!tmux.includes("--max-budget-usd"), "the budget flag is headless only");
});

test("adapters: the run-only hoptell server is in Codex's -c overrides (with --ignore-user-config) and in Claude Code's mcp.json", () => {
  const codex = buildPlan(ctxOf(profileOf("codex", "read-only"), "headless")).plan.args;
  assert.ok(codex.includes("--ignore-user-config"));
  const c = (k) => codex[codex.findIndex((w) => w.startsWith(`mcp_servers.hoptell.${k}=`))];
  assert.equal(c("command"), 'mcp_servers.hoptell.command="/node"');
  assert.equal(c("args"), `mcp_servers.hoptell.args=["/hoptell/bin/hoptell.js", "mcp", "--run", "${RUN}", "--home", "/h"]`);
  assert.equal(c("env"), `mcp_servers.hoptell.env={HOPTELL_RUN="${RUN}", HOPTELL_HOME="/h", HOPTELL_ENV="/h/agents/runs/${RUN}/env", HOPTELL_RELAYS="/h/agents/runs/${RUN}/relays.json"}`);
  assert.ok(codex.includes('approval_policy="never"'));
  // TOML strings: quotes and backslashes are escaped.
  const odd = buildPlan({ ...ctxOf(profileOf("codex", "read-only"), "headless"), home: '/h "x"\\y' }).plan.args;
  assert.ok(odd.includes('mcp_servers.hoptell.env={HOPTELL_RUN="r-0123456789abcdef", HOPTELL_HOME="/h \\"x\\"\\\\y", HOPTELL_ENV="/h/agents/runs/r-0123456789abcdef/env", HOPTELL_RELAYS="/h/agents/runs/r-0123456789abcdef/relays.json"}'));
  for (const mode of ["headless", "tmux"]) {
    const { plan, files } = buildPlan(ctxOf(profileOf("claude", "read-only"), mode));
    const args = mode === "headless" ? plan.args : plan.cli.args;
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--mcp-config") + 1], `/h/agents/runs/${RUN}/mcp.json`);
    assert.deepEqual(files.mcp, { mcpServers: { hoptell: { type: "stdio", command: "/node", args: ["/hoptell/bin/hoptell.js", "mcp", "--run", RUN, "--home", "/h"], env: { HOPTELL_RUN: RUN, HOPTELL_HOME: "/h", HOPTELL_ENV: `/h/agents/runs/${RUN}/env`, HOPTELL_RELAYS: `/h/agents/runs/${RUN}/relays.json` } } } });
  }
});

test("adapter gates: Gemini and agy and Codex in tmux are refused for MCP isolation; the others until their gates pass", () => {
  assert.equal(gateRefusal("gemini", "headless"), "mcp_isolation_unverified");
  assert.equal(gateRefusal("gemini", "tmux"), "mcp_isolation_unverified");
  assert.equal(gateRefusal("agy", "headless"), "mcp_isolation_unverified");
  assert.equal(gateRefusal("agy", "tmux"), "mcp_isolation_unverified");
  assert.equal(gateRefusal("codex", "tmux"), "mcp_isolation_unverified");
  // Codex headless passed its gates on one exact binary of 0.164.0 with the read-only argument
  // shape (test/agents-gates.test.js checks the record): only that binary and shape run.
  const [b] = GATES.codex.headless.modes.plain.passed.binaries;
  const ro = gateShape(profileOf("codex", "read-only"), "headless");
  const facts = { version: b.version, digest: b.launcher, native: b.native, shape: ro };
  assert.equal(gateRefusal("codex", "headless"), null, "the approval view: not refused on every binary");
  assert.equal(gateRefusal("codex", "headless", facts), null);
  assert.equal(gateRefusal("codex", "headless", { ...facts, version: "0.164.1" }), "adapter_gate_unverified", "another version");
  assert.equal(gateRefusal("codex", "headless", { ...facts, digest: "0".repeat(64) }), "adapter_gate_unverified", "another launcher");
  assert.equal(gateRefusal("codex", "headless", { ...facts, native: "0".repeat(64) }), "adapter_gate_unverified", "another native binary");
  assert.equal(gateRefusal("codex", "headless", { ...facts, native: null }), "adapter_gate_unverified", "no native binary found");
  assert.equal(gateRefusal("codex", "headless", { ...facts, shape: gateShape(profileOf("codex", "workspace-write"), "headless") }), "adapter_gate_unverified", "workspace-write was not gated");
  assert.equal(gateRefusal("codex", "headless", {}), "adapter_gate_unverified", "no facts");
  assert.equal(GATES.codex.headless.modes.plain.family, "0.164");
  assert.equal(gateRefusal("claude", "headless"), "adapter_gate_unverified");
  assert.equal(gateRefusal("claude", "tmux"), "adapter_gate_unverified");
  assert.equal(gateRefusal("nope", "headless"), "adapter_gate_unverified");
  // The argument shape leaves out only the model and the effort.
  assert.equal(gateShape({ ...profileOf("codex", "read-only"), cliOptions: { model: "gpt-x", effort: "max" } }, "headless"), ro);
  assert.deepEqual(shapeArgs("codex", ["a", "-m", "x", "-c", 'model_reasoning_effort="low"', "-c", "other=1", "-"]), ["a", "-c", "other=1", "-"]);
});

test("help check: the installed help lists every flag and value used; a missing or renamed flag or a dropped value is cli_flags_changed", () => {
  for (const sb of ["read-only", "workspace-write"]) {
    assert.deepEqual(missingInHelp(HELP.codexExec, helpNeeds(profileOf("codex", sb, { cliOptions: { model: "m" } }), "headless")), []);
    assert.deepEqual(missingInHelp(HELP.codex, helpNeeds(profileOf("codex", sb), "tmux")), []);
    for (const mode of ["headless", "tmux"]) assert.deepEqual(missingInHelp(HELP.claude, helpNeeds(profileOf("claude", sb, { cliOptions: { model: "m", effort: "high", allowedTools: ["Read"], disallowedTools: ["X"] }, limits: { budgetUsd: 1 } }), mode)), [], `claude ${mode} ${sb}`);
  }
  assert.deepEqual(helpNeeds(profileOf("codex", "read-only"), "headless").helpArgs, ["exec", "--help"], "the exact subcommand's help");
  const needs = helpNeeds(profileOf("codex", "read-only"), "headless");
  assert.deepEqual(missingInHelp(HELP.codexExec.replace(/--ignore-user-config/g, "--ignore-config"), needs), ["--ignore-user-config"]);
  assert.deepEqual(missingInHelp(HELP.codexExec.replace(/--ephemeral/g, "--no-persist"), needs), ["--ephemeral"]);
  assert.deepEqual(missingInHelp(HELP.codexExec.replace(/read-only, /g, ""), needs), ["value read-only"]);
  const cl = helpNeeds(profileOf("claude", "read-only"), "headless");
  assert.deepEqual(missingInHelp(HELP.claude.replace(/--permission-prompts/g, "--prompts"), cl), ["--permission-prompts", "value none"], "a renamed flag loses its value too");
  assert.deepEqual(missingInHelp(HELP.claude.replace('"host", "none", default', '"host", default').replace('or "none"', "or"), cl), ["value none"], "a choice dropped from the flag's own block");
  // A value counts only inside its flag's block: "plan" elsewhere in the help does not help.
  const noPlan = `${HELP.claude.replace('"dontAsk", "plan")', '"dontAsk")')}\n  --other <x>   Use a plan file\n`;
  assert.match(noPlan, /\bplan\b/);
  assert.deepEqual(missingInHelp(noPlan, cl), ["value plan"]);
});

test("help check: version and help are read from the binary, cached per digest and version; an untested version warns and runs", (t) => {
  const w = agentsWorld(t);
  const bin = path.join(w.base, "codex");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const calls = [];
  const fake = (version, help, features = HELP.codexFeatures) => (_command, args) => {
    calls.push(args[0] === "features" ? "features list" : args.join(" "));
    if (args[0] === "--version") return `codex-cli ${version}\n`;
    if (args[0] === "features") return features;
    return help;
  };
  const prof = profileOf("codex", "read-only");
  assert.throws(() => checkCli(w.home, prof, "headless", bin, { env: {} }), /PATH/);
  assert.deepEqual(checkCli(w.home, prof, "headless", bin, { run: fake("0.164.0", HELP.codexExec) }), { version: "0.164.0", digest: digestOf(bin), native: null, untested: false, features: HELP.codexFeatures });
  assert.deepEqual(calls, ["--version", "exec --help", "features list"]);
  calls.length = 0;
  assert.deepEqual(checkCli(w.home, prof, "headless", bin, { run: fake("0.164.0", "nothing") }), { version: "0.164.0", digest: digestOf(bin), native: null, untested: false, features: HELP.codexFeatures }, "cached for this digest and version");
  assert.deepEqual(calls, ["--version", "features list"], "the help is cached; the feature list is read every time");
  // Another version: read again; untested (not the version the tests ran against), but its help
  // still lists everything: warn and run (its gates decide separately).
  assert.deepEqual(checkCli(w.home, prof, "headless", bin, { run: fake("0.170.0", HELP.codexExec) }), { version: "0.170.0", digest: digestOf(bin), native: null, untested: true, features: HELP.codexFeatures });
  // A changed binary with the same version string is checked again.
  fs.appendFileSync(bin, "# changed\n");
  const r = checkCli(w.home, prof, "headless", bin, { run: fake("0.164.0", HELP.codexExec.replace(/-o, --output-last-message/g, "--last-message")) });
  assert.equal(r.code, "cli_flags_changed");
  assert.deepEqual(r.missing, ["-o"]);
  // The help cannot be read: refused, not assumed.
  const failing = checkCli(w.home, profileOf("codex", "workspace-write"), "tmux", bin, {
    run: (_c, a) => {
      if (a[0] === "--version") return "codex-cli 0.164.0";
      throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
    },
  });
  assert.equal(failing.code, "cli_flags_changed");
  assert.equal(fs.statSync(path.join(w.home, "agents", "cli-checks.json")).mode & 0o777, 0o600);
});

test("features check: every Codex feature the run turns off must be listed as off by `codex features list` with the same overrides; a missing row or one left on is cli_flags_changed", (t) => {
  assert.deepEqual(featuresNotOff(HELP.codexFeatures, CODEX_FEATURES_OFF), [], "0.164.0 with the run's overrides");
  // Codex ignores an unknown feature name: its row is simply missing.
  assert.deepEqual(featuresNotOff(HELP.codexFeatures, ["apps", "no_such_feature"]), ["feature no_such_feature (not in the feature list)"]);
  assert.deepEqual(featuresNotOff(HELP.codexFeatures.replace(/^(hooks\s+\S+\s+)false/m, "$1true"), CODEX_FEATURES_OFF), ["feature hooks stays on"]);
  // Fail closed: only exact rows "<name> <stage> <true|false>", each feature once.
  const unreadable = /^the feature list cannot be read/;
  assert.match(featuresNotOff(`${HELP.codexFeatures}\nhooks  stable  true\n`, ["hooks"])[0], unreadable, "a feature listed twice (the later row would say on)");
  assert.match(featuresNotOff(`${HELP.codexFeatures}\nhooks  stable  false\n`, ["hooks"])[0], /hooks listed twice/, "even when both rows say off");
  assert.match(featuresNotOff(`${HELP.codexFeatures}\nwarning: something  false\n`, ["hooks"])[0], unreadable, "a line that is not a row");
  assert.match(featuresNotOff("hooks  beta  false\n", ["hooks"])[0], unreadable, "an unknown stage");
  assert.match(featuresNotOff("hooks  stable  off\n", ["hooks"])[0], unreadable, "a value other than true/false");
  assert.match(featuresNotOff("hooks stable false extra\n", ["hooks"])[0], unreadable, "extra words");
  assert.deepEqual(featuresNotOff("\nhooks  under development  false\n\n", ["hooks"]), [], "blank lines and a two-word stage are fine");
  // Every turned-off feature is on the command line as -c features.<name>=false.
  const { plan } = buildPlan(ctxOf(profileOf("codex", "read-only"), "headless"));
  for (const f of CODEX_FEATURES_OFF) assert.ok(plan.args.includes(`features.${f}=false`), f);
  // checkCli: a renamed feature (its row gone) refuses the spawn.
  const w = agentsWorld(t);
  const bin = path.join(w.base, "codex");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const run = (_c, args) => (args[0] === "--version" ? "codex-cli 0.164.0" : args[0] === "features" ? HELP.codexFeatures.replace(/^computer_use .*\n/m, "") : HELP.codexExec);
  const r = checkCli(w.home, profileOf("codex", "read-only"), "headless", bin, { run });
  assert.equal(r.code, "cli_flags_changed");
  assert.deepEqual(r.missing, ["feature computer_use (not in the feature list)"]);
  assert.deepEqual(missingInHelp(HELP.codexExec.replace(/--ignore-rules/g, "--no-rules"), helpNeeds(profileOf("codex", "read-only"), "headless")), ["--ignore-rules"]);
});

test("help check: the real path runs the binary with the given environment (a shebang script needs PATH)", (t) => {
  const w = agentsWorld(t);
  const bin = path.join(w.base, "codex");
  const help = path.join(w.base, "help.txt");
  fs.writeFileSync(help, HELP.codexExec);
  // #!/usr/bin/env sh: like the npm shims of codex and claude, it starts only with PATH set.
  const features = path.join(FIX, "help", "codex-features-0.164.0.txt");
  fs.writeFileSync(bin, `#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; exit 0; fi\nif [ "$1 $2" = "exec --help" ]; then cat '${help}'; exit 0; fi\nif [ "$1 $2" = "features list" ]; then cat '${features}'; exit 0; fi\nexit 3\n`, { mode: 0o755 });
  assert.deepEqual(checkCli(w.home, profileOf("codex", "read-only"), "headless", bin, { env: { PATH: "/usr/bin:/bin" } }), { version: "0.164.0", digest: digestOf(bin), native: null, untested: false, features: HELP.codexFeatures });
  const r = checkCli(w.home, profileOf("codex", "read-only"), "tmux", bin, { env: { PATH: "/usr/bin:/bin" } });
  assert.equal(r.code, "cli_flags_changed", "the top-level help is not served by this fake");
});

test("native binary: Codex's npm launcher starts one platform binary, found next to it, hashed once per file state; a run checks it again before the CLI starts", (t) => {
  const w = agentsWorld(t);
  const pkg = path.join(w.base, "lib", "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  const launcher = path.join(pkg, "bin", "codex.js");
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.mkdirSync(path.join(w.base, "bin"));
  const link = path.join(w.base, "bin", "codex");
  fs.symlinkSync(launcher, link);
  assert.match(nativeBinary("codex", link).problem, /no native codex binary/);
  const vendor = path.join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin");
  fs.mkdirSync(vendor, { recursive: true });
  const native = path.join(vendor, "codex");
  fs.writeFileSync(native, "native-1", { mode: 0o755 });
  assert.deepEqual(nativeBinary("codex", link), { path: fs.realpathSync(native) });
  assert.deepEqual(nativeBinary("codex", native), { path: fs.realpathSync(native) }, "a native command is its own binary");
  assert.deepEqual(nativeBinary("claude", link), { path: fs.realpathSync(launcher) }, "other CLIs: the file itself");
  const d1 = nativeDigest(w.home, "codex", link).digest;
  assert.equal(d1, digestOf(native));
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(w.home, "agents", "cli-checks.json"), "utf8"))).some((k) => k.startsWith(`native:${fs.realpathSync(native)}:`)), "cached");
  fs.appendFileSync(native, "-changed");
  assert.equal(nativeDigest(w.home, "codex", link).digest, digestOf(native), "a changed file is hashed again");
  // The supervisor's check right before the CLI starts: the launcher and the native binary.
  const rec = { cli: "codex", cliDigest: digestOf(launcher), nativeDigest: d1 };
  assert.equal(cliProblem(rec, link, w.home)?.code, "cli_changed", "the native binary changed since the check");
  assert.equal(cliProblem({ ...rec, nativeDigest: digestOf(native) }, link, w.home), null);
  // Two platform binaries: ambiguous, no digest (the gates then refuse).
  const other = path.join(pkg, "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "codex"), "native-2", { mode: 0o755 });
  assert.match(nativeBinary("codex", link).problem, /2 native codex binaries/);
});

test("help check: the cached help belongs to one native binary, and the feature list is read fresh with an empty CODEX_HOME and folder (the run ignores config.toml)", (t) => {
  const w = agentsWorld(t);
  const pkg = path.join(w.base, "lib", "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  const launcher = path.join(pkg, "bin", "codex.js");
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  const vendor = path.join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin");
  fs.mkdirSync(vendor, { recursive: true });
  const native = path.join(vendor, "codex");
  fs.writeFileSync(native, "native-A", { mode: 0o755 });
  const userHome = path.join(w.base, "user-codex");
  fs.mkdirSync(userHome);
  fs.writeFileSync(path.join(userHome, "config.toml"), "[features]\nnew_unreviewed_capability = false\n");
  const calls = [];
  let features = HELP.codexFeatures;
  const run = (_command, args, opts = {}) => {
    if (args[0] === "--version") return "codex-cli 0.164.0\n";
    calls.push({ args: args.join(" "), opts, entries: opts.env?.CODEX_HOME && fs.existsSync(opts.env.CODEX_HOME) ? fs.readdirSync(opts.env.CODEX_HOME) : null });
    return args[0] === "features" ? features : HELP.codexExec;
  };
  const prof = profileOf("codex", "read-only");
  const env = { PATH: "/usr/bin:/bin", CODEX_HOME: userHome };
  const a = checkCli(w.home, prof, "headless", launcher, { env, run });
  assert.equal(a.native, digestOf(native));
  const probe = calls.find((c) => c.args.startsWith("features"));
  assert.notEqual(probe.opts.env.CODEX_HOME, userHome, "not the user's CODEX_HOME");
  assert.deepEqual(probe.entries, [], "an empty one");
  assert.equal(probe.opts.cwd, probe.opts.env.CODEX_HOME, "run from it, outside any project");
  assert.equal(probe.opts.env.PATH, env.PATH, "otherwise the run's environment");
  assert.equal(fs.existsSync(probe.opts.env.CODEX_HOME), false, "removed afterwards");
  // Another native binary behind the same launcher and version: its help is read again, and its
  // own feature list (a new feature on) is what the result carries.
  calls.length = 0;
  fs.writeFileSync(native, "native-B", { mode: 0o755 });
  features = `${HELP.codexFeatures}new_unreviewed_capability                under development  true\n`;
  const b = checkCli(w.home, prof, "headless", launcher, { env, run });
  assert.equal(b.native, digestOf(native));
  assert.deepEqual(calls.map((c) => c.args.split(" ")[0]), ["exec", "features"], "help and feature list read for the new native binary");
  assert.match(b.features, /new_unreviewed_capability +under development +true/);
});

test("command: the profile's absolute path is checked; otherwise the adapter's binary on PATH", (t) => {
  const w = agentsWorld(t);
  const dir = path.join(w.base, "bin");
  fs.mkdirSync(dir);
  const exe = path.join(dir, "claude");
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n", { mode: 0o644 });
  assert.deepEqual(resolveCommand({ cli: "claude" }, { pathVar: `relative:${dir}` }), { command: exe });
  assert.equal(resolveCommand({ cli: "codex" }, { pathVar: dir }).code, "cli_missing", "not executable");
  assert.equal(resolveCommand({ cli: "gemini" }, { pathVar: dir }).code, "cli_missing");
  assert.deepEqual(resolveCommand({ cli: "codex", command: exe }), { command: exe });
  assert.match(resolveCommand({ cli: "codex", command: "bin/codex" }).problem, /absolute/);
  assert.match(resolveCommand({ cli: "codex", command: path.join(dir, "nope") }).problem, /does not exist/);
  assert.match(resolveCommand({ cli: "codex", command: exe }, { uid: 4242 }).problem, /owned/);
});

test("approval view: the generated command line for each mode, in the CLI and the owner UI", async (t) => {
  const w = agentsWorld(t);
  writeProfile(w.home, profileDoc(w.work, { modes: ["headless", "tmux"] }));
  const sources = { agents: { homedir: w.homedir } };
  const shown = await decisions.show({ home: w.home, id: "agent-profile:codex-reviewer", sources });
  const lines = shown.view.commandLines;
  assert.deepEqual(Object.keys(lines), ["headless", "tmux"]);
  assert.match(lines.headless, /codex exec --ignore-user-config --ignore-rules --ephemeral --json -s read-only -c 'approval_policy="never"' -c features\.apps=false (-c features\.\w+=false )+-c 'web_search="disabled"' -c agents\.max_threads=1 -C \S+ -o '<home>\/agents\/runs\/<run>\/result' .* -c 'mcp_servers\.hoptell\.default_tools_approval_mode="approve"' - < task/);
  assert.ok(lines.headless.includes('"mcp", "--run", "<run>", "--home", "<home>"'));
  assert.match(lines.headless, / - < task {3}\(adapter gates passed on codex 0\.164\.0 \(launcher 61b0194f3bb6, native d8990e3ee7ac\); other binaries need your one-time approval \(hoptell agents trust-cli\), other arguments are refused: adapter_gate_unverified\)$/);
  assert.match(commandLines(profileOf("codex", "workspace-write")).headless, /\(refused for this profile: its arguments \(sandbox workspace-write\) were not gated: adapter_gate_unverified\)$/);
  assert.match(lines.tmux, /-a on-request/);
  assert.match(lines.tmux, /\(refused for now: mcp_isolation_unverified\)$/);
  // The CLI shows them before approving.
  const out = [];
  await agentsCommand({ args: ["profile", "approve", "codex-reviewer", "--accept-read-risk"], home: w.home, env: {}, homedir: w.homedir, out: (l) => out.push(l), fail: (m) => assert.fail(m) });
  assert.ok(out.some((l) => l.startsWith("headless: ") && l.includes("codex exec --ignore-user-config")), out.join("\n"));
  assert.ok(out.some((l) => l.startsWith("tmux: ")));
  // An invalid profile has no command lines.
  writeProfile(w.home, profileDoc(w.work, { id: "broken", sandbox: "full" }));
  const bad = profileView(w.home, "broken", { homedir: w.homedir, commandLines: () => ({ headless: "x" }) });
  assert.ok(bad.view.problems.length);
  assert.equal(bad.view.commandLines, undefined);
});

test("adapters: a profile with only checked options yields no command line outside the adapter's flags", () => {
  // commandLines works from a checked profile only; an unknown CLI throws.
  assert.throws(() => buildPlan(ctxOf({ ...profileOf("codex", "read-only"), cli: "sh" }, "headless")), /no adapter/);
  assert.throws(() => buildPlan(ctxOf({ ...profileOf("codex", "read-only"), sandbox: "full" }, "headless")), /refused/);
  assert.throws(() => buildPlan(ctxOf({ ...profileOf("codex", "read-only"), modes: ["tmux"] }, "headless")), /not in the profile/);
  assert.equal(typeof commandLines(profileOf("claude", "read-only")).headless, "string");
});
