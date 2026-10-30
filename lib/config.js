// Shared settings: .env loading, peer-name rules, per-user state directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errnoWords } from "./words.js";

/** The settings file the last loadEnv() call read, or null when it found none. */
export let loadedEnvFile = null;
/** The variables the last loadEnv() call took from that file (the others came from the environment). */
export let loadedEnvKeys = new Set();

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "hoptell.js");

// Race and crash tests pause hoptell at named steps through barrier paths
// (HOPTELL_APPLY_TEST_BARRIER, HOPTELL_READER_TEST_BARRIER, HOPTELL_WAKE_TEST_BARRIER). They are
// read only in a source checkout, which has test/ next to lib/; the npm package ships no test/
// folder (package.json "files"), so an installed hoptell never reads them.
const CHECKOUT = fs.existsSync(path.join(ROOT, "test", "helpers.js"));
/** The test barrier path `HOPTELL_<kind>_TEST_BARRIER` in a source checkout, else null. */
export const testBarrier = (env, kind, checkout = CHECKOUT) => (checkout && env[`HOPTELL_${kind}_TEST_BARRIER`]) || null;
/** POSIX shell quoting for text shown as a command to run. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** This installation's CLI as a shell command (works without a global "hoptell" on PATH). */
export const cliCommand = () => `${shellQuote(process.execPath)} ${shellQuote(BIN)}`;
export const PROTOCOL = 1; // relay wire protocol version
export const MAX_ROLES = 16; // roles per peer
// The role of an injector's control connection (lib/control.js): plumbing, not an agent. Peer
// lists leave it out, and the relay's @role and @all sends never reach it.
export const CONTROL_ROLE = "hoptell-control";
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
      if (e.code !== "ENOENT" || explicit) throw new Error(`cannot read settings file ${file}: ${errnoWords(e)}`);
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
/** NAME_RE in words, the same everywhere a name is refused. */
export const NAME_RULE = 'a name is 1 to 64 letters, digits, "_" or "-", starting with a letter or digit';

export function checkName(name, what = "peer name") {
  if (!NAME_RE.test(name || "")) {
    throw new Error(`invalid ${what} "${name ?? ""}": ${NAME_RULE}`);
  }
  return name;
}

// A session's owner-only status (design 8, 3.2): text the relay keeps on the session's claim and
// lists only to sessions of the same member that ask for it. The relay never reads it; a lead's
// team summary (lib/teamstatus.js) is the one use today.
export const STATUS_MAX_BYTES = 8192;

// Session titles (design "readable session names"): a display-only label next to an address,
// never used for routing or authorization. The client cleans a title before sending it, the relay
// cleans it again, and every renderer cleans and escapes it once more.
export const TITLE_MAX_BYTES = 1024; // raw input over this is refused before any normalization
export const TITLE_MAX_CHARS = 80; // code points, the ellipsis included
// Removed: control characters (C0, DEL, C1), Bidi_Control (U+061C, U+200E/F, U+202A-E, U+2066-9)
// and every default-ignorable code point (zero-width characters, variation selectors, ...).
const TITLE_REMOVE = /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * A cleaned title, or null for none: not a string, over TITLE_MAX_BYTES UTF-8 bytes, or empty after
 * cleaning. NFC; the characters above removed; U+2028, U+2029 and other whitespace runs become one
 * space; trimmed; at most TITLE_MAX_CHARS code points (79 and "…" when cut). Unpaired surrogates
 * become U+FFFD.
 */
export function cleanTitle(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > TITLE_MAX_BYTES) return null;
  const s = raw.toWellFormed().normalize("NFC").replace(TITLE_REMOVE, "").replace(/\s+/gu, " ").trim();
  const cps = [...s];
  const out = cps.length > TITLE_MAX_CHARS ? `${cps.slice(0, TITLE_MAX_CHARS - 1).join("")}…` : s;
  return out || null;
}

/** Why a title given by the user would not be used, or null (for settings messages). */
export function titleProblem(raw) {
  if (typeof raw !== "string") return "must be text";
  if (Buffer.byteLength(raw, "utf8") > TITLE_MAX_BYTES) return `is longer than ${TITLE_MAX_BYTES} bytes`;
  if (!cleanTitle(raw)) return "is empty after removing control and invisible characters";
  return null;
}

// Letters that decomposition does not reduce to ASCII (design section 6, step 2).
const SLUG_MAP = { ı: "i", ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ł: "l", þ: "th" };

/**
 * The canonical ASCII stem of a text (design section 6): lowercase, the letters above mapped, NFKD
 * with combining marks dropped, every other character outside [a-z0-9_-] as "-", "-" squeezed,
 * leading characters that are not letters or digits and trailing "-" trimmed.
 */
export function slugTitle(text) {
  return String(text)
    .toLowerCase()
    .replace(/[ıßæœøđłþ]/g, (c) => SLUG_MAP[c])
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
}

/**
 * The visible addresses of one list, indexed once for the "resembles another address" mark: how
 * often each raw address and each address's slug occurs. Building it slugs every address once;
 * each lookup after that is constant work (one cleaning and one slug of the title). `slug`: the
 * slug function (tests count its calls).
 */
export function resemblanceIndex(addresses, { slug = slugTitle } = {}) {
  const raw = new Map();
  const slugs = new Map();
  const slugOf = new Map();
  for (const a of addresses) {
    if (typeof a !== "string") continue;
    raw.set(a, (raw.get(a) ?? 0) + 1);
    const s = slugOf.has(a) ? slugOf.get(a) : slug(a);
    slugOf.set(a, s);
    if (s) slugs.set(s, (slugs.get(s) ?? 0) + 1);
  }
  return { raw, slugs, slugOf, slug };
}

/**
 * Whether `title` equals, or slugs to, an address of `index` other than `own` (the row's own
 * address, which is in the index once and is subtracted, not filtered).
 */
export function resemblesIn(index, title, own = null) {
  const t = cleanTitle(title);
  if (!t) return false;
  const counted = own !== null && index.raw.has(own); // the row's own contribution, if indexed
  if ((index.raw.get(t) ?? 0) - (counted && t === own ? 1 : 0) > 0) return true;
  const s = index.slug(t);
  return s !== "" && (index.slugs.get(s) ?? 0) - (counted && s === index.slugOf.get(own) ? 1 : 0) > 0;
}

/** Whether a title equals one of `addresses`, or slugs to one (a single check; lists use resemblanceIndex). */
export const titleResembles = (title, addresses) => resemblesIn(resemblanceIndex(addresses), title);

/**
 * HOPTELL_TITLE: unset or empty -> null (no explicit title); "off" (any case) -> "off" (no title at
 * all); otherwise the cleaned text. Throws when the text cannot be used (too long, or nothing left
 * after cleaning).
 */
export function envTitle(env) {
  const raw = env.HOPTELL_TITLE;
  if (raw == null || String(raw).trim() === "") return null;
  if (String(raw).trim().toLowerCase() === "off") return "off";
  const problem = titleProblem(String(raw));
  if (problem) throw new Error(`HOPTELL_TITLE ${problem}; no title is sent (set a shorter text, or off)`);
  return cleanTitle(String(raw));
}

// The MCP client names of the CLIs hoptell knows, and the word the automatic title uses for each.
const CLIENT_WORDS = [
  [/claude/i, "Claude"],
  [/codex/i, "Codex"],
  [/antigravity|\bagy\b/i, "agy"],
  [/gemini/i, "Gemini"],
];

/**
 * The automatic session title "<client> · <folder>" (for example "Codex · hoptell"), from the MCP
 * client's self-reported name and the working folder's last part ("~" for the home folder itself,
 * so the account name is not shown). Either part alone when the other is missing; null for none.
 */
export function autoClientTitle(client, folder, home = null) {
  const raw = typeof client === "string" ? client : "";
  const word = CLIENT_WORDS.find(([re]) => re.test(raw))?.[1] ?? cleanTitle(raw.slice(0, 24));
  let place = null;
  if (typeof folder === "string" && folder) {
    const full = path.resolve(folder);
    place = home && full === path.resolve(home) ? "~" : cleanTitle(path.basename(full));
  }
  return cleanTitle([word, place].filter(Boolean).join(" · "));
}

/** "reviewer, backend" -> ["reviewer", "backend"], validated. */
/** HOPTELL_PROTOCOL: 2 (default; falls back to 1 on older relays) or 1 (always the legacy protocol). */
export function parseProtocol(value) {
  if (value == null || value === "" || value === "2") return 2;
  if (value === "1") return 1;
  throw new Error(`HOPTELL_PROTOCOL must be 1 or 2, not ${JSON.stringify(String(value).slice(0, 40))}`);
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

/**
 * HOPTELL_TITLE_AUTO: "on", "off", or "member" when unset (automatic titles only for a session the
 * relay authenticated as a member: a shared-token session publishes none). Who may see a published
 * title is the relay's list rule, as for the name. Throws like envSwitch for anything else.
 */
export function envTitleAuto(env) {
  if (String(env.HOPTELL_TITLE_AUTO ?? "").trim() === "") return "member";
  return envSwitch(env, "HOPTELL_TITLE_AUTO") ? "on" : "off";
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
 * HOPTELL_CONTACTS_SELF: whether the contacts hold messages from this session's own member (as the
 * relay authenticated both sides): "allow" (the default, also when unset) or "hold". Throws for
 * anything else: a misspelled "hold" is never taken as "allow".
 */
export function envContactsSelf(env) {
  const v = String(env.HOPTELL_CONTACTS_SELF ?? "").trim().toLowerCase();
  if (v === "" || v === "allow") return "allow";
  if (v === "hold") return "hold";
  throw new Error(`HOPTELL_CONTACTS_SELF must be allow or hold, not ${shownValue(env.HOPTELL_CONTACTS_SELF)}`);
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
