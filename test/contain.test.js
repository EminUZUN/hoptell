// Contained Codex team members (design 10, Part C, phase C1): the pinned launch and the rows that
// decide containment, without a real CLI. No VERIFIED row ships for the mechanisms, so every
// member stays uncontained; the other rows are exercised with a test table (full evaluation).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BIN } from "../lib/config.js";
import { VERIFIED, parseFeatures } from "../lib/capabilities.js";
import { CLEARED_ENV, FEATURE_ALLOW, FORCED_PREFS_SCRIPT, MECHANISM, SERVER_RE, SET_PINS, candidateFolders, canonical, commonPins, configFacts, bindCodex, containedPlan, containmentFor, containmentLine, evaluateLaunch, executableOf, fileIdentity, recheckContainment, rowXLive, sandboxReportOf, hooksNotes, managedRecordOf, newServerName, parseForced, pinnedRegistration, readLayers, rowB, rowE, rowF, rowM1, rowM2, rowM3, rowP, rowR, rowS, rowT, rowTRecheck, rowV, rowX, tomlKeys, verifiedContainment } from "../lib/contain.js";

const FEATURES = parseFeatures(fs.readFileSync(new URL("./fixtures/help/codex-features-0.164.0.txt", import.meta.url), "utf8")).features;
const TABLE = [{ cli: "codex", mechanism: MECHANISM.B, class: "contained", min: "0.165.0", max: "0.165.0", checked: "2026-10-30", evidence: "test" }];

function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-contain-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A member's launch parts as memberCommand gives them, and a plan of set `set`. */
function planOf(set, { head = [], extra = [], servers = ["hoptell", "fs"], name = newServerName() } = {}) {
  const parts = { head, args: ["-s", "workspace-write", "-a", "never", "-m", "gpt-5", "-c", 'model_reasoning_effort="high"'], extra, placed: ["-c", 'developer_instructions="You are an implementer."', "You are the implementer for dana-lead; read your task."] };
  const registration = pinnedRegistration({ name, entry: BIN, env: { HOPTELL_HOME: "/h", HOPTELL_NAME: "dana-n1-impl-1" } });
  const plan = containedPlan({ set, parts, features: FEATURES, servers: new Set(servers), registration, codexHome: "/u/.codex", tmpdir: "/var/t/hoptell-member-x" });
  return { parts, registration, plan, servers: new Set(servers) };
}

test("row V: no VERIFIED row ships for a contained-member mechanism, so every version fails; a test table holds only in its range", () => {
  assert.ok(!VERIFIED.some((r) => Object.values(MECHANISM).includes(r.mechanism)), "C1 ships switched off");
  for (const set of ["A", "B"]) assert.match(rowV({ set, version: "0.165.0" }).why, new RegExp(`no hoptell test verified containment \\(contained-member set ${set}\\) for codex 0\\.165\\.0`));
  assert.equal(rowV({ set: "B", version: "0.165.0", verified: TABLE }).ok, true);
  assert.equal(rowV({ set: "A", version: "0.165.0", verified: TABLE }).ok, false, "by mechanism");
  assert.equal(rowV({ set: "B", version: "0.165.1", verified: TABLE }).ok, false);
  assert.equal(rowV({ set: "B", version: "0.165.0-alpha.1", verified: TABLE }).ok, false, "a pre-release is not its release");
  assert.match(rowV({ set: "B", version: null, verified: TABLE }).why, /version is unknown/);
  assert.equal(verifiedContainment("B", "0.165.0", [{ ...TABLE[0], class: "policy-limited" }]), null, "by class");
});

test("the pinned launch: the env prefix, the member's flags without -s, the common pins and the set last before the template and prompt", () => {
  const { plan, registration } = planOf("B");
  assert.deepEqual(plan.env, ["/usr/bin/env", ...CLEARED_ENV.flatMap((k) => ["-u", k]), "CODEX_HOME=/u/.codex", "TMPDIR=/var/t/hoptell-member-x"]);
  assert.deepEqual(plan.launch, [...plan.env, ...plan.argv]);
  assert.deepEqual(plan.argv.slice(0, 7), ["codex", "-a", "never", "-m", "gpt-5", "-c", 'model_reasoning_effort="high"']);
  assert.ok(!plan.argv.includes("-s"), "set B drops -s (with it Codex ignores the profile)");
  assert.deepEqual(plan.argv.slice(-3), ["-c", 'developer_instructions="You are an implementer."', "You are the implementer for dana-lead; read your task."]);
  assert.deepEqual(plan.argv.slice(-7, -3), SET_PINS.B);
  // The common part: hooks, plugins and every listed feature not on the allow-list, off.
  const pins = commonPins({ features: FEATURES, servers: new Set(["hoptell", "fs"]), registration });
  assert.deepEqual(pins.slice(0, 7), ["--no-daemon", "-a", "never", "--disable", "hooks", "--disable", "plugins"]);
  const disabled = pins.filter((a, i) => pins[i - 1] === "--disable");
  for (const k of Object.keys(FEATURES)) assert.equal(disabled.includes(k), !FEATURE_ALLOW.includes(k), k);
  assert.ok(pins.includes("mcp_servers.hoptell.enabled=false") && pins.includes("mcp_servers.fs.enabled=false"));
  // The pinned registration: a fresh name, this hoptell's node and entry, its digest, one inline table.
  assert.match(registration.name, SERVER_RE);
  assert.notEqual(newServerName(), newServerName());
  assert.deepEqual([registration.command, registration.args], [process.execPath, [fs.realpathSync(BIN), "mcp"]]);
  assert.equal(registration.entryDigest, crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(BIN))).digest("hex"));
  assert.equal(pins.at(-1), `mcp_servers.${registration.name}={command=${JSON.stringify(process.execPath)}, args=[${JSON.stringify(fs.realpathSync(BIN))}, "mcp"], env={HOPTELL_HOME="/h", HOPTELL_NAME="dana-n1-impl-1"}}`);
  assert.throws(() => pinnedRegistration({ name: "hoptell", entry: BIN, env: {} }), /not a pinned server name/);
  // Set A keeps the sandbox flag, as its own pin; a resume keeps its head and loses its duplicate.
  const setA = planOf("A", { head: ["resume", crypto.randomUUID()], extra: ["-c", 'tui.resume_cwd="current"'] });
  assert.deepEqual(setA.plan.argv.slice(1, 3), ["resume", setA.parts.head[1]]);
  assert.equal(setA.plan.argv.filter((x) => x === 'tui.resume_cwd="current"').length, 1);
  assert.deepEqual(setA.plan.argv.slice(-11, -3), SET_PINS.A);
  assert.equal(setA.plan.argv.filter((x) => x === "-s").length, 1);
});

test("row P: the pinned argv passes; any token outside the allow-list, a changed pin or a missing one fails; row E needs the env prefix", () => {
  for (const set of ["A", "B"]) {
    const x = planOf(set);
    const p = (argv) => rowP(argv, { set, registration: x.registration, servers: x.servers });
    assert.deepEqual(p(x.plan.argv), { ok: true }, set);
    const at = x.plan.argv.length - 3;
    const insert = (...extra) => [...x.plan.argv.slice(0, at), ...extra, ...x.plan.argv.slice(at)];
    // H8-style additions after the pins, and other escapes.
    for (const [extra, re] of [
      [["--add-dir", "/"], /--add-dir/],
      [["-c", "sandbox_workspace_write.network_access=true"], /sandbox_workspace_write\.network_access/],
      [["--dangerously-bypass-approvals-and-sandbox"], /--dangerously/],
      [["--enable", "hooks"], /--enable/],
      [["-s", "danger-full-access"], /-s danger-full-access/],
      [["--profile", "wide"], /--profile/],
      [["--remote", "x"], /--remote/],
      [["-c", 'features.hooks=true'], /-c features\.hooks/],
      [["-c", 'hooks.x="y"'], /-c hooks\.x/],
      [["-c", 'default_permissions="wide"'], /default_permissions/],
      [["-c", "notify=[\"sh\"]"], /-c notify/],
      [["-a", "on-request"], /-a on-request/],
      [["-c", 'mcp_servers.other={command="x"}'], /mcp_servers\.other/],
    ]) assert.match(p(insert(...extra)).why, re, `${set} ${extra.join(" ")}`);
    assert.match(p([...x.plan.argv, "more"]).why, /a token after the prompt/);
    // A pin taken out: missing.
    const drop = (i, n = 2) => [...x.plan.argv.slice(0, i), ...x.plan.argv.slice(i + n)];
    assert.match(p(drop(x.plan.argv.indexOf("--no-daemon"), 1)).why, /pinned --no-daemon is missing/);
    assert.match(p(drop(x.plan.argv.indexOf("hooks") - 1)).why, /--disable hooks is missing/);
    assert.match(p(drop(x.plan.argv.indexOf("mcp_servers.fs.enabled=false") - 1)).why, /mcp_servers\.fs\.enabled is missing/);
    assert.match(rowP(["claude", "x"], { set, registration: x.registration, servers: x.servers }).why, /not codex/);
    assert.equal(rowE(x.plan.launch, x.plan).ok, true);
    assert.match(rowE(x.plan.argv, x.plan).why, /not the pinned env prefix/);
  }
  const b = planOf("B");
  assert.match(rowP([...b.plan.argv.slice(0, 1), "-s", "workspace-write", ...b.plan.argv.slice(1)], { set: "B", registration: b.registration, servers: b.servers }).why, /-s workspace-write/, "set B takes no -s");
});

test("candidate folders and row R (set A): any rules file at any level, an unreadable folder or an odd entry fails; absent folders count as empty", (t) => {
  const root = tmp(t);
  const wt = path.join(root, "repo-wt", "dana-n1-impl-1");
  fs.mkdirSync(wt, { recursive: true });
  const codexHome = path.join(root, "home", ".codex");
  const c = candidateFolders(wt, { codexHome, etc: path.join(root, "etc-codex") });
  assert.deepEqual(c.slice(0, 4), [path.join(root, "etc-codex"), codexHome, path.join(wt, ".codex"), path.join(root, "repo-wt", ".codex")]);
  assert.equal(c.at(-1), "/.codex");
  assert.deepEqual(rowR(c), { ok: true }, "all absent");
  // An empty rules folder is fine; a file in it at any level, whatever it holds, is not.
  const rules = path.join(root, "repo-wt", ".codex", "rules");
  fs.mkdirSync(path.join(rules, "sub"), { recursive: true });
  assert.equal(rowR(c).ok, true);
  for (const body of ["prefix_rule(pattern=['git'], decision='allow')\n", "prefix_rule(\n  pattern = [\"git\",\n \"commit\"],\n  decision =\n \"allow\")\n", ""]) {
    fs.writeFileSync(path.join(rules, "sub", "x.rules"), body);
    assert.match(rowR(c).why, /the rules file .*x\.rules exists/);
  }
  fs.rmSync(path.join(rules, "sub", "x.rules"));
  fs.symlinkSync("/etc/hosts", path.join(rules, "link"));
  assert.match(rowR(c).why, /is not a plain file or folder/);
  fs.rmSync(path.join(rules, "link"));
  // An unreadable candidate folder.
  fs.chmodSync(rules, 0o000);
  t.after(() => fs.rmSync(rules, { recursive: true, force: true }));
  if (process.getuid() !== 0) assert.match(rowR(c).why, /cannot be read \(EACCES\)/);
  fs.chmodSync(rules, 0o700);
  // A rules file the owner adds after launch: the recheck runs the row again.
  fs.mkdirSync(path.join(codexHome, "rules"), { recursive: true });
  assert.equal(rowR(c).ok, true);
  fs.writeFileSync(path.join(codexHome, "rules", "default.rules"), "x");
  assert.match(rowR(c).why, /default\.rules exists/);
});

test("reading config.toml: key paths of tables, dotted keys and inline tables; anything unrecognized is a problem", () => {
  const keys = (s) => tomlKeys(s).keys?.map((k) => k.join("."));
  assert.deepEqual(keys('model = "x" # c\n[mcp_servers.fs]\ncommand = "w"\nargs = ["a", "b",\n  "c"]\nenv = { A = "1", "B C" = { d = 2 } }\n[[profiles.p.list]]\n"q.r".s = true\n'), ["model", "mcp_servers.fs", "mcp_servers.fs.command", "mcp_servers.fs.args", "mcp_servers.fs.env", "mcp_servers.fs.env.A", "mcp_servers.fs.env.B C", "mcp_servers.fs.env.B C.d", "profiles.p.list", "profiles.p.list.q.r.s"]);
  assert.deepEqual(keys("[mcp_servers]\nweb = { url = 'http://x' }\nx.command = \"y\"\n"), ["mcp_servers", "mcp_servers.web", "mcp_servers.web.url", "mcp_servers.x.command"]);
  assert.deepEqual(keys('a = """multi\nline "x" """\nb = \'\'\'lit\n\'\'\'\nc = 1979-05-27T07:32:00Z\nd = -1.5e3\n'), ["a", "b", "c", "d"]);
  for (const bad of ['a = "open\n', "a = \n", "[x\n", "a = 1 b = 2\n", "a = 1979-05-27 07:32:00\n", "= 1\n", "a = [1 2]\n", "a = {b = 1\n", "a = 'x\0'\n"]) assert.ok(tomlKeys(bad).problem, JSON.stringify(bad));
  const f = configFacts('experimental_use_unified_exec_tool = true\n[features]\ncode_mode = true\nimagegenext = true\n[profiles.w.features]\nweb_search_request = true\n[hooks]\nx = 1\n[mcp_servers."my server"]\ncommand = "x"\n[permissions.p]\nextends = "hoptell-member"\n');
  assert.deepEqual([[...f.servers], [...f.features], [...f.legacy], f.hooks, f.profileName], [["my server"], ["code_mode", "imagegenext", "web_search_request"], ["experimental_use_unified_exec_tool"], true, true]);
});

test("rows B, X, F and H read every candidate layer's config.toml; a layer that cannot be read fails them", (t) => {
  const root = tmp(t);
  const dir = path.join(root, "wt");
  fs.mkdirSync(dir);
  const home = path.join(root, ".codex");
  fs.mkdirSync(home);
  const c = candidateFolders(dir, { codexHome: home, etc: path.join(root, "etc") });
  const write = (text) => fs.writeFileSync(path.join(home, "config.toml"), text);
  const x = planOf("B", { servers: ["hoptell"] });
  const X = (layers) => rowX(layers, { argv: x.plan.argv, registration: x.registration, expected: x.registration });
  const F = (layers, features = FEATURES) => rowF(layers, { argv: x.plan.argv, features });
  write('[mcp_servers.hoptell]\ncommand = "hoptell"\n');
  let layers = readLayers(c);
  assert.deepEqual([rowB(layers), X(layers), F(layers)], [{ ok: true }, { ok: true }, { ok: true }]);
  // Row B: the profile's name in any layer (a table of it, or an extends naming it).
  write('[permissions.hoptell-member]\nfilesystem = { "/" = "write" }\n');
  assert.match(rowB(readLayers(c)).why, /names the permission profile hoptell-member/);
  write('[permissions.wide]\nextends = "hoptell-member"\n');
  assert.match(rowB(readLayers(c)).why, /hoptell-member/);
  // Escaped forms read as the decoded name: a key, a value, a literal or multi-line string, another case.
  for (const text of ['[permissions."hoptell\\u002dmember"]\nx = 1\n', '[permissions.wide]\nextends = "hoptell\\u002Dmember"\n', '[permissions."\\u0068optell-member"]\n', "[permissions.wide]\nextends = '''HOPTELL-MEMBER'''\n", '[permissions.wide]\nextends = ["x", { y = "hoptell\\u002dmember" }]\n']) {
    write(text);
    assert.match(rowB(readLayers(c)).why, /names the permission profile hoptell-member/, text);
  }
  // A multi-line basic string with an escape is not decoded: row B fails closed.
  write('[permissions.wide]\nextends = """hoptell\\\n  -member"""\n');
  assert.match(rowB(readLayers(c)).why, /a multi-line string with an escape, which hoptell does not decode/);
  // An escape TOML has and JSON lacks (\U) is a problem, not a guess.
  write('[permissions.wide]\nextends = "hoptell\\U0000002dmember"\n');
  assert.match(rowB(readLayers(c)).why, /a string hoptell cannot read/);
  // Row X: a server not disabled; a layer defining the chosen name; a registration not this hoptell's.
  write('[mcp_servers.fs]\ncommand = "w"\n');
  assert.match(X(readLayers(c)).why, /MCP server fs is not disabled/);
  write(`[mcp_servers.${x.registration.name}]\ncommand = "w"\n`);
  assert.match(X(readLayers(c)).why, /defines hoptell-member-/);
  write("");
  layers = readLayers(c);
  assert.match(rowX(layers, { argv: x.plan.argv, registration: x.registration, expected: { ...x.registration, entryDigest: "0".repeat(64) } }).why, /not the one built from this hoptell/);
  assert.match(rowX(layers, { argv: x.plan.argv, registration: { ...x.registration, env: { ...x.registration.env, X: "1" } }, expected: x.registration }).why, /not the one built/);
  // Row F: a listed feature without its --disable; an alias or legacy toggle in a layer; no list.
  const lacking = x.plan.argv.filter((a, i) => !(a === "--disable" && x.plan.argv[i + 1] === "code_mode") && !(x.plan.argv[i - 1] === "--disable" && a === "code_mode"));
  assert.match(rowF(layers, { argv: lacking, features: FEATURES }).why, /the feature code_mode is not disabled/);
  assert.match(F(layers, null).why, /feature list could not be read/);
  assert.match(F(layers, {}).why, /feature list could not be read/);
  write("[features]\ncode_mode = true\ncode_mode_only = true\n");
  assert.equal(F(readLayers(c)).ok, true, "canonical keys, all disabled in argv");
  write("[features]\nimagegenext = true\n");
  assert.match(F(readLayers(c)).why, /sets the feature key imagegenext, which is not one of this Codex's own/);
  write("[features]\nimagegenext = true\nimage_generation = false\n");
  assert.match(F(readLayers(c)).why, /imagegenext/, "the alias next to its canonical key, too");
  // A deprecated canonical key (web_search_request in 0.165.0) is its own key: it passes with its own --disable.
  write("[features]\nweb_search_request = true\n");
  const withWeb = { ...FEATURES, web_search_request: { stage: "deprecated", enabled: false } };
  const web = containedPlan({ set: "B", parts: x.parts, features: withWeb, servers: x.servers, registration: x.registration, codexHome: "/u/.codex", tmpdir: "/t" });
  assert.ok(web.argv.join(" ").includes("--disable web_search_request"));
  assert.equal(rowF(readLayers(c), { argv: web.argv, features: withWeb }).ok, true, "a deprecated canonical key with its own --disable");
  assert.match(rowF(readLayers(c), { argv: web.argv.filter((a) => a !== "web_search_request"), features: withWeb }).why, /web_search_request is not disabled/);
  write("experimental_use_unified_exec_tool = true\n");
  assert.match(F(readLayers(c)).why, /legacy feature toggle experimental_use_unified_exec_tool/);
  // Unreadable or unparsable layers fail B, X and F alike.
  write('a = "open\n');
  layers = readLayers(c);
  for (const r of [rowB(layers), X(layers), F(layers)]) assert.match(r.why, /config\.toml: an unterminated string at line 1/);
  fs.rmSync(path.join(home, "config.toml"));
  fs.mkdirSync(path.join(home, "config.toml"));
  layers = readLayers(c);
  for (const r of [rowB(layers), X(layers), F(layers)]) assert.match(r.why, /is not a plain file/);
  fs.rmSync(path.join(home, "config.toml"), { recursive: true });
  // Row H only reports.
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");
  write("[hooks]\nx = 1\n");
  assert.deepEqual(hooksNotes(readLayers(c)).length, 2);
});

test("rows M1, M2 and M3: system files, forced managed preferences, the owner's record of no cloud-managed configuration", (t) => {
  const root = tmp(t);
  const etc = path.join(root, "etc-codex");
  assert.deepEqual(rowM1({ etc }), { ok: true }, "absent");
  fs.mkdirSync(etc);
  assert.deepEqual(rowM1({ etc }), { ok: true });
  for (const n of ["config.toml", "requirements.toml", "managed_config.toml", "hooks.json", "rules"]) {
    fs.writeFileSync(path.join(etc, n), "");
    assert.match(rowM1({ etc }).why, new RegExp(`${n.replace(".", "\\.")} exists`));
    fs.rmSync(path.join(etc, n));
  }
  if (process.getuid() !== 0) {
    fs.chmodSync(etc, 0o000);
    assert.match(rowM1({ etc }).why, /cannot be read/);
    fs.chmodSync(etc, 0o700);
  }
  // M2: only {key: {forced: false}} for both keys passes.
  const out = (d) => ({ status: 0, stdout: JSON.stringify(d), error: null });
  const both = (v) => ({ config_toml_base64: { forced: v }, requirements_toml_base64: { forced: false } });
  assert.deepEqual(parseForced(out(both(false))), { ok: true });
  assert.match(parseForced(out(both(true))).why, /config_toml_base64 is forced/);
  for (const r of [out({ config_toml_base64: { forced: false } }), out({ ...both(false), extra: { forced: false } }), out({ ...both(false), config_toml_base64: { forced: "no" } }), out({ ...both(false), config_toml_base64: { forced: false, present: true } }), { status: 0, stdout: "x", error: null }]) assert.match(parseForced(r).why, /unexpected answer/);
  assert.match(parseForced({ status: 1, stdout: "", error: null }).why, /exit 1/);
  assert.match(parseForced({ status: null, stdout: "", error: "ETIMEDOUT" }).why, /ETIMEDOUT/);
  assert.match(parseForced(null).why, /no answer/);
  assert.deepEqual(rowM2({ platform: "linux", osascript: () => assert.fail("not run") }), { ok: true });
  assert.match(rowM2({ platform: "darwin", osascript: () => out(both(true)) }).why, /forced/);
  assert.match(FORCED_PREFS_SCRIPT, /CFPreferencesAppValueIsForced/);
  // M3: the owner's record.
  const home = path.join(root, "home");
  assert.match(rowM3({ home }).why, /decision CD5/);
  fs.mkdirSync(path.dirname(managedRecordOf(home)), { recursive: true });
  fs.writeFileSync(managedRecordOf(home), JSON.stringify({ version: 1, managed: "unknown" }));
  assert.match(rowM3({ home }).why, /does not say none/);
  fs.writeFileSync(managedRecordOf(home), JSON.stringify({ version: 1, managed: "none" }));
  assert.deepEqual(rowM3({ home }), { ok: true });
});

test("M2's helper on this Mac: the real osascript answers, and both keys are not forced", { skip: process.platform !== "darwin" }, () => {
  assert.deepEqual(rowM2(), { ok: true });
});

test("row T: canonical paths (absent parts kept), overlaps by components either way, every resolution error fails; the recheck catches a later symbolic link", (t) => {
  const root = tmp(t);
  const repo = path.join(root, "repo");
  const wt = path.join(root, "repo-wt", "m");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  const tmpdir = path.join(root, "t", "hoptell-member-x");
  fs.mkdirSync(tmpdir, { recursive: true });
  const guard = [repo, path.join(repo, ".git"), path.join(root, "home", ".codex"), path.join(root, "hoptell"), "/.codex", path.join(root, ".codex")];
  const T = (writable, g = guard) => rowT({ writable, protected: g }, { fold: false });
  assert.equal(T([wt, tmpdir]).ok, true, "siblings and absent folders pass");
  assert.deepEqual(canonical(path.join(root, "a", "b")), { path: path.join(root, "a", "b"), missing: { base: root, rest: ["a", "b"] } });
  assert.match(T([wt, root]).why, /writable .* overlaps the protected/, "an ancestor of a protected folder");
  assert.match(T([path.join(repo, "sub")]).why, /overlaps/, "inside the repository");
  assert.match(T([path.join(root, "home")]).why, /overlaps .*\.codex/, "CODEX_HOME nested in a writable root");
  assert.match(T([path.join(repo, ".git", "worktrees")], [path.join(repo, ".git")]).why, /overlaps/);
  assert.equal(T([path.join(root, "repo2")], [repo]).ok, true, "a name prefix is not a component");
  assert.equal(rowT({ writable: [path.join(root, "REPO", "x")], protected: [repo] }, { fold: true }).ok, false, "case-folded on case-insensitive volumes");
  // A symbolic link on the way: canonicalized through it.
  fs.symlinkSync(repo, path.join(root, "alias"));
  assert.match(T([path.join(root, "alias", "src")]).why, /overlaps/);
  // A loop, a component that is not a folder, a folder that cannot be read: failed.
  fs.symlinkSync(path.join(root, "loop2"), path.join(root, "loop1"));
  fs.symlinkSync(path.join(root, "loop1"), path.join(root, "loop2"));
  assert.match(row(() => T([path.join(root, "loop1", "x")])).why, /ELOOP/);
  fs.writeFileSync(path.join(root, "file"), "");
  assert.match(row(() => T([path.join(root, "file", "x")])).why, /ENOTDIR|not a folder/);
  if (process.getuid() !== 0) {
    fs.mkdirSync(path.join(root, "closed"));
    fs.chmodSync(path.join(root, "closed"), 0o000);
    // Opened again before the folder's cleanup, whatever order the after hooks run in (Node 24).
    try {
      assert.match(row(() => T([path.join(root, "closed", "x", "y")])).why, /EACCES/);
    } finally {
      fs.chmodSync(path.join(root, "closed"), 0o700);
    }
  }
  // Recheck: an absent protected component later created as a symbolic link.
  const input = { writable: [wt], protected: [path.join(root, "later", ".codex")] };
  const at = rowT(input, { fold: false });
  assert.equal(at.ok, true);
  assert.equal(rowTRecheck(input, at.canon, { fold: false }).ok, true);
  fs.symlinkSync(wt, path.join(root, "later"));
  assert.match(rowTRecheck(input, at.canon, { fold: false }).why, /missing at launch, is now a symbolic link/);
});

// The rows' runner: a throw is a failure.
const row = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { ok: false, why: `${e.code ?? ""} ${e.message}` };
  }
};

test("row S: no report, an unknown shape or no tested reading fails; a report wider than the pins fails", () => {
  const writable = ["/w", "/t"];
  assert.match(rowS(null, { writable }).why, /no sandbox state report/);
  assert.match(rowS({ permissionProfile: {} }, { writable }).why, /no tested reading/);
  const describe = (r) => r.d;
  assert.match(rowS({ d: null }, { writable, describe }).why, /shape hoptell does not know/);
  assert.deepEqual(rowS({ d: { writable: ["/w"], network: false, deny: ["/tmp"] } }, { writable, deny: ["/tmp"], describe }), { ok: true });
  assert.match(rowS({ d: { writable: ["/w", "/x"], network: false, deny: ["/tmp"] } }, { writable, deny: ["/tmp"], describe }).why, /can write \/x/);
  assert.match(rowS({ d: { writable: ["/w"], network: true, deny: ["/tmp"] } }, { writable, describe }).why, /allows the network/);
  assert.match(rowS({ d: { writable: ["/w"], network: false, deny: [] } }, { writable, deny: ["/tmp"], describe }).why, /does not deny \/tmp/);
});

test("the launch evaluation: in production it stops at row V (nothing else is read or run); with a test table every row is evaluated and must pass", (t) => {
  const root = tmp(t);
  const dir = path.join(root, "repo-wt", "m");
  fs.mkdirSync(dir, { recursive: true });
  const codexHome = path.join(root, "u", ".codex");
  const x = planOf("B", { servers: [] });
  const ctx = { set: "B", version: "0.165.0", argv: x.plan.argv, launch: x.plan.launch, plan: x.plan, servers: x.servers, features: FEATURES, registration: x.registration, expected: x.registration, dir, codexHome, home: path.join(root, "hoptell"), writable: [dir, path.join(root, "t")], protected: [path.join(root, "repo"), codexHome, path.join(root, "hoptell")] };
  const never = { get fsx() { return assert.fail("nothing is read"); }, osascript: () => assert.fail("nothing is run") };
  const off = evaluateLaunch(ctx, never);
  assert.deepEqual([off.contained, off.rows.map((r) => r.row)], [false, ["V"]]);
  assert.equal(containmentLine(off), "uncontained: row V: no hoptell test verified containment (contained-member set B) for codex 0.165.0");
  // Every row, with the test table: the audit (row A) and the owner's record (M3) still fail.
  const deps = { full: true, etc: path.join(root, "etc"), platform: "linux", fold: false };
  let r = evaluateLaunch({ ...ctx, verified: TABLE }, deps);
  assert.deepEqual(r.rows.filter((x) => !x.ok).map((x) => x.row), ["M3", "A"]);
  fs.mkdirSync(path.join(ctx.home, "agents"), { recursive: true });
  fs.writeFileSync(managedRecordOf(ctx.home), JSON.stringify({ version: 1, managed: "none" }));
  r = evaluateLaunch({ ...ctx, verified: TABLE }, { ...deps, audited: true });
  assert.deepEqual([r.contained, r.why], [true, null]);
  assert.equal(containmentLine({ ...r, version: "0.165.0" }), "contained (codex 0.165.0, set B)");
  // One failing row is enough; a row that throws fails.
  r = evaluateLaunch({ ...ctx, verified: TABLE, writable: [path.join(root, "repo", "x")] }, { ...deps, audited: true });
  assert.match(r.why, /^row T: /);
  r = evaluateLaunch({ ...ctx, verified: TABLE, argv: null }, { ...deps, audited: true });
  assert.match(r.why, /^row P: /);
  r = evaluateLaunch({ ...ctx, verified: TABLE }, { ...deps, audited: true, platform: "darwin", osascript: () => { throw new Error("boom"); } });
  assert.match(r.why, /^row M2: the check failed/);
});

test("a launch's containment record: set B, then A; nothing is built while row V fails; a contained record keeps what the rechecks compare with, and each recheck row fails on its own", (t) => {
  const root = tmp(t);
  const dir = path.join(root, "repo-wt", "m");
  fs.mkdirSync(dir, { recursive: true });
  const codexHome = path.join(root, "u", ".codex");
  const home = path.join(root, "hoptell");
  const x = planOf("B", { servers: [] });
  const ctx = { argv: x.plan.argv, launch: x.plan.launch, plan: x.plan, servers: x.servers, features: FEATURES, registration: x.registration, expected: x.registration, dir, codexHome, home, writable: [dir, path.join(root, "t")], protected: [path.join(root, "repo"), codexHome, home] };
  const never = () => assert.fail("nothing is built while row V fails");
  const off = containmentFor({ version: "0.165.0", build: never });
  assert.deepEqual([off.contained, off.set, off.version, off.recheck], [false, null, "0.165.0", null]);
  assert.match(off.why, /^row V: .*set B\) for codex 0\.165\.0$/);
  assert.match(containmentFor({ version: null, build: never }).why, /^row V: /);
  // A build that throws fails closed.
  assert.match(containmentFor({ version: "0.165.0", verified: TABLE, build: () => { throw new Error("no"); } }).why, /^row plan: the contained launch could not be built \(no\)$/);
  assert.equal(containmentFor({ version: "0.165.0", verified: TABLE, build: () => { throw new Error("x".repeat(2000)); } }).why.length <= 600, true, "clipped to what a session record holds");
  fs.mkdirSync(path.join(home, "agents"), { recursive: true });
  fs.writeFileSync(managedRecordOf(home), JSON.stringify({ version: 1, managed: "none" }));
  // A sandbox helper the launch records by its path and file (a stand-in for /usr/bin/sandbox-exec).
  fs.mkdirSync(path.join(root, "sbin"));
  const helper = path.join(root, "sbin", "sandbox-exec");
  fs.writeFileSync(helper, "helper");
  const deps = { full: true, audited: true, etc: path.join(root, "etc"), platform: "linux", fold: false, helpers: [{ path: helper, flag: "-p" }] };
  const c = containmentFor({ version: "0.165.0", verified: TABLE, build: () => ctx, deps });
  assert.deepEqual([c.contained, c.set, c.why], [true, "B", null]);
  assert.deepEqual(Object.keys(c.recheck).sort(), ["argv", "candidates", "codex", "deny", "etc", "helpers", "server", "set", "t", "writable"]);
  assert.equal(c.recheck.codex, null, "recorded once the member starts");
  assert.deepEqual(c.recheck.helpers.map((h) => [h.path, h.flag]), [[helper, "-p"]]);
  assert.equal(c.recheck.server.exe.path, fs.realpathSync(process.execPath));
  // Linux has no tested helper: none is recorded there by default.
  assert.deepEqual(containmentFor({ version: "0.165.0", verified: TABLE, build: () => ctx, deps: { ...deps, helpers: undefined } }).recheck.helpers, []);
  // The processes: pane 100, its codex 101 (the recorded argv), the pinned server 102 and a helper 103.
  const paneRoot = { pid: 100, start: "s" };
  const server = c.recheck.server.exe.path;
  const lines = new Map([[101, c.recheck.argv], [102, [c.recheck.server.command, ...c.recheck.server.args]], [103, [helper, "-p", "x", "sh"]]]);
  const exes = new Map([[102, server], [103, helper]]);
  let rows = [[101, { ppid: 100 }], [102, { ppid: 101 }], [103, { ppid: 101 }]];
  const alive = new Set(["100:s", "101:s1"]);
  const state = (id) => (alive.has(`${id.pid}:${id.start}`) ? "same" : "different");
  const starts = new Map([[101, "s1"], [202, "s2"]]);
  const identity = (pid) => (starts.has(pid) ? { pid, start: starts.get(pid), uid: 501, boot: "b" } : null);
  const procs = () => ({ table: new Map(rows), commandLine: (pid) => lines.get(pid) ?? null, state, identity });
  // Binding the codex process: exactly one, with a readable identity.
  const bound = bindCodex({ root: paneRoot, argv: c.recheck.argv }, procs());
  assert.deepEqual(bound, { ok: true, codex: { pid: 101, start: "s1", uid: 501, boot: "b" } });
  const describe = (r) => r;
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.writeFileSync(sandboxReportOf(home, "m"), JSON.stringify({ state: { writable: [dir], network: false, deny: ["~/.ssh", "/tmp"] } }));
  const rec = { ...c.recheck, codex: bound.codex };
  const base = { table: () => new Map(rows), commandLine: (pid) => lines.get(pid) ?? null, executable: (pid) => exes.get(pid) ?? null, state, describe, fold: false };
  assert.deepEqual(recheckContainment(home, "m", paneRoot, rec, base), { ok: true });
  assert.match(recheckContainment(home, "m", paneRoot, c.recheck, base).why, /^row P: the member's codex process was not recorded when it started/);
  assert.match(recheckContainment(home, "m", paneRoot, rec, { ...base, describe: undefined }).why, /^row S: .*no tested reading/);
  assert.match(recheckContainment(home, "m", paneRoot, rec, { ...base, state: () => "different" }).why, /^row P: the member's pane process is not the recorded one/);
  assert.match(recheckContainment(home, "m", paneRoot, rec, { ...base, table: () => null }).why, /^row P: the process table could not be read/);
  // Row P: a replacement codex (pid 202, another start) with the same argv does not pass; nor does a second one.
  lines.set(202, c.recheck.argv);
  const both = [...rows, [202, { ppid: 100 }]];
  assert.match(recheckContainment(home, "m", paneRoot, rec, { ...base, table: () => new Map(both) }).why, /^row P: 2 processes of the member run the codex command line/);
  alive.delete("101:s1");
  alive.add("202:s2");
  assert.match(recheckContainment(home, "m", paneRoot, rec, { ...base, table: () => new Map(both.filter(([p]) => p !== 101)) }).why, /^row P: the member's codex process 101 is not the recorded one/);
  alive.add("101:s1");
  assert.match(recheckContainment(home, "m", paneRoot, rec, { ...base, commandLine: (pid) => (pid === 101 ? null : (lines.get(pid) ?? null)) }).why, /^row P: the member's codex process 101 does not run the recorded command line/);
  // bindCodex fails closed: none, several, or an unreadable identity.
  assert.match(bindCodex({ root: paneRoot, argv: ["x"] }, procs()).why, /^no process of the member runs/);
  rows = both;
  assert.match(bindCodex({ root: paneRoot, argv: c.recheck.argv }, procs()).why, /^2 processes of the member run/);
  rows = rows.filter(([p]) => p !== 202);
  assert.match(bindCodex({ root: paneRoot, argv: c.recheck.argv }, { ...procs(), identity: () => null }).why, /identity of process 101 cannot be read/);
  // Row X: hostile children named like the helper at untrusted paths, a spoofed argv[0], a wrong
  // flag, a replaced helper file, an unreadable executable, and a server run by another binary.
  const hostile = path.join(dir, "sandbox-exec");
  fs.writeFileSync(hostile, "evil");
  const child = (line, exe) => ({ ...base, table: () => new Map([...rows, [104, { ppid: 101 }]]), commandLine: (pid) => (pid === 104 ? line : (lines.get(pid) ?? null)), executable: (pid) => (pid === 104 ? exe : (exes.get(pid) ?? null)) });
  assert.match(recheckContainment(home, "m", paneRoot, rec, child([hostile, "-p", "x"], hostile)).why, /^row X: process 104 \(sandbox-exec at .*\/repo-wt\/m\/sandbox-exec\) runs outside the sandbox/);
  assert.match(recheckContainment(home, "m", paneRoot, rec, child(["/worktree/codex-linux-sandbox", "--", "sh"], "/worktree/codex-linux-sandbox")).why, /^row X: process 104 \(codex-linux-sandbox/);
  assert.match(recheckContainment(home, "m", paneRoot, rec, child([helper, "-p", "x"], hostile)).why, /^row X: process 104 /, "argv[0] is not the executable");
  assert.match(recheckContainment(home, "m", paneRoot, rec, child([helper, "-f", "x"], helper)).why, /^row X: process 104 /);
  assert.match(recheckContainment(home, "m", paneRoot, rec, child([helper, "-p", "x"], null)).why, /^row X: the executable of process 104 cannot be read/);
  assert.match(recheckContainment(home, "m", paneRoot, rec, child([c.recheck.server.command, ...c.recheck.server.args], hostile)).why, /^row X: process 104 /);
  assert.deepEqual(recheckContainment(home, "m", paneRoot, rec, child([helper, "-p", "y"], helper)), { ok: true });
  fs.rmSync(helper);
  fs.writeFileSync(helper, "replaced");
  assert.match(recheckContainment(home, "m", paneRoot, rec, base).why, /^row X: process 103 /, "a replaced helper file");
  // The same inode again (as Linux hands out a freed one at once): its change time still differs.
  const same = fileIdentity(helper);
  const reused = (o) => ({ ...rec, helpers: rec.helpers.map((h) => ({ ...h, dev: same.dev, ino: same.ino, ...o })) });
  assert.match(recheckContainment(home, "m", paneRoot, reused({}), base).why, /^row X: process 103 /, "a reused inode");
  assert.match(recheckContainment(home, "m", paneRoot, reused({ size: same.size, mtimeNs: same.mtimeNs, ctimeNs: "1" }), base).why, /^row X: process 103 /, "another change time");
  fs.rmSync(helper);
  fs.writeFileSync(helper, "helper");
  // A protected folder that is now a symbolic link into the writable one.
  fs.symlinkSync(dir, path.join(root, "repo"));
  assert.match(recheckContainment(home, "m", paneRoot, rec, base).why, /^row T: /);
});

test("executableOf reads the kernel's executable, not argv[0]: Linux /proc only; macOS has no tested reader yet, so none is read and row X fails", () => {
  assert.equal(executableOf(process.pid), process.platform === "linux" ? fs.realpathSync(process.execPath) : null);
  assert.equal(executableOf(2 ** 22 + 7), null);
  assert.equal(executableOf(1, { platform: "linux", fsx: { readlinkSync: () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } } }), null);
  assert.equal(executableOf(5, { platform: "linux", fsx: { readlinkSync: (p) => (p === "/proc/5/exe" ? "/usr/bin/codex" : null) } }), "/usr/bin/codex");
  // On macOS nothing is run or read, whatever lsof would list (several text mappings, the trusted helper first).
  const never = { readlinkSync: () => assert.fail("nothing is read"), run: () => assert.fail("nothing is run") };
  assert.equal(executableOf(104, { platform: "darwin", fsx: never }), null);
  // An executable that cannot be identified fails row X, even for a child that looks like the pinned helper.
  const table = new Map([[104, { ppid: 101 }]]);
  const helpers = [{ path: "/usr/bin/sandbox-exec", dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5", flag: "-p" }];
  const r = rowXLive({ pid: 101, server: { command: "node", args: [], exe: null }, helpers }, { table, commandLine: () => ["/usr/bin/sandbox-exec", "-p", "x"], executable: (pid) => executableOf(pid, { platform: "darwin" }) });
  assert.match(r.why, /the executable of process 104 cannot be read/);
});

