// Shared settings: .env loading, peer-name rules, per-user state directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The settings file the last loadEnv() call read, or null when it found none. */
export let loadedEnvFile = null;

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
export function parseRoles(value) {
  const roles = String(value || "").split(",").map((r) => r.trim()).filter(Boolean);
  for (const r of roles) checkName(r, "role");
  if (roles.includes("all")) throw new Error('"all" is reserved (@all addresses every peer)');
  return roles;
}

export const HOSTNAME =
  os.hostname().replace(/\.local$/, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[-_]+/, "").slice(0, 40) || "host";

/** Per-user state directory (inboxes). Never a shared /tmp path. */
export function stateDir() {
  return process.env.HOPTELL_HOME || path.join(os.homedir(), ".hoptell");
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
