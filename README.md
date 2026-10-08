# ![hoptell icon](assets/icon-40.png) hoptell

**Let AI coding agents talk to each other: across sessions, machines, accounts and tools.**

hoptell connects Claude Code, Codex, Antigravity (`agy`) and other MCP-capable agents through one small
relay that you run yourself on your LAN or VPN. Agents get tools to list peers and
send messages, and incoming messages **wake idle agents up**, so a Claude session on
your laptop can hand a review to a Codex session on a colleague's workstation and
get the answer back without anyone typing.

![Sam's Claude Code sends the contents of greet.js to Alex's Codex, which wakes up and suggests a corrected line](https://github.com/EminUZUN/hoptell/releases/download/v0.1.0/demo-review.gif)

*Sam's Claude Code on a MacBook sends the contents of `greet.js` to Alex's Codex in a Linux container. Codex wakes up and returns a one-line suggested fix. Real session, played at 2.5× speed with idle pauses shortened.*

```
 laptop:   Claude Code ──┐                        ┌── Codex        :workstation
 laptop:   Codex       ──┼── hoptell relay (LAN) ─┼── Claude Code  :workstation
 CI box:   Claude Code ──┘    one tiny process    └── ...
```

- **Self-hosted, no accounts.** One Node process. Agents can use different Claude or
  OpenAI accounts. Messages between agents travel only through your relay; each agent
  still talks to its own AI provider as usual.
- **Wakes supported idle sessions.** Claude Code can use channel or verified hook notices. In tmux,
  supported terminal prompt layouts can receive a fixed inbox notice; other sessions can poll.
- **Teams and swarms.** Agents announce roles (`reviewer`, `backend`, ...). Send to one
  agent by name, to every agent with a role (`@reviewer`), or to everyone (`@all`).
- **Small and auditable.** JavaScript, with two direct runtime dependencies (`ws` and the MCP SDK).

Agents can also answer questions about plans, not only code:

![Sam's Claude Code asks @pm about the demo app's 2.4 release; Dana's agent answers from planning/roadmap.md](https://github.com/EminUZUN/hoptell/releases/download/v0.1.0/demo-ask-pm.gif)

*Sam's Claude Code asks `@pm` about the demo app's 2.4 release, and Dana's agent answers from `planning/roadmap.md` in its Linux container. Real session, played at 2.5× speed with idle pauses shortened.*

> hoptell moves plain text between agents that may act on it. Read [Security](#security)
> before connecting agents that run with relaxed permissions.

## How it works

| Part | What it does |
|---|---|
| `hoptell relay` | WebSocket hub on one machine: authenticates peers, routes messages, queues messages for offline peers (in memory). |
| `hoptell mcp` | MCP server each agent session runs: tools `list_peers`, `send_message`, `wait_for_message`, `read_inbox`. |
| `hoptell tmux` | Runs a terminal agent in tmux and attempts to submit a fixed inbox notice when its prompt appears idle. |
| `hoptell send / list / wait / listen` | CLI for scripts, CI jobs and agents without MCP. |

How an incoming message reaches the agent:

| Agent | Start it with | Incoming message |
|---|---|---|
| Claude Code (channel) | `claude --dangerously-load-development-channels server:hoptell` | a channel notice wakes the agent, which calls `read_inbox` to read the message |
| Claude Code (hooks) | `claude` with the hoptell plugin, or with the settings from `hoptell hooks` | a fixed hook notice wakes the agent, which calls `read_inbox` |
| Claude Code (listener) | `HOPTELL_PUSH=listener claude` | the MCP server asks Claude to keep a background `hoptell listen` running; Claude can wake when it returns |
| Antigravity (`agy`) | `agy` | background `hoptell listen`, like plain Claude Code |
| Supported terminal agents in tmux | `hoptell tmux <name> -- codex` | a fixed notice is typed into the agent's prompt; the agent calls `read_inbox` |
| Anything else | — | `wait_for_message` / `read_inbox` tools, or `hoptell wait` |

Each MCP server chooses one delivery mode. Avoid registering hoptell twice in the same Claude Code session. Unless `HOPTELL_PUSH` chooses one (`channel`, `hook`,
`tmux` or `listener`), hoptell picks it when the session starts: channel when Claude Code was
started with the hoptell channel; otherwise hook when the hoptell hooks answer a silent check
for that Claude Code process; otherwise listener. `hoptell tmux` always uses tmux. Notices
never contain message text: the message stays in the local inbox until the agent reads it.
A notice does not prove that the agent read or acted on a message.

Channels are Claude Code's [channels](https://code.claude.com/docs/en/channels) (research
preview). Custom channels need the `--dangerously-load-development-channels` flag, and
Claude Code asks you to confirm a "development channels" warning each time it starts with
it. In listener mode, the MCP instructions ask the agent to start a background listener after your first prompt.

Hook delivery uses Claude Code [hooks](https://code.claude.com/docs/en/hooks) and needs no
flag. The plugin's `SessionStart` hook asks Claude Code to watch a private file, and when a
message arrives, the MCP server changes that file. Claude Code then runs the plugin's
`FileChanged` hook, which wakes the session with a fixed notice to call `read_inbox`. Settings
such as `disableAllHooks` can prevent hooks from running. In automatic mode, a failed startup check
selects listener delivery; disabling hooks later does not change the selected mode. An explicit
`HOPTELL_PUSH=hook` does not fall back to the listener. For hooks in settings files, interactive
sessions require workspace trust; `-p` and SDK sessions treat the folder as trusted. Tested with the Claude Code terminal app on macOS. Without the
plugin, `hoptell hooks` prints the hook settings to add to your Claude Code settings; it does
not change any file.

If the MCP entry sets `HOPTELL_HOME`, run `HOPTELL_HOME=<same value> hoptell hooks` so the printed hook commands use the same state directory.

## Quick start

Requirements: Node.js 20+, plus tmux 3.2+ to wake Codex/terminal agents. Supported on macOS
and Linux; on Windows only the relay and polling tools work.

### 1. Install (every machine)

```sh
npm install -g hoptell    # puts `hoptell` on your PATH
```

From source instead: `git clone https://github.com/EminUZUN/hoptell && cd hoptell && npm install && npm link`.

Claude Code clients can use the plugin instead of the manual MCP registration in step 4.
It asks for the relay URL and token (stored in Claude Code's secure storage). The relay
machine still needs the npm installation above or the Docker image. Anyone using the
`hoptell` CLI or `hoptell tmux` needs the npm installation above.

Install the plugin. With automatic delivery, plain `claude` uses hooks when the startup check succeeds; add the channel flag to use channels:

```
/plugin marketplace add EminUZUN/hoptell
/plugin install hoptell@hoptell
claude                                                                    # hook notices
claude --dangerously-load-development-channels plugin:hoptell@hoptell   # channel notices
```

The relay image is `ghcr.io/eminuzun/hoptell`, and the server is listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.EminUZUN/hoptell`.

### 2. Start a relay (one machine)

```sh
mkdir -p ~/.config/hoptell
cat > ~/.config/hoptell/.env <<EOF
HOPTELL_TOKEN=$(openssl rand -hex 32)
HOPTELL_HOST=192.0.2.10
EOF
chmod 600 ~/.config/hoptell/.env
hoptell relay
```

Replace `192.0.2.10` with this machine's LAN or VPN address in the relay settings above.
For Docker, use the same address and replace `...` with your generated token:
`docker run -d -p 192.0.2.10:7777:7777 -e HOPTELL_TOKEN=... ghcr.io/eminuzun/hoptell`.
Publish the port on that address only. Without a host address, `-p 7777:7777` publishes
on all host addresses by default. See [examples/](examples/). Health check: `GET /healthz`.

### 3. Configure each machine

Add these settings to `~/.config/hoptell/.env` (chmod 600). On the relay machine, add
them to the file from step 2 and keep its `HOPTELL_HOST` and token:

```sh
HOPTELL_RELAY=ws://192.0.2.10:7777
HOPTELL_TOKEN=<the same token>
```

Check: `hoptell list` should connect and print the peers (none yet).

### 4. Connect your agents

**Claude Code**: register the MCP server once (user scope, all projects):

```sh
claude mcp add --scope user hoptell -- hoptell mcp
```

If an agent cannot find `hoptell` (for example with nvm), use the full path that
`command -v hoptell` prints, here and in the configs below.

Then start Claude with push enabled:

```sh
HOPTELL_NAME=laptop-claude claude --dangerously-load-development-channels server:hoptell
```

Or start plain `claude` with hook notices instead of channels: add the hook settings that
`hoptell hooks` prints to `~/.claude/settings.json` (the plugin includes them).

Inside a clone of this repo, `.mcp.json` registers the server for you.

**Codex**: add to `~/.codex/config.toml`:

```toml
[mcp_servers.hoptell]
command = "hoptell"
args = ["mcp"]
tool_timeout_sec = 1800                  # wait_for_message can block up to 1500s
default_tools_approval_mode = "approve"  # optional: no approval prompt per hoptell tool call
```

Then start Codex through tmux so messages wake it:

```sh
hoptell tmux laptop-codex -- codex
```

The launcher passes the peer name to Codex as a `-c` override, because interactive
Codex starts MCP servers from a shared daemon that does not inherit your shell's
environment. Detach with `Ctrl-b d`, reattach with `tmux attach -t hoptell-laptop-codex`.

**Antigravity (`agy`)**: register the MCP server once:

```sh
agy mcp add hoptell hoptell mcp
HOPTELL_NAME=laptop-agy agy                      # listener mode, after your first prompt
hoptell tmux laptop-agy --roles gemini -- agy    # or: woken through tmux
```

### 5. Try it

Ask either agent: *"list hoptell peers and say hi to laptop-codex"*.

If a Claude Code session does not wake up after another agent's `send_message` reports the
message as delivered, ask the agent to call `read_inbox`: messages are stored in the local inbox
before any channel or hook notice is sent. `hoptell doctor` shows the delivery setting and the
hook sessions running on this machine.

## For organizations

hoptell has no central service: every organization runs its own relay, and agents connect
from their users' machines.

1. **Run a relay** inside your network: the Docker image (`examples/docker-compose.yml`),
   or the systemd unit (`examples/hoptell-relay.service`), behind your VPN or a TLS proxy.
2. **Issue per-member tokens** with a members file (see [Teams and swarms](#teams-and-swarms)),
   so people cannot use each other's agent names.
3. **Roll out the client**: the Claude Code plugin, or `npm install -g hoptell` plus
   the MCP config for Codex and Antigravity.
4. **Allowlist the channel** (Claude Code): with [managed settings](https://code.claude.com/docs/en/channels#enterprise-controls)
   your users can start `claude --channels plugin:hoptell@hoptell`, without the development flag
   and its prompt:

   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [{ "marketplace": "hoptell", "plugin": "hoptell" }]
   }
   ```

## Teams and swarms

**Names.** Each agent has a peer name (`HOPTELL_NAME`; default `<hostname>-<pid>`):
letters, digits, `_` and `-`. A new connection using a name already in use replaces the
old one. For names up to 58 characters, the replaced MCP session waits until the name is
free, then reconnects automatically. This lets it recover after a temporary copy of its
MCP server exits, such as a copy started only to list tools. Longer names still require
the session to be restarted.

**Roles.** `HOPTELL_ROLES=reviewer,backend` (or `hoptell tmux <name> --roles reviewer -- codex`).
`list_peers` shows them. Sending to `@reviewer` reaches every *online* peer with that role,
and `@all` reaches every online peer. A busy peer gets it queued behind its unconfirmed
messages. Fan-out is not queued for offline peers. A direct
message to a name is queued while that peer is offline (up to 50 per peer, in relay memory).
Roles are labels that agents choose for themselves to route work. They are not permissions.

**Many people.** Give each person their own token so nobody can impersonate anyone else's
agents. Create a members file on the relay (chmod 600):

```json
{ "members": [
    { "name": "alice", "token": "<openssl rand -hex 32>" },
    { "name": "bob",   "token": "sha256:<hex sha256 of bob's token>" } ] }
```

Run `hoptell relay --members members.json` or set `HOPTELL_MEMBERS`. A member may only use
the name `<member>` or names starting with `<member>-` (`alice-claude`, `alice-codex-2`).
The relay refuses member names that overlap, such as `alice` and `alice-bob`.
You can combine a members file with a shared `HOPTELL_TOKEN`; token holders can use any name.

To add, remove or change member tokens without a restart, edit the file and run
`kill -HUP <relay pid>`. The relay re-reads it and closes connections whose token was removed
or changed. If the new file is invalid, it keeps the active members list and logs a sanitized
error. An empty list (`{"members": []}`) removes every member. The shared token is not
reloaded. With systemd `LoadCredential`, restart the service to refresh the credential copy. A
Docker bind mount of a single file can keep the old file when an editor replaces it
atomically; restart the container after such edits, or bind-mount the containing directory to
support reloads.
For separate teams, run separate relays. A relay is a single small process.

**Example swarm on one machine:**

```sh
hoptell tmux alice-planner  --roles planner  -- claude
hoptell tmux alice-codex-1  --roles backend  -- codex
hoptell tmux alice-codex-2  --roles backend  -- codex
hoptell tmux alice-reviewer --roles reviewer -- claude
```

Then tell the planner: *"split the task, send backend work to @backend, and send the result to @reviewer"*.

**Guard rails.** Each connection may send at most 30 messages per 10 seconds, so two agents
that keep replying to each other hit the limit instead of flooding everyone. Messages are
plain text up to 100,000 characters.

## Replies and file reviews

Clients from 0.2.0 display a `Message reference:` line after the message text. When it contains
a UUID, pass that UUID as `reply_to` (MCP) or `--reply-to` (CLI) when answering. Receiving
clients from 0.2.0 display the link as `In reply to:`. If the reference is unavailable, omit
the option. Relays before 0.2.0 do not provide references, and older client renderers omit
these fields. A reply reference is a sender-supplied label; the relay does not verify that the
referenced message exists.

When a file goes to another agent for review, the reviewer may answer after the file has
changed. To know which version a suggestion refers to:

1. Run `hoptell snapshot greet.js` and send the complete output unchanged. It captures the
   file through one descriptor and includes the SHA-256 of the captured bytes, a
   `review_request_id` and the content. Keep the original request id, digest, local path and
   intended reviewer in your task context. The file must contain valid UTF-8 and be at most
   60,000 bytes; the encoded snapshot must also fit the message limit of 100,000 characters.
2. The reviewer quotes the `review_request_id` and gives the snapshot's `sha256` as
   `based_on`.
3. Check that the reply comes from the reviewer you asked and that its `review_request_id`
   and `based_on` match your original snapshot. Then run
   `hoptell snapshot --check <original-sha256> greet.js` against the original local path. If
   the metadata does not match or the file changed, ask for a new review or reconcile the
   change deliberately.

A `based_on` value is the reviewer's statement, not proof of what a model read. The check
compares current file bytes with the supplied digest; it does not validate a reply or apply
changes. A capture is not an atomic filesystem snapshot, and the file can change again after
the check. Unsaved editor changes are outside this comparison. Connected agents get these
steps in the hoptell instructions.

### File tools: send_file and verify_snapshot

Agents can also send a file without running a command, and check it later by id. These tools
are off by default. To turn them on, approve folders on the sender's machine (macOS or Linux):

Set this in the shell that starts the MCP server, or add the KEY=VALUE setting to its local
settings file.

```sh
export HOPTELL_SNAPSHOT_ROOTS='[{"id":"app","path":"/Users/sam/work/app"}]'
```

(In the plugin, use the **Approved snapshot folders** setting; `[]` turns the tools off.)
Restart the MCP server after changing this setting (restart the agent session if needed).

- `send_file` takes `to` (one peer), `root_id`, a `path` inside that folder and a `request`.
  It captures up to 60,000 bytes of UTF-8 text through a reader that refuses symlinks, hard
  links and special files, and rejects changes it detects during the read. The encoded
  snapshot must also fit the message limit. It requests a one-hour relay queue deadline by
  default; older relays ignore this request. It returns a local `snapshot_id`.
- `verify_snapshot` takes that `snapshot_id` and reports `match`, `changed`, `unknown`,
  `expired` or `unavailable`. It compares file bytes only; it does not validate a reply.

Approved folders are local: a request from another agent never adds one, and the reviewer's
machine never resolves the sender's file label as a path. Records of sent snapshots expire
after 24 hours. Expired records are cleaned up while an MCP server with file tools enabled is
running; backups may retain copies.

## CLI

```
hoptell relay --host <ip> [--port 7777] [--members file.json]
hoptell mcp
hoptell tmux <name> [--roles a,b] -- <agent command...>
hoptell list
hoptell send [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>
                                      # to: name, @role or @all; sends as $HOPTELL_NAME without going online
                                      # --ttl: request relay queue expiry; older relays ignore it
                                      # --reply-to: the "Message reference" you are answering
hoptell wait [seconds]                # goes online as $HOPTELL_NAME and prints the next message
hoptell listen <name> [seconds]       # waits on <name>'s local inbox (no relay connection)
hoptell doctor                        # checks settings, relay, login, inbox and tmux; never prints the token
hoptell hooks                         # prints Claude Code hook settings for hook delivery without the plugin
hoptell snapshot <file>               # prints a UTF-8 file snapshot with its SHA-256, for review
hoptell snapshot --check <sha256> <file>  # exit 0 if the bytes match; nonzero if different or the check fails
```

Expiry does not remove messages already delivered to a local inbox.

Settings come from environment variables, otherwise from the first existing file of
`$HOPTELL_ENV`, `~/.config/hoptell/.env`, `<package>/.env`. See [.env.example](.env.example). In settings files,
double-quoted values decode JSON-style escapes (`\"`, `\\`, `\n`), single-quoted values are
literal, and an empty value counts as unset.

| Variable | Used by | Meaning |
|---|---|---|
| `HOPTELL_RELAY` | peers | relay URL, `ws://host:7777` or `wss://` behind TLS |
| `HOPTELL_TOKEN` | both | shared secret, or a member's own token |
| `HOPTELL_NAME` | peers | this agent's peer name |
| `HOPTELL_ROLES` | peers | comma-separated roles |
| `HOPTELL_PUSH` | peers | `channel`, `hook`, `tmux` or `listener`; unset picks one per session |
| `HOPTELL_HOME` | peers | local state directory (default `~/.hoptell`) |
| `HOPTELL_HOST`, `HOPTELL_PORT` | relay | listen address (required) and port (default 7777) |
| `HOPTELL_MEMBERS` | relay | members file with per-member tokens |
| `HOPTELL_SNAPSHOT_ROOTS` | peers | JSON list of approved folders for the file tools, e.g. `[{"id":"app","path":"/abs/app"}]`; off when unset |
| `HOPTELL_LOG_FINGERPRINTS` | relay | `on` enables keyed message-text fingerprints in relay logs; default `off` |
| `HOPTELL_LOG_FINGERPRINT_KEY_FILE` | relay | absolute path to a private key JSON file, required when fingerprint logging is enabled |

### Keyed log fingerprints (optional)

On macOS and Linux, optional keyed fingerprints help correlate the text the relay holds at
routing, queue, forward-attempt, requeue, receipt and expiry events. Enable
`HOPTELL_LOG_FINGERPRINTS=on` and configure `HOPTELL_LOG_FINGERPRINT_KEY_FILE` with a private
JSON file containing `v: 1`, a public `id` and `key_hex` with 64 lowercase hex digits from a
separately generated random key. The relay adds a full HMAC-SHA-256 tag to message log events,
using the message reference as a nonce. It does not log message text or send the key or tags
to clients. Protect the key file and logs. Rotation requires a new key/id and a relay restart.
With Compose file secrets, recreate the container; with systemd LoadCredential, restart the
service to load its new copy. Restarting still discards pending in-memory messages.

Create the key file in an existing private directory (mode 0600; nothing secret is printed). The
command runs as the current user; `/etc/hoptell` normally requires root. The relay accepts a key
owned by its own user or root, provided it can read the file:

```sh
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({v: 1, id: process.argv[2], key_hex: require("crypto").randomBytes(32).toString("hex")}) + "\n", {flag: "wx", mode: 0o600})' /etc/hoptell/fingerprint-key.json relay-2026-10
```

These fingerprints record the relay's view of a message. They do not identify a file version,
validate what a receiving agent read, or make logs tamper-proof. File reviews use the
snapshot's original byte digest and a local check before editing. Message-specific nonces avoid
a stable tag for repeated text, but the key holder can test guesses about a message. Log
metadata can still identify participants.

## Security

hoptell's job is to put text from one agent in front of another agent. Plan for that:

- **Anyone who holds a valid token can message your agents**, and agents running with
  relaxed permissions (`--dangerously-skip-permissions`, auto-approve) may act on it.
  Keep tokens secret, use per-member tokens for groups, and run the relay on a
  private network or VPN only.
- **Messages are labeled, not trusted.** Agents are told that hoptell messages come from
  other agents, not from their user. Message text cannot close the channel tag or forge a
  message boundary. That is guidance for the model, not a sandbox.
- **Use TLS outside a trusted network.** The relay speaks plain `ws://`. Put it behind a
  VPN (WireGuard, Tailscale) or a TLS proxy, for example Caddy:
  `caddy reverse-proxy --from relay.example.com --to 127.0.0.1:7777`, then use
  `HOPTELL_RELAY=wss://relay.example.com`.
- **tmux delivery types into a live terminal.** The injector types only a fixed notice, never
  message text, and only into the pane where it started the agent. It waits while the pane is
  in copy mode, while it recognizes an approval prompt, until nobody attached to the session
  has typed for a few seconds, and until it recognizes the agent's prompt as empty (Claude
  Code, Codex and Antigravity layouts). On any other screen it does not type. This is best
  effort, based on what the screen shows: use a pane you are not typing in, and prefer agents
  that ask before risky actions over auto-approve modes. Typed text reaches the agent as
  input from you, which is why only the fixed notice is typed.
- **Hook notices come from your own hook settings.** Claude Code treats hook output as
  configured by you, so hoptell's hooks print only the fixed notice and never message text.
- Local inboxes live in `~/.hoptell/inbox/<name>/` (0700/0600). Every message holds the
  sender name the relay verified.

### What the hoptell MCP server does on your machine

- **Runs** a local MCP server over standard input/output, `hoptell mcp`. The Claude Code plugin starts `node ${CLAUDE_PLUGIN_ROOT}/bin/hoptell.js mcp`.
- **Uses** two direct runtime dependencies, `ws` and `@modelcontextprotocol/sdk`. `package-lock.json` records resolved dependency versions. Installing from a checkout with `npm ci` uses that lockfile and can download packages from the configured npm registry. The MCP server does not install dependencies at startup.
- **Loads** settings from environment variables and a local settings file, when present: an explicit `HOPTELL_ENV` file, otherwise the first existing file of `$XDG_CONFIG_HOME/hoptell/.env` (default `~/.config/hoptell/.env`) and `<package>/.env`. It also reads its package's `package.json` for the version.
- **Connects** by WebSocket to the relay you configure. Its hello frame sends the token, peer name, roles, sanitized host name, protocol version and connection mode. It sends message destinations and text, peer-list requests and receipt acknowledgements; it receives addressed messages, peer-list metadata and protocol responses.
- **Stores** incoming MCP messages before acknowledging receipt. It creates private inbox directories (0700) and message files (0600) under `~/.hoptell/inbox/<name>/` by default, or `$HOPTELL_HOME/inbox/<name>/` when configured. Files are consumed and deleted by `read_inbox`, `wait_for_message` or `hoptell listen`. Recovering abandoned inbox claims checks whether the claiming process exists with `process.kill(pid, 0)`.
- **Inspects** the processes that started it with `ps -o ppid=,uid=,lstart=,args= -p <pid>` to find the Claude Code process that started it and check its channel flags, and reads the boot identifier (`/proc/sys/kernel/random/boot_id` on Linux, `sysctl -n kern.boottime` on macOS) and process start times to tell processes apart. This check is skipped when `HOPTELL_PUSH` chooses `channel`, `tmux` or `listener`.
- **For hook delivery**, uses private files in `~/.hoptell/wake/` (0700/0600; under `$HOPTELL_HOME` when configured), keyed by the Claude Code process: a small counter file that Claude Code watches, a registration written by the `SessionStart` hook (process identity, session id and a random value), the MCP server's record (its process identity, peer name and current request) and the hook's last acknowledgement. They contain no message text, sender, relay URL, token, prompt or transcript. On a handled shutdown, the MCP server removes its runtime record and notice claims. Ownership state is retained for later ended-host cleanup. Later SessionStart hooks attempt bounded cleanup of ended hosts whose registration is old; deletion by a fixed deadline is not guaranteed. Claude Code executes the `hook-session-start` and `hook-file-changed` CLI commands with your OS permissions. These commands load normal hoptell settings, perform the local process inspection described above, and read and write wake files; they do not open inbox message or transcript files.
- **Tells agents** in its instructions how to capture file snapshots with the local CLI and check them before applying suggestions. The MCP server does not execute these snapshot commands. An agent or user must run the CLI under their own permissions; the CLI loads its normal settings before capturing or checking the selected file.
- **File tools** are disabled by default. When you configure approved local folders, send_file can read a selected regular UTF-8 file from those folders and send its captured content, a relative file label, byte count, SHA-256 digest, review request id and review request to one named peer through your configured relay. The receiving agent's AI provider may process that content. Folder configuration does not make another agent's request an authorization to share a file.
- **The file tools start** a bundled Node helper on the same machine to perform checked file reads. They do not run a shell, download software, execute project code or make additional network connections. The helper uses the MCP server's OS permissions; configuring folders does not inherit an AI agent's separate filesystem sandbox.
- **verify_snapshot** reads the private outgoing metadata record and the original file in a currently approved folder. It compares file bytes locally; it does not send the file, validate a reply or apply a change.
- **In listener mode**, instructs the receiving agent to run `node <package>/bin/hoptell.js listen <name>` as a background command when supported. That command polls and consumes the local inbox. Launching it remains subject to the receiving agent's permissions.
- **At runtime**, the MCP server opens outbound WebSocket connections only to its configured relay. It has no telemetry and does not change the agent's permission settings. Dependency installation is separate from runtime; each agent still communicates with its own AI provider.

To report a vulnerability, see [SECURITY.md](SECURITY.md). How hoptell handles data is described in [PRIVACY.md](PRIVACY.md).

## Limitations

- The relay keeps offline queues in memory; restarting the relay drops them.
- Delivery is at least once. "Delivered" means the receiving machine stored the message in
  the agent's inbox or pushed it into the session, not that the agent has acted on it. A message
  that was not confirmed is redelivered after the receiver reconnects, so in rare cases it
  arrives twice. A receiver gets at most 50 unconfirmed messages; more wait in its queue.
- Channel delivery depends on Claude Code channels (research preview); the flag name may change.
- Hook delivery depends on Claude Code's `FileChanged` hook and `asyncRewake` option. It was
  tested with the Claude Code terminal app; the VS Code extension and Desktop app are untested.
  One hoptell MCP server per Claude Code process can use it; a second one uses the listener.
- No built-in TLS, persistence, message history or web UI, by design: the relay stays small.
- The file tools (`send_file`, `verify_snapshot`) need macOS or Linux. Windows peers can still
  receive and review snapshots.

## Roadmap

Ideas that fit the small-relay design, roughly in order:

- optional per-member send rules
- optional on-disk queue so a relay restart keeps undelivered messages

## Development

```sh
npm install
npm test        # starts its own relay on a random port; tmux tests run when tmux is installed
```

`npm run test:e2e` is an opt-in end-to-end test with real agents. It starts a relay and two
Docker "machines" running Claude Code, Codex and Antigravity, then checks a roll call
(`@all`) and a baton passed through every agent across both machines. It needs Docker and
agent logins (`--use-local-logins` copies this machine's logins into the test containers
for the run; `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY` also work; see
[test/e2e/run.mjs](test/e2e/run.mjs)), uses your model subscriptions, and takes a few
minutes. It runs only on your machine, never in CI.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [Apache License 2.0](LICENSE).
