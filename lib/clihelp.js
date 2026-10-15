// The command line's help, version and option checks. Everything here is read before a command
// runs: `--help` (or `-h`) anywhere before a lone `--` prints that command's help and does nothing
// else (no state directory, no connection, nothing listening), and an option a command does not
// know is refused before the command starts.
import fs from "node:fs";
import { envFiles } from "./config.js";

const HEADER = "hoptell - messaging between AI coding agents (Claude Code, Codex, ...) through a self-hosted relay";

/** `hoptell relay admin` (lib/admincli.js prints it too). */
export const ADMIN_USAGE = `usage: hoptell relay admin <command> [--state-dir <dir>] [--json]
  status | members [--member <name>] | devices [--member <name>] | devices reinstate <member> <device>
  devices pending [--member <name>] | devices approve <member> <device> <fingerprint>
  devices pending-cancel <member> <device>
  policy [check <from> <to>] | grants [--member <name>] | grants --entries --member <name>
  revocations [--since <time>] | metrics | store | checkpoint | backup <dir> [--pages <n>]
  restore <dir> | restore --resume | restore --abort | restore --discard-evidence <id>
  audit [--since <time>] | reload | ui [--port <n>]`;

/** `hoptell telegram` (lib/ownerchannelcli.js prints it too). */
export const TELEGRAM_USAGE = `usage:
  hoptell telegram setup [--relay <alias>] [--name owner]   (the bot token on standard input)
  hoptell telegram pair
  hoptell telegram trust '<pin>' [--add] | --remove-key <key id> [--realm <realm id>] | --revoke <realm id>
  hoptell telegram key next | key commit                     (with the bridge stopped)
  hoptell telegram run                                         (exit code 78: refused by the encryption policy; do not restart on it)
  hoptell telegram status
  hoptell telegram identity [--apply] [--photo <file.jpg> | --remove-photo]
                                                               (the bot's name, descriptions and photo; --apply asks first)
  hoptell telegram fav <name> | unfav <name>                   (your favourites in Telegram)
  hoptell telegram alias <name> <new name> | alias <name> --clear
  hoptell telegram sessions                                    (favourites, names and hidden agents)
  hoptell telegram app --on | --off | --rotate | --status      (the app in Telegram; --on, --off, --rotate with the bridge stopped)
  hoptell telegram unpair [--all]`;

/** `hoptell device` (lib/mls/cli.js prints it too). */
export const DEVICE_USAGE =
  "usage: hoptell device enroll [--new-baseline --yes]|status|list|accept <device> [--set <code>]|pending [--cancel <device>]|expect <device> <pin identity>|retire [--yes]|replenish [--force]|rotate|revoke <device>|backup <file>|restore <file>|migrate <backup>";

/** `hoptell mcp-hosted` (lib/hostedcli.js prints it too). */
export const HOSTED_USAGE =
  "usage: hoptell mcp-hosted --experimental --config <file> --state-dir <dir> [--port 7791] [--bind 127.0.0.1]\n       hoptell mcp-hosted --experimental link --issuer <URL> --subject <subject> --member <m_...> --name <member name> --state-dir <dir>\n       hoptell mcp-hosted --experimental unlink --issuer <URL> --subject <subject> --state-dir <dir>\n       hoptell mcp-hosted --experimental list --state-dir <dir>\n       (a subject that starts with \"--\": --subject=<subject>)";

/** Each command's lines in `hoptell help`, in that order. */
export const HELP = {
  relay: `  hoptell relay --host <ip> [--port 7777] [--members file.json] [--require-members] [--policy policy.json]
                [--oidc oidc.json] [--state-dir <dir>] [--realm-name <name>] [--trusted-proxies <ip/cidr,...>]
                [--log-format text|json] [--metrics-port <port>] [--metrics-host 127.0.0.1]
                [--wal-soft-limit <size>] [--wal-hard-limit <size>]
                [--experimental-e2ee [--transfer-quota <size>] [--transfer-member-quota <size>]]
                                            run the relay (one machine per team); --require-members refuses
                                            the shared token; --experimental-e2ee: EXPERIMENTAL device keys,
                                            encrypted messages and larger transfers
  hoptell relay broker-reset --yes [--state-dir <dir>]
                                            with the relay stopped: a new broker refresh key; every broker
                                            sign-in ends (after the key was lost or damaged)
  hoptell relay apps [--retire <id prefix> | --purge <id prefix>] [--state-dir <dir>]
                                            with the relay stopped: the Mini App ids of owner channel bridges;
                                            --retire blocks an id for good; --purge deletes it, which frees
                                            its URL for anyone (old Telegram buttons could then open another
                                            bridge's app)
  hoptell relay admin status|members|devices|policy|grants|revocations|metrics|store|audit|reload|checkpoint
                | backup <dir> | restore <dir>|--resume|--abort | devices reinstate <member> <device> | ui
                                            the relay owner's views and controls (on the relay host); see
                                            hoptell relay admin help`,
  members: `  hoptell members list | add <name> | revoke <name> | signout <name> | migrate [--yes]
                | link|unlink <name> --issuer <url> --subject <sub>
                | add-hosted <name> --host <id> | host add|remove <id> | host list
                | device-revoke <name> <device> | device-approve <name> <device> <fingerprint>
                [--members <file>] [--state-dir <dir>]
                                            manage the relay's members file on the relay host; add shows
                                            the new token once and stores only its SHA-256; signout ends
                                            the member's broker sign-ins made until now; host, add-hosted:
                                            EXPERIMENTAL hosted members; device-*: EXPERIMENTAL device keys;
                                            a subject that starts with "--": --subject=<sub>`,
  grants: `  hoptell grants [show] | allow|deny <selector> [--until <s>] | deny-forever member:<id> | remove <selector>
                | default allow|deny | visible all|grantees   [--relay <alias>] [--yes --rev N]
                                            who may reach your sessions through the relay; selectors: *,
                                            group:<name>, member:<id>; a change is only shown until you
                                            run it again with --yes --rev N`,
  "local-relay": `  hoptell local-relay install [--port 7788] | start | stop | status | uninstall [--purge]
                                            a private relay for your own sessions on this machine
                                            (loopback, a user service, a token only you can read)`,
  contacts: `  hoptell contacts [list] | show <id> [--text] | allow|allow-once <id> --rev N --policy-rev P [--session S]
                | block <id> --rev N --policy-rev P | grants | blocks | revoke|unblock <id> --policy-rev P
                | check <realm> member <id> | init
                                            decide who may reach your agent sessions; senders without a
                                            grant wait in quarantine until you decide (see README)
  hoptell contacts request <name> [--reason collaborate|review|handoff|other] [--relay <alias>]
                                            ask a member who does not accept you yet at the relay
  hoptell contacts requests [accept|deny|deny-forever <id>] [--relay <alias>]
                                            contact requests waiting for you at the relay (acts at once)
  hoptell contacts verify <member id> [--yes --how in-person|out-of-band --set <code>] | verify <member id> --conversation
                | accept-device|forget-device <member id> <device> [--set <code>]
                | encryption <member id>|--default required|preferred|off|clear
                                            EXPERIMENTAL (HOPTELL_EXPERIMENTAL_E2EE=1): a contact's devices,
                                            and whether messages with it must be encrypted`,
  ui: `  hoptell ui [--port N] [--open]           the owner's pages on 127.0.0.1: what waits for your decision,
                                            contacts, devices, settings (prints a single-use launch link)`,
  login: `  hoptell login [--issuer <url|broker id>] [--mode broker|resource] [--device | --client-credentials --client-id <id> --client-secret-file <file>] [--store file]
                                            sign in to the relay with your identity provider; then HOPTELL_AUTH=login`,
  logout: `  hoptell logout                            remove (and revoke) the stored sign-in credential`,
  mcp: `  hoptell mcp                               MCP server for an agent session (stdio)
  hoptell mcp --run <run> --home <home>     the same for a spawned agent's run: only the run's tools`,
  "mcp-http": `  hoptell mcp-http [--port 7790]            the same over HTTP on 127.0.0.1, for clients that only speak HTTP
  hoptell mcp-http client add <label> [--name <peer>] [--roles a,b] [--agents] | list | remove <label>
                                            tokens for those clients (shown once, stored hashed)`,
  "hook-header": `  hoptell hook-header                       print the hook registration header for an mcp-http client
                                            (Claude Code's headers helper); {} when there is none`,
  "mcp-hosted": `  hoptell mcp-hosted --experimental --config <file> --state-dir <dir> [--port 7791] [--bind 127.0.0.1]
  hoptell mcp-hosted --experimental link|unlink|list ... --state-dir <dir>
                                            EXPERIMENTAL hosted MCP endpoint behind an HTTPS proxy: the host
                                            reads its tenants' messages; link|unlink|list manage its links`,
  agents: `  hoptell agents profiles | profile approve <id> [--accept-read-risk] | list [--all] | stop <run> | result <run>
                 | confirm <run> [--start | --discard] | audit [--run <id>]
                                            agent profiles: which local agent CLIs your sessions may
                                            start, and how; a new or changed profile needs your approval
                                            (a codex profile: read its warning, then approve with
                                            --accept-read-risk)`,
  tmux: `  hoptell tmux <name> [--roles a,b] -- <agent command>
                                            run an agent in tmux; attempt an inbox notice when its prompt appears idle`,
  list: `  hoptell list [--relay <alias>]            list peers on the relay`,
  send: `  hoptell send [--relay <alias>] [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>
                                            send a message (as $HOPTELL_NAME, without going online);
                                            --ttl: request relay queue expiry; older relays ignore it;
                                            --reply-to: the "Message reference" you are answering`,
  snapshot: `  hoptell snapshot <file>                   print a UTF-8 file snapshot with its SHA-256, for review
  hoptell snapshot --check <sha256> <file>  exit 0 if the bytes match; nonzero if different or the check fails`,
  apply: `  hoptell apply                             list proposals that answered your review sets and wait for you
  hoptell apply <proposal id> [--preview | --yes]
                                            show what a proposal changes (from the captured bytes) and, after
                                            you confirm, write it; --preview writes nothing
  hoptell apply --recover [--finish | --roll-back]
                                            after an interrupted apply: show each file's state, then finish
                                            it or restore the files as they were`,
  wait: `  hoptell wait [--relay <alias>] [--wait-for-name | --replace] [seconds]
                                            go online as $HOPTELL_NAME, print the next message, exit
                                            (waits up to [seconds], default 300);
                                            if another session has the name: stop (default), wait for it
                                            (--wait-for-name), or take it over once (--replace)`,
  listen: `  hoptell listen [--no-ack] <name> [seconds]
                                            wait for the next messages in <name>'s local inbox, print them, exit
                                            (waits up to [seconds], default 3600)
  hoptell listen [--no-ack] --session <folder> [seconds]
                                            the same for an agent session's storage folder (shown by the session);
                                            acknowledges after printing, or prints a receipt with --no-ack`,
  ack: `  hoptell ack <receipt> (<name> | --session <folder>)
                                            acknowledge messages printed with --no-ack`,
  doctor: `  hoptell doctor [--relay-check] [--fix]    check settings, relay, login, inbox and tmux on this machine;
                                            --relay-check: also send a test message through the relay;
                                            --fix: remove transfer leftovers (staging, outbox)`,
  transfers: `  hoptell transfers [cancel <t_id>]         EXPERIMENTAL: file transfers staged for you (or being fetched)`,
  save: `  hoptell save <t_id> <path> [--overwrite] [--yes] | --forget <t_id>
                                            EXPERIMENTAL: save a staged transfer to a path you choose
                                            (never replaces a file without --overwrite)`,
  device: `  hoptell device enroll [--new-baseline --yes] | status | list | accept <device> [--set <code>]
                 | pending [--cancel <device>] | expect <device> <pin identity> | retire [--yes]
                 | replenish [--force] | rotate | revoke <device> | backup <file> | restore <file> | migrate <backup>
                                            EXPERIMENTAL (HOPTELL_EXPERIMENTAL_E2EE=1): this machine's device
                                            key for encrypted messages`,
  telegram: `  hoptell telegram setup [--relay <alias>] [--name owner]   the owner channel (a Telegram bot; token on stdin)
  hoptell telegram pair | run | status | identity [--apply] | unpair [--all]   (run exits 78 when the encryption policy refuses it: do not restart on 78)
  hoptell telegram trust '<pin>' [--add] | --remove-key <key id> | --revoke <realm id>
  hoptell telegram key next | key commit    rotate the bridge's signing key (bridge stopped)
  hoptell telegram app --on|--off|--rotate|--status | fav|unfav <name> | alias <name> <new name> | sessions
                                            the app in Telegram, your favourites and names (hoptell telegram help)`,
  hooks: `  hoptell hooks                             print Claude Code hook settings for hook delivery without the plugin`,
  version: `  hoptell --version                         print the version of hoptell`,
};

const FOOTER = () => `Settings: environment variables, else the first file found of
${envFiles()
  .map((f) => `  ${f}`)
  .join("\n")}
Peers:  HOPTELL_RELAY, HOPTELL_TOKEN, HOPTELL_NAME, HOPTELL_ROLES (e.g. reviewer,backend),
        HOPTELL_RELAYS (a relays file: several relays, name@relay), HOPTELL_HOME,
        HOPTELL_PUSH (channel, hook, tmux or listener; unset for automatic),
        HOPTELL_PROTOCOL (1 to keep the older relay protocol), HOPTELL_PROFILE,
        HOPTELL_RECEIPTS (on/off), HOPTELL_LEASE_MINUTES, HOPTELL_NOTIFY (off: no desktop notifications),
        HOPTELL_AUTH (login: use hoptell login), HOPTELL_CREDENTIAL_STORE (file or keychain), HOPTELL_CREDENTIAL_PASSPHRASE,
        HOPTELL_EXPERIMENTAL_E2EE (1: the experimental device keys and encrypted messages)
Relay:  HOPTELL_HOST, HOPTELL_PORT, HOPTELL_TOKEN and/or HOPTELL_MEMBERS (members file); HOPTELL_POLICY (access policy file);
        HOPTELL_STATE_DIR, HOPTELL_REQUIRE_MEMBERS, HOPTELL_REALM_NAME, HOPTELL_OIDC (sign-in configuration file);
        HOPTELL_LOG_FINGERPRINTS=on with HOPTELL_LOG_FINGERPRINT_KEY_FILE for keyed log fingerprints;
        HOPTELL_TRUSTED_PROXIES, HOPTELL_LOG_FORMAT, HOPTELL_METRICS_PORT, HOPTELL_METRICS_HOST
Switches (HOPTELL_EXPERIMENTAL_E2EE, HOPTELL_REQUIRE_MEMBERS, HOPTELL_OWNER_APP): 1, true, on or yes;
        0, false, off or no. A value a setting does not accept is refused or reported, never read as its default.

Send to a peer name, to @<role> (every online peer with the role) or to @all.`;

/** `hoptell help`: every command. */
export const usage = () => `${HEADER}\n\nUsage:\n${Object.values(HELP).join("\n")}\n\n${FOOTER()}`;

/** `hoptell <command> --help`: that command's lines, and its detailed usage where it has one. */
export function commandHelp(cmd, args = []) {
  if (cmd === "relay" && args[0] === "admin") return ADMIN_USAGE;
  const more = { telegram: TELEGRAM_USAGE, device: DEVICE_USAGE, "mcp-hosted": HOSTED_USAGE }[cmd];
  return `Usage:\n${HELP[cmd]}${more ? `\n\n${more}` : ""}${cmd === "relay" ? `\n\n${ADMIN_USAGE}` : ""}`;
}

/** The version in package.json. */
export const version = () => JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Commands whose first word may be `help` (for the others it can be a peer name or a file).
const HELP_WORD = new Set(["relay", "members", "grants", "local-relay", "contacts", "mcp-http", "mcp-hosted", "agents", "transfers", "device", "telegram"]);
const isHelp = (a) => a === "--help" || a === "-h";
// Options that take a value, in any command (the value is never a subcommand).
const VALUE_FLAGS = new Set(["--members", "--state-dir", "--host", "--port", "--issuer", "--subject", "--until", "--rev", "--policy-rev", "--relay", "--session", "--how", "--set", "--reason", "--policy", "--oidc", "--realm-name", "--trusted-proxies", "--log-format", "--metrics-port", "--metrics-host", "--wal-soft-limit", "--wal-hard-limit", "--transfer-quota", "--transfer-member-quota", "--retire", "--purge", "--member", "--since", "--pages", "--discard-evidence", "--config", "--bind", "--name", "--roles", "--run", "--home", "--mode", "--client-id", "--client-secret-file", "--store", "--photo", "--remove-key", "--realm", "--revoke", "--cancel"]);

/**
 * What the command line asks for before any command runs: {version: true}, {help: <command or
 * null>, unknown?: <word>}, or null. `argv` is process.argv.slice(2).
 */
export function preflight(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return { version: true };
  if (cmd === undefined || isHelp(cmd)) return { help: null };
  if (cmd === "help") {
    const topic = rest[0];
    if (topic === undefined) return { help: null };
    return Object.hasOwn(HELP, topic) ? { help: topic, args: rest.slice(1) } : { help: null, unknown: topic };
  }
  if (!Object.hasOwn(HELP, cmd)) return null;
  // Options end at a lone "--": after it come an agent's command (tmux) or a message (send).
  const sep = rest.indexOf("--");
  const head = sep < 0 ? rest : rest.slice(0, sep);
  if (cmd === "send") {
    // Options first, then <to>, then the message: --help is an option only where options are, as
    // <to>, or as the whole message (a message that only says "--help" was not meant to be sent).
    let i = 0;
    while (["--relay", "--ttl", "--reply-to"].includes(head[i])) {
      if (isHelp(head[i + 1])) return { help: cmd, args: [] }; // where the option's value belongs
      i += 2;
    }
    const words = head.slice(i);
    if (isHelp(words[0]) || (sep < 0 && words.length === 2 && isHelp(words[1]))) return { help: cmd, args: [] };
    return null;
  }
  if (head.some(isHelp)) return { help: cmd, args: head.filter((a) => !isHelp(a)) };
  // The words that are not options or option values: `relay --realm-name help` names a realm.
  const words = head.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(head[i - 1]));
  if (HELP_WORD.has(cmd) && words[0] === "help") return { help: cmd, args: [] };
  if (cmd === "relay" && words[0] === "admin" && words[1] === "help") return { help: cmd, args: ["admin"] };
  return null;
}

// The options each command accepts (a value-taking option's value is not checked here).
const FLAGS = {
  relay: ["--host", "--port", "--members", "--policy", "--oidc", "--state-dir", "--realm-name", "--trusted-proxies", "--log-format", "--metrics-port", "--metrics-host", "--wal-soft-limit", "--wal-hard-limit", "--require-members", "--experimental-e2ee", "--transfer-quota", "--transfer-member-quota"],
  "relay broker-reset": ["--yes", "--state-dir", "--members", "--policy", "--oidc"],
  "relay apps": ["--retire", "--purge", "--state-dir"],
  "relay admin": ["--state-dir", "--json", "--member", "--since", "--pages", "--port", "--entries", "--resume", "--abort", "--discard-evidence", "--members", "--policy", "--oidc", "--experimental-e2ee"],
  members: ["--members", "--state-dir", "--host", "--issuer", "--subject", "--yes", "--json"],
  grants: ["--until", "--rev", "--yes", "--relay"],
  "local-relay": ["--port", "--purge"],
  contacts: ["--rev", "--policy-rev", "--session", "--text", "--how", "--set", "--yes", "--conversation", "--default", "--reason", "--relay"],
  ui: ["--port", "--open", "--host"],
  login: ["--issuer", "--mode", "--device", "--client-credentials", "--client-id", "--client-secret-file", "--store"],
  logout: [],
  mcp: ["--run", "--home"],
  "mcp-http": ["--port", "--name", "--roles", "--agents"],
  "mcp-hosted": ["--experimental", "--config", "--state-dir", "--port", "--bind", "--issuer", "--subject", "--member", "--name"],
  agents: ["--accept-read-risk", "--all", "--start", "--discard", "--run", "--home"],
  list: ["--relay"],
  wait: ["--relay", "--wait-for-name", "--replace"],
  listen: ["--no-ack", "--session"],
  ack: ["--session"],
  doctor: ["--relay-check", "--fix"],
  device: ["--new-baseline", "--yes", "--set", "--cancel", "--force"],
  telegram: ["--relay", "--name", "--add", "--remove-key", "--realm", "--revoke", "--apply", "--photo", "--remove-photo", "--clear", "--on", "--off", "--rotate", "--status", "--all"],
  hooks: [],
  // tmux, send, snapshot, apply, save and transfers check their own arguments.
};

// The options of each command that take a value (`relay apps --purge <id>` does, `local-relay
// uninstall --purge` does not).
const VALUES = {
  relay: ["--host", "--port", "--members", "--policy", "--oidc", "--state-dir", "--realm-name", "--trusted-proxies", "--log-format", "--metrics-port", "--metrics-host", "--wal-soft-limit", "--wal-hard-limit", "--transfer-quota", "--transfer-member-quota"],
  "relay broker-reset": ["--state-dir", "--members", "--policy", "--oidc"],
  "relay apps": ["--retire", "--purge", "--state-dir"],
  "relay admin": ["--state-dir", "--member", "--since", "--pages", "--port", "--discard-evidence", "--members", "--policy", "--oidc"],
  members: ["--members", "--state-dir", "--host", "--issuer", "--subject"],
  grants: ["--until", "--rev", "--relay"],
  "local-relay": ["--port"],
  contacts: ["--rev", "--policy-rev", "--session", "--how", "--set", "--reason", "--relay"],
  ui: ["--port", "--host"],
  login: ["--issuer", "--mode", "--client-id", "--client-secret-file", "--store"],
  mcp: ["--run", "--home"],
  "mcp-http": ["--port", "--name", "--roles"],
  "mcp-hosted": ["--config", "--state-dir", "--port", "--bind", "--issuer", "--subject", "--member", "--name"],
  agents: ["--run", "--home"],
  list: ["--relay"],
  wait: ["--relay"],
  listen: ["--session"],
  ack: ["--session"],
  device: ["--set", "--cancel"],
  telegram: ["--relay", "--name", "--remove-key", "--realm", "--revoke", "--photo"],
};

// Options that may also be written --option=<value>, for a value that itself starts with "--" (an
// identity provider's subject is opaque). Other options take their value as the next word only.
export const EQUALS_FLAGS = ["--subject"];

const keyOf = (cmd, args) => (cmd === "relay" && ["broker-reset", "apps", "admin"].includes(args[0]) ? `relay ${args[0]}` : cmd);

/**
 * The first option of `args` (before a lone "--") that takes a value but has none: it is last, the
 * next word is another option, or the value is empty (`--port ''`, `--subject=`). Such an option is
 * refused, never read as left out (which would quietly use its default). Returns the option, or
 * null.
 */
export function missingValue(cmd, args) {
  const values = VALUES[keyOf(cmd, args)];
  if (!values) return null;
  const sep = args.indexOf("--");
  const head = sep < 0 ? args : args.slice(0, sep);
  for (const [n, a] of head.entries()) {
    if (values.includes(a) && (n + 1 >= head.length || head[n + 1] === "" || head[n + 1].startsWith("--"))) return a;
    const eq = EQUALS_FLAGS.find((f) => a === `${f}=`);
    if (eq && values.includes(eq)) return eq;
  }
  return null;
}

/** The first option of `args` that command `cmd` does not accept (before a lone "--"), or null. */
export function unknownFlag(cmd, args) {
  const key = keyOf(cmd, args);
  const known = FLAGS[key];
  if (!known) return null;
  const sep = args.indexOf("--");
  const head = sep < 0 ? args : args.slice(0, sep);
  return head.find((a) => a.startsWith("--") && !known.includes(a) && !EQUALS_FLAGS.some((f) => known.includes(f) && a.startsWith(`${f}=`))) ?? null;
}
