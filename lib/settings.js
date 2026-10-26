// Client settings for an agent session, read once. bootstrap() is the only place that reads the
// process environment; readSettings() is pure and returns a deeply frozen copy, with a problem
// per field instead of an exception, so an MCP server can start and report what is wrong.
import os from "node:os";
import path from "node:path";
import { HOSTNAME, checkName, defaultHome, envAuth, envCredentialStore, envElicitation, envNotify, envOwnerChannel, envSwitch, envTitle, loadEnv, parseProtocol, parseRoles } from "./config.js";
import { requestedMode } from "./delivery.js";
import { profileKey } from "./profiles.js";

/** Load the settings file into the environment (as the CLI does), then capture the inputs once. */
export function bootstrap() {
  loadEnv();
  return { env: { ...process.env }, homedir: os.homedir(), cwd: process.cwd(), pid: process.pid, hostname: HOSTNAME };
}

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

/**
 * Settings from captured inputs. `errors` maps a field to its problem:
 *   name            fatal at start (as before);
 *   push            logged; the session uses the listener (as before);
 *   receipts        logged; the defaults (receipts on, 30-minute lease) are used;
 *   relay           relay tools report it, local tools keep working;
 *   e2ee, credentialStore
 *                   fatal at start (settingsProblem): a misspelled switch is not taken as off;
 *   agentsMax       spawning agents is refused (an invalid limit is not replaced by the default);
 *   title           logged; no title is sent at all (an unusable HOPTELL_TITLE is not replaced
 *                   by another title);
 *   titleAuto       fatal at start (settingsProblem), like the other on/off switches;
 *   warnings        a list: settings whose value was not accepted and whose default is used
 *                   (logged at start);
 *   (snapshot roots are checked when the file tools start: a problem turns only them off).
 */
export function readSettings({ env, homedir, cwd = null, pid, hostname = HOSTNAME }) {
  const errors = {};
  const field = (key, fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      errors[key] ??= e.message;
      return fallback;
    }
  };
  const name = field("name", () => (env.HOPTELL_NAME ? checkName(env.HOPTELL_NAME, "HOPTELL_NAME") : null), null);
  // The session title (display only): null (none set), "off" (never send one) or the cleaned text.
  const title = field("title", () => envTitle(env), "off");
  // Titles found in Claude Code's hook input (it does not say who set them): sent only when on.
  const titleAuto = field("titleAuto", () => envSwitch(env, "HOPTELL_TITLE_AUTO"), false);
  const push = field("push", () => requestedMode(env.HOPTELL_PUSH), "listener");
  // Receipts for protocol-2 sessions (on by default) and how long a handed-out batch is held.
  const receipts = field("receipts", () => {
    const v = String(env.HOPTELL_RECEIPTS ?? "").trim().toLowerCase();
    if (v === "" || v === "on") return "on";
    if (v === "off") return "off";
    throw new Error("HOPTELL_RECEIPTS must be on or off");
  }, "on");
  const leaseMinutes = field("receipts", () => {
    const v = String(env.HOPTELL_LEASE_MINUTES ?? "").trim();
    if (v === "") return 30;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error("HOPTELL_LEASE_MINUTES must be a whole number from 1 to 1440");
    return n;
  }, 30);
  // The credential store and the experimental encryption switch: refused at start when invalid.
  const credentialStore = field("credentialStore", () => envCredentialStore(env), "auto");
  const e2ee = field("e2ee", () => envSwitch(env, "HOPTELL_EXPERIMENTAL_E2EE"), false);
  // Settings with a harmless default: an unaccepted value is reported and the default used.
  const warnings = [];
  const choice = ({ value, warning }) => {
    if (warning) warnings.push(warning);
    return value;
  };
  // Roles are part of the relay login: an invalid role makes relay tools report it (as before).
  const roles = field("relay", () => parseRoles(env.HOPTELL_ROLES), []);
  const relay = field(
    "relay",
    () => {
      if (errors.relay) throw new Error(errors.relay);
      const protocol = parseProtocol(env.HOPTELL_PROTOCOL);
      if (!env.HOPTELL_RELAY) throw new Error("HOPTELL_RELAY is not set (e.g. ws://192.0.2.10:7777); see .env.example");
      // HOPTELL_AUTH=login: signed in with an identity provider (hoptell login) instead of a token.
      const auth = envAuth(env);
      if (auth === "token" && !env.HOPTELL_TOKEN) throw new Error("HOPTELL_TOKEN is not set; use the same token as the relay, or sign in with hoptell login and set HOPTELL_AUTH=login");
      if (auth === "login" && protocol !== 2) throw new Error("signing in needs relay protocol 2 (HOPTELL_PROTOCOL=1 is set)");
      const profile = env.HOPTELL_PROFILE || null;
      if (protocol === 2) profileKey(env.HOPTELL_RELAY, profile); // validates the URL and profile name
      return { url: env.HOPTELL_RELAY, token: auth === "token" ? env.HOPTELL_TOKEN : null, auth, protocol, profile, credentialStore, passphrase: env.HOPTELL_CREDENTIAL_PASSPHRASE || null };
    },
    null,
  );
  return deepFreeze({
    // A relative HOPTELL_HOME is resolved once, against the directory captured at startup, so
    // the storage cannot move later if the process changes its working directory.
    home: cwd ? path.resolve(cwd, defaultHome(env, homedir)) : defaultHome(env, homedir),
    name,
    title,
    titleAuto,
    roles,
    push,
    relay,
    snapshotRoots: env.HOPTELL_SNAPSHOT_ROOTS ?? "",
    // Session-wide relay options, also without a single relay (a relays file uses them for each).
    protocol: (() => {
      try {
        return parseProtocol(env.HOPTELL_PROTOCOL);
      } catch {
        return 2;
      }
    })(),
    signIn: { credentialStore, passphrase: env.HOPTELL_CREDENTIAL_PASSPHRASE || null },
    // Several relays (design 2.1): HOPTELL_RELAYS, else <config dir>/hoptell/relays.json when it exists.
    relaysFile: env.HOPTELL_RELAYS ? path.resolve(cwd ?? "/", env.HOPTELL_RELAYS) : path.join(env.XDG_CONFIG_HOME || path.join(homedir, ".config"), "hoptell", "relays.json"),
    relaysExplicit: Boolean(env.HOPTELL_RELAYS),
    receipts,
    leaseMinutes,
    // The elicitation adapter (design 3.4): asks the owner during read_inbox only when set to
    // "read_inbox"; off otherwise (another value is reported).
    elicitation: choice(envElicitation(env)),
    // The owner channel (design 7.2): "off" hides ask_owner and turns off owner-envelope
    // verification (such envelopes then show as ordinary peer messages). On by default.
    ownerChannel: choice(envOwnerChannel(env)),
    // Live spawned-agent runs per home (design 7.1): default 4, at most 16 (a larger value is
    // lowered to 16, with a warning). Not a whole number of at least 1: null, and spawning is
    // refused (errors.agentsMax) rather than allowed under the default.
    agentsMax: field("agentsMax", () => {
      const v = String(env.HOPTELL_AGENTS_MAX ?? "").trim();
      if (v === "") return 4;
      const n = Number(v);
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < 1) throw new Error(`HOPTELL_AGENTS_MAX must be a whole number from 1 to 16, not ${JSON.stringify(v.slice(0, 40))}`);
      if (n > 16) warnings.push(`HOPTELL_AGENTS_MAX is at most 16, not ${n}; using 16`);
      return Math.min(16, n);
    }, null),
    // Desktop notifications for messages waiting for the owner's decision (on unless "off").
    notify: choice(envNotify(env)),
    pid,
    hostname,
    // Race tests only: paths handed to the services that pause at named steps.
    barriers: { wake: env.HOPTELL_WAKE_TEST_BARRIER || null, reader: env.HOPTELL_READER_TEST_BARRIER || null },
    // Encrypted direct messages (design 3.3): EXPERIMENTAL, present only with
    // HOPTELL_EXPERIMENTAL_E2EE=1 (the MLS driver's location and the device's credential store).
    ...(e2ee
      ? { e2ee: { env: Object.fromEntries(["HOPTELL_MLS_DRIVER", "HOPTELL_MLS_WASM", "HOPTELL_CREDENTIAL_STORE", "HOPTELL_CREDENTIAL_PASSPHRASE"].filter((k) => env[k]).map((k) => [k, env[k]])) } }
      : {}),
    errors,
    warnings,
  });
}

/** The settings problem that stops a session from starting (errors.name, .e2ee, .credentialStore, .titleAuto), or null. */
export const settingsProblem = (settings) => settings.errors.name ?? settings.errors.e2ee ?? settings.errors.credentialStore ?? settings.errors.titleAuto ?? null;
