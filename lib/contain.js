// Contained Codex team members (design 10, Part C, phase C1): the pinned launch of a Codex
// implementer and the checks that decide whether it counts as contained, so that hoptell's git
// commands need not wait for it to stop.
//
// A member counts as contained only when every launch row of design 10, C.4 passes; a row that
// fails, or cannot be evaluated, launches it uncontained, as before (stop it before git). The
// first row (V) needs a VERIFIED row of lib/capabilities.js for the mechanism ("contained-member
// set A" or "set B") at this Codex version. Phase C2's real-CLI tests write that row; until then
// none ships, so row V fails for every version and every member stays uncontained. In production
// the evaluation stops at row V: nothing else is read or run at a launch.
//
// Every row returns {ok: true} or {ok: false, why}; a row that throws counts as failed.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VERIFIED, compareVersions } from "./capabilities.js";
import { insidePath } from "./agentdeny.js";

export const SETS = ["A", "B"];
export const MECHANISM = { A: "contained-member set A", B: "contained-member set B" };

/**
 * The features a contained member keeps (row F): what an implementer needs and acts only through
 * the sandboxed shell or the model. Every other feature key the binary lists gets `--disable`.
 * Phase C2's tests fix this list; it may only shrink without them.
 */
export const FEATURE_ALLOW = ["goals", "incremental_tools", "shell_snapshot", "shell_tool", "unified_exec", "unified_exec_tty", "view_image"];
/** Root-level legacy feature toggles of Codex 0.165.0 (`LegacyFeatureToggles`, features/src/legacy.rs). */
export const LEGACY_TOGGLES = ["experimental_use_unified_exec_tool"];
/** Environment a contained launch clears (C.3): another executor, a managed-config path, a sandbox marker. */
export const CLEARED_ENV = ["CODEX_EXEC_SERVER_URL", "CODEX_APP_SERVER_MANAGED_CONFIG_PATH", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"];
export const PROFILE = "hoptell-member";
export const SERVER_RE = /^hoptell-member-[0-9a-f]{16}$/;
export const newServerName = () => `hoptell-member-${crypto.randomBytes(8).toString("hex")}`;

const ok = { ok: true };
const no = (why) => ({ ok: false, why: String(why).slice(0, 500) });
/** Run a row: a throw is a failed row, never a pass. */
export function row(fn) {
  try {
    const r = fn();
    return r && typeof r === "object" && r.ok === true ? r : r && r.ok === false ? r : no("the check gave no answer");
  } catch (e) {
    return no(`the check failed (${e?.code ?? e?.message ?? "error"})`);
  }
}

// TOML basic strings take JSON's escapes; a key is bare when it can be.
const toml = (s) => JSON.stringify(String(s));
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : toml(k));
const inline = (o) => `{${Object.entries(o).map(([k, v]) => `${tomlKey(k)}=${Array.isArray(v) ? `[${v.map(toml).join(", ")}]` : v && typeof v === "object" ? inline(v) : toml(v)}`).join(", ")}}`;

// ---- row V: the version -----------------------------------------------------------------------

/** The VERIFIED row of a contained-member mechanism that holds at `version`, or null. A pre-release holds only at an exact tested end. */
export function verifiedContainment(set, version, table = VERIFIED) {
  if (!SETS.includes(set) || typeof version !== "string" || !version) return null;
  const pre = !/^\d+(\.\d+)*$/.test(version);
  return table.find((r) => r.cli === "codex" && r.mechanism === MECHANISM[set] && r.class === "contained" && (pre ? version === r.min || version === r.max : compareVersions(version, r.min) >= 0 && compareVersions(version, r.max) <= 0)) ?? null;
}

export function rowV({ set, version, verified = VERIFIED }) {
  if (!version) return no("the Codex version is unknown");
  return verifiedContainment(set, version, verified) ? ok : no(`no hoptell test verified containment (${MECHANISM[set] ?? set}) for codex ${version}`);
}

// ---- the pinned launch (C.3) --------------------------------------------------------------------

/**
 * The member's own hoptell MCP server under a fresh name no layer defines (C.3): stdio only, the
 * node binary and the realpath of this hoptell's entry script, with its digest, and an explicit
 * environment. {name, command, args, env, entryDigest, value (the TOML inline table)}.
 */
export function pinnedRegistration({ name = newServerName(), node = process.execPath, entry, env }, { fsx = fs } = {}) {
  if (!SERVER_RE.test(name)) throw new Error(`not a pinned server name: ${name}`);
  const real = fsx.realpathSync(entry);
  const entryDigest = crypto.createHash("sha256").update(fsx.readFileSync(real)).digest("hex");
  const args = [real, "mcp"];
  return { name, command: node, args, env: { ...env }, entryDigest, value: inline({ command: node, args, env }) };
}

/** The common part of both sets (C.3), without the environment: the pins that come after the member's own flags. */
export function commonPins({ features, servers, registration }) {
  const off = Object.keys(features ?? {})
    .filter((k) => !FEATURE_ALLOW.includes(k) && k !== "hooks" && k !== "plugins")
    .sort();
  return [
    "--no-daemon",
    "-a",
    "never",
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    ...off.flatMap((k) => ["--disable", k]),
    "-c",
    "notify=[]",
    "-c",
    'approvals_reviewer="user"',
    "-c",
    'tui.resume_cwd="current"',
    ...[...servers].sort().flatMap((n) => ["-c", `mcp_servers.${tomlKey(n)}.enabled=false`]),
    "-c",
    `mcp_servers.${registration.name}=${registration.value}`,
  ];
}

export const SET_PINS = {
  A: ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.writable_roots=[]", "-c", "sandbox_workspace_write.exclude_slash_tmp=true"],
  B: ["-c", `default_permissions="${PROFILE}"`, "-c", `permissions.${PROFILE}={extends=":workspace", filesystem={"~/.ssh"="deny", "/tmp"="deny"}, network={enabled=false}}`],
};

const withoutPair = (args, flag, value) => args.filter((a, i) => !(a === flag && args[i + 1] === value) && !(args[i - 1] === flag && a === value));
/** Without `-s <mode>` (the set decides the sandbox; with `-s` present Codex ignores a profile). */
const withoutSandboxFlag = (args) => args.filter((a, i) => !(a === "-s" || a === "--sandbox" || args[i - 1] === "-s" || args[i - 1] === "--sandbox"));

/**
 * A contained member's launch (C.3): `parts` from memberCommand ({head (["resume", id] or []),
 * args (preset flags, model, effort), extra, placed (developer_instructions and the prompt)}),
 * then the pins last before the template and prompt. {env (the `env` prefix), argv (from
 * "codex"), launch (env + argv)}.
 */
export function containedPlan({ set, parts, features, servers, registration, codexHome, tmpdir, envTool = "/usr/bin/env" }) {
  if (!SETS.includes(set)) throw new Error(`no pin set ${set}`);
  // A Codex resume's only extra (-c tui.resume_cwd="current") is one of the common pins.
  const extra = withoutPair(parts.extra, "-c", 'tui.resume_cwd="current"');
  const argv = ["codex", ...parts.head, ...withoutSandboxFlag(parts.args), ...extra, ...commonPins({ features, servers, registration }), ...SET_PINS[set], ...parts.placed];
  const env = [envTool, ...CLEARED_ENV.flatMap((k) => ["-u", k]), `CODEX_HOME=${codexHome}`, `TMPDIR=${tmpdir}`];
  return { set, env, argv, launch: [...env, ...argv] };
}

// ---- row P: the final argv ----------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FEATURE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * Row P at launch: every token of `argv` is on the allow-list (C.4): "codex", an optional
 * `resume <id>`, `-a never`, `-m <model>`, `--no-daemon`, `--disable <feature>`, `-s
 * workspace-write` (set A), and `-c` only with the pinned values, `model_reasoning_effort` and
 * `developer_instructions`, then one prompt last. The pins themselves must all be present.
 */
export function rowP(argv, { set, registration, servers }) {
  if (!Array.isArray(argv) || argv[0] !== "codex") return no("the command is not codex");
  const fixed = new Set(["notify=[]", 'approvals_reviewer="user"', 'tui.resume_cwd="current"', `mcp_servers.${registration.name}=${registration.value}`, ...[...servers].map((n) => `mcp_servers.${tomlKey(n)}.enabled=false`)]);
  for (let i = 1; i < SET_PINS[set].length; i += 2) if (SET_PINS[set][i - 1] === "-c") fixed.add(SET_PINS[set][i]);
  const seen = new Map();
  let i = 1;
  if (argv[1] === "resume") {
    if (!UUID_RE.test(argv[2] ?? "")) return no("resume without a conversation id");
    i = 3;
  }
  let prompt = false;
  for (; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    const once = (k, value) => {
      if (seen.has(k) && seen.get(k) !== value) return no(`${k} is given twice with different values`);
      seen.set(k, value);
      i++;
      return null;
    };
    let bad = null;
    if (prompt) return no("a token after the prompt");
    if (a === "--no-daemon") seen.set(a, true);
    else if (a === "-a") bad = v === "never" ? once("-a", v) : no(`-a ${String(v).slice(0, 40)}`);
    else if (a === "-s") bad = set === "A" && v === "workspace-write" ? once("-s", v) : no(`-s ${String(v).slice(0, 40)}`);
    else if (a === "-m") bad = typeof v === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(v) ? once("-m", v) : no("-m without a model");
    else if (a === "--disable") bad = typeof v === "string" && FEATURE_RE.test(v) ? once(`--disable ${v}`, v) : no(`--disable ${String(v).slice(0, 40)}`);
    else if (a === "-c") {
      if (typeof v !== "string") return no("-c without a value");
      const key = v.slice(0, v.indexOf("=") < 0 ? v.length : v.indexOf("="));
      if (fixed.has(v)) bad = once(`-c ${key}`, v);
      else if (/^model_reasoning_effort="[a-z]{1,20}"$/.test(v) || key === "developer_instructions") bad = once(`-c ${key}`, v);
      else bad = no(`-c ${key.slice(0, 60)}`);
    } else if (a.startsWith("-")) bad = no(a.slice(0, 60));
    else prompt = true;
    if (bad) return bad;
  }
  const need = ["--no-daemon", "-a", "--disable hooks", "--disable plugins", "-c notify", "-c approvals_reviewer", "-c tui.resume_cwd", `-c mcp_servers.${registration.name}`, ...[...servers].map((n) => `-c mcp_servers.${tomlKey(n)}.enabled`), ...(set === "A" ? ["-s", "-c sandbox_workspace_write.network_access", "-c sandbox_workspace_write.writable_roots", "-c sandbox_workspace_write.exclude_slash_tmp"] : ["-c default_permissions", `-c permissions.${PROFILE}`])];
  const missing = need.filter((k) => !seen.has(k));
  return missing.length ? no(`the pinned ${missing[0]} is missing`) : ok;
}

/** Row E: the launch goes through the plan's `env` prefix, then exactly the plan's argv. */
export function rowE(launch, plan) {
  const want = plan.launch;
  return Array.isArray(launch) && launch.length === want.length && launch.every((x, i) => x === want[i]) ? ok : no("the launch is not the pinned env prefix and argv");
}

// ---- rows M1, M2, M3: managed configuration -----------------------------------------------------

const ENOENT = (e) => e?.code === "ENOENT";

/** Row M1: none of Codex's system files exists, and /etc/codex can be read. */
export function rowM1({ etc = "/etc/codex", fsx = fs } = {}) {
  let names;
  try {
    names = fsx.readdirSync(etc);
  } catch (e) {
    if (ENOENT(e)) return ok;
    return no(`${etc} cannot be read (${e.code ?? "error"})`);
  }
  const found = ["config.toml", "requirements.toml", "managed_config.toml", "rules", "hooks.json"].filter((n) => names.includes(n));
  return found.length ? no(`${path.join(etc, found[0])} exists`) : ok;
}

const PREF_APP = "com.openai.codex";
export const PREF_KEYS = ["config_toml_base64", "requirements_toml_base64"];
/**
 * The fixed JXA script of row M2: per key, whether its value is forced, by the call Codex makes
 * (CFPreferencesAppValueIsForced, config/src/loader/macos.rs). Prints {key: {forced: bool}}.
 */
export const FORCED_PREFS_SCRIPT = `ObjC.import("CoreFoundation"); const s = (x) => $.CFStringCreateWithCString(null, x, 0x08000100); const app = s(${JSON.stringify(PREF_APP)}); JSON.stringify(Object.fromEntries(${JSON.stringify(PREF_KEYS)}.map((k) => [k, { forced: Boolean($.CFPreferencesAppValueIsForced(s(k), app)) }])))`;

const defaultOsascript = () => {
  const r = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", FORCED_PREFS_SCRIPT], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  return { status: r.status, stdout: r.stdout ?? "", error: r.error ? (r.error.code ?? "error") : null };
};

/** Row M2's reading of the helper's answer: only {key: {forced: false}} for both keys, and nothing else, passes. */
export function parseForced(r) {
  if (!r || r.error) return no(`the managed preferences of ${PREF_APP} cannot be read (${r?.error ?? "no answer"})`);
  if (r.status !== 0) return no(`the managed preferences of ${PREF_APP} cannot be read (exit ${r.status})`);
  let d;
  try {
    d = JSON.parse(String(r.stdout).trim());
  } catch {
    return no(`the managed preferences of ${PREF_APP} gave an unexpected answer`);
  }
  if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).sort().join() !== [...PREF_KEYS].sort().join()) return no(`the managed preferences of ${PREF_APP} gave an unexpected answer`);
  for (const k of PREF_KEYS) {
    if (!d[k] || typeof d[k] !== "object" || Object.keys(d[k]).join() !== "forced" || typeof d[k].forced !== "boolean") return no(`the managed preferences of ${PREF_APP} gave an unexpected answer`);
    if (d[k].forced) return no(`the managed preference ${PREF_APP} ${k} is forced`);
  }
  return ok;
}

/** Row M2: macOS managed preferences; not applicable elsewhere. */
export function rowM2({ platform = process.platform, osascript = defaultOsascript } = {}) {
  if (platform !== "darwin") return ok;
  return parseForced(osascript());
}

/** Where the owner records that their Codex login has no workspace-managed configuration (decision CD5). */
export const managedRecordOf = (home) => path.join(home, "agents", "codex-managed.json");

/** Row M3: the owner's record (version 1, managed "none"); none, or anything else, fails. Row S must then report the pinned profile too. */
export function rowM3({ home, fsx = fs }) {
  let d;
  try {
    d = JSON.parse(fsx.readFileSync(managedRecordOf(home), "utf8"));
  } catch (e) {
    return no(ENOENT(e) ? "you have not recorded that your Codex login has no workspace-managed configuration (decision CD5)" : "the record of your Codex login's managed configuration cannot be read");
  }
  return d?.version === 1 && d.managed === "none" ? ok : no("the record of your Codex login's managed configuration does not say none");
}

// ---- the candidate layer folders (C.3) ------------------------------------------------------------

/** /etc/codex, CODEX_HOME, and <dir>/.codex for every folder from the member's up to "/". */
export function candidateFolders(dir, { codexHome, etc = "/etc/codex" }) {
  const out = [etc, codexHome];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.push(path.join(d, ".codex"));
    if (d === path.dirname(d)) break;
  }
  return [...new Set(out)];
}

/** Row R (set A): no candidate folder has a rules/ folder with anything in it; every one can be read. */
export function rowR(candidates, { fsx = fs } = {}) {
  for (const c of candidates) {
    const rules = path.join(c, "rules");
    let st;
    try {
      st = fsx.lstatSync(rules);
    } catch (e) {
      if (ENOENT(e) || e?.code === "ENOTDIR") continue;
      return no(`${rules} cannot be read (${e.code ?? "error"})`);
    }
    if (!st.isDirectory()) return no(`${rules} is not a plain folder`);
    const walk = (d) => {
      for (const e of fsx.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          const r = walk(p);
          if (r) return r;
        } else return e.isFile() ? `the rules file ${p} exists` : `${p} is not a plain file or folder`;
      }
      return null;
    };
    let found;
    try {
      found = walk(rules);
    } catch (e) {
      return no(`${rules} cannot be read (${e.code ?? "error"})`);
    }
    if (found) return no(found);
  }
  return ok;
}

// ---- reading the candidate layers' config.toml ----------------------------------------------------

/**
 * The key paths of a TOML document, read conservatively: table headers and every key with its
 * full path, including the keys of inline tables, decoded; and every string value, decoded
 * (`opaque`: a multi-line basic string with an escape, which is not decoded). {keys: [[...path]],
 * strings, opaque} or {problem}. Anything it does not recognize is a problem: a check that needs
 * it then fails.
 */
export function tomlKeys(text) {
  const s = String(text);
  let i = 0;
  const keys = [];
  const strings = [];
  let opaque = false;
  let table = [];
  const lineNo = () => s.slice(0, i).split("\n").length;
  const bad = (why) => {
    throw Object.assign(new Error(`${why} at line ${lineNo()}`), { toml: true });
  };
  const ws = () => {
    while (s[i] === " " || s[i] === "\t") i++;
  };
  const blank = () => {
    for (;;) {
      ws();
      if (s[i] === "#") while (i < s.length && s[i] !== "\n") i++;
      if (s[i] === "\n" || s[i] === "\r") i++;
      else return;
    }
  };
  const eol = () => {
    ws();
    if (s[i] === "#") while (i < s.length && s[i] !== "\n") i++;
    if (i < s.length && s[i] !== "\n" && !(s[i] === "\r" && s[i + 1] === "\n")) bad("unexpected text");
  };
  const basic = () => {
    const start = i;
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\n") bad("an unterminated string");
      i += s[i] === "\\" ? 2 : 1;
    }
    if (s[i] !== '"') bad("an unterminated string");
    i++;
    try {
      return JSON.parse(s.slice(start, i));
    } catch {
      return bad("a string hoptell cannot read");
    }
  };
  const literal = () => {
    const end = s.indexOf("'", i + 1);
    if (end < 0 || s.slice(i + 1, end).includes("\n")) bad("an unterminated string");
    const v = s.slice(i + 1, end);
    i = end + 1;
    return v;
  };
  const key = () => {
    const out = [];
    for (;;) {
      ws();
      if (s[i] === '"') out.push(basic());
      else if (s[i] === "'") out.push(literal());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
        if (!m) bad("a key hoptell cannot read");
        out.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (s[i] !== ".") return out;
      i++;
    }
  };
  // A value, skipped; the key paths inside an inline table are returned.
  const value = () => {
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
      const q = s.slice(i, i + 3);
      let j = i + 3;
      for (;;) {
        const k = s.indexOf(q, j);
        if (k < 0) bad("an unterminated string");
        if (q === '"""' && s[k - 1] === "\\" && s[k - 2] !== "\\") {
          j = k + 1;
          continue;
        }
        const start = i + 3;
        i = k + 3;
        while (s[i] === q[0]) i++;
        const body = s.slice(start, i - 3);
        if (q === '"""' && body.includes("\\")) opaque = true;
        else strings.push(body);
        return [];
      }
    }
    if (s[i] === '"') return strings.push(basic()), [];
    if (s[i] === "'") return strings.push(literal()), [];
    if (s[i] === "[") {
      i++;
      for (;;) {
        blank();
        if (s[i] === "]") return i++, [];
        value();
        blank();
        if (s[i] === ",") i++;
        else if (s[i] !== "]") bad("an array hoptell cannot read");
      }
    }
    if (s[i] === "{") {
      i++;
      const inner = [];
      for (;;) {
        blank();
        if (s[i] === "}") return i++, inner;
        const k = key();
        if (s[i] !== "=") bad("an inline table hoptell cannot read");
        i++;
        ws();
        inner.push(k);
        for (const p of value()) inner.push([...k, ...p]);
        blank();
        if (s[i] === ",") i++;
        else if (s[i] !== "}") bad("an inline table hoptell cannot read");
      }
    }
    const m = /^[-+0-9A-Za-z_.:]+/.exec(s.slice(i));
    if (!m || !/^(true|false|[-+]?(inf|nan)|[-+]?[0-9][0-9_]*(\.[0-9_]+)?([eE][-+]?[0-9]+)?|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[-+]\d{2}:\d{2})?)?|[0-9:.]+)$/.test(m[0])) bad("a value hoptell cannot read");
    i += m[0].length;
    return [];
  };
  try {
    if (s.includes("\0")) bad("a NUL byte");
    for (;;) {
      blank();
      if (i >= s.length) break;
      if (s[i] === "[") {
        const array = s[i + 1] === "[";
        i += array ? 2 : 1;
        table = key();
        if (s[i] !== "]" || (array && s[i + 1] !== "]")) bad("a table header hoptell cannot read");
        i += array ? 2 : 1;
        keys.push(table);
        eol();
        continue;
      }
      const k = key();
      if (s[i] !== "=") bad("a line hoptell cannot read");
      i++;
      ws();
      const full = [...table, ...k];
      keys.push(full);
      for (const p of value()) keys.push([...full, ...p]);
      eol();
    }
  } catch (e) {
    if (e.toml) return { problem: e.message };
    throw e;
  }
  return { keys, strings, opaque };
}

/** What the rows read from one config.toml: {servers, features, legacy, hooks, profileName} or {problem}. */
export function configFacts(text) {
  const t = tomlKeys(text);
  if (t.problem) return { problem: t.problem };
  const servers = new Set();
  const features = new Set();
  const legacy = new Set();
  let hooks = false;
  for (const p of t.keys) {
    if (p[0] === "mcp_servers" && p.length >= 2) servers.add(p[1]);
    if (p[0] === "features" && p.length >= 2) features.add(p.slice(1).join("."));
    if (p[0] === "profiles" && p[2] === "features" && p.length >= 4) features.add(p.slice(3).join("."));
    if (p.length === 1 && LEGACY_TOGGLES.includes(p[0])) legacy.add(p[0]);
    if (p[0] === "profiles" && p.length === 3 && LEGACY_TOGGLES.includes(p[2])) legacy.add(p[2]);
    if (p[0] === "hooks") hooks = true;
  }
  // Row B, read as a superset: the profile's name in any decoded key or string value (a table of
  // it, an extends naming it), in any case, or anywhere in the text; unknown when a string was not
  // decoded.
  const named = (x) => x.toLowerCase().includes(PROFILE);
  const profileName = t.keys.some((p) => p.some(named)) || t.strings.some(named) || named(String(text)) ? true : t.opaque ? "unknown" : false;
  return { servers, features, legacy, hooks, profileName };
}

/** The config.toml and hooks.json of every candidate folder: [{file, text | null (absent), problem}]. */
export function readLayers(candidates, { fsx = fs } = {}) {
  const out = [];
  for (const c of candidates) {
    for (const name of ["config.toml", "hooks.json"]) {
      const file = path.join(c, name);
      try {
        const st = fsx.lstatSync(file);
        if (!st.isFile()) out.push({ file, problem: `${file} is not a plain file` });
        else if (st.size > 1024 * 1024) out.push({ file, problem: `${file} is larger than 1 MiB` });
        else out.push({ file, text: fsx.readFileSync(file, "utf8") });
      } catch (e) {
        if (ENOENT(e) || e?.code === "ENOTDIR") continue;
        out.push({ file, problem: `${file} cannot be read (${e.code ?? "error"})` });
      }
    }
  }
  return out;
}

const configs = (layers) => layers.filter((l) => l.file.endsWith("config.toml"));

/** Row B (set B): no candidate layer names the profile, and every one can be read. */
export function rowB(layers) {
  for (const l of configs(layers)) {
    if (l.problem) return no(l.problem);
    const f = configFacts(l.text);
    if (f.problem) return no(`${l.file}: ${f.problem}`);
    if (f.profileName === "unknown") return no(`${l.file} has a multi-line string with an escape, which hoptell does not decode`);
    if (f.profileName) return no(`${l.file} names the permission profile ${PROFILE}`);
  }
  return ok;
}

/** Row H's report (not blocking: the hooks feature is off): candidate folders with hooks. */
export function hooksNotes(layers) {
  const notes = [];
  for (const l of layers) {
    if (l.file.endsWith("hooks.json")) notes.push(`${l.file} exists (hooks are off in a contained member)`);
    else if (l.text != null && configFacts(l.text).hooks) notes.push(`${l.file} has hooks (off in a contained member)`);
  }
  return notes;
}

/** The MCP server names the candidate layers configure, for the disables of the plan. {servers} or {problem}. */
export function layerServers(layers) {
  const servers = new Set();
  for (const l of configs(layers)) {
    if (l.problem) return { problem: l.problem };
    const f = configFacts(l.text);
    if (f.problem) return { problem: `${l.file}: ${f.problem}` };
    for (const n of f.servers) servers.add(n);
  }
  return { servers };
}

/**
 * Row X at launch: every configured server is disabled in argv, no layer defines the pinned
 * name, and the pinned registration is the one built from this hoptell (`expected`).
 */
export function rowX(layers, { argv, registration, expected }) {
  const l = layerServers(layers);
  if (l.problem) return no(l.problem);
  if (l.servers.has(registration.name)) return no(`a candidate layer defines ${registration.name}`);
  for (const n of l.servers) if (!argv.includes(`mcp_servers.${tomlKey(n)}.enabled=false`)) return no(`the MCP server ${n.slice(0, 60)} is not disabled`);
  const same = registration.command === expected.command && registration.entryDigest === expected.entryDigest && JSON.stringify(registration.args) === JSON.stringify(expected.args) && JSON.stringify(registration.env) === JSON.stringify(expected.env) && registration.value === expected.value;
  return same ? ok : no("the pinned hoptell server is not the one built from this hoptell");
}

/**
 * Row F: argv disables every listed feature not on the allow-list; no candidate layer names a
 * feature key that is not a canonical key of this binary (an alias), or a legacy toggle; and the
 * binary's feature list could be read (`features`: the capability record's, or null).
 */
export function rowF(layers, { argv, features }) {
  if (!features || typeof features !== "object" || !Object.keys(features).length) return no("Codex's feature list could not be read");
  for (const k of Object.keys(features)) {
    if (FEATURE_ALLOW.includes(k)) continue;
    if (!argv.some((a, i) => a === "--disable" && argv[i + 1] === k)) return no(`the feature ${k} is not disabled`);
  }
  for (const l of configs(layers)) {
    if (l.problem) return no(l.problem);
    const f = configFacts(l.text);
    if (f.problem) return no(`${l.file}: ${f.problem}`);
    for (const k of f.features) if (!Object.hasOwn(features, k)) return no(`${l.file} sets the feature key ${k.slice(0, 60)}, which is not one of this Codex's own`);
    for (const k of f.legacy) return no(`${l.file} sets the legacy feature toggle ${k}`);
  }
  return ok;
}

// ---- row T: overlap of writable roots and protected locations -----------------------------------

/**
 * The canonical form of a path (C.4 row T): an existing path's realpath; for an absent one, the
 * realpath of its nearest existing ancestor joined with the missing part. {path, missing (the
 * missing components, from the ancestor)}. Throws on anything but "does not exist" (permission
 * denied, a loop, a component that is not a folder).
 */
export function canonical(p, { fsx = fs } = {}) {
  let at = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      fsx.lstatSync(at);
      break;
    } catch (e) {
      if (!ENOENT(e)) throw Object.assign(new Error(`${at} cannot be resolved (${e.code ?? "error"})`), { code: e.code });
      if (at === path.dirname(at)) break;
      rest.unshift(path.basename(at));
      at = path.dirname(at);
    }
  }
  const real = fsx.realpathSync(at);
  if (rest.length && !fsx.statSync(real).isDirectory()) throw Object.assign(new Error(`${at} is not a folder`), { code: "ENOTDIR" });
  return { path: path.join(real, ...rest), missing: rest.length ? { base: real, rest } : null };
}

/** Component-wise "a equal to, inside, or an ancestor of b"; case-insensitive where volumes usually are (macOS). */
export function overlaps(a, b, { fold = process.platform === "darwin" } = {}) {
  const f = (x) => (fold ? x.toLowerCase() : x);
  return insidePath(f(a), f(b)) || insidePath(f(b), f(a));
}

/**
 * Row T: no writable root overlaps a protected location (both canonical). `writable`: the
 * worktree, the per-member TMPDIR (and at recheck what row S reports); `protected`: the main
 * repository and its common git folder, the worktree's gitdir, CODEX_HOME, the hoptell home, the
 * candidate folders outside the worktree. Returns {ok, why} plus `canon` (the canonical paths,
 * for the recheck).
 */
export function rowT({ writable, protected: guarded }, { fsx = fs, fold } = {}) {
  const canon = {};
  const of = (p) => (canon[p] ??= canonical(p, { fsx }));
  for (const w of writable) {
    for (const g of guarded) {
      if (overlaps(of(w).path, of(g).path, fold === undefined ? {} : { fold })) return { ...no(`the writable ${of(w).path} overlaps the protected ${of(g).path}`), canon };
    }
  }
  return { ...ok, canon };
}

/** Row T at recheck: the same check again, and no component missing at launch now exists as a symbolic link. */
export function rowTRecheck(input, launchCanon, opts = {}) {
  const fsx = opts.fsx ?? fs;
  for (const c of Object.values(launchCanon ?? {})) {
    if (!c.missing) continue;
    let at = c.missing.base;
    for (const part of c.missing.rest) {
      at = path.join(at, part);
      let st;
      try {
        st = fsx.lstatSync(at);
      } catch (e) {
        if (ENOENT(e)) break;
        return no(`${at} cannot be resolved (${e.code ?? "error"})`);
      }
      if (st.isSymbolicLink()) return no(`${at}, missing at launch, is now a symbolic link`);
    }
  }
  const r = rowT(input, opts);
  return r.ok ? ok : no(r.why);
}

// ---- row S: the session's own report --------------------------------------------------------------

export const SANDBOX_STATE_CAPABILITY = "codex/sandbox-state";
export const SANDBOX_STATE_ALIAS = "codex/sandbox-state-meta";

/**
 * Row S: the sandbox state Codex reported on the member's first read_task (`report`, the
 * `codex/sandbox-state` value of the call's _meta) shows only the pinned writable roots, no
 * network, and the pinned deny entries. Codex calls that policy opaque, so its reading
 * (`describe(report)` → {writable: [paths], network: bool, deny: [paths]} or null) is fixed by
 * phase C2's tests; without one, nothing passes.
 */
export function rowS(report, { writable, deny = [], describe = null }) {
  if (report == null) return no("Codex sent no sandbox state report before the first git command");
  if (!describe) return no("hoptell has no tested reading of Codex's sandbox state report");
  const d = describe(report);
  if (!d || !Array.isArray(d.writable) || typeof d.network !== "boolean" || !Array.isArray(d.deny)) return no("the sandbox state report has a shape hoptell does not know");
  if (d.network) return no("the reported sandbox allows the network");
  const extra = d.writable.filter((w) => !writable.includes(w));
  if (extra.length) return no(`the reported sandbox can write ${extra[0]}`);
  const lost = deny.filter((x) => !d.deny.includes(x));
  return lost.length ? no(`the reported sandbox does not deny ${lost[0]}`) : ok;
}

// ---- the rechecks before a git command (C.4, C.6) -------------------------------------------------

/** A process's command line: its arguments (Linux, /proc/<pid>/cmdline), or the space-joined line of `ps -ww -o command=` (macOS); null when unreadable. */
export function commandLineOf(pid, { platform = process.platform, fsx = fs, run = spawnSync } = {}) {
  try {
    if (platform === "linux") {
      const raw = fsx.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw ? raw.replace(/\0$/, "").split("\0") : null;
    }
    const r = run("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    return r.status === 0 && r.stdout.trim() ? r.stdout.replace(/\n$/, "") : null;
  } catch {
    return null;
  }
}

const sameCommand = (line, argv) => (Array.isArray(line) ? line.length === argv.length && line.every((x, i) => x === argv[i]) : line === argv.join(" "));

/** The descendants of `pid` in a process table (Map pid → {ppid}), breadth first. */
function descendants(table, pid) {
  const out = [];
  const queue = [pid];
  while (queue.length && out.length < 4096) {
    const p = queue.shift();
    for (const [c, row] of table) if (row.ppid === p && !out.includes(c)) (out.push(c), queue.push(c));
  }
  return out;
}

/** The pane process `root` and its descendants that run exactly `argv`. */
function runningArgv(root, argv, table, commandLine) {
  return [root.pid, ...descendants(table, root.pid)].filter((pid) => {
    const line = commandLine(pid);
    return line && sameCommand(line, argv);
  });
}

/**
 * The member's codex process once it started (C.4, row P), to record with the launch: the one
 * process among its pane's process `root` (still the recorded one) and its descendants that runs
 * exactly the recorded argv, and its identity {pid, start, uid, boot}. {ok, codex} or {why}: none,
 * several, or one whose identity cannot be read.
 */
export function bindCodex({ root, argv }, { table, commandLine = commandLineOf, state, identity }) {
  if (!table) return no("the process table could not be read");
  if (!root || state(root) !== "same") return no("the member's pane process is not the recorded one");
  const found = runningArgv(root, argv, table, commandLine);
  if (found.length !== 1) return no(found.length ? `${found.length} processes of the member run the codex command line` : "no process of the member runs the codex command line");
  const codex = identity(found[0]);
  return codex ? { ok: true, codex } : no(`the identity of process ${found[0]} cannot be read`);
}

/**
 * Row P at recheck: the codex process recorded once the member started (`codex`, bindCodex) is
 * still that process (pid, start, boot), under the recorded pane process `root`, and it is the
 * only one there that runs exactly the recorded argv. {ok, pid} or {why}.
 */
export function rowPLive({ root, argv, codex }, { table, commandLine = commandLineOf, state }) {
  if (!table) return no("the process table could not be read");
  if (!root || state(root) !== "same") return no("the member's pane process is not the recorded one");
  if (!codex) return no("the member's codex process was not recorded when it started");
  if (state(codex) !== "same") return no(`the member's codex process ${codex.pid} is not the recorded one`);
  const found = runningArgv(root, argv, table, commandLine);
  if (!found.includes(codex.pid)) return no(`the member's codex process ${codex.pid} does not run the recorded command line under its pane`);
  if (found.length !== 1) return no(`${found.length} processes of the member run the codex command line`);
  return { ok: true, pid: codex.pid };
}

/**
 * The executable a process runs, from the kernel, not its argv: Linux /proc/<pid>/exe. null when
 * unreadable, and on macOS until a tested reader of a process's executable exists (C2): lsof's
 * txt entries list every mapped file, so none of them is proven to be the executable.
 */
export function executableOf(pid, { platform = process.platform, fsx = fs } = {}) {
  if (platform !== "linux") return null;
  try {
    return fsx.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

/**
 * The sandbox helpers a contained member's codex may run directly, by platform: macOS's
 * /usr/bin/sandbox-exec with a profile (-p). Codex's Linux helper is not tested yet (C2), so on
 * Linux every direct child must be the pinned server.
 */
export const SANDBOX_HELPERS = { darwin: [{ path: "/usr/bin/sandbox-exec", flag: "-p" }], linux: [] };

/**
 * An executable as the launch recorded it: its real path and file identity, or null when
 * unreadable. The identity is the device and inode with the size and the nanosecond change and
 * modification times: a file removed and written again can get its inode back (Linux reuses a
 * freed one at once), so the size and times are compared too. A metadata fingerprint, not a
 * check of the content.
 */
export function fileIdentity(file, { fsx = fs } = {}) {
  try {
    const real = fsx.realpathSync(file);
    const st = fsx.statSync(real, { bigint: true });
    return st.isFile() ? { path: real, dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) } : null;
  } catch {
    return null;
  }
}
const FILE_ID_KEYS = ["path", "dev", "ino", "size", "mtimeNs", "ctimeNs"];
const sameFile = (rec, { fsx }) => {
  const now = fileIdentity(rec.path, { fsx });
  return Boolean(now) && FILE_ID_KEYS.every((k) => typeof rec[k] === "string" && now[k] === rec[k]);
};
const words = (line) => (Array.isArray(line) ? line : line.split(" "));

/**
 * Row X at recheck: every direct child of the member's codex process runs, by its kernel
 * executable, either the pinned hoptell server (the recorded node binary, its arguments) or a
 * recorded sandbox helper (its path, unchanged file, invoked with its flag). A child whose
 * command line or executable cannot be read fails, as does any other.
 */
export function rowXLive({ pid, server, helpers = [] }, { table, commandLine = commandLineOf, executable = executableOf, fsx = fs }) {
  if (!table) return no("the process table could not be read");
  for (const [c, r] of table) {
    if (r.ppid !== pid) continue;
    const line = commandLine(c);
    if (!line) return no(`the command line of process ${c} cannot be read`);
    const exe = executable(c);
    if (!exe) return no(`the executable of process ${c} cannot be read`);
    if (server.exe && exe === server.exe.path && sameFile(server.exe, { fsx }) && sameCommand(line, [server.command, ...server.args])) continue;
    const h = helpers.find((x) => x.path === exe);
    const w = words(line);
    if (h && sameFile(h, { fsx }) && w[0] === h.path && w[1] === h.flag) continue;
    return no(`process ${c} (${path.basename(exe).slice(0, 60)} at ${exe.slice(0, 200)}) runs outside the sandbox under the member's codex`);
  }
  return ok;
}

/** Where a member's pinned server records Codex's sandbox state report (row S). */
export const sandboxReportOf = (home, name) => path.join(home, "sessions", `${name}.sandbox.json`);

/**
 * The rechecks of a contained member before a git command (C.4: P, M1, R, X, T, S), from what
 * its launch recorded (`rec`: {set, argv, candidates, etc, t: {input, canon}, server, writable,
 * deny}) and its pane process `root`. {ok} or {ok: false, why: "row <r>: ..."}.
 */
export function recheckContainment(home, name, root, rec, deps = {}) {
  const fsx = deps.fsx ?? fs;
  const table = deps.table ? deps.table() : null;
  const checks = [
    ["M1", () => rowM1({ etc: rec.etc, fsx })],
    ...(rec.set === "A" ? [["R", () => rowR(rec.candidates, { fsx })]] : []),
    ["T", () => rowTRecheck(rec.t.input, rec.t.canon, { fsx, fold: deps.fold })],
  ];
  for (const [n, fn] of checks) {
    const r = row(fn);
    if (!r.ok) return no(`row ${n}: ${r.why}`);
  }
  const p = row(() => rowPLive({ root, argv: rec.argv, codex: rec.codex }, { table, commandLine: deps.commandLine, state: deps.state }));
  if (!p.ok) return no(`row P: ${p.why}`);
  const x = row(() => rowXLive({ pid: p.pid, server: rec.server, helpers: rec.helpers }, { table, commandLine: deps.commandLine, executable: deps.executable, fsx }));
  if (!x.ok) return no(`row X: ${x.why}`);
  let report = null;
  try {
    report = JSON.parse(fsx.readFileSync(sandboxReportOf(home, name), "utf8")).state ?? null;
  } catch {}
  const sr = row(() => rowS(report, { writable: rec.writable, deny: rec.deny, describe: deps.describe ?? null }));
  return sr.ok ? ok : no(`row S: ${sr.why}`);
}

// ---- the evaluation at launch ---------------------------------------------------------------------

/** The per-member TMPDIR: a fresh 0700 folder under the system temp root (removed at team down). */
export const makeTmpdir = ({ fsx = fs, root = os.tmpdir() } = {}) => fsx.mkdtempSync(path.join(fsx.realpathSync(root), "hoptell-member-"));

/**
 * Whether a Codex implementer's launch counts as contained (C.4): {contained, set, rows: [{row,
 * ok, why}], why (the first failed row, or null), notes}. In production (`full` false) it stops at
 * row V, so a build without a VERIFIED row reads and runs nothing more. `ctx`: {set, version,
 * verified, argv, launch, plan, parts, features, registration, expected, member dir, codexHome,
 * home, writable, protected}; `deps`: the readers of the rows (fsx, osascript, platform, etc).
 */
export function evaluateLaunch(ctx, deps = {}) {
  const rows = [];
  const add = (name, fn) => rows.push({ row: name, ...row(fn) });
  add("V", () => rowV({ set: ctx.set, version: ctx.version, verified: ctx.verified ?? VERIFIED }));
  if (!rows[0].ok && !deps.full) return result(ctx.set, rows, []);
  const fsx = deps.fsx ?? fs;
  const candidates = candidateFolders(ctx.dir, { codexHome: ctx.codexHome, etc: deps.etc ?? "/etc/codex" });
  const layers = readLayers(candidates, { fsx });
  add("P", () => rowP(ctx.argv, { set: ctx.set, registration: ctx.registration, servers: ctx.servers }));
  add("E", () => rowE(ctx.launch, ctx.plan));
  add("M1", () => rowM1({ etc: deps.etc ?? "/etc/codex", fsx }));
  add("M2", () => rowM2({ platform: deps.platform, osascript: deps.osascript }));
  add("M3", () => rowM3({ home: ctx.home, fsx }));
  if (ctx.set === "A") add("R", () => rowR(candidates, { fsx }));
  else add("B", () => rowB(layers));
  add("X", () => rowX(layers, { argv: ctx.argv, registration: ctx.registration, expected: ctx.expected }));
  add("F", () => rowF(layers, { argv: ctx.argv, features: ctx.features }));
  const tInput = { writable: ctx.writable, protected: [...ctx.protected, ...candidates.filter((c) => !insidePath(path.resolve(c), path.resolve(ctx.dir)))] };
  let canon = null;
  add("T", () => {
    const r = rowT(tInput, { fsx, fold: deps.fold });
    canon = r.canon;
    return r.ok ? ok : no(r.why);
  });
  // Row A (the audit of hoptell's own MCP server) is a release gate: until it is done no member counts.
  rows.push({ row: "A", ...(deps.audited ? ok : no("hoptell's MCP server has not been audited for contained members")) });
  const out = result(ctx.set, rows, hooksNotes(layers));
  // What the rechecks before each git command compare with.
  // `codex`: the member's codex process, recorded once it started (bindCodex); null until then.
  if (out.contained) {
    const helpers = (deps.helpers ?? SANDBOX_HELPERS[deps.platform ?? process.platform] ?? []).flatMap((h) => {
      const id = fileIdentity(h.path, { fsx });
      return id && id.path === h.path ? [{ ...id, flag: h.flag }] : [];
    });
    out.recheck = { set: ctx.set, argv: ctx.argv, codex: null, candidates, etc: deps.etc ?? "/etc/codex", t: { input: tInput, canon }, server: { command: ctx.registration.command, args: ctx.registration.args, exe: fileIdentity(ctx.registration.command, { fsx }) }, helpers, writable: ctx.writable, deny: ctx.set === "B" ? ["~/.ssh", "/tmp"] : [] };
  }
  return out;
}

function result(set, rows, notes) {
  const failed = rows.find((r) => !r.ok);
  return { contained: !failed, set, rows: rows.map(({ row: r, ok: o, why }) => ({ row: r, ok: o, why: why ?? null })), why: failed ? `row ${failed.row}: ${failed.why}` : null, notes, recheck: null };
}

/**
 * The containment of a Codex implementer's launch (set B first, as decision CD2 recommends, then
 * set A): row V of each first, and only when one holds, `build(set)` for the full context and the
 * other rows. The record a launch keeps: {contained, set, version, why, at, recheck}.
 */
export function containmentFor({ version, verified = VERIFIED, build, deps = {} }) {
  const at = new Date().toISOString();
  let first = null;
  for (const set of ["B", "A"]) {
    const v = row(() => rowV({ set, version, verified }));
    let r;
    if (!v.ok && !deps.full) r = result(set, [{ row: "V", ...v }], []);
    else {
      try {
        r = evaluateLaunch({ ...build(set), set, version, verified }, deps);
      } catch (e) {
        r = result(set, [{ row: "plan", ...no(`the contained launch could not be built (${e.message})`) }], []);
      }
    }
    if (r.contained) return { contained: true, set, version: version ?? null, why: null, at, recheck: r.recheck };
    first ??= r;
  }
  // Clipped to what a session record holds (lib/worktrees.js), so the record stays readable.
  return { contained: false, set: null, version: version ?? null, why: String(first.why).slice(0, 600), at, recheck: null };
}

/** The status line of a member (C.9): "contained (codex 0.165.0, set B)" or "uncontained: row V (...)". */
export const containmentLine = (c) => (c?.contained ? `contained (codex ${c.version}, set ${c.set})` : `uncontained${c?.why ? `: ${c.why}` : ""}`);
