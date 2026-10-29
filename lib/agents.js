// Agent profiles (design 7.1): files the owner writes once that say which local agent CLI a
// session of this home may start, how and within which limits. Not the relay profiles of 1.1
// (lib/profiles.js). A profile is usable only while its SHA-256 is the one the owner approved
// (approved.json, through the decision service, kind "agent-profile").
//
//   <home>/agents/                    0700
//   <home>/agents/profiles/<id>.json  0600, schema/agent-profile.schema.json (checked here)
//   <home>/agents/approved.json       0600, {version: 1, profiles: {<id>: {digest, approved}}}
//   <home>/agents/lock                the agents lock
//   <home>/agents/audit.jsonl         0600, append-only (rotated at 10 MB, two files kept)
//
// Files are read with the checks lib/wake.js uses: a regular file of ours, private mode, one link,
// no symlink, bounded size. Profiles are read at every use, never cached.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, ensurePrivateDir } from "./config.js";
import { tryLock, writeRecord } from "./locks.js";
import { ALIAS_RE } from "./relays.js";
// (agentadapters.js imports agentsPaths from here: both sides use the other's exports only at call time.)
import { GATES, GATE_EFFORTS, HEADLESS_MODES, gateFor, gateRefusal, gateShape, modeGated } from "./agentadapters.js";
import { codexHomeOf, insidePath, rawRelays, resolveDeny, spellings } from "./agentdeny.js";

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

export const PROFILE_MAX = 16 * 1024;
const APPROVED_MAX = 256 * 1024;
export const AUDIT_MAX = 10 * 1024 * 1024;
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CLIS = ["codex", "claude", "gemini", "agy"];
export const MODES = ["headless", "tmux"];

/**
 * R7, shown before the owner approves a profile whose cli is codex (design 7.1, R7; the final text
 * of design-7.1-read-containment.md, "Owner decisions" (c)), verbatim, in every headless mode
 * offered (plain and hardening): what a run can read with the owner's macOS account.
 */
export const CODEX_APPROVAL_WARNING =
  "Spawned Codex runs use your macOS account. A run may read account-readable files, including relay member tokens and the sealed MLS device record. It could send a token in a hoptell message or its result even when direct shell writes and network access are denied. Anyone with that token can sign in as your member. Approve this profile only if you trust the tasks you assign and the files the run may read. Access to the Keychain and the device-state sealing key has not been tested.";
/** The approval text of a hardened profile (H4), verbatim, shown before R7. */
export const HARDENING_APPROVAL_TEXT =
  "This Codex build is configured to deny command reads of listed hoptell paths, but the run uses your macOS account and may still access account-readable secrets. Approve only if you trust the tasks you assign and the files the run can read.";
/** How the approval view names each offered headless mode. */
export const HEADLESS_MODE_LABEL = {
  plain: "plain: read-only (direct shell writes and network access denied; reads not contained)",
  hardening: "hardening: path-deny hardening (read-only; command reads of listed hoptell paths are configured to be denied)",
};
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- control characters are what is refused
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}(\([^()\u0000-\u001f]{1,200}\))?$/;
// Upper bounds of the schema (design 7.1 "Schema (v1)"), and the defaults.
export const LIMIT_CAPS = { concurrent: 8, perHour: 60, lifetimeMinutes: 1440, taskBytes: 256 * 1024, resultBytes: 1024 * 1024 };
export const HEADLESS_LIFETIME_MAX = 240;
export const LIMIT_DEFAULTS = { concurrent: 2, perHour: 10, taskBytes: 32768, resultBytes: 65536, budgetUsd: null };
export const LIFETIME_DEFAULT = { headless: 30, tmux: 480 };

/** The layout of <home>/agents. */
export function agentsPaths(home) {
  const dir = path.join(home, "agents");
  return { dir, profiles: path.join(dir, "profiles"), approved: path.join(dir, "approved.json"), lock: path.join(dir, "lock"), runs: path.join(dir, "runs"), audit: path.join(dir, "audit.jsonl") };
}

/** Create <home>/agents (and profiles/, runs/) private, or throw when one is not ours. */
export function ensureAgentsDirs(home) {
  const p = agentsPaths(home);
  ensurePrivateDir(home);
  for (const d of [p.dir, p.profiles, p.runs]) ensurePrivateDir(d);
  return p;
}

/** An existing directory of ours that only we can use, else null (never created or changed). */
export function privateDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0 ? dir : null;
  } catch {
    return null;
  }
}

/** A plain, private file of ours with one link (fstat result), or a reason. */
export function unsafe(st, max, { privateMode = true } = {}) {
  if (!st.isFile()) return "not a regular file";
  if (st.uid !== process.getuid()) return "not owned by this user";
  if (privateMode && (st.mode & 0o077) !== 0) return "readable or writable by other users (chmod 600 it)";
  if (st.nlink !== 1) return LINKS_PROBLEM;
  if (st.size > max) return `larger than ${max} bytes`;
  return null;
}

/**
 * Read a small private file: {bytes} or {problem} ("missing" when it does not exist). Opened
 * without following a symlink, checked on the open descriptor, read up to max + 1 bytes.
 */
export function readPrivateFile(file, max, { privateMode = true, pause = pauseBriefly } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = readPrivateOnce(file, max, privateMode);
    // While rename() replaces a file, a reader can see the new file with a second hard link for a
    // moment (APFS): only that check is read again, a few times, before it counts.
    if (r.problem !== LINKS_PROBLEM || attempt >= 3) return r;
    pause();
  }
}

const LINKS_PROBLEM = "has more than one hard link";
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
const pauseBriefly = () => Atomics.wait(PAUSE, 0, 0, 5);

function readPrivateOnce(file, max, privateMode) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e.code === "ENOENT") return { problem: "missing", missing: true };
    return { problem: e.code === "ELOOP" ? "is a symbolic link" : `cannot be read (${e.code ?? "error"})` };
  }
  try {
    const bad = unsafe(fs.fstatSync(fd), max, { privateMode });
    if (bad) return { problem: bad };
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n > max) return { problem: `larger than ${max} bytes` };
    return { bytes: buf.subarray(0, n) };
  } catch (e) {
    return { problem: `cannot be read (${e.code ?? "error"})` };
  } finally {
    fs.closeSync(fd);
  }
}

export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** `~/x` against the home folder; anything else must already be absolute. */
const expand = (p, homedir) => (p.startsWith("~/") ? path.join(homedir, p.slice(2)) : p);
const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
/** Is `child` the same as or inside `parent` (both real paths)? */
export const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v, re, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && re.test(x)) && new Set(v).size === v.length;

/**
 * Check a parsed profile against the schema and the rules a schema cannot say. Returns a list of
 * problems ([] when valid). `home` is the hoptell home (roots may not touch it), `homedir` the
 * user's home folder for `~/` (passed in, never read here), `id` the file name's id.
 */
export function validateProfile(doc, { id = null, home, homedir = null, env = null, relaysFile = null, gates = GATES } = {}) {
  const p = [];
  if (!isObj(doc)) return ["the profile must be a JSON object"];
  const known = ["version", "id", "description", "cli", "command", "modes", "sandbox", "folders", "name", "roles", "relays", "env", "cliOptions", "codex", "spawners", "confirm", "limits"];
  for (const k of Object.keys(doc)) if (!known.includes(k)) p.push(`unknown field "${k.slice(0, 40)}"`);
  for (const k of ["version", "id", "cli", "modes", "sandbox", "folders", "name"]) if (!Object.hasOwn(doc, k)) p.push(`${k} is required`);
  if (Object.hasOwn(doc, "version") && doc.version !== 1) p.push("version must be 1");
  if (Object.hasOwn(doc, "id")) {
    if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) p.push('id must be lowercase letters, digits and "-", up to 32 characters');
    else if (id !== null && doc.id !== id) p.push(`id "${doc.id}" does not match the file name ${id}.json`);
  }
  if (Object.hasOwn(doc, "description") && !(typeof doc.description === "string" && doc.description.length <= 200)) p.push("description must be text of at most 200 characters");
  if (Object.hasOwn(doc, "cli") && !CLIS.includes(doc.cli)) p.push(`cli must be one of ${CLIS.join(", ")}`);
  if (Object.hasOwn(doc, "command")) {
    if (!(typeof doc.command === "string" && doc.command.startsWith("/") && doc.command.length <= 1024 && !doc.command.includes("\0"))) p.push("command must be an absolute path");
  }
  if (Object.hasOwn(doc, "modes") && !(Array.isArray(doc.modes) && doc.modes.length >= 1 && doc.modes.length <= 2 && doc.modes.every((m) => MODES.includes(m)) && new Set(doc.modes).size === doc.modes.length)) p.push("modes must list headless and/or tmux, each once");
  if (Object.hasOwn(doc, "sandbox")) {
    if (!["read-only", "workspace-write", "full"].includes(doc.sandbox)) p.push("sandbox must be read-only or workspace-write");
    else if (doc.sandbox === "full") p.push("sandbox full is refused in this version");
  }
  const mode = checkHeadlessMode(doc, p);
  // Hardening, gated now: the deny roots this check can resolve (H, C, and R and T with the owner
  // relays file); otherwise today's rule. The authoritative check is the one at start.
  const deny = mode === "hardening" && modeGated("codex", "headless", "hardening", gates) ? approvalDeny({ home, homedir, env, relaysFile }) : null;
  if (Object.hasOwn(doc, "folders")) checkFolders(doc.folders, p, { home, homedir, deny });
  if (deny?.tokenEnvs.length && Array.isArray(doc.env?.pass)) for (const v of doc.env.pass.filter((x) => deny.tokenEnvs.includes(x))) p.push(`env.pass: ${v} is a relay token variable of your relays file; a hardened run may not get it`);
  if (Object.hasOwn(doc, "name")) {
    const n = doc.name;
    if (!isObj(n) || Object.keys(n).some((k) => k !== "prefix")) p.push('name must be {"prefix": ...}');
    else if (!(typeof n.prefix === "string" && PREFIX_RE.test(n.prefix))) p.push('name.prefix must be letters, digits, "_" and "-", up to 32 characters, starting with a letter or digit');
  }
  if (Object.hasOwn(doc, "roles")) {
    if (!strings(doc.roles, NAME_RE, 15)) p.push("roles must be at most 15 distinct role names");
    else if (doc.roles.some((r) => r === "all" || r === "spawned")) p.push('roles cannot include "all" or "spawned" (every run has "spawned")');
  }
  if (Object.hasOwn(doc, "relays") && !(strings(doc.relays, ALIAS_RE, 8) && doc.relays.length >= 1)) p.push("relays must list 1 to 8 distinct relay aliases");
  if (Object.hasOwn(doc, "env")) {
    const e = doc.env;
    if (!isObj(e) || Object.keys(e).some((k) => k !== "pass")) p.push('env must be {"pass": [...]}');
    else if (Object.hasOwn(e, "pass")) {
      if (!strings(e.pass, ENV_RE, 16)) p.push("env.pass must be at most 16 distinct variable names");
      else if (e.pass.some((v) => v.startsWith("HOPTELL_"))) p.push("env.pass cannot pass HOPTELL_ variables");
    }
  }
  if (Object.hasOwn(doc, "cliOptions")) checkCliOptions(doc.cliOptions, doc.cli, p);
  if (Object.hasOwn(doc, "spawners")) {
    const s = doc.spawners;
    if (!isObj(s) || Object.keys(s).some((k) => !["roles", "names"].includes(k))) p.push('spawners must be {"roles": [...], "names": [...]}');
    else for (const k of ["roles", "names"]) if (Object.hasOwn(s, k) && !strings(s[k], NAME_RE, 16)) p.push(`spawners.${k} must be at most 16 distinct names`);
  }
  if (Object.hasOwn(doc, "confirm") && !["never", "always"].includes(doc.confirm)) p.push("confirm must be never or always");
  if (Object.hasOwn(doc, "limits")) checkLimits(doc.limits, doc, p);
  return p;
}

/**
 * codex.headlessMode (design-7.1-read-containment.md): plain, hardening or containment; anything
 * but plain only for a Codex profile with modes ["headless"] and sandbox read-only. The mode the
 * other checks use (plain when absent or invalid).
 */
function checkHeadlessMode(doc, p) {
  if (!Object.hasOwn(doc, "codex")) return "plain";
  const c = doc.codex;
  if (!isObj(c) || Object.keys(c).some((k) => k !== "headlessMode")) {
    p.push('codex must be {"headlessMode": ...}');
    return "plain";
  }
  if (!Object.hasOwn(c, "headlessMode")) return "plain";
  if (!HEADLESS_MODES.includes(c.headlessMode)) {
    p.push(`codex.headlessMode must be one of ${HEADLESS_MODES.join(", ")}`);
    return "plain";
  }
  if (c.headlessMode !== "plain" && !(doc.cli === "codex" && doc.sandbox === "read-only" && Array.isArray(doc.modes) && doc.modes.length === 1 && doc.modes[0] === "headless")) {
    p.push(`codex.headlessMode ${c.headlessMode} is only for codex profiles with modes ["headless"] and sandbox read-only`);
    return "plain";
  }
  return c.headlessMode;
}

/**
 * The deny roots an approval can resolve for a hardened profile: {roots (every spelling), tokenEnvs}.
 * H and C always (C from `env`, else the home folder's .codex); with the owner relays file, R and
 * every tokenFile of its raw array, and its tokenEnv names.
 */
function approvalDeny({ home, homedir, env, relaysFile }) {
  const runEnv = env ? { HOME: env.HOME ?? homedir, ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}) } : { HOME: homedir };
  if (relaysFile) {
    const d = resolveDeny({ home, relaysFile, homedir, env: runEnv });
    if (!d.problem) return { roots: d.deny, tokenEnvs: d.tokenEnvs };
  }
  const roots = [];
  for (const x of [home, codexHomeOf(runEnv)].filter(Boolean)) {
    try {
      roots.push(...spellings(x));
    } catch {}
  }
  const tokenEnvs = relaysFile ? (rawRelays(relaysFile, homedir).entries ?? []).map((e) => e.tokenEnv).filter(Boolean) : [];
  return { roots, tokenEnvs };
}

function checkFolders(f, p, { home, homedir, deny = null }) {
  if (!isObj(f) || Object.keys(f).some((k) => !["roots", "default"].includes(k))) return p.push('folders must be {"roots": [...], "default": ...}');
  const okPath = (x) => typeof x === "string" && x.length <= 1024 && !x.includes("\0") && (x.startsWith("/") || x.startsWith("~/"));
  if (!(Array.isArray(f.roots) && f.roots.length >= 1 && f.roots.length <= 16 && f.roots.every(okPath))) return p.push("folders.roots must list 1 to 16 absolute paths (or ~/...); relative paths are refused");
  if (!okPath(f.default)) return p.push("folders.default must be an absolute path (or ~/...)");
  if (!f.roots.includes(f.default)) p.push("folders.default must be one of folders.roots");
  const homeReal = home ? (realpath(home) ?? path.resolve(home)) : null;
  for (const r of f.roots) {
    if (r.startsWith("~/") && !homedir) {
      p.push(`folders.roots: ${r} needs the home folder, which this check was not given`);
      continue;
    }
    const real = realpath(expand(r, homedir));
    if (!real) {
      p.push(`folders.roots: ${r} does not exist`);
      continue;
    }
    if (deny) {
      // Hardening: a root may contain a denied path (the deny is more specific and wins), but may
      // not be or lie inside one (the workspace root would beat the deny), in any spelling.
      let sp = [real];
      try {
        sp = spellings(expand(r, homedir));
      } catch {}
      const hit = deny.roots.find((d) => sp.some((x) => insidePath(x, d)));
      if (hit) p.push(`folders.roots: ${r} is or lies inside ${hit}, which a hardened run denies`);
      continue;
    }
    // A root that is, contains or lies inside the hoptell home would expose the run directory
    // (relays file, settings, MCP configuration) to a workspace-write run.
    if (homeReal && (within(real, homeReal) || within(homeReal, real))) p.push(`folders.roots: ${r} is, contains or lies inside the hoptell home`);
  }
}

function checkCliOptions(o, cli, p) {
  if (!isObj(o)) return p.push("cliOptions must be an object");
  for (const k of Object.keys(o)) {
    if (!["model", "effort", "allowedTools", "disallowedTools"].includes(k)) p.push(`cliOptions: unknown option "${k.slice(0, 40)}"`);
  }
  if (Object.hasOwn(o, "model") && !(typeof o.model === "string" && MODEL_RE.test(o.model))) p.push("cliOptions.model must be a model name (letters, digits, . _ : / -)");
  if (Object.hasOwn(o, "effort")) {
    if (!GATE_EFFORTS[cli]) p.push("cliOptions.effort is only for codex and claude");
    else if (!GATE_EFFORTS[cli].includes(o.effort)) p.push(`cliOptions.effort must be one of ${GATE_EFFORTS[cli].join(", ")} (the efforts hoptell's gate records allow for ${cli})`);
  }
  for (const k of ["allowedTools", "disallowedTools"]) {
    if (!Object.hasOwn(o, k)) continue;
    if (!(Array.isArray(o[k]) && o[k].length <= 32 && o[k].every((t) => typeof t === "string" && TOOL_RE.test(t)))) p.push(`cliOptions.${k} must list at most 32 tool names, such as Read or Bash(git diff:*)`);
    else if (cli !== "claude") p.push(`cliOptions.${k} is only for claude`);
  }
}

function checkLimits(l, doc, p) {
  if (!isObj(l)) return p.push("limits must be an object");
  for (const k of Object.keys(l)) if (!["concurrent", "perHour", "lifetimeMinutes", "taskBytes", "resultBytes", "budgetUsd"].includes(k)) p.push(`limits: unknown field "${k.slice(0, 40)}"`);
  for (const [k, max] of Object.entries(LIMIT_CAPS)) {
    if (!Object.hasOwn(l, k)) continue;
    if (!(Number.isInteger(l[k]) && l[k] >= 1 && l[k] <= max)) p.push(`limits.${k} must be a whole number from 1 to ${max}`);
  }
  if (Number.isInteger(l.lifetimeMinutes) && Array.isArray(doc.modes) && doc.modes.includes("headless") && l.lifetimeMinutes > HEADLESS_LIFETIME_MAX) p.push(`limits.lifetimeMinutes must be at most ${HEADLESS_LIFETIME_MAX} for a profile with headless mode`);
  if (Object.hasOwn(l, "budgetUsd") && l.budgetUsd !== null) {
    if (!(typeof l.budgetUsd === "number" && Number.isFinite(l.budgetUsd) && l.budgetUsd > 0 && l.budgetUsd <= 1000)) p.push("limits.budgetUsd must be a number above 0 and at most 1000, or null");
    else if (doc.cli !== "claude") p.push("limits.budgetUsd is only for cli claude (the only CLI with a budget flag)");
  }
}

/**
 * The profile with its defaults filled in (a valid profile only). `lifetimeMinutes` stays as the
 * profile gives it (null: the mode's default, see lifetimeOf).
 */
export function withDefaults(doc, homedir) {
  return {
    ...doc,
    description: doc.description ?? "",
    command: doc.command ?? null,
    roles: doc.roles ?? [],
    relays: doc.relays ?? ["local"],
    env: { pass: doc.env?.pass ?? [] },
    cliOptions: doc.cliOptions ?? {},
    spawners: { roles: doc.spawners?.roles ?? [], names: doc.spawners?.names ?? [] },
    confirm: doc.confirm ?? null,
    codex: { headlessMode: doc.codex?.headlessMode ?? "plain" },
    folders: { roots: doc.folders.roots.map((r) => expand(r, homedir)), default: expand(doc.folders.default, homedir) },
    limits: { ...LIMIT_DEFAULTS, lifetimeMinutes: null, ...(doc.limits ?? {}) },
  };
}

/** The lifetime of a run of `profile` (withDefaults) in `mode`, in minutes. */
export const lifetimeOf = (profile, mode) => profile.limits.lifetimeMinutes ?? LIFETIME_DEFAULT[mode];

/**
 * The confirmation a spawn needs: the profile's explicit choice, else "always" for workspace-write
 * or a remote relay (`remote(alias)` says whether an alias is not the local relay), else "never".
 */
export const confirmOf = (profile, remote) => profile.confirm ?? (profile.sandbox === "workspace-write" || profile.relays.some(remote) ? "always" : "never");

const profileFile = (home, id) => path.join(agentsPaths(home).profiles, `${id}.json`);

/**
 * Read one profile: {id, profile (with defaults), doc, digest, problems}. `problems` is empty for a
 * usable file; `digest` is null when the file could not be read at all.
 */
export function readProfile(home, id, { homedir = null, env = null, relaysFile = null, gates = GATES } = {}) {
  if (typeof id !== "string" || !ID_RE.test(id)) return { id, profile: null, doc: null, digest: null, problems: ["not a profile id"], missing: true };
  if (!privateDir(agentsPaths(home).dir) || !privateDir(agentsPaths(home).profiles)) {
    const exists = fs.existsSync(agentsPaths(home).profiles);
    return { id, profile: null, doc: null, digest: null, problems: [exists ? `${agentsPaths(home).profiles} is not a private directory of this user` : "missing"], missing: !exists };
  }
  const r = readPrivateFile(profileFile(home, id), PROFILE_MAX);
  if (r.problem) return { id, profile: null, doc: null, digest: null, problems: [r.problem], missing: Boolean(r.missing) };
  const digest = sha256(r.bytes);
  let doc;
  try {
    doc = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    return { id, profile: null, doc: null, digest, problems: ["not valid JSON"] };
  }
  const problems = validateProfile(doc, { id, home, homedir, env, relaysFile, gates });
  return { id, profile: problems.length ? null : withDefaults(doc, homedir), doc, digest, problems };
}

/** Every profile file of the home, broken ones included (each with its problems), sorted by id. */
export function listProfiles(home, { homedir = null, ...more } = {}) {
  const dir = agentsPaths(home).profiles;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".json") || n.startsWith(".")) continue;
    const id = n.slice(0, -5);
    if (!ID_RE.test(id)) {
      out.push({ id, profile: null, doc: null, digest: null, problems: ["the file name is not <id>.json with a valid id"] });
      continue;
    }
    out.push(readProfile(home, id, { homedir, ...more }));
  }
  return out;
}

/** The approved digests: {profiles: {id: {digest, approved}}}, plus a problem when unreadable. */
export function readApproved(home) {
  const r = readPrivateFile(agentsPaths(home).approved, APPROVED_MAX);
  if (r.missing) return { profiles: {}, problem: null };
  if (r.problem) return { profiles: {}, problem: `${agentsPaths(home).approved}: ${r.problem}` };
  try {
    const doc = JSON.parse(r.bytes.toString("utf8"));
    if (doc?.version !== 1 || !isObj(doc.profiles)) throw new Error();
    const profiles = {};
    for (const [id, v] of Object.entries(doc.profiles)) if (ID_RE.test(id) && isObj(v) && /^[0-9a-f]{64}$/.test(v.digest ?? "")) profiles[id] = { digest: v.digest, approved: String(v.approved ?? "") };
    return { profiles, problem: null };
  } catch {
    return { profiles: {}, problem: `${agentsPaths(home).approved}: not a valid approvals file` };
  }
}

/**
 * The approval state of a read profile: "approved", "changed" (another digest was approved),
 * "unapproved" or "invalid".
 */
export function approvalOf(read, approved) {
  if (read.problems.length) return "invalid";
  const a = approved.profiles[read.id];
  if (!a) return "unapproved";
  return a.digest === read.digest ? "approved" : "changed";
}

/** Record `digest` as the approved one for `id` (the caller holds the agents lock). */
export function writeApproved(home, id, digest, now = new Date()) {
  const p = ensureAgentsDirs(home);
  const cur = readApproved(home);
  if (cur.problem && fs.existsSync(p.approved)) throw new Error(`${cur.problem}; fix or remove it first`);
  writeRecord(p.approved, { version: 1, profiles: { ...cur.profiles, [id]: { digest, approved: now.toISOString() } } }, 2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn while holding <home>/agents/lock; waits briefly for a live holder, else `busy`. */
export async function withAgentsLock(home, fn, { waitMs = 5000 } = {}) {
  const { lock } = ensureAgentsDirs(home);
  for (let i = 0; i < Math.ceil(waitMs / 20); i++) {
    const release = tryLock(lock);
    if (typeof release !== "function") {
      await sleep(20);
      continue;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
  throw Object.assign(new Error("the agents lock is held by another hoptell process"), { code: "busy" });
}

/**
 * Append one event to <home>/agents/audit.jsonl (0600). Rotated at AUDIT_MAX: the full file
 * becomes audit.jsonl.1 (the older .1 is dropped), so two files are kept. Never task text,
 * result text, tokens or environment values: callers pass sizes and digests.
 */
export function audit(home, event, fields = {}, { max = AUDIT_MAX, now = new Date() } = {}) {
  const { audit: file } = ensureAgentsDirs(home);
  const line = `${JSON.stringify({ time: now.toISOString(), event, ...fields })}\n`;
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size + Buffer.byteLength(line) > max) fs.renameSync(file, `${file}.1`);
  } catch {}
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (unsafe(st, Infinity)) throw new Error(`${file} is not a private file of this user`);
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

/** The audit events, oldest first (both files), optionally of one run. */
export function readAudit(home, { run = null } = {}) {
  const { audit: file } = agentsPaths(home);
  const out = [];
  for (const f of [`${file}.1`, file]) {
    const r = readPrivateFile(f, AUDIT_MAX + 64 * 1024);
    if (r.problem) continue;
    for (const line of r.bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (!run || e.run === run) out.push(e);
      } catch {}
    }
  }
  return out;
}

// ---- the decision kind "agent-profile" (lib/decisions.js) ---------------------------------------

/** The decision view of a profile: what `hoptell agents profile approve` shows. Token: the digest. */
export function profileView(home, id, { homedir = null, commandLines = null, env = null, relaysFile = null, gates = GATES } = {}) {
  const read = readProfile(home, id, { homedir, env, relaysFile, gates });
  if (read.missing) return null;
  const approved = readApproved(home);
  const state = approvalOf(read, approved);
  const view = { id, digest: read.digest, state, problems: read.problems, profile: read.doc, ...(approved.problem ? { approvalsProblem: approved.problem } : {}) };
  if (read.doc?.cli === "codex" && Array.isArray(read.doc.modes) && read.doc.modes.includes("headless")) {
    // The headless mode by name, the modes offered and gated now, and a refusal when the chosen
    // one is not (a hand-edited containment, or hardening before its gate is recorded).
    const mode = HEADLESS_MODES.includes(read.doc.codex?.headlessMode) ? read.doc.codex.headlessMode : "plain";
    view.headlessMode = mode;
    view.headlessModes = Object.keys(HEADLESS_MODE_LABEL).filter((m) => modeGated("codex", "headless", m, gates));
    if (!modeGated("codex", "headless", mode, gates) && mode !== "plain") view.modeRefusal = "adapter_gate_unverified";
  }
  // A codex profile none of whose modes can ever run on this hoptell (a mode whose gate has not
  // passed, or arguments its gates did not pass with) is not approved: it would only be refused
  // at every spawn.
  if (read.doc?.cli === "codex" && !read.problems.length && !view.modeRefusal && Array.isArray(read.profile?.modes)) {
    const hm = view.headlessMode ?? "plain";
    const why = read.profile.modes.map((mode) => {
      if (gateRefusal("codex", mode, null, gates, hm)) return mode === "tmux" ? "codex in tmux mode is not available yet (a tmux run cannot be limited to its own hoptell server)" : `codex in ${mode} mode is not available yet`;
      const shapes = gateFor("codex", mode, hm, gates)?.passed?.shapes;
      let shape;
      try {
        shape = gateShape(read.profile, mode);
      } catch {
        return null; // not judged here: the spawn checks it
      }
      return shapes && !shapes.includes(shape) ? `codex in ${mode} mode runs only with the arguments its gates passed with${read.profile.sandbox === "read-only" ? ", not with this profile's" : ` (sandbox read-only), not with sandbox ${read.profile.sandbox}`}` : null;
    });
    if (why.every(Boolean)) view.unusable = why.join("; ");
  }
  if (!read.problems.length && commandLines) view.commandLines = commandLines(read.profile);
  return { read, view };
}

/** Profiles waiting for the owner's approval (new or changed), for the decision service's list. */
export function pendingProfiles(home, { homedir = null } = {}) {
  const approved = readApproved(home);
  return listProfiles(home, { homedir })
    .map((r) => ({ r, state: approvalOf(r, approved) }))
    .filter((x) => x.state === "unapproved" || x.state === "changed")
    .map(({ r, state }) => ({ id: r.id, digest: r.digest, state }));
}
