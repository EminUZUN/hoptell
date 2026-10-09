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
| `hoptell mcp` | MCP server each agent session runs: tools `list_peers`, `send_message`, `wait_for_message`, `read_inbox`, `ack_messages`. |
| `hoptell tmux` | Runs a terminal agent in tmux and attempts to submit a fixed inbox notice when its prompt appears idle. |
| `hoptell send / list / wait / listen / ack` | CLI for scripts, CI jobs and agents without MCP. |

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

Requirements: Node.js 22+, plus tmux 3.2+ to wake Codex/terminal agents. Supported on macOS
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
`docker run -d -p 192.0.2.10:7777:7777 -v hoptell-state:/data -e HOPTELL_TOKEN=... ghcr.io/eminuzun/hoptell`.
Publish the port on that address only. Without a host address, `-p 7777:7777` publishes
on all host addresses by default. See [examples/](examples/). Health check: `GET /healthz`.

The relay keeps a small state directory (`~/.local/state/hoptell-relay` by default; set it
with `--state-dir` or `HOPTELL_STATE_DIR`). It holds the relay's realm id, a random id that
clients use to recognize this relay's name space, and no messages. Keep this directory when you
upgrade or move the relay: with a new realm id, clients that connected before refuse it until
their profile is reset. The Docker image keeps it in `/data`; use a named volume, as above, so
a replacement container keeps the same realm id.

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
hoptell mcp-http [--port 7790]            # the same over HTTP on 127.0.0.1 (see above)
hoptell mcp-http client add <label> [--name <peer>] [--roles a,b] | list | remove <label>
hoptell hook-header                       # the hook registration header for an HTTP client
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

**Receipts.** With a current relay, messages stay in the session's inbox until the agent
acknowledges them. `read_inbox` and `wait_for_message` return a batch with a receipt; the agent
passes it back as `ack` in its next call (or calls `ack_messages`) once it has handled the
messages. Reading again without acknowledging returns the same batch, and a batch that is not
acknowledged within 30 minutes (`HOPTELL_LEASE_MINUTES`) is shown again, marked as such. An
acknowledgement records that the agent accepted the messages; it does not make the agent's later
actions happen exactly once. For agents that cannot repeat a value reliably, set
`HOPTELL_RECEIPTS=off`: reading then removes messages, as before. A session's inbox holds at most
1,000 messages or 50 MB; beyond that, new messages wait at the relay until messages are
acknowledged.

## Several relays

One agent session can be on several relays at once, for example your team's relay and a relay
of your own. List them in a relays file, `~/.config/hoptell/relays.json` (or `HOPTELL_RELAYS`;
mode 0600):

```json
{
  "version": 1,
  "default": "work",
  "relays": [
    { "alias": "work", "url": "wss://relay.example.com", "auth": "login" },
    { "alias": "lab", "url": "wss://lab.example.org", "tokenFile": "~/.config/hoptell/lab.token" },
    { "alias": "ops", "url": "wss://ops.example.net", "tokenEnv": "HOPTELL_TOKEN_OPS", "join": false }
  ]
}
```

- Address peers as `name@alias` (also `@role@alias` and `@all@alias`). A bare name goes to the
  `default` relay only, never to whichever relay happens to know the name; without a default,
  bare names are refused. Nothing is ever forwarded from one relay to another.
- Messages show the relay they came through: `from "carol@lab"`. A reply (`reply_to`) must go
  through the relay its message came from; hoptell refuses a reply addressed to another relay and
  names the right address.
- `read_inbox` returns messages from every relay with one receipt; `list_peers` lists each relay
  with its peers and whether it is connected. With a relays file, reads always end with a receipt
  (also with `HOPTELL_RECEIPTS=off`): messages are removed only when it is acknowledged, so a read
  that is cancelled or lost never loses them.
- Tokens come from `tokenFile` (a private file) or `tokenEnv`, never from the relays file itself;
  `"auth": "login"` uses `hoptell login` for that relay. `"join": false` makes a relay send-only:
  this session does not go online there, it only sends when you address it.
- `name` in an entry sets the peer name on that relay; `namePrefix` (for example `"me-"`) puts a
  prefix before this session's name there, for relays whose member names must start with it. Changes to the file take effect when the
  session starts again. `hoptell doctor` checks the file.
- On the command line: `hoptell send bob@lab hi`, or `hoptell send --relay lab bob hi`;
  `hoptell list --relay lab`; `hoptell wait --relay lab`.

Without a relays file, hoptell works with one relay exactly as before.

## A private relay on your own machine

To connect only your own agent sessions on one computer, run a private relay as a user service:

```
hoptell local-relay install          # macOS LaunchAgent or Linux systemd user service, port 7788
hoptell local-relay status           # service, sign-in, port and paths; also shown by hoptell doctor
hoptell local-relay stop | start | uninstall [--purge]
```

It listens on 127.0.0.1 only and accepts one member token, kept in `~/.hoptell/local-relay/token`
and readable only by your account (other accounts on the machine can reach the port, not sign in).
Install adds it to your relays file (see [Several relays](#several-relays)) as relay `local`
(creating the file if needed, with your current relay kept as the default), so sessions reach your
own agents as `name@local`; uninstall removes that entry again unless you changed it (and removes
a relays file that install created once it would be empty). The service reads only its own
settings file, not your shared hoptell settings. After moving Node.js or hoptell (an upgrade to
another path), run `install` again; `status` warns about it. A rerun keeps the token and the port
(`--port` moves it, and the relays entry with it). If the token or the members file next to it is
lost, install stops instead of issuing a new token: restore the file, or start over with
`uninstall --purge`.

## MCP over HTTP on this machine

stdio stays the recommended setup. For MCP clients that only speak HTTP, hoptell can serve MCP
(Streamable HTTP) on this machine:

```
hoptell mcp-http client add editor --name alice-editor   # prints the client's token once
hoptell mcp-http [--port 7790]                           # serves http://127.0.0.1:7790/mcp
hoptell mcp-http client list | remove <label>
```

Configure the client with the URL and the header `Authorization: Bearer <token>`. Each client
session gets its own agent session, with the peer name and roles of the client entry (an entry
without a name gets an automatic one, never the server's own settings). Every read is held under
a receipt until it is acknowledged, so a response lost with its connection is shown again. The
server answers only on 127.0.0.1 and only to requests addressed to that host; requests from web
pages (any `Origin` header) are refused, and there are no CORS headers. Removing a client ends its
sessions. Limits: 4 sessions per client and 32 in all; per session 4 tool calls in progress (one
of them `wait_for_message`) and 2 standalone event streams.

Wake-ups: a client that negotiates the channel extension at initialize gets channel notices;
otherwise the agent reads with `read_inbox` or `wait_for_message`. For Claude Code hook notices, the client also sends
the header printed by `hoptell hook-header` (run it from the client's command for dynamic
headers); without it, an HTTP session has no hook notices.

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

### Running a relay behind a TLS proxy

hoptell has no built-in TLS. Put the relay behind a reverse proxy that terminates TLS and passes
WebSocket upgrades (`Upgrade` and `Connection` headers, HTTP/1.1 to the relay), with an idle
timeout of at least 60 seconds; the relay pings every 15 seconds. Clients then use
`HOPTELL_RELAY=wss://relay.example.com`.

- **Client addresses:** behind a proxy, the relay sees the proxy's address.
  `--trusted-proxies 10.0.0.5` or `HOPTELL_TRUSTED_PROXIES=10.0.0.5` configures
  trusted proxies; both accept a comma-separated list of IP addresses or CIDR ranges.
  For connections from those proxies, the relay reads `X-Forwarded-For` from right to
  left and logs `client via proxy`. Forwarded addresses are used only in logs.
  Restrict access to the relay's port to the configured proxies.
- **Logs:** `--log-format json` (or `HOPTELL_LOG_FORMAT=json`) writes one JSON object per line
  (`time`, `msg`). Control characters in logged values are replaced, so a value cannot add a log
  line.
- **Metrics:** `--metrics-port 9464` or `HOPTELL_METRICS_PORT=9464` enables
  `GET /metrics` in Prometheus text format on 127.0.0.1. Metrics include connected
  peers, queued messages and bytes, the oldest queued message's age, unconfirmed
  deliveries, and counters for logins, refused tokens, accepted sends, delivery
  attempts, expiries, rate limits, full queues and takeovers. They contain no peer
  names, message text or tokens. Set `HOPTELL_METRICS_HOST` to bind to another address;
  metrics reveal activity levels, so choose who can access them.
- **Checks:** `GET /healthz` returns 200 while the relay runs.
  `hoptell doctor --relay-check` sends a test message to a temporary receiver and
  reports the elapsed time for connection setup, delivery and acknowledgement.
- **Authentication mode:** relays report how names are authenticated, and `hoptell doctor` shows
  it: one shared token (names identify sessions, not people), per-member tokens only, or both
  (a warning: a shared-token holder can use any member's name).

### Signing in with your identity provider (OIDC)

Instead of handing out member tokens, a relay can accept sign-in with your organization's
identity provider (Keycloak, or any provider that issues access tokens for a custom resource).
The relay checks access tokens issued **for the relay**; a member is linked to an identity
deliberately, never created automatically. Member tokens keep working alongside.

1. **At the provider** (Keycloak shown): a client scope `hoptell` with an audience mapper that
   adds `hoptell-relay` to access tokens; a public client `hoptell-cli` (standard flow, PKCE
   S256, redirect URI `http://127.0.0.1/callback`, any port per RFC 8252; optionally the device
   grant) with that scope; for unattended agents, a confidential client with a service account
   (`build-bot`). For opaque tokens or immediate revocation, also a confidential client for the
   relay's introspection. [test/keycloak/realm.json](test/keycloak/realm.json) is a complete
   test realm.
2. **At the relay**: a sign-in file (mode 0600), for example
   [examples/oidc.example.json](examples/oidc.example.json), passed with `--oidc <file>` or
   `HOPTELL_OIDC`. `validation` is `jwt` (checked with the provider's keys) or `introspection`
   (every token is checked with the provider; `introspection: {clientId, clientSecretFile}`).
   `profile` is `rfc9068` for providers issuing RFC 9068 access tokens, or `claims` with
   `requiredClaims` that only access tokens carry (Keycloak: `{"typ": "Bearer"}`). The relay
   publishes the issuer and the CLI client at `/.well-known/hoptell` (no secrets).
3. **Link identities** to members: `hoptell members link alice --issuer <issuer> --subject <sub>`
   (the provider's `sub` for that user or service account), then reload the relay (`kill -HUP`
   or a restart).
4. **On each machine**: `hoptell login` opens the browser (`--device` prints a code for another
   device; `--client-credentials --client-id <id> --client-secret-file <file>` for a service
   account), then set `HOPTELL_AUTH=login`. The credential is kept in the OS keychain (macOS
   Keychain, Linux Secret Service), or with `--store file` in a file encrypted with
   `HOPTELL_CREDENTIAL_PASSPHRASE`. `hoptell logout` removes it and revokes it at the provider.

Access tokens are renewed on the live connection before they expire; the relay closes a
connection whose token expired. A JWT stays valid at the relay until it expires, so logout or
removing an account takes effect within the token lifetime (`maxTokenLifetimeSeconds` bounds
it); with introspection, within `maxRevocationDelaySeconds`. `hoptell doctor` shows the sign-in
and checks it.

#### Broker mode: providers that only sign users in

Some providers issue ID tokens for a client but no access tokens for a resource like the relay.
In broker mode the relay is itself a client of the provider: you sign in there in the browser,
the relay checks the ID token, and it issues its own credential to `hoptell login`. Browser
sign-in only; devices and service accounts use member tokens or resource mode.

1. **At the provider**: a confidential client for the relay (client secret or a private key for
   `private_key_jwt`), redirect URI `<publicBaseUrl>/oidc/<id>/callback`, scope `openid`.
2. **At the relay**: an issuer entry with `"mode": "broker"` in the sign-in file:
   `id` (it names the relay's endpoints `/oidc/<id>/...`), `publicBaseUrl` (the relay's public
   https origin, as the operator configures it; never taken from request headers), `client`
   (`clientId` and `clientSecretFile` or `privateKeyFile`), and optionally `scopes`,
   `reverifyAfterSeconds` (a fresh browser sign-in is due after this, default one day),
   `familyIdleSeconds` (30 days), `familyMaxSeconds` (90 days), `accessTokenSeconds` (900) and
   `requireReauthentication`. See [examples/oidc.example.json](examples/oidc.example.json).
   The relay keeps its sign-ins in `<state dir>/broker/` (one relay process per state directory).
3. **Link identities** as above. A user whose identity is not linked sees the issuer and
   subject to give the administrator. Broker and resource subjects can differ for one person.
4. **On each machine**: `hoptell login` (with `--mode broker` when the relay offers the same
   provider in both modes), then `HOPTELL_AUTH=login`.

A refresh token is used once: the relay detects a copied, already used token and ends that
sign-in everywhere. When a renewal's answer is lost, the old token is never sent again, and
`hoptell login` is needed. `hoptell members signout <name>` (then a reload) ends a member's
broker sign-ins made until now; removing or unlinking the member does too. If the relay's
`broker/refresh.key` is lost or damaged, broker sign-in stays off until
`hoptell relay broker-reset --yes` (with the relay stopped) creates a new key and ends every
broker sign-in.

## Teams and swarms

**Names.** Each agent has a peer name: letters, digits, `_` and `-`. Set it with
`HOPTELL_NAME`, or leave it unset and the relay assigns one: `<member>-<host>-<n>` with a
member token, `<host>-<n>` with the shared token. `list_peers` shows the name in use.

A session holds its name with a lease. While it is online, another connection cannot take
the name: a second agent session with the same name waits until the name is free, and
`hoptell wait` stops with an error (`--wait-for-name` waits instead, and `--replace` takes the
name over once, for the same member). When a session's connection drops, the name is reserved
for 30 seconds so the session can come back. During that time other members cannot take it,
but the same member can, for example a restarted session. All shared-token sessions count as
one member here. A session that exits cleanly frees the name immediately.

Relays from earlier versions do not lease names: a new connection using a name replaces the
old one. For names up to 58 characters, the replaced MCP session waits until the name is free,
then reconnects. Set `HOPTELL_PROTOCOL=1` to keep this behavior with a current relay.

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

On the relay host, `hoptell members add alice` (with `HOPTELL_MEMBERS` or `--members <file>`)
adds a member with a generated id and token. It shows the token once and stores only its
SHA-256. `hoptell members list` shows members without tokens, and `hoptell members revoke alice`
removes one. A member's id identifies it to the relay even if its name changes. Members
without an id, as in the example, are identified by name; `hoptell members migrate` reports
them and, with `--yes`, gives them ids. Reloading the relay then closes their connections;
restart those sessions so they connect under the new ids. Messages queued for their names under
the old identity are dropped when the new identities take the names.

Run `hoptell relay --members members.json` or set `HOPTELL_MEMBERS`. A member may only use
the name `<member>` or names starting with `<member>-` (`alice-claude`, `alice-codex-2`).
The relay refuses member names that overlap, such as `alice` and `alice-bob`.
You can combine a members file with a shared `HOPTELL_TOKEN`; token holders can use any name.
`--require-members` (or `HOPTELL_REQUIRE_MEMBERS=1`) makes the relay refuse a shared token.

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

## Who may reach your sessions (contacts)

You decide who may reach the agent sessions of your machine. In a new install, messages from
senders you have not allowed are held back: the agent sees only "N messages from M senders are
waiting for your user's decision", never who sent them or what they say, and a desktop
notification points you to the command:

```
hoptell contacts                          # what is waiting, and your policy
hoptell contacts show <id> [--text]       # the sender, how the relay authenticated it, the sessions;
                                          #   --text shows the held messages (untrusted peer text)
hoptell contacts allow <id> --rev N --policy-rev P        # always allow this sender (a grant)
hoptell contacts allow-once <id> --rev N --policy-rev P   # release only these messages
hoptell contacts block <id> --rev N --policy-rev P        # delete them and block the sender
hoptell contacts grants | blocks | revoke <id> | unblock <id> | check ...
```

`show` prints the exact `--rev` and `--policy-rev` to use, so a decision never applies to messages
or a policy that changed after you looked. `--session <realm>/<name>` narrows a decision to one of
your sessions. Grants name the sender as the relay authenticated it: a member (by its member id,
which survives renames) or, for a shared token, the exact sender name (any shared-token holder can
use any name). Senders on relays that do not authenticate them can be released once or blocked,
not granted. A peer's message never approves anything, and no hoptell tool an agent can call does;
an agent running as your OS user could still run these commands itself, so keep that in mind
when you let agents use a shell.

The policy is `~/.hoptell/contacts.json` (per hoptell home; JSON Schema in
[schema/contacts.schema.json](schema/contacts.schema.json)). Held messages are kept for seven days,
at most 50 messages or 1 MB per sender and 500 messages or 10 MB in all; beyond that, new messages
from unknown senders are dropped (their delivery is still confirmed to the relay). **Existing
installs** keep today's behavior (every sender reaches your sessions) until you run
`hoptell contacts init`; `hoptell doctor` reminds you. After `init`, nobody is granted, and
messages already waiting in your sessions are held back on their next read. Every process that
receives messages for this home must run this version or later. `HOPTELL_NOTIFY=off` turns the
desktop notifications off.

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
hoptell relay --host <ip> [--port 7777] [--members file.json] [--state-dir <dir>] [--require-members] [--oidc <file>]
hoptell members list|add <name>|revoke <name>|migrate [--yes]   # on the relay host
hoptell members link|unlink <name> --issuer <url> --subject <sub>   # an identity-provider sign-in for a member
hoptell login [--device | --client-credentials --client-id <id> --client-secret-file <file>] [--store file]
hoptell logout                        # removes the stored sign-in and revokes it at the provider
hoptell mcp
hoptell tmux <name> [--roles a,b] -- <agent command...>
hoptell list
hoptell send [--relay <alias>] [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>
                                      # to: name, @role or @all; sends as $HOPTELL_NAME without going online
                                      # --ttl: request relay queue expiry; older relays ignore it
                                      # --reply-to: the "Message reference" you are answering
hoptell wait [--wait-for-name | --replace] [seconds]
                                      # goes online as $HOPTELL_NAME and prints the next message
hoptell listen [--no-ack] <name> [seconds]   # waits on <name>'s local inbox (no relay connection)
hoptell listen [--no-ack] --session <folder> [seconds]  # the same, for the folder an agent session names
                                      # prints the messages, then acknowledges them; --no-ack prints a receipt instead
hoptell ack <receipt> (<name> | --session <folder>)     # acknowledges messages printed with --no-ack
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
| `HOPTELL_RELAYS` | peers | relays file for several relays (default `~/.config/hoptell/relays.json` when it exists) |
| `HOPTELL_TOKEN` | both | shared secret, or a member's own token |
| `HOPTELL_AUTH` | peers | `login`: sign in with `hoptell login` instead of a token; default `token` |
| `HOPTELL_CREDENTIAL_STORE` | peers | `file`: keep the sign-in credential in an encrypted file instead of the OS keychain |
| `HOPTELL_CREDENTIAL_PASSPHRASE` | peers | passphrase for that file (at least 12 characters) |
| `HOPTELL_NAME` | peers | this agent's peer name; unset lets the relay assign one |
| `HOPTELL_ROLES` | peers | comma-separated roles |
| `HOPTELL_PUSH` | peers | `channel`, `hook`, `tmux` or `listener`; unset picks one per session |
| `HOPTELL_HOME` | peers | local state directory (default `~/.hoptell`) |
| `HOPTELL_PROTOCOL` | peers | `1` keeps the earlier relay protocol (no name leases); default `2`, which falls back to `1` with earlier relays |
| `HOPTELL_PROFILE` | peers | name of the local relay profile (default: derived from the relay URL) |
| `HOPTELL_RECEIPTS` | peers | `on` (default): messages stay until acknowledged; `off`: reading removes them |
| `HOPTELL_NOTIFY` | peers | `off` disables desktop notifications about senders waiting for your decision |
| `HOPTELL_LEASE_MINUTES` | peers | how long a batch waits for its acknowledgement before it is shown again (default 30, 1–1440) |
| `HOPTELL_HOST`, `HOPTELL_PORT` | relay | listen address (required) and port (default 7777) |
| `HOPTELL_MEMBERS` | relay | members file with per-member tokens |
| `HOPTELL_STATE_DIR` | relay | state directory with the realm id (default `~/.local/state/hoptell-relay`) |
| `HOPTELL_REALM_NAME` | relay | optional display name for the realm, shown to clients |
| `HOPTELL_REQUIRE_MEMBERS` | relay | `1` refuses a shared token |
| `HOPTELL_OIDC` | relay | sign-in file naming the identity providers the relay accepts |
| `HOPTELL_SNAPSHOT_ROOTS` | peers | JSON list of approved folders for the file tools, e.g. `[{"id":"app","path":"/abs/app"}]`; off when unset |
| `HOPTELL_LOG_FINGERPRINTS` | relay | `on` enables keyed message-text fingerprints in relay logs; default `off` |
| `HOPTELL_LOG_FINGERPRINT_KEY_FILE` | relay | absolute path to a private key JSON file, required when fingerprint logging is enabled |
| `HOPTELL_TRUSTED_PROXIES` | relay | proxy addresses or CIDR ranges whose `X-Forwarded-For` is used in logs |
| `HOPTELL_LOG_FORMAT` | relay | `text` (default) or `json` |
| `HOPTELL_METRICS_PORT`, `HOPTELL_METRICS_HOST` | relay | serve `/metrics` on this port; host defaults to 127.0.0.1 |

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
- **Stores** incoming MCP messages durably (synced to disk) before acknowledging receipt to the relay. It creates private directories (0700) and files (0600): with a current relay in the session's folder under `~/.hoptell/v2/` (see [PRIVACY.md](PRIVACY.md)), with earlier relays under `~/.hoptell/inbox/<name>/` (both under `$HOPTELL_HOME` when configured). With receipts, files are deleted when the agent acknowledges them; otherwise they are consumed and deleted by `read_inbox`, `wait_for_message` or `hoptell listen`. Recovering abandoned claims checks whether the claiming process still runs (process id, start time and boot).
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

- The relay keeps offline queues and name leases in memory; restarting the relay drops them.
- Delivery is at least once. "Delivered" means the receiving machine stored the message in
  the agent's inbox or pushed it into the session, not that the agent has acted on it. A message
  that was not confirmed is redelivered after the receiver reconnects, so in rare cases it
  arrives twice. Agent sessions on a current relay usually store such a repeat only once: they
  recognize messages still stored, and remember up to 10,000 delivery ids for at most eight days.
  When a send's reply is lost, a current client resends it to the same relay instance with the same
  operation id, and the relay delivers it once; otherwise the result is reported as uncertain. A receiver gets at most 50 unconfirmed messages; more wait in its queue.
- Channel delivery depends on Claude Code channels (research preview); the flag name may change.
- Hook delivery depends on Claude Code's `FileChanged` hook and `asyncRewake` option. It was
  tested with the Claude Code terminal app; the VS Code extension and Desktop app are untested.
  One hoptell MCP server per Claude Code process can use it; a second one uses the listener.
- No built-in TLS, persistence, message history or web UI, by design: the relay stays small.
- The file tools (`send_file`, `verify_snapshot`) need macOS or Linux. Windows peers can still
  receive and review snapshots.

## Tested clients

Results observed on 2026-10-08; behavior depends on the client build and configuration.

| Client | Delivery methods | MCP questions to the person (elicitation) |
|---|---|---|
| Claude Code 2.1.294 (terminal) | channel, hook, tmux; listener | shown, also outside a tool call |
| Codex CLI 0.161.0 | tmux; listener | shown with `approval_policy = "on-request"` or `granular.mcp_elicitations = true`; declined automatically with `approval_policy = "never"` |
| Antigravity 1.3.1 | tmux; listener | cancelled automatically |

A listener must be started by the client and does not, by itself, wake an idle
session. Elicitation results come from separate probe servers; hoptell does not
yet request access approvals through elicitation.

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

`npm run test:oidc` is an opt-in test of sign-in against a real Keycloak in a throwaway Docker
container (pinned image, the test realm above): browser, device and service-account sign-in,
renewal on a live connection, and revocation with introspection. It takes about three minutes.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [Apache License 2.0](LICENSE).
