// Several relays per engine (design 2.1): the relays file and addresses of the form name@alias.
// Pure functions: the caller passes the environment, the home directory and file readers.
import fs from "node:fs";
import path from "node:path";
import { NAME_RE } from "./config.js";

export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_ALIAS = "default";

const FILE_MAX = 64 * 1024;
const TOKEN_MAX = 4096;

/** A private regular file of bounded size, or a distinct error ("missing", "unreadable", ...). */
function readPrivate(file, max, { readFile, stat }) {
  let st;
  try {
    st = stat(file);
  } catch (e) {
    throw new Error(e.code === "ENOENT" ? `${file} is missing` : `${file} cannot be read (${e.code ?? "error"})`);
  }
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${file} is readable by other users; chmod 600 it`);
  if (st.size > max) throw new Error(`${file} is larger than ${max} bytes`);
  try {
    return String(readFile(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} cannot be read (${e.code ?? "error"})`);
  }
}

/**
 * Read and check the relays file (startup only). Root problems throw (nothing routes): not
 * readable, not JSON, wrong version, no list, duplicate aliases. Entry problems are reported per
 * entry and the valid siblings stay usable. Returns {relays: [{alias, url, auth, token,
 * tokenProblem, profile, join, name}], default, problems: [{alias, problem}]}.
 */
export function readRelaysFile(file, { env, homedir, readFile = fs.readFileSync, stat = fs.statSync }) {
  let doc;
  try {
    doc = JSON.parse(readPrivate(file, FILE_MAX, { readFile, stat }));
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `${file}: invalid JSON` : e.message);
  }
  if (doc?.version !== 1 || !Array.isArray(doc.relays) || !doc.relays.length) throw new Error(`${file}: expected {"version": 1, "relays": [...]}`);
  const aliases = doc.relays.map((r) => r?.alias);
  const dup = aliases.find((a, i) => typeof a === "string" && aliases.indexOf(a) !== i);
  if (dup) throw new Error(`${file}: the alias "${dup}" is used twice`);
  const relays = [];
  const problems = [];
  const profiles = new Map(); // profile -> url
  const expand = (p) => (p.startsWith("~/") ? path.join(homedir, p.slice(2)) : path.resolve(path.dirname(file), p));
  for (const [i, r] of doc.relays.entries()) {
    const alias = typeof r?.alias === "string" ? r.alias : `#${i + 1}`;
    const bad = (problem) => problems.push({ alias, problem });
    if (!ALIAS_RE.test(r?.alias ?? "")) {
      bad("alias must be lowercase letters, digits and \"-\", up to 32 characters");
      continue;
    }
    let url;
    try {
      url = new URL(r.url);
      if (!["ws:", "wss:"].includes(url.protocol)) throw new Error();
    } catch {
      bad("url must be a ws:// or wss:// URL");
      continue;
    }
    if ("token" in r) {
      bad("put the token in tokenFile or tokenEnv, not in the relays file");
      continue;
    }
    const auth = r.auth ?? "token";
    if (!["token", "login"].includes(auth)) {
      bad("auth must be token or login");
      continue;
    }
    const sources = ["tokenFile", "tokenEnv"].filter((k) => r[k] !== undefined);
    if (auth === "token" && sources.length !== 1) {
      bad("auth token needs exactly one of tokenFile or tokenEnv");
      continue;
    }
    if (auth === "login" && sources.length) {
      bad("auth login takes no token (sign in with hoptell login)");
      continue;
    }
    if (r.name !== undefined && !NAME_RE.test(r.name)) {
      bad("name must be a valid peer name");
      continue;
    }
    // namePrefix: this session's name with a prefix on that relay (a member's names must start with
    // the member name, for example "me-" on the local relay), unless `name` is set.
    if (r.namePrefix !== undefined && !(typeof r.namePrefix === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}-$/.test(r.namePrefix))) {
      bad('namePrefix must be letters, digits, "_" and "-", ending in "-"');
      continue;
    }
    if (r.profile !== undefined && typeof r.profile !== "string") {
      bad("profile must be text");
      continue;
    }
    const href = url.href.replace(/\/$/, "");
    if (r.profile) {
      if (profiles.has(r.profile) && profiles.get(r.profile) !== href) {
        bad(`the profile "${r.profile}" is already used for ${profiles.get(r.profile)}`);
        continue;
      }
      profiles.set(r.profile, href);
    }
    let token = null;
    let tokenProblem = null;
    if (auth === "token") {
      if (r.tokenFile !== undefined) {
        try {
          token = readPrivate(expand(String(r.tokenFile)), TOKEN_MAX, { readFile, stat }).replace(/\r?\n$/, "");
          if (!token) tokenProblem = `${expand(String(r.tokenFile))} is empty`;
        } catch (e) {
          tokenProblem = e.message;
        }
      } else {
        token = env[r.tokenEnv] || null;
        if (!token) tokenProblem = `${r.tokenEnv} is not set or empty`;
      }
      if (tokenProblem) token = null;
    }
    const join = r.join !== false;
    // Two receiving entries for the same relay and name would compete for one store.
    const twin = join && relays.find((x) => x.join && x.url === href && (x.name ?? null) === (r.name ?? null));
    if (twin) {
      bad(`it receives on the same relay and name as "${twin.alias}"; give one of them another name or join: false`);
      continue;
    }
    relays.push({ alias, url: href, auth, token, tokenProblem, profile: r.profile ?? null, join, name: r.name ?? null, namePrefix: r.namePrefix ?? null });
  }
  const def = doc.default ?? (relays.length === 1 ? relays[0].alias : null);
  const usable = (a) => relays.some((r) => r.alias === a && !r.tokenProblem);
  if (def !== null && !usable(def)) problems.push({ alias: String(def), problem: "the default names no usable relay; bare addresses are refused" });
  return { relays, default: usable(def) ? def : null, problems };
}

/**
 * Parse an address: "name", "name@alias", "@role", "@role@alias", "@all", "@all@alias".
 * Returns {kind: "peer"|"role"|"all", target, alias|null} or throws with a readable reason.
 */
export function parseAddress(to) {
  const s = String(to ?? "").trim();
  const m = /^(@?)([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:@([a-z0-9][a-z0-9-]{0,31}))?$/.exec(s);
  if (!m) throw new Error(`"${s.slice(0, 80)}" is not an address: use a peer name, @role or @all, optionally followed by @<relay alias>`);
  const [, at, target, alias = null] = m;
  if (!at) return { kind: "peer", target, alias };
  return { kind: target === "all" ? "all" : "role", target, alias };
}

/**
 * The relay an address goes to. A bare address goes to the default relay only (never resolved by
 * who is online); with several relays and no default it is refused.
 */
export function routeOf(address, { aliases, defaultAlias }) {
  const a = parseAddress(address);
  if (a.alias) {
    if (!aliases.includes(a.alias)) throw new Error(`no relay "${a.alias}"; relays: ${aliases.join(", ")}`);
    return { ...a, relay: a.alias };
  }
  if (!defaultAlias) throw new Error(`say which relay: ${a.kind === "peer" ? a.target : `@${a.target}`}@<alias> (relays: ${aliases.join(", ")})`);
  return { ...a, relay: defaultAlias };
}

/** How an address is shown: with "@alias" only when there is more than one relay. */
export const labelOf = (name, alias, several) => (several ? `${name}@${alias}` : name);
