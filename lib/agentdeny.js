// Path-deny hardening of spawned Codex headless runs (design-7.1-read-containment.md, draft 6.1):
// the deny set, the local managed-source detection, the preflight and the cloud stream's line
// classes. This is hardening, never containment: a run still uses the owner's account and may
// read account-readable files (R7).
//
//   resolveDeny(...)     the deny table from current state: H (the hoptell home), T (every
//                        tokenFile of the RAW relays array), R (the relays file or its hoptell
//                        directory), C (the CODEX_HOME of the run's exact environment); E (the
//                        tokenEnv names) is not a path and is returned on its own
//   checkHardening(...)  steps 2-4 of "Start-time revalidation": resolve, hard links, managed
//                        sources, the plan's table, the overlap with the run's folders, tokenEnv
//   managedSources(...)  /etc/codex files, the com.openai.codex managed preferences (NSUserDefaults
//                        through JXA) and the Managed Preferences plists; fails closed
//   preflight(...)       `codex sandbox -P <id> ... -- /usr/bin/stat` per path, empty CODEX_HOME
//   cloudLineClass(...)  the class of a codex_cloud_config log line
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkHardenedArgs } from "./agentadapters.js";

const DATA = "/System/Volumes/Data";

/** `child` equal to or inside `parent` (absolute, normalized), on "/" boundaries. */
export const insidePath = (child, parent) => child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);

const normal = (p) => {
  const r = path.resolve(p);
  return r.length > 1 ? r.replace(/\/+$/, "") : r;
};
const missingCode = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";

/**
 * The deepest existing ancestor of `p` (itself included): {at, rest}. A missing path is allowed (a
 * deny rule is a path rule); any other error is thrown.
 */
function existingAncestor(p, fsx) {
  let at = p;
  const rest = [];
  for (;;) {
    try {
      fsx.lstatSync(at);
      return { at, rest: rest.reverse() };
    } catch (e) {
      if (!missingCode(e)) throw e;
      if (at === "/") return { at, rest: rest.reverse() };
      rest.push(path.basename(at));
      at = path.dirname(at);
    }
  }
}

const sameInode = (a, b, fsx) => {
  try {
    const x = fsx.statSync(a);
    const y = fsx.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
};

/**
 * The spellings of a path a deny rule must name: as configured (normalized), its realpath (of the
 * nearest existing ancestor plus the rest when it does not exist), and for a /System/Volumes/Data
 * spelling the firmlinked one without that prefix, only when both name the same (dev, ino): a
 * deny in the Data spelling alone denies nothing (probe 15). Throws on an unresolvable path.
 */
export function spellings(p, { fsx = fs } = {}) {
  const configured = normal(p);
  const out = [configured];
  const { at, rest } = existingAncestor(configured, fsx);
  out.push(normal(path.join(fsx.realpathSync(at), ...rest)));
  for (const s of [...out]) {
    if (!s.startsWith(`${DATA}/`)) continue;
    const a = existingAncestor(s, fsx);
    if (a.at === DATA || !a.at.startsWith(`${DATA}/`)) continue;
    const stripped = a.at.slice(DATA.length);
    if (sameInode(a.at, stripped, fsx)) out.push(normal(path.join(stripped, ...a.rest)));
  }
  return [...new Set(out)];
}

/** Deduplicated, without entries inside another entry, sorted. */
export function compactDeny(paths) {
  const sorted = [...new Set(paths)].sort();
  return sorted.filter((p) => !sorted.some((q) => q !== p && insidePath(p, q)));
}

/**
 * The owner relays file a surface's environment resolves (lib/settings.js's rule: a relative
 * HOPTELL_RELAYS against the surface's working folder).
 */
export const ownerRelaysFile = (env, homedir, cwd = process.cwd()) => (env?.HOPTELL_RELAYS ? path.resolve(cwd, env.HOPTELL_RELAYS) : path.join(env?.XDG_CONFIG_HOME || path.join(homedir ?? env?.HOME ?? "/", ".config"), "hoptell", "relays.json"));

/** Whether two spellings name the same relays file (canonical paths when they exist). */
export function sameFile(a, b) {
  if (!a || !b) return false;
  const canon = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return canon(a) === canon(b);
}

/**
 * The CODEX_HOME of an environment object: its CODEX_HOME, else $HOME/.codex; null without either,
 * or for a relative CODEX_HOME (Codex resolves that against its own working folder, which is not
 * known here: refused, fail closed).
 */
export function codexHomeOf(env) {
  if (typeof env?.CODEX_HOME === "string" && env.CODEX_HOME) return path.isAbsolute(env.CODEX_HOME) ? path.resolve(env.CODEX_HOME) : null;
  return typeof env?.HOME === "string" && path.isAbsolute(env.HOME) ? path.join(env.HOME, ".codex") : null;
}

/**
 * The owner's relays file as its RAW array (every element: duplicates, entries without an alias,
 * entries not granted), read as ownerRelays reads it (a private regular file, version 1). Every
 * element must be an object whose tokenFile and tokenEnv, when present, are strings.
 * {entries: [{tokenFile (expanded) | null, tokenEnv | null}], file} or {problem}.
 */
export function rawRelays(file, homedir, { fsx = fs } = {}) {
  if (!file) return { problem: "no owner relays file is recorded" };
  let doc;
  try {
    const st = fsx.lstatSync(file);
    if (!st.isFile() || st.mode & 0o077) return { problem: `${file} is not a private regular file` };
    doc = JSON.parse(fsx.readFileSync(file, "utf8"));
  } catch (e) {
    return { problem: `${file} cannot be read (${e.code ?? "invalid JSON"})` };
  }
  if (doc?.version !== 1 || !Array.isArray(doc.relays)) return { problem: `${file} has an unknown format` };
  const expand = (p) => (p.startsWith("~/") ? path.join(homedir, p.slice(2)) : path.resolve(path.dirname(file), p));
  const entries = [];
  for (const [i, r] of doc.relays.entries()) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return { problem: `${file}: relays[${i}] is not an object` };
    if (r.tokenFile !== undefined && typeof r.tokenFile !== "string") return { problem: `${file}: relays[${i}].tokenFile is not a string` };
    if (r.tokenEnv !== undefined && typeof r.tokenEnv !== "string") return { problem: `${file}: relays[${i}].tokenEnv is not a string` };
    if (typeof r.tokenFile === "string" && r.tokenFile.startsWith("~/") && !homedir) return { problem: `${file}: relays[${i}].tokenFile needs the home folder` };
    entries.push({ tokenFile: typeof r.tokenFile === "string" ? expand(r.tokenFile) : null, tokenEnv: r.tokenEnv ?? null });
  }
  return { entries, file };
}

/** Is the relays file's directory hoptell's own (<config>/hoptell): then the directory is denied. */
const hoptellOwnedDir = (dir) => path.basename(dir) === "hoptell" && path.basename(path.dirname(dir)) === ".config";

/**
 * The deny inputs from current state: {deny (sorted paths), tokenEnvs, tokenFiles, hardlinked,
 * classes: {H, T, R, C} (configured paths)} or {problem}. `env` is the exact environment object
 * the CLI gets (C comes from it); `relaysFile` the owner relays file the spawn recorded.
 */
export function resolveDeny({ home, relaysFile, homedir, env }, { fsx = fs } = {}) {
  const raw = rawRelays(relaysFile, homedir, { fsx });
  if (raw.problem) return { problem: raw.problem };
  if (typeof env?.CODEX_HOME === "string" && env.CODEX_HOME && !path.isAbsolute(env.CODEX_HOME)) return { problem: "the run's CODEX_HOME is not an absolute path; Codex would resolve it against its own working folder, so its sign-in folder cannot be denied" };
  const C = codexHomeOf(env);
  if (!C) return { problem: "the run's environment has neither CODEX_HOME nor HOME, so Codex's sign-in folder cannot be located" };
  const T = raw.entries.map((e) => e.tokenFile).filter(Boolean);
  const rdir = path.dirname(raw.file);
  const R = hoptellOwnedDir(rdir) ? rdir : raw.file;
  const classes = { H: [home], T, R: [R], C: [C] };
  const hardlinked = [];
  for (const t of T) {
    try {
      // A regular file only: a folder always has more than one link.
      const st = fsx.statSync(t);
      if (st.isFile() && st.nlink > 1) hardlinked.push(t);
    } catch (e) {
      if (!missingCode(e)) return { problem: `the token file ${t} cannot be checked (${e.code ?? "error"})` };
    }
  }
  const all = [];
  for (const [cls, list] of Object.entries(classes)) {
    for (const p of list) {
      try {
        all.push(...spellings(p, { fsx }));
      } catch (e) {
        return { problem: `the ${cls} path ${p} cannot be resolved (${e.code ?? "error"})` };
      }
    }
  }
  return { deny: compactDeny(all), tokenEnvs: [...new Set(raw.entries.map((e) => e.tokenEnv).filter(Boolean))], tokenFiles: T, hardlinked, classes };
}

/** The first of `paths` (any spelling) equal to or inside a deny entry: {path, entry}, or null. Throws when unresolvable. */
export function overlapOf(paths, deny, { fsx = fs } = {}) {
  for (const p of paths) {
    for (const s of spellings(p, { fsx })) {
      const entry = deny.find((d) => insidePath(s, d));
      if (entry) return { path: p, entry };
    }
  }
  return null;
}

// ---- local managed Codex configuration (fail closed) ------------------------------------------------

export const ETC_CODEX = ["/etc/codex/requirements.toml", "/etc/codex/managed_config.toml", "/etc/codex/config.toml"];
const PREF_KEYS = ["config_toml_base64", "requirements_toml_base64"];
/** The fixed JXA script: per key, present or absent and forced, through NSUserDefaults (forced values included). */
export const MANAGED_PREFS_SCRIPT = `ObjC.import("Foundation"); const d = $.NSUserDefaults.alloc.initWithSuiteName("com.openai.codex"); ${JSON.stringify(PREF_KEYS)}.map((k) => \`\${k}=\${d.objectForKey(k).isNil() ? "absent" : "present"} forced=\${d.objectIsForcedForKey(k) ? "true" : "false"}\`).join("\\n")`;
const EXPECTED_PREFS = PREF_KEYS.map((k) => `${k}=absent forced=false`).join("\n");

const defaultOsascript = () => {
  const r = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MANAGED_PREFS_SCRIPT], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  return { status: r.status, stdout: r.stdout ?? "", error: r.error ? (r.error.code ?? "error") : null };
};

/**
 * The local managed or system Codex configuration sources 0.162.1 reads: null when none is present,
 * {present: [names]} or {problem} (undeterminable: refused like present). `osascript()` (tests):
 * {status, stdout, error}. macOS only: elsewhere the mode is refused.
 */
export function managedSources({ fsx = fs, osascript = defaultOsascript, user = os.userInfo().username, platform = process.platform } = {}) {
  if (platform !== "darwin") return { problem: `path-deny hardening is gated on macOS only, not ${platform}` };
  const present = [];
  const lst = (p) => {
    try {
      fsx.lstatSync(p);
      return true;
    } catch (e) {
      // Only ENOENT is absence (design 6.1): anything else, ENOTDIR included, refuses.
      if (e?.code === "ENOENT") return false;
      throw Object.assign(new Error(`${p} cannot be checked (${e.code ?? "error"})`), { undeterminable: true });
    }
  };
  try {
    for (const f of ETC_CODEX) if (lst(f)) present.push(f);
    for (const f of ["/Library/Managed Preferences/com.openai.codex.plist", `/Library/Managed Preferences/${user}/com.openai.codex.plist`]) if (lst(f)) present.push(f);
  } catch (e) {
    return { problem: e.message };
  }
  let r;
  try {
    r = osascript();
  } catch (e) {
    return { problem: `the managed preferences of com.openai.codex cannot be read (${e.code ?? e.message})` };
  }
  if (r?.error || r?.status !== 0) return { problem: `the managed preferences of com.openai.codex cannot be read (${r?.error ?? `exit ${r?.status}`})` };
  const out = String(r.stdout).trim();
  if (out !== EXPECTED_PREFS) {
    const lines = out.split("\n");
    const known = lines.length === 2 && lines.every((l, i) => new RegExp(`^${PREF_KEYS[i]}=(absent|present) forced=(true|false)$`).test(l));
    if (!known) return { problem: "the managed preferences of com.openai.codex gave an unexpected answer" };
    for (const l of lines) if (l !== `${l.split("=")[0]}=absent forced=false`) present.push(`managed preference com.openai.codex ${l.split("=")[0]}`);
  }
  return present.length ? { present } : null;
}

// ---- steps 2-4 of the start-time revalidation ------------------------------------------------------

/**
 * Steps 2-4 against one environment object: resolve the deny inputs, hard links, the local managed
 * sources, the plan's table (structural check, equality), the overlap of the cwd and the profile's
 * roots, and tokenEnv against env.pass. {deny, tokenEnvs} or {kind, problem} with kind "resolve",
 * "hardlink", "managed", "plan", "overlap" or "env" (paths and names only, never contents).
 * `plan`: the stored plan (omitted at spawn, before it is built).
 */
export function checkHardening({ home, relaysFile, homedir, env, pass = [], cwd, roots = [], plan = null, sandbox = "read-only" }, { fsx = fs, managed = managedSources } = {}) {
  const d = resolveDeny({ home, relaysFile, homedir, env }, { fsx });
  if (d.problem) return { kind: "resolve", problem: d.problem };
  if (d.hardlinked.length) return { kind: "hardlink", problem: `the token file ${d.hardlinked.join(", ")} has more than one hard link; a second name for it would not be denied` };
  const m = managed();
  if (m?.problem) return { kind: "managed", problem: `local managed Codex configuration cannot be ruled out: ${m.problem}` };
  if (m?.present) return { kind: "managed", problem: `local managed Codex configuration is present: ${m.present.join(", ")}` };
  if (plan) {
    const bad = checkHardenedArgs(plan, d.deny, sandbox);
    if (bad) return { kind: "plan", problem: bad };
    if (!Array.isArray(plan.deny) || JSON.stringify([...plan.deny].sort()) !== JSON.stringify(d.deny)) return { kind: "plan", problem: "the plan's recorded deny table differs from the one resolved now" };
  }
  let o;
  try {
    o = overlapOf([cwd, ...roots].filter(Boolean), d.deny, { fsx });
  } catch (e) {
    return { kind: "resolve", problem: `a folder of the run cannot be resolved (${e.code ?? "error"})` };
  }
  if (o) return { kind: "overlap", problem: `${o.path} is equal to or inside the denied path ${o.entry}` };
  const named = pass.filter((v) => d.tokenEnvs.includes(v));
  if (named.length) return { kind: "env", problem: `env.pass names ${named.join(", ")}, a relay token variable of the owner's relays file` };
  return { deny: d.deny, tokenEnvs: d.tokenEnvs, tokenFiles: d.tokenFiles, codexHome: d.classes.C[0] };
}

// ---- the preflight -------------------------------------------------------------------------------

const defaultRunner = (command, args, opts) => {
  const r = spawnSync(command, args, { ...opts, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? (r.error.code ?? "error") : null };
};

/**
 * The paths the preflight stats: every deny entry and known child that exists (expected denied),
 * and the cwd (expected allowed). Children: under H the run's relays.json, local-relay/token,
 * credentials/ and mls/; each T file; <C>/auth.json.
 */
export function preflightTargets({ home, run, deny, tokenFiles = [], codexHome = null }, { fsx = fs } = {}) {
  const children = [path.join(home, "agents", "runs", run, "relays.json"), path.join(home, "local-relay", "token"), path.join(home, "credentials"), path.join(home, "mls"), ...tokenFiles, ...(codexHome ? [path.join(codexHome, "auth.json")] : [])];
  const exists = (p) => {
    try {
      fsx.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  return [...new Set([...deny, ...children])].filter(exists);
}

/**
 * The preflight (never cached): for each target, `codex sandbox <the plan's -c permission slots>
 * -P <id> -C <cwd> -- /usr/bin/stat -f %i <path>` with an empty temporary CODEX_HOME (0700,
 * removed afterwards) and otherwise the run's environment, 10 s per call. Expected: "Operation not
 * permitted" with a non-zero exit for each denied target, success for the cwd. null or {problem}.
 * `run(command, args, {env, cwd, timeout})` (tests): {status, stdout, stderr, error}.
 */
export function preflight({ command, plan, cwd, env, targets }, { run = defaultRunner, tmp = os.tmpdir() } = {}) {
  const slots = [];
  for (let i = 0; i < plan.args.length - 1; i++) if (plan.args[i] === "-c" && /^(default_permissions=|permissions\.)/.test(plan.args[i + 1])) slots.push("-c", plan.args[i + 1]);
  if (slots.length !== 6) return { problem: "the plan's permission slots are missing" };
  const codexHome = fs.mkdtempSync(path.join(tmp, "hoptell-preflight-"));
  try {
    fs.chmodSync(codexHome, 0o700);
    const penv = { ...env, CODEX_HOME: codexHome };
    const stat = (p) => run(command, ["sandbox", ...slots, "-P", plan.profileId, "-C", cwd, "--", "/usr/bin/stat", "-f", "%i", p], { env: penv, cwd: "/", timeout: 10_000 });
    const c = stat(cwd);
    if (c.error || c.status !== 0) return { problem: `the preflight could not stat the run's folder ${cwd} (${c.error ?? `exit ${c.status}`})` };
    for (const p of targets) {
      const r = stat(p);
      if (r.error) return { problem: `the preflight of ${p} failed (${r.error})` };
      if (r.status === 0 || !/Operation not permitted/.test(`${r.stdout}\n${r.stderr}`)) return { problem: `the preflight could stat ${p}, which must be denied` };
    }
    return null;
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

// ---- the cloud stream check ------------------------------------------------------------------------

/** The plain "(none)" outcome line of Codex's cloud config load. */
const NONE_RE = /Cloud config bundle load completed \(none\)/;
// eslint-disable-next-line no-control-regex -- terminal colour codes are what is removed
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The class of a log line: null when it is not a codex_cloud_config line; "none" for the "(none)"
 * outcome; "loaded" (a bundle with fragment counts), "cached" or "other". `counts`: the
 * key=number fields of a loaded line. The rest of the line is never kept.
 */
export function cloudLineClass(line) {
  const l = String(line).replace(ANSI, "");
  if (!/codex_cloud_config/.test(l)) return null;
  if (NONE_RE.test(l)) return { cls: "none" };
  if (/cached cloud config bundle/i.test(l)) return { cls: "cached" };
  if (/Cloud config bundle load completed/.test(l)) {
    const counts = Object.fromEntries([...l.matchAll(/\b([a-z_]+)=(\d+)\b/g)].filter(([, k]) => k !== "elapsed_ms").map(([, k, v]) => [k, Number(v)]));
    return { cls: "loaded", counts };
  }
  return { cls: "other" };
}

/**
 * The run note of a hardening run whose cloud-config stream was unexpected (any observed class:
 * missing_none, loaded, cached or other). It names no cause, since an `other` line has none known.
 */
export const CLOUD_NOTE = "Codex's cloud-config stream was unexpected. Path denial may not have applied as configured.";
