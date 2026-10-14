// The adapter gates (design 7.1): a pass in GATES is only valid with its evidence in the committed
// gate record (test/real-cli/gate-record.json), recorded with the adapter's current arguments.
// The real-CLI runs themselves are outside this suite (npm run test:real-cli).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CLIS, GATES, HEADLESS_MODES, MOCK_EVIDENCE_CLAIM, MOCK_EVIDENCE_GATES, MOCK_EVIDENCE_PROVIDER, REQUIRED_GATES, TESTED, argsShape, buildPlan, gateFor, gateRefusal, gateShape, requiredGates, shapeArgs } from "../lib/agentadapters.js";

import { WRAPPER_DIGEST, providerSlots } from "./real-cli/mock-provider.mjs";

const RECORD = JSON.parse(fs.readFileSync(new URL("./real-cli/gate-record.json", import.meta.url), "utf8"));

/**
 * The adapter's arguments for a read-only profile without cliOptions, with placeholders (a
 * hardened shape: <PROFILE_ID> and <DENY_TABLE>), in a headless mode.
 */
const canonicalArgs = (cli, mode, headlessMode = "plain") => {
  const { plan } = buildPlan({ profile: { cli, modes: [mode], sandbox: "read-only", limits: {}, ...(headlessMode !== "plain" ? { codex: { headlessMode } } : {}) }, mode, run: "r_0000000000000000", home: "<home>", cwd: "<cwd>", name: "<name>", command: "<command>", hoptell: { node: "<node>", bin: "<bin>" }, paths: { result: "<result>", env: "<env>", relays: "<relays>", mcp: "<mcp>" }, resultTo: "<result-to>", lifetimeMinutes: 30 });
  return mode === "headless" ? plan.args : plan.cli.args;
};

const familyRe = (family) => new RegExp(`^${family.replace(/\./g, "\\.")}\\.`);

/** The headless modes of a CLI and mode: Codex headless has three; every other entry is plain only. */
const modesOf = (cli, mode) => (cli === "codex" && mode === "headless" ? HEADLESS_MODES : ["plain"]);
/** A gate table entry as written (containment included, which gateFor never returns). */
const entryOf = (cli, mode, hm) => (GATES[cli][mode].modes ? GATES[cli][mode].modes[hm] : hm === "plain" ? GATES[cli][mode] : null);
/** A record entry's headless mode: its headlessMode field, plain when absent. */
const recordMode = (r) => r.headlessMode ?? "plain";

/**
 * Whether a recorded gate counts as passed (design-7.1-read-containment.md, draft 6.4): `pass`, and
 * either production evidence (no `evidence`), or mock-provider evidence for a gate the rule allows
 * in that mode, with every field exactly as the rule binds it.
 */
function gatePassed(r, k) {
  const g = r.gates[k];
  if (g?.result !== "pass") return false;
  // A pass names what was observed.
  if (typeof g.observed !== "string" || !g.observed.trim()) return false;
  const mockList = MOCK_EVIDENCE_GATES[r.cli]?.[r.mode]?.[recordMode(r)];
  // Records of a mode without the mock rule (plain): production only, as before (no provider field needed).
  if (!mockList) return g.evidence === undefined && (g.provider === undefined || g.provider === "real");
  // A mode with the rule: every gate names its provider. Mock rows need their validated evidence;
  // other rows carry none and name the production route the design gives them.
  // The five mock gates have no production route in this runner and design: mock with evidence only.
  if (mockList.includes(k)) return g.provider === "mock" && mockEvidenceProblem(r, k) === null;
  if (g.provider === "mock" || g.evidence !== undefined) return false;
  return g.provider === PRODUCTION_PROVIDER(k);
}
/** The provider a gate's production evidence names in a mode with the mock rule (draft 6.3, "Per gate"). */
const PRODUCTION_PROVIDER = (k) => (k === "preflight-contract" ? "none" : k === "cloud-stream" ? "all" : "real");
function mockEvidenceProblem(r, k) {
  const e = r.gates[k]?.evidence;
  const allowed = MOCK_EVIDENCE_GATES[r.cli]?.[r.mode]?.[recordMode(r)] ?? [];
  if (e?.kind !== "mock-provider") return "an evidence kind other than mock-provider";
  if (!allowed.includes(k)) return `${k} may not be shown with mock-provider evidence in ${recordMode(r)}`;
  if (e.executable?.wrapper !== WRAPPER_DIGEST) return "the wrapper is not the current template";
  if (e.executable?.codex?.launcher !== r.binaryDigest || e.executable?.codex?.native !== r.nativeBinaryDigest) return "the Codex the wrapper execs is not the record's binary";
  if (JSON.stringify(e.argvDelta) !== JSON.stringify(providerSlots("<port>"))) return "the argv delta is not exactly the four provider tokens";
  if (e.insertedBefore !== "-" || e.refusesOtherProviderSlots !== true) return "the insertion point or the provider-slot refusal";
  if (e.provider !== MOCK_EVIDENCE_PROVIDER) return "the provider text";
  if (e.claim !== MOCK_EVIDENCE_CLAIM) return "the claim text";
  return null;
}

test("gates: every passed binary and argument shape is a recorded run of that headless mode whose required gates all passed, with the adapter's current arguments", () => {
  for (const cli of CLIS) {
    for (const mode of ["headless", "tmux"]) {
      for (const hm of modesOf(cli, mode)) {
        const g = entryOf(cli, mode, hm);
        if (!g?.passed) continue;
        const required = requiredGates(cli, mode, hm);
        assert.ok(required, `${cli} ${mode} ${hm} has no gate mechanism and cannot pass`);
        // Records never count across modes.
        const runs = RECORD.runs.filter((r) => r.cli === cli && r.mode === mode && recordMode(r) === hm && required.every((k) => gatePassed(r, k)));
        assert.ok(g.passed.binaries.length > 0 && g.passed.shapes.length > 0);
        // Each binary: the version, the launcher's and the native binary's digests of one such run.
        for (const b of g.passed.binaries) {
          const run = runs.find((r) => r.version === b.version && r.binaryDigest === b.launcher && r.nativeBinaryDigest === b.native);
          assert.ok(run, `${cli} ${mode} ${hm}: GATES passes ${b.version} (${b.launcher.slice(0, 12)}, native ${String(b.native).slice(0, 12)}) without a recorded run of that binary and mode where ${required.join(", ")} all passed`);
          assert.ok(TESTED[cli].includes(b.version), `${cli} ${b.version} passed its gates but is not in TESTED`);
          assert.ok(familyRe(g.family).test(b.version), `${cli} ${mode}: family ${g.family} does not name ${b.version}`);
          // Each shape: the shape of the arguments that run recorded, which are the adapter's current ones.
          for (const shape of g.passed.shapes) assert.ok(runs.some((r) => r.binaryDigest === b.launcher && argsShape(cli, r.adapterArgs) === shape), `${cli} ${mode} ${hm}: shape ${shape.slice(0, 12)} was not recorded with this binary`);
        }
        assert.ok(runs.some((r) => JSON.stringify(r.adapterArgs) === JSON.stringify(canonicalArgs(cli, mode, hm))), `${cli} ${mode} ${hm}: the adapter's arguments changed since the recorded gate run; run the gates again`);
        assert.ok(g.passed.shapes.includes(argsShape(cli, canonicalArgs(cli, mode, hm))), `${cli} ${mode} ${hm}: the shipped shape is not the adapter's current read-only shape`);
      }
    }
  }
});

/**
 * The `passed` a gate entry must have, derived from the committed record (design-7.1-read-containment.md
 * draft 6.3, "The flip"): the distinct binaries of the records of that CLI, mode and headless mode
 * whose required gates all passed with the adapter's current canonical arguments, and the shape of
 * those arguments; null when there is no such record (or no gate mechanism).
 */
function derivedPass(cli, mode, hm) {
  const required = requiredGates(cli, mode, hm);
  if (!required) return null;
  const runs = RECORD.runs.filter((r) => r.cli === cli && r.mode === mode && recordMode(r) === hm && required.every((k) => gatePassed(r, k)));
  if (!runs.length) return null;
  const canonical = canonicalArgs(cli, mode, hm);
  const current = runs.filter((r) => JSON.stringify(r.adapterArgs) === JSON.stringify(canonical));
  if (!current.length) return null;
  const binaries = [...new Map(current.map((r) => [`${r.version} ${r.binaryDigest} ${r.nativeBinaryDigest}`, { version: r.version, launcher: r.binaryDigest, native: r.nativeBinaryDigest }])).values()];
  return { binaries, shapes: [argsShape(cli, canonical)] };
}
const byKey = (bs) => [...bs].map((b) => `${b.version} ${b.launcher} ${b.native}`).sort();

test("gates: every entry's pass is exactly what the committed record yields for its CLI, mode and headless mode (a pass without an all-pass record fails, and so does an all-pass record left unflipped)", () => {
  for (const cli of CLIS) {
    for (const mode of ["headless", "tmux"]) {
      for (const hm of modesOf(cli, mode)) {
        if (hm === "containment") continue; // not offered: checked below, never gated
        const g = entryOf(cli, mode, hm);
        const want = derivedPass(cli, mode, hm);
        if (want === null) {
          assert.equal(g?.passed ?? null, null, `${cli} ${mode} ${hm}: GATES passes without an all-pass record of that mode with the current arguments`);
          continue;
        }
        assert.ok(g?.passed, `${cli} ${mode} ${hm}: the record has an all-pass run with the current arguments, but GATES does not pass it`);
        assert.deepEqual(byKey(g.passed.binaries), byKey(want.binaries), `${cli} ${mode} ${hm}: binaries`);
        assert.deepEqual([...g.passed.shapes].sort(), [...want.shapes].sort(), `${cli} ${mode} ${hm}: shapes`);
      }
    }
  }
});

test("gates: mock-provider evidence (draft 6.4) counts only for the named hardening gates, with the exact wrapper, binary, argv delta, provider and claim", () => {
  const run = { cli: "codex", mode: "headless", headlessMode: "hardening", binaryDigest: "a".repeat(64), nativeBinaryDigest: "b".repeat(64), gates: {} };
  const ev = { kind: "mock-provider", executable: { wrapper: WRAPPER_DIGEST, codex: { launcher: "a".repeat(64), native: "b".repeat(64) } }, argvDelta: providerSlots("<port>"), insertedBefore: "-", refusesOtherProviderSlots: true, provider: MOCK_EVIDENCE_PROVIDER, claim: MOCK_EVIDENCE_CLAIM };
  const with_ = (k, e) => ({ ...run, gates: { [k]: { result: "pass", provider: "mock", observed: "x", evidence: e } } });
  assert.equal(gatePassed(with_("reads-denied", ev), "reads-denied"), true);
  assert.equal(gatePassed({ ...run, gates: { "mcp-isolation": { result: "pass", provider: "real", observed: "x" } } }, "mcp-isolation"), true, "production evidence");
  // Relabelling: a mock row without its evidence, a row without a provider, the wrong production route.
  assert.equal(gatePassed({ ...run, gates: { "reads-denied": { result: "pass", provider: "mock", observed: "x" } } }, "reads-denied"), false, "mock without evidence");
  assert.equal(gatePassed({ ...run, gates: { "reads-denied": { result: "pass", observed: "x" } } }, "reads-denied"), false, "no provider in a hardening record");
  assert.equal(gatePassed({ ...run, gates: { "reads-denied": { result: "pass", provider: "real", observed: "x" } } }, "reads-denied"), false, "a mock-only gate relabelled real, without evidence");
  assert.equal(gatePassed({ ...run, gates: { "reads-denied": { result: "pass", provider: "real", observed: "x", evidence: ev } } }, "reads-denied"), false, "evidence under another provider");
  assert.equal(gatePassed({ ...run, gates: { "preflight-contract": { result: "pass", provider: "real", observed: "x" } } }, "preflight-contract"), false, "preflight is provider none");
  assert.equal(gatePassed({ ...run, gates: { "preflight-contract": { result: "pass", provider: "none", observed: "x" } } }, "preflight-contract"), true);
  assert.equal(gatePassed({ ...run, gates: { "cloud-stream": { result: "pass", provider: "all", observed: "x" } } }, "cloud-stream"), true);
  assert.equal(gatePassed({ ...run, gates: { "mcp-isolation": { result: "pass", provider: "real", observed: " " } } }, "mcp-isolation"), false, "a pass without an observation");
  assert.equal(gatePassed({ ...run, headlessMode: undefined, gates: { "mcp-isolation": { result: "pass", observed: "x" } } }, "mcp-isolation"), true, "plain records: production without a provider field");
  assert.equal(gatePassed({ ...run, headlessMode: undefined, gates: { "mcp-isolation": { result: "pass", provider: "mock", observed: "x" } } }, "mcp-isolation"), false);
  assert.equal(gatePassed(with_("mcp-isolation", ev), "mcp-isolation"), false, "a standard gate on the mock");
  assert.equal(gatePassed(with_("preflight-contract", ev), "preflight-contract"), false);
  assert.equal(gatePassed({ ...with_("reads-denied", ev), headlessMode: undefined }, "reads-denied"), false, "plain allows no mock evidence");
  assert.equal(gatePassed({ ...with_("reads-denied", ev), headlessMode: "containment" }, "reads-denied"), false, "nor containment");
  for (const bad of [{ kind: "mock" }, { executable: { ...ev.executable, wrapper: "c".repeat(64) } }, { executable: { ...ev.executable, codex: { launcher: "a".repeat(64), native: "d".repeat(64) } } }, { argvDelta: [...ev.argvDelta, "-c", "x=1"] }, { argvDelta: ev.argvDelta.slice(0, 2) }, { insertedBefore: "exec" }, { refusesOtherProviderSlots: false }, { provider: "another" }, { claim: "Reads are contained." }]) {
    assert.equal(gatePassed(with_("reads-denied", { ...ev, ...bad }), "reads-denied"), false, JSON.stringify(bad));
  }
  for (const k of ["kind", "executable", "argvDelta", "insertedBefore", "refusesOtherProviderSlots", "provider", "claim"]) {
    const e = { ...ev };
    delete e[k];
    assert.equal(gatePassed(with_("reads-denied", e), "reads-denied"), false, `without ${k}`);
  }
  assert.equal(gatePassed({ ...run, gates: { "reads-denied": { result: "fail", observed: "x", evidence: ev } } }, "reads-denied"), false);
  // The rule's list is exactly the five gates, all of them hardening rows.
  assert.deepEqual(MOCK_EVIDENCE_GATES, { codex: { headless: { hardening: ["reads-denied", "reads-allowed", "hostile-project-config", "write-network-parity", "sub-agent-reads"] } } });
  for (const k of MOCK_EVIDENCE_GATES.codex.headless.hardening) assert.ok(REQUIRED_GATES.codex.headless.modes.hardening.includes(k) && !REQUIRED_GATES.codex.headless.modes.plain.includes(k));
  // Every evidence in the committed record is well formed: no record carries ignored mock evidence.
  for (const r of RECORD.runs) for (const [k, g] of Object.entries(r.gates)) if (g.evidence !== undefined) assert.equal(mockEvidenceProblem(r, k), null, `${r.cli} ${r.mode} ${recordMode(r)} ${k}`);
});

test("gates: containment is specified but not offered: no pass, gateFor never returns it, refused everywhere", () => {
  assert.equal(GATES.codex.headless.modes.containment.passed, null);
  assert.equal(gateFor("codex", "headless", "containment"), null);
  assert.equal(gateFor("codex", "headless", "containment", { codex: { headless: { modes: { containment: { passed: { binaries: [], shapes: [] } } } } } }), null, "not even a table that names it");
  assert.equal(gateRefusal("codex", "headless", null, GATES, "containment"), "adapter_gate_unverified");
  assert.ok(!RECORD.runs.some((r) => recordMode(r) === "containment"));
});

test("gates: each mode has its own state; a hardening record never gates another mode, and gating hardening leaves plain gated", () => {
  const pass = { passed: { binaries: [{ version: "0.162.1", launcher: "a".repeat(64), native: "b".repeat(64) }], shapes: ["s"] }, refusal: "adapter_gate_unverified" };
  const facts = { version: "0.162.1", digest: "a".repeat(64), native: "b".repeat(64), shape: "s" };
  const onlyHardening = { codex: { headless: { modes: { hardening: pass } } } };
  assert.equal(gateRefusal("codex", "headless", facts, onlyHardening, "hardening"), null);
  assert.equal(gateRefusal("codex", "headless", facts, onlyHardening, "plain"), "adapter_gate_unverified", "a hardening record does not gate plain");
  assert.equal(gateRefusal("codex", "headless", facts, onlyHardening, "containment"), "adapter_gate_unverified", "nor containment");
  const both = { codex: { headless: { modes: { plain: pass, hardening: pass } } } };
  assert.equal(gateRefusal("codex", "headless", facts, both, "plain"), null, "gating hardening leaves plain");
  // A table without modes (an older shape) is plain's only: hardening is ungated, not an error.
  assert.equal(gateRefusal("codex", "headless", facts, { codex: { headless: pass } }, "plain"), null);
  assert.equal(gateRefusal("codex", "headless", facts, { codex: { headless: pass } }, "hardening"), "adapter_gate_unverified");
  // The shipped table: plain and hardening gated (each by its own record), containment not.
  assert.equal(gateRefusal("codex", "headless", null, GATES, "plain"), null);
  assert.equal(gateRefusal("codex", "headless", null, GATES, "hardening"), null);
  assert.equal(gateRefusal("codex", "headless", null, GATES, "containment"), "adapter_gate_unverified");
  // Hardening's required list is plain's plus its own rows; containment's adds its precondition rows.
  const req = REQUIRED_GATES.codex.headless.modes;
  assert.ok(req.plain.every((k) => req.hardening.includes(k)) && req.hardening.every((k) => req.containment.includes(k)));
  assert.ok(["reads-denied", "write-network-parity", "cloud-stream", "preflight-contract"].every((k) => req.hardening.includes(k) && !req.plain.includes(k)));
});

test("gates: the hardened shape is the same for two installs with different deny tables and profile ids", () => {
  const p = { cli: "codex", modes: ["headless"], sandbox: "read-only", limits: {}, codex: { headlessMode: "hardening" } };
  const ctx = (deny, profileId) => ({ profile: p, mode: "headless", run: "r_0000000000000000", home: "<home>", cwd: "<cwd>", name: "<name>", command: "<command>", hoptell: { node: "<node>", bin: "<bin>" }, paths: { result: "<result>", env: "<env>", relays: "<relays>", mcp: "<mcp>" }, resultTo: "<result-to>", lifetimeMinutes: 30, deny, profileId });
  const a = buildPlan(ctx(["/Users/a/.hoptell", "/Users/a/.codex"], `hoptell_${"1".repeat(32)}`)).plan.args;
  const b = buildPlan(ctx(["/home/b/.hoptell", "/x/tok", "/home/b/.codex"], `hoptell_${"2".repeat(32)}`)).plan.args;
  assert.notDeepEqual(a, b);
  assert.equal(argsShape("codex", a), argsShape("codex", b));
  assert.equal(argsShape("codex", a), gateShape(p, "headless"));
  assert.notEqual(gateShape(p, "headless"), gateShape({ ...p, codex: undefined }, "headless"), "plain and hardening differ");
  // An id that is not hoptell_<32 hex> is not a placeholder: another shape.
  assert.notEqual(argsShape("codex", buildPlan(ctx(["/x"], "hoptell_run")).plan.args), gateShape(p, "headless"));
});

test("gates: the argument variants a profile can make differ from the gated shape only in the reviewed gate-neutral slots (model, effort); others are refused", () => {
  const ro = { cli: "codex", modes: ["headless"], sandbox: "read-only", limits: {} };
  const shape = gateShape(ro, "headless");
  assert.ok(GATES.codex.headless.modes.plain.passed.shapes.includes(shape));
  const plain = canonicalArgs("codex", "headless");
  for (const cliOptions of [{ model: "gpt-x" }, { effort: "low" }, { effort: "max" }, { model: "o9", effort: "minimal" }]) {
    assert.equal(gateShape({ ...ro, cliOptions }, "headless"), shape, JSON.stringify(cliOptions));
    // The whole difference to the gated arguments is the slots themselves.
    const { plan } = buildPlan({ profile: { ...ro, cliOptions }, mode: "headless", run: "r_0000000000000000", home: "<home>", cwd: "<cwd>", name: "<name>", command: "<command>", hoptell: { node: "<node>", bin: "<bin>" }, paths: { result: "<result>", env: "<env>", relays: "<relays>", mcp: "<mcp>" }, resultTo: "<result-to>", lifetimeMinutes: 30 });
    assert.deepEqual(shapeArgs("codex", plan.args), plain, "only the slots are left out");
    assert.equal(plan.args.length - plain.length, (cliOptions.model ? 2 : 0) + (cliOptions.effort ? 2 : 0), "and nothing else differs");
    for (const a of plan.args.filter((x) => !plain.includes(x))) assert.ok(a === "-m" || a === cliOptions.model || /^model_reasoning_effort=/.test(a), `not a neutral slot: ${a}`);
  }
  assert.notEqual(gateShape({ ...ro, sandbox: "workspace-write" }, "headless"), shape, "the sandbox is not neutral");
  assert.ok(!GATES.codex.headless.modes.plain.passed.shapes.includes(gateShape({ ...ro, sandbox: "workspace-write" }, "headless")), "workspace-write was not gated");
});

test("gates: modes without a mechanism stay refused (Codex tmux, Gemini, agy); no run claims a pass for them", () => {
  for (const cli of CLIS) {
    for (const mode of ["headless", "tmux"]) {
      if (requiredGates(cli, mode)) continue;
      assert.equal(GATES[cli][mode].passed, null, `${cli} ${mode}`);
      assert.equal(gateRefusal(cli, mode, { version: "0.0.0" }), "mcp_isolation_unverified", `${cli} ${mode}`);
      assert.ok(!RECORD.runs.some((r) => r.cli === cli && r.mode === mode && Object.values(r.gates).some((x) => x.result === "pass")), `${cli} ${mode}: a recorded pass`);
    }
  }
  // Claude Code has its gate tests, but no recorded run: refused.
  assert.equal(GATES.claude.headless.passed, null);
  assert.equal(GATES.claude.tmux.passed, null);
});

test("gates: the record is well formed: known CLIs, modes and gates, results pass/fail/inconclusive", () => {
  assert.equal(RECORD.version, 1);
  for (const r of RECORD.runs) {
    assert.ok(CLIS.includes(r.cli) && ["headless", "tmux"].includes(r.mode), JSON.stringify(r).slice(0, 80));
    assert.ok(HEADLESS_MODES.includes(recordMode(r)) && (recordMode(r) === "plain" || (r.cli === "codex" && r.mode === "headless")), `headless mode ${r.headlessMode}`);
    assert.match(r.version, /^\d+\.\d+\.\d+/);
    assert.ok(familyRe(r.family).test(r.version));
    assert.match(r.binaryDigest, /^[0-9a-f]{64}$/);
    for (const [k, v] of Object.entries(r.gates)) {
      assert.ok((requiredGates(r.cli, r.mode, recordMode(r)) ?? []).includes(k), `${r.cli} ${r.mode} ${recordMode(r)}: unknown gate ${k}`);
      assert.ok(["pass", "fail", "inconclusive"].includes(v.result));
      assert.equal(typeof v.observed, "string");
    }
  }
});
