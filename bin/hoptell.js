#!/usr/bin/env node
// hoptell: let AI coding agents (Claude Code, Codex, ...) message each other
// across sessions, machines and accounts through a small self-hosted relay.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOSTNAME, NAME_RE, NAME_RULE, REF_RE, checkName, defaultHome, envAuth, envContactsSelf, envCredentialStore, envNotify, envSwitch, loadEnv, parseProtocol, parseRoles, testBarrier } from "../lib/config.js";
import { profileKey } from "../lib/profiles.js";
import { memberOfStoreDir, storeParts } from "../lib/session.js";
import { errnoWords, plural, wrap } from "../lib/words.js";

// Claude Code hook commands (lib/wake.js) print only what Claude Code expects, never errors.
const HOOKS = { "hook-session-start": "hookSessionStart", "hook-file-changed": "hookFileChanged", "hook-user-prompt-submit": "hookUserPromptSubmit" };
if (Object.hasOwn(HOOKS, process.argv[2] ?? "")) {
  let code = 0;
  try {
    const i = process.argv.indexOf("--home", 3);
    if (i > 0 && process.argv[i + 1]) process.env.HOPTELL_HOME = process.argv[i + 1];
    loadEnv();
    const wake = await import("../lib/wake.js");
    code = wake[HOOKS[process.argv[2]]]({ home: defaultHome(process.env, os.homedir()), env: process.env, barrier: testBarrier(process.env, "WAKE") });
  } catch {
    code = 0;
  }
  process.exit(code);
}

// A client's headers helper for hoptell mcp-http: prints {"X-Hoptell-Hook-Registration": id} for
// the Claude Code process it runs under, or {} (never an error: the client then has no hooks).
// `hook-header --help` prints its help (Claude Code never passes it).
if (process.argv[2] === "hook-header" && !process.argv.slice(3).some((a) => a === "--help" || a === "-h")) {
  let out = {};
  try {
    const i = process.argv.indexOf("--home", 3);
    if (i > 0 && process.argv[i + 1]) process.env.HOPTELL_HOME = process.argv[i + 1];
    loadEnv();
    const wake = await import("../lib/wake.js");
    out = wake.hookHeader({ home: defaultHome(process.env, os.homedir()) });
  } catch {}
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

// --help or -h anywhere before a lone "--", and --version: printed before anything else runs (no
// settings read, no state created, no connection). An option a command does not know is refused.
{
  const cli = await import("../lib/clihelp.js");
  const argv = process.argv.slice(2);
  const p = cli.preflight(argv);
  const print = async (text, code) => {
    await new Promise((resolve) => (code ? process.stderr : process.stdout).write(`${text}\n`, resolve));
    process.exit(code);
  };
  if (p?.version) await print(`hoptell ${cli.version()}`, 0);
  if (p?.unknown) await print(`hoptell: no help for ${JSON.stringify(String(p.unknown).slice(0, 40))} (see hoptell --help)`, 2);
  if (p) await print(p.help ? cli.commandHelp(p.help, p.args) : cli.usage(), 0);
  const bad = cli.unknownFlag(argv[0], argv.slice(1));
  const where = `hoptell ${argv[0]}${argv[0] === "relay" && ["admin", "apps", "broker-reset"].includes(argv[1]) ? ` ${argv[1]}` : ""}`;
  if (bad) await print(`hoptell: unknown option ${bad} for ${where} (see hoptell ${argv[0]} --help)`, 2);
  const empty = cli.missingValue(argv[0], argv.slice(1));
  if (empty) await print(`hoptell: ${empty} needs a value (see ${where} --help); nothing was done`, 2);
}

// `hoptell mcp --run <id> --home <home>` (design 7.1): a spawned agent's server reads the run's own
// settings file, never the environment's or the owner's default one.
let mcpRun = null;
if (process.argv[2] === "mcp" && process.argv.includes("--run")) {
  const m = await import("../lib/mcp.js");
  try {
    mcpRun = m.prepareRunEnv(process.argv.slice(3), process.env);
  } catch (e) {
    console.error(`hoptell: ${e.message}`);
    process.exit(2);
  }
  // The record first: nothing of the run (not even its settings file) is read for a run that
  // does not verify.
  const v = await m.verifyRun(mcpRun.home, mcpRun.run);
  if (v.problem) {
    console.error(`[hoptell] not serving: ${v.problem}`);
    process.exit(1);
  }
}

try {
  loadEnv();
} catch (e) {
  console.error(`hoptell: ${e.message}`);
  process.exit(1);
}


/** A byte size: a whole number of bytes, or with a unit (KiB, MiB, GiB; K, M, G mean the same). */
function parseSize(v) {
  const m = /^\s*(\d{1,15})\s*(B|K|KB|KIB|M|MB|MIB|G|GB|GIB)?\s*$/i.exec(String(v));
  if (!m) return null;
  const unit = { "": 1, B: 1, K: 1024, KB: 1024, KIB: 1024, M: 1024 ** 2, MB: 1024 ** 2, MIB: 1024 ** 2, G: 1024 ** 3, GB: 1024 ** 3, GIB: 1024 ** 3 }[(m[2] ?? "").toUpperCase()];
  const n = Number(m[1]) * unit;
  return Number.isSafeInteger(n) ? n : null;
}

const fail = (msg, code = 1) => {
  console.error(`hoptell: ${msg}`);
  process.exit(code);
};

const [cmd, ...args] = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  // --subject=<value>: a value that starts with "--" (clihelp's EQUALS_FLAGS).
  const eq = flag === "--subject" ? args.find((a) => a.startsWith(`${flag}=`)) : undefined;
  return eq ? eq.slice(flag.length + 1) || fallback : fallback;
};
/** A port option: a whole number from 0 to 65535 (0: any free port), else refused (exit 2). */
const portOpt = (flag, fallback) => {
  const v = opt(flag);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v) || Number(v) > 65535) fail(`invalid ${flag}: a port number from 0 to 65535`, 2);
  return Number(v);
};
/** A seconds argument: a whole number from 1 to 2147483 (a timer's limit), else refused (exit 2); absent: the default. */
const secondsArg = (v, fallback, usage) => {
  if (v === undefined) return fallback;
  if (!/^\d{1,7}$/.test(v) || Number(v) < 1 || Number(v) > 2_147_483) fail(`invalid seconds "${String(v).slice(0, 40)}": a whole number from 1 to 2147483 (${usage})`, 2);
  return Number(v);
};
// Unset HOPTELL_NAME: a protocol-2 relay assigns the name (<member>-<host>-cli for sending); the protocol-1
// fallback uses <host>-cli as before.
// The CLI is an entry point: it reads its settings from the environment (after loadEnv) here.
const home = () => defaultHome(process.env, os.homedir());
const leaseMinutes = () => {
  const v = String(process.env.HOPTELL_LEASE_MINUTES ?? "").trim();
  if (v === "") return 30;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1440) fail("HOPTELL_LEASE_MINUTES must be a whole number from 1 to 1440");
  return n;
};
const relayChoice = () => ({ relayUrl: process.env.HOPTELL_RELAY, protocol: parseProtocol(process.env.HOPTELL_PROTOCOL), profile: process.env.HOPTELL_PROFILE || null });
const cliName = () => (process.env.HOPTELL_NAME ? checkName(process.env.HOPTELL_NAME, "HOPTELL_NAME") : null);

/** HOPTELL_RELAY is set and is a URL the client can connect to (the WebSocket library's rules). Throws. */
function checkRelayUrl() {
  const v = process.env.HOPTELL_RELAY;
  if (!v) throw new Error("HOPTELL_RELAY is not set (e.g. ws://192.0.2.10:7777): set it in the environment or your hoptell settings file; hoptell --help lists the file locations");
  const shown = `"${v.slice(0, 80)}"`;
  if (!URL.canParse(v)) throw new Error(`HOPTELL_RELAY is not a URL: ${shown} (e.g. ws://192.0.2.10:7777)`);
  const u = new URL(v);
  if (!["ws:", "wss:", "http:", "https:", "ws+unix:"].includes(u.protocol)) throw new Error(`HOPTELL_RELAY ${shown} must start with ws://, wss://, http:// or https://`);
  if (u.protocol === "ws+unix:" && !u.pathname) throw new Error(`HOPTELL_RELAY ${shown} names no socket path`);
  if (u.hash) throw new Error(`HOPTELL_RELAY ${shown} must not contain a fragment (#...)`);
}

/**
 * The settings a relay connection needs, checked before the home's contacts are opened (a command
 * that cannot connect creates nothing): the relay's URL, the protocol, the profile, HOPTELL_AUTH (token or login, as
 * for agent sessions), the name and, for a peer, the roles. Throws.
 */
function checkPeerSettings(mode) {
  checkRelayUrl();
  if (parseProtocol(process.env.HOPTELL_PROTOCOL) === 2) profileKey(process.env.HOPTELL_RELAY, process.env.HOPTELL_PROFILE || null);
  envAuth(process.env);
  cliName();
  if (mode === "peer") parseRoles(process.env.HOPTELL_ROLES);
}

/** Device keys and enrollment (design 3.2) are experimental: off unless HOPTELL_EXPERIMENTAL_E2EE=1 (a value that is not on or off is refused). */
const experimentalE2ee = () => {
  try {
    return envSwitch(process.env, "HOPTELL_EXPERIMENTAL_E2EE");
  } catch (e) {
    fail(e.message);
  }
};
/** A switch that guards something (HOPTELL_REQUIRE_MEMBERS, HOPTELL_OWNER_APP, ...): a value that is not on or off is refused. */
const envOnOff = (name) => {
  try {
    return envSwitch(process.env, name);
  } catch (e) {
    fail(e.message);
  }
};
/** HOPTELL_CREDENTIAL_STORE: "file" or "auto" (the OS keychain); a misspelled value is refused. */
const credentialStoreOrFail = () => {
  try {
    return envCredentialStore(process.env);
  } catch (e) {
    fail(e.message);
  }
};
/** HOPTELL_NOTIFY: an unaccepted value is reported once and notifications stay on. */
let notifyWarned = false;
const notifyOn = () => {
  const { value, warning } = envNotify(process.env);
  if (warning && !notifyWarned) console.error(`hoptell: ${warning}`);
  notifyWarned = true;
  return value;
};

const CONNECT_BUDGET_MS = 30_000; // send and list: retry an unreachable relay this long

/**
 * Connect to the relay. `onMessage` is attached before connecting, so queued messages are not
 * missed. Transient failures (relay restarting, network drop, slow proxy) are retried with
 * backoff for `budgetMs`, and later drops reconnect; a refused token or name, or another
 * session taking the name, still stops at once (a CLI command never fights an agent session).
 */
// The home's contacts (design 1.5): opened before anything creates state, so a new install is
// recognized as one.
let contactsPromise = null;
const contactsOf = () =>
  (contactsPromise ??= import("../lib/quarantine.js").then((q) =>
    q.openContacts(home(), { notify: notifyOn(), log: (...a) => console.error("hoptell:", ...a), self: envContactsSelf(process.env) }),
  ));
const relayProfileOf = async () => {
  if (!process.env.HOPTELL_RELAY) return null;
  const { profileKey } = await import("../lib/profiles.js");
  try {
    return profileKey(process.env.HOPTELL_RELAY, process.env.HOPTELL_PROFILE || null);
  } catch {
    return null;
  }
};
/** The receiving session of a bound store folder or a legacy name, as the policy names it. */
const sessionOfDir = (dir) => {
  const rel = storeParts(home(), dir);
  return rel[0] === "v2" ? { realm: rel[1], name: rel[3] } : { realm: null, name: rel[1] };
};
/** The own member of a session store folder (v2/<realm>/<member folder>/<key>; lib/session.js memberDir), or null. */
const memberOfDir = (dir) => memberOfStoreDir(home(), dir);

/** The access-token source of this relay profile (HOPTELL_AUTH=login, after hoptell login). */
async function signInSource() {
  const { tokenSource } = await import("../lib/login.js");
  return tokenSource({ home: home(), relayUrl: process.env.HOPTELL_RELAY, profile: await profileOfRelay(), passphrase: process.env.HOPTELL_CREDENTIAL_PASSPHRASE || null });
}
async function profileOfRelay() {
  if (!process.env.HOPTELL_RELAY) fail("HOPTELL_RELAY is not set");
  const { profileKey } = await import("../lib/profiles.js");
  return profileKey(process.env.HOPTELL_RELAY, process.env.HOPTELL_PROFILE || null);
}

// The relay settings as they were before any relay was chosen. selectRelay starts from them on
// every call, so a relay entry's namePrefix applies once however often a command chooses.
const RELAY_KEYS = ["HOPTELL_RELAY", "HOPTELL_AUTH", "HOPTELL_TOKEN", "HOPTELL_PROFILE", "HOPTELL_NAME"];
let relayBase = null;

/**
 * Several relays (design 2.1): choose the relay for this command from --relay or the address's
 * @relay (they must agree), else the default, and point this process's settings at it.
 */
async function selectRelay(addressAlias = null, given = undefined) {
  const i = args.indexOf("--relay");
  const flag = given !== undefined ? given : i >= 0 ? args[i + 1] : null;
  if (given === undefined && i >= 0) args.splice(i, 2);
  const file = process.env.HOPTELL_RELAYS || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hoptell", "relays.json");
  if (!process.env.HOPTELL_RELAYS && !fs.existsSync(file)) {
    if (flag || addressAlias) fail("name@relay and --relay need a relays file (HOPTELL_RELAYS; see README)", 2);
    return null;
  }
  if (flag && addressAlias && flag !== addressAlias) fail(`--relay ${flag} and the address's @${addressAlias} disagree`, 2);
  const { readRelaysFile } = await import("../lib/relays.js");
  const r = readRelaysFile(file, { env: process.env, homedir: os.homedir() });
  const alias = flag ?? addressAlias ?? r.default;
  if (!alias) fail(`say which relay: --relay <alias> or name@<alias> (relays: ${r.relays.map((x) => x.alias).join(", ")})`, 2);
  const e = r.relays.find((x) => x.alias === alias);
  if (!e) fail(`no relay "${alias}" in ${file}`, 2);
  if (e.tokenProblem) fail(`relay ${alias}: ${e.tokenProblem}`);
  relayBase ??= Object.fromEntries(RELAY_KEYS.map((k) => [k, process.env[k]]));
  const name = relayBase.HOPTELL_NAME;
  process.env.HOPTELL_RELAY = e.url;
  process.env.HOPTELL_AUTH = e.auth;
  if (e.auth === "token") process.env.HOPTELL_TOKEN = e.token;
  else delete process.env.HOPTELL_TOKEN;
  if (e.profile) process.env.HOPTELL_PROFILE = e.profile;
  else delete process.env.HOPTELL_PROFILE;
  if (e.name) process.env.HOPTELL_NAME = e.name;
  else if (e.namePrefix && name) process.env.HOPTELL_NAME = `${e.namePrefix}${name}`.slice(0, 64);
  else if (name === undefined) delete process.env.HOPTELL_NAME;
  else process.env.HOPTELL_NAME = name;
  return { relays: r, entry: e, qualified: Boolean(flag || addressAlias) };
}

/**
 * Send `text` to `to` as this CLI's name (hoptell send, hoptell review request): the relay choice,
 * the reply rule, the owner channel's guard and the contacts' encryption policy. Returns the line
 * that describes the relay's answer. `die(message, code)` refuses (fail by default).
 */
async function sendText(to, text, { ttl, replyTo, relayFlag = null, die = fail, chosen = null } = {}) {
  const { describeAck } = await import("../lib/client.js");
  const at = /^(@?[A-Za-z0-9][A-Za-z0-9_-]{0,63})@([a-z0-9][a-z0-9-]{0,31})$/.exec(to);
  if (at) to = at[1];
  // `chosen` ({sel}): a relay chosen once for several sends (hoptell review request).
  const sel = chosen ? chosen.sel : await selectRelay(at?.[2] ?? null, relayFlag);
  if (sel && replyTo) {
    // The same reply rule as agent sessions: the reference must have come through this relay.
    const { checkReply, routesStore } = await import("../lib/routes.js");
    const { profileKey } = await import("../lib/profiles.js");
    const prof = (x) => {
      try {
        return profileKey(x.url, x.profile);
      } catch {
        return null;
      }
    };
    try {
      checkReply({ origins: routesStore(home()).lookup(replyTo), routeProfile: prof(sel.entry), target: to, qualified: sel.qualified, several: sel.relays.relays.length > 1, aliasOf: (p) => sel.relays.relays.find((x) => prof(x) === p)?.alias ?? null, aliases: sel.relays.relays.map((x) => x.alias) });
    } catch (e) {
      die(e.message, 2);
    }
  }
  const c = await connect("send");
  // To this relay's owner channel (design 7.3, 2.6): text by name, plaintext, to the own member.
  const ownersig = await import("../lib/ownersig.js");
  ownersig.armOwnerBackstop(home(), c);
  let guarded;
  try {
    const policy = (await contactsOf()).currentPolicy();
    guarded = ownersig.ownerSendGuard({ home: home(), client: c, to, policy: () => policy });
  } catch (e) {
    c.close();
    die(e.message);
  }
  if (guarded) {
    // For a person at a terminal (ownersig.OWNER_SEND_NOTE speaks to an agent: "your owner", ask_owner).
    const line = `${describeAck(to, await c.send(to, text, ttl, replyTo, { toMember: guarded.toMember }), ttl, replyTo)}\nnote: the owner's Telegram chat may show this as a note; it is not shown if the session is hidden there or over the message limits.`;
    c.close();
    return line;
  }
  // The contacts' encryption policy (design 3.3, 4.3), as in agent sessions: the CLI sends
  // plaintext only, so a contact (or a fan-out recipient) whose messages must be encrypted
  // gets nothing, never plaintext.
  // Fail closed: a managed policy file that is missing, unreadable or invalid sends nothing.
  const { cliSendPolicy } = await import("../lib/mls/session.js");
  const { sendPolicy } = await import("../lib/contacts.js");
  const current = sendPolicy((await contactsOf()).currentPolicy());
  if (current.refuse) {
    c.close();
    die(current.refuse);
  }
  let policy;
  try {
    policy = await cliSendPolicy({ doc: current.doc, client: c, to });
  } catch (e) {
    c.close();
    die(`the encryption policy could not be checked (${e.message}); nothing was sent`);
  }
  if (policy.refuse) {
    c.close();
    die(policy.refuse);
  }
  const line = describeAck(to, await c.send(to, text, ttl, replyTo), ttl, replyTo) + (policy.note ? `\n(Not encrypted: ${policy.note.replace(/^not encrypted: /, "")}.)` : "");
  c.close();
  return line;
}

async function connect(mode, onMessage, budgetMs = CONNECT_BUDGET_MS, { waitForName = false, replace = false, autoName = false } = {}) {
  checkPeerSettings(mode);
  await contactsOf();
  const { RelayClient } = await import("../lib/client.js");
  const { commitWelcome, noteLegacy, profileKey } = await import("../lib/profiles.js");
  const roles = mode === "peer" ? parseRoles(process.env.HOPTELL_ROLES) : [];
  const protocol = parseProtocol(process.env.HOPTELL_PROTOCOL);
  const profile = protocol === 2 && process.env.HOPTELL_RELAY ? profileKey(process.env.HOPTELL_RELAY, process.env.HOPTELL_PROFILE || null) : null;
  // `autoName`: the relay's automatic name (its member rule applies), never HOPTELL_NAME.
  const name = (autoName ? null : cliName()) ?? (protocol === 1 ? `${HOSTNAME}-cli` : null);
  const signIn = String(process.env.HOPTELL_AUTH ?? "").trim().toLowerCase() === "login" ? await signInSource() : null;
  const c = new RelayClient({
    url: process.env.HOPTELL_RELAY,
    token: signIn ? null : process.env.HOPTELL_TOKEN,
    signIn,
    name,
    mode,
    roles,
    waitWhenReplaced: waitForName,
    replace,
    protocol,
    onWelcome: (w) => (w.realm ? commitWelcome(home(), profile, { realm: w.realm.id, member: w.member }) : undefined),
    onLegacy: () => noteLegacy(home(), profile),
  });
  // Only this machine sets "e2ee" and "owner" on a message (lib/quarantine.js fromRelay): a relay's never count.
  const { fromRelay } = onMessage ? await import("../lib/quarantine.js") : {};
  if (onMessage) c.on("message", (m, confirm) => onMessage(fromRelay(m), confirm, c));
  c.start();
  try {
    await c.ready(budgetMs);
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}

try {
  switch (cmd) {
    case "login": {
      // login [--issuer <url|broker id>] [--mode broker|resource] [--device] [--client-credentials --client-id <id> --client-secret-file <file>] [--store file]
      const { checkSignInUrl, login } = await import("../lib/login.js");
      // The options are checked before anything is read, created or asked of the relay.
      if (!process.env.HOPTELL_RELAY) fail("HOPTELL_RELAY is not set");
      const loginUsage = "usage: hoptell login [--issuer <url|broker id>] [--mode broker|resource] [--device | --client-credentials --client-id <id> --client-secret-file <file>] [--store file]";
      if (opt("--mode") !== undefined && !["broker", "resource"].includes(opt("--mode"))) fail("--mode must be broker or resource", 2);
      if (opt("--store") !== undefined && opt("--store") !== "file") fail("--store takes only file (the default is the OS keychain)", 2);
      const cc = args.includes("--client-credentials");
      if (cc && args.includes("--device")) fail(`use --device or --client-credentials, not both\n${loginUsage}`, 2);
      if (cc && (!opt("--client-id") || !opt("--client-secret-file"))) fail(`--client-credentials needs --client-id <id> and --client-secret-file <file>\n${loginUsage}`, 2);
      if (!cc && (opt("--client-id") !== undefined || opt("--client-secret-file") !== undefined)) fail(`--client-id and --client-secret-file go with --client-credentials\n${loginUsage}`, 2);
      const stray = args.find((a, i) => !a.startsWith("--") && !["--issuer", "--mode", "--client-id", "--client-secret-file", "--store"].includes(args[i - 1]));
      if (stray !== undefined) fail(`login does not take ${JSON.stringify(String(stray).slice(0, 40))}\n${loginUsage}`, 2);
      const service = cc ? { clientId: opt("--client-id"), clientSecret: fs.readFileSync(opt("--client-secret-file"), "utf8").trim() } : null;
      let storeOfEnv;
      try {
        checkRelayUrl();
        checkSignInUrl(process.env.HOPTELL_RELAY);
        storeOfEnv = envCredentialStore(process.env); // a misspelled store is refused, also with --store file
      } catch (e) {
        fail(e.message);
      }
      const profile = await profileOfRelay();
      await contactsOf(); // classify the home first, as every command that creates state does
      const r = await login({
        relayUrl: process.env.HOPTELL_RELAY,
        home: home(),
        profile,
        issuer: opt("--issuer") ?? null,
        signInMode: opt("--mode") ?? null,
        mode: service ? "service" : args.includes("--device") ? "device" : "browser",
        service,
        store: opt("--store") === "file" ? "file" : storeOfEnv,
        passphrase: process.env.HOPTELL_CREDENTIAL_PASSPHRASE || null,
      });
      console.log(`Signed in with ${r.issuer} (${r.kind === "service" ? "client credentials" : r.kind === "broker" ? `your account, through the relay (broker ${r.broker})` : "your account"}).\nThe credential is kept in the ${r.store}.\nNext: set HOPTELL_AUTH=login for this relay.`);
      break;
    }
    case "logout": {
      const { logout } = await import("../lib/login.js");
      const r = await logout({ home: home(), profile: await profileOfRelay(), passphrase: process.env.HOPTELL_CREDENTIAL_PASSPHRASE || null });
      if (!r.removed) console.log("Not signed in for this relay.");
      else {
        const rev = r.revoked === true ? (r.kind === "broker" ? "ended at the relay" : "revoked at the identity provider") : r.revoked === "unsupported" ? "the identity provider does not offer revocation" : r.revoked === false ? (r.kind === "broker" ? "ending it at the relay failed" : "revoking it at the identity provider failed") : "a service credential (nothing to revoke)";
        console.log(wrap(`Signed out: the stored credential was removed (${rev}). Running sessions stop at their next renewal; access tokens already issued stay valid at the relay until they expire.`));
      }
      break;
    }
    case "grants": {
      // grants [show] | allow <selector> [--until <seconds>] | deny <selector> | deny-forever member:<id>
      //        | remove <selector> | default allow|deny | visible all|grantees | publish   (publish with --yes)
      const [sub = "show", arg] = args.filter((a, i) => !a.startsWith("--") && !["--until", "--rev", "--relay"].includes(args[i - 1]));
      // A selector the relay would refuse is refused before the preview, not only at --yes.
      if (["allow", "deny", "deny-forever", "remove"].includes(sub) && arg !== undefined) {
        const { SELECTOR_RE } = await import("../lib/access.js");
        if (!SELECTOR_RE.test(arg) || (sub === "deny-forever" && !arg.startsWith("member:"))) {
          fail(`"${arg}" is not a ${sub === "deny-forever" ? "member selector: use member:<id>" : "selector: use '*' (quote it), group:<name> or member:<id>"}; a member id looks like m_ followed by 26 letters and digits (a message's Sender line shows it)`, 2);
        }
      }
      // The command's shape, --until and --rev are checked before anything is opened or asked.
      const grantsUsage = "usage: hoptell grants [show] | allow|deny <'*'|group:<name>|member:<id>> [--until <seconds>] | deny-forever member:<id> | remove <selector> | default allow|deny | visible all|grantees | publish [--yes --rev N]";
      const shaped = sub === "show" || (sub === "publish" && arg === undefined) || (["allow", "deny", "remove"].includes(sub) && arg) || (sub === "deny-forever" && arg?.startsWith("member:")) || (sub === "default" && ["allow", "deny"].includes(arg)) || (sub === "visible" && ["all", "grantees"].includes(arg));
      if (!shaped) {
        const needs = { allow: "a selector", deny: "a selector", remove: "a selector", "deny-forever": "a member:<id> selector", default: "allow or deny", visible: "all or grantees" }[sub];
        fail(`${needs ? `grants ${sub} needs ${needs}` : `unknown grants command ${JSON.stringify(String(sub).slice(0, 40))}`}\n${grantsUsage}`, 2);
      }
      const untilArg = opt("--until");
      if (untilArg !== undefined && !(Number.isSafeInteger(Number(untilArg)) && Number(untilArg) > 0)) fail("--until needs a number of seconds", 2);
      if (args.includes("--yes") && !/^\d+$/.test(opt("--rev") ?? "")) fail("--yes needs --rev <revision> from the preview", 2);
      await selectRelay();
      const c = await connect("send");
      try {
        const got = await c.rpc({ type: "grants_get" });
        const cur = got.grants;
        // After a relay restore that lost the access state (design 4.4), the relay waits for this
        // member to publish its grants again: until then, sends to it fail as for an unknown name.
        const pendingNote = () =>
          got.pending
            ? `\nThe relay was restored from a backup and lost its record of your latest grants. Until you publish them again,\nsends to your sessions fail with "unknown peer" and queued messages wait. If the grants above are what you want,\npublish them as they are with: hoptell grants publish --yes --rev ${cur.revision}\n(or change them first with the commands in hoptell grants --help).`
            : "";
        const show = (g) => {
          console.log(`Revision ${g.revision ?? "?"}: default ${g.default}; visible to ${g.visible === "grantees" ? "those you allow only" : "everyone"}.`);
          for (const e of g.entries) console.log(`  ${e.action.padEnd(5)} ${e.selector}${e.until ? ` until ${new Date(e.until).toISOString()}` : ""}${e.requests === "blocked" ? " (no contact requests)" : ""}`);
          if (!g.entries.length) console.log("  (no entries)");
        };
        if (sub === "show") {
          show(cur);
          if (got.pending) console.log(pendingNote());
          break;
        }
        const others = (sel) => cur.entries.filter((e) => e.selector !== sel);
        const until = untilArg !== undefined ? Date.now() + Number(untilArg) * 1000 : undefined;
        let next;
        if (sub === "allow" && arg) next = { ...cur, entries: [...others(arg), { selector: arg, action: "allow", ...(until ? { until } : {}) }] };
        else if (sub === "deny" && arg) next = { ...cur, entries: [...others(arg), { selector: arg, action: "deny", ...(until ? { until } : {}) }] };
        else if (sub === "deny-forever" && arg?.startsWith("member:")) next = { ...cur, entries: [...others(arg), { selector: arg, action: "deny", requests: "blocked" }] };
        else if (sub === "remove" && arg) next = { ...cur, entries: others(arg) };
        else if (sub === "default" && ["allow", "deny"].includes(arg)) next = { ...cur, default: arg };
        else if (sub === "visible" && ["all", "grantees"].includes(arg)) next = { ...cur, visible: arg };
        else if (sub === "publish") next = { ...cur }; // the same grants again (after a relay restore)
        else fail(grantsUsage, 2);
        console.log("These grants say who may reach your sessions through this relay (your machine's contacts decide too).");
        show({ ...next, revision: `${cur.revision} -> ${cur.revision + 1}` });
        if (!args.includes("--yes")) {
          // With --until the end time is computed again when publishing, so the preview is not exact.
          console.log(`Nothing published yet. Run the same command with --yes --rev ${cur.revision} to publish it.${untilArg !== undefined ? " A --until duration starts when you publish." : ""}`);
          break;
        }
        const { revision, entries, ...rest } = next;
        void revision;
        // Published only against the revision the owner previewed: a change made meanwhile (another
        // session or machine) refuses, so nothing unseen is overwritten.
        const rev = opt("--rev");
        if (rev === undefined || !/^\d+$/.test(rev)) fail(`--yes needs --rev <revision> from the preview (now ${cur.revision})`, 2);
        if (Number(rev) !== cur.revision) fail(`the grants changed since that preview (revision ${rev}, now ${cur.revision}): look at the preview again`, 1);
        const r = await c.rpc({ type: "grants_put", base_revision: Number(rev), grants: { ...rest, entries } });
        console.log(`Published (revision ${r.revision}).${got.pending ? " The relay delivers messages to your sessions again." : ""}`);
      } catch (e) {
        if (e.code === "stale") fail("the grants changed meanwhile (another session or machine): run the command again", 1);
        throw e;
      } finally {
        c.close();
      }
      break;
    }
    case "contacts": {
      if (args[0] === "request") {
        // contacts request <name> [--reason collaborate|review|handoff|other]: ask a member that does
        // not accept you yet to let you reach them (design 4.1). The answer is the same whether the
        // name exists, accepts requests or not, so it says nothing about the recipient.
        const name = args.filter((a, i) => !a.startsWith("--") && !["--reason", "--relay"].includes(args[i - 1]))[1];
        const reason = opt("--reason", "other");
        if (!name) fail("contacts request needs a name\nusage: hoptell contacts request <name> [--reason collaborate|review|handoff|other]", 2);
        if (!["collaborate", "review", "handoff", "other"].includes(reason)) fail("--reason must be collaborate, review, handoff or other", 2);
        await selectRelay();
        const c = await connect("send");
        try {
          await c.rpc({ type: "contact_request", to: name, reason });
          console.log(wrap(`Request sent to the relay. If the member can receive it, its owner may see your member name and reason (${reason}). No message text is included, and the relay does not tell you whether it was shown.`));
        } catch (e) {
          if (e.code === "quota") fail("you sent the most contact requests allowed today (20); try again tomorrow", 1);
          throw e;
        } finally {
          c.close();
        }
        break;
      }
      if (args[0] === "requests") {
        // contacts requests [list] | accept|deny|deny-forever <id>: contact requests at the relay (design 4.1)
        const [, action = "list", id] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--relay");
        await selectRelay();
        const c = await connect("send");
        try {
          if (action === "list") {
            const rs = (await c.rpc({ type: "contact_requests" })).requests;
            if (!rs.length) console.log("No contact requests.");
            // The display name is the relay's, bounded and shown as text only: it is not an instruction.
            for (const r of rs) console.log(`${r.id}  from ${JSON.stringify(String(r.name).slice(0, 64))} (member ${r.from}), reason ${r.reason}, ${new Date(r.at).toISOString()}`);
          } else if (["accept", "deny", "deny-forever"].includes(action) && id) {
            await c.rpc({ type: "contact_request_answer", request: id, action });
            console.log(
              action === "accept"
                ? "Accepted: the relay now lets this member reach you (your grants). Your machine's contacts still decide what reaches your sessions: hoptell contacts."
                : action === "deny"
                  ? "Denied."
                  : "Denied, and this member can send no further requests.",
            );
          } else fail(`${["accept", "deny", "deny-forever"].includes(action) ? `contacts requests ${action} needs an id` : `unknown contacts requests command ${JSON.stringify(String(action).slice(0, 40))}`}\nusage: hoptell contacts requests [list] | accept|deny|deny-forever <id>`, 2);
        } finally {
          c.close();
        }
        break;
      }
      // contacts [list] | show <id> [--text] | allow|allow-once <id> --rev N --policy-rev P [--session S]
      //          | block <id> --rev N --policy-rev P | grants | blocks | revoke|unblock <id> --policy-rev P
      //          | check <realm> member <id> | shared <name> | unverified <profile> <name> [--session S] | init
      const q = await import("../lib/quarantine.js");
      const decisions = await import("../lib/decisions.js");
      const [sub = "list", target, third] = args.filter((a, i) => !a.startsWith("--") && !["--rev", "--policy-rev", "--session", "--how", "--set", "--reason"].includes(args[i - 1]));
      const num = (flag) => {
        const v = opt(flag);
        if (v === undefined || !/^\d+$/.test(v)) fail(`${flag} <number> is required (shown by hoptell contacts show)`, 2);
        return Number(v);
      };
      // A usage error is said before the home's contacts are opened (which creates them in a new home).
      if (!["list", "show", "allow", "allow-once", "block", "grants", "blocks", "revoke", "unblock", "check", "verify", "accept-device", "forget-device", "encryption", "init"].includes(sub)) fail(`unknown contacts command "${sub}" (see hoptell contacts --help)`, 2);
      if (sub === "show" && !target) fail("contacts show needs an id\nusage: hoptell contacts show <id> [--text]", 2);
      if (["allow", "allow-once", "block"].includes(sub)) {
        if (!target) fail(`contacts ${sub} needs an id\nusage: hoptell contacts ${sub} <id> --rev N --policy-rev P${sub === "block" ? "" : " [--session <scope>]"}`, 2);
        num("--rev");
        num("--policy-rev");
      }
      if (sub === "revoke" || sub === "unblock") {
        if (!target) fail(`contacts ${sub} needs an id\nusage: hoptell contacts ${sub} <id> --policy-rev P`, 2);
        num("--policy-rev");
      }
      if (["verify", "accept-device", "forget-device"].includes(sub) && !experimentalE2ee()) fail(`hoptell contacts ${sub} is experimental (device keys). To try it, set HOPTELL_EXPERIMENTAL_E2EE=1`, 2);
      if (sub === "encryption" && !experimentalE2ee()) fail("hoptell contacts encryption is experimental (encrypted messages). To try it, set HOPTELL_EXPERIMENTAL_E2EE=1", 2);
      if (["verify", "accept-device", "forget-device", "encryption"].includes(sub)) credentialStoreOrFail(); // the device store, before the contacts are opened
      const deviceUsage = { verify: "usage: hoptell contacts verify <member id> [--yes --how in-person|out-of-band --set <code>] | <member id> --conversation", "accept-device": "usage: hoptell contacts accept-device <member id> <device> [--set <code>]", "forget-device": "usage: hoptell contacts forget-device <member id> <device> [--set <code>]" }[sub];
      if (deviceUsage && (!target || (sub !== "verify" && !third))) fail(`contacts ${sub} needs a member id${sub === "verify" ? "" : " and a device"}\n${deviceUsage}`, 2);
      if (sub === "verify" && !args.includes("--conversation")) {
        // The confirmation's own arguments (the device set's code is compared later, with the relay's
        // list); exit 1, as when the confirmation itself refused them.
        if (opt("--how") !== undefined && !["in-person", "out-of-band"].includes(opt("--how"))) fail(`--how in-person or --how out-of-band says how you compared the safety number\n${deviceUsage}`);
        if (args.includes("--yes") && (opt("--how") === undefined || opt("--set") === undefined)) fail(`--yes needs --how in-person|out-of-band and --set <code>\n${deviceUsage}`);
      }
      const encryptionUsage = "usage: hoptell contacts encryption <member id> | --default  required|preferred|off|clear  (for the current relay's realm)";
      const encryptionArgs = () => {
        const pos = args.filter((a) => !a.startsWith("--"));
        return args.includes("--default") ? [null, pos[1]] : [pos[1], pos[2]];
      };
      if (sub === "encryption") {
        const [who, mode] = encryptionArgs();
        if (!who && !args.includes("--default")) fail(`contacts encryption needs a member id or --default\n${encryptionUsage}`, 2);
        if (!["required", "preferred", "off", "clear"].includes(mode)) fail(`contacts encryption needs a mode: required, preferred, off or clear\n${encryptionUsage}`, 2);
      }
      if (sub === "check") {
        const [, realmOrProfile, kind, a1] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--session");
        if (!((kind === "member" || kind === "shared") && a1) && !(realmOrProfile === "unverified" && kind && a1)) fail("contacts check is missing an argument\nusage: hoptell contacts check <realm> member <id> | <realm> shared <name> | unverified <profile> <name> [--session <realm>/<name>]", 2);
      }
      const c = await contactsOf();
      const where = `contacts of ${home()}`;
      try {
        if (sub === "list") {
          const st = await c.status();
          const pol = st.policy;
          console.log(`hoptell ${where}: ${st.mode === "legacy-allow" ? "not managed yet (every sender reaches your sessions as before); run hoptell contacts init" : pol.problem ? `managed, but ${pol.problem}: every sender waits for your decision` : `managed (default: ${pol.doc.default}, unverified senders: ${pol.doc.unverified ?? "ask"}), policy revision ${st.policyRevision}`}`);
          if (!st.requests.length) console.log("No messages are waiting for your decision.");
          for (const r of st.requests) console.log(`${r.id}  ${r.sender.label}  ${plural(r.items, "message")} for ${r.sessions.join(", ")}  since ${r.created}${r.dropped ? `  (${r.dropped} dropped over the limits)` : ""}`);
          if (st.withheld) console.log(`${st.withheld === 1 ? "1 earlier message is" : `${st.withheld} earlier messages are`} withheld until the quarantine has room.`);
          if (st.journalsWaiting) console.log(`${st.journalsWaiting === 1 ? "1 decision is" : `${st.journalsWaiting} decisions are`} waiting for room in an inbox.`);
          if (st.requests.length) console.log("Next: hoptell contacts show <id>");
        } else if (sub === "show") {
          if (!target) fail("contacts show needs an id\nusage: hoptell contacts show <id> [--text]", 2);
          // Through the decision service; printed from its view (the CLI's tokens are --rev/--policy-rev).
          const shown = await decisions.show({ home: home(), id: `contact:${target}`, sources: { contacts: c }, text: args.includes("--text") });
          if (shown.refused || shown.busy) fail(shown.reason);
          const r = { id: target, rev: shown.nativeToken.rev, policyRevision: shown.nativeToken.policyRev, sender: shown.view.sender, items: shown.view.items.map((i, n) => (shown.text ? { ...i, text: shown.text[n].text } : i)) };
          console.log(`${r.id}  ${r.sender.label}  (${r.sender.auth === "member" ? `member ${r.sender.member} of realm ${r.sender.realm}, authenticated by the relay` : r.sender.auth === "shared" ? `shared-token sender in realm ${r.sender.realm}: any token holder can use this name` : `unverified: the relay ${r.sender.relay ?? ""} does not authenticate senders`})`);
          for (const i of r.items) {
            console.log(`- for ${i.session}, ${i.arrived}, ${i.bytes} bytes`);
            if (i.text !== undefined) console.log(`  --- untrusted peer text ---\n  ${String(i.text ?? "(unreadable)").replace(/\n/g, "\n  ")}\n  --- end of peer text ---`);
          }
          const scopeHint = new Set(r.items.map((i) => i.session)).size > 1 ? " [--session <one of the sessions above>]" : "";
          console.log(`\nDecide with --rev ${r.rev} --policy-rev ${r.policyRevision}:`);
          // Plaintext from a contact whose encryption is required: allowing is refused, so only
          // blocking is offered (or a change of that contact's encryption setting).
          if (shown.view.violation) console.log(`  (These messages are unencrypted, and this contact's encryption is required: they can only be blocked, or released after you set this contact's encryption to preferred or off (hoptell contacts encryption ${r.sender.member} preferred).)`);
          else {
            if (r.sender.auth !== "unverified") console.log(`  hoptell contacts allow ${r.id} --rev ${r.rev} --policy-rev ${r.policyRevision}${scopeHint}   (always: adds a grant)`);
            console.log(`  hoptell contacts allow-once ${r.id} --rev ${r.rev} --policy-rev ${r.policyRevision}${scopeHint}   (only these messages)`);
          }
          console.log(`  hoptell contacts block ${r.id} --rev ${r.rev} --policy-rev ${r.policyRevision}   (deletes them; blocks the sender)`);
        } else if (["allow", "allow-once", "block"].includes(sub)) {
          if (!target) fail(`contacts ${sub} needs an id\nusage: hoptell contacts ${sub} <id> --rev N --policy-rev P${sub === "block" ? "" : " [--session <scope>]"}`, 2);
          const token = { rev: num("--rev"), policyRev: num("--policy-rev") };
          const d = await decisions.decide({ home: home(), id: `contact:${target}`, action: sub, token, options: { session: opt("--session") ?? null }, sources: { contacts: c } });
          if (d.stale) fail(`request ${target} changed since it was shown (now --rev ${d.nativeToken.rev} --policy-rev ${d.nativeToken.policyRev}); show it again before deciding`);
          if (d.refused || d.busy) fail(d.reason);
          const r = d.effects;
          console.log(`${sub === "block" ? "Blocked; its messages were deleted." : `Released ${r.steps} message${r.steps === 1 ? "" : "s"}${sub === "allow" ? " and added a grant" : ""}.`}${r.waiting ? " Some wait for room in a full inbox and are released when there is room." : ""}`);
        } else if (sub === "grants" || sub === "blocks") {
          const { doc, problem } = c.currentPolicy();
          if (!doc) fail(problem ?? "no policy yet: run hoptell contacts init");
          console.log(`Policy revision ${doc.revision ?? 0}:`);
          for (const e of doc[sub] ?? []) console.log(`${e.id ?? "(no id)"}  ${e.member ? `member ${e.member}` : e.shared ? `shared ${e.name}` : `unverified ${e.relay}/${e.name}`}${e.realm ? ` in ${e.realm}` : ""}${e.session ? ` for ${e.session.realm}/${e.session.name}` : ""}${e.added ? `  (${e.added})` : ""}`);
          if (!(doc[sub] ?? []).length) console.log(`No ${sub}.`);
        } else if (sub === "revoke" || sub === "unblock") {
          if (!target) fail(`contacts ${sub} needs an id\nusage: hoptell contacts ${sub} <id> --policy-rev P`, 2);
          await (sub === "revoke" ? c.revoke(target, { policyRev: num("--policy-rev") }) : c.unblock(target, { policyRev: num("--policy-rev") }));
          console.log(sub === "revoke" ? "Grant removed." : "Block removed.");
        } else if (sub === "check") {
          const { decide } = await import("../lib/contacts.js");
          const pos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--session");
          const [, realmOrProfile, kind, a1] = pos;
          let key;
          if (kind === "member" && a1) key = { realm: realmOrProfile, member: a1 };
          else if (kind === "shared" && a1) key = { realm: realmOrProfile, shared: true, name: a1 };
          else if (realmOrProfile === "unverified" && kind && a1) key = { unverified: true, relay: kind, name: a1 };
          else fail("contacts check is missing an argument\nusage: hoptell contacts check <realm> member <id> | <realm> shared <name> | unverified <profile> <name> [--session <realm>/<name>]", 2);
          const s = opt("--session");
          const session = s ? (s.startsWith("legacy/") ? { realm: null, name: s.slice(7) } : { realm: s.split("/")[0], name: s.split("/")[1] }) : null;
          const p = c.currentPolicy();
          console.log(p.legacy ? "allow (not managed yet)" : decide(p.doc, key, session));
        } else if (sub === "verify" || sub === "accept-device" || sub === "forget-device") {
          // Device pins (design 3.2): EXPERIMENTAL, only with HOPTELL_EXPERIMENTAL_E2EE=1.
          if (!experimentalE2ee()) fail(`hoptell contacts ${sub} is experimental (device keys). To try it, set HOPTELL_EXPERIMENTAL_E2EE=1`, 2);
          const { verifyCommand, conversationCommand } = await import("../lib/mls/cli.js");
          // The encrypted conversation's checkpoint (design 3.3), for comparing histories.
          if (sub === "verify" && args.includes("--conversation")) await conversationCommand({ member: target, home: home(), profile: await profileOfRelay(), env: process.env });
          else await verifyCommand({ sub, member: target, device: third, yes: args.includes("--yes"), how: opt("--how") ?? null, set: opt("--set") ?? null, home: home(), profile: await profileOfRelay(), connect: () => connect("send", null), contacts: c });
        } else if (sub === "encryption") {
          // The require-encryption policy (design 3.3): EXPERIMENTAL, only with HOPTELL_EXPERIMENTAL_E2EE=1.
          if (!experimentalE2ee()) fail("hoptell contacts encryption is experimental (encrypted messages). To try it, set HOPTELL_EXPERIMENTAL_E2EE=1", 2);
          const [who, mode] = encryptionArgs();
          if (!who && !args.includes("--default")) fail(`contacts encryption needs a member id or --default\n${encryptionUsage}`, 2);
        if (!["required", "preferred", "off", "clear"].includes(mode)) fail(`contacts encryption needs a mode: required, preferred, off or clear\n${encryptionUsage}`, 2);
          const rc = await connect("send", null);
          const realmId = rc.realm?.id;
          rc.close();
          if (!realmId) fail("the relay did not name its realm (protocol 2 is needed)");
          await c.setEncryption({ realm: realmId, member: who, mode: mode === "clear" ? null : mode });
          console.log(`${who ? `Encryption with ${who}` : "The realm's default encryption"} is now ${mode === "clear" ? "unset" : mode} (EXPERIMENTAL).`);
        } else if (sub === "init") {
          const r = await c.init();
          console.log(r.already ? `The ${where} are already managed.` : wrap(`The ${where} are now managed: senders without a grant wait for your decision (hoptell contacts). Nobody was granted. Messages already waiting in your sessions' inboxes are held back on their next read.`));
        } else fail(`unknown contacts command "${sub}" (see hoptell contacts --help)`, 2);
      } catch (e) {
        if (e instanceof q.DecisionError) fail(e.message);
        throw e;
      }
      break;
    }
    case "ui": {
      // ui [--port N] [--open]: the owner UI (design 3.4), loopback only, in the foreground.
      const port = Number(opt("--port", "0"));
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port: a port number from 0 to 65535", 2);
      if (args.includes("--host") && opt("--host") !== "127.0.0.1") fail("hoptell ui binds 127.0.0.1 only", 2);
      const { loadedEnvFile, loadedEnvKeys } = await import("../lib/config.js");
      const { settingsContext } = await import("../lib/decisions.js");
      const { startOwnerUi } = await import("../lib/ownerui.js");
      // The switches it uses are checked before the contacts are opened (a new home stays untouched).
      if (experimentalE2ee()) credentialStoreOrFail();
      const contacts = await contactsOf();
      const sources = { contacts, agents: { homedir: os.homedir(), env: process.env, surface: "ui" } };
      // The relay (HOPTELL_RELAY) is reached only for what lives there: contact requests, and the
      // device lists with experimental device keys. Without it those views say so.
      if (process.env.HOPTELL_RELAY) {
        sources.relay = {
          contactRequests: async () => {
            const c = await connect("send", null, 10_000);
            try {
              return (await c.rpc({ type: "contact_requests" })).requests;
            } finally {
              c.close();
            }
          },
        };
        if (experimentalE2ee()) {
          const { fetchDevices, fetchOwnDevices, storeFor } = await import("../lib/mls/cli.js");
          const profile = await profileOfRelay();
          sources.devices = {
            fetch: (member) => fetchDevices(() => connect("send", null, 10_000), member),
            // This member's own devices, and which one is this home's (from its local record).
            own: async () => ({ list: await fetchOwnDevices(() => connect("send", null, 10_000)), thisDevice: (await storeFor({ home: home(), profile, env: process.env })).record()?.device ?? null }),
          };
          // The encrypted conversation's checkpoint (design 3.3), read from this device's records.
          sources.conversation = {
            checkpoint: async (member) => {
              const { createE2ee } = await import("../lib/mls/e2ee.js");
              const store = await storeFor({ home: home(), profile, env: process.env });
              if (!store.record()) return null;
              return createE2ee({ store, driver: store.driver, client: null, session: null, home: home(), profile }).checkpoint(member);
            },
          };
        }
      }
      const relaysFile = process.env.HOPTELL_RELAYS || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hoptell", "relays.json");
      const ui = await startOwnerUi({
        home: home(),
        port,
        sources,
        ctx: settingsContext({ env: process.env, fromFile: loadedEnvKeys, envFile: loadedEnvFile, relaysFile }),
        log: (m) => console.error(`hoptell: ${m}`),
        onIdle: () => {
          console.log("Closed after 30 minutes without a request.");
          process.exit(0);
        },
      });
      const link = ui.launchUrl();
      // The launch link is the one secret this command prints: single use, valid 60 seconds.
      console.log(`hoptell ui is running at ${ui.origin}\nOpen this link within 60 seconds (it works once):\n\n  ${link}\n\nPress Ctrl-C to stop.`);
      if (args.includes("--open")) {
        const { spawn } = await import("node:child_process");
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? null : "xdg-open";
        if (opener) spawn(opener, [link], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      }
      for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => ui.close().finally(() => process.exit(0)));
      break;
    }
    case "local-relay": {
      // local-relay install [--port N] | start | stop | status | uninstall [--purge]
      const lr = await import("../lib/localrelay.js");
      const words = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
      const sub = words[0] ?? "status";
      const lrUsage = "usage: hoptell local-relay install [--port 7788]|start|stop|status|uninstall [--purge]";
      // --port goes with install and --purge with uninstall only; nothing else is taken.
      if (words.length > 1) fail(`local-relay takes one command\n${lrUsage}`, 2);
      if (args.includes("--port") && sub !== "install") fail(`--port goes with local-relay install only\n${lrUsage}`, 2);
      if (args.includes("--purge") && sub !== "uninstall") fail(`--purge goes with local-relay uninstall only\n${lrUsage}`, 2);
      const relaysFile = process.env.HOPTELL_RELAYS || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hoptell", "relays.json");
      const o = { home: home(), homedir: os.homedir(), relaysFile, env: process.env };
      if (sub === "install") {
        const r = await lr.installLocalRelay({ ...o, port: opt("--port") ?? undefined });
        console.log(`The local relay runs at ${r.url} (service ${r.service}). Its token is in ${r.tokenFile}, readable only by you.`);
        console.log(r.alias ? `Sessions reach it as relay "${r.alias}" (${r.relaysFile}): address peers there as name@${r.alias}.` : `To use it: HOPTELL_RELAY=${r.url} and HOPTELL_TOKEN=$(cat ${r.tokenFile}).`);
      } else if (sub === "start" || sub === "stop") {
        await lr.controlLocalRelay(o, sub);
        console.log(sub === "start" ? "Started." : "Stopped (the service starts it again at the next login).");
      } else if (sub === "status") {
        const st = await lr.localRelayStatus(o);
        if (!st.installed) console.log("Not installed. Install it with: hoptell local-relay install");
        else {
          console.log(`${st.url}: service ${st.loaded ? "loaded" : "not loaded"}, ${st.signedIn ? "its token signs in" : st.healthy ? "answering" : "not answering"}; token in ${st.tokenFile}`);
          for (const p of st.problems) console.log(`warning: ${p}`);
          if (!st.signedIn || st.problems.length) process.exitCode = 1;
        }
      } else if (sub === "uninstall") {
        const r = await lr.uninstallLocalRelay(o, { purge: args.includes("--purge") });
        console.log(r.removed ? `Removed the service${r.entryRemoved ? " and its relays entry" : ""}${r.purged ? ", the token and the realm state" : "; the token and the realm state are kept (--purge removes them)"}.` : "Not installed.");
        if (r.note) console.log(`note: ${r.note}.`);
      } else fail(`unknown local-relay command ${JSON.stringify(String(sub).slice(0, 40))}\n${lrUsage}`, 2);
      break;
    }
    case "members": {
      const [sub, name, third] = args.filter((a, i) => !a.startsWith("--") && !["--members", "--state-dir", "--host", "--issuer", "--subject"].includes(args[i - 1]));
      // The command word is checked first: a typo is named before the members file is asked for.
      if (!["list", "add", "revoke", "signout", "link", "unlink", "device-revoke", "device-approve", "add-hosted", "host", "migrate"].includes(sub)) fail(sub === undefined ? "members needs a command (see hoptell members --help)" : `unknown members command ${JSON.stringify(String(sub).slice(0, 40))} (see hoptell members --help)`, 2);
      const file = opt("--members", process.env.HOPTELL_MEMBERS);
      if (!file) fail("set HOPTELL_MEMBERS or pass --members <file> (the relay's members file)", 2);
      const m = await import("../lib/members.js");
      // Every change is recorded in the relay's audit log (design 4.4): an intent before the file is
      // edited (refused: nothing is touched), then the running relay reloads it and records the
      // result; with the relay stopped this command records it. The relay's state directory:
      // --state-dir, HOPTELL_STATE_DIR, or the default.
      const { auditedChange, appliedNote } = await import("../lib/admincli.js");
      const { defaultStateDir } = await import("../lib/realm.js");
      const changeOf = (action, target, change) =>
        auditedChange({ stateDir: opt("--state-dir", process.env.HOPTELL_STATE_DIR) || defaultStateDir(), config: { members: file, policy: process.env.HOPTELL_POLICY || null, oidc: process.env.HOPTELL_OIDC || null }, action, target, change, e2ee: experimentalE2ee() });
      // A name the file would refuse is refused before the relay's state (its audit log) is opened.
      if ((sub === "add" || sub === "add-hosted") && name && !NAME_RE.test(name)) fail(`invalid member name "${name}": ${NAME_RULE}`);
      if (sub === "list") {
        const rows = m.listMembers(file);
        if (!rows.length) console.log("No members.");
        for (const r of rows) console.log(`${r.name}\t${r.id ?? "(no id: run hoptell members migrate)"}\t${r.custody === "hosted" ? `hosted by ${r.host}` : `${r.token} token`}`);
      } else if (sub === "add" && name) {
        const c = await changeOf("members.add", name, () => m.addMember(file, name));
        const r = c.value;
        console.log(`Added member "${r.name}" (${r.id}).\nToken, shown only now:\n\n  ${r.token}\n\nGive it to ${r.name} privately. ${file} keeps only its SHA-256.\n${r.name}'s sessions may use the names ${r.name} and ${r.name}-<anything>.\n${appliedNote(c)}`);
      } else if (sub === "revoke" && name) {
        const c = await changeOf("members.revoke", name, () => m.revokeMember(file, name));
        console.log(`Removed member "${name}". ${appliedNote(c)}${c.online && c.outcome === "ok" ? " Its connections are closed." : ""}`);
      } else if (sub === "signout" && name) {
        const c = await changeOf("members.signout", name, () => m.signoutMember(file, name));
        console.log(`Broker sign-ins of "${name}" made until now end when the relay applies it. ${appliedNote(c)}`);
      } else if ((sub === "link" || sub === "unlink") && name) {
        const c = await changeOf(`members.${sub}`, name, () => m.linkMember(file, name, { issuer: opt("--issuer"), subject: opt("--subject"), unlink: sub === "unlink" }));
        console.log(sub === "unlink" ? `Unlinked that identity from "${name}". ${appliedNote(c)}` : c.value.already ? `"${name}" already has that identity.` : `Linked: "${name}" may now sign in with that identity. ${appliedNote(c)}`);
      } else if (sub === "device-revoke" && name && third) {
        if (!experimentalE2ee()) fail("hoptell members device-revoke is experimental (device keys). To try it, set HOPTELL_EXPERIMENTAL_E2EE=1", 2);
        const c = await changeOf("members.device-revoke", `${name}/${third}`, () => m.revokeMemberDevice(file, name, third));
        console.log(c.value.already ? `Device ${third} of "${name}" is already revoked.` : `Revoked device ${third} of "${name}": once the relay applies it, it no longer serves that device's KeyPackages or directory entry. ${appliedNote(c)}`);
      } else if (sub === "device-approve" && name && third) {
        // A12: the relay admin approves a new device's pending request when none of the member's
        // devices can (all suspended, or all lost); over the admin channel, audited.
        if (!experimentalE2ee()) fail("hoptell members device-approve is experimental (device keys). To try it, set HOPTELL_EXPERIMENTAL_E2EE=1", 2);
        const words = args.filter((a, i) => !a.startsWith("--") && !["--members", "--state-dir"].includes(args[i - 1]));
        const fingerprint = words.slice(3).join(" ");
        if (!fingerprint) fail("members device-approve needs the fingerprint the new device shows\nusage: hoptell members device-approve <member> <device> <fingerprint>", 2);
        const { adminCommand } = await import("../lib/admincli.js");
        process.exitCode = await adminCommand({ args: ["devices", "approve", name, third, fingerprint, ...(args.includes("--json") ? ["--json"] : [])], stateDir: opt("--state-dir", process.env.HOPTELL_STATE_DIR) || defaultStateDir(), config: { members: file, policy: process.env.HOPTELL_POLICY || null, oidc: process.env.HOPTELL_OIDC || null }, e2ee: true });
      } else if (sub === "add-hosted" && name) {
        // Hosted custody (design 4.5, experimental): a new member held by a host; never an existing one.
        const c = await changeOf("members.add-hosted", name, () => m.addHostedMember(file, name, opt("--host")));
        console.log(`${wrap(`Added hosted member "${name}" (${c.value.id}) held by host "${c.value.host}". It has no token: only that host signs in for it, and peers see it labeled hosted (the host can read its messages).`)}\n${appliedNote(c)}`);
      } else if (sub === "host" && name === "list") {
        const rows = m.listHosts(file);
        if (!rows.length) console.log("No hosts.");
        for (const r of rows) console.log(`${r.id}\t${r.token} token`);
      } else if (sub === "host" && name === "add" && third) {
        const c = await changeOf("members.host-add", third, () => m.addHost(file, third));
        console.log(`Added host "${third}".\nToken, shown only now:\n\n  ${c.value.token}\n\nConfigure it on that host privately. ${file} keeps only its SHA-256.\nIt may open only members hosted by "${third}".\n${appliedNote(c)}`);
      } else if (sub === "host" && name === "remove" && third) {
        const c = await changeOf("members.host-remove", third, () => m.removeHost(file, third));
        console.log(`Removed host "${third}". ${appliedNote(c)}`);
      } else if (sub === "migrate") {
        const pending = m.migrateMembers(file, { apply: false });
        const p = (await pending).pending;
        if (!p.length) console.log("Every member already has an id.");
        else if (!args.includes("--yes")) {
          console.log(`Members without an id: ${p.join(", ")}.\n${wrap("Giving them ids changes their identity on the relay: their sessions reconnect and messages queued for them are dropped. Run again with --yes to do it.")}`);
        } else {
          const c = await changeOf("members.migrate", null, () => m.migrateMembers(file, { apply: true }));
          console.log(`Gave ids to: ${c.value.pending.join(", ")}. ${appliedNote(c)}`);
        }
      } else fail(`members ${sub} is missing an argument (see hoptell members --help)`, 2);
      break;
    }
    case "relay": {
      const { defaultStateDir } = await import("../lib/realm.js");
      const stateDirOf = () => opt("--state-dir", process.env.HOPTELL_STATE_DIR) || defaultStateDir();
      const configFiles = () => ({ members: opt("--members", process.env.HOPTELL_MEMBERS) || null, policy: opt("--policy", process.env.HOPTELL_POLICY) || null, oidc: opt("--oidc", process.env.HOPTELL_OIDC) || null });
      if (args[0] === "admin") {
        // The relay owner's commands (design 4.4): over the admin socket, or offline with the lock.
        const { adminCommand } = await import("../lib/admincli.js");
        // Tests only: a real crash at a restore point, set by a preload in test/ (never by the environment).
        const crash = globalThis[Symbol.for("hoptell.test.restoreCrash")] || null;
        process.exitCode = await adminCommand({ args: args.slice(1), stateDir: stateDirOf(), config: configFiles(), e2ee: experimentalE2ee() || args.includes("--experimental-e2ee"), testFault: crash ? (p) => p === crash && process.kill(process.pid, "SIGKILL") : null });
        break;
      }
      if (args[0] === "broker-reset") {
        // Explicit, with the relay stopped (the state lock): a new refresh key, every broker sign-in ended.
        if (!args.includes("--yes")) fail("hoptell relay broker-reset ends every broker sign-in of this relay (users run hoptell login again); run it with --yes, while the relay is stopped", 2);
        const { auditedChange } = await import("../lib/admincli.js");
        const dir = stateDirOf();
        const { value: n } = await auditedChange({ stateDir: dir, config: configFiles(), action: "relay.broker-reset", online: false, change: async () => (await import("../lib/broker.js")).brokerReset(dir) });
        console.log(`Broker sign-in reset: a new refresh key, ${n} sign-in${n === 1 ? "" : "s"} ended.`);
        break;
      }
      if (args[0] === "apps") {
        // The owner channel's Mini App ids (design 7.4, section 2), with the relay stopped (the state lock).
        const { appsAdmin } = await import("../lib/apptunnel.js");
        const dir = stateDirOf();
        const retire = opt("--retire");
        const purge = opt("--purge");
        if (retire && purge) fail("use --retire or --purge, not both", 2);
        const { lockStateDir: lockDir } = await import("../lib/realm.js");
        let release;
        try {
          release = lockDir(dir);
        } catch (e) {
          fail(`${e.message}; stop the relay first`);
        }
        try {
          if (retire) console.log(`Retired: ${appsAdmin.retire(dir, retire).slice(0, 6)}… (it answers 404 and can never be registered again).`);
          else if (purge) console.log(`Deleted: ${appsAdmin.purge(dir, purge).slice(0, 6)}…. Its URL is free now: any bridge may register it again.`);
          else {
            const rows = appsAdmin.list(dir);
            if (!rows.length) console.log("No app ids.");
            for (const r of rows) console.log(`${r.id}  ${r.state}  member ${r.member}  ${r.name}${r.registered ? `  since ${new Date(r.registered).toISOString()}` : ""}`);
          }
        } catch (e) {
          release();
          fail(e.message);
        }
        release();
        break;
      }
      const { startRelay } = await import("../lib/relay.js");
      const port = Number(opt("--port", process.env.HOPTELL_PORT || 7777));
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid ${opt("--port") === undefined && process.env.HOPTELL_PORT ? "HOPTELL_PORT" : "--port"}: a port number from 0 to 65535`);
      // Every option and file is checked before the state directory is created or locked: a
      // refused start changes nothing. The switches are read even when their flag is given, so
      // a misspelled value is refused rather than taken as off.
      const requireMembers = envOnOff("HOPTELL_REQUIRE_MEMBERS") || args.includes("--require-members");
      const e2ee = experimentalE2ee() || args.includes("--experimental-e2ee");
      // The owner channel's Mini App (design 7.4): off unless HOPTELL_OWNER_APP=on.
      const ownerApp = envOnOff("HOPTELL_OWNER_APP");
      const membersFile = opt("--members", process.env.HOPTELL_MEMBERS);
      const { loadMembersAndHosts } = await import("../lib/members.js");
      // The members list and the host credentials (design 4.5) come from one read of the file.
      let hostsRead = null;
      // systemd LoadCredential= hands the file over as a 0440 copy in its credentials directory;
      // the relay's own reads of it (start, reload, the admin views) accept that copy.
      const membersRead = { credentialsDir: process.env.CREDENTIALS_DIRECTORY || null };
      const readMembers = () => {
        const d = loadMembersAndHosts(membersFile, membersRead);
        hostsRead = d.hosts;
        return d.members;
      };
      // Opt-in keyed fingerprints in the log: loaded once, before listening; no silent fallback.
      const fpModule = await import("../lib/fingerprint.js");
      const fingerprint = fpModule.fingerprintsEnabled(process.env.HOPTELL_LOG_FINGERPRINTS) ? fpModule.loadFingerprintKey(process.env.HOPTELL_LOG_FINGERPRINT_KEY_FILE) : null;
      const { parseTrustedProxies } = await import("../lib/relay.js");
      const trustedProxies = parseTrustedProxies(opt("--trusted-proxies", process.env.HOPTELL_TRUSTED_PROXIES));
      const { makeLogger, startMetrics } = await import("../lib/metrics.js");
      const log = makeLogger(opt("--log-format", process.env.HOPTELL_LOG_FORMAT || "text"));
      const { fencedMessage, loadRealm, lockStateDir, readRestoreIntent } = await import("../lib/realm.js");
      const stateDirectory = stateDirOf();
      const realmName = opt("--realm-name", process.env.HOPTELL_REALM_NAME);
      if (realmName && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(realmName)) fail("invalid --realm-name: letters, digits, '.', '_' and '-', up to 64 characters");
      // WAL admission (design 6): every write of the store is admitted against the log's size.
      const size = (flag, env) => {
        const v = opt(flag, process.env[env]);
        if (v === undefined || v === null || v === "") return undefined;
        const n = parseSize(v);
        if (n === null) fail(`invalid ${flag}: a size such as 256MiB, 1GiB or a number of bytes`);
        return n;
      };
      const admission = Object.fromEntries(Object.entries({ soft: size("--wal-soft-limit", "HOPTELL_WAL_SOFT_LIMIT"), hard: size("--wal-hard-limit", "HOPTELL_WAL_HARD_LIMIT") }).filter(([, v]) => v !== undefined));
      // The pair in force (a limit not given takes its default) is checked here, before the state directory is touched.
      const { WAL_LIMITS } = await import("../lib/relaydb.js");
      if ((admission.soft ?? WAL_LIMITS.soft) > (admission.hard ?? WAL_LIMITS.hard)) {
        const mib = (n) => `${n / 1024 / 1024}MiB`;
        if (admission.hard === undefined) fail(`--wal-soft-limit must not be above the hard limit (${mib(WAL_LIMITS.hard)} unless --wal-hard-limit is set)`);
        if (admission.soft === undefined) fail(`--wal-hard-limit must not be below the soft limit (${mib(WAL_LIMITS.soft)} unless --wal-soft-limit is set)`);
        fail("--wal-soft-limit must not be above --wal-hard-limit");
      }
      // Larger transfers' quotas: checked with or without --experimental-e2ee, used only with it.
      const quota = Object.fromEntries(Object.entries({ totalQuota: size("--transfer-quota", "HOPTELL_TRANSFER_QUOTA"), memberQuota: size("--transfer-member-quota", "HOPTELL_TRANSFER_MEMBER_QUOTA") }).filter(([, v]) => v !== undefined));
      const metricsPort = opt("--metrics-port", process.env.HOPTELL_METRICS_PORT);
      if (metricsPort && !(/^\d+$/.test(metricsPort) && Number(metricsPort) >= 1 && Number(metricsPort) <= 65535)) fail(`invalid ${opt("--metrics-port") === undefined ? "HOPTELL_METRICS_PORT" : "--metrics-port"}: a port number from 1 to 65535`);
      const initialMembers = membersFile ? readMembers() : null;
      const { checkRelayStart } = await import("../lib/relay.js");
      checkRelayStart({ host: opt("--host", process.env.HOPTELL_HOST), token: process.env.HOPTELL_TOKEN, members: initialMembers, hosts: hostsRead, requireMembers });
      if (process.env.HOPTELL_REALM_ID && !/^[0-9a-f]{32}$/.test(process.env.HOPTELL_REALM_ID)) fail("HOPTELL_REALM_ID must be 32 lowercase hex characters");
      const policyFile = opt("--policy", process.env.HOPTELL_POLICY);
      const { createAccess, loadPolicy } = await import("../lib/access.js");
      const policyDoc = policyFile ? loadPolicy(policyFile) : null;
      const oidcFile = opt("--oidc", process.env.HOPTELL_OIDC);
      const oidcConfig = oidcFile ? (await import("../lib/oidc.js")).loadOidcConfig(oidcFile) : null;
      // Before anything listens: a relay must not say it is listening and then stop on this.
      const socketProblem = (await import("../lib/admin.js")).socketPathProblem(stateDirectory);
      if (socketProblem) fail(socketProblem);
      const release = lockStateDir(stateDirectory);
      for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (release(), process.exit(0)));
      process.on("exit", release);
      // An unfinished restore fences the state directory (design 4.4): checked before any store,
      // access state or broker state is opened.
      const fence = readRestoreIntent(stateDirectory);
      if (fence) fail(fencedMessage(fence));
      const realm = { id: loadRealm(stateDirectory, process.env.HOPTELL_REALM_ID || null), name: realmName || undefined };
      // The store opens on every start (design 4.4: the audit log, the store's instance id and the
      // restore marker live there); the device service stays behind the experimental flag.
      const { openRelayStore } = await import("../lib/relaystore.js");
      let db;
      try {
        db = openRelayStore({ dir: stateDirectory, admission });
      } catch (e) {
        fail(e.message);
      }
      // Security events go to the admin audit log once it exists (the relay acts on them regardless).
      let admin = null;
      const pendingEvents = [];
      const audit = (action, detail) => (admin ? admin.securityEvent(action, detail) : pendingEvents.push([action, detail]));
      // Sign-in with identity providers (design 1.6): explicit issuers from --oidc / HOPTELL_OIDC.
      let oidc = null;
      // Broker sign-ins of a relay whose broker issuers were all removed end at startup (design 1.7:
      // removing an issuer ends its families); the broker starts whenever its state exists.
      const brokerState = fs.existsSync(path.join(stateDirectory, "broker", "families.json"));
      if (!oidcFile && brokerState) {
        const broker = await (await import("../lib/broker.js")).createBroker({ issuers: [], stateDir: stateDirectory, log, audit });
        oidc = { config: { issuers: [] }, verifier: null, discovery: null, broker };
      }
      if (oidcFile) {
        const o = await import("../lib/oidc.js");
        const config = oidcConfig;
        const brokerIssuers = config.issuers.filter((i) => i.mode === "broker");
        // Broker mode (design 1.7): its families and refresh key live in this relay's state directory.
        const broker = brokerIssuers.length || brokerState ? await (await import("../lib/broker.js")).createBroker({ issuers: brokerIssuers, stateDir: stateDirectory, log, audit }) : null;
        oidc = { config, verifier: config.issuers.some((i) => i.mode === "resource") ? await o.createVerifier(config, { log }) : null, discovery: o.discoveryDocument(config, realm.id), broker };
        log(`sign-in with ${config.issuers.map((i) => `${i.issuer}${i.mode === "broker" ? ` (broker ${i.id})` : ""}`).join(", ")}`);
      }
      // Access (design 4.1/4.2): the admin policy (gate 1) from --policy / HOPTELL_POLICY, and the
      // members' own grants (gate 2) in the state directory. Without either nothing changes.
      const access = createAccess({ stateDir: stateDirectory, policy: policyDoc });
      // Device keys (design 3.2): EXPERIMENTAL, only on explicit request.
      let devices = null;
      if (e2ee) {
        const { createDeviceDirectory } = await import("../lib/mls/relaydir.js");
        const { createDeliveryService } = await import("../lib/mls/relayds.js");
        const { createTransferStore } = await import("../lib/mls/relaytransfers.js");
        const directory = createDeviceDirectory({ db, realm: realm.id });
        // Larger transfers (design 6) on the same store; the quotas are relay options.
        let transfers;
        try {
          transfers = createTransferStore({ db, limits: quota, log });
        } catch (e) {
          fail(e.message);
        }
        devices = { directory, ds: createDeliveryService({ db, directory, realm: realm.id, transfers }), transfers };
        log("EXPERIMENTAL: device keys, encrypted messages and larger transfers are enabled; not for production use");
      } else if (Object.keys(quota).length) log("note: the transfer quotas apply only with --experimental-e2ee; they are ignored");
      let dropped = () => 0;
      // The store's sizes, checkpoints and admission (design 6), and the transfers' charged total.
      const storeStats = () => {
        try {
          const st = db.stat();
          const adm = db.admission();
          return { storeFileBytes: st.file, storeWalBytes: st.wal, storeCheckpointBusy: adm.checkpoints.busy, storeWritesRefused: adm.refusals.bulk + adm.refusals.progress + adm.refusals.maintenance, ...(devices?.transfers ? { transferChargedBytes: devices.transfers.stats().charged } : {}) };
        } catch {
          return {};
        }
      };
      if (ownerApp) log("owner app: /app/ is served for registered owner channel bridges (HOPTELL_OWNER_APP=on)");
      // A kill -HUP that arrives while the relay starts is kept and run once it is ready, rather
      // than ending the process (the default for SIGHUP).
      let reload = null;
      let reloadAsked = false;
      if (membersFile || policyFile) process.on("SIGHUP", () => (reload ? reload() : (reloadAsked = true)));
      const relay = await startRelay({ host: opt("--host", process.env.HOPTELL_HOST), port, token: process.env.HOPTELL_TOKEN, members: initialMembers, hosts: hostsRead, requireMembers, realm, fingerprint, trustedProxies, oidc, access, devices, ownerApp: ownerApp ? { stateDir: stateDirectory } : null, audit, extraStats: () => ({ auditDropped: dropped(), ...storeStats() }), log });
      // The relay admin (design 4.4): its operations over this store, served on the admin socket.
      const { createAdmin, startAdminSocket, COUNTS_EVERY_MS } = await import("../lib/admin.js");
      admin = createAdmin({
        stateDir: stateDirectory,
        db,
        realm: realm.id,
        relay,
        access,
        config: { members: membersFile || null, policy: policyFile || null, oidc: oidcFile || null },
        flags: { e2ee },
        apply: { readMembers, members: (list) => relay.reload(list, hostsRead), policy: (p) => access.setPolicy(p) },
        membersRead,
        log,
      });
      dropped = admin.auditDropped;
      for (const [action, detail] of pendingEvents.splice(0)) admin.securityEvent(action, detail);
      // Intents a CLI or relay left without a result: recorded as unknown, with what is seen now.
      try {
        const n = admin.settleOpenIntents("relay");
        if (n) log(`admin: ${n} unfinished admin change${n === 1 ? "" : "s"} recorded as outcome unknown (hoptell relay admin audit)`);
      } catch (e) {
        log("admin: open intents could not be settled:", e.message);
      }
      await startAdminSocket({ stateDir: stateDirectory, admin, log });
      const maintain = () => admin.maintain().catch((e) => log("admin: store maintenance failed:", e.message));
      maintain();
      setInterval(maintain, COUNTS_EVERY_MS).unref();
      if (metricsPort) {
        const mp = Number(metricsPort);
        const metricsHost = opt("--metrics-host", process.env.HOPTELL_METRICS_HOST || "127.0.0.1");
        await startMetrics(relay, { host: metricsHost, port: mp });
        log(`metrics on http://${metricsHost}:${mp}/metrics`);
      }
      // kill -HUP and the admin socket's reload: re-read the members file (revoked tokens are
      // disconnected) and the policy file; on any problem keep the current list or policy.
      if (membersFile || policyFile) {
        reload = () => {
          let r;
          try {
            r = admin.reload({}, "relay");
          } catch (e) {
            return log(`reload failed: ${e.message}`);
          }
          if (r.policy) log(r.policy.ok ? "access policy reloaded" : `policy reload failed; keeping the active policy: ${r.policy.error}`);
          // Through the relay's logger, so --log-format json keeps every line JSON.
          if (r.members && !r.members.ok) log(r.members.applied ? `members reload applied changes but did not complete: ${r.members.error}` : `members reload failed; the active members list is unchanged: ${r.members.error}`);
        };
        if (reloadAsked) reload();
      }
      break;
    }
    case "device": {
      // Device keys and enrollment (design 3.2): EXPERIMENTAL, only with HOPTELL_EXPERIMENTAL_E2EE=1.
      if (!experimentalE2ee()) fail("hoptell device is experimental: device keys and encrypted messages are not independently reviewed. To try it, set HOPTELL_EXPERIMENTAL_E2EE=1", 2);
      credentialStoreOrFail(); // before the contacts are opened
      const { deviceCommand } = await import("../lib/mls/cli.js");
      await deviceCommand({ args, home: home(), profile: await profileOfRelay(), env: process.env, connect: () => connect("send", null), contacts: await contactsOf() });
      break;
    }
    case "mcp-hosted": {
      // Hosted HTTP MCP mode (design 4.5): EXPERIMENTAL, only with --experimental.
      const { hostedCommand } = await import("../lib/hostedcli.js");
      try {
        await hostedCommand({ args, opt });
      } catch (e) {
        fail(e.message, e.exitCode ?? 1);
      }
      break;
    }
    case "mcp-http": {
      const sub = args.find((a, i) => !a.startsWith("--") && !["--port", "--name", "--roles"].includes(args[i - 1]));
      // A stray word is refused: it never starts the server.
      if (sub !== undefined && sub !== "client") fail(`unknown mcp-http command ${JSON.stringify(String(sub).slice(0, 40))} (see hoptell mcp-http --help)`, 2);
      if (sub === "client") {
        const h = await import("../lib/httpmcp.js");
        const [, action, label] = args.filter((a, i) => !a.startsWith("--") && !["--port", "--name", "--roles"].includes(args[i - 1]));
        if (action === "add" && label) {
          const r = await h.addClient(home(), label, { name: opt("--name") ?? null, roles: parseRoles(opt("--roles") ?? ""), agents: args.includes("--agents") });
          console.log(`Client "${r.label}" added.\nToken, shown only now:\n\n  ${r.token}\n`);
          console.log("Configure the client with the URL http://127.0.0.1:<port>/mcp\nand the header \"Authorization: Bearer <token>\".");
        } else if (action === "list") {
          const rows = h.listClients(home());
          if (!rows.length) console.log("No clients.");
          for (const c of rows) console.log(`${c.label}${c.name ? `  name ${c.name}` : ""}${c.roles?.length ? `  roles ${c.roles.join(",")}` : ""}${c.agents ? "  agents" : ""}  since ${c.created}`);
        } else if (action === "remove" && label) {
          await h.removeClient(home(), label);
          console.log(`Removed client "${label}"; its token no longer works and its open sessions end within a minute.`);
        } else fail(`${["add", "remove"].includes(action) ? `mcp-http client ${action} needs a label` : action === undefined ? "mcp-http client needs a command" : `unknown mcp-http client command ${JSON.stringify(String(action).slice(0, 40))}`}\nusage: hoptell mcp-http client add <label> [--name <peer>] [--roles a,b] [--agents] | list | remove <label>`, 2);
        break;
      }
      const { runMcpHttp } = await import("../lib/mcp.js");
      await runMcpHttp({ port: portOpt("--port", undefined) });
      break;
    }
    case "agents": {
      // Agent profiles and runs (design 7.1).
      const { agentsCommand } = await import("../lib/agentscli.js");
      await agentsCommand({ args, home: home(), env: process.env, homedir: os.homedir(), fail });
      break;
    }
    case "mcp": {
      if (!mcpRun && (args.includes("--home") || args.some((a) => !a.startsWith("--")))) fail("mcp takes no arguments other than --run <run> --home <home>\nusage: hoptell mcp\n       hoptell mcp --run <run> --home <home>", 2);
      const { runMcp } = await import("../lib/mcp.js");
      await runMcp(mcpRun ?? {});
      break;
    }
    case "tmux": {
      const sep = args.indexOf("--");
      const head = sep < 0 ? args : args.slice(0, sep);
      const { launch, TMUX_USAGE } = await import("../lib/tmux.js");
      // The peer name first, then each option once, with its value.
      const opts = {};
      let bad = sep < 0 || head.length % 2 !== 1 || head[0].startsWith("-");
      for (let i = 1; !bad && i < head.length; i += 2) {
        if (!["--roles", "--cwd", "--task"].includes(head[i]) || head[i] in opts || head[i + 1].startsWith("--")) bad = true;
        else opts[head[i]] = head[i + 1];
      }
      if (bad) fail(`tmux needs a peer name, then -- and the agent's command\nusage: ${TMUX_USAGE}`, 2);
      // Once the checks pass, the home is classified first (a new install becomes managed): the
      // session settings file and the injector's reads create state that would otherwise make a
      // new home look like an old one.
      // A launch prompt (hoptell agents flags --lead) sends the agent to read_task, which only a
      // session started with --task has.
      if (!opts["--task"] && args.slice(sep + 1).some((w) => w.includes("read_task"))) console.error("warning: the agent's prompt mentions read_task, but without --task this session has no task to read; give the task with --task <file>");
      await launch(head[0], args.slice(sep + 1), opts["--roles"] ?? process.env.HOPTELL_ROLES ?? "", { env: { ...process.env }, home: home(), prepare: () => contactsOf(), cwd: opts["--cwd"] ?? null, task: opts["--task"] ?? null });
      break;
    }
    case "worktree": {
      // Implementer worktrees (design 8, topic 2).
      const { worktreeCommand } = await import("../lib/worktrees.js");
      await worktreeCommand({ args, home: home(), cwd: process.cwd(), fail, out: (l) => console.log(l) });
      break;
    }
    case "team": {
      const { teamCommand } = await import("../lib/teams.js");
      // team up asks, after the start, whether the lead is online (a bounded listing; null when
      // it cannot tell).
      const leadOnline = async (lead) => {
        // Only a default relay is checked: selectRelay would end this process on any other choice.
        const relaysFile = process.env.HOPTELL_RELAYS || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hoptell", "relays.json");
        if (process.env.HOPTELL_RELAYS || fs.existsSync(relaysFile)) {
          const { readRelaysFile } = await import("../lib/relays.js");
          const r = readRelaysFile(relaysFile, { env: process.env, homedir: os.homedir() });
          const e = r.relays.find((x) => x.alias === r.default);
          if (!e || e.tokenProblem) return null;
        }
        await selectRelay(null, null);
        // A send-only probe under the relay's automatic name: the relay leaves the caller's own name
        // out of a listing, so HOPTELL_NAME set to the lead would make an online lead look offline.
        const c = await connect("send", undefined, 5000, { autoName: true });
        try {
          if (c.name === lead) return null;
          const peers = await Promise.race([c.list(), new Promise((r) => setTimeout(() => r(null), 5000).unref())]);
          return peers ? peers.some((p) => p.name === lead && p.online) : null;
        } finally {
          c.close();
        }
      };
      await teamCommand({ args, home: home(), homedir: os.homedir(), env: { ...process.env }, fail, out: (l) => console.log(l), warn: (l) => console.error(l), isTTY: Boolean(process.stdin.isTTY), prepare: () => contactsOf(), deps: { leadOnline } });
      break;
    }
    case "review": {
      // The review queue of a team (design 8, 3.5): requests go out through the send path above.
      const { reviewCommand } = await import("../lib/teams.js");
      // One relay and one sender name for the whole batch, chosen when the first send runs.
      let chosen = null;
      await reviewCommand({
        args,
        home: home(),
        fail,
        out: (l) => console.log(l),
        send: async (to, text) => {
          chosen ??= { sel: await selectRelay(null, null) };
          return sendText(to, text, {
            chosen,
            die: (m) => {
              throw new Error(m);
            },
          });
        },
      });
      break;
    }
    case "inject": {
      const { inject } = await import("../lib/tmux.js");
      await contactsOf(); // classify the home first, as every command that creates state does
      await inject(args[0], args[1], args[2], { home: home(), relay: relayChoice() });
      break;
    }
    case "list": {
      const sel = await selectRelay();
      const c = await connect("send");
      const peers = await c.list();
      const { formatPeers } = await import("../lib/client.js");
      // Grants can hide peers, so this says what is visible, not what exists.
      const none = sel && sel.relays.relays.length > 1 ? `No peers are visible on relay "${sel.entry.alias}".` : "No peers are visible on this relay.";
      console.log(peers.length ? formatPeers(peers).join("\n") : none);
      c.close();
      break;
    }
    case "send": {
      const { parseRef, parseTtl } = await import("../lib/client.js");
      let ttl;
      let replyTo;
      let relayFlag = null;
      let rest = args;
      // Options come first; "--" ends them, so a message may itself start with "--".
      for (;;) {
        if (!["--relay", "--ttl", "--reply-to"].includes(rest[0])) break;
        if (rest[1] === undefined || rest[1] === "") fail(`${rest[0]} needs a value (see hoptell send --help); nothing was sent`, 2);
        if (rest[0] === "--relay") relayFlag = rest[1];
        else if (rest[0] === "--ttl") ttl = parseTtl(rest[1]);
        else replyTo = parseRef(rest[1]);
        rest = rest.slice(2);
      }
      // A name never starts with "-": before the recipient, anything else is a mistyped option.
      if (rest[0]?.startsWith("-") && rest[0] !== "--") fail(`unknown option ${rest[0].slice(0, 40)} for hoptell send (see hoptell send --help); nothing was sent`, 2);
      if (rest[0] === "--") rest = rest.slice(1);
      let [to, ...words] = rest;
      if (!to || !words.length) fail("send needs a recipient and a message\nusage: hoptell send [--relay <alias>] [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>", 2);
      console.log(await sendText(to, words.join(" "), { ttl, replyTo, relayFlag }));
      break;
    }
    case "wait": {
      // wait [--relay <alias>] [--wait-for-name | --replace] [seconds]
      await selectRelay();
      const waitForName = args.includes("--wait-for-name");
      const replace = args.includes("--replace");
      if (waitForName && replace) fail("use --wait-for-name or --replace, not both", 2);
      const words = args.filter((a) => !a.startsWith("--"));
      if (words.length > 1) fail("wait takes at most one number of seconds\nusage: hoptell wait [--relay <alias>] [--wait-for-name | --replace] [seconds]", 2);
      const secs = secondsArg(words[0], 300, "hoptell wait [seconds]; default 300");
      checkPeerSettings("peer");
      const deadline = Date.now() + secs * 1000;
      const { format } = await import("../lib/inbox.js");
      process.stdout.on("error", (err) => fail(`cannot write output: ${err.message}`));
      let c = null;
      let timer = null;
      let idle = null;
      const done = () => (c ? c.close() : setTimeout(done, 50));
      // The owner's contacts apply here too: only allowed senders are printed; others are held
      // in the quarantine of this name's storage (or dropped when blocked), then confirmed.
      const contacts = await contactsOf();
      const relayProfile = await relayProfileOf();
      let holdAt = null;
      const holdPlace = async (client) => {
        if (holdAt) return holdAt;
        if (client.protocolInUse === 2 && client.realm) {
          const { openBound, sessionKey } = await import("../lib/session.js");
          const key = sessionKey(client.name, { explicit: Boolean(cliName()), member: client.member });
          const bound = await openBound(home(), { realm: client.realm.id, member: client.member, key });
          holdAt = { dir: bound.dir, session: { realm: client.realm.id, name: key } };
        } else holdAt = { dir: path.join(home(), "legacy", client.name), session: { realm: null, name: client.name } };
        return holdAt;
      };
      const { ownSelf, stamp } = await import("../lib/quarantine.js");
      const review = await import("../lib/reviewsets.js");
      const reviewSets = new review.ReviewSetStore({ home: home() });
      // A message the contacts hold ends the wait as in a session (the fixed held text, never its
      // body), once: a later wait does not report the same hold again.
      const notices = await import("../lib/notices.js");
      let ended = false;
      const heldText = (place) => {
        const fresh = contacts.heldUnreported({ store: place.dir });
        return fresh.length ? { fresh, note: notices.heldNote(contacts.heldFor({ store: place.dir })) } : null;
      };
      const reportHeld = (place, first) => {
        const h = heldText(place);
        if (!h) return false;
        process.stdout.write(`${first ? notices.HELD_WAIT : ""}${h.note}\n`, (err) => (err ? fail(`cannot write output: ${err.message}`) : contacts.noteHeldReported({ store: place.dir }, h.fresh)));
        return true;
      };
      const finish = () => {
        if (ended) return;
        ended = true;
        if (holdAt) reportHeld(holdAt, false); // held after the printed messages: named after them
        done();
      };
      const named = (e) => {
        // hoptell wait can also wait for the name instead of stopping.
        if (/^the name is in use by another session: /.test(e.message) && !waitForName) e.message += " (or use --wait-for-name)";
        throw e;
      };
      c = await connect("peer", (raw, confirm, client) => {
        let m = stamp(raw, relayProfile); // an unverified sender's relay, recorded at arrival
        holdPlace(client)
          .then(async (place) => {
            // A proposal is stored for the owner and replaced by a fixed note, as in a session.
            if (review.isReviewTraffic(m)) m = await review.intakeMessage(reviewSets, m);
            // The own member as this connection's welcome names it, unless hosted: its messages need
            // no grant (as in the engine). The owner-channel exception stays off here, as before.
            const v = contacts.verdict(m, place.session, null, { self: client.protocolInUse === 2 ? ownSelf(client.member) : null });
            if (v !== "allow") {
              await contacts.hold(place.dir, place.session, m, v);
              confirm();
              if (!idle && !ended && reportHeld(place, true)) {
                ended = true;
                clearTimeout(timer);
                done();
              }
              return;
            }
            if (ended) return; // the wait already ended: the relay keeps it for a later receiver
            clearTimeout(timer);
            // Confirm only once printed; on a write error the relay keeps the message. Printed, it
            // reached this session: this member may reply to it once even where the sender's
            // grants would refuse it (a reply allowance), as with an agent session.
            process.stdout.write(`${format(m)}\n`, (err) => (err ? fail(`cannot write output: ${err.message}`) : confirm({ released: true })));
            clearTimeout(idle);
            idle = setTimeout(finish, 500); // also collect messages arriving together
          })
          // A storage problem leaves the message unconfirmed: the relay keeps it for a later receiver.
          .catch((e) => console.error(`hoptell: a message could not be stored and stays with the relay: ${e.message}`));
      }, secs * 1000, { waitForName, replace }).catch(named);
      if (!idle) {
        timer = setTimeout(async () => {
          if (ended) return;
          ended = true;
          // Messages held for this name and not released yet are still listed, as by listen.
          const place = await holdPlace(c).catch(() => null);
          const held = place ? notices.heldNote(contacts.heldFor({ store: place.dir })) : "";
          console.log(`No messages within ${secs}s.${held}`);
          c.close();
        }, Math.max(0, deadline - Date.now()));
      }
      c.on("fatal", (r) => fail(`relay closed the connection: ${r}`));
      break;
    }
    case "snapshot": {
      const snap = await import("../lib/snapshot.js");
      if (args[0] === "--check") {
        if (args.length !== 3) fail("snapshot --check needs a digest and a file\nusage: hoptell snapshot --check <sha256:...> <file>", 2);
        const r = snap.checkSnapshot(args[1], args[2]);
        console.log(
          r.matches
            ? `unchanged: ${args[2]} still matches ${r.expected}`
            : `changed: ${args[2]} is now ${r.current}, not ${r.expected}. Ask for a new review, or reconcile the change deliberately.`,
        );
        process.exitCode = r.matches ? 0 : 1;
      } else {
        if (args.length !== 1) fail("snapshot needs one file\nusage: hoptell snapshot <file>\n       hoptell snapshot --check <sha256:...> <file>", 2);
        console.log(snap.snapshotMessage(args[0]));
      }
      break;
    }
    case "apply": {
      // apply | apply <proposal id> [--preview | --yes] | apply --recover [--finish | --roll-back]
      const a = await import("../lib/apply.js");
      const flags = args.filter((x) => x.startsWith("--"));
      const ids = args.filter((x) => !x.startsWith("--"));
      const usage = "usage: hoptell apply [<proposal id> [--preview | --yes]]\n       hoptell apply --recover [--finish | --roll-back]";
      const badFlag = flags.find((f) => !["--preview", "--yes", "--recover", "--finish", "--roll-back"].includes(f));
      if (badFlag) fail(`unknown option ${badFlag} for hoptell apply\n${usage}`, 2);
      if (ids.length > 1) fail(`apply takes one proposal id\n${usage}`, 2);
      const recovering = flags.includes("--recover");
      if (recovering ? ids.length || flags.includes("--preview") || flags.includes("--yes") || (flags.includes("--finish") && flags.includes("--roll-back")) : flags.includes("--finish") || flags.includes("--roll-back") || (flags.includes("--preview") && flags.includes("--yes"))) fail(`these apply options do not go together\n${usage}`, 2);
      // The id's form is checked before the apply lock creates anything in the home.
      if (ids.length && !REF_RE.test(ids[0].toLowerCase())) fail(`"${ids[0].slice(0, 80)}" is not a proposal id: use an id that hoptell apply lists`, 2);
      const h = home();
      const pause = a.barrierFor(testBarrier(process.env, "APPLY"));
      if (!recovering && !ids.length) {
        const list = a.listPending(h);
        if (!list.length) console.log("No proposals are waiting for you.");
        for (const p of list) console.log(`${p.proposal_id}  from "${p.from}"  review set ${p.review_set_id}  ${p.received}\n    ${p.files.map(a.visible).join("\n    ")}`);
        if (list.length) console.log("Next: hoptell apply <proposal id> --preview");
        if (a.journals(h).length) console.log("An earlier apply was interrupted: run hoptell apply --recover.");
        break;
      }
      let release = null;
      let roots = new Map();
      let message = null;
      let code = 0;
      try {
        release = a.applyLock(h);
        roots = a.openApprovedRoots(process.env.HOPTELL_SNAPSHOT_ROOTS ?? "");
        if (recovering) {
          const choice = flags.includes("--finish") ? "finish" : flags.includes("--roll-back") ? "roll-back" : null;
          const report = a.recover({ home: h, roots, choice, pause });
          if (!report.length) console.log("No interrupted apply: nothing to recover.");
          for (const r of report) {
            const state = r.resolved ? r.outcome : r.committed ? (choice ? "committed; its cleanup is not finished, the journal was kept" : "committed; only its cleanup is left") : choice ? "not resolved; the journal was kept" : "interrupted";
            console.log(`Apply of proposal ${r.proposal_id}: ${state}${r.note ? ` (${r.note})` : ""}`);
            const holds = { preimage: "has the original contents", postimage: "has the proposed contents", other: "matches neither the original nor the proposed contents", unavailable: "cannot be checked" };
            for (const t of r.targets) console.log(`  ${a.visible(t.label)}: ${holds[t.state] ?? t.state}${t.outcome ? `; ${t.outcome}` : ""}`);
            for (const f of r.left) console.log(`  ${a.visible(f)}: a temporary file this apply did not provably create; left for you to inspect`);
          }
          if (report.length && !choice) {
            console.log(
              report.every((r) => r.committed)
                ? "To finish writing the proposed contents: hoptell apply --recover --finish\nA committed apply can only be finished."
                : "To finish writing the proposed contents: hoptell apply --recover --finish\nTo restore the original contents: hoptell apply --recover --roll-back\nA committed apply can only be finished.",
            );
          }
          // A roll-back refused because the apply was already committed is not what was asked.
          if (report.some((r) => !r.resolved || (choice === "roll-back" && r.committed))) code = 1;
        } else {
          if (a.journals(h).length) throw new a.ApplyError("journal_pending", "an earlier apply was interrupted; run hoptell apply --recover first");
          const plan = a.prepare({ home: h, roots, id: ids[0] });
          console.log(a.renderPreview(plan));
          if (flags.includes("--preview")) {
            console.log("\nPreview only: nothing was written.");
          } else {
            const blocked = plan.targets.find((t) => t.note);
            if (blocked) throw new a.ApplyError(blocked.note, "a target changed since it was captured, so nothing was written. Send a new review set");
            let ok = flags.includes("--yes");
            if (!ok) {
              if (!process.stdin.isTTY) throw new a.ApplyError("not_confirmed", "not confirmed: run this in a terminal, or pass --yes after reviewing --preview; nothing was written");
              // The question goes to stderr: stdout keeps only the preview and the result.
              const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stderr });
              ok = (await rl.question(`\nWrite these changes to ${plural(plan.targets.length, "file")}? Type yes to write them, anything else cancels: `)).trim() === "yes";
              rl.close();
            }
            if (!ok) console.log("Not applied: nothing was written.");
            else {
              try {
                const n = a.commit(plan, { home: h, pause });
                console.log(`Applied: ${plural(n, "file")} written. Proposal ${plan.proposal.proposal_id} is marked applied.`);
              } catch (e) {
                if (e instanceof a.ApplyError && e.code === "committed") throw e;
                if (a.journals(h).some((d) => path.basename(d) === plan.proposal.proposal_id)) {
                  throw new a.ApplyError("interrupted", `the apply stopped (${e instanceof a.ApplyError ? e.message : "a file could not be written"}); some files may already be written. Run hoptell apply --recover to finish or roll back`);
                }
                throw e;
              }
            }
          }
        }
      } catch (e) {
        if (!(e instanceof a.ApplyError)) throw e;
        message = e.message;
        code = 1;
      } finally {
        release?.();
        a.closeRoots(roots);
      }
      if (message) console.error(`hoptell: ${message}`);
      process.exitCode = code;
      break;
    }
    case "telegram": {
      // The owner channel (design 7.2): the bot token comes from standard input only.
      const { telegramCommand } = await import("../lib/ownerchannelcli.js");
      const { terminalMarks } = await import("../lib/words.js");
      process.exitCode = await telegramCommand(args, { home: home(), env: process.env, homedir: os.homedir(), marks: terminalMarks(process.stdout, process.env) });
      break;
    }
    case "hooks": {
      // Settings for Claude Code without the plugin: printed only, never written.
      const { hooksSnippet } = await import("../lib/wake.js");
      console.log(JSON.stringify(hooksSnippet(process.execPath, process.env.HOPTELL_HOME), null, 2));
      break;
    }
    case "doctor": {
      const { doctor, terminalMarks } = await import("../lib/doctor.js");
      process.exitCode = (await doctor(process.env, console.log, { relayCheck: args.includes("--relay-check"), fix: args.includes("--fix"), homedir: os.homedir(), marks: terminalMarks(process.stdout, process.env) })) ? 1 : 0;
      break;
    }
    case "transfers": {
      // EXPERIMENTAL (design 6): transfers [cancel <t_id>]
      const { transfersCommand } = await import("../lib/transfercli.js");
      process.exitCode = await transfersCommand({ args, home: home() });
      break;
    }
    case "save": {
      // EXPERIMENTAL (design 6): save <t_id> <path> [--overwrite] [--yes] | save --forget <t_id>
      const { saveCommand } = await import("../lib/transfercli.js");
      const confirm = process.stdin.isTTY
        ? async (question) => {
            const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stderr });
            try {
              return (await rl.question(question)).trim() === "yes";
            } finally {
              rl.close();
            }
          }
        : null;
      process.exitCode = await saveCommand({ args, home: home(), confirm });
      break;
    }
    case "listen": {
      // listen [--no-ack] (--session <folder> | <name>) [seconds]
      const noAck = args.includes("--no-ack");
      const rest = args.filter((a) => a !== "--no-ack");
      const bySession = rest[0] === "--session";
      const target = bySession ? rest[1] : rest[0] && checkName(rest[0], "name");
      const listenUsage = "usage: hoptell listen [--no-ack] <name> [seconds]\n       hoptell listen [--no-ack] --session <folder> [seconds]";
      if (!target) fail(`listen needs a name or --session <folder>\n${listenUsage}`, 2);
      if (rest.length > (bySession ? 3 : 2)) fail(`listen takes at most one number of seconds after the name or folder\n${listenUsage}`, 2);
      const secs = secondsArg(rest[bySession ? 2 : 1], 3600, "hoptell listen ... [seconds]; default 3600");
      const inbox = await import("../lib/inbox.js");
      const { boundFromPath, resolveNameStore } = await import("../lib/session.js");
      const { openStore, processConsumer } = await import("../lib/store.js");
      // A name follows its receiving session (resolved at each check); a folder is fixed.
      const resolve = () => {
        if (bySession) return { state: "bound", store: boundFromPath(home(), target) };
        const r = resolveNameStore(home(), target, relayChoice());
        if (r.state === "invalid") throw new Error(r.error);
        return r;
      };
      const consumer = noAck ? { kind: "manual", id: crypto.randomUUID() } : processConsumer("listen");
      const deadline = Date.now() + secs * 1000;
      let out = null;
      const pipes = new Map();
      const contacts = await contactsOf();
      const { attest } = await import("../lib/quarantine.js");
      const notices = await import("../lib/notices.js");
      // A hold that no wait or listener has reported yet ends it too (design contacts-self), so an
      // idle agent wakes, once: a restarted listener does not exit again for the same hold.
      await contacts.adopt(); // held messages a crash left without their request join it first
      let lastDir = null;
      let lastState = null;
      while (!out) {
        const r = resolve();
        lastState = r.state;
        if (r.state === "legacy") {
          // Protocol 1: the messages the owner released (legacy store), then the legacy inbox, each
          // file claimed until it is printed or moved to quarantine (a failed move keeps it).
          // Everything selected stays recoverable until it is printed: released messages are taken with
          // a receipt (this process), old inbox files stay claimed. --no-ack applies to current relays only.
          const sid = { realm: null, name: r.store.name };
          const legacyDir = path.join(home(), "legacy", r.store.name);
          const legacyPipe = await openStore({ dir: legacyDir, inbox: path.join(legacyDir, "inbox"), seen: path.join(legacyDir, "seen") }, { receipts: "on", managed: contacts.isManaged() });
          const me = processConsumer("listen");
          const shown = [];
          const released = await legacyPipe.take(me, { screen: contacts.screenFor(sid) });
          if (released?.quarantined?.length) await contacts.adopt();
          for (const x of released?.messages ?? []) shown.push(x.msg);
          const claims = [];
          try {
            for (const f of inbox.list(r.store)) {
              const cl = inbox.claim(r.store, f);
              if (!cl) continue;
              if (!cl.msg) {
                cl.commit();
                continue;
              }
              const v = contacts.verdict(cl.msg, sid);
              if (v === "allow") {
                shown.push(cl.msg);
                claims.push(cl);
                continue;
              }
              try {
                await contacts.adoptBacklog(legacyDir, sid, cl.msg, v, { source: inbox.fileOf(r.store, f) }); // accepted backlog: never dropped
              } catch (e) {
                cl.release();
                throw e;
              }
              cl.commit();
            }
          } catch (e) {
            for (const k of claims) k.release();
            if (released?.receipt) await legacyPipe.release(me);
            throw new Error(`a message could not be moved to the quarantine (${e.message}); nothing was taken from the inbox`);
          }
          const undo = async () => {
            for (const k of claims) k.release();
            if (released?.receipt) await legacyPipe.release(me);
          };
          // What is shown carries this machine's checks (lib/attested.js), never a stored flag alone.
          const checked = shown.map((m) => attest(home(), m));
          if (shown.length) out = { text: checked.map(inbox.format).join("\n\n"), note: inbox.batchNote(checked), receipt: null, pipe: null, claims, legacy: released?.receipt ? { pipe: legacyPipe, receipt: released.receipt } : null, undo };
          else {
            await undo();
            // Holds for a protocol-1 session are kept with its legacy store.
            lastDir = legacyDir;
            const fresh = contacts.heldUnreported({ store: legacyDir });
            if (fresh.length) out = { held: fresh, store: legacyDir, text: notices.HELD_WAIT + notices.heldNote(contacts.heldFor({ store: legacyDir })) };
          }
        } else if (r.state === "bound") {
          // Keeps the session's receipt policy; claims use the configured lease.
          if (!pipes.has(r.store.dir)) pipes.set(r.store.dir, await openStore(r.store, { leaseMs: leaseMinutes() * 60_000 }));
          const pipe = pipes.get(r.store.dir);
          // A message that cannot be read is an error (nothing is acknowledged); the current policy
          // is applied, and messages it holds back join their requests.
          await (await import("../lib/ownersig.js")).completeSeen(home(), pipe); // owner-channel replay records first (design 7.2)
          // The own member too: a verified owner-channel message needs no grant (as in the engine).
          const batch = await pipe.take(consumer, { screen: contacts.screenFor(sessionOfDir(r.store.dir), memberOfDir(r.store.dir)) });
          if (batch?.quarantined?.length) await contacts.adopt();
          if (batch && (batch.messages.length || batch.damaged?.length)) {
            const notes = (batch.damaged ?? []).map((f) => `(A stored message was damaged and was set aside, unread, in ${f}.)`);
            const where = { ...sessionOfDir(r.store.dir), member: memberOfDir(r.store.dir) };
            const checked = batch.messages.map((m) => attest(home(), m.msg, where));
            out = { text: [...notes, ...checked.map((m) => inbox.format(m))].join("\n\n"), note: inbox.batchNote(checked), receipt: batch.receipt, pipe };
          } else {
            lastDir = r.store.dir;
            const fresh = contacts.heldUnreported({ store: r.store.dir });
            if (fresh.length) out = { held: fresh, store: r.store.dir, text: notices.HELD_WAIT + notices.heldNote(contacts.heldFor({ store: r.store.dir })) };
          }
        }
        if (out || Date.now() >= deadline) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      if (!out) {
        const held = lastDir ? notices.heldNote(contacts.heldFor({ store: lastDir })) : "";
        // Files hoptell 0.2 left for this name are read here only for a protocol-1 relay; else
        // they wait for a session with this name (lib/engine.js moves them), so say so.
        let left = "";
        if (!bySession && lastState !== "legacy") {
          const dir = path.join(home(), "inbox", target);
          let n = 0;
          try {
            n = fs.readdirSync(dir).filter((f) => /^\d{13}-\d{8}-[0-9a-f]{8}\.json$/.test(f)).length;
          } catch {}
          if (n) left = `\n${n} message file${n === 1 ? "" : "s"} that hoptell 0.2 left for ${target} ${n === 1 ? "waits" : "wait"} in ${dir}: a session with HOPTELL_NAME=${target} reads them, or moves them into its own storage when it connects to a current relay.`;
        }
        process.stdout.write(`No messages within ${secs}s.${held}${left}\nStart the listener again to keep receiving.\n`);
        break;
      }
      if (out.held) {
        const held = out;
        process.stdout.write(`${held.text}\nStart the listener again to keep receiving.\n`, (err) => (err ? fail(`cannot write output: ${err.message}`) : contacts.noteHeldReported({ store: held.store }, held.held)));
        break;
      }
      const footer = out.receipt && noAck ? `\nReceipt: ${out.receipt} (acknowledge with: hoptell ack ${out.receipt} ${bySession ? `--session "${target}"` : target})` : "";
      // Acknowledge only after the output is written (automatic mode); a failed write keeps them.
      process.stdout.write(`${out.text}\n\n${out.note ?? inbox.NOT_YOUR_USER}${footer}\nReply with send_message if needed, then restart this listener while the task still requires incoming messages.\n`, async (err) => {
        if (err) {
          if (out.undo) await out.undo(); // not printed: the messages stay
          else for (const k of out.claims ?? []) k.release();
          return fail(`cannot write output: ${err.message}`);
        }
        if (out.receipt && !noAck) await out.pipe.ack(out.receipt);
        for (const k of out.claims ?? []) k.commit(); // legacy inbox files go once they are printed
        if (out.legacy) await out.legacy.pipe.ack(out.legacy.receipt);
      });
      break;
    }
    case "ack": {
      // ack <receipt> (--session <folder> | <name>)
      const [receipt, ...where] = args;
      const bySession = where[0] === "--session";
      const target = bySession ? where[1] : where[0];
      if (!receipt || !target) fail("ack needs a receipt and a name or --session <folder>\nusage: hoptell ack <receipt> <name>\n       hoptell ack <receipt> --session <folder>", 2);
      const { boundFromPath, resolveNameStore } = await import("../lib/session.js");
      const { openStore } = await import("../lib/store.js");
      let bound;
      if (bySession) bound = boundFromPath(home(), target);
      else {
        const r = resolveNameStore(home(), checkName(target, "name"), relayChoice());
        if (r.state !== "bound") fail(r.state === "invalid" ? r.error : `no protocol-2 session storage for "${target}" on this machine (receipts are not used there)`);
        bound = r.store;
      }
      const pipe = await openStore(bound);
      await (await import("../lib/ownersig.js")).completeSeen(home(), pipe); // owner-channel replay records first (design 7.2)
      const r = await pipe.ack(receipt);
      if (r !== "ok") fail(`unknown receipt ${receipt}: it may have expired (its messages were returned to the inbox) or be mistyped`);
      console.log("Acknowledged.");
      break;
    }
    default:
      fail(`unknown command ${JSON.stringify(String(cmd).slice(0, 40))} (see hoptell --help)`, 2);
  }
} catch (e) {
  // A state directory that cannot be created: its path and the cause in words, not Node's errno text.
  if (e?.syscall === "mkdir" && e.path && ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EEXIST"].includes(e.code)) fail(`cannot create the state directory ${e.path} (${errnoWords(e)}): check HOPTELL_HOME and its parent directories`);
  fail(e.message);
}
