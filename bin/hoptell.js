#!/usr/bin/env node
// hoptell: let AI coding agents (Claude Code, Codex, ...) message each other
// across sessions, machines and accounts through a small self-hosted relay.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOSTNAME, checkName, defaultHome, envFiles, loadEnv, parseProtocol, parseRoles } from "../lib/config.js";

// Claude Code hook commands (lib/wake.js) print only what Claude Code expects, never errors.
const HOOKS = { "hook-session-start": "hookSessionStart", "hook-file-changed": "hookFileChanged" };
if (Object.hasOwn(HOOKS, process.argv[2] ?? "")) {
  let code = 0;
  try {
    const i = process.argv.indexOf("--home", 3);
    if (i > 0 && process.argv[i + 1]) process.env.HOPTELL_HOME = process.argv[i + 1];
    loadEnv();
    const wake = await import("../lib/wake.js");
    code = wake[HOOKS[process.argv[2]]]({ home: defaultHome(process.env, os.homedir()), barrier: process.env.HOPTELL_WAKE_TEST_BARRIER || null });
  } catch {
    code = 0;
  }
  process.exit(code);
}

// A client's headers helper for hoptell mcp-http: prints {"X-Hoptell-Hook-Registration": id} for
// the Claude Code process it runs under, or {} (never an error: the client then has no hooks).
if (process.argv[2] === "hook-header") {
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

try {
  loadEnv();
} catch (e) {
  console.error(`hoptell: ${e.message}`);
  process.exit(1);
}

const USAGE = `hoptell - messaging between AI coding agents over your own LAN/VPN

Usage:
  hoptell relay --host <ip> [--port 7777] [--members file.json] [--policy policy.json] [--trusted-proxies <ip/cidr,...>]
                [--log-format text|json] [--metrics-port <port>] [--wal-soft-limit <size>] [--wal-hard-limit <size>]
                                            run the relay (one machine per team)
  hoptell relay broker-reset --yes [--state-dir <dir>]
                                            with the relay stopped: a new broker refresh key; every broker
                                            sign-in ends (after the key was lost or damaged)
  hoptell relay admin status|members|devices|policy|grants|revocations|metrics|store|audit|reload|checkpoint
                | backup <dir> | restore <dir>|--resume|--abort | devices reinstate <member> <device> | ui
                                            the relay owner's views and controls (on the relay host); see
                                            hoptell relay admin help
  hoptell members list|add <name>|revoke <name>|migrate [--yes]|link|unlink <name> --issuer <url> --subject <sub>|signout <name> [--members <file>]
                                            manage the relay's members file on the relay host; add shows
                                            the new token once and stores only its SHA-256; signout ends
                                            the member's broker sign-ins made until now
  hoptell grants [show] | allow|deny <selector> [--until <s>] | deny-forever member:<id> | remove <selector> [--yes --rev N]
                | default allow|deny | visible all|grantees [--yes]
                                            who may reach your sessions through the relay (gate 2);
                                            selectors: *, group:<name>, member:<id>
  hoptell local-relay install [--port 7788]|start|stop|status|uninstall [--purge]
                                            a private relay for your own sessions on this machine
                                            (loopback, a user service, a token only you can read)
  hoptell contacts [list|show|allow|allow-once|block|grants|blocks|revoke|unblock|check|init]
                                            decide who may reach your agent sessions; senders without a
                                            grant wait in quarantine until you decide (see README)
  hoptell contacts request <name> [--reason collaborate|review|handoff|other]
                                            ask a member who does not accept you yet at the relay
  hoptell contacts requests [accept|deny|deny-forever <id>]
                                            contact requests waiting for you at the relay (acts at once)
  hoptell ui [--port N] [--open]           the owner's pages on 127.0.0.1: what waits for your decision,
                                            contacts, devices, settings (prints a single-use launch link)
  hoptell login [--issuer <url|broker id>] [--mode broker|resource] [--device | --client-credentials --client-id <id> --client-secret-file <file>] [--store file]
                                            sign in to the relay with your identity provider; then HOPTELL_AUTH=login
  hoptell logout                            remove (and revoke) the stored sign-in credential
  hoptell mcp                               MCP server for an agent session (stdio)
  hoptell mcp-http [--port 7790]            the same over HTTP on 127.0.0.1, for clients that only speak HTTP
  hoptell mcp-http client add <label> [--name <peer>] [--roles a,b] | list | remove <label>
  hoptell mcp-hosted --experimental --config <file> --state-dir <dir>
                                            EXPERIMENTAL hosted MCP endpoint behind an HTTPS proxy: the host
                                            reads its tenants' messages; link|unlink|list manage its links
                                            tokens for those clients (shown once, stored hashed)
  hoptell tmux <name> [--roles a,b] -- <agent command>
                                            run an agent in tmux; attempt an inbox notice when its prompt appears idle
  hoptell list                              list peers on the relay
  hoptell send [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>
                                            send a message (as $HOPTELL_NAME, without going online);
                                            --ttl: request relay queue expiry; older relays ignore it;
                                            --reply-to: the "Message reference" you are answering
  hoptell snapshot <file>                   print a UTF-8 file snapshot with its SHA-256, for review
  hoptell snapshot --check <sha256> <file>  exit 0 if the bytes match; nonzero if different or the check fails
  hoptell apply                             list proposals that answered your review sets and wait for you
  hoptell apply <proposal id> [--preview | --yes]
                                            show what a proposal changes (from the captured bytes) and, after
                                            you confirm, write it; --preview writes nothing
  hoptell apply --recover [--finish | --roll-back]
                                            after an interrupted apply: show each file's state, then finish
                                            it or restore the files as they were
  hoptell wait [--wait-for-name | --replace] [seconds]
                                            go online as $HOPTELL_NAME, print the next message, exit;
                                            if another session has the name: stop (default), wait for it
                                            (--wait-for-name), or take it over once (--replace)
  hoptell listen [--no-ack] <name> [seconds]
                                            wait for the next messages in <name>'s local inbox, print them, exit
  hoptell listen [--no-ack] --session <folder> [seconds]
                                            the same for an agent session's storage folder (shown by the session);
                                            acknowledges after printing, or prints a receipt with --no-ack
  hoptell ack <receipt> (<name> | --session <folder>)
                                            acknowledge messages printed with --no-ack
  hoptell doctor [--relay-check] [--fix]    check settings, relay, login, inbox and tmux on this machine;
                                            --relay-check: also send a test message through the relay;
                                            --fix: remove transfer leftovers (staging, outbox)
  hoptell transfers [cancel <t_id>]         EXPERIMENTAL: file transfers staged for you (or being fetched)
  hoptell save <t_id> <path> [--overwrite] [--yes] | --forget <t_id>
                                            EXPERIMENTAL: save a staged transfer to a path you choose
                                            (never replaces a file without --overwrite)
  hoptell hooks                             print Claude Code hook settings for hook delivery without the plugin

Settings: environment variables, else the first file found of
${envFiles().map((f) => `  ${f}`).join("\n")}
Peers:  HOPTELL_RELAY, HOPTELL_TOKEN, HOPTELL_NAME, HOPTELL_ROLES (e.g. reviewer,backend),
        HOPTELL_PUSH (channel, hook, tmux or listener; unset for automatic),
        HOPTELL_PROTOCOL (1 to keep the older relay protocol), HOPTELL_PROFILE,
        HOPTELL_RECEIPTS (on/off), HOPTELL_LEASE_MINUTES, HOPTELL_NOTIFY (off: no desktop notifications),
        HOPTELL_AUTH (login: use hoptell login), HOPTELL_CREDENTIAL_STORE (file), HOPTELL_CREDENTIAL_PASSPHRASE
Relay:  HOPTELL_HOST, HOPTELL_PORT, HOPTELL_TOKEN and/or HOPTELL_MEMBERS (members file); HOPTELL_POLICY (access policy file);
        HOPTELL_LOG_FINGERPRINTS=on with HOPTELL_LOG_FINGERPRINT_KEY_FILE for keyed log fingerprints;
        HOPTELL_TRUSTED_PROXIES, HOPTELL_LOG_FORMAT, HOPTELL_METRICS_PORT, HOPTELL_METRICS_HOST,
        HOPTELL_OIDC (sign-in configuration file)

Send to a peer name, to @<role> (every online peer with the role) or to @all.`;

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
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
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

/** Device keys and enrollment (design 3.2) are experimental: off unless HOPTELL_EXPERIMENTAL_E2EE=1. */
const experimentalE2ee = () => /^(1|true|on|yes)$/i.test(String(process.env.HOPTELL_EXPERIMENTAL_E2EE ?? "").trim());

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
    q.openContacts(home(), { notify: String(process.env.HOPTELL_NOTIFY ?? "").trim().toLowerCase() !== "off", log: (...a) => console.error("hoptell:", ...a) }),
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
  const rel = path.relative(home(), dir).split(path.sep);
  return rel[0] === "v2" ? { realm: rel[1], name: rel[3] } : { realm: null, name: rel[1] };
};

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
  process.env.HOPTELL_RELAY = e.url;
  process.env.HOPTELL_AUTH = e.auth;
  if (e.auth === "token") process.env.HOPTELL_TOKEN = e.token;
  else delete process.env.HOPTELL_TOKEN;
  if (e.profile) process.env.HOPTELL_PROFILE = e.profile;
  else delete process.env.HOPTELL_PROFILE;
  if (e.name) process.env.HOPTELL_NAME = e.name;
  else if (e.namePrefix && process.env.HOPTELL_NAME) process.env.HOPTELL_NAME = `${e.namePrefix}${process.env.HOPTELL_NAME}`.slice(0, 64);
  return { relays: r, entry: e, qualified: Boolean(flag || addressAlias) };
}

async function connect(mode, onMessage, budgetMs = CONNECT_BUDGET_MS, { waitForName = false, replace = false } = {}) {
  await contactsOf();
  const { RelayClient } = await import("../lib/client.js");
  const { commitWelcome, noteLegacy, profileKey } = await import("../lib/profiles.js");
  const roles = mode === "peer" ? parseRoles(process.env.HOPTELL_ROLES) : [];
  const protocol = parseProtocol(process.env.HOPTELL_PROTOCOL);
  const profile = protocol === 2 && process.env.HOPTELL_RELAY ? profileKey(process.env.HOPTELL_RELAY, process.env.HOPTELL_PROFILE || null) : null;
  const name = cliName() ?? (protocol === 1 ? `${HOSTNAME}-cli` : null);
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
  if (onMessage) c.on("message", (m, confirm) => onMessage(m, confirm, c));
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
      const { login } = await import("../lib/login.js");
      await contactsOf(); // classify the home first, as every command that creates state does
      const service = args.includes("--client-credentials") ? { clientId: opt("--client-id"), clientSecret: opt("--client-secret-file") ? fs.readFileSync(opt("--client-secret-file"), "utf8").trim() : null } : null;
      const r = await login({
        relayUrl: process.env.HOPTELL_RELAY ?? fail("HOPTELL_RELAY is not set"),
        home: home(),
        profile: await profileOfRelay(),
        issuer: opt("--issuer") ?? null,
        signInMode: opt("--mode") ? (["broker", "resource"].includes(opt("--mode")) ? opt("--mode") : fail("--mode must be broker or resource", 2)) : null,
        mode: service ? "service" : args.includes("--device") ? "device" : "browser",
        service,
        store: opt("--store") === "file" || process.env.HOPTELL_CREDENTIAL_STORE === "file" ? "file" : "auto",
        passphrase: process.env.HOPTELL_CREDENTIAL_PASSPHRASE || null,
      });
      console.log(`Signed in with ${r.issuer} (${r.kind === "service" ? "client credentials" : r.kind === "broker" ? `your account, through the relay (broker ${r.broker})` : "your account"}); the credential is kept in the ${r.store}. Set HOPTELL_AUTH=login for this relay.`);
      break;
    }
    case "logout": {
      const { logout } = await import("../lib/login.js");
      const r = await logout({ home: home(), profile: await profileOfRelay(), passphrase: process.env.HOPTELL_CREDENTIAL_PASSPHRASE || null });
      if (!r.removed) console.log("Not signed in for this relay.");
      else {
        const rev = r.revoked === true ? (r.kind === "broker" ? "ended at the relay" : "revoked at the identity provider") : r.revoked === "unsupported" ? "the identity provider does not offer revocation" : r.revoked === false ? (r.kind === "broker" ? "ending it at the relay failed" : "revoking it at the identity provider failed") : "a service credential (nothing to revoke)";
        console.log(`Signed out: the stored credential was removed (${rev}). Running sessions stop at their next renewal; access tokens already issued stay valid at the relay until they expire.`);
      }
      break;
    }
    case "grants": {
      // grants [show] | allow <selector> [--until <seconds>] | deny <selector> | deny-forever member:<id>
      //        | remove <selector> | default allow|deny | visible all|grantees   (publish with --yes)
      const [sub = "show", arg] = args.filter((a, i) => !a.startsWith("--") && !["--until", "--rev"].includes(args[i - 1]));
      await selectRelay();
      const c = await connect("send");
      try {
        const cur = (await c.rpc({ type: "grants_get" })).grants;
        const show = (g) => {
          console.log(`Revision ${g.revision ?? "?"}: default ${g.default}; visible to ${g.visible === "grantees" ? "those you allow only" : "everyone"}.`);
          for (const e of g.entries) console.log(`  ${e.action.padEnd(5)} ${e.selector}${e.until ? ` until ${new Date(e.until).toISOString()}` : ""}${e.requests === "blocked" ? " (no contact requests)" : ""}`);
          if (!g.entries.length) console.log("  (no entries)");
        };
        if (sub === "show") {
          show(cur);
          break;
        }
        const others = (sel) => cur.entries.filter((e) => e.selector !== sel);
        const untilArg = opt("--until");
        if (untilArg !== undefined && !(Number.isSafeInteger(Number(untilArg)) && Number(untilArg) > 0)) fail("--until needs a number of seconds", 2);
        const until = untilArg !== undefined ? Date.now() + Number(untilArg) * 1000 : undefined;
        let next;
        if (sub === "allow" && arg) next = { ...cur, entries: [...others(arg), { selector: arg, action: "allow", ...(until ? { until } : {}) }] };
        else if (sub === "deny" && arg) next = { ...cur, entries: [...others(arg), { selector: arg, action: "deny", ...(until ? { until } : {}) }] };
        else if (sub === "deny-forever" && arg?.startsWith("member:")) next = { ...cur, entries: [...others(arg), { selector: arg, action: "deny", requests: "blocked" }] };
        else if (sub === "remove" && arg) next = { ...cur, entries: others(arg) };
        else if (sub === "default" && ["allow", "deny"].includes(arg)) next = { ...cur, default: arg };
        else if (sub === "visible" && ["all", "grantees"].includes(arg)) next = { ...cur, visible: arg };
        else fail("usage: hoptell grants [show] | allow|deny <*|group:<name>|member:<id>> [--until <seconds>] | deny-forever member:<id> | remove <selector> | default allow|deny | visible all|grantees [--yes --rev N]", 2);
        console.log("These grants say who may reach your sessions through this relay (your machine's contacts decide too).");
        show({ ...next, revision: `${cur.revision} -> ${cur.revision + 1}` });
        if (!args.includes("--yes")) {
          console.log(`Nothing published yet: run the same command with --yes --rev ${cur.revision} to publish exactly this change.`);
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
        console.log(`Published (revision ${r.revision}).`);
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
        const name = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--reason")[1];
        const reason = opt("--reason", "other");
        if (!name) fail("usage: hoptell contacts request <name> [--reason collaborate|review|handoff|other]", 2);
        if (!["collaborate", "review", "handoff", "other"].includes(reason)) fail("--reason must be collaborate, review, handoff or other", 2);
        await selectRelay();
        const c = await connect("send");
        try {
          await c.rpc({ type: "contact_request", to: name, reason });
          console.log(`Request sent to the relay. If ${name} is a member that does not accept you yet, its owner sees your member name and the reason (${reason}); nothing else is sent, and you are not told whether it was shown.`);
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
        const [, action = "list", id] = args.filter((a) => !a.startsWith("--"));
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
          } else fail("usage: hoptell contacts requests [list] | accept|deny|deny-forever <id>", 2);
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
      const c = await contactsOf();
      const [sub = "list", target, third] = args.filter((a, i) => !a.startsWith("--") && !["--rev", "--policy-rev", "--session", "--how"].includes(args[i - 1]));
      const num = (flag) => {
        const v = opt(flag);
        if (v === undefined || !/^\d+$/.test(v)) fail(`${flag} <number> is required (shown by hoptell contacts show)`, 2);
        return Number(v);
      };
      const where = `contacts of ${home()}`;
      try {
        if (sub === "list") {
          const st = await c.status();
          const pol = st.policy;
          console.log(`hoptell ${where}: ${st.mode === "legacy-allow" ? "not managed yet (every sender reaches your sessions as before); run hoptell contacts init" : pol.problem ? `managed, but ${pol.problem}: every sender waits for your decision` : `managed (default: ${pol.doc.default}, unverified senders: ${pol.doc.unverified ?? "ask"}), policy revision ${st.policyRevision}`}`);
          if (!st.requests.length) console.log("No messages are waiting for your decision.");
          for (const r of st.requests) console.log(`${r.id}  ${r.sender.label}  ${r.items} message(s) for ${r.sessions.join(", ")}  since ${r.created}${r.dropped ? `  (${r.dropped} dropped over the limits)` : ""}`);
          if (st.withheld) console.log(`${st.withheld} earlier message(s) are withheld until the quarantine has room.`);
          if (st.journalsWaiting) console.log(`${st.journalsWaiting} decision(s) are waiting for room in an inbox.`);
          if (st.requests.length) console.log("Next: hoptell contacts show <id>");
        } else if (sub === "show") {
          if (!target) fail("usage: hoptell contacts show <id> [--text]", 2);
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
          if (r.sender.auth !== "unverified") console.log(`  hoptell contacts allow ${r.id} --rev ${r.rev} --policy-rev ${r.policyRevision}${scopeHint}   (always: adds a grant)`);
          console.log(`  hoptell contacts allow-once ${r.id} --rev ${r.rev} --policy-rev ${r.policyRevision}${scopeHint}   (only these messages)`);
          console.log(`  hoptell contacts block ${r.id} --rev ${r.rev} --policy-rev ${r.policyRevision}   (deletes them; blocks the sender)`);
        } else if (["allow", "allow-once", "block"].includes(sub)) {
          if (!target) fail(`usage: hoptell contacts ${sub} <id> --rev N --policy-rev P${sub === "block" ? "" : " [--session <scope>]"}`, 2);
          const token = { rev: num("--rev"), policyRev: num("--policy-rev") };
          const d = await decisions.decide({ home: home(), id: `contact:${target}`, action: sub, token, options: { session: opt("--session") ?? null }, sources: { contacts: c } });
          if (d.stale) fail(`request ${target} changed since it was shown (now --rev ${d.nativeToken.rev} --policy-rev ${d.nativeToken.policyRev}); show it again before deciding`);
          if (d.refused || d.busy) fail(d.reason);
          const r = d.effects;
          console.log(`${sub === "block" ? "Blocked; its messages were deleted." : `Released ${r.steps} message(s)${sub === "allow" ? " and added a grant" : ""}.`}${r.waiting ? " Some wait for room in a full inbox and are released when there is room." : ""}`);
        } else if (sub === "grants" || sub === "blocks") {
          const { doc, problem } = c.currentPolicy();
          if (!doc) fail(problem ?? "no policy yet: run hoptell contacts init");
          console.log(`Policy revision ${doc.revision ?? 0}:`);
          for (const e of doc[sub] ?? []) console.log(`${e.id ?? "(no id)"}  ${e.member ? `member ${e.member}` : e.shared ? `shared ${e.name}` : `unverified ${e.relay}/${e.name}`}${e.realm ? ` in ${e.realm}` : ""}${e.session ? ` for ${e.session.realm}/${e.session.name}` : ""}${e.added ? `  (${e.added})` : ""}`);
          if (!(doc[sub] ?? []).length) console.log(`No ${sub}.`);
        } else if (sub === "revoke" || sub === "unblock") {
          if (!target) fail(`usage: hoptell contacts ${sub} <id> --policy-rev P`, 2);
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
          else fail("usage: hoptell contacts check <realm> member <id> | <realm> shared <name> | unverified <profile> <name> [--session <realm>/<name>]", 2);
          const s = opt("--session");
          const session = s ? (s.startsWith("legacy/") ? { realm: null, name: s.slice(7) } : { realm: s.split("/")[0], name: s.split("/")[1] }) : null;
          const p = c.currentPolicy();
          console.log(p.legacy ? "allow (not managed yet)" : decide(p.doc, key, session));
        } else if (sub === "verify" || sub === "accept-device" || sub === "forget-device") {
          // Device pins (design 3.2): EXPERIMENTAL, only with HOPTELL_EXPERIMENTAL_E2EE=1.
          if (!experimentalE2ee()) fail(`hoptell contacts ${sub} is experimental (device keys, design 3.2): set HOPTELL_EXPERIMENTAL_E2EE=1 to try it`, 2);
          const { verifyCommand, conversationCommand } = await import("../lib/mls/cli.js");
          // The encrypted conversation's checkpoint (design 3.3), for comparing histories.
          if (sub === "verify" && args.includes("--conversation")) await conversationCommand({ member: target, home: home(), profile: await profileOfRelay(), env: process.env });
          else await verifyCommand({ sub, member: target, device: third, yes: args.includes("--yes"), how: opt("--how") ?? null, set: opt("--set") ?? null, home: home(), profile: await profileOfRelay(), connect: () => connect("send", null), contacts: c });
        } else if (sub === "encryption") {
          // The require-encryption policy (design 3.3): EXPERIMENTAL, only with HOPTELL_EXPERIMENTAL_E2EE=1.
          if (!experimentalE2ee()) fail("hoptell contacts encryption is experimental (encrypted messages, design 3.3): set HOPTELL_EXPERIMENTAL_E2EE=1 to try it", 2);
          const usage = "usage: hoptell contacts encryption <member id> | --default  required|preferred|off|clear  (for the current relay's realm)";
          const pos = args.filter((a) => !a.startsWith("--"));
          const [who, mode] = args.includes("--default") ? [null, pos[1]] : [pos[1], pos[2]];
          if ((!who && !args.includes("--default")) || !["required", "preferred", "off", "clear"].includes(mode)) fail(usage, 2);
          const rc = await connect("send", null);
          const realmId = rc.realm?.id;
          rc.close();
          if (!realmId) fail("the relay did not name its realm (protocol 2 is needed)");
          await c.setEncryption({ realm: realmId, member: who, mode: mode === "clear" ? null : mode });
          console.log(`${who ? `Encryption with ${who}` : "The realm's default encryption"} is now ${mode === "clear" ? "unset" : mode} (EXPERIMENTAL).`);
        } else if (sub === "init") {
          const r = await c.init();
          console.log(r.already ? `The ${where} are already managed.` : `The ${where} are now managed: senders without a grant wait for your decision (hoptell contacts). Nobody was granted. Messages already waiting in your sessions' inboxes are held back on their next read.`);
        } else fail(`unknown contacts command "${sub}" (see hoptell help)`, 2);
      } catch (e) {
        if (e instanceof q.DecisionError) fail(e.message);
        throw e;
      }
      break;
    }
    case "ui": {
      // ui [--port N] [--open]: the owner UI (design 3.4), loopback only, in the foreground.
      const port = Number(opt("--port", "0"));
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port", 2);
      if (args.includes("--host") && opt("--host") !== "127.0.0.1") fail("hoptell ui binds 127.0.0.1 only", 2);
      const { loadedEnvFile, loadedEnvKeys } = await import("../lib/config.js");
      const { settingsContext } = await import("../lib/decisions.js");
      const { startOwnerUi } = await import("../lib/ownerui.js");
      const contacts = await contactsOf();
      const sources = { contacts };
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
      console.log(`hoptell ui at ${ui.origin}. Open this link within 60 seconds (single use):\n\n  ${link}\n\nCtrl-C ends it.`);
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
      const sub = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") ?? "status";
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
        if (!st.installed) console.log("Not installed: hoptell local-relay install");
        else {
          console.log(`${st.url}: service ${st.loaded ? "loaded" : "not loaded"}, ${st.signedIn ? "its token signs in" : st.healthy ? "answering" : "not answering"}; token in ${st.tokenFile}`);
          for (const p of st.problems) console.log(`warning: ${p}`);
          if (!st.signedIn || st.problems.length) process.exitCode = 1;
        }
      } else if (sub === "uninstall") {
        const r = await lr.uninstallLocalRelay(o, { purge: args.includes("--purge") });
        console.log(r.removed ? `Removed the service${r.entryRemoved ? " and its relays entry" : ""}${r.purged ? ", the token and the realm state" : "; the token and the realm state are kept (--purge removes them)"}.` : "Not installed.");
        if (r.note) console.log(`Note: ${r.note}.`);
      } else fail("usage: hoptell local-relay install [--port 7788]|start|stop|status|uninstall [--purge]", 2);
      break;
    }
    case "members": {
      const [sub, name, third] = args.filter((a, i) => !a.startsWith("--") && !["--members", "--state-dir", "--host", "--issuer", "--subject"].includes(args[i - 1]));
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
      if (sub === "list") {
        const rows = m.listMembers(file);
        if (!rows.length) console.log("No members.");
        for (const r of rows) console.log(`${r.name}\t${r.id ?? "(no id: run hoptell members migrate)"}\t${r.custody === "hosted" ? `hosted by ${r.host}` : `${r.token} token`}`);
      } else if (sub === "add" && name) {
        const c = await changeOf("members.add", name, () => m.addMember(file, name));
        const r = c.value;
        console.log(`Added member "${r.name}" (${r.id}). Its token, shown only now:\n\n  ${r.token}\n\nGive it to ${r.name} privately; ${file} keeps only its SHA-256. ${r.name}'s sessions may use the names ${r.name} and ${r.name}-<anything>.\n${appliedNote(c)}`);
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
        if (!experimentalE2ee()) fail("hoptell members device-revoke is experimental (device keys, design 3.2): set HOPTELL_EXPERIMENTAL_E2EE=1 to use it", 2);
        const c = await changeOf("members.device-revoke", `${name}/${third}`, () => m.revokeMemberDevice(file, name, third));
        console.log(c.value.already ? `Device ${third} of "${name}" is already revoked.` : `Revoked device ${third} of "${name}": once the relay applies it, it no longer serves that device's KeyPackages or directory entry. ${appliedNote(c)}`);
      } else if (sub === "device-approve" && name && third) {
        // A12: the relay admin approves a new device's pending request when none of the member's
        // devices can (all suspended, or all lost); over the admin channel, audited.
        if (!experimentalE2ee()) fail("hoptell members device-approve is experimental (device keys, design 3.2): set HOPTELL_EXPERIMENTAL_E2EE=1 to use it", 2);
        const words = args.filter((a, i) => !a.startsWith("--") && !["--members", "--state-dir"].includes(args[i - 1]));
        const fingerprint = words.slice(3).join(" ");
        if (!fingerprint) fail("usage: hoptell members device-approve <member> <device> <fingerprint> (the fingerprint the new device shows)", 2);
        const { adminCommand } = await import("../lib/admincli.js");
        process.exitCode = await adminCommand({ args: ["devices", "approve", name, third, fingerprint, ...(args.includes("--json") ? ["--json"] : [])], stateDir: opt("--state-dir", process.env.HOPTELL_STATE_DIR) || defaultStateDir(), config: { members: file, policy: process.env.HOPTELL_POLICY || null, oidc: process.env.HOPTELL_OIDC || null }, e2ee: true });
      } else if (sub === "add-hosted" && name) {
        // Hosted custody (design 4.5, experimental): a new member held by a host; never an existing one.
        const c = await changeOf("members.add-hosted", name, () => m.addHostedMember(file, name, opt("--host")));
        console.log(`Added hosted member "${name}" (${c.value.id}) held by host "${c.value.host}". It has no token: only that host signs in for it, and peers see it labeled hosted (the host can read its messages).\n${appliedNote(c)}`);
      } else if (sub === "host" && name === "list") {
        const rows = m.listHosts(file);
        if (!rows.length) console.log("No hosts.");
        for (const r of rows) console.log(`${r.id}\t${r.token} token`);
      } else if (sub === "host" && name === "add" && third) {
        const c = await changeOf("members.host-add", third, () => m.addHost(file, third));
        console.log(`Added host "${third}". Its token, shown only now:\n\n  ${c.value.token}\n\nConfigure it on that host privately; ${file} keeps only its SHA-256. It may open only members hosted by "${third}".\n${appliedNote(c)}`);
      } else if (sub === "host" && name === "remove" && third) {
        const c = await changeOf("members.host-remove", third, () => m.removeHost(file, third));
        console.log(`Removed host "${third}". ${appliedNote(c)}`);
      } else if (sub === "migrate") {
        const pending = m.migrateMembers(file, { apply: false });
        const p = (await pending).pending;
        if (!p.length) console.log("Every member already has an id.");
        else if (!args.includes("--yes")) {
          console.log(`Members without an id: ${p.join(", ")}.\nGiving them ids changes their identity on the relay: their sessions reconnect and messages queued for them are dropped. Run again with --yes to do it.`);
        } else {
          const c = await changeOf("members.migrate", null, () => m.migrateMembers(file, { apply: true }));
          console.log(`Gave ids to: ${c.value.pending.join(", ")}. ${appliedNote(c)}`);
        }
      } else fail("usage: hoptell members list|add <name>|revoke <name>|link|unlink <name> --issuer <URL> --subject <subject>|signout <name>|migrate [--yes]|add-hosted <name> --host <id>|host add|remove <id>|host list|device-revoke <name> <device>|device-approve <name> <device> <fingerprint> [--members <file>] [--state-dir <dir>]", 2);
      break;
    }
    case "relay": {
      const { defaultStateDir } = await import("../lib/realm.js");
      const stateDirOf = () => opt("--state-dir", process.env.HOPTELL_STATE_DIR) || defaultStateDir();
      const configFiles = () => ({ members: opt("--members", process.env.HOPTELL_MEMBERS) || null, policy: opt("--policy", process.env.HOPTELL_POLICY) || null, oidc: opt("--oidc", process.env.HOPTELL_OIDC) || null });
      if (args[0] === "admin") {
        // The relay owner's commands (design 4.4): over the admin socket, or offline with the lock.
        const { adminCommand } = await import("../lib/admincli.js");
        const crash = process.env.HOPTELL_RESTORE_TEST_CRASH || null; // tests: a real crash at a restore point
        process.exitCode = await adminCommand({ args: args.slice(1), stateDir: stateDirOf(), config: configFiles(), e2ee: args.includes("--experimental-e2ee") || experimentalE2ee(), testFault: crash ? (p) => p === crash && process.kill(process.pid, "SIGKILL") : null });
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
      const { startRelay } = await import("../lib/relay.js");
      const port = Number(opt("--port", process.env.HOPTELL_PORT || 7777));
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
      const membersFile = opt("--members", process.env.HOPTELL_MEMBERS);
      const { loadMembersAndHosts } = await import("../lib/members.js");
      // The members list and the host credentials (design 4.5) come from one read of the file.
      let hostsRead = null;
      const readMembers = () => {
        const d = loadMembersAndHosts(membersFile);
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
      const release = lockStateDir(stateDirectory);
      for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (release(), process.exit(0)));
      process.on("exit", release);
      // An unfinished restore fences the state directory (design 4.4): checked before any store,
      // access state or broker state is opened.
      const fence = readRestoreIntent(stateDirectory);
      if (fence) fail(fencedMessage(fence));
      const realmName = opt("--realm-name", process.env.HOPTELL_REALM_NAME);
      if (realmName && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(realmName)) fail("invalid --realm-name: letters, digits, '.', '_' and '-', up to 64 characters");
      const realm = { id: loadRealm(stateDirectory, process.env.HOPTELL_REALM_ID || null), name: realmName || undefined };
      // The store opens on every start (design 4.4: the audit log, the store's instance id and the
      // restore marker live there); the device service stays behind the experimental flag.
      const { openRelayStore } = await import("../lib/relaystore.js");
      // WAL admission (design 6): every write of the store is admitted against the log's size.
      const size = (flag, env) => {
        const v = opt(flag, process.env[env]);
        if (v === undefined || v === null || v === "") return undefined;
        const n = parseSize(v);
        if (n === null) fail(`invalid ${flag}: a size such as 256MiB, 1GiB or a number of bytes`);
        return n;
      };
      const admission = Object.fromEntries(Object.entries({ soft: size("--wal-soft-limit", "HOPTELL_WAL_SOFT_LIMIT"), hard: size("--wal-hard-limit", "HOPTELL_WAL_HARD_LIMIT") }).filter(([, v]) => v !== undefined));
      if (admission.soft !== undefined && admission.hard === undefined && admission.soft > 512 * 1024 * 1024) fail("--wal-soft-limit must not be above --wal-hard-limit (512MiB unless set)");
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
      const requireMembers = args.includes("--require-members") || /^(1|true|on|yes)$/i.test(process.env.HOPTELL_REQUIRE_MEMBERS || "");
      // Sign-in with identity providers (design 1.6): explicit issuers from --oidc / HOPTELL_OIDC.
      const oidcFile = opt("--oidc", process.env.HOPTELL_OIDC);
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
        const config = o.loadOidcConfig(oidcFile);
        const brokerIssuers = config.issuers.filter((i) => i.mode === "broker");
        // Broker mode (design 1.7): its families and refresh key live in this relay's state directory.
        const broker = brokerIssuers.length || brokerState ? await (await import("../lib/broker.js")).createBroker({ issuers: brokerIssuers, stateDir: stateDirectory, log, audit }) : null;
        oidc = { config, verifier: config.issuers.some((i) => i.mode === "resource") ? await o.createVerifier(config, { log }) : null, discovery: o.discoveryDocument(config, realm.id), broker };
        log(`sign-in with ${config.issuers.map((i) => `${i.issuer}${i.mode === "broker" ? ` (broker ${i.id})` : ""}`).join(", ")}`);
      }
      // Access (design 4.1/4.2): the admin policy (gate 1) from --policy / HOPTELL_POLICY, and the
      // members' own grants (gate 2) in the state directory. Without either nothing changes.
      const { createAccess, loadPolicy } = await import("../lib/access.js");
      const policyFile = opt("--policy", process.env.HOPTELL_POLICY);
      const access = createAccess({ stateDir: stateDirectory, policy: policyFile ? loadPolicy(policyFile) : null });
      // Device keys (design 3.2): EXPERIMENTAL, only on explicit request.
      const e2ee = args.includes("--experimental-e2ee") || experimentalE2ee();
      let devices = null;
      if (e2ee) {
        const { createDeviceDirectory } = await import("../lib/mls/relaydir.js");
        const { createDeliveryService } = await import("../lib/mls/relayds.js");
        const { createTransferStore } = await import("../lib/mls/relaytransfers.js");
        const directory = createDeviceDirectory({ db, realm: realm.id });
        // Larger transfers (design 6) on the same store; the quotas are relay options.
        const quota = Object.fromEntries(Object.entries({ totalQuota: size("--transfer-quota", "HOPTELL_TRANSFER_QUOTA"), memberQuota: size("--transfer-member-quota", "HOPTELL_TRANSFER_MEMBER_QUOTA") }).filter(([, v]) => v !== undefined));
        let transfers;
        try {
          transfers = createTransferStore({ db, limits: quota, log });
        } catch (e) {
          fail(e.message);
        }
        devices = { directory, ds: createDeliveryService({ db, directory, realm: realm.id, transfers }), transfers };
        log("EXPERIMENTAL: device keys, encrypted messages and larger transfers (designs 3.2, 3.3, 6) are enabled; not for production use");
      }
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
      const relay = await startRelay({ host: opt("--host", process.env.HOPTELL_HOST), port, token: process.env.HOPTELL_TOKEN, members: membersFile ? readMembers() : null, hosts: hostsRead, requireMembers, realm, fingerprint, trustedProxies, oidc, access, devices, audit, extraStats: () => ({ auditDropped: dropped(), ...storeStats() }), log });
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
      const metricsPort = opt("--metrics-port", process.env.HOPTELL_METRICS_PORT);
      if (metricsPort) {
        const mp = Number(metricsPort);
        if (!Number.isInteger(mp) || mp < 1 || mp > 65535) fail("invalid --metrics-port");
        const metricsHost = opt("--metrics-host", process.env.HOPTELL_METRICS_HOST || "127.0.0.1");
        await startMetrics(relay, { host: metricsHost, port: mp });
        log(`metrics on http://${metricsHost}:${mp}/metrics`);
      }
      // kill -HUP and the admin socket's reload: re-read the members file (revoked tokens are
      // disconnected) and the policy file; on any problem keep the current list or policy.
      if (membersFile || policyFile) {
        process.on("SIGHUP", () => {
          let r;
          try {
            r = admin.reload({}, "relay");
          } catch (e) {
            return log(`reload failed: ${e.message}`);
          }
          if (r.policy) log(r.policy.ok ? "access policy reloaded" : `policy reload failed; keeping the active policy: ${r.policy.error}`);
          if (r.members && !r.members.ok) console.log(new Date().toISOString(), r.members.applied ? `members reload failed: ${r.members.error}` : `members reload failed; keeping the active members list: ${r.members.error}`);
        });
      }
      break;
    }
    case "device": {
      // Device keys and enrollment (design 3.2): EXPERIMENTAL, only with HOPTELL_EXPERIMENTAL_E2EE=1.
      if (!experimentalE2ee()) fail("hoptell device is experimental (device keys, design 3.2): set HOPTELL_EXPERIMENTAL_E2EE=1 to try it (encrypted messages are experimental and not independently reviewed)", 2);
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
      if (sub === "client") {
        const h = await import("../lib/httpmcp.js");
        const [, action, label] = args.filter((a, i) => !a.startsWith("--") && !["--port", "--name", "--roles"].includes(args[i - 1]));
        if (action === "add" && label) {
          const r = await h.addClient(home(), label, { name: opt("--name") ?? null, roles: parseRoles(opt("--roles") ?? "") });
          console.log(`Client "${r.label}" added. Its token (shown only now): ${r.token}`);
          console.log(`Configure the client with the URL http://127.0.0.1:<port>/mcp and the header "Authorization: Bearer <token>".`);
        } else if (action === "list") {
          const rows = h.listClients(home());
          if (!rows.length) console.log("No clients.");
          for (const c of rows) console.log(`${c.label}${c.name ? `  name ${c.name}` : ""}${c.roles?.length ? `  roles ${c.roles.join(",")}` : ""}  since ${c.created}`);
        } else if (action === "remove" && label) {
          await h.removeClient(home(), label);
          console.log(`Removed client "${label}"; its token no longer works and its open sessions end within a minute.`);
        } else fail("usage: hoptell mcp-http client add <label> [--name <peer>] [--roles a,b] | list | remove <label>", 2);
        break;
      }
      const { runMcpHttp } = await import("../lib/mcp.js");
      await runMcpHttp({ port: opt("--port") ? Number(opt("--port")) : undefined });
      break;
    }
    case "mcp": {
      const { runMcp } = await import("../lib/mcp.js");
      await runMcp();
      break;
    }
    case "tmux": {
      const sep = args.indexOf("--");
      const head = sep < 0 ? args : args.slice(0, sep);
      if (sep < 0 || !(head.length === 1 || (head.length === 3 && head[1] === "--roles"))) {
        fail("usage: hoptell tmux <peer-name> [--roles a,b] -- <agent command...>", 2);
      }
      const { launch } = await import("../lib/tmux.js");
      launch(head[0], args.slice(sep + 1), head[2] ?? process.env.HOPTELL_ROLES ?? "", { env: { ...process.env }, home: home() });
      break;
    }
    case "inject": {
      const { inject } = await import("../lib/tmux.js");
      await inject(args[0], args[1], args[2], { home: home(), relay: relayChoice() });
      break;
    }
    case "list": {
      await selectRelay();
      const c = await connect("send");
      const peers = await c.list();
      const { formatPeer } = await import("../lib/client.js");
      console.log(peers.length ? peers.map(formatPeer).join("\n") : "no other peers");
      c.close();
      break;
    }
    case "send": {
      const { describeAck, parseRef, parseTtl } = await import("../lib/client.js");
      let ttl;
      let replyTo;
      let relayFlag = null;
      let rest = args;
      // Options come first; "--" ends them, so a message may itself start with "--".
      for (;;) {
        if (rest[0] === "--relay") relayFlag = rest[1] ?? fail("--relay needs an alias", 2);
        else if (rest[0] === "--ttl") ttl = parseTtl(rest[1]);
        else if (rest[0] === "--reply-to") replyTo = parseRef(rest[1]);
        else break;
        rest = rest.slice(2);
      }
      if (rest[0] === "--") rest = rest.slice(1);
      let [to, ...words] = rest;
      if (!to || !words.length) fail("usage: hoptell send [--relay <alias>] [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>", 2);
      const at = /^(@?[A-Za-z0-9][A-Za-z0-9_-]{0,63})@([a-z0-9][a-z0-9-]{0,31})$/.exec(to);
      if (at) to = at[1];
      const sel = await selectRelay(at?.[2] ?? null, relayFlag);
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
          fail(e.message, 2);
        }
      }
      const c = await connect("send");
      // The contacts' encryption policy (design 3.3, 4.3), as in agent sessions: the CLI sends
      // plaintext only, so a contact (or a fan-out recipient) whose messages must be encrypted
      // gets nothing, never plaintext.
      const { cliSendPolicy } = await import("../lib/mls/session.js");
      let policy;
      try {
        policy = await cliSendPolicy({ doc: (await contactsOf()).currentPolicy().doc ?? null, client: c, to });
      } catch (e) {
        c.close();
        fail(`the encryption policy could not be checked (${e.message}); nothing was sent`);
      }
      if (policy.refuse) {
        c.close();
        fail(policy.refuse);
      }
      console.log(describeAck(to, await c.send(to, words.join(" "), ttl, replyTo), ttl, replyTo) + (policy.note ? `\n(Not encrypted: ${policy.note.replace(/^not encrypted: /, "")}.)` : ""));
      c.close();
      break;
    }
    case "wait": {
      // wait [--relay <alias>] [--wait-for-name | --replace] [seconds]
      await selectRelay();
      const waitForName = args.includes("--wait-for-name");
      const replace = args.includes("--replace");
      if (waitForName && replace) fail("use --wait-for-name or --replace, not both", 2);
      const secs = Number(args.find((a) => !a.startsWith("--"))) || 300;
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
      const { stamp } = await import("../lib/quarantine.js");
      const review = await import("../lib/reviewsets.js");
      const reviewSets = new review.ReviewSetStore({ home: home() });
      c = await connect("peer", (raw, confirm, client) => {
        let m = stamp(raw, relayProfile); // an unverified sender's relay, recorded at arrival
        holdPlace(client)
          .then(async (place) => {
            // A proposal is stored for the owner and replaced by a fixed note, as in a session.
            if (review.isReviewTraffic(m)) m = await review.intakeMessage(reviewSets, m);
            const v = contacts.verdict(m, place.session);
            if (v !== "allow") {
              await contacts.hold(place.dir, place.session, m, v);
              return confirm();
            }
            clearTimeout(timer);
            // Confirm only once printed; on a write error the relay keeps the message.
            process.stdout.write(`${format(m)}\n`, (err) => (err ? fail(`cannot write output: ${err.message}`) : confirm()));
            clearTimeout(idle);
            idle = setTimeout(done, 500); // also collect messages arriving together
          })
          // A storage problem leaves the message unconfirmed: the relay keeps it for a later receiver.
          .catch((e) => console.error(`hoptell: a message could not be stored and stays with the relay: ${e.message}`));
      }, secs * 1000, { waitForName, replace });
      if (!idle) {
        timer = setTimeout(() => {
          console.log(`No messages within ${secs}s.`);
          c.close();
        }, Math.max(0, deadline - Date.now()));
      }
      c.on("fatal", (r) => fail(`relay closed the connection: ${r}`));
      break;
    }
    case "snapshot": {
      const snap = await import("../lib/snapshot.js");
      if (args[0] === "--check") {
        if (args.length !== 3) fail("usage: hoptell snapshot --check <sha256:...> <file>", 2);
        const r = snap.checkSnapshot(args[1], args[2]);
        console.log(
          r.matches
            ? `unchanged: ${args[2]} still matches ${r.expected}`
            : `changed: ${args[2]} is now ${r.current}, not ${r.expected}. Ask for a new review, or reconcile the change deliberately.`,
        );
        process.exitCode = r.matches ? 0 : 1;
      } else {
        if (args.length !== 1) fail("usage: hoptell snapshot <file>   or   hoptell snapshot --check <sha256:...> <file>", 2);
        console.log(snap.snapshotMessage(args[0]));
      }
      break;
    }
    case "apply": {
      // apply | apply <proposal id> [--preview | --yes] | apply --recover [--finish | --roll-back]
      const a = await import("../lib/apply.js");
      const flags = args.filter((x) => x.startsWith("--"));
      const ids = args.filter((x) => !x.startsWith("--"));
      const usage = "usage: hoptell apply [<proposal id> [--preview | --yes]] | hoptell apply --recover [--finish | --roll-back]";
      if (flags.some((f) => !["--preview", "--yes", "--recover", "--finish", "--roll-back"].includes(f)) || ids.length > 1) fail(usage, 2);
      const recovering = flags.includes("--recover");
      if (recovering ? ids.length || flags.includes("--preview") || flags.includes("--yes") || (flags.includes("--finish") && flags.includes("--roll-back")) : flags.includes("--finish") || flags.includes("--roll-back") || (flags.includes("--preview") && flags.includes("--yes"))) fail(usage, 2);
      const h = home();
      const pause = a.barrierFor(process.env.HOPTELL_APPLY_TEST_BARRIER || null);
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
            for (const t of r.targets) console.log(`  ${a.visible(t.label)}: holds its ${t.state === "other" ? "neither preimage nor postimage" : t.state}${t.outcome ? `; ${t.outcome}` : ""}`);
            for (const f of r.left) console.log(`  ${a.visible(f)}: a temporary file this apply did not provably create; left for you to inspect`);
          }
          if (report.length && !choice) {
            console.log(
              report.every((r) => r.committed)
                ? "Run hoptell apply --recover --finish to complete it (a committed apply cannot be rolled back)."
                : "Run hoptell apply --recover --finish (write the missing postimages) or --roll-back (restore the preimages). A committed apply is only finished.",
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
              const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
              ok = (await rl.question(`\nWrite these changes to ${plan.targets.length} file(s)? Type yes to apply: `)).trim() === "yes";
              rl.close();
            }
            if (!ok) console.log("Not applied: nothing was written.");
            else {
              try {
                const n = a.commit(plan, { home: h, pause });
                console.log(`Applied: ${n} file(s) written. Proposal ${plan.proposal.proposal_id} is marked applied.`);
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
    case "hooks": {
      // Settings for Claude Code without the plugin: printed only, never written.
      const { hooksSnippet } = await import("../lib/wake.js");
      console.log(JSON.stringify(hooksSnippet(process.execPath, process.env.HOPTELL_HOME), null, 2));
      break;
    }
    case "doctor": {
      const { doctor } = await import("../lib/doctor.js");
      process.exitCode = (await doctor(process.env, console.log, { relayCheck: args.includes("--relay-check"), fix: args.includes("--fix"), homedir: os.homedir() })) ? 1 : 0;
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
            const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
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
      if (!target) fail("usage: hoptell listen [--no-ack] <name> [seconds]   or   hoptell listen [--no-ack] --session <folder> [seconds]", 2);
      const secs = Number(rest[bySession ? 2 : 1]) || 3600;
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
      while (!out) {
        const r = resolve();
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
          if (shown.length) out = { text: shown.map(inbox.format).join("\n\n"), receipt: null, pipe: null, claims, legacy: released?.receipt ? { pipe: legacyPipe, receipt: released.receipt } : null, undo };
          else await undo();
        } else if (r.state === "bound") {
          // Keeps the session's receipt policy; claims use the configured lease.
          if (!pipes.has(r.store.dir)) pipes.set(r.store.dir, await openStore(r.store, { leaseMs: leaseMinutes() * 60_000 }));
          const pipe = pipes.get(r.store.dir);
          // A message that cannot be read is an error (nothing is acknowledged); the current policy
          // is applied, and messages it holds back join their requests.
          const batch = await pipe.take(consumer, { screen: contacts.screenFor(sessionOfDir(r.store.dir)) });
          if (batch?.quarantined?.length) await contacts.adopt();
          if (batch && (batch.messages.length || batch.damaged?.length)) {
            const notes = (batch.damaged ?? []).map((f) => `(A stored message was damaged and was set aside, unread, in ${f}.)`);
            out = { text: [...notes, ...batch.messages.map((m) => inbox.format(m.msg))].join("\n\n"), receipt: batch.receipt, pipe };
          }
        }
        if (out || Date.now() >= deadline) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      if (!out) {
        process.stdout.write(`No messages within ${secs}s. Start the listener again to keep receiving.\n`);
        break;
      }
      const footer = out.receipt && noAck ? `\nReceipt: ${out.receipt} (acknowledge with: hoptell ack ${out.receipt} ${bySession ? `--session "${target}"` : target})` : "";
      // Acknowledge only after the output is written (automatic mode); a failed write keeps them.
      process.stdout.write(`${out.text}\n\n${inbox.NOT_YOUR_USER}${footer}\nReply with send_message, then start this listener again.\n`, async (err) => {
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
      if (!receipt || !target) fail("usage: hoptell ack <receipt> --session <folder>   or   hoptell ack <receipt> <name>", 2);
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
      const r = await pipe.ack(receipt);
      if (r !== "ok") fail(`unknown receipt ${receipt}: it may have expired (its messages were returned to the inbox) or be mistyped`);
      console.log("Acknowledged.");
      break;
    }
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      break;
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`, 2);
  }
} catch (e) {
  fail(e.message);
}
