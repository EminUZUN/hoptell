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
   (the provider's `sub` for that user or service account). The command reloads a running
   relay itself (see "Members").
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

### Hosted MCP endpoints (experimental)

**The host can read every message its tenants send and receive.** Hosted mode lets a relay
operator serve MCP endpoints for people whose clients cannot run hoptell locally (for example
custom connectors that connect from a vendor's cloud). It is not end-to-end encrypted, and it is
experimental: `hoptell mcp-hosted --experimental`.

- **Custody.** A hosted member is its own member id with `custody: "hosted"` and a host in the
  relay's members file (`hoptell members host add <id>`, then `hoptell members add-hosted <name>
  --host <id>`). It has no token and no devices; only its host signs in for it, with the host's
  own token. Custody never changes: moving a person to or from hosted custody means a new member.
  Peers see hosted members labeled in `list_peers`, and their messages carry that label.
- **Senders.** A contact whose encryption is `required` is never sent to a hosted member. Under
  `preferred`, a send needs `"custody": "allow-hosted"` on that contact's encryption entry in
  contacts.json, and then goes as plaintext. An encrypted `@role` or `@all` never sends a hosted
  member a copy: it is left out and counted as not encrypted (unavailable under `required`), also
  with `allow-hosted`; a hosted name in a list of names is refused. A plaintext `@role` or `@all`
  under an encryption policy leaves hosted members out. To reach one, send to it by name.
  Recipients can treat hosted senders as a class with
  `"hosted": "ask" | "block" | "allow"` (`ask` by default: a grant for that member is needed).
- **The fence.** While the relay's access policy has a group with provider groups
  (`oidcGroups`), hosted custody is fenced: hosted connections are refused, messages to or from
  hosted members are held, and hosted members look unknown to everyone else. The policy itself
  applies as always. `hoptell relay admin status` shows the fence and the held count.
- **The endpoint** runs behind the operator's HTTPS proxy. It takes OAuth access tokens issued
  for it (scope `hoptell.mcp`), links each `(issuer, subject)` to one hosted member
  (`hoptell mcp-hosted --experimental link`), and offers `send_message`, `read_inbox`,
  `wait_for_message`, `ack_messages` and `list_peers`. Owners decide held contacts at
  `https://<host>/owner`; grants and contact requests are shown only there. Owner sign-ins are
  kept in memory: restarting the endpoint signs owners out.
- **Limits** (sessions, rates, stored messages and bytes, the disk floors, live engines) and
  retention (messages are deleted 7 days after arrival, read or not; the data of a member that
  is unlinked, or that the relay confirms it no longer holds, is deleted within 24 hours) use placeholder values; they are configurable and still open for
  the owner to decide.

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

**Roles under an encryption policy (experimental).** When encrypted sending is available
(`HOPTELL_EXPERIMENTAL_E2EE=1` and an enrolled device) and the realm has a non-off encryption
policy (`hoptell contacts encryption`), `@role` and `@all` are sent encrypted, one copy per
recipient session, and only to members whose devices you have already pinned (a new member
needs a first direct message). They never send plaintext: a session whose contact is set to
`off`, or that cannot receive encrypted messages, is left out and counted in the result. To
reach those sessions in plaintext, send to each one by name. When encrypted sending is not
available and the policy is only `preferred`, `@role` and `@all` go as plaintext, and the result
says they were not encrypted. `hoptell send @role` and `hoptell send @all` are refused when the
realm has any non-off encryption policy. A contact whose encryption is `required` never gets
plaintext, including from `hoptell send` or when `HOPTELL_EXPERIMENTAL_E2EE` is unset.

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

The `members` commands record each change in the relay's audit log. Run them on the relay host,
with the relay's state directory (`--state-dir` or `HOPTELL_STATE_DIR`, as for the relay). If
the relay is running, the command reloads it through its admin socket in the state directory,
then reports the result. If the relay is stopped, the relay applies the change when it starts.
`hoptell relay admin audit` shows the log, and `hoptell relay admin help` lists the relay
owner's other commands.

Run `hoptell relay --members members.json` or set `HOPTELL_MEMBERS`. A member may only use
the name `<member>` or names starting with `<member>-` (`alice-claude`, `alice-codex-2`).
The relay refuses member names that overlap, such as `alice` and `alice-bob`.
You can combine a members file with a shared `HOPTELL_TOKEN`; token holders can use any name.
`--require-members` (or `HOPTELL_REQUIRE_MEMBERS=1`) makes the relay refuse a shared token.

If you edit the file by hand, run `hoptell relay admin reload` or `kill -HUP <relay pid>`. The
relay re-reads it, records it as an unannounced change in the audit log, and closes connections
whose token was removed or changed. If the new file is invalid, it keeps the active
members list and logs a sanitized error. An empty list (`{"members": []}`) removes every member. The shared token is not
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

### Deciding in a browser: hoptell ui

`hoptell ui` serves the same decisions as pages on `127.0.0.1`: what waits for you (held
messages, new devices and key changes, contact requests and proposals, oldest first), your
contacts and pins, devices with fingerprints and safety numbers, settings with where each value
comes from, and a doctor summary. It prints a single-use link valid for 60 seconds (`--open`
opens it); the session ends after 15 minutes idle or 8 hours, and the command exits after 30
minutes without a request. Pages have no JavaScript. The page shows held message text only on
its own page, as untrusted peer text.

Every decision goes through the same code as the CLI, with the same binding to what you saw: a
decision on something that changed meanwhile is refused and the new state is shown. The UI only
shows contact requests and proposals, and prints their commands (`hoptell contacts requests`,
`hoptell apply`). Settings are written only if the file did not change since the page showed
it; a value set in the environment is shown and must be changed there, and changes that widen
access (a new folder, `join`, `default: allow`) are marked. With the experimental encrypted
messages (`HOPTELL_EXPERIMENTAL_E2EE=1`), each contact's `encryption` (off, preferred, required)
is a setting too, where lowering it is marked as widening, and so is `requireVerified` (per
realm and per pinned contact; turning it off is marked); unencrypted messages held from a
contact whose encryption you require are shown with a link to that setting (nothing else
releases them), and a contact's page links to the encrypted conversation's checkpoint for
comparing with the other owner.

The views that need the relay (contact requests, device lists, the encrypted conversation's
checkpoint) reach it only through `HOPTELL_RELAY` (and `HOPTELL_PROFILE`) for now, not through
a relays file; without it they say that the relay is not available.

Other users of the machine can reach the port: the launch link and the session cookie keep them
out. An agent running as your OS user can open the UI as well as run the CLI; the UI protects
against peers, stale pages and accidents, not against such an agent.

### Asking in the agent client (optional)

With `HOPTELL_ELICITATION=read_inbox`, a `read_inbox` call may first ask you through the client's
own question dialog about one sender whose messages are held: who it is (as the relay
authenticated it), how many messages, for which sessions, never the text. The answers are
`allow-once` (release exactly those messages) and `later`; lasting decisions (allow, block) and
device keys stay with the CLI and `hoptell ui`. A decline, a cancel, no answer within 60 seconds or
any other answer leaves the messages waiting and does not ask about that sender again for 30
minutes. It is off by default.

It asks only in sessions on MCP revision 2025-06-18 or 2025-11-25 whose client declares form
questions; with the 2026-07-28 revision or an unknown one it never asks. The answer comes from
the client, not from the agent's tool calls, but a client can answer automatically (Claude Code's
`Elicitation` hook can; Codex with `approval_policy = "never"` declines at once), so an answer
does not prove that a person answered. See [Tested clients](#tested-clients).

### Who may reach you through the relay (grants and the relay's policy)

Your machine's contacts decide what reaches your sessions. On a relay with member credentials, two
more checks happen before a message leaves the relay, and each can only refuse:

- **The relay's policy** (`hoptell relay --policy policy.json` or `HOPTELL_POLICY`), set by the
  relay's operator: groups of members (by member id, or by the identity provider's groups for
  signed-in members) and allow or deny rules between them. `hoptell relay admin reload` (or
  `kill -HUP <relay pid>`) reloads it and records the change in the audit log; a file with a
  mistake keeps the active policy.

```json
{ "v": 1,
  "groups": { "reviewers": { "members": ["m_..."], "oidcGroups": [{ "issuer": "https://idp.example", "group": "reviewers" }] } },
  "rules": [{ "from": "group:reviewers", "to": "*", "action": "allow" }],
  "defaultAction": "deny" }
```
- **Your grants**, published by you for your member:

```
hoptell grants                                   # your grants and their revision
hoptell grants allow member:<id> [--until <s>]   # also group:<name> or *; --until for a while
hoptell grants deny member:<id> | remove <selector>
hoptell grants deny-forever member:<id>          # deny, and no contact requests from it
hoptell grants default allow|deny                # for senders no entry names
hoptell grants visible all|grantees              # grantees: others do not see you in lists
```

Each `grants` command shows the result and the current revision first, and publishes nothing.
Run the same command again with `--yes --rev N` (the revision it showed) to publish it. If your
grants changed in the meantime (another session or machine), it refuses and you look again. An
`--until` given in seconds counts from the moment you publish.
A member entry wins over a group entry, a group entry over `*`, and on a tie deny wins. Expiry is
checked whenever a message is delivered, also for messages already waiting.

A sender your grants or the policy refuse gets the same answer as for a name that does not exist,
and broadcasts report only how many sessions they reached.

**Replies.** If you send a message to someone your grants refuse by default, they may reply to it
once within seven days, but only after your message passed the relay's policy and their machine's
contacts released it to a session. The reply still needs the relay's policy. An entry in your
grants that denies them (for the member or a group it is in) cancels it, and so does expiry.

**Contact requests.** A member the relay's policy allows, but your grants refuse, can ask to reach
you with a fixed reason and no text: `hoptell contacts request <name> --reason
collaborate|review|handoff|other`. The sender gets the same answer whether or not you exist, accept
requests or have blocked them. You see requests with `hoptell contacts requests`; `accept`,
`deny` and `deny-forever` act at once, without a preview. Accepting adds that member to your grants;
your machine's contacts still decide what reaches your sessions.

Hiding yourself (`visible grantees`) needs a relay without a shared token. A relay that requires
grants (`"requireGrants": true` in the policy) or has hidden members refuses older clients that
cannot be filtered (protocol 1). Each sender can have at most 1,000 messages or 20 MiB waiting at
the relay across all recipients. Without a policy and without published grants, delivery does
not change; the relay still records sign-ins (below), so a policy added later can use them.

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

### Review sets and owner-run apply

With approved folders, agents also get `send_review_set` and `verify_review_set`, for
several files at once:

- `send_review_set` takes `to` (one peer), `files` (`[{"root": "app", "path": "src/a.js"}, ...]`),
  a `request` and optionally `git: true`. Each file is read once through the same guarded reader;
  a file listed twice, or reachable twice through overlapping folders or a case alias, is refused,
  and so is any file inside a `.git` folder (in any letter case).
  At most 50 files and 512 KB in all, and the whole message must fit the relay's message limit
  (100,000 characters today); a set over a limit is refused with the sizes, never cut. The peer
  gets one message: `{hoptell_review_set: 1, review_set_id, manifest, contents}`. Files are
  ordered by folder id, then path, and `bundle_digest` is the SHA-256 of the RFC 8785
  canonical JSON of `manifest.files`. With `git: true` the manifest also says, per file, whether
  the capture `matches-head`, `differs-from-head` or is `untracked`; that is provenance only:
  the captured bytes are the base for everything later.
- The reviewer's hoptell checks every file against its SHA-256 and prints the `bundle_digest`
  under the message. A reviewer answers with one message whose whole text is a proposal:
  `{hoptell_proposal: 1, proposal_id, review_set_id, based_on: <bundle_digest>, changes:
  [{file_id, base_sha256, kind: "replace", text} | {file_id, base_sha256, kind: "patch",
  unified_diff}]}`. File ids only: no paths, no commands, no new files.
- The relay tells the sender who it delivers a direct send to (a member, or a name used with the
  shared token), and the set records that. A proposal is checked before it is stored: it must
  come from that recipient (same realm and name; for a member, that member and never a
  shared-token sender using its name), name a set that has not expired, match its
  `bundle_digest`, and name each file at most once with its recorded SHA-256. Anything else is
  dropped with a fixed note. At most 20 proposals per set, 1 MB each and 50 MB in all are kept;
  the same `proposal_id` again is stored once, and with a different payload it is refused. The
  agent only sees that a proposal for the set is waiting for you, never its content; this also
  holds for `hoptell wait` and for a sender your contacts hold back (only the note waits there).
- An older relay confirms a send without naming the recipient. The set then records that, and the
  check is weaker: a proposal is accepted from **any** authenticated sender with the recorded
  name in the same realm, not from one bound member. `send_review_set` says so in its
  `recipient` field, and `hoptell apply` shows it in the preview. Until the relay's confirmation
  is saved, no proposal matches the set: a proposal that arrives first, or answers a set whose
  confirmation was not saved or named the recipient in an unexpected form, is dropped. It is
  never accepted on the realm and name alone. If saving failed in a way that leaves the outcome
  unclear, `send_review_set` says so and names both possibilities: only the named recipient can
  answer, or nobody can.
- `verify_review_set` reports `match`, `changed` (with the files), `expired` or `unknown`.

Only you apply a proposal, from a terminal; no MCP tool does:

```sh
hoptell apply                          # proposals waiting for you
hoptell apply <proposal id> --preview  # what it changes; writes nothing
hoptell apply <proposal id>            # the same, then asks; --yes skips the question
hoptell apply --recover [--finish | --roll-back]   # after an interrupted apply
```

The changes are applied to the captured bytes in a private temporary folder (never your
repository), so edits you had made before the capture are kept. Patches must change exactly the
recorded file (no absolute paths, `..`, `.git`, symbolic links, submodules, mode changes or binary
content) and go through `git apply` with no configuration, hooks, filters or pager; Git 2.39.2 or
later (or a fixed release of an older series) is required. The preview is hoptell's own diff of
each current file against the result. Before writing, every file is checked again: still inside
its folder with no symbolic link on the way, the same file as captured, and still the captured
bytes; any change refuses the whole apply. Files inside a `.git` folder are never written,
whatever the change's kind. A recovery journal (`~/.hoptell/apply/<id>/`) is written and synced
first. Each file is then replaced atomically by a new file renamed over it: the new file gets the
old one's permission bits, but it is a new inode, so ACLs, extended attributes (xattrs) and
other hard links to the old file are not carried over. A multi-file apply is not atomic while it
runs. After an interruption, `hoptell apply --recover` brings every file to its old or its new
content, and stops for any file that someone changed since (that file is never overwritten; the
journal keeps both versions). Once the complete journal state is saved, the apply is committed (an
interruption before that can still be rolled back): from then on
recovery only marks the proposal applied and removes the journal, and `--roll-back` is refused
("already committed"). Recovery removes a leftover temporary file only if it is the exact file
the journal recorded; any other file is left in place and listed for you to check. `hoptell
doctor` reports an unfinished journal. A program that edits a file in the instant between the
last check and the rename can lose that edit; that race is outside these checks. Nothing is run
because a proposal asks.

Review set records (with the captured files) are kept for 7 days, or until every proposal for
the set is applied or expired, whichever is later.

### Encrypted messages: your devices and verification (experimental)

With `HOPTELL_EXPERIMENTAL_E2EE=1` and a relay started with `--experimental-e2ee`, each hoptell
home has one MLS device per relay realm. Encrypted messaging is experimental and not
independently reviewed.

- **Enroll.** `hoptell device enroll` needs managed contacts (`hoptell contacts init`): the
  new device is recorded there as this home's own device before the relay hears of it. A home
  holds one device per realm; enrolling a second relay profile in a realm the home already has is
  refused. `hoptell device retire` gives up this profile's device (it may still read, never
  send). Retiring the profile that holds this home's own device in the realm keeps that record,
  marked retired: any later enrollment in that realm, from any profile, is refused until you run
  `hoptell device enroll --new-baseline`. Retiring a duplicate profile (a second one in the same
  realm) leaves the other profile's device as it is.
- **Your other devices** are trusted only when you accept them, never because the relay lists
  them. On an existing device, run `hoptell device accept <device>`, compare its fingerprint with
  `hoptell device status` on the new device, and run the printed `--set <code>` command. Once the
  new device registers, repeat those steps on it to accept the existing device, comparing against
  that device's status.
- **A new device needs your approval at the relay.** While you have a registered device in a realm
  that remains unrevoked, the relay registers another only after approval from an active device of
  yours or the relay admin. `hoptell device enroll` on the new device asks the relay, prints its
  fingerprint and waits ("waiting for approval from one of your devices: run hoptell device accept
  <device> there"). On an existing device, run `hoptell device accept <device>` and compare the
  fingerprint with the new device. It prints a command containing `--set <code>`; run that command
  to accept the device and send its signed approval. If the approval cannot be sent at once, it is
  kept and sent again whenever that device connects. `hoptell device enroll` waits for up to 15
  minutes per run, while the relay keeps the request for up to 24 hours. If the command stops
  before the approval arrives, run it again on the new device. If the request expires, enroll and
  accept again (a different key for an accepted device is refused as a key change). `hoptell
  device pending` lists the requests waiting for your devices and `hoptell device pending --cancel
  <device>` cancels one; the same device and key must then wait 24 hours before requesting again.
  Someone with only your member token can occupy the four regular pending-request slots, but
  cannot register an additional device while one of yours remains unrevoked. If the slots are
  full, first try `hoptell device enroll` on the new device; this creates its device id and key
  even if the request is refused. Run `hoptell device status` there to get the id and the value
  labeled `Pin identity` (a 64-character hexadecimal identifier for that device and key). On an
  active existing device, run `hoptell device expect <device> <pin identity>`, then retry
  enrollment on the new device. This reserves an extra request slot; you must still approve the
  request. When none of your devices can approve (all suspended after a relay restore, or all
  lost), the relay admin approves the request with `hoptell members device-approve <member>
  <device> <fingerprint>` (audited). If a member has no registered device that remains unrevoked,
  a new device can register without approval. A member token can register a device in that case.
  It can send and read plaintext messages for the member regardless of device registration.
- **Review your devices.** `hoptell device list` shows your accepted devices, devices the relay
  lists that you have not accepted, and devices no longer listed. A conversation that holds a
  device of yours you have not accepted stops (nothing is sent or committed there) until you
  accept it or revoke it. `hoptell device enroll --new-baseline` starts again with a new device
  id, on your explicit confirmation: after you retired this home's device in the realm, when
  every device of yours is lost, or when this device's record cannot be read. The replaced record
  is kept for review, and your contacts see the new device as a new device of yours.
- **Verify a contact** with `hoptell contacts verify <member id>`: it shows your devices and
  theirs, each with its fingerprint and state, and the safety number to compare in person or over
  a channel you trust. Your half of the number comes from the devices you accepted, never from
  the relay's list. Verify refuses while the relay lists a device of yours you have not accepted,
  and it does not pin while one of the contact's pinned devices is no longer listed.
- **A device the relay stops listing** is not removed: messages to that contact wait until it is
  listed again, a revocation signed by another of their devices arrives, or you run
  `hoptell contacts forget-device <member id> <device>`. A message that reached no device of the
  contact is reported as not delivered.
- **Limit (first use).** A contact you have not verified is trusted on first use: hoptell takes
  the relay's list of their devices at the first encrypted message. A relay can add a device
  there. Verifying the contact, or setting `requireVerified`, closes this for later messages.
- Only the post-quantum MLS suite 0x004D is used; a binding without it is refused. Each
  conversation sends an update at least every 7 days of activity and after a member is removed;
  `hoptell doctor` lists members whose last update is older than 30 days. A planned key rotation
  (`hoptell device rotate`) needs a device without encrypted conversations, and device-signed
  rotation and revocation need an MLS binding that can sign (otherwise they refuse before
  changing anything; the relay owner can still revoke a device with
  `hoptell members device-revoke`).
- **Proof of the device key.** A connection acts for a device (receives its messages, publishes
  its KeyPackages, transfers) only after it signs a fresh relay challenge with that device's key;
  a member token alone is not enough. An older hoptell cannot attach to such a relay and needs an
  update. Commands such as `hoptell device replenish` prove the device on their own connection
  and receive none of its messages. A rotation is saved before the relay hears of it and is
  retried at the next start if it was interrupted or the relay refused it.
- **Expired KeyPackages.** With an MLS binding that can prune, the private keys of KeyPackages
  that expired unused are deleted after a one-day grace period, within six hours while the engine
  runs (it checks at start, at attach, when publishing, and every 6 hours, also while the relay
  refuses the device). A device that is not running keeps them until its next
  start, and older backups still hold them. `hoptell doctor` says when the binding cannot prune.

### Larger file transfers (experimental)

With the experimental encrypted messages (`HOPTELL_EXPERIMENTAL_E2EE=1` and an enrolled device),
a relay started with `--experimental-e2ee`, and approved folders, agents also get
`send_transfer`: one file of any content, up to 200 MiB, to one peer.

- The file is read once through the guarded reader into a private outbox
  (`~/.hoptell/outgoing/`), encrypted there in 256 KiB chunks (AES-256-GCM, a new key for each
  transfer) and uploaded as ciphertext. Retries and resumes send the stored ciphertext again;
  nothing is encrypted twice. The key travels only inside the encrypted message that announces
  the file.
- The relay keeps the encrypted chunks for 7 days after the upload is sealed (an upload not
  finished within 24 hours expires). It serves them only to the recipient's devices that were in
  the conversation when the message was accepted, and only while the relay's access rules still
  let the sender reach the recipient, as the sender is signed in now (a changed identity-provider
  group or a sign-out stops it). The sender can withdraw the file earlier.
- The recipient's agent only sees `a file transfer from X (N bytes, label "...") is waiting for
  your user`. hoptell fetches it only if you allowed transfers from that contact in
  `contacts.json` (the default is not allowed):

  ```json
  "transfers": {
    "contacts": [{ "realm": "<realm id>", "member": "<member id>", "allowed": true, "maxBytes": 104857600 }],
    "stagedBytes": 2147483648, "stagedFiles": 20, "concurrent": 2
  }
  ```

  The size comes from the encrypted, authenticated header and is checked before anything is
  fetched, and so are this home's limits (by default 2 GiB and 20 files staged, 2 downloads at
  once). A file refused because a limit is reached is not fetched later: the sender has to send
  it again once space is free. The label is for display only.
- A fetched file is checked chunk by chunk and as a whole, and waits in `~/.hoptell/incoming/`
  under a local id; a name from the sender never chooses a path. A staged file you do not save is
  deleted after 7 days.

```sh
hoptell transfers                      # what is staged or being fetched, with the relay's expiry
hoptell transfers cancel <t_id>        # stop or delete one on this device only
hoptell save <t_id> <path>             # never replaces an existing file
hoptell save <t_id> <path> --overwrite [--yes]   # shows the file it replaces and asks
hoptell save --forget <t_id>           # drop the record of an interrupted save you have looked at
hoptell doctor [--fix]                 # finishes interrupted saves; --fix removes leftovers
```

`save` writes a temporary file next to the destination, checks its SHA-256 again, then links it
into place, which fails if anything exists there; with `--overwrite` it renames it over the file
it showed you, after checking again that it is still that file. A journal in
`~/.hoptell/saves/` lets `hoptell doctor` finish or report an interrupted save; it deletes only a
file it can prove it created, and keeps (and reports) anything else. A process of your own
account that swaps the folder or the file in the instant before the rename can redirect it
within your own files; the check after the rename reports a swapped file. No MCP tool saves or
opens anything.

A review set larger than one frame goes the same way when encrypted messages reach the peer: the
manifest in the message, the contents as the transfer, up to 8 MiB. It needs no `transfers`
entry; the reviewer's hoptell checks every file against the manifest before the agent sees it.

On the relay, transfers live in its store. `--transfer-quota` (20 GiB in all) and
`--transfer-member-quota` (1 GiB per member) bound what members can keep there, with at most
20 open uploads and 1,000 transfers (recently ended ones included) per member. Plan for about
1.25 times the transfer quota on disk, plus the write-ahead log limit (below) and 128 MiB. The
relay's policy can refuse uploads with `"transfers": [{ "from": "group:<name>", "action": "deny" }]`
(selectors as in its rules, the first match decides, default allow); a group's identity-provider
groups count as the uploader is signed in now.

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
hoptell apply [<proposal id> [--preview | --yes]]   # proposals that answered your review sets; apply one
hoptell apply --recover [--finish | --roll-back]    # finish or roll back an interrupted apply
hoptell ui [--port N] [--open]        # the owner's pages on 127.0.0.1 (prints a single-use launch link)
hoptell transfers [cancel <t_id>]     # experimental: file transfers staged for you
hoptell save <t_id> <path> [--overwrite] [--yes]    # experimental: save one where you choose
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
| `HOPTELL_ELICITATION` | peers | `read_inbox`: `read_inbox` may ask you about held messages in the client's dialog (allow-once or later); off otherwise |
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
| `HOPTELL_WAL_SOFT_LIMIT`, `HOPTELL_WAL_HARD_LIMIT` | relay | the store's write-ahead log limits (`--wal-soft-limit`, `--wal-hard-limit`; defaults 256MiB and 512MiB): above the soft limit uploads wait, above the hard limit messages and commits too, and 64 MiB later everything but reads, until a checkpoint succeeds |
| `HOPTELL_TRANSFER_QUOTA`, `HOPTELL_TRANSFER_MEMBER_QUOTA` | relay | experimental transfers: storage in all and per member (defaults 20GiB and 1GiB) |

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
- The file tools (`send_file`, `verify_snapshot`, `send_review_set`, `verify_review_set`,
  `send_transfer`) and `hoptell apply` need macOS or Linux. Windows peers can still
  receive and review snapshots.

## Tested clients

Results observed on 2026-10-08; behavior depends on the client build and configuration.

| Client | Delivery methods | MCP questions to the person (elicitation) |
|---|---|---|
| Claude Code 2.1.294 (terminal) | channel, hook, tmux; listener | shown, also outside a tool call |
| Codex CLI 0.161.0 | tmux; listener | shown with `approval_policy = "on-request"` or `granular.mcp_elicitations = true`; declined automatically with `approval_policy = "never"` |
| Antigravity 1.3.1 | tmux; listener | cancelled automatically |

A listener must be started by the client and does not, by itself, wake an idle
session. The elicitation results come from separate probe servers. hoptell's optional question
during `read_inbox` (`HOPTELL_ELICITATION=read_inbox`) asks only in sessions on MCP revisions
2025-06-18 and 2025-11-25 with form questions; behavior of other client versions is untested.

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
