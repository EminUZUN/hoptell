// Shared settings: .env loading, peer-name rules, per-user state directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The settings file the last loadEnv() call read, or null when it found none. */
export let loadedEnvFile = null;
/** The variables the last loadEnv() call took from that file (the others came from the environment). */
export let loadedEnvKeys = new Set();

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "hoptell.js");
/** POSIX shell quoting for text shown as a command to run. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** This installation's CLI as a shell command (works without a global "hoptell" on PATH). */
export const cliCommand = () => `${shellQuote(process.execPath)} ${shellQuote(BIN)}`;
export const PROTOCOL = 1; // relay wire protocol version
export const MAX_ROLES = 16; // roles per peer
export const MAX_TTL_S = 7 * 86400; // longest message lifetime a sender can ask for
/** A message reference: the relay-assigned UUID of an accepted send (lowercase). */
export const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Settings files, first existing one wins: $HOPTELL_ENV, ~/.config/hoptell/.env, <package>/.env. */
export function envFiles() {
  if (process.env.HOPTELL_ENV) return [process.env.HOPTELL_ENV];
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return [path.join(xdg, "hoptell", ".env"), path.join(ROOT, ".env")];
}

/**
 * Load KEY=VALUE lines from the first settings file that exists. Variables
 * already set (non-empty) in the environment win, so a shell can override it;
 * an empty value counts as unset.
 */
export function loadEnv() {
  loadedEnvFile = null;
  loadedEnvKeys = new Set();
  let text = null;
  const explicit = Boolean(process.env.HOPTELL_ENV);
  for (const file of envFiles()) {
    try {
      text = fs.readFileSync(file, "utf8");
      loadedEnvFile = file;
      break;
    } catch (e) {
      // A missing default file is fine; anything else (EACCES, an explicit path) is an error.
      if (e.code !== "ENOENT" || explicit) throw new Error(`cannot read settings file ${file}: ${e.code || e.message}`);
    }
  }
  if (text == null) return;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue; // set and non-empty in the environment wins
    let v = m[2];
    if (/^".*"$/.test(v)) {
      // Double quotes: JSON-style escapes (\" \\ \n ...) are decoded, as many .env tools do.
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (/^'.*'$/.test(v)) v = v.slice(1, -1); // single quotes: literal
    else v = v.replace(/\s+#.*$/, "");
    process.env[m[1]] = v;
    loadedEnvKeys.add(m[1]);
  }
}

// No dots or colons: names double as file names and tmux session names.
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function checkName(name, what = "peer name") {
  if (!NAME_RE.test(name || "")) {
    throw new Error(`invalid ${what} "${name ?? ""}": use letters, digits, "_" and "-" (max 64, must start with a letter or digit)`);
  }
  return name;
}

/** "reviewer, backend" -> ["reviewer", "backend"], validated. */
/** HOPTELL_PROTOCOL: 2 (default; falls back to 1 on older relays) or 1 (always the legacy protocol). */
export function parseProtocol(value) {
  if (value == null || value === "" || value === "2") return 2;
  if (value === "1") return 1;
  throw new Error("HOPTELL_PROTOCOL: 1 or 2");
}

// Environment switches. A value that is not one of the accepted spellings is never taken silently:
// the switches that guard something (envSwitch, envAuth, envCredentialStore) are refused, naming
// the variable and the accepted values; the others (envChoice) report the value used instead.
const shownValue = (v) => JSON.stringify(String(v).slice(0, 40));
const SWITCH_ON = ["1", "true", "on", "yes"];
const SWITCH_OFF = ["0", "false", "off", "no"];

/** An on/off switch: on for 1, true, on or yes; off for 0, false, off, no or unset (any case). Throws for anything else. */
export function envSwitch(env, name) {
  const v = String(env[name] ?? "").trim().toLowerCase();
  if (v === "" || SWITCH_OFF.includes(v)) return false;
  if (SWITCH_ON.includes(v)) return true;
  throw new Error(`${name} must be on or off (1, true and yes also mean on; 0, false and no mean off), not ${shownValue(env[name])}`);
}

/** HOPTELL_AUTH: "token" (default) or "login". Throws for anything else. */
export function envAuth(env) {
  const v = String(env.HOPTELL_AUTH ?? "").trim().toLowerCase();
  if (v === "") return "token";
  if (v === "token" || v === "login") return v;
  throw new Error(`HOPTELL_AUTH must be token or login, not ${shownValue(env.HOPTELL_AUTH)}`);
}

/** HOPTELL_CREDENTIAL_STORE: "file", or "auto" (the OS keychain) when unset or "keychain". Throws for anything else. */
export function envCredentialStore(env) {
  const v = String(env.HOPTELL_CREDENTIAL_STORE ?? "").trim().toLowerCase();
  if (v === "" || v === "keychain") return "auto";
  if (v === "file") return "file";
  throw new Error(`HOPTELL_CREDENTIAL_STORE must be file or keychain (the default when unset), not ${shownValue(env.HOPTELL_CREDENTIAL_STORE)}`);
}

/**
 * A setting with a few accepted spellings whose fallback weakens nothing: `choices` maps each
 * accepted (lowercase) spelling to its value, and "" (unset) to the default. Returns {value,
 * warning}: for any other value, the default with a warning naming the variable and the value used.
 */
export function envChoice(env, name, choices) {
  const v = String(env[name] ?? "").trim().toLowerCase();
  if (Object.hasOwn(choices, v)) return { value: choices[v], warning: null };
  const accepted = Object.keys(choices).filter(Boolean);
  const used = Object.keys(choices).find((k) => k && choices[k] === choices[""]) ?? "the default";
  return { value: choices[""], warning: `${name} must be ${accepted.slice(0, -1).join(", ")}${accepted.length > 1 ? " or " : ""}${accepted.at(-1)}, not ${shownValue(env[name])}; using ${used}` };
}

/** HOPTELL_NOTIFY: desktop notifications, on unless "off". */
export const envNotify = (env) => envChoice(env, "HOPTELL_NOTIFY", { "": true, on: true, off: false });
/** HOPTELL_OWNER_CHANNEL: the owner channel (design 7.2), on unless "off". */
export const envOwnerChannel = (env) => envChoice(env, "HOPTELL_OWNER_CHANNEL", { "": true, on: true, off: false });
/** HOPTELL_ELICITATION: "read_inbox", or "off" (the default). */
export const envElicitation = (env) => envChoice(env, "HOPTELL_ELICITATION", { "": "off", off: "off", read_inbox: "read_inbox" });

export function parseRoles(value) {
  const roles = String(value || "").split(",").map((r) => r.trim()).filter(Boolean);
  for (const r of roles) checkName(r, "role");
  if (roles.includes("all")) throw new Error('"all" is reserved (@all addresses every peer)');
  return roles;
}

export const HOSTNAME =
  os.hostname().replace(/\.local$/, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[-_]+/, "").slice(0, 40) || "host";

/**
 * The automatic name of a protocol-1 session (the relay assigns none): host-pid, or host-pid-tag
 * for one of several sessions of one process (MCP over HTTP). The host part is shortened, never
 * the unique tail, so the name stays within 64 characters.
 */
export function legacyAutoName(host, n, tag = null) {
  const tail = tag ? `${n}-${tag}` : String(n);
  return `${String(host).slice(0, 64 - tail.length - 1)}-${tail}`;
}

/**
 * The per-user state directory (inboxes, profiles, sessions): HOPTELL_HOME, else ~/.hoptell.
 * Never a shared /tmp path. Callers pass the environment and home folder they captured.
 */
export function defaultHome(env, homedir) {
  return env.HOPTELL_HOME || path.join(homedir, ".hoptell");
}

/** Create `dir` if needed and make sure only the current user can use it. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user; refusing to use it`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}
