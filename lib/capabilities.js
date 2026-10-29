// Capability discovery (design 8, topic 0): what each agent CLI on this machine offers (flags,
// enum values, models and their efforts), so a launch can be checked against it, and what changed
// when a CLI updated. Availability only: what a mechanism *does* comes from the shipped verified
// table (VERIFIED), written from hoptell's own tests.
//
//   capabilities(cli, opts)   the record of the CLI on PATH: probe part cached per binary digest,
//                             model lists re-read from the CLIs' own caches; keeps the previous
//                             record when the fingerprint changes (diffRecords)
//   cliFlags(cli, req, rec)   the model and effort arguments of a launch, with warnings (advisory
//                             data never refuses) or a refusal (an agy effort without a model id)
//   resolveLaunch(...)        a role preset (presets/roles.json, the owner's override) plus the
//                             request, in one precedence rule: request > owner > shipped > CLI
//
// The probe contract: a probe is a fixed entry of PROBES, never `-p`, `exec` or a prompt. Each runs
// in a fresh empty folder with PATH and LANG only, and HOME and CODEX_HOME set to fresh empty
// folders, so no configuration, project file, hook or plugin of the user's loads. The user's real
// home is only read, as files: Codex's models_cache.json and Claude Code's model catalog cache.
// `agy models` needs the real login and is not run.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, ensurePrivateDir } from "./config.js";
import { writeRecord } from "./locks.js";
import { cliDigest, nativeBinary, resolveCommand } from "./agentadapters.js";

export const CAPABILITY_CLIS = ["codex", "claude", "agy"];
export const ROLES = ["reviewer", "implementer", "lead"];
const RECORD_VERSION = 1;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const EFFORT_RE = /^[a-z]{1,16}$/;
const PROBE_MS = 15_000;
const OUTPUT_MAX = 16 * 1024 * 1024;
const CACHE_MAX = 8 * 1024 * 1024;

/**
 * The probes, per CLI: help texts, Codex's feature list and bundled model list, agy's changelog.
 * `--version` is read the same way (no configuration is needed for it). Nothing else is ever run.
 */
export const PROBES = {
  codex: [
    { id: "version", args: ["--version"] },
    { id: "help", args: ["--help"] },
    { id: "features", args: ["features", "list"] },
    { id: "bundled", args: ["debug", "models", "--bundled"] },
  ],
  claude: [
    { id: "version", args: ["--version"] },
    { id: "help", args: ["--help"] },
  ],
  agy: [
    { id: "version", args: ["--version"] },
    { id: "help", args: ["--help"] },
    { id: "changelog", args: ["changelog"] },
  ],
};

/**
 * What hoptell's own tests established, per CLI, mechanism and tested version range (inclusive).
 * Separate from availability: a flag in --help is "available, unverified" until a row here names
 * it. `class`: contained (an OS sandbox held in hoptell's test), policy-limited (the CLI's own
 * rules only, not an OS sandbox), not-confining (a test showed it does not hold), applied (the
 * setting takes effect).
 */
export const VERIFIED = [
  { cli: "codex", mechanism: "-s read-only", class: "contained", min: "0.164.0", max: "0.164.0", checked: "2026-10-27", evidence: "hoptell's adapter gates (test/real-cli/gate-record.json, gate25): writes and network denied" },
  { cli: "codex", mechanism: "-c developer_instructions", class: "applied", min: "0.164.0", max: "0.164.0", checked: "2026-10-27", evidence: "codex debug prompt-input shows the text (design 8)" },
  { cli: "claude", mechanism: "--permission-mode plan", class: "policy-limited", min: "2.1.296", max: "2.1.311", checked: "2026-10-27", evidence: "Claude Code's own permission rules; no OS sandbox (design 8)" },
  { cli: "agy", mechanism: "--mode plan", class: "policy-limited", min: "1.4.8", max: "1.4.8", checked: "2026-10-27", evidence: "with --sandbox --dangerously-skip-permissions it executed none of six requested actions, but plan mode is a rule of agy's, not an OS sandbox (design 8, owner decisions)" },
  { cli: "agy", mechanism: "--sandbox", class: "not-confining", min: "1.4.8", max: "1.4.8", checked: "2026-10-27", evidence: "in accept-edits mode, file and shell writes outside the workspace and network access were allowed (design 8, owner decisions)" },
];

/** How a launch warning words the weaker classes of VERIFIED. */
const CLASS_TEXT = { "policy-limited": "policy-limited (the CLI's own rules, not an OS sandbox)", "not-confining": "does not confine writes or network access (hoptell's test)" };

/** Roles hoptell does not offer for a CLI, with the reason (not a preset an override can add). */
export const NOT_OFFERED = {
  agy: { implementer: "agy implementers are not offered: agy's --sandbox did not keep writes in the workspace or block the network in hoptell's test (agy 1.4.8, 2026-10-27)" },
};

/** A version's numeric part and its pre-release suffix ("0.164.0-alpha.1": [0, 164, 0], "-alpha.1"). */
const splitVersion = (v) => {
  const m = String(v).match(/^(\d+(?:\.\d+)*)(.*)$/);
  return m ? { nums: m[1].split(".").map(Number), suffix: m[2] } : { nums: [], suffix: String(v) };
};

/**
 * Compare two dotted versions numerically: -1, 0 or 1. A pre-release (any suffix) sorts before the
 * release it precedes, as in semver; two suffixes of one release compare as text.
 */
export function compareVersions(a, b) {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.suffix === pb.suffix) return 0;
  if (!pa.suffix || !pb.suffix) return pa.suffix ? -1 : 1;
  return pa.suffix < pb.suffix ? -1 : 1;
}

/**
 * The rows of VERIFIED for a CLI, each with `holds`: true when `version` is a release inside its
 * tested range. A pre-release (alpha, preview, ...) is a build of its own: it holds only when it is
 * exactly a tested end of the range, never because a release near it was tested.
 */
export function verifiedFor(cli, version) {
  const pre = Boolean(version) && splitVersion(version).suffix !== "";
  const holds = (r) => Boolean(version) && (pre ? version === r.min || version === r.max : compareVersions(version, r.min) >= 0 && compareVersions(version, r.max) <= 0);
  return VERIFIED.filter((r) => r.cli === cli).map((r) => ({ ...r, holds: holds(r) }));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// --- Probes -----------------------------------------------------------------------------------

/**
 * Run one probe of PROBES (an entry of the table, nothing else) under the contract: a fresh empty
 * working folder, HOME and CODEX_HOME, PATH and LANG only. {text} or {problem}. `run` (tests):
 * (command, args, {env, cwd}) => {stdout, stderr, status, error}.
 */
export function runProbe(cli, probe, command, { pathVar = "", lang, run = defaultRun, tmpdir = os.tmpdir() } = {}) {
  if (!PROBES[cli]?.includes(probe)) throw new Error(`not a probe of ${cli}`);
  const what = [path.basename(command), ...probe.args].join(" ");
  // The folders cannot be made (no temporary folder, a full disk): the probe is not run, never
  // run in a folder of the user's.
  let root;
  try {
    root = fs.mkdtempSync(path.join(tmpdir, "hoptell-probe-"));
  } catch (e) {
    return { problem: `${what} was not run: no empty temporary folder (${e.code ?? e.message})` };
  }
  try {
    const dirs = {};
    try {
      for (const d of ["cwd", "home", "codex-home"]) dirs[d] = fs.mkdtempSync(path.join(root, `${d}-`));
    } catch (e) {
      return { problem: `${what} was not run: no empty temporary folder (${e.code ?? e.message})` };
    }
    const env = { PATH: pathVar, ...(lang ? { LANG: lang } : {}), HOME: dirs.home, CODEX_HOME: dirs["codex-home"] };
    const r = run(command, [...probe.args], { env, cwd: dirs.cwd });
    if (r.error) return { problem: `${what} failed (${r.error.code ?? r.error.message})` };
    // Some CLIs print their help on standard error.
    const text = String(r.stdout ?? "").trim() ? String(r.stdout) : String(r.stderr ?? "");
    if (!text.trim()) return { problem: `${what} printed nothing (exit ${r.status})` };
    return { text };
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // a leftover empty temporary folder; the probe's result stands
    }
  }
}

function defaultRun(command, args, { env, cwd }) {
  return spawnSync(command, args, { env, cwd, encoding: "utf8", timeout: PROBE_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], maxBuffer: OUTPUT_MAX });
}

// --- Parsers ----------------------------------------------------------------------------------

// An option line starts with at most 8 spaces and a dash (as in agentadapters.js).
const OPTION_LINE = /^ {0,8}-{1,2}[A-Za-z]/;

/** The option tokens of a help text (`-m`, `--model`), from the option part of each option line. */
export function parseOptions(help) {
  const out = new Set();
  for (const line of String(help).split("\n")) {
    if (!OPTION_LINE.test(line)) continue;
    const head = line.trim().split(/\s{2,}/)[0];
    for (const m of head.matchAll(/(?:^|[\s,])(--?[A-Za-z][\w-]*)/g)) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * The values a flag's help block lists: `[possible values: a, b]` and `- a: ...` lists (Codex),
 * `(choices: "a", "b")` and `(a, b)` (Claude Code), `(a, b)` and `(a|b)` (agy). [] when none.
 */
export function parseValues(help, flag) {
  const lines = String(help).split("\n");
  const re = new RegExp(`(^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s,=<\\[]|$)`);
  const at = lines.findIndex((l) => OPTION_LINE.test(l) && re.test(l.trim().split(/\s{2,}/)[0]));
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && OPTION_LINE.test(l));
  const block = lines.slice(at, end < 0 ? undefined : end).join("\n");
  const word = /^[A-Za-z][\w.-]*$/;
  let m = block.match(/\[possible values:\s*([^\]]+)\]/);
  if (m) return m[1].split(",").map((s) => s.trim()).filter((s) => word.test(s));
  if (/Possible values:/.test(block)) return [...block.matchAll(/^\s*-\s+([A-Za-z][\w.-]*):/gm)].map((x) => x[1]);
  m = block.match(/\(choices:\s*([^)]*)\)/);
  if (m) return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const groups = [...block.replace(/\s+/g, " ").matchAll(/\(([^()]*)\)/g)].map((x) => x[1]).filter((g) => /[,|]/.test(g));
  for (const g of groups.reverse()) {
    const vals = g.split(/[,|]/).map((s) => s.trim());
    if (vals.every((v) => word.test(v))) return vals;
  }
  return [];
}

/** The model aliases a `--model` help block names in quotes ('fable', 'opus'). */
export function parseAliases(help) {
  const lines = String(help).split("\n");
  const at = lines.findIndex((l) => OPTION_LINE.test(l) && /(^|[\s,])--model(?=[\s,=<]|$)/.test(l));
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && OPTION_LINE.test(l));
  return [...lines.slice(at, end < 0 ? undefined : end).join(" ").matchAll(/'([a-z][\w.-]*)'/g)].map((x) => x[1]);
}

export const parseVersion = (text) => (String(text).match(/\d+\.\d+\.\d+[\w.-]*/) ?? [null])[0];

/** Codex's feature table: {features: {name: {stage, enabled}}, unreadable: number of other lines}. */
export function parseFeatures(text) {
  const features = {};
  let unreadable = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)\s*$/);
    if (m) features[m[1]] = { stage: m[2], enabled: m[3] === "true" };
    else unreadable++;
  }
  return { features, unreadable };
}

/** agy's changelog headings ("1.4.7:"), newest first, at most 20. */
export const parseChangelog = (text) => [...String(text).matchAll(/^(\d+\.\d+\.\d+[\w.-]*):\s*$/gm)].map((m) => m[1]).slice(0, 20);

/**
 * A Codex model list (`codex debug models` or models_cache.json): only id, efforts, default effort
 * and whether it is hidden. null when the shape is not the known one (a warning, never a guess).
 */
export function codexModels(doc) {
  if (!doc || !Array.isArray(doc.models)) return null;
  const out = [];
  for (const m of doc.models) {
    if (!m || typeof m.slug !== "string" || !MODEL_RE.test(m.slug)) return null;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => l?.effort).filter((e) => typeof e === "string" && EFFORT_RE.test(e)) : [];
    out.push({ id: m.slug, aliases: [], efforts: levels, default_effort: typeof m.default_reasoning_level === "string" && EFFORT_RE.test(m.default_reasoning_level) ? m.default_reasoning_level : null, hidden: m.visibility !== "list" });
  }
  return out;
}

/** Read a bounded regular file (no symbolic link): its text, or null. */
function readSmall(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > CACHE_MAX) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Codex's own cache of the account's model list ($CODEX_HOME/models_cache.json): the models, its
 * fetched_at and client_version. The account hash, etag and every other field are dropped.
 * {models} | {missing} | {problem}.
 */
export function readCodexCache(codexHome) {
  const file = path.join(codexHome, "models_cache.json");
  const text = readSmall(file);
  if (text === null) return { missing: true };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { problem: "Codex's models_cache.json cannot be read (not JSON)" };
  }
  const models = codexModels(doc);
  if (!models) return { problem: "Codex's models_cache.json has an unknown shape" };
  return {
    models: { source: "$CODEX_HOME/models_cache.json", label: "account, as cached", fetched_at: typeof doc.fetched_at === "string" && !Number.isNaN(Date.parse(doc.fetched_at)) ? new Date(doc.fetched_at).toISOString() : null, client_version: typeof doc.client_version === "string" ? parseVersion(doc.client_version) : null, account: "not verified", list: models },
  };
}

const CATALOG_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]+)-cc\.json$/i;

/**
 * Claude Code's model catalog cache (~/.claude/cache/model-catalog/<org>-<hash>-cc.json), used only
 * when exactly one organisation's files are there (several accounts: which one applies cannot be
 * told without running the CLI in the real home). The newest file of that organisation by its
 * fetchedAt; ids, aliases, efforts, default effort and minimum version only. The format is internal
 * to Claude Code. {models} | {missing} | {problem}.
 */
export function readClaudeCatalog(homedir) {
  const dir = path.join(homedir, ".claude", "cache", "model-catalog");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => CATALOG_FILE.test(n));
  } catch {
    return { missing: true };
  }
  if (!names.length) return { missing: true };
  const orgs = new Set(names.map((n) => n.match(CATALOG_FILE)[1].toLowerCase()));
  if (orgs.size > 1) return { problem: `Claude Code's model catalog cache holds ${orgs.size} accounts; which one applies is unknown` };
  let best = null;
  for (const n of names) {
    const text = readSmall(path.join(dir, n));
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {}
    // A time a Date cannot hold (1e20) is not a fetch time: the file is skipped.
    if (doc && Number.isFinite(doc.fetchedAt) && !Number.isNaN(new Date(doc.fetchedAt).getTime()) && (!best || doc.fetchedAt > best.fetchedAt)) best = doc;
  }
  const config = best?.catalog?.config;
  if (!config || !Array.isArray(config.models)) return { problem: "Claude Code's model catalog cache has an unknown shape" };
  const targets = config.provider_alias_targets && typeof config.provider_alias_targets === "object" ? config.provider_alias_targets : {};
  const list = [];
  for (const m of config.models) {
    if (!m || typeof m.id !== "string" || !MODEL_RE.test(m.id)) return { problem: "Claude Code's model catalog cache has an unknown shape" };
    const rt = m.runtime ?? {};
    list.push({
      id: m.id,
      aliases: Object.entries(targets).filter(([a, t]) => /^[a-z][\w-]{0,31}$/.test(a) && t?.default === m.id).map(([a]) => a),
      efforts: Array.isArray(rt.effort_levels) ? rt.effort_levels.filter((e) => typeof e === "string" && EFFORT_RE.test(e)) : [],
      default_effort: typeof rt.default_effort === "string" && EFFORT_RE.test(rt.default_effort) ? rt.default_effort : null,
      hidden: m.section !== "main",
      ...(typeof m.min_claude_code_version === "string" && parseVersion(m.min_claude_code_version) ? { min_version: parseVersion(m.min_claude_code_version) } : {}),
    });
  }
  return { models: { source: "~/.claude/cache/model-catalog", label: "account, as cached", fetched_at: new Date(best.fetchedAt).toISOString(), account: "not verified", list } };
}

// --- The record -------------------------------------------------------------------------------

/** An advisory read that throws on data it did not foresee: {problem} instead. */
function guarded(read, what) {
  try {
    return read();
  } catch (e) {
    return { problem: `${what} cannot be read (${e.code ?? e.message})` };
  }
}

/** The capability folder of a hoptell home. */
export const capabilitiesDir = (home) => path.join(home, "capabilities");

/**
 * The SHA-256 of a file, cached in <home>/capabilities/digests.json by path, size, inode, mtime
 * and ctime (as nativeDigest does), so a launch hashes a large binary once.
 */
function digestOf(home, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return { problem: `${file} cannot be read: ${e.code ?? e.message}` };
  }
  const key = `${file}:${st.size}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}`;
  const cacheFile = path.join(capabilitiesDir(home), "digests.json");
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) ?? {};
  } catch {}
  if (/^[0-9a-f]{64}$/.test(cache[key] ?? "")) return { digest: cache[key] };
  const d = cliDigest(file);
  if (d.problem) return d;
  cache = Object.fromEntries(Object.entries(cache).slice(-15));
  cache[key] = d.digest;
  try {
    writeRecord(cacheFile, cache);
  } catch {
    // a cache only
  }
  return d;
}

/**
 * The identity of the CLI binary `command` starts: the launcher's digest and the native binary's
 * (the same file except for Codex's npm launcher; null when a launcher script has none next to
 * it), as the adapter gates identify a binary.
 */
export function binaryIdentity(home, cli, command) {
  let real;
  try {
    real = fs.realpathSync(command);
  } catch (e) {
    return { problem: `${command} cannot be read: ${e.code ?? e.message}` };
  }
  const launcher = digestOf(home, real);
  if (launcher.problem) return launcher;
  // A launcher script whose native binary cannot be found (not an npm install): the launcher alone.
  const n = nativeBinary(cli, command);
  const native = n.problem ? { digest: null } : n.path === real ? launcher : digestOf(home, n.path);
  if (native.problem) return native;
  return { launcher: launcher.digest, native: native.digest, key: sha256(`${cli}:${launcher.digest}:${native.digest ?? "none"}`).slice(0, 32) };
}

/** Probe a CLI and keep only the listed fields: the probe part of the record. */
function probeCli(cli, command, opts) {
  const out = { probed_at: new Date(opts.now()).toISOString(), problems: [] };
  const texts = {};
  for (const probe of PROBES[cli]) {
    const r = runProbe(cli, probe, command, opts);
    if (r.problem) out.problems.push(r.problem);
    else texts[probe.id] = r.text;
  }
  out.version = texts.version ? parseVersion(texts.version) : null;
  out.help_sha256 = texts.help ? sha256(texts.help) : null;
  out.flags = texts.help ? parseOptions(texts.help) : null;
  if (texts.help && !out.flags.length) out.problems.push(`${cli} --help lists no options hoptell can read`);
  const enums = {};
  const want = { codex: { sandbox: "--sandbox", approval: "--ask-for-approval" }, claude: { permission_mode: "--permission-mode", effort: "--effort" }, agy: { mode: "--mode", effort: "--effort" } }[cli];
  for (const [k, flag] of Object.entries(want)) enums[k] = texts.help ? parseValues(texts.help, flag) : [];
  out.enums = enums;
  if (cli === "claude") out.aliases = texts.help ? parseAliases(texts.help) : [];
  if (cli === "codex") {
    if (texts.features) {
      const f = parseFeatures(texts.features);
      out.features = f.features;
      if (f.unreadable) out.problems.push(`codex features list has ${f.unreadable} line(s) hoptell cannot read`);
    }
    if (texts.bundled) {
      let list = null;
      try {
        list = codexModels(JSON.parse(texts.bundled));
      } catch {}
      if (list) out.bundled = { source: "codex debug models --bundled", label: "bundled with this binary", account: "not account data", list };
      else out.problems.push("codex debug models --bundled has an unknown shape");
    }
  }
  if (cli === "agy" && texts.changelog) out.changelog = parseChangelog(texts.changelog);
  return out;
}

/** The ids, aliases and efforts of the record's model lists, for the fingerprint and the diff. */
const modelSummary = (rec) => ["account", "bundled"].map((k) => (rec[k]?.list ?? []).map((m) => [m.id, [...m.aliases].sort(), [...m.efforts].sort()]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/** version + hash of --help + hash of the model lists. */
export const fingerprintOf = (rec) => sha256(JSON.stringify([rec.version ?? null, rec.help_sha256 ?? null, sha256(JSON.stringify(modelSummary(rec)))]));

const readJson = (file) => {
  const t = readSmall(file);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/**
 * The capability record of `cli`: {record, changes} where `changes` lists what differs from the
 * last stored record (null when nothing did or there was none). `opts`: {home, pathVar, homedir,
 * codexHome, lang, refresh, store (default true), probe (default true; false: a binary without a
 * cached probe part gives {unprobed: true} instead of running it), run, now, tmpdir}. The probe
 * part is cached per binary identity (<home>/capabilities/<cli>/probe-<key>.json) and redone with
 * `refresh`; model lists are read from the CLIs' caches every time. A changed fingerprint moves the
 * stored record to previous.json.
 */
export function capabilities(cli, opts) {
  if (!CAPABILITY_CLIS.includes(cli)) throw new Error(`no capability probes for "${cli}" (${CAPABILITY_CLIS.join(", ")})`);
  const { home, pathVar = "", homedir, codexHome, refresh = false, store = true, probe: mayProbe = true } = opts;
  const now = opts.now ?? Date.now;
  const record = { record_version: RECORD_VERSION, cli, present: false, warnings: [] };
  const cmd = resolveCommand({ cli }, { pathVar });
  if (cmd.code) {
    record.warnings.push(`${cli} was not found on PATH`);
    return { record, changes: null };
  }
  record.present = true;
  record.command = cmd.command;
  const id = binaryIdentity(home, cli, cmd.command);
  if (id.problem) {
    record.warnings.push(`the ${cli} binary cannot be identified (${id.problem}); its capabilities are unknown`);
    return { record, changes: null };
  }
  record.binary = { launcher: id.launcher, native: id.native };
  const dir = path.join(capabilitiesDir(home), cli);
  const probeFile = path.join(dir, `probe-${id.key}.json`);
  let probe = refresh ? null : readJson(probeFile);
  if ((!probe || probe.record_version !== RECORD_VERSION) && !mayProbe) return { record, changes: null, unprobed: true };
  if (!probe || probe.record_version !== RECORD_VERSION) {
    try {
      probe = { record_version: RECORD_VERSION, ...probeCli(cli, cmd.command, { ...opts, now }) };
    } catch (e) {
      record.warnings.push(`the probes of ${cli} failed (${e.code ?? e.message}); its flags and version are unknown`);
      return { record, changes: null };
    }
    if (store) {
      try {
        ensurePrivateDir(dir);
        writeRecord(probeFile, probe);
        // Keep the newest few probe records of this CLI.
        const old = fs.readdirSync(dir).filter((n) => /^probe-[0-9a-f]{32}\.json$/.test(n)).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(4);
        for (const o of old) fs.rmSync(path.join(dir, o.n), { force: true });
      } catch {
        // a cache only
      }
    }
  }
  const { problems = [], ...fields } = probe;
  Object.assign(record, fields, { record_version: RECORD_VERSION });
  for (const p of problems) record.warnings.push(`${p}; that part is unknown`);
  if (!record.version) record.warnings.push(`the version of ${cli} is unknown`);
  // Model lists: advisory, with their provenance. agy's needs its real login: not read.
  if (cli === "codex") {
    const c = guarded(() => readCodexCache(codexHome ?? path.join(homedir, ".codex")), "Codex's models_cache.json");
    if (c.models) record.account = c.models;
    else if (c.problem) record.warnings.push(`${c.problem}; the account's models are unknown`);
  } else if (cli === "claude") {
    const c = guarded(() => readClaudeCatalog(homedir), "Claude Code's model catalog cache");
    if (c.models) record.account = c.models;
    else if (c.problem) record.warnings.push(`${c.problem}; models and efforts are unknown`);
  }
  if (cli === "agy") record.models_note = "not read: agy models needs your login; run it yourself and name the complete model id";
  record.default_model = "unknown";
  record.fingerprint = fingerprintOf(record);
  // The stored record and its predecessor.
  const curFile = path.join(dir, "current.json");
  const prevFile = path.join(dir, "previous.json");
  const cur = readJson(curFile);
  const today = new Date(now()).toISOString().slice(0, 10);
  record.version_first_seen = cur?.version && cur.version === record.version && cur.version_first_seen ? cur.version_first_seen : today;
  let changes = null;
  if (cur?.fingerprint && cur.fingerprint !== record.fingerprint) changes = diffRecords(cur, record);
  if (store && (!cur || cur.fingerprint !== record.fingerprint || cur.version_first_seen !== record.version_first_seen)) {
    try {
      ensurePrivateDir(dir);
      if (changes) writeRecord(prevFile, cur);
      writeRecord(curFile, { ...record, recorded_at: new Date(now()).toISOString() });
    } catch {
      // the record is still returned; only the change notice is lost
    }
  }
  return { record, changes };
}

/**
 * capabilities(), never throwing: any failure it did not foresee (the hoptell home, the temporary
 * folder) gives a record whose parts are unknown, with a warning. A launch then keeps its preset's
 * flags unchanged.
 */
export function safeCapabilities(cli, opts) {
  try {
    return capabilities(cli, opts);
  } catch (e) {
    return { record: { record_version: RECORD_VERSION, cli, present: null, warnings: [`the capabilities of ${cli} are unknown (${e.code ?? e.message})`] }, changes: null };
  }
}

/** The stored record of a CLI and its predecessor ({current, previous}, each or null). */
export function storedRecords(home, cli) {
  const dir = path.join(capabilitiesDir(home), cli);
  return { current: readJson(path.join(dir, "current.json")), previous: readJson(path.join(dir, "previous.json")) };
}

/** What differs between two records, one line per change. */
export function diffRecords(a, b) {
  const out = [];
  if ((a.version ?? null) !== (b.version ?? null)) out.push(`version ${a.version ?? "unknown"} -> ${b.version ?? "unknown"}`);
  const set = (x) => new Set(x ?? []);
  const delta = (what, x, y) => {
    const added = [...set(y)].filter((v) => !set(x).has(v));
    const removed = [...set(x)].filter((v) => !set(y).has(v));
    if (added.length) out.push(`${what} added: ${added.join(", ")}`);
    if (removed.length) out.push(`${what} removed: ${removed.join(", ")}`);
  };
  if (a.help_sha256 !== b.help_sha256) {
    if (a.flags && b.flags) delta("flags", a.flags, b.flags);
    if (!out.some((l) => l.startsWith("flags"))) out.push("help text changed");
  }
  for (const k of new Set([...Object.keys(a.enums ?? {}), ...Object.keys(b.enums ?? {})])) delta(`${k} values`, a.enums?.[k], b.enums?.[k]);
  delta("model aliases in --help", a.aliases, b.aliases);
  for (const k of ["account", "bundled"]) {
    const ma = new Map((a[k]?.list ?? []).map((m) => [m.id, m]));
    const mb = new Map((b[k]?.list ?? []).map((m) => [m.id, m]));
    const label = k === "account" ? "models (account, as cached)" : "models (bundled)";
    delta(label, [...ma.keys()], [...mb.keys()]);
    for (const [idm, m] of mb) {
      const o = ma.get(idm);
      if (!o) continue;
      if ([...o.efforts].sort().join() !== [...m.efforts].sort().join()) out.push(`${idm} efforts: ${o.efforts.join(", ") || "none"} -> ${m.efforts.join(", ") || "none"}`);
      if ([...o.aliases].sort().join() !== [...m.aliases].sort().join()) out.push(`${idm} aliases: ${o.aliases.join(", ") || "none"} -> ${m.aliases.join(", ") || "none"}`);
    }
  }
  if (a.features && b.features) {
    for (const [n, f] of Object.entries(b.features)) {
      const o = a.features[n];
      if (!o) out.push(`feature ${n} added (${f.stage}, ${f.enabled ? "on" : "off"})`);
      else if (o.stage !== f.stage || o.enabled !== f.enabled) out.push(`feature ${n}: ${o.stage}, ${o.enabled ? "on" : "off"} -> ${f.stage}, ${f.enabled ? "on" : "off"}`);
    }
    for (const n of Object.keys(a.features)) if (!b.features[n]) out.push(`feature ${n} removed`);
  }
  const news = (b.changelog ?? []).filter((h) => !(a.changelog ?? []).includes(h));
  if (news.length) out.push(`changelog: ${news.join(", ")}`);
  return out.length ? out : ["the fingerprint changed"];
}

/** "3 h ago", "12 days ago": the age of a cached list. */
export function ageOf(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "age unknown";
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

// --- Flags and launch validation --------------------------------------------------------------

const toml = (s) => JSON.stringify(String(s));

/**
 * The model and effort arguments of a CLI, unchecked: Codex `-m` and `-c model_reasoning_effort=`
 * (TOML-quoted, so a value cannot add another key), Claude Code `--model` and `--effort`, agy and
 * Gemini `--model` / `-m` only. The adapters of spawned agents use the same slots.
 */
export function modelEffortArgs(cli, { model, effort } = {}) {
  switch (cli) {
    case "codex":
      return [...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort=${toml(effort)}`] : [])];
    case "claude":
      return [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
    case "gemini":
      return model ? ["-m", model] : [];
    default:
      return model ? ["--model", model] : [];
  }
}

/** The hint of an agy effort without a complete model id. */
export const AGY_EFFORT_HINT = "agy takes its effort in the model id: give the complete model id, for example gemini-4-argon-high";

/**
 * The model and effort arguments of an interactive launch, checked against the record:
 * {args, warnings} or {refused}. Advisory data (cached lists) only warns, with its age; the CLI has
 * the last word. Refused: a value that is not a model name or effort word, and an agy effort (agy
 * encodes effort in the model id; hoptell never passes --effort to agy).
 */
export function cliFlags(cli, { model = null, effort = null } = {}, record = null, { now = Date.now() } = {}) {
  if (model != null && !(typeof model === "string" && MODEL_RE.test(model))) return { refused: "the model must be a model name (letters, digits, . _ : / -)" };
  if (effort != null && !(typeof effort === "string" && EFFORT_RE.test(effort))) return { refused: "the effort must be one lowercase word, such as high" };
  if (cli === "agy" && effort) return { refused: AGY_EFFORT_HINT };
  const warnings = [];
  const args = modelEffortArgs(cli, { model, effort });
  const lists = [record?.account, record?.bundled].filter(Boolean);
  const provenance = (l) => (l === record?.bundled ? "the list bundled with this binary" : `the cached account list (fetched ${l.fetched_at ? ageOf(l.fetched_at, now) : "at an unknown time"}, account not verified)`);
  if (cli === "agy") {
    if (model) warnings.push(`${model} is passed to agy unchanged; hoptell does not read agy's model list (run agy models to see yours)`);
    return { args, warnings };
  }
  if (!model) {
    if (effort) warnings.push(`effort ${effort} unchecked (model from your CLI settings)`);
  } else if (!lists.length) {
    warnings.push(`model ${model}${effort ? ` and effort ${effort}` : ""} unchecked: ${cli === "claude" ? "Claude Code's model catalog cache is unknown here" : "no model list was read"}`);
  } else {
    let found = null;
    for (const l of lists) {
      const m = l.list.find((x) => x.id === model || x.aliases.includes(model));
      if (m && !found) found = { m, l };
    }
    if (!found) warnings.push(`model ${model} is not in ${lists.map(provenance).join(" or ")}; the CLI decides`);
    else {
      if (found.l !== lists[0]) warnings.push(`model ${model} is not in ${provenance(lists[0])}, only in ${provenance(found.l)}`);
      if (effort && found.m.efforts.length && !found.m.efforts.includes(effort)) warnings.push(`model ${found.m.id} offers efforts ${found.m.efforts.join(", ")}, not ${effort}, in ${provenance(found.l)}; the CLI decides`);
      if (effort && !found.m.efforts.length) warnings.push(`model ${found.m.id} offers no effort levels in ${provenance(found.l)}; effort ${effort} unchecked`);
      if (found.m.min_version && record?.version && compareVersions(record.version, found.m.min_version) < 0) warnings.push(`model ${found.m.id} needs ${cli} ${found.m.min_version} or newer; this is ${record.version}`);
    }
  }
  if (effort && cli === "claude" && record?.enums?.effort?.length && !record.enums.effort.includes(effort)) warnings.push(`claude --help lists efforts ${record.enums.effort.join(", ")}, not ${effort}`);
  return { args, warnings };
}

// --- Presets ----------------------------------------------------------------------------------

/** The shipped role presets (presets/roles.json in the package). */
export const SHIPPED_PRESETS = path.join(ROOT, "presets", "roles.json");

/** The problems of one preset entry (shipped or the owner's). */
function presetProblems(e) {
  const p = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["not an object"];
  for (const k of Object.keys(e)) if (!["flags", "effort", "model", "source", "checked", "min_version", "note"].includes(k)) p.push(`unknown field "${String(k).slice(0, 40)}"`);
  if (e.flags !== undefined && !(Array.isArray(e.flags) && e.flags.length <= 32 && e.flags.every((f) => typeof f === "string" && f.length > 0 && f.length <= 200 && !/[\0\n]/.test(f)))) p.push("flags must be a list of at most 32 arguments");
  if (e.effort !== undefined && !(typeof e.effort === "string" && EFFORT_RE.test(e.effort))) p.push("effort must be one lowercase word");
  if (e.model !== undefined && !(typeof e.model === "string" && MODEL_RE.test(e.model))) p.push("model must be a model alias");
  if (e.source !== undefined && !(typeof e.source === "string" && /^https:\/\/\S+$/.test(e.source))) p.push("source must be an https URL");
  if (e.checked !== undefined && !(typeof e.checked === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.checked))) p.push("checked must be a date (YYYY-MM-DD)");
  if (e.min_version !== undefined && !(typeof e.min_version === "string" && parseVersion(e.min_version) === e.min_version)) p.push("min_version must be a version such as 1.4.8");
  return p;
}

/**
 * The role presets: shipped, then the owner's override (<home>/presets/roles.json) field by field
 * per CLI and role. {presets: {cli: {role: entry with `from`}}, warnings}. An override entry with
 * a problem is left out with a warning (the shipped entry stays).
 */
export function loadPresets(home, { shipped = SHIPPED_PRESETS } = {}) {
  const warnings = [];
  const presets = {};
  const merge = (doc, from) => {
    if (!doc || typeof doc !== "object" || !doc.presets || typeof doc.presets !== "object") return warnings.push(`${from} presets: not a presets file ({"version": 1, "presets": {...}})`);
    for (const [cli, roles] of Object.entries(doc.presets)) {
      if (!CAPABILITY_CLIS.includes(cli) || !roles || typeof roles !== "object") {
        warnings.push(`${from} presets: unknown CLI "${String(cli).slice(0, 40)}"`);
        continue;
      }
      for (const [role, e] of Object.entries(roles)) {
        if (!ROLES.includes(role)) {
          warnings.push(`${from} presets: unknown role "${String(role).slice(0, 40)}" for ${cli}`);
          continue;
        }
        const p = presetProblems(e);
        if (p.length) {
          warnings.push(`${from} preset ${cli} ${role} left out: ${p.join("; ")}`);
          continue;
        }
        presets[cli] ??= {};
        presets[cli][role] = { ...(presets[cli][role] ?? {}), ...e, from };
      }
    }
  };
  const s = readJson(shipped);
  if (!s) throw new Error(`the shipped presets ${shipped} cannot be read`);
  merge(s, "shipped");
  const ownFile = path.join(home, "presets", "roles.json");
  if (fs.existsSync(ownFile)) {
    const own = readJson(ownFile);
    if (!own) warnings.push(`${ownFile} cannot be read (not JSON); the shipped presets apply`);
    else merge(own, "your");
  }
  return { presets, warnings };
}

/** Option tokens of an argument list (`--mode`, `-s`), for the availability check. */
const optionTokens = (args) => args.filter((a) => /^--?[A-Za-z][\w-]*$/.test(a));

/**
 * The flags of an interactive launch of `cli` as `role`: the preset's safety flags, then the model
 * and effort, in one precedence rule: the request > the owner's preset > the shipped preset > the
 * CLI's own configuration. {args, warnings, model, effort, preset} or {refused}. Unknown or
 * advisory data only warns; the preset's safety flags are always passed as they are.
 */
export function resolveLaunch(cli, role, request = {}, { record = null, presets, now = Date.now() } = {}) {
  if (!CAPABILITY_CLIS.includes(cli)) return { refused: `unknown CLI "${String(cli).slice(0, 40)}" (${CAPABILITY_CLIS.join(", ")})` };
  if (!ROLES.includes(role)) return { refused: `unknown role "${String(role).slice(0, 40)}" (${ROLES.join(", ")})` };
  if (NOT_OFFERED[cli]?.[role]) return { refused: NOT_OFFERED[cli][role] };
  const preset = presets?.presets?.[cli]?.[role];
  if (!preset) return { refused: `no preset for ${cli} ${role}; add one to <hoptell home>/presets/roles.json` };
  const warnings = [];
  let effort = request.effort ?? null;
  if (effort == null && preset.effort) {
    if (cli === "agy") warnings.push(`the ${preset.from} preset's effort ${preset.effort} is not used: agy takes its effort in the model id`);
    else effort = preset.effort;
  }
  const model = request.model ?? preset.model ?? null;
  const f = cliFlags(cli, { model, effort }, record, { now });
  if (f.refused) return { refused: f.refused };
  const args = [...(preset.flags ?? []), ...f.args];
  if (record?.present === false) warnings.push(`${cli} was not found on PATH; nothing was checked`);
  else if (record && !record.flags) warnings.push(`${cli}'s flags are unknown (its help could not be read); the preset's flags are passed unchanged`);
  else if (record) {
    const missing = optionTokens(args).filter((t) => !record.flags.includes(t));
    if (missing.length) warnings.push(`${[cli, record.version].filter(Boolean).join(" ")} --help does not list ${missing.join(", ")}; the launch keeps ${missing.length > 1 ? "them" : "it"}`);
    const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
    const checks = { codex: [["-s", "sandbox"], ["-a", "approval"]], claude: [["--permission-mode", "permission_mode"]], agy: [["--mode", "mode"]] }[cli];
    for (const [flag, k] of checks) {
      const v = valueOf(flag);
      if (v && record.enums?.[k]?.length && !record.enums[k].includes(v)) warnings.push(`${cli} --help lists ${flag} values ${record.enums[k].join(", ")}, not ${v}`);
      else if (v && !record.enums?.[k]?.length) warnings.push(`the values of ${cli} ${flag} are unknown; ${v} unchecked`);
    }
  }
  if (preset.checked && record?.version_first_seen && preset.checked < record.version_first_seen) warnings.push(`the ${preset.from} preset for ${cli} ${role} was checked on ${preset.checked}, before ${cli} ${record.version} was first seen here (${record.version_first_seen}); see ${preset.source ?? "its source"}`);
  if (preset.min_version && record?.version && compareVersions(record.version, preset.min_version) < 0) warnings.push(`the ${preset.from} preset for ${cli} ${role} needs ${cli} ${preset.min_version} or newer; this is ${record.version}`);
  if (preset.model && request.model == null && record) {
    const known = [record.account, record.bundled].filter(Boolean).some((l) => l.list.some((m) => m.id === preset.model || m.aliases.includes(preset.model))) || (record.aliases ?? []).includes(preset.model);
    if (!known) warnings.push(`the ${preset.from} preset names model ${preset.model}, which the record of ${cli} does not list`);
  }
  // What the role's mechanisms are known to do on this version.
  if (record?.version) {
    for (const v of verifiedFor(cli, record.version)) {
      const words = v.mechanism.split(" ");
      const used = words.every((w, i) => (i === 0 ? args.includes(w) : args[args.indexOf(words[0]) + i] === w));
      if (!used) continue;
      if (!v.holds) warnings.push(`${v.mechanism}: ${v.class} was verified on ${cli} ${v.min === v.max ? v.min : `${v.min} to ${v.max}`}, not on ${record.version}`);
      else if (CLASS_TEXT[v.class]) warnings.push(`${v.mechanism} on ${cli} ${record.version}: ${CLASS_TEXT[v.class]}`);
    }
  }
  warnings.push(...f.warnings);
  return { args, warnings, model, effort, preset };
}
