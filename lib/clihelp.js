// The command line's help, version and option checks. Everything here is read before a command
// runs: `--help` (or `-h`) anywhere before a lone `--` prints that command's help and does nothing
// else (no state directory, no connection, nothing listening), and an option a command does not
// know is refused before the command starts.
import fs from "node:fs";
import { envFiles } from "./config.js";

const HEADER = "hoptell - messaging between AI coding agents (Claude Code, Codex, ...)\nthrough a self-hosted relay";

const COMMON = `Common commands:
  hoptell list                 who is on the relay
  hoptell send <to> <message>  send a message
  hoptell doctor               check this machine's setup
  hoptell local-relay install  a private relay for your own sessions
  hoptell telegram setup       reach yourself through a Telegram bot`;

/** `hoptell relay admin` (lib/admincli.js prints it too). */
export const ADMIN_USAGE = `usage: hoptell relay admin <command> [--state-dir <dir>] [--json]
  status
  members [--member <name>]
  devices [--member <name>] | devices reinstate <member> <device>
  devices pending [--member <name>]
  devices approve <member> <device> <fingerprint>
  devices pending-cancel <member> <device>
  policy [check <from> <to>]
  grants [--member <name>] | grants --entries --member <name>
  revocations [--since <time>] | audit [--since <time>]
  metrics | store | checkpoint | reload
  backup <dir> [--pages <n>]
  restore <dir> | restore --resume | restore --abort
  restore --discard-evidence <id>
  ui [--port <n>]`;

/** `hoptell telegram` (lib/ownerchannelcli.js prints it too). */
export const TELEGRAM_USAGE = `usage:
  hoptell telegram setup [--relay <alias>] [--name owner]
      Reads the bot token from standard input.
  hoptell telegram pair
  hoptell telegram trust '<pin>' [--add]
  hoptell telegram trust --remove-key <key id> [--realm <realm id>]
  hoptell telegram trust --revoke <realm id>
  hoptell telegram key next | key commit
      With the bridge stopped.
  hoptell telegram run
      Exit code 78: refused by the encryption policy. Do not restart on 78.
  hoptell telegram status
  hoptell telegram identity [--apply] [--photo <file> | --remove-photo]
      The bot's name, descriptions and photo. --apply asks first.
  hoptell telegram fav <name> | unfav <name>
      Your favourites in Telegram.
  hoptell telegram alias <name> <new name> | alias <name> --clear
  hoptell telegram sessions
      Favourites, names and hidden agents.
  hoptell telegram app --on | --off | --rotate | --status
      The app in Telegram. Use --on, --off and --rotate with the bridge
      stopped.
  hoptell telegram unpair [--all]`;

/** `hoptell device` (lib/mls/cli.js prints it too). */
export const DEVICE_USAGE = `usage: hoptell device enroll [--new-baseline --yes] | status | list
       hoptell device accept <device> [--set <code>]
       hoptell device pending [--cancel <device>]
       hoptell device expect <device> <pin identity>
       hoptell device retire [--yes] | replenish [--force] | rotate
       hoptell device revoke <device> | backup <file> | restore <file>
       hoptell device migrate <backup>
Experimental. Set HOPTELL_EXPERIMENTAL_E2EE=1 to use it.
Backup, restore and migrate use HOPTELL_CREDENTIAL_PASSPHRASE.`;

/** `hoptell mcp-hosted` (lib/hostedcli.js prints it too). */
export const HOSTED_USAGE = `usage: hoptell mcp-hosted --experimental --config <file> --state-dir <dir>
                          [--port 7791] [--bind 127.0.0.1]
       hoptell mcp-hosted --experimental link --issuer <url>
                          --subject <subject> --member <m_...>
                          --name <member name> --state-dir <dir>
       hoptell mcp-hosted --experimental unlink --issuer <url>
                          --subject <subject> --state-dir <dir>
       hoptell mcp-hosted --experimental list --state-dir <dir>
A subject that starts with "--": --subject=<subject>`;

/** Each command's lines in `hoptell help`, in that order. */
export const HELP = {
  relay: `  hoptell relay --host <ip> [--port 7777] [--state-dir <dir>]
                [--members <file>] [--require-members] [--policy <file>]
                [--oidc <file>] [--realm-name <name>]
                [--trusted-proxies <ip/cidr,...>] [--log-format text|json]
                [--metrics-port <port>] [--metrics-host 127.0.0.1]
                [--wal-soft-limit <size>] [--wal-hard-limit <size>]
                [--experimental-e2ee [--transfer-quota <size>]
                                     [--transfer-member-quota <size>]]
      Run the relay (one machine per team). --require-members refuses the
      shared token. --experimental-e2ee turns on EXPERIMENTAL device keys,
      encrypted messages and larger transfers.
  hoptell relay broker-reset --yes [--state-dir <dir>]
      With the relay stopped: make a new broker refresh key. Every broker
      sign-in ends. Use it when the key was lost or damaged.
  hoptell relay apps [--retire <id prefix> | --purge <id prefix>]
                     [--state-dir <dir>]
      With the relay stopped: list the Mini App ids of owner channel bridges.
      --retire blocks an id for good. --purge deletes it and frees its URL for
      anyone, so old Telegram buttons could open another bridge's app.
  hoptell relay admin <command>
      The relay owner's views and controls, on the relay host.
      See: hoptell relay admin --help`,
  members: `  hoptell members list | add <name> | revoke <name> | signout <name>
  hoptell members migrate [--yes]
  hoptell members link|unlink <name> --issuer <url> --subject <sub>
  hoptell members add-hosted <name> --host <id>
  hoptell members host add|remove <id> | host list
  hoptell members device-revoke <name> <device>
  hoptell members device-approve <name> <device> <fingerprint>
      Options for all: [--members <file>] [--state-dir <dir>]
      Manage the relay's members file on the relay host. add shows the new
      token once and stores only its SHA-256. signout ends the member's
      broker sign-ins made until now. host, add-hosted: EXPERIMENTAL hosted
      members. device-*: EXPERIMENTAL device keys. A subject that starts
      with "--": --subject=<sub>`,
  grants: `  hoptell grants [show] [--relay <alias>]
  hoptell grants allow|deny <selector> [--until <seconds>] [--yes --rev N]
  hoptell grants deny-forever member:<id> [--yes --rev N]
  hoptell grants remove <selector> [--yes --rev N]
  hoptell grants default allow|deny [--yes --rev N]
  hoptell grants visible all|grantees [--yes --rev N]
  hoptell grants publish [--yes --rev N]
      Who may reach your sessions through the relay. Selectors: '*' (quote
      it), group:<name>, member:<id>. A change is only shown until you run it
      again with --yes --rev N. publish publishes your grants unchanged
      (after a relay restore, hoptell grants says when). Each takes
      [--relay <alias>].`,
  "local-relay": `  hoptell local-relay install [--port 7788] | start | stop | status
  hoptell local-relay uninstall [--purge]
      A private relay for your own sessions on this machine (loopback, a
      user service, a token only you can read).`,
  contacts: `  hoptell contacts [list] | show <id> [--text] | grants | blocks | init
  hoptell contacts allow|allow-once <id> --rev N --policy-rev P
                   [--session S]
  hoptell contacts block <id> --rev N --policy-rev P
  hoptell contacts revoke|unblock <id> --policy-rev P
  hoptell contacts check <realm> member <id>
      Decide who may reach your agent sessions. Senders without a grant wait
      in quarantine until you decide (see README).
  hoptell contacts request <name>
                   [--reason collaborate|review|handoff|other]
                   [--relay <alias>]
      Ask a member who does not accept you yet, through the relay.
  hoptell contacts requests [accept|deny|deny-forever <id>] [--relay <alias>]
      Contact requests waiting for you at the relay (acts at once).
  hoptell contacts verify <member id>
                   [--yes --how in-person|out-of-band --set <code>]
  hoptell contacts verify <member id> --conversation
  hoptell contacts accept-device|forget-device <member id> <device>
                   [--set <code>]
  hoptell contacts encryption <member id> required|preferred|off|clear
  hoptell contacts encryption --default required|preferred|off|clear
      EXPERIMENTAL (HOPTELL_EXPERIMENTAL_E2EE=1): a contact's devices, and
      whether messages with it must be encrypted.`,
  ui: `  hoptell ui [--port N] [--open]
      The owner's pages on 127.0.0.1: what waits for your decision, contacts,
      devices, settings. Prints a single-use launch link.`,
  login: `  hoptell login [--issuer <url|broker id>] [--mode broker|resource]
                [--device] [--store file]
  hoptell login --client-credentials --client-id <id>
                --client-secret-file <file> [--issuer <url|broker id>]
                [--mode broker|resource] [--store file]
      Sign in to the relay with your identity provider, then set
      HOPTELL_AUTH=login.`,
  logout: `  hoptell logout
      Remove (and revoke) the stored sign-in credential.`,
  mcp: `  hoptell mcp
      The MCP server for an agent session (stdio).
  hoptell mcp --run <run> --home <home>
      The same for a spawned agent's run: only the run's tools.`,
  "mcp-http": `  hoptell mcp-http [--port 7790]
      Run an MCP server over HTTP on 127.0.0.1 for local agent clients that
      only speak HTTP.
  hoptell mcp-http client add <label> [--name <peer>] [--roles a,b] [--agents]
  hoptell mcp-http client list | client remove <label>
      Manage tokens for those clients (shown once, stored hashed). --agents
      lets the client use the agent tools (spawn_agent and the others).`,
  "hook-header": `  hoptell hook-header
      Print the hook registration header for an mcp-http client (Claude
      Code's headers helper); {} when there is none.`,
  "mcp-hosted": `  hoptell mcp-hosted --experimental --config <file> --state-dir <dir>
                     [--port 7791] [--bind 127.0.0.1]
  hoptell mcp-hosted --experimental link|unlink|list ... --state-dir <dir>
      EXPERIMENTAL hosted MCP endpoint behind an HTTPS proxy: the host reads
      its tenants' messages. link, unlink and list manage its links.`,
  agents: `  hoptell agents profiles | list [--all] | audit [--run <id>]
  hoptell agents profile approve <id> [--accept-read-risk]
  hoptell agents stop <run> | result <run>
  hoptell agents confirm <run> [--start | --discard]
  hoptell agents trust-cli <profile> | --list | --revoke <digest prefix>
      Agent profiles: which local agent CLIs your sessions may start, and
      how. A new or changed profile needs your approval. For a codex
      profile, read its warning, then approve with --accept-read-risk.
      trust-cli approves a Codex build hoptell has not tested, once per
      exact binary, after you type "trust" in the terminal.
  hoptell agents capabilities [codex|claude|agy] [--refresh] [--diff] [--json]
      What each agent CLI offers (flags, models and efforts from its own
      caches, advisory), what hoptell's tests verified, and what changed
      since the last record. Reads --help in an empty home; never starts
      a model.
  hoptell agents flags <codex|claude|agy> --role <reviewer|implementer|lead>
                       [--model <model>] [--effort <effort>] [--json]
                       [--lead <name> [--template <role template>]]
      The CLI and flags for hoptell tmux ... -- <these> "<prompt>": the
      role preset (safety flags, effort), your model and effort, and
      warnings. For agy, give the complete model id (it carries the
      effort); hoptell never passes --effort to agy. --lead adds the role
      template (reviewer, implementer or tester; default: the role;
      ~/.config/hoptell/roles/<name>.md replaces the shipped one) and a
      launch prompt that points at read_task; give the task with hoptell
      tmux --task.`,
  tmux: `  hoptell tmux <name> [--roles a,b] [--cwd <dir>] [--task <file>]
               -- <agent command>
      Run an agent in tmux; try to type an inbox notice when its prompt
      looks idle. --cwd: the agent's working folder. --task: a task file
      (at most 32 KiB) the session reads with read_task; it stays off the
      command line.`,
  worktree: `  hoptell worktree add <member> --team <team> --cli <codex|claude>
                       [--base <commit>] [--folder <name>] [--owns <globs>]
                       [--repo <dir>]
      A git worktree for an implementer at <repo>-wt/<folder> next to the
      repository, on a new branch team/<team>/<member>. --owns: the
      comma-separated globs the member may change.
  hoptell worktree list
  hoptell worktree commit <member> -m <message> [--allow-outside]
      Commit the member's changes on its branch (implementers never
      commit). Every member of the repository must be stopped first.
  hoptell worktree diff <member> [--stat]
      The patch of the member's commits, for review (members stopped).
  hoptell worktree remove <member>
      Remove a clean worktree of a stopped member. Its branch is kept when
      it has commits.
      hoptell's git reads no global configuration and runs no hook, filter
      or diff program of the repository; a repository whose config sets one
      is refused.`,
  list: `  hoptell list [--relay <alias>]
      List the peers on the relay.`,
  send: `  hoptell send [--relay <alias>] [--ttl 10m] [--reply-to <reference>]
               [--] <to> <message...>
      Send a message (as $HOPTELL_NAME, without going online). --ttl asks
      the relay to drop it if still queued after that time; older relays
      ignore it. --reply-to: the "Message reference" you are answering.
      Options come before the recipient. To send text that starts with
      "--", put -- before the recipient: hoptell send -- bob --ttl 10m hi`,
  snapshot: `  hoptell snapshot <file>
      Print a UTF-8 file snapshot with its SHA-256, for review.
  hoptell snapshot --check <sha256> <file>
      Exit 0 if the bytes match; 1 if they differ or the check fails; 2 for
      usage errors.`,
  apply: `  hoptell apply
      List proposals that answered your review sets and wait for you.
  hoptell apply <proposal id> [--preview | --yes]
      Show what a proposal changes (from the captured bytes) and, after you
      confirm, write it. --preview writes nothing.
  hoptell apply --recover [--finish | --roll-back]
      After an interrupted apply: show each file's state, then finish it or
      restore the files as they were.`,
  wait: `  hoptell wait [--relay <alias>] [--wait-for-name | --replace] [seconds]
      Go online as $HOPTELL_NAME, print the next message and exit. Waits up
      to [seconds] (default 300). If another session has the name: stop
      (default), wait for it (--wait-for-name), or take it over once
      (--replace).`,
  listen: `  hoptell listen [--no-ack] <name> [seconds]
      Wait for the next messages in <name>'s local inbox, print them and
      exit. Waits up to [seconds] (default 3600).
  hoptell listen [--no-ack] --session <folder> [seconds]
      The same for an agent session's storage folder (the session shows it).
      Acknowledges after printing, or prints a receipt with --no-ack.`,
  ack: `  hoptell ack <receipt> <name>
  hoptell ack <receipt> --session <folder>
      Acknowledge messages printed with --no-ack.`,
  doctor: `  hoptell doctor [--relay-check] [--fix]
      Check this machine's settings and connections, and finish interrupted
      saves.
      --relay-check  also send a test message through the relay
      --fix          also remove transfer leftovers (staging, outbox)`,
  transfers: `  hoptell transfers [cancel <t_id>]
      EXPERIMENTAL: file transfers staged for you (or being fetched).`,
  save: `  hoptell save <t_id> <path> [--overwrite] [--yes]
  hoptell save --forget <t_id>
      EXPERIMENTAL: save a staged transfer to a path you choose (never
      replaces a file without --overwrite).`,
  device: `  hoptell device enroll [--new-baseline --yes] | status | list
  hoptell device accept <device> [--set <code>]
  hoptell device pending [--cancel <device>]
  hoptell device expect <device> <pin identity>
  hoptell device retire [--yes] | replenish [--force] | rotate
  hoptell device revoke <device> | backup <file> | restore <file>
  hoptell device migrate <backup>
      EXPERIMENTAL (HOPTELL_EXPERIMENTAL_E2EE=1): this machine's device key
      for encrypted messages.`,
  telegram: `  hoptell telegram setup [--relay <alias>] [--name owner]
      Set up the owner channel (a Telegram bot). Reads the bot token from
      standard input.
  hoptell telegram pair | run | status | identity [--apply] | unpair [--all]
      \`run\` exits with code 78 when the encryption policy refuses it.
      Do not restart it on 78.
  hoptell telegram trust '<pin>' [--add]
  hoptell telegram trust --remove-key <key id> | --revoke <realm id>
  hoptell telegram key next | key commit
      Rotate the bridge's signing key (with the bridge stopped).
  hoptell telegram app --on|--off|--rotate|--status
  hoptell telegram fav|unfav <name> | alias <name> <new name> | sessions
      The app in Telegram, your favourites and names.
      More: hoptell telegram --help`,
  hooks: `  hoptell hooks
      Print Claude Code hook settings for hook delivery without the plugin.`,
  version: `  hoptell --version
      Print the version of hoptell.`,
};

const FOOTER = () => `Settings come from environment variables, else from the first file found of:
${envFiles()
  .map((f) => `  ${f}`)
  .join("\n")}

Agent sessions:
  HOPTELL_RELAY, HOPTELL_TOKEN   the relay URL and your token
  HOPTELL_NAME, HOPTELL_ROLES    your peer name; roles, e.g. reviewer,backend
  HOPTELL_RELAYS                 a relays file: several relays, name@relay
  HOPTELL_HOME                   state directory
  HOPTELL_PROFILE                relay profile key
  HOPTELL_PUSH                   channel, hook, tmux or listener
                                 (unset: automatic)
  HOPTELL_PROTOCOL               1 keeps the older relay protocol
  HOPTELL_RECEIPTS               on or off
  HOPTELL_LEASE_MINUTES          1 to 1440
  HOPTELL_NOTIFY                 off: no desktop notifications
  HOPTELL_AUTH                   login: use hoptell login
  HOPTELL_CREDENTIAL_STORE       file or keychain
  HOPTELL_CREDENTIAL_PASSPHRASE
  HOPTELL_EXPERIMENTAL_E2EE      1: experimental device keys and encryption
Relay:
  HOPTELL_HOST, HOPTELL_PORT, HOPTELL_TOKEN and/or HOPTELL_MEMBERS,
  HOPTELL_POLICY, HOPTELL_STATE_DIR, HOPTELL_REQUIRE_MEMBERS,
  HOPTELL_REALM_NAME, HOPTELL_OIDC, HOPTELL_TRUSTED_PROXIES,
  HOPTELL_LOG_FORMAT, HOPTELL_METRICS_PORT, HOPTELL_METRICS_HOST,
  HOPTELL_LOG_FINGERPRINTS=on with HOPTELL_LOG_FINGERPRINT_KEY_FILE
On/off settings accept 1, true, on, yes and 0, false, off, no. Invalid values
are refused or reported; some settings warn and use their default.

Send to a peer name, to @<role> (every online peer with that role) or to @all.`;

/** `hoptell help`: every command. */
export const usage = () => `${HEADER}\n\n${COMMON}\n\nAll commands:\n${Object.values(HELP).join("\n")}\n\n${FOOTER()}`;

/** `hoptell <command> --help`: that command's lines, and its detailed usage where it has one. */
export function commandHelp(cmd, args = []) {
  if (cmd === "relay" && args[0] === "admin") return ADMIN_USAGE;
  const more = { telegram: TELEGRAM_USAGE, device: DEVICE_USAGE, "mcp-hosted": HOSTED_USAGE }[cmd];
  return `Usage:\n${HELP[cmd]}${more ? `\n\n${more}` : ""}${cmd === "relay" ? `\n\n${ADMIN_USAGE}` : ""}`;
}

/** The version in package.json. */
export const version = () => JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Commands whose first word may be `help` (for the others it can be a peer name or a file).
const HELP_WORD = new Set(["relay", "members", "grants", "local-relay", "contacts", "mcp-http", "mcp-hosted", "agents", "worktree", "transfers", "device", "telegram"]);
const isHelp = (a) => a === "--help" || a === "-h";
// Options that take a value, in any command (the value is never a subcommand).
const VALUE_FLAGS = new Set(["--members", "--state-dir", "--host", "--port", "--issuer", "--subject", "--until", "--rev", "--policy-rev", "--relay", "--session", "--how", "--set", "--reason", "--policy", "--oidc", "--realm-name", "--trusted-proxies", "--log-format", "--metrics-port", "--metrics-host", "--wal-soft-limit", "--wal-hard-limit", "--transfer-quota", "--transfer-member-quota", "--retire", "--purge", "--member", "--since", "--pages", "--discard-evidence", "--config", "--bind", "--name", "--roles", "--run", "--home", "--mode", "--client-id", "--client-secret-file", "--store", "--photo", "--remove-key", "--realm", "--revoke", "--cancel", "--team", "--cli", "--base", "--folder", "--owns", "--repo", "--message", "-m", "--cwd", "--task", "--lead", "--template"]);

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
  agents: ["--accept-read-risk", "--all", "--start", "--discard", "--run", "--home", "--list", "--revoke", "--refresh", "--diff", "--json", "--role", "--model", "--effort", "--lead", "--template"],
  worktree: ["--team", "--cli", "--base", "--folder", "--owns", "--repo", "--message", "--allow-outside", "--stat"],
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
  agents: ["--run", "--home", "--role", "--model", "--effort", "--lead", "--template"],
  worktree: ["--team", "--cli", "--base", "--folder", "--owns", "--repo", "--message"],
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
