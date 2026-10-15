// The CLI adapters of spawned agents (design 7.1, "Per-CLI mapping", "How the run's MCP server
// learns that it serves a run", "Adapter gates"). An adapter is the only source of a run's flags:
// a profile names a CLI and a few checked options, never a command line.
//
//   buildPlan(...)     the run's argument list (and, for Claude Code, the run's mcp.json)
//   commandLines(...)  the generated command line per mode, for the owner's approval view
//   checkCli(...)      the per-spawn check of the exact subcommand's help (cli_flags_changed),
//                      the version, the launcher's and the native binary's digests, cached
//   gateRefusal(...)   a spawn is refused unless the gates passed on this exact binary (launcher
//                      and native digests) with this argument shape (gateShape), per headless mode
//   gateFor(...)       the gate entry of a CLI, mode and Codex headless mode (plain, hardening;
//                      containment is specified but not offered)
//   resolveCommand(...) the profile's command, or the adapter's binary name on the given PATH
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { agentsPaths } from "./agents.js";
import { writeRecord } from "./locks.js";

export const CLIS = ["codex", "claude", "gemini", "agy"];
const BIN_NAME = { codex: "codex", claude: "claude", gemini: "gemini", agy: "agy" };

/**
 * The exact versions the adapter tests were run against (help fixtures, gates). A version not
 * listed here would start with a warning (`cliVersionUntested`); for a gated mode it cannot occur,
 * since a gated mode runs only the exact binaries of its gate record.
 */
export const TESTED = { codex: ["0.162.1"], claude: ["2.1.296"], gemini: [], agy: [] };

/**
 * The headless modes of a read-only Codex profile (design-7.1-read-containment.md, "Headless
 * modes, gate states and the profile's choice"): `plain` (today's `-s read-only`), `hardening`
 * (path-deny hardening: a per-run permission profile that denies the listed hoptell paths) and
 * `containment` (specified only; not offered: no approval option, no gate, refused everywhere).
 * A profile chooses one with `codex.headlessMode`; absent means plain.
 */
export const HEADLESS_MODES = ["plain", "hardening", "containment"];
/** The headless modes hoptell offers. Containment is not offered until its own gate has run. */
export const OFFERED_MODES = ["plain", "hardening"];
/** The headless mode of a profile: its codex.headlessMode, plain when absent. */
export const headlessModeOf = (profile) => profile?.codex?.headlessMode ?? "plain";

const CODEX_HEADLESS_GATES = ["mcp-isolation", "approval-denial", "run-marker", "tool-catalog", "real-home-catalog", "sub-agents", "teardown-stop", "teardown-exit"];
/**
 * The hardening rows (design-7.1-read-containment.md, "Gates" and H1): the denied reads, the
 * allowed workspace control and read_task, the ignored hostile project config, write and network
 * denial identical to plain's in the same run, the preflight contract, the cloud stream's two
 * "(none)" lines, and the sub-agent's reads.
 */
export const HARDENING_GATES = ["reads-denied", "reads-allowed", "hostile-project-config", "write-network-parity", "preflight-contract", "cloud-stream", "sub-agent-reads"];

/**
 * The gates that a record may show with mock-provider evidence (design-7.1-read-containment.md,
 * draft 6.4, "The narrower rule for mock-provider rows"), per CLI, mode and headless mode: Codex runs
 * the exact hardened argument list behind a test wrapper that adds only two -c model-provider slots
 * (a scripted model on 127.0.0.1). Such a row counts only with its `evidence` (the wrapper template
 * digest, the Codex digests, the exact argv delta and MOCK_EVIDENCE_CLAIM); every other gate needs
 * the production command. Nothing at run time reads this: it is the rule the default suite applies
 * to test/real-cli/gate-record.json.
 */
export const MOCK_EVIDENCE_GATES = { codex: { headless: { hardening: ["reads-denied", "reads-allowed", "hostile-project-config", "write-network-parity", "sub-agent-reads"] } } };
/** The weaker claim a mock-provider row makes (draft 6.4, codex-pc1's text), recorded verbatim with its evidence. */
export const MOCK_EVIDENCE_CLAIM = "The Codex launcher and native binary exercised the production permission-profile slots and other buildPlan arguments, plus the recorded four-token local-provider delta, while a scripted provider called commands and tools. The test observed the gate-specific results; it did not exercise the production provider or real-home cloud policy.";
/** The provider a mock-provider row names (draft 6.4), recorded verbatim with its evidence. */
export const MOCK_EVIDENCE_PROVIDER = "a local scripted mock of the Responses API on 127.0.0.1; empty CODEX_HOME; no sign-in";

/**
 * The runtime gates each adapter and mode must pass on a version family (design 7.1, "Adapter
 * gates"). `null`: no mechanism exists yet (no per-run server definition, or for Codex in tmux
 * the shared app-server daemon), so no run can pass it and the mode stays refused. Codex headless
 * has one list per headless mode; records never count across modes.
 */
export const REQUIRED_GATES = {
  codex: {
    headless: {
      modes: {
        plain: CODEX_HEADLESS_GATES,
        hardening: [...CODEX_HEADLESS_GATES, ...HARDENING_GATES],
        containment: [...CODEX_HEADLESS_GATES, ...HARDENING_GATES, "auth-route", "config-toml-negative", "cloud-kill"],
      },
    },
    tmux: null,
  },
  claude: { headless: ["mcp-isolation", "task-on-stdin", "run-marker"], tmux: ["mcp-isolation", "task-through-read-task", "run-marker"] },
  gemini: { headless: null, tmux: null },
  agy: { headless: null, tmux: null },
};

/** The required gates of a CLI, mode and headless mode (a gate record entry without `mode` is plain). */
export function requiredGates(cli, mode, headlessMode = "plain") {
  const r = REQUIRED_GATES[cli]?.[mode];
  if (r && !Array.isArray(r)) return r.modes?.[headlessMode] ?? null;
  return headlessMode === "plain" ? (r ?? null) : null;
}

/**
 * The adapter gates per CLI and mode. `passed` is null (refused with `refusal` on every binary),
 * or the exact binaries and argument shapes on which every gate of REQUIRED_GATES passed in one
 * recorded run: {binaries: [{version, launcher, native}], shapes: [gateShape digests]}; `family`
 * names their version family (shown in the approval view). A spawn runs only when the CLI's
 * version, launcher digest and native binary digest are one recorded binary and the profile's
 * argument shape is a recorded shape; anything else is refused with `refusal` until the gates
 * are run again. A pass is set here, in reviewed code, and only together with its evidence in the
 * committed gate record (test/real-cli/gate-record.json): the default test suite checks that each
 * binary and shape is a recorded run whose gates all passed, so neither a run nor a same-user
 * agent can turn a gate on, and an adapter change voids the pass.
 */
export const GATES = {
  codex: {
    headless: {
      modes: {
        // plain: all gates passed on 0.162.1 in one run (gate-record.json, 2026-10-13), with the
        // read-only argument shape (model and effort are the only slots left out of the shape).
        plain: {
          passed: {
            binaries: [{ version: "0.162.1", launcher: "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70", native: "74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0" }],
            shapes: ["ea0d1b24e40c136f963bc0b1bc47ccaf102e93fe9337a0c54c3a6b17290245c1"],
          },
          family: "0.162",
          refusal: "adapter_gate_unverified",
        },
        // hardening: all 15 gates passed on 0.162.1 in one run (gate-record.json, 2026-10-14), with
        // the hardened read-only shape (<PROFILE_ID> and <DENY_TABLE> as placeholders); the five
        // read rows on the local scripted provider under the mock-evidence rule (draft 6.4).
        hardening: {
          passed: {
            binaries: [{ version: "0.162.1", launcher: "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70", native: "74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0" }],
            shapes: ["6c43ba527f3c470082a85d19f46a7d6e6fe47c9e78c80943225f340024b82b00"],
          },
          family: "0.162",
          refusal: "adapter_gate_unverified",
        },
        // containment: specified, not offered (gateFor never returns it).
        containment: { passed: null, refusal: "adapter_gate_unverified" },
      },
    },
    tmux: { passed: null, refusal: "mcp_isolation_unverified" },
  },
  claude: { headless: { passed: null, refusal: "adapter_gate_unverified" }, tmux: { passed: null, refusal: "adapter_gate_unverified" } },
  gemini: { headless: { passed: null, refusal: "mcp_isolation_unverified" }, tmux: { passed: null, refusal: "mcp_isolation_unverified" } },
  agy: { headless: { passed: null, refusal: "mcp_isolation_unverified" }, tmux: { passed: null, refusal: "mcp_isolation_unverified" } },
};

/**
 * The refusal for a CLI and mode, or null. `facts` ({version, digest, native, shape}: the checked
 * CLI's version, launcher digest, native binary digest, and gateShape of the profile) must be one
 * recorded binary and one recorded shape of a passed mode. Without facts (the approval view):
 * whether the mode is refused on every binary.
 */
export function gateRefusal(cli, mode, facts = null, gates = GATES, headlessMode = "plain") {
  const g = gateFor(cli, mode, headlessMode, gates);
  if (!g) return "adapter_gate_unverified";
  if (!g.passed) return g.refusal;
  if (facts === null) return null;
  const f = facts ?? {};
  const binary = (g.passed.binaries ?? []).some((b) => typeof f.digest === "string" && b.version === f.version && b.launcher === f.digest && b.native === f.native);
  const shape = typeof f.shape === "string" && (g.passed.shapes ?? []).includes(f.shape);
  return binary && shape ? null : g.refusal;
}

/**
 * The gate entry of a CLI, mode and headless mode, or null (ungated: not an error, and no effect
 * on the other modes). A table entry without `modes` is the plain mode's. Containment is never
 * returned: it is not offered, so no code path consults its entry.
 */
export function gateFor(cli, mode, headlessMode = "plain", gates = GATES) {
  if (!OFFERED_MODES.includes(headlessMode)) return null;
  const g = gates?.[cli]?.[mode];
  if (!g) return null;
  if (g.modes) return g.modes[headlessMode] ?? null;
  return headlessMode === "plain" ? g : null;
}

/** Whether a CLI, mode and Codex headless mode has a recorded passing gate (an entry is not enough). */
export const modeGated = (cli, mode, headlessMode = "plain", gates = GATES) => Boolean(gateFor(cli, mode, headlessMode, gates)?.passed);

// The argument slots that do not change what a gate tests: the model and the reasoning effort.
const NEUTRAL = {
  codex: (args, i) => (args[i] === "-m" ? 2 : args[i] === "-c" && /^model_reasoning_effort=/.test(args[i + 1] ?? "") ? 2 : 0),
  claude: (args, i) => (args[i] === "--model" || args[i] === "--effort" ? 2 : 0),
};

/** The per-run profile id of a hardened Codex run: hoptell_<32 lowercase hex>. */
export const PROFILE_ID_RE = /^hoptell_[0-9a-f]{32}$/;
export const newProfileId = () => `hoptell_${crypto.randomBytes(16).toString("hex")}`;
const ID_OR_PLACEHOLDER = "(?:hoptell_[0-9a-f]{32}|<PROFILE_ID>)";
/**
 * The per-install values of a hardened Codex shape, as fixed placeholders: the profile id and the
 * deny table (checked structurally before every start instead, checkHardenedArgs).
 */
const PLACEHOLDER = {
  codex: (a) =>
    a
      .replace(new RegExp(`^default_permissions="${ID_OR_PLACEHOLDER}"$`), 'default_permissions="<PROFILE_ID>"')
      .replace(new RegExp(`^permissions\\.${ID_OR_PLACEHOLDER}\\.extends=`), "permissions.<PROFILE_ID>.extends=")
      .replace(new RegExp(`^permissions\\.${ID_OR_PLACEHOLDER}\\.filesystem=[\\s\\S]*$`), "permissions.<PROFILE_ID>.filesystem=<DENY_TABLE>"),
};

/** The argument list without its gate-neutral slots (model, effort), per-install values as placeholders. */
export function shapeArgs(cli, args) {
  const out = [];
  for (let i = 0; i < args.length; ) {
    const n = NEUTRAL[cli]?.(args, i) ?? 0;
    if (n) i += n;
    else {
      out.push(i > 0 && args[i - 1] === "-c" && PLACEHOLDER[cli] ? PLACEHOLDER[cli](String(args[i])) : args[i]);
      i++;
    }
  }
  return out;
}

/** The SHA-256 of an argument list's shape (shapeArgs). */
export const argsShape = (cli, args) => crypto.createHash("sha256").update(JSON.stringify(shapeArgs(cli, args))).digest("hex");

/**
 * The gate shape of a stored headless plan, without rebuilding it: the run's own values in its
 * arguments (the cwd, the run's files, the home, the run id, the hoptell node and bin of its server
 * definition) are put back as gateShape's placeholders, then argsShape. A genuine plan's shape is
 * its profile's gateShape; any other flag or value gives another shape. null when the plan cannot
 * be read (a refusal).
 */
export function storedShape(cli, plan, { home, run, cwd }) {
  const args = plan?.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string") || typeof home !== "string" || typeof run !== "string" || typeof cwd !== "string") return null;
  let node = null;
  let bin = null;
  try {
    const c = args.find((a) => a.startsWith("mcp_servers.hoptell.command="));
    const a = args.find((x) => x.startsWith("mcp_servers.hoptell.args="));
    node = c ? JSON.parse(c.slice("mcp_servers.hoptell.command=".length)) : null;
    bin = a ? JSON.parse(a.slice("mcp_servers.hoptell.args=".length))[0] : null;
  } catch {
    return null;
  }
  const dir = path.join(home, "agents", "runs", run);
  // Longest first, so a value inside another (the home inside a run file) is never cut.
  const pairs = [
    [path.join(dir, "result"), "<result>"],
    [path.join(dir, "env"), "<env>"],
    [path.join(dir, "relays.json"), "<relays>"],
    [path.join(dir, "mcp.json"), "<mcp>"],
    ...(node ? [[node, "<node>"]] : []),
    ...(bin ? [[bin, "<bin>"]] : []),
    [home, "<home>"],
    [run, "r_0000000000000000"],
    [cwd, "<cwd>"],
  ];
  const out = args.map((a, i) => {
    const bare = pairs.find(([v]) => a === v);
    if (bare && i > 0 && ["-C", "-o"].includes(args[i - 1])) return bare[1];
    if (i > 0 && args[i - 1] === "-c") {
      let v = a;
      for (const [from, to] of pairs) v = v.replaceAll(toml(from), toml(to));
      return v;
    }
    return a;
  });
  return argsShape(cli, out);
}

/**
 * The argument shape of a profile in a mode: the adapter's arguments with the run's values as
 * fixed placeholders, without the gate-neutral slots. Everything else the profile changes (the
 * sandbox, a budget, tool lists) changes the shape, and such a shape needs its own gate run.
 */
export function gateShape(profile, mode) {
  // A mode that is not offered has no shape (and no plan).
  if (mode === "headless" && profile.cli === "codex" && !OFFERED_MODES.includes(headlessModeOf(profile))) return null;
  // A hardened shape takes its placeholders (<PROFILE_ID>, <DENY_TABLE>): buildPlan's default.
  const { plan } = buildPlan({ profile: { ...profile, modes: [mode] }, mode, run: "r_0000000000000000", home: "<home>", cwd: "<cwd>", name: "<name>", command: "<command>", hoptell: { node: "<node>", bin: "<bin>" }, paths: { result: "<result>", env: "<env>", relays: "<relays>", mcp: "<mcp>" }, resultTo: "<result-to>", lifetimeMinutes: 30 });
  return argsShape(profile.cli, mode === "headless" ? plan.args : plan.cli.args);
}

/** Flags and values no adapter ever generates (design: "refused in v1"; no extra directories). */
export const REFUSED = {
  all: ["--add-dir", "--include-directories"],
  // sandbox_mode as a -c key would switch a permission profile off (read containment design, rule 1).
  codex: ["danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "--approve-for-me", "sandbox_mode"],
  claude: ["bypassPermissions", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
  gemini: ["--yolo", "yolo"],
  agy: ["--dangerously-skip-permissions"],
};

/** The fixed initial prompt of a tmux run: never the task. */
export const initialPrompt = (resultTo) => `Call the hoptell read_task tool for your task. When you are done, send the result to ${resultTo} with send_message.`;

/** The run-only hoptell MCP server definition: the run in its arguments and its environment. */
export function hoptellServer({ node, bin, run, home, paths }) {
  return {
    command: node,
    args: [bin, "mcp", "--run", run, "--home", home],
    env: { HOPTELL_RUN: run, HOPTELL_HOME: home, HOPTELL_ENV: paths.env, HOPTELL_RELAYS: paths.relays },
  };
}

// TOML basic strings take JSON's escapes; an array of strings in JSON is a TOML array.
const toml = (s) => JSON.stringify(String(s));
const codexServer = (srv) => [
  "-c",
  `mcp_servers.hoptell.command=${toml(srv.command)}`,
  "-c",
  `mcp_servers.hoptell.args=[${srv.args.map(toml).join(", ")}]`,
  "-c",
  `mcp_servers.hoptell.env={${Object.entries(srv.env).map(([k, v]) => `${k}=${toml(v)}`).join(", ")}}`,
];
/**
 * Codex features a headless run turns off (`-c features.<name>=false`): each is on by default in
 * 0.162.1 and brings tools or code from outside the profile (the account's app connectors,
 * plugins, hooks, browser and computer use, sub-agents, image generation, goals). An unknown name
 * is ignored by Codex, so the per-spawn check reads `codex features list` with the same overrides
 * (checkCli). Web search is a setting, not a feature (`-c web_search="disabled"`); the feature list
 * cannot show it, so the adapter gate checks the tool catalog instead. Codex sub-agents
 * (`collaboration.*`) cannot be turned off in 0.162.1; `agents.max_threads=1` allows at most one
 * at a time and refuses a nested one ("agent thread limit reached"; `agents.max_depth` is ignored
 * by these sub-agents), which the sub-agent gate checks.
 */
export const CODEX_FEATURES_OFF = ["apps", "plugins", "hooks", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "multi_agent", "image_generation", "goals"];
const codexFeaturesOff = () => CODEX_FEATURES_OFF.flatMap((f) => ["-c", `features.${f}=false`]);

// Codex has no "max", Claude Code no "minimal": the nearest level.
const CODEX_EFFORT = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };
const CLAUDE_EFFORT = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/**
 * The plan of a run, as the supervisor runs it. Headless: {command, args, stdin: "task", result};
 * tmux: {cli: {command, args}} (the pane starts it through `hoptell agents exec`). `files.mcp` is
 * the run's mcp.json for Claude Code. `ctx`: {profile, mode, run, home, cwd, name, command,
 * hoptell: {node, bin}, paths, resultTo, lifetimeMinutes}; for a hardened Codex profile also
 * {profileId, deny} (the per-run id and the resolved deny table; placeholders when absent).
 * A Codex headless plan records its headless mode (`plan.mode`) and, when hardened, its profile id
 * and deny table: the plan is bound to them at confirmation and start, and never rebuilt there.
 */
export function buildPlan(ctx) {
  const { profile, mode } = ctx;
  if (!CLIS.includes(profile.cli)) throw new Error(`no adapter for "${profile.cli}"`);
  if (!profile.modes.includes(mode)) throw new Error(`mode ${mode} is not in the profile`);
  if (!["read-only", "workspace-write"].includes(profile.sandbox)) throw new Error(`sandbox ${profile.sandbox} is refused`);
  const out = ADAPT[profile.cli](ctx);
  const plan = mode === "headless" ? { command: ctx.command, args: out.args, stdin: "task", result: out.result, ...(out.binding ?? {}) } : { cli: { command: ctx.command, args: out.args } };
  return { plan, files: out.files ?? {} };
}

/** A deny table as one TOML inline table: every value "deny" (keys are TOML basic strings). */
export const denyTableToml = (deny) => `{${deny.map((p) => `${toml(p)}="deny"`).join(", ")}}`;

/**
 * Parse a deny table exactly in the grammar denyTableToml writes: `{}` or `{"<key>"="deny", ...}`
 * with JSON-escaped keys. The paths, or null for anything else (another value, another spacing, a
 * duplicate key): it fails closed.
 */
export function parseDenyTable(text) {
  const s = String(text);
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  const out = [];
  let i = 1;
  while (i < s.length - 1) {
    if (out.length) {
      if (s.slice(i, i + 2) !== ", ") return null;
      i += 2;
    }
    if (s[i] !== '"') return null;
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) return null;
    let key;
    try {
      key = JSON.parse(s.slice(i, j + 1));
    } catch {
      return null;
    }
    if (typeof key !== "string" || s.slice(j + 1, j + 8) !== '="deny"') return null;
    out.push(key);
    i = j + 8;
  }
  if (i !== s.length - 1 || new Set(out).size !== out.length) return null;
  return out;
}

// The base a hardened profile extends: the built-in profile of the sandbox (names starting with
// ":" cannot be redefined by any configuration layer).
const EXTENDS = { "read-only": ":read-only", "workspace-write": ":workspace" };

/**
 * The structural check of a hardened Codex argument list against the plan's own binding and the
 * deny table resolved now (design "Gate shape" and H1): no -s/--sandbox and no sandbox_mode; one
 * slot each of default_permissions, extends and filesystem, all with the plan's profile id
 * (^hoptell_[0-9a-f]{32}$); extends the sandbox's built-in; the table parses, every value "deny",
 * and its entries are exactly `expected`. null, or the problem (paths only).
 */
export function checkHardenedArgs(plan, expected, sandbox = "read-only") {
  const args = plan?.args ?? [];
  const id = plan?.profileId;
  if (typeof id !== "string" || !PROFILE_ID_RE.test(id)) return "the plan has no valid profile id";
  if (args.includes("-s") || args.includes("--sandbox")) return "the plan passes -s/--sandbox";
  const values = args.filter((a, i) => i > 0 && args[i - 1] === "-c").map(String);
  if (values.some((v) => /^\s*sandbox_mode\s*=/.test(v))) return "the plan sets sandbox_mode";
  if (!values.includes("agents.enabled=false") || !values.includes("features.multi_agent_v2=false") || values.some((v) => /^\s*(agents\.enabled|features\.multi_agent_v2)\s*=/.test(v) && !["agents.enabled=false", "features.multi_agent_v2=false"].includes(v))) return "the plan does not keep Codex sub-agents off";
  const perm = values.filter((v) => /^\s*(default_permissions|permissions\.)/.test(v));
  const want = [`default_permissions=${toml(id)}`, `permissions.${id}.extends=${toml(EXTENDS[sandbox])}`];
  if (perm.length !== 3 || perm[0] !== want[0] || perm[1] !== want[1] || !perm[2].startsWith(`permissions.${id}.filesystem=`)) return "the plan's permission slots are not the recorded ones";
  const table = parseDenyTable(perm[2].slice(`permissions.${id}.filesystem=`.length));
  if (!table) return "the plan's deny table is not an inline table of deny entries";
  const a = [...table].sort();
  const b = [...expected].sort();
  const missing = b.filter((x) => !a.includes(x));
  const extra = a.filter((x) => !b.includes(x));
  if (missing.length || extra.length) return `the deny table differs from the one resolved now${missing.length ? ` (missing: ${missing.join(", ")})` : ""}${extra.length ? ` (no longer resolved: ${extra.join(", ")})` : ""}`;
  return null;
}

const ADAPT = {
  codex({ profile, mode, cwd, paths, resultTo, ...ctx }) {
    const srv = codexServer(hoptellServer({ ...ctx.hoptell, run: ctx.run, home: ctx.home, paths }));
    const o = profile.cliOptions ?? {};
    const opts = [...(o.model ? ["-m", o.model] : []), ...(o.effort ? ["-c", `model_reasoning_effort=${toml(CODEX_EFFORT[o.effort])}`] : [])];
    if (mode === "headless") {
      const hm = headlessModeOf(profile);
      if (!OFFERED_MODES.includes(hm)) throw new Error(`headless mode ${hm} is not offered`);
      // plain: today's `-s <sandbox>`. hardening: no -s/--sandbox ever (it would void the profile),
      // a per-run profile id that lower configuration layers cannot address, the sandbox's
      // built-in as its base, and only "deny" entries (any narrower allow would beat a deny).
      let perm = ["-s", profile.sandbox];
      let binding = { mode: "plain" };
      if (hm === "hardening") {
        if (profile.sandbox !== "read-only") throw new Error("hardening is for read-only profiles only");
        const id = ctx.profileId ?? "<PROFILE_ID>";
        const table = ctx.deny ? denyTableToml(ctx.deny) : "<DENY_TABLE>";
        perm = ["-c", `default_permissions=${toml(id)}`, "-c", `permissions.${id}.extends=${toml(EXTENDS[profile.sandbox])}`, "-c", `permissions.${id}.filesystem=${table}`];
        binding = { mode: "hardening", ...(ctx.profileId ? { profileId: ctx.profileId } : {}), ...(ctx.deny ? { deny: [...ctx.deny] } : {}) };
      }
      // hardening: Codex sub-agents off (0.162.1 config/mod.rs: `agents.enabled = false` selects
      // MultiAgentVersion::Disabled unless features.multi_agent_v2 is on, and then no collaboration
      // tool is offered), so no thread outside the run's own can be started.
      const noSubAgents = hm === "hardening" ? ["-c", "agents.enabled=false", "-c", "features.multi_agent_v2=false"] : [];
      const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", ...perm, "-c", 'approval_policy="never"', ...codexFeaturesOff(), ...noSubAgents, "-c", 'web_search="disabled"', "-c", "agents.max_threads=1", "-C", cwd, "-o", paths.result, ...srv, "-c", 'mcp_servers.hoptell.default_tools_approval_mode="approve"', ...opts, "-"];
      if (hm === "hardening" && (args.includes("-s") || args.includes("--sandbox"))) throw new Error("a hardened plan never passes -s/--sandbox");
      return {
        binding,
        // `default_tools_approval_mode="approve"` applies to the hoptell server only: the run-only
        // server (`--run`), which serves a verified run's allow list and refuses every other tool
        // with not_available_in_run. Under approval_policy="never" Codex refuses every MCP tool
        // call that needs an approval; shell commands stay denied by the sandbox.
        args,
        result: { from: "file" },
      };
    }
    return { args: ["-s", profile.sandbox, "-a", "on-request", "-C", cwd, ...srv, ...opts, initialPrompt(resultTo)] };
  },
  claude({ profile, mode, paths, name, resultTo, ...ctx }) {
    const o = profile.cliOptions ?? {};
    const srv = hoptellServer({ ...ctx.hoptell, run: ctx.run, home: ctx.home, paths });
    const files = { mcp: { mcpServers: { hoptell: { type: "stdio", ...srv } } } };
    // Variadic options (--mcp-config, --allowedTools) come before a single-value option, so
    // the positional prompt is never taken as one of their values.
    const common = [
      "--permission-mode",
      profile.sandbox === "read-only" ? "plan" : "acceptEdits",
      "--strict-mcp-config",
      "--mcp-config",
      paths.mcp,
      ...(o.allowedTools ?? []).flatMap((t) => ["--allowedTools", t]),
      ...(o.disallowedTools ?? []).flatMap((t) => ["--disallowedTools", t]),
      ...(o.model ? ["--model", o.model] : []),
      ...(o.effort ? ["--effort", CLAUDE_EFFORT[o.effort]] : []),
      "-n",
      name,
    ];
    if (mode === "headless") {
      const budget = profile.limits?.budgetUsd;
      return {
        args: ["-p", "--output-format", "json", "--no-session-persistence", "--permission-prompts", "none", ...(budget != null ? ["--max-budget-usd", String(budget)] : []), ...common],
        result: { from: "json", field: "result" },
        files,
      };
    }
    return { args: [...common, initialPrompt(resultTo)], files };
  },
  gemini({ profile, mode, resultTo }) {
    const o = profile.cliOptions ?? {};
    const level = ["--approval-mode", profile.sandbox === "read-only" ? "plan" : "auto_edit", ...(profile.sandbox === "workspace-write" ? ["-s"] : []), ...(o.model ? ["-m", o.model] : [])];
    if (mode === "headless") return { args: ["-p", "", "-o", "json", ...level], result: { from: "json", field: "response" } };
    return { args: [...level, "-i", initialPrompt(resultTo)] };
  },
  agy({ profile, mode, lifetimeMinutes, resultTo }) {
    const o = profile.cliOptions ?? {};
    const level = ["--mode", profile.sandbox === "read-only" ? "plan" : "accept-edits", ...(profile.sandbox === "workspace-write" ? ["--sandbox"] : []), ...(o.model ? ["--model", o.model] : [])];
    if (mode === "headless") return { args: ["--print", "--output-format", "json", "--print-timeout", `${Math.round(lifetimeMinutes * 60)}s`, ...level], result: { from: "json", field: "result" } };
    return { args: [...level, "-i", initialPrompt(resultTo)] };
  },
};

/**
 * Is `dir` inside a Git work tree, as Git itself decides (`git rev-parse --is-inside-work-tree`
 * in `dir`, with only PATH in its environment: the spawner's, then /usr/bin and /bin)?
 * `codex exec` refuses to run anywhere else, and hoptell never passes --skip-git-repo-check, so a
 * Codex spawn outside one is refused up front
 * (cwd_not_git_repo). No git, or any error: false.
 */
export function insideGitWorkTree(dir, { pathVar = "" } = {}) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, env: { PATH: [pathVar, "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter) }, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** A shell-like rendering of an argument list, for people only (never executed). */
export function shellLine(command, args) {
  const q = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replaceAll("'", "'\\''")}'`);
  return [command, ...args].map(q).join(" ");
}

/**
 * The generated command line per mode of a (checked) profile, for the approval view: the run's
 * values as placeholders (<run>, <home>, <name>, <spawner>), its default folder as the cwd.
 */
export function commandLines(profile, { node = "node", bin = "hoptell", gates = GATES } = {}) {
  const out = {};
  const hm = headlessModeOf(profile);
  for (const mode of profile.modes) {
    if (mode === "headless" && profile.cli === "codex" && !OFFERED_MODES.includes(hm)) {
      out[mode] = `(refused: headless mode ${hm} is not offered: adapter_gate_unverified)`;
      continue;
    }
    const dir = "<home>/agents/runs/<run>";
    const paths = { env: `${dir}/env`, relays: `${dir}/relays.json`, mcp: `${dir}/mcp.json`, result: `${dir}/result` };
    const { plan } = buildPlan({
      profile,
      mode,
      run: "<run>",
      home: "<home>",
      cwd: profile.folders.default,
      name: "<name>",
      command: profile.command ?? BIN_NAME[profile.cli],
      hoptell: { node, bin },
      paths,
      resultTo: "<spawner>",
      lifetimeMinutes: profile.limits?.lifetimeMinutes ?? (mode === "headless" ? 30 : 480),
    });
    const p = mode === "headless" ? plan : plan.cli;
    const m = mode === "headless" ? hm : "plain";
    const g = gateFor(profile.cli, mode, m, gates);
    let note = "";
    if (gateRefusal(profile.cli, mode, null, gates, m)) note = `   (refused for now: ${gateRefusal(profile.cli, mode, null, gates, m)})`;
    else if (!g.passed.shapes.includes(gateShape(profile, mode))) note = `   (refused for this profile: its arguments (sandbox ${profile.sandbox}) were not gated: ${g.refusal})`;
    else note = `   (adapter gates passed on ${profile.cli} ${g.passed.binaries.map((b) => `${b.version} (launcher ${b.launcher.slice(0, 12)}, native ${b.native ? b.native.slice(0, 12) : "none"})`).join(", ")}; other binaries or arguments refused: ${g.refusal})`;
    out[mode] = `${shellLine(p.command, p.args)}${mode === "headless" ? " < task" : ""}${note}`;
  }
  return out;
}

/**
 * What the exact subcommand's help must still list for this adapter, mode and sandbox: the flags
 * the sandbox, approvals, MCP isolation and task input rely on, and the option values used.
 */
export function helpNeeds(profile, mode) {
  const sb = profile.sandbox;
  const o = profile.cliOptions ?? {};
  switch (profile.cli) {
    case "codex":
      // hardening: no -s; `codex sandbox` (the preflight) must still take -P, --permission-profile.
      if (mode === "headless" && headlessModeOf(profile) === "hardening") return { helpArgs: ["exec", "--help"], flags: ["-c", "--ignore-user-config", "--ignore-rules", "--ephemeral", "-o", "--json", "-C", ...(o.model ? ["-m"] : [])], values: [], featuresOff: CODEX_FEATURES_OFF, extraHelp: [{ helpArgs: ["sandbox", "--help"], flags: ["-P", "--permission-profile", "-C", "-c"], values: [] }] };
      return mode === "headless"
        ? { helpArgs: ["exec", "--help"], flags: ["-s", "-c", "--ignore-user-config", "--ignore-rules", "--ephemeral", "-o", "--json", "-C", ...(o.model ? ["-m"] : [])], values: [{ flag: "-s", value: sb }], featuresOff: CODEX_FEATURES_OFF }
        : { helpArgs: ["--help"], flags: ["-s", "-a", "-C", "-c", ...(o.model ? ["-m"] : [])], values: [{ flag: "-s", value: sb }, { flag: "-a", value: "on-request" }] };
    case "claude":
      return {
        helpArgs: ["--help"],
        flags: [
          ...(mode === "headless" ? ["-p", "--output-format", "--no-session-persistence", "--permission-prompts", ...(profile.limits?.budgetUsd != null ? ["--max-budget-usd"] : [])] : []),
          "--permission-mode",
          "--strict-mcp-config",
          "--mcp-config",
          "-n",
          ...(o.model ? ["--model"] : []),
          ...(o.effort ? ["--effort"] : []),
          ...(o.allowedTools ? ["--allowedTools"] : []),
          ...(o.disallowedTools ? ["--disallowedTools"] : []),
        ],
        values: [{ flag: "--permission-mode", value: sb === "read-only" ? "plan" : "acceptEdits" }, ...(mode === "headless" ? [{ flag: "--output-format", value: "json" }, { flag: "--permission-prompts", value: "none" }] : [])],
      };
    case "gemini":
      return { helpArgs: ["--help"], flags: ["--approval-mode", ...(mode === "headless" ? ["-p", "-o"] : ["-i"]), ...(sb === "workspace-write" ? ["-s"] : [])], values: [{ flag: "--approval-mode", value: sb === "read-only" ? "plan" : "auto_edit" }] };
    default:
      return { helpArgs: ["--help"], flags: ["--mode", ...(mode === "headless" ? ["--print", "--output-format", "--print-timeout"] : ["-i"]), ...(sb === "workspace-write" ? ["--sandbox"] : [])], values: [{ flag: "--mode", value: sb === "read-only" ? "plan" : "accept-edits" }] };
  }
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An option starts a line with at most 8 spaces; deeper lines continue a description.
const OPTION_LINE = /^ {0,8}-{1,2}[A-Za-z]/;
/**
 * The needs the help text no longer lists: a flag as an option token on an option line; a value
 * as a word inside the help block of the flag that takes it (from its option line to the next).
 */
export function missingInHelp(help, needs) {
  const lines = String(help).split("\n");
  const flagLine = (f) => lines.findIndex((l) => OPTION_LINE.test(l) && new RegExp(`(^|[\\s,])${escRe(f)}(?=[\\s,=<\\[]|$)`).test(l));
  const missing = [];
  for (const f of needs.flags) if (flagLine(f) < 0) missing.push(f);
  for (const { flag, value } of needs.values) {
    const at = flagLine(flag);
    let block = "";
    if (at >= 0) {
      const end = lines.findIndex((l, i) => i > at && OPTION_LINE.test(l));
      block = lines.slice(at, end < 0 ? undefined : end).join("\n");
    }
    if (!new RegExp(`(^|[^A-Za-z0-9_-])${escRe(value)}(?![A-Za-z0-9_-])`, "m").test(block)) missing.push(`value ${value}`);
  }
  return missing;
}

/**
 * The executable of a profile: `profile.command` (absolute, a regular executable file owned by
 * the user or root), else the adapter's binary name on `pathVar`. {command} or {code, problem}.
 */
export function resolveCommand(profile, { pathVar = "", uid = process.getuid?.() } = {}) {
  const check = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return "does not exist";
    }
    if (!st.isFile()) return "is not a file";
    if (!(st.mode & 0o111)) return "is not executable";
    if (uid != null && st.uid !== uid && st.uid !== 0) return "is not owned by you or root";
    return null;
  };
  if (profile.command) {
    if (!path.isAbsolute(profile.command)) return { code: "cli_missing", problem: "command must be an absolute path" };
    const why = check(profile.command);
    return why ? { code: "cli_missing", problem: `${profile.command} ${why}` } : { command: profile.command };
  }
  for (const dir of String(pathVar).split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, BIN_NAME[profile.cli]);
    if (!check(p)) return { command: p };
  }
  return { code: "cli_missing", problem: `${BIN_NAME[profile.cli]} was not found on PATH` };
}

/**
 * The per-spawn check of the CLI: its version and the exact subcommand's help, cached in
 * <home>/agents/cli-checks.json per binary digest and version. {version, digest, untested}, or
 * {code: "cli_missing", problem} or {code: "cli_flags_changed", missing, version}. `env`: the
 * environment the CLI will run with (the run's allow-listed one); `run(command, args)` (tests)
 * returns the output.
 */
export function checkCli(home, profile, mode, command, { env, run = defaultRun(env) }) {
  const bin = cliDigest(command);
  if (bin.problem) return { code: "cli_missing", problem: bin.problem };
  const { digest } = bin;
  let version;
  try {
    version = (String(run(command, ["--version"])).match(/\d+\.\d+\.\d+[\w.-]*/) ?? [null])[0];
  } catch {
    version = null;
  }
  const needs = helpNeeds(profile, mode);
  const key = `${digest}:${version}:${needs.helpArgs.join(" ")}`;
  const cacheFile = path.join(agentsPaths(home).dir, "cli-checks.json");
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) ?? {};
  } catch {
    cache = {};
  }
  let help = cache[key]?.help;
  if (typeof help !== "string") {
    try {
      help = String(run(command, needs.helpArgs));
    } catch (e) {
      return { code: "cli_flags_changed", missing: [`the help of ${[path.basename(command), ...needs.helpArgs].join(" ")} could not be read (${e.code ?? "error"})`], version };
    }
    cache = Object.fromEntries(Object.entries(cache).slice(-15));
    cache[key] = { help, checked: new Date().toISOString() };
    try {
      writeRecord(cacheFile, cache);
    } catch {
      // a cache only
    }
  }
  const missing = missingInHelp(help, needs);
  if (missing.length) return { code: "cli_flags_changed", missing, version };
  for (const extra of needs.extraHelp ?? []) {
    const ekey = `${digest}:${version}:${extra.helpArgs.join(" ")}`;
    let text = cache[ekey]?.help;
    if (typeof text !== "string") {
      try {
        text = String(run(command, extra.helpArgs));
      } catch (e) {
        return { code: "cli_flags_changed", missing: [`the help of ${[path.basename(command), ...extra.helpArgs].join(" ")} could not be read (${e.code ?? "error"})`], version };
      }
      cache[ekey] = { help: text, checked: new Date().toISOString() };
      try {
        writeRecord(cacheFile, cache);
      } catch {
        // a cache only
      }
    }
    const m = missingInHelp(text, extra).map((x) => `${x} (${extra.helpArgs.join(" ")})`);
    if (m.length) return { code: "cli_flags_changed", missing: m, version };
  }
  if (needs.featuresOff?.length) {
    // `codex features list` with the run's own overrides: every feature must be listed, off.
    const fkey = `${digest}:${version}:features:${needs.featuresOff.join(",")}`;
    let list = cache[fkey]?.help;
    if (typeof list !== "string") {
      try {
        list = String(run(command, ["features", "list", ...needs.featuresOff.flatMap((f) => ["-c", `features.${f}=false`])]));
      } catch (e) {
        return { code: "cli_flags_changed", missing: [`the feature list of ${path.basename(command)} could not be read (${e.code ?? "error"})`], version };
      }
      cache[fkey] = { help: list, checked: new Date().toISOString() };
      try {
        writeRecord(cacheFile, cache);
      } catch {
        // a cache only
      }
    }
    const off = featuresNotOff(list, needs.featuresOff);
    if (off.length) return { code: "cli_flags_changed", missing: off, version };
  }
  const native = nativeDigest(home, profile.cli, command);
  return { version, digest, native: native.digest ?? null, untested: !(version && TESTED[profile.cli]?.includes(version)) };
}

/**
 * The native binary a CLI's command starts: for Codex's npm launcher (a script), the one
 * platform binary of its package (node_modules/@openai/codex-<platform>/vendor/<triple>/bin/
 * codex); otherwise the file the command resolves to. {path} or {problem}.
 */
export function nativeBinary(cli, command) {
  let real;
  try {
    real = fs.realpathSync(command);
  } catch (e) {
    return { problem: `${command} cannot be read: ${e.code ?? e.message}` };
  }
  if (cli !== "codex") return { path: real };
  const head = Buffer.alloc(2);
  try {
    const fd = fs.openSync(real, "r");
    try {
      fs.readSync(fd, head, 0, 2, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { problem: `${command} cannot be read: ${e.code ?? e.message}` };
  }
  if (head.toString("latin1") !== "#!") return { path: real };
  const scope = path.join(path.dirname(real), "..", "node_modules", "@openai");
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(scope).filter((d) => d.startsWith("codex-"));
  } catch {}
  for (const d of dirs) {
    let triples = [];
    try {
      triples = fs.readdirSync(path.join(scope, d, "vendor"));
    } catch {}
    for (const t of triples) {
      const bin = path.join(scope, d, "vendor", t, "bin", "codex");
      try {
        if (fs.statSync(bin).isFile()) found.push(bin);
      } catch {}
    }
  }
  if (found.length !== 1) return { problem: found.length ? `${found.length} native codex binaries next to ${real}` : `no native codex binary next to ${real}` };
  return { path: found[0] };
}

/**
 * The SHA-256 of the native binary (nativeBinary): {digest} or {problem}. Cached in
 * <home>/agents/cli-checks.json per path, size, inode, mtime and ctime (a change of the file
 * changes its ctime), so a spawn hashes a large binary once.
 */
export function nativeDigest(home, cli, command) {
  const n = nativeBinary(cli, command);
  if (n.problem) return n;
  let st;
  try {
    st = fs.statSync(n.path);
  } catch (e) {
    return { problem: `${n.path} cannot be read: ${e.code ?? e.message}` };
  }
  const key = `native:${n.path}:${st.size}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}`;
  const cacheFile = path.join(agentsPaths(home).dir, "cli-checks.json");
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) ?? {};
  } catch {
    cache = {};
  }
  if (/^[0-9a-f]{64}$/.test(cache[key]?.digest ?? "")) return { digest: cache[key].digest };
  const d = cliDigest(n.path);
  if (d.problem) return d;
  cache = Object.fromEntries(Object.entries(cache).slice(-15));
  cache[key] = { digest: d.digest, checked: new Date().toISOString() };
  try {
    writeRecord(cacheFile, cache);
  } catch {
    // a cache only
  }
  return { digest: d.digest };
}

/**
 * The SHA-256 of the file `command` resolves to (symbolic links followed): {digest} or {problem}.
 * A run records the digest of the CLI that was checked; it runs only that file.
 */
export function cliDigest(command) {
  try {
    return { digest: crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(command))).digest("hex") };
  } catch (e) {
    return { problem: `${command} cannot be read: ${e.code ?? e.message}` };
  }
}

/**
 * The features of `wanted` that `codex features list` output does not show as off: a row
 * "<name> <stage> false" is required (Codex ignores an unknown feature name silently). Fails
 * closed: a non-blank line that is not exactly such a row, or a feature listed twice, makes every
 * wanted feature unverified.
 */
export function featuresNotOff(list, wanted) {
  const rows = new Map();
  const bad = [];
  for (const line of String(list).split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)\s*$/);
    if (!m) bad.push("a line that is not a feature row");
    else if (rows.has(m[1])) bad.push(`feature ${m[1]} listed twice`);
    else rows.set(m[1], m[3]);
  }
  if (bad.length) return [`the feature list cannot be read (${[...new Set(bad)].join(", ")})`];
  return wanted.filter((f) => rows.get(f) !== "false").map((f) => (rows.has(f) ? `feature ${f} stays on` : `feature ${f} (not in the feature list)`));
}

const defaultRun = (env) => {
  // The CLIs start through a shebang (#!/usr/bin/env node): without PATH nothing runs.
  if (!env?.PATH) throw new Error("checkCli needs the environment the CLI will run with (PATH)");
  return (command, args) => execFileSync(command, args, { encoding: "utf8", env, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
};
