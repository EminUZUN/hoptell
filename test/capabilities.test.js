// Capability discovery (design 8, topic 0): the probe contract (fake CLIs, a fake home with canary
// files), the parsers against recorded help texts and model lists, the advisory model lists with
// their provenance, launch validation and presets, the change notice. No real CLI is run here.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGY_EFFORT_HINT, NOT_OFFERED, PROBES, VERIFIED, capabilities, cliFlags, codexModels, compareVersions, diffRecords, loadPresets, parseAliases, parseOptions, parseValues, readClaudeCatalog, readCodexCache, resolveLaunch, runProbe, safeCapabilities, storedRecords, verifiedFor } from "../lib/capabilities.js";
import { agentsCommand } from "../lib/agentscli.js";
import { doctor } from "../lib/doctor.js";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const HELP = {
  codex: fs.readFileSync(path.join(FIX, "help", "codex-0.164.0.txt"), "utf8"),
  codexFeatures: fs.readFileSync(path.join(FIX, "help", "codex-features-0.164.0.txt"), "utf8"),
  claude: fs.readFileSync(path.join(FIX, "help", "claude-2.1.296.txt"), "utf8"),
  agy: fs.readFileSync(path.join(FIX, "help", "agy-1.4.8.txt"), "utf8"),
};
const BUNDLED = fs.readFileSync(path.join(FIX, "capabilities", "codex-debug-models-bundled-0.164.0.json"), "utf8");
const CANARY = "CANARY-7f3a9c";
const ORG = "0b3c6a52-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
const NOW = Date.parse("2026-10-27T20:00:00Z");

function tmp(t, name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `hcap-${name}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/**
 * A fake user home with canaries where the CLIs keep configuration, credentials, hooks and MCP
 * servers, plus the two caches hoptell reads; and a project folder with the same kinds of files.
 */
function fakeHome(t, { codexFetched = "2026-10-27T18:00:00Z", orgs = [ORG], catalogFetched = Date.parse("2026-10-27T19:00:00Z") } = {}) {
  const homedir = tmp(t, "home");
  const project = tmp(t, "project");
  for (const f of [".codex/config.toml", ".codex/auth.json", ".claude/settings.json", ".claude/.credentials.json", ".claude.json", ".gemini/antigravity-cli/settings.json", ".gemini/config/mcp_config.json", ".ssh/known_hosts"]) put(path.join(homedir, f), `${CANARY} ${f}\n`);
  for (const f of ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".agents/mcp_config.json", ".claude/settings.json", ".claude/hooks/pre.sh", ".codex/config.toml"]) put(path.join(project, f), `${CANARY} ${f}\n`);
  put(path.join(homedir, ".codex/models_cache.json"), JSON.stringify({ fetched_at: codexFetched, etag: `W/"${CANARY}-etag"`, client_version: "0.164.0", identity: `${CANARY}-identity`, models: [{ slug: "gpt-6.1-sol", visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }], base_instructions: `${CANARY} instructions` }, { slug: "gpt-reserve", visibility: "hide", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] }] }));
  for (const org of orgs) {
    put(
      path.join(homedir, ".claude/cache/model-catalog", `${org}-60331a305b89-cc.json`),
      JSON.stringify({ version: 2, fetchedAt: catalogFetched, staleAt: catalogFetched + 3600_000, catalog: { surface: "cc", config: { id: CANARY, models: [{ id: "claude-opus-5-5", name: CANARY, section: "main", runtime: { effort_levels: ["low", "medium", "high", "xhigh", "max"], default_effort: "medium", family: "opus" }, min_claude_code_version: "2.1.280" }, { id: "claude-haiku-4-5-20251001", section: "overflow", runtime: {} }], provider_alias_targets: { opus: { default: "claude-opus-5-5", per_provider: { bedrock: CANARY } } } }, state: { model: CANARY } } }),
    );
  }
  put(path.join(homedir, ".claude/cache/model-catalog/tok-abc-ccd.json"), `${CANARY}\n`);
  return { homedir, project };
}

/** Every file under `dir` with its content and modification time. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${fs.statSync(p).mtimeMs}:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}

/**
 * Fake CLIs in a bin folder: each logs its argv, working folder and environment, writes into the
 * HOME and CODEX_HOME it was given (a hostile CLI would), and prints the recorded output for a
 * probe. `version` sets --version; `broken` makes every call print nothing and fail.
 */
function fakeClis(t, { versions = { codex: "0.164.0", claude: "2.1.296", agy: "1.4.8" }, broken = [] } = {}) {
  const bin = tmp(t, "bin");
  const log = path.join(tmp(t, "log"), "calls.jsonl");
  const out = {
    codex: { "--version": `codex-cli ${versions.codex}`, "--help": HELP.codex, "features list": HELP.codexFeatures, "debug models --bundled": BUNDLED },
    claude: { "--version": `${versions.claude} (Claude Code)`, "--help": HELP.claude },
    agy: { "--version": versions.agy, "--help": HELP.agy, changelog: "1.4.8:\n· one\n\n1.4.7:\n· two\n" },
  };
  for (const cli of ["codex", "claude", "agy"]) {
    const file = path.join(bin, cli);
    const script = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cli: ${JSON.stringify(cli)}, argv: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env } }) + "\\n");
for (const d of [process.env.HOME, process.env.CODEX_HOME]) if (d) try { fs.mkdirSync(path.join(d, ".hostile"), { recursive: true }); fs.writeFileSync(path.join(d, ".hostile", "w"), "x"); } catch {}
${broken.includes(cli) ? "process.exit(1);" : ""}
const out = ${JSON.stringify(out[cli])}[process.argv.slice(2).join(" ")];
if (out === undefined) { process.stderr.write("unknown"); process.exit(2); }
${cli === "agy" ? "process.stderr.write(out);" : "process.stdout.write(out);"}
`;
    fs.writeFileSync(file, script, { mode: 0o755 });
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, calls, pathVar: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter) };
}

const optsOf = (t, f, h, extra = {}) => ({ home: tmp(t, "hoptell"), pathVar: f.pathVar, homedir: h.homedir, lang: "C", now: () => NOW, ...extra });

test("probe contract: only the fixed probes, in fresh empty folders, with PATH, LANG and temporary HOME and CODEX_HOME; the user's files stay unchanged and out of the record", (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  const before = { home: snapshot(h.homedir), project: snapshot(h.project) };
  const opts = optsOf(t, f, h);
  const records = ["codex", "claude", "agy"].map((cli) => capabilities(cli, opts).record);
  const calls = f.calls();
  assert.equal(calls.length, PROBES.codex.length + PROBES.claude.length + PROBES.agy.length, "each probe ran once");
  const allowed = new Set(Object.entries(PROBES).flatMap(([cli, ps]) => ps.map((p) => `${cli} ${p.args.join(" ")}`)));
  for (const c of calls) {
    assert.ok(allowed.has(`${c.cli} ${c.argv.join(" ")}`), `not a probe: ${c.cli} ${c.argv.join(" ")}`);
    assert.ok(!c.argv.some((a) => ["-p", "--print", "--prompt", "-i", "--prompt-interactive", "exec", "e", "resume"].includes(a)), `${c.cli}: ${c.argv.join(" ")}`);
    assert.deepEqual(Object.keys(c.env).filter((k) => !["PATH", "LANG", "HOME", "CODEX_HOME"].includes(k) && !/^__CF|^__CFBundle/.test(k)), [], `${c.cli}: only the allow-listed environment`);
    for (const k of ["HOME", "CODEX_HOME"]) {
      assert.ok(c.env[k] && c.env[k] !== h.homedir && !c.env[k].startsWith(h.homedir) && c.env[k] !== os.homedir(), `${c.cli}: ${k} is a temporary folder`);
      assert.ok(!fs.existsSync(c.env[k]), `${c.cli}: the temporary ${k} was removed`);
    }
    assert.ok(c.cwd !== h.project && !fs.existsSync(c.cwd), `${c.cli}: a fresh working folder, removed afterwards`);
    assert.equal(c.env.PATH, f.pathVar);
  }
  // Fresh folders per probe: no two probes share a HOME.
  assert.equal(new Set(calls.map((c) => c.env.HOME)).size, calls.length);
  assert.deepEqual(snapshot(h.homedir), before.home, "the user's home is unchanged");
  assert.deepEqual(snapshot(h.project), before.project, "the project is unchanged");
  const text = JSON.stringify(records) + JSON.stringify(fs.readdirSync(opts.home, { recursive: true }).map((n) => (fs.statSync(path.join(opts.home, n)).isFile() ? fs.readFileSync(path.join(opts.home, n), "utf8") : "")));
  assert.ok(!text.includes(CANARY), "no canary content (account hash, etag, org data, credentials) in the record or the store");
  assert.ok(!text.includes(ORG), "not the organisation id either");
});

test("probe contract: a failing or timed-out probe leaves the canaries unchanged and gives unknown with a warning", (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t, { broken: ["claude"] });
  const before = snapshot(h.homedir);
  const opts = optsOf(t, f, h);
  const r = capabilities("claude", opts).record;
  assert.equal(r.version, null);
  assert.equal(r.flags, null);
  assert.ok(r.warnings.some((w) => /claude --version printed nothing/.test(w)), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => /version of claude is unknown/.test(w)));
  // A timeout (the default runner kills the CLI after 15 s): the folders are removed all the same.
  const seen = [];
  const timedOut = runProbe("agy", PROBES.agy[1], path.join(f.bin, "agy"), {
    pathVar: f.pathVar,
    run: (_command, _args, { env, cwd }) => {
      seen.push(env.HOME, env.CODEX_HOME, cwd);
      return { error: Object.assign(new Error("spawnSync agy ETIMEDOUT"), { code: "ETIMEDOUT" }) };
    },
  });
  assert.match(timedOut.problem, /agy --help failed \(ETIMEDOUT\)/);
  for (const d of seen) assert.ok(!fs.existsSync(d));
  assert.deepEqual(snapshot(h.homedir), before);
  // Only an entry of the table can run.
  assert.throws(() => runProbe("agy", { id: "x", args: ["-p", "/effort"] }, path.join(f.bin, "agy")), /not a probe of agy/);
});

test("probes: the table never names a prompt, print mode or exec; agy models and Claude Code's auth status are not run", () => {
  for (const [cli, ps] of Object.entries(PROBES)) {
    for (const p of ps) {
      assert.ok(!p.args.some((a) => /^(-p|--print|--prompt|-i|--prompt-interactive|exec|e|auth)$/.test(a) || a.startsWith("/")), `${cli} ${p.args.join(" ")}`);
      if (cli !== "codex") assert.ok(!p.args.includes("models"), `${cli} ${p.args.join(" ")}: a live list needs the real login`);
    }
  }
  assert.deepEqual(PROBES.agy.map((p) => p.args.join(" ")), ["--version", "--help", "changelog"]);
  assert.deepEqual(PROBES.claude.map((p) => p.args.join(" ")), ["--version", "--help"]);
});

test("parsers: options and values from the recorded help of codex 0.164.0, Claude Code 2.1.296 and agy 1.4.8", () => {
  const codex = parseOptions(HELP.codex);
  for (const f of ["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-c", "-p", "--profile"]) assert.ok(codex.includes(f), f);
  assert.deepEqual(parseValues(HELP.codex, "--sandbox"), ["read-only", "workspace-write", "danger-full-access"]);
  assert.ok(parseValues(HELP.codex, "--ask-for-approval").includes("never"));
  const claude = parseOptions(HELP.claude);
  for (const f of ["--model", "--effort", "--permission-mode", "-n", "--name"]) assert.ok(claude.includes(f), f);
  assert.deepEqual(parseValues(HELP.claude, "--permission-mode"), ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
  assert.deepEqual(parseValues(HELP.claude, "--effort"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(parseAliases(HELP.claude), ["fable", "opus", "sonnet"]);
  const agy = parseOptions(HELP.agy);
  for (const f of ["--mode", "--sandbox", "--dangerously-skip-permissions", "--model", "--effort", "-i", "-p"]) assert.ok(agy.includes(f), f);
  assert.deepEqual(parseValues(HELP.agy, "--mode"), ["accept-edits", "auto", "plan"]);
  assert.deepEqual(parseValues(HELP.agy, "--effort"), ["low", "medium", "high", "xhigh", "max"]);
  // A description that mentions another flag does not list it as an option.
  assert.ok(!parseOptions("  --tmux    Create a tmux session (requires --worktree)\n").includes("--worktree"));
});

test("model lists: the recorded `codex debug models --bundled` shape; a changed shape is unknown, loudly", () => {
  const list = codexModels(JSON.parse(BUNDLED));
  assert.ok(list.length >= 5);
  const luna = list.find((m) => m.id === "gpt-6-luna");
  assert.deepEqual(luna.efforts, ["low", "medium", "high", "xhigh", "max"], "no ultra on luna");
  assert.ok(list.every((m) => !m.efforts.includes("minimal")), "no listed model offers minimal");
  assert.deepEqual(Object.keys(luna).sort(), ["aliases", "default_effort", "efforts", "hidden", "id"]);
  assert.equal(codexModels({ data: [] }), null, "renamed list");
  assert.equal(codexModels({ models: [{ id: "gpt-x" }] }), null, "renamed id field");
});

test("caches: Codex's models_cache.json keeps only ids, efforts and its fetch time; Claude Code's catalog only with exactly one organisation", (t) => {
  const h = fakeHome(t);
  const c = readCodexCache(path.join(h.homedir, ".codex"));
  assert.equal(c.models.fetched_at, "2026-10-27T18:00:00.000Z");
  assert.equal(c.models.account, "not verified");
  assert.deepEqual(c.models.list.map((m) => [m.id, m.hidden]), [["gpt-6.1-sol", false], ["gpt-reserve", true]]);
  assert.ok(!JSON.stringify(c).includes(CANARY));
  const k = readClaudeCatalog(h.homedir);
  assert.deepEqual(k.models.list[0], { id: "claude-opus-5-5", aliases: ["opus"], efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "medium", hidden: false, min_version: "2.1.280" });
  assert.ok(!JSON.stringify(k).includes(CANARY) && !JSON.stringify(k).includes(ORG));
  const two = fakeHome(t, { orgs: [ORG, "1b3c6a52-1d2e-4f5a-8b9c-0d1e2f3a4b5c"] });
  assert.match(readClaudeCatalog(two.homedir).problem, /holds 2 accounts; which one applies is unknown/);
  assert.ok(readClaudeCatalog(tmp(t, "empty")).missing);
});

test("launch validation: a stale cache from another account warns with its age and never refuses an interactive launch", (t) => {
  const h = fakeHome(t, { codexFetched: "2026-09-27T20:00:00Z", catalogFetched: Date.parse("2026-10-07T20:00:00Z") });
  const f = fakeClis(t);
  const opts = optsOf(t, f, h);
  const codex = capabilities("codex", opts).record;
  let r = cliFlags("codex", { model: "gpt-6.1-sol", effort: "xhigh" }, codex, { now: NOW });
  assert.ok(!r.refused);
  assert.deepEqual(r.args, ["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"']);
  assert.ok(r.warnings.some((w) => /offers efforts low, high, ultra, not xhigh, in the cached account list \(fetched 30 days ago, account not verified\)/.test(w)), r.warnings.join("\n"));
  // A model the account list lacks but the binary's own list has.
  r = cliFlags("codex", { model: "gpt-5.5", effort: "high" }, codex, { now: NOW });
  assert.ok(r.warnings.some((w) => /gpt-5.5 is not in the cached account list \(fetched 30 days ago, account not verified\), only in the list bundled with this binary/.test(w)), r.warnings.join("\n"));
  r = cliFlags("codex", { model: "gpt-9", effort: "high" }, codex, { now: NOW });
  assert.ok(!r.refused && r.warnings.some((w) => /gpt-9 is not in .*; the CLI decides/.test(w)));
  const claude = capabilities("claude", opts).record;
  r = cliFlags("claude", { model: "opus", effort: "ultra" }, claude, { now: NOW });
  assert.ok(!r.refused);
  assert.deepEqual(r.args, ["--model", "opus", "--effort", "ultra"]);
  assert.ok(r.warnings.some((w) => /claude-opus-5-5 offers efforts low, medium, high, xhigh, max, not ultra, in the cached account list \(fetched 20 days ago/.test(w)), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => /claude --help lists efforts low, medium, high, xhigh, max, not ultra/.test(w)));
  // Several accounts' catalogs: models unknown, still no refusal.
  const two = fakeHome(t, { orgs: [ORG, "1b3c6a52-1d2e-4f5a-8b9c-0d1e2f3a4b5c"] });
  const c2 = capabilities("claude", optsOf(t, f, two)).record;
  assert.ok(c2.warnings.some((w) => /holds 2 accounts/.test(w)));
  r = cliFlags("claude", { model: "opus", effort: "high" }, c2, { now: NOW });
  assert.ok(!r.refused && r.warnings.some((w) => /model opus and effort high unchecked: Claude Code's model catalog cache is unknown here/.test(w)));
  // Malformed values are refused before any lookup.
  assert.match(cliFlags("codex", { model: "gpt 6" }, codex).refused, /model name/);
  assert.match(cliFlags("codex", { effort: 'high"\nsandbox_mode="danger-full-access' }, codex).refused, /one lowercase word/);
});

test("launch validation: the default mixed team (codex, claude and agy reviewers, nothing named) resolves without a refusal; agy gets no effort", (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  const opts = optsOf(t, f, h);
  const presets = loadPresets(opts.home);
  const got = {};
  for (const cli of ["codex", "claude", "agy"]) {
    const r = resolveLaunch(cli, "reviewer", {}, { record: capabilities(cli, opts).record, presets, now: NOW });
    assert.ok(!r.refused, `${cli}: ${r.refused}`);
    got[cli] = r;
  }
  assert.deepEqual(got.codex.args, ["-s", "read-only", "-a", "never", "-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(got.claude.args, ["--permission-mode", "plan", "--effort", "high"]);
  assert.deepEqual(got.agy.args, ["--mode", "plan", "--sandbox", "--dangerously-skip-permissions"]);
  for (const cli of ["codex", "claude"]) assert.ok(got[cli].warnings.includes("effort high unchecked (model from your CLI settings)"), cli);
  assert.ok(!got.agy.args.includes("--effort") && got.agy.effort === null);
  // What the mechanisms are known to do, as warnings.
  assert.ok(got.agy.warnings.some((w) => /--mode plan on agy 1.4.8: policy-limited/.test(w)));
  assert.ok(got.agy.warnings.some((w) => /--sandbox on agy 1.4.8: does not confine writes or network access/.test(w)));
  assert.ok(got.claude.warnings.some((w) => /--permission-mode plan on claude 2.1.296: policy-limited/.test(w)));
  assert.ok(!got.codex.warnings.some((w) => /read-only/.test(w)), "contained on the tested version: no warning");
});

test("launch validation: agy takes the complete model id unchanged and never --effort; an agy effort is refused with the hint", (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  const opts = optsOf(t, f, h);
  const record = capabilities("agy", opts).record;
  const presets = loadPresets(opts.home);
  const r = resolveLaunch("agy", "reviewer", { model: "gemini-4-argon-high" }, { record, presets });
  assert.deepEqual(r.args, ["--mode", "plan", "--sandbox", "--dangerously-skip-permissions", "--model", "gemini-4-argon-high"]);
  assert.equal(r.args.filter((a) => a === "--model").length, 1);
  assert.ok(!r.args.includes("--effort"));
  assert.ok(r.warnings.some((w) => /passed to agy unchanged/.test(w)));
  assert.equal(resolveLaunch("agy", "reviewer", { effort: "high" }, { record, presets }).refused, AGY_EFFORT_HINT);
  assert.equal(resolveLaunch("agy", "reviewer", { model: "gemini-4-argon", effort: "high" }, { record, presets }).refused, AGY_EFFORT_HINT);
  assert.match(AGY_EFFORT_HINT, /give the complete model id, for example gemini-4-argon-high/);
  // An owner preset with an effort for agy: not used, with a warning.
  put(path.join(opts.home, "presets", "roles.json"), JSON.stringify({ version: 1, presets: { agy: { reviewer: { effort: "high" } } } }));
  const own = resolveLaunch("agy", "reviewer", {}, { record, presets: loadPresets(opts.home) });
  assert.ok(!own.refused && !own.args.includes("--effort"));
  assert.ok(own.warnings.some((w) => /your preset's effort high is not used: agy takes its effort in the model id/.test(w)));
  // agy implementers are not offered; an override cannot add one.
  put(path.join(opts.home, "presets", "roles.json"), JSON.stringify({ version: 1, presets: { agy: { implementer: { flags: ["--mode", "accept-edits", "--sandbox"] } } } }));
  assert.equal(resolveLaunch("agy", "implementer", {}, { record, presets: loadPresets(opts.home) }).refused, NOT_OFFERED.agy.implementer);
  assert.match(resolveLaunch("agy", "lead", {}, { record, presets }).refused, /no preset for agy lead/);
});

test("presets: request > the owner's preset > the shipped preset; a bad override entry is left out with a warning; dated warnings", (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  const opts = optsOf(t, f, h);
  const record = capabilities("codex", opts).record;
  put(path.join(opts.home, "presets", "roles.json"), JSON.stringify({ version: 1, presets: { codex: { reviewer: { effort: "xhigh", model: "gpt-6.1-sol" }, implementer: { flags: "-s workspace-write" } }, claude: { reviewer: { model: "nonesuch" } } } }));
  const presets = loadPresets(opts.home);
  assert.ok(presets.warnings.some((w) => /your preset codex implementer left out: flags must be a list/.test(w)));
  assert.deepEqual(presets.presets.codex.implementer.flags, ["-s", "workspace-write", "-a", "never"], "the shipped entry stays");
  let r = resolveLaunch("codex", "reviewer", {}, { record, presets, now: NOW });
  assert.deepEqual(r.args, ["-s", "read-only", "-a", "never", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"'], "the owner's model and effort, the shipped flags");
  r = resolveLaunch("codex", "reviewer", { model: "gpt-6-luna", effort: "low" }, { record, presets, now: NOW });
  assert.deepEqual(r.args.slice(4), ["-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"'], "the request wins");
  // A preset model the record does not list.
  const claude = capabilities("claude", opts).record;
  r = resolveLaunch("claude", "reviewer", {}, { record: claude, presets, now: NOW });
  assert.ok(r.warnings.some((w) => /your preset names model nonesuch, which the record of claude does not list/.test(w)), r.warnings.join("\n"));
  // A preset checked before the CLI's version was first seen here.
  const later = capabilities("codex", { ...opts, home: tmp(t, "later"), now: () => Date.parse("2026-12-01T00:00:00Z") }).record;
  r = resolveLaunch("codex", "reviewer", {}, { record: later, presets: loadPresets(tmp(t, "plain")) });
  assert.ok(r.warnings.some((w) => /shipped preset for codex reviewer was checked on 2026-10-27, before codex 0.164.0 was first seen here \(2026-12-01\)/.test(w)), r.warnings.join("\n"));
});

test("presets: the shipped file names no model, gives reviewers high (never agy), implementers no effort, and every role its permission flags", () => {
  const { presets, warnings } = loadPresets(fs.mkdtempSync(path.join(os.tmpdir(), "hcap-shipped-")));
  assert.deepEqual(warnings, []);
  assert.deepEqual(presets.codex.reviewer.flags, ["-s", "read-only", "-a", "never"]);
  assert.deepEqual(presets.claude.reviewer.flags, ["--permission-mode", "plan"]);
  assert.deepEqual(presets.agy.reviewer.flags, ["--mode", "plan", "--sandbox", "--dangerously-skip-permissions"]);
  assert.equal(presets.codex.reviewer.effort, "high");
  assert.equal(presets.claude.reviewer.effort, "high");
  assert.equal(presets.agy.reviewer.effort, undefined);
  assert.equal(presets.agy.implementer, undefined);
  for (const [cli, roles] of Object.entries(presets)) {
    for (const [role, e] of Object.entries(roles)) {
      assert.equal(e.model, undefined, `${cli} ${role}: no model`);
      if (role === "implementer") assert.equal(e.effort, undefined, `${cli} implementer: no effort`);
      assert.match(e.source, /^https:\/\//);
      assert.match(e.checked, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(e.flags.includes({ codex: "-s", claude: "--permission-mode", agy: "--mode" }[cli]), `${cli} ${role}: the permission flag explicitly`);
    }
  }
});

test("verified table: separate from availability, per tested version range; outside it a launch says so", (t) => {
  assert.ok(VERIFIED.every((v) => ["contained", "policy-limited", "not-confining", "applied"].includes(v.class) && v.min && v.max && v.evidence));
  assert.ok(verifiedFor("codex", "0.164.0").find((v) => v.mechanism === "-s read-only").holds);
  assert.ok(!verifiedFor("codex", "0.165.0").find((v) => v.mechanism === "-s read-only").holds);
  assert.equal(verifiedFor("agy", "1.4.8").find((v) => v.mechanism === "--sandbox").class, "not-confining");
  const h = fakeHome(t);
  const f = fakeClis(t, { versions: { codex: "0.165.0", claude: "2.1.296", agy: "1.4.8" } });
  const opts = optsOf(t, f, h);
  const r = resolveLaunch("codex", "reviewer", {}, { record: capabilities("codex", opts).record, presets: loadPresets(opts.home) });
  assert.ok(r.warnings.some((w) => /-s read-only: contained was verified on codex 0.164.0, not on 0.165.0/.test(w)), r.warnings.join("\n"));
  assert.deepEqual(r.args.slice(0, 4), ["-s", "read-only", "-a", "never"], "the safety flags stay");
});

test("change notice: a new binary changes the fingerprint; the old record is kept, the difference shown, and doctor says so without running the CLI", async (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  const opts = optsOf(t, f, h);
  const first = capabilities("agy", opts);
  assert.equal(first.changes, null);
  assert.equal(capabilities("agy", opts).changes, null, "same binary: the cached probe, no change");
  assert.equal(f.calls().length, PROBES.agy.length, "probed once");
  // agy replaced itself: another binary that says 1.4.9 and lists one more option.
  const file = path.join(f.bin, "agy");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"1.4.8"', '"1.4.9"').replace("Usage of agy:\\n", "Usage of agy:\\n  --worktree                      Run in a new worktree\\n"));
  // doctor sees a binary without a record, and does not run it. (The file credential store: no
  // keychain is consulted.)
  const doctorEnv = { PATH: f.pathVar, HOPTELL_HOME: opts.home, HOPTELL_NOTIFY: "off", HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: "test-pass-040" };
  const lines = [];
  const calls = f.calls().length;
  await doctor(doctorEnv, (l) => lines.push(l), { homedir: h.homedir });
  assert.equal(f.calls().length, calls, "doctor ran no CLI");
  assert.deepEqual(lines.filter((l) => /agent CLIs/.test(l)), ["warn  agent CLIs: agy changed since its last capability record (a new binary; was 1.4.8, recorded 2026-10-27); run: hoptell agents capabilities agy --diff"]);
  const second = capabilities("agy", opts);
  assert.deepEqual(second.changes, ["version 1.4.8 -> 1.4.9", "flags added: --worktree"]);
  const stored = storedRecords(opts.home, "agy");
  assert.equal(stored.previous.version, "1.4.8");
  assert.equal(stored.current.version, "1.4.9");
  assert.deepEqual(diffRecords(stored.previous, stored.current), second.changes);
  // A changed model list alone changes the fingerprint too (Codex's account cache).
  capabilities("codex", opts);
  const cache = path.join(h.homedir, ".codex", "models_cache.json");
  const doc = JSON.parse(fs.readFileSync(cache, "utf8"));
  doc.models.push({ slug: "gpt-7", visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] });
  fs.writeFileSync(cache, JSON.stringify(doc));
  lines.length = 0;
  await doctor(doctorEnv, (l) => lines.push(l), { homedir: h.homedir });
  assert.ok(lines.some((l) => /agent CLIs: codex changed since its last capability record \(models \(account, as cached\) added: gpt-7\)/.test(l)), lines.join("\n"));
});

test("hoptell agents flags and capabilities: the line to launch with, warnings apart; refusals end with an error", async (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  const home = tmp(t, "hoptell");
  const run = async (args) => {
    const out = [];
    const warn = [];
    let failed = null;
    try {
      await agentsCommand({ args, home, env: { PATH: f.pathVar }, homedir: h.homedir, out: (l) => out.push(l), warn: (l) => warn.push(l), fail: (m, c = 1) => { failed = { m, c }; throw new Error("fail"); }, sources: { capabilities: { now: () => NOW } } });
    } catch (e) {
      if (!failed) throw e;
    }
    return { out, warn, failed };
  };
  let r = await run(["flags", "agy", "--role", "reviewer", "--model", "gemini-4-argon-high"]);
  assert.deepEqual(r.out, ["agy --mode plan --sandbox --dangerously-skip-permissions --model gemini-4-argon-high"]);
  assert.ok(r.warn.every((w) => w.startsWith("warning: ")));
  r = await run(["flags", "codex", "--role", "reviewer"]);
  assert.deepEqual(r.out, [`codex -s read-only -a never -c 'model_reasoning_effort="high"'`]);
  assert.ok(r.warn.includes("warning: effort high unchecked (model from your CLI settings)"));
  r = await run(["flags", "agy", "--role", "reviewer", "--effort", "high"]);
  assert.equal(r.failed.m, AGY_EFFORT_HINT);
  r = await run(["flags", "agy", "--role", "implementer"]);
  assert.match(r.failed.m, /agy implementers are not offered/);
  r = await run(["flags", "codex"]);
  assert.equal(r.failed.c, 2);
  r = await run(["flags", "claude", "--role", "reviewer", "--model", "opus", "--json"]);
  const j = JSON.parse(r.out.join("\n"));
  assert.deepEqual(j.args, ["--permission-mode", "plan", "--model", "opus", "--effort", "high"]);
  assert.equal(j.preset.from, "shipped");
  r = await run(["capabilities", "agy"]);
  assert.match(r.out[0], /^agy 1\.4\.8 {2}/);
  assert.ok(r.out.some((l) => /models: unknown, not read: agy models needs your login/.test(l)));
  assert.ok(r.out.some((l) => /--sandbox: not-confining on 1\.4\.8/.test(l)));
  r = await run(["capabilities", "codex", "--diff"]);
  assert.ok(r.out.includes("  no earlier record to compare with"));
  r = await run(["capabilities", "codex", "--json"]);
  assert.equal(JSON.parse(r.out.join("\n"))[0].record.version, "0.164.0");
  r = await run(["capabilities", "gemini"]);
  assert.equal(r.failed.c, 2);
});

test("unknown or changed help: a launch keeps every safety flag of its preset and warns", (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  const opts = optsOf(t, f, h);
  // agy dropped --sandbox from its help.
  const file = path.join(f.bin, "agy");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/ {2}--sandbox {2}[^\\]*\\n/, ""));
  const presets = loadPresets(opts.home);
  let r = resolveLaunch("agy", "reviewer", {}, { record: capabilities("agy", opts).record, presets });
  assert.deepEqual(r.args, ["--mode", "plan", "--sandbox", "--dangerously-skip-permissions"]);
  assert.ok(r.warnings.includes("agy 1.4.8 --help does not list --sandbox; the launch keeps it"), r.warnings.join("\n"));
  // Help that cannot be read at all: flags unknown, the preset passes unchanged.
  const broken = fakeClis(t, { broken: ["codex"] });
  r = resolveLaunch("codex", "reviewer", {}, { record: capabilities("codex", optsOf(t, broken, h)).record, presets });
  assert.deepEqual(r.args.slice(0, 4), ["-s", "read-only", "-a", "never"]);
  assert.ok(r.warnings.some((w) => /codex's flags are unknown \(its help could not be read\); the preset's flags are passed unchanged/.test(w)), r.warnings.join("\n"));
  // A CLI that is not installed: nothing is checked, nothing refused.
  r = resolveLaunch("claude", "reviewer", {}, { record: capabilities("claude", { ...opts, pathVar: "/nonexistent" }).record, presets });
  assert.ok(!r.refused && r.warnings.includes("claude was not found on PATH; nothing was checked"));
});

test("verified table: a pre-release is a build of its own; a tested release's behaviour does not carry over to it", (t) => {
  for (const [cli, v] of [["codex", "0.164.0-alpha.1"], ["codex", "0.164.1-alpha.2"], ["agy", "1.4.8-preview.1"], ["claude", "2.1.300-beta"]]) {
    assert.ok(verifiedFor(cli, v).every((r) => !r.holds), `${cli} ${v}`);
  }
  assert.ok(verifiedFor("codex", "0.164.0").every((r) => r.holds));
  assert.ok(verifiedFor("claude", "2.1.300").every((r) => r.holds), "a release inside the range");
  assert.equal(compareVersions("0.164.0-alpha.1", "0.164.0"), -1);
  assert.equal(compareVersions("0.164.0", "0.164.0-alpha.1"), 1);
  assert.equal(compareVersions("1.4.8", "1.4.8"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  // A launch on such a build says so, and keeps its flags.
  const h = fakeHome(t);
  const f = fakeClis(t, { versions: { codex: "0.164.0-alpha.1", claude: "2.1.296", agy: "1.4.8-preview.1" } });
  const opts = optsOf(t, f, h);
  const presets = loadPresets(opts.home);
  let r = resolveLaunch("codex", "reviewer", {}, { record: capabilities("codex", opts).record, presets });
  assert.ok(r.warnings.includes("-s read-only: contained was verified on codex 0.164.0, not on 0.164.0-alpha.1"), r.warnings.join("\n"));
  r = resolveLaunch("agy", "reviewer", {}, { record: capabilities("agy", opts).record, presets });
  assert.ok(r.warnings.some((w) => /--sandbox: not-confining was verified on agy 1.4.8, not on 1.4.8-preview.1/.test(w)), r.warnings.join("\n"));
  assert.deepEqual(r.args, ["--mode", "plan", "--sandbox", "--dangerously-skip-permissions"]);
});

test("discovery failures are unknown parts with warnings, never a failed launch: no temporary folder, a cleanup error, a malformed cache", async (t) => {
  const h = fakeHome(t);
  const f = fakeClis(t);
  // No temporary folder (as with a full disk): nothing runs, and the probes say why.
  const opts = optsOf(t, f, h, { tmpdir: path.join(tmp(t, "gone"), "missing") });
  const rec = capabilities("codex", opts).record;
  assert.equal(f.calls().length, 0, "no probe ran outside an empty temporary folder");
  assert.ok(rec.warnings.some((w) => /codex --help was not run: no empty temporary folder \(ENOENT\)/.test(w)), rec.warnings.join("\n"));
  const presets = loadPresets(opts.home);
  const r = resolveLaunch("codex", "reviewer", {}, { record: rec, presets });
  assert.deepEqual(r.args, ["-s", "read-only", "-a", "never", "-c", 'model_reasoning_effort="high"']);
  assert.ok(r.warnings.some((w) => /flags are unknown/.test(w)));
  // A cleanup that fails: the probe's result stands.
  const orig = fs.rmSync;
  fs.rmSync = () => {
    throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
  };
  let out;
  try {
    out = runProbe("agy", PROBES.agy[0], path.join(f.bin, "agy"), { pathVar: f.pathVar });
  } finally {
    fs.rmSync = orig;
  }
  assert.equal(out.text, "1.4.8");
  // Claude Code's catalog with a fetch time no Date can hold: skipped, never a RangeError.
  const k = path.join(h.homedir, ".claude/cache/model-catalog", `${ORG}-60331a305b89-cc.json`);
  const doc = JSON.parse(fs.readFileSync(k, "utf8"));
  fs.writeFileSync(k, JSON.stringify({ ...doc, fetchedAt: 1e20 }));
  assert.match(readClaudeCatalog(h.homedir).problem, /unknown shape/);
  const c = capabilities("claude", optsOf(t, f, h)).record;
  assert.ok(c.warnings.some((w) => /model catalog cache has an unknown shape; models and efforts are unknown/.test(w)), c.warnings.join("\n"));
  // Anything else that throws: an unknown record with a warning, and the preset's flags unchanged.
  const thrown = safeCapabilities("codex", { ...optsOf(t, f, h), home: undefined });
  assert.equal(thrown.record.present, null);
  assert.match(thrown.record.warnings[0], /^the capabilities of codex are unknown \(/);
  assert.deepEqual(resolveLaunch("codex", "reviewer", {}, { record: thrown.record, presets }).args.slice(0, 4), ["-s", "read-only", "-a", "never"]);
  // The CLI: an unusable hoptell home still prints the launch line, with warnings.
  const file = path.join(tmp(t, "notdir"), "file");
  fs.writeFileSync(file, "");
  const lines = [];
  const warns = [];
  await agentsCommand({ args: ["flags", "claude", "--role", "reviewer"], home: path.join(file, "home"), env: { PATH: f.pathVar }, homedir: h.homedir, out: (l) => lines.push(l), warn: (l) => warns.push(l), fail: (m) => assert.fail(m), sources: { capabilities: { tmpdir: path.join(file, "tmp") } } });
  assert.deepEqual(lines, ["claude --permission-mode plan --effort high"]);
  assert.ok(warns.some((w) => /no empty temporary folder|unknown/.test(w)), warns.join("\n"));
});
