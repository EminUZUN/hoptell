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
- **Wakes agents up.** Claude Code with channels enabled gets a notice and reads the message; Codex (or
  any terminal agent) gets it pasted in through tmux; anything else can poll.
- **Teams and swarms.** Agents announce roles (`reviewer`, `backend`, ...). Send to one
  agent by name, to every agent with a role (`@reviewer`), or to everyone (`@all`).
- **Small and auditable.** About 1,200 lines of JavaScript, two dependencies (`ws` and the MCP SDK).

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
| `hoptell tmux` | Runs a terminal agent in tmux and pastes incoming messages into it, so it wakes up. |
| `hoptell send / list / wait / listen` | CLI for scripts, CI jobs and agents without MCP. |

How an incoming message reaches the agent:

| Agent | Start it with | Incoming message |
|---|---|---|
| Claude Code (push) | `claude --dangerously-load-development-channels server:hoptell` | a channel notice wakes the agent, which calls `read_inbox` to read the message |
| Claude Code (plain) | `claude` | the MCP server asks Claude to keep a background `hoptell listen` running; Claude wakes when it returns |
| Antigravity (`agy`) | `agy` | background `hoptell listen`, like plain Claude Code |
| Codex, Antigravity, or any terminal agent | `hoptell tmux <name> -- codex` | pasted into the agent's prompt |
| Anything else | — | `wait_for_message` / `read_inbox` tools, or `hoptell wait` |

Push uses Claude Code's [channels](https://code.claude.com/docs/en/channels) (research
preview). Custom channels need the `--dangerously-load-development-channels` flag, and
Claude Code asks you to confirm a "development channels" warning each time it starts with
it. hoptell detects the flag and adapts. Set `HOPTELL_PUSH=channel|listener` to override
the detection. Without the flag, the background listener starts after your first prompt in
the session.

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

Install the plugin and start Claude Code with push enabled:

```
/plugin marketplace add EminUZUN/hoptell
/plugin install hoptell@hoptell
claude --dangerously-load-development-channels plugin:hoptell@hoptell   # with push
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
letters, digits, `_` and `-`. A new connection with a name already in use replaces the
old one.

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

## CLI

```
hoptell relay --host <ip> [--port 7777] [--members file.json]
hoptell mcp
hoptell tmux <name> [--roles a,b] -- <agent command...>
hoptell list
hoptell send <to> <message...>        # to: name, @role or @all; sends as $HOPTELL_NAME without going online
hoptell wait [seconds]                # goes online as $HOPTELL_NAME and prints the next message
hoptell listen <name> [seconds]       # waits on <name>'s local inbox (no relay connection)
```

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
| `HOPTELL_PUSH` | peers | `channel` or `listener`, overrides detection |
| `HOPTELL_HOME` | peers | local state directory (default `~/.hoptell`) |
| `HOPTELL_HOST`, `HOPTELL_PORT` | relay | listen address (required) and port (default 7777) |
| `HOPTELL_MEMBERS` | relay | members file with per-member tokens |

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
- **tmux injection types into a live terminal.** The injector pastes only into the pane
  where it started the agent, never into another pane, and holds back while it recognizes an
  approval prompt on screen. That is best effort, based on what the screen shows; prefer
  agents that ask before risky actions over auto-approve modes. A message that itself looks
  like a prompt is never typed: the agent gets a short notice to fetch it with `read_inbox`.
  Detection errs on the side of waiting: text on screen that merely looks like a prompt
  (for example a quoted question the agent just printed) also holds later messages until
  it scrolls away. Held messages stay in the inbox; nothing is lost. Anything you have half-typed in that pane is submitted together with the message.
- Local inboxes live in `~/.hoptell/inbox/<name>/` (0700/0600). Every message holds the
  sender name the relay verified.

### What the hoptell MCP server does on your machine

- **Runs** a local MCP server over standard input/output, `hoptell mcp`. The Claude Code plugin starts `node ${CLAUDE_PLUGIN_ROOT}/bin/hoptell.js mcp`.
- **Uses** two direct runtime dependencies, `ws` and `@modelcontextprotocol/sdk`. `package-lock.json` records resolved dependency versions. Installing from a checkout with `npm ci` uses that lockfile and can download packages from the configured npm registry. The MCP server does not install dependencies at startup.
- **Loads** settings from environment variables and a local settings file, when present: an explicit `HOPTELL_ENV` file, otherwise the first existing file of `$XDG_CONFIG_HOME/hoptell/.env` (default `~/.config/hoptell/.env`) and `<package>/.env`. It also reads its package's `package.json` for the version.
- **Connects** by WebSocket to the relay you configure. Its hello frame sends the token, peer name, roles, sanitized host name, protocol version and connection mode. It sends message destinations and text, peer-list requests and receipt acknowledgements; it receives addressed messages, peer-list metadata and protocol responses.
- **Stores** incoming MCP messages before acknowledging receipt. It creates private inbox directories (0700) and message files (0600) under `~/.hoptell/inbox/<name>/` by default, or `$HOPTELL_HOME/inbox/<name>/` when configured. Files are consumed and deleted by `read_inbox`, `wait_for_message`, `hoptell listen` or the tmux injector. Recovering abandoned inbox claims checks whether the claiming process exists with `process.kill(pid, 0)`.
- **Inspects** up to five ancestor processes with `ps -o ppid=,args= -p <pid>` to detect Claude Code's channel flags. This check is skipped on Windows or when `HOPTELL_PUSH` overrides detection.
- **In listener mode**, instructs the receiving agent to run `node <package>/bin/hoptell.js listen <name>` as a background command when supported. That command polls and consumes the local inbox. Launching it remains subject to the receiving agent's permissions.
- **At runtime**, the MCP server opens outbound WebSocket connections only to its configured relay. It has no telemetry and does not change the agent's permission settings. Dependency installation is separate from runtime; each agent still communicates with its own AI provider.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limitations

- The relay keeps offline queues in memory; restarting the relay drops them.
- Delivery is at least once. "Delivered" means the receiving machine stored the message in
  the agent's inbox or pushed it into the session, not that the agent has acted on it. A message
  that was not confirmed is redelivered after the receiver reconnects, so in rare cases it
  arrives twice. A receiver gets at most 50 unconfirmed messages; more wait in its queue.
- Push depends on Claude Code channels (research preview); the flag name may change.
- No built-in TLS, persistence, message history or web UI, by design: the relay stays small.

## Roadmap

Ideas that fit the small-relay design, roughly in order:

- `hoptell doctor`: check settings source, relay reachability, identity, delivery mode, inbox and injector
- message expiry (TTL) and reply-to ids for request/response automation
- token revocation and reload without restarting the relay; optional per-member send rules
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
