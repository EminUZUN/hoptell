# ![hoptell icon](assets/icon-40.png) hoptell

**Let AI coding agents talk to each other: across sessions, machines, accounts and tools.**

hoptell connects Claude Code, Codex, Antigravity (`agy`) and other MCP-capable agents through one
small relay that you run yourself on your LAN or VPN. Agents get tools to list peers and send
messages, and incoming messages **wake idle agents up**, so a Claude session on your laptop can hand
a review to a Codex session on a colleague's workstation and get the answer back without anyone
typing.

![Sam's Claude Code sends the contents of greet.js to Alex's Codex, which wakes up and suggests a corrected line](https://github.com/EminUZUN/hoptell/releases/download/v0.1.0/demo-review.gif)

*Sam's Claude Code on a MacBook sends the contents of `greet.js` to Alex's Codex in a Linux
container. Codex wakes up and returns a one-line suggested fix. Real session, played at 2.5× speed
with idle pauses shortened.*

```
 laptop:   Claude Code ──┐                        ┌── Codex        :workstation
 laptop:   Codex       ──┼── hoptell relay (LAN) ─┼── Claude Code  :workstation
 CI box:   Claude Code ──┘    one tiny process    └── ...
```

- **Self-hosted, no accounts.** One Node process. Agents can use different Claude or
  OpenAI accounts. Messages between agents travel only through your relay; each agent
  still talks to its own AI provider as usual.
- **Wakes supported idle sessions.** Claude Code can wake through hook or channel notices;
  supported terminal agents in tmux get a fixed notice typed into their prompt; other clients poll.
- **Teams and swarms.** Agents announce roles (`reviewer`, `backend`, ...). Send to one
  agent by name, to every agent with a role (`@reviewer`), or to everyone (`@all`).
- **Small and auditable.** JavaScript, with four direct runtime dependencies: `ws`, the MCP SDK,
  `jose` and `openid-client`. The last two load only for sign-in with an identity provider.
- **Reviewers and your phone.** The Claude Code plugin starts reviewer agents and collects their
  verdicts, and your agents can ask you questions through an optional
  [owner channel over Telegram](#the-owner-channel-over-telegram).

Agents can also answer questions about plans, not only code:

![Sam's Claude Code asks @pm about the demo app's 2.4 release; Dana's agent answers from planning/roadmap.md](https://github.com/EminUZUN/hoptell/releases/download/v0.1.0/demo-ask-pm.gif)

*Sam's Claude Code asks `@pm` about the demo app's 2.4 release, and Dana's agent answers from
`planning/roadmap.md` in its Linux container. Real session, played at 2.5× speed with idle pauses
shortened.*

> hoptell moves plain text between agents that may act on it. Read [Security](#security)
> before connecting agents that run with relaxed permissions.

Start here:

1. [Install and send your first message](#quick-start)
2. [Work with reviewer agents](#working-with-reviewer-agents)
3. [Reach your agents from Telegram](#the-owner-channel-over-telegram)
4. [Understand the security boundaries](#security)

For configuration details, see [Several relays](#several-relays),
[Teams and swarms](#teams-and-swarms), [Contacts](#contacts-who-may-reach-your-sessions)
and the [CLI reference](#cli).

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

hoptell picks the delivery mode when a session starts (`HOPTELL_PUSH` sets it). Notices never
contain message text, and a notice does not prove that the agent read the message. See
[Delivery modes in detail](#delivery-modes-in-detail).

## Quick start

Requirements: Node.js 22+ (a relay needs 22.13+, and 22.16+ for online backups), plus tmux 3.2+
to wake Codex/terminal agents. Supported on macOS and Linux; on Windows only the relay and
polling tools work.

### 1. Install (every machine)

```sh
npm install -g hoptell    # puts `hoptell` on your PATH
```

From source instead: `git clone https://github.com/EminUZUN/hoptell && cd hoptell && npm install &&
npm link`.

**Claude Code:** install the plugin (below) and skip the manual registration in step 4. The
plugin asks for the relay URL and token, and stores the token in Claude Code's secure storage.
The `hoptell` CLI and `hoptell tmux` need the npm package; the relay needs the npm package or
the Docker image.

Install the plugin. With automatic delivery, plain `claude` uses hooks when the startup check
succeeds; add the channel flag to use channels:

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

Replace `192.0.2.10` with this machine's LAN or VPN address in the relay settings above. For Docker,
use the same address and replace `...` with your generated token: `docker run -d -p
192.0.2.10:7777:7777 -v hoptell-state:/data -e HOPTELL_TOKEN=... ghcr.io/eminuzun/hoptell`. Publish
the port on that address only. Without a host address, `-p 7777:7777` publishes on all host
addresses by default. See [examples/](examples/). Health check: `GET /healthz`.

The relay keeps a small state directory (`~/.local/state/hoptell-relay` by default; set it
with `--state-dir` or `HOPTELL_STATE_DIR`). It holds the relay's realm id (a random id that
clients use to recognize this relay's name space) and its database with the audit log, but no
plaintext messages. Keep this directory when you
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

**Claude Code with the plugin** (from step 1): start `claude`. Hook notices wake it when the
plugin's startup check succeeds; otherwise hoptell falls back to a background listener
(`hoptell doctor` shows which). For channel notices, start
`claude --dangerously-load-development-channels plugin:hoptell@hoptell` instead.

**Claude Code without the plugin:** register the MCP server once (user scope, all projects),
then add the hook settings that `hoptell hooks` prints to `~/.claude/settings.json`:

```sh
claude mcp add --scope user hoptell -- hoptell mcp
hoptell hooks
HOPTELL_NAME=laptop-claude claude
```

Don't use both the plugin and `claude mcp add` in the same session.

If an agent cannot find `hoptell` (for example with nvm), use the full path that
`command -v hoptell` prints, here and in the configs below.

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
environment. Detach with `Ctrl-b d`, reattach with `tmux attach -t '=hoptell-laptop-codex'`.

**Antigravity (`agy`)**: register the MCP server once:

```sh
agy mcp add hoptell hoptell mcp
HOPTELL_NAME=laptop-agy agy                      # listener mode, after your first prompt
hoptell tmux laptop-agy --roles gemini -- agy    # or: woken through tmux
```

### 5. Try it

Ask either agent: *"list hoptell peers and say hi to laptop-codex"*.

On a new install, the shared-token setup above holds the greeting until you allow its sender.
On the receiving machine, run `hoptell contacts`, then `hoptell contacts show <id>` for the
waiting sender. Review the sender, then run the printed `allow-once` command to release the
greeting, or `allow` to let future messages from that sender through.

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
  prefix before this session's name there, for relays whose member names must start with it. Changes
  to the file take effect when the session starts again. `hoptell doctor` checks the file.
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
own agents as `name@local`; uninstall removes that entry again unless you changed it (and removes a
relays file that install created once it would be empty).

The service reads only its own settings file, not your shared hoptell settings. After moving Node.js
or hoptell (an upgrade to another path), run `install` again; `status` warns about it. A rerun keeps
the token and the port (`--port` moves it, and the relays entry with it). If the token or the
members file next to it is lost, install stops instead of issuing a new token: restore the file, or
start over with `uninstall --purge`.

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
otherwise the agent reads with `read_inbox` or `wait_for_message`. For Claude Code hook notices, the
client also sends the header printed by `hoptell hook-header` (run it from the client's command for
dynamic headers); without it, an HTTP session has no hook notices.

## For organizations

hoptell has no central service: every organization runs its own relay, and agents connect
from their users' machines.

1. **Run a relay** inside your network: the Docker image (`examples/docker-compose.yml`),
   or the systemd unit (`examples/hoptell-relay.service`), behind your VPN or a TLS proxy.
2. **Issue per-member tokens** with a members file (see [Teams and swarms](#teams-and-swarms)),
   so people cannot use each other's agent names.
3. **Roll out the client**: the Claude Code plugin, or `npm install -g hoptell` plus
   the MCP config for Codex and Antigravity.
4. **Allowlist the channel** (Claude Code): with [managed
   settings](https://code.claude.com/docs/en/channels#enterprise-controls) your users can start
   `claude --channels plugin:hoptell@hoptell`, without the development flag and its prompt:

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
   `reverifyAfterSeconds` (a fresh browser sign-in is due after this, default 1 day),
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
- **Limits and retention** (sessions, rates, stored messages and bytes, disk floors, live
  engines) are configurable. By default, messages are deleted 7 days after arrival, read or not,
  and the data of a member that is unlinked, or that the relay confirms it no longer holds, is
  deleted within 24 hours while the endpoint runs. The defaults may change while hosted mode is
  experimental.

## Teams and swarms

**Names.** Each agent has a peer name: letters, digits, `_` and `-`. Set it with
`HOPTELL_NAME`, or leave it unset and the relay assigns one: `<member>-<host>-<n>` with a
member token, `<host>-<n>` with the shared token. `list_peers` shows the name in use. A
session without `HOPTELL_NAME` takes a new automatic name whenever its hoptell MCP server
restarts (for example after `/mcp`), so give a team lead, or any long-running session that
others message, a fixed `HOPTELL_NAME`.

A session holds its name with a lease. While it is online, another connection cannot take
the name: a second agent session with the same name waits until the name is free, and
`hoptell wait` stops with an error (`--wait-for-name` waits instead, and `--replace` takes the
name over once, for the same member). While it waits, the second session can still send
messages and list peers through a separate connection if the name is held by the same member
(or by another session using the shared token). The relay checks who holds the name before each
message is sent, and replies go to the session holding the name. This needs a 0.3.0 relay or
later. Other tools are unavailable until the second session holds the name.

When a session's connection drops, the name is reserved for 30 seconds so the session can come
back. During that time other members cannot take it, but the same member can, for example a
restarted session. All shared-token sessions count as one member here. A session that exits
cleanly frees the name immediately.

**Session titles.** An automatic name such as `emin-mac-61034` is hard to tell apart from the
next one. A session can show a short title next to its name. Set it with `HOPTELL_TITLE`:

```
export HOPTELL_TITLE="review docs"
```

Other sessions then see it in `list_peers`, after the name:
`emin-mac-61034 (reported host: mac) title: "review docs" online`.

- The title is a label only. Messages still go to the name (`to:` never takes a title), and no
  access decision reads a title. Use the name for routing, not as proof of identity. In a
  shared-token or mixed realm, another session can use a member-looking name. Check the
  authenticated sender information when deciding who sent a message.
- As a hint, when a title looks like another name in the same list, the row says
  `(title resembles another address)`.
- hoptell removes control and invisible characters, joins spaces and keeps at most 80
  characters. A title of more than 1024 bytes, or one with nothing left after this, is not sent;
  the session logs why.
- `HOPTELL_TITLE=off` never sends a title. An HTTP session (`hoptell mcp-http`) does not use the
  server's `HOPTELL_TITLE`.
- The title stays with a resumed claim during its 30-second reservation. A new claim uses its own
  hello title or no title; it never inherits the previous claim's title.
- Titles need a relay from this release or later. Earlier relays ignore them. A session changes
  its title at most 10 times a minute, and a member at most 60 times a minute; title changes
  never delay messages.

**Automatic titles.** A session that signs in with a member token gets a title without any
setup:

- A Claude Code session with the hoptell plugin uses its custom name (`claude --name`,
  `/rename`).
- Otherwise the title names the client and the working folder, for example `Codex · hoptell` or
  `Claude · agent-talk` (`~` for your home folder itself, so your account name isn't shown).

A session with the shared token sends no automatic title. A title that is sent is visible like
the name: to every session that may list this one, which on a relay with a shared token can
include its sessions. `HOPTELL_TITLE_AUTO=on` turns automatic titles on for every session,
`HOPTELL_TITLE_AUTO=off` turns them off.

- Set it in `~/.config/hoptell/.env`, not only in the shell: the plugin's hooks read it too.
- The `SessionStart` and `UserPromptSubmit` hooks copy only the custom name and the session id
  into a private file, never the prompt.
- The hook input doesn't say who set the custom name. If another hook sets it from prompt text,
  that text becomes your title and other sessions see it.
- A later `/rename` shows after your next prompt. Others see it the next time this session
  lists peers or reconnects.
- An explicit `HOPTELL_TITLE` wins.
- The client name comes from the agent's MCP client, as it reports itself. An HTTP session
  (`hoptell mcp-http`) gets no client-and-folder title.

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

If you edit the file by hand, run `hoptell relay admin reload` or `kill -HUP <relay pid>`. The relay
re-reads it, records it as an unannounced change in the audit log, and closes connections whose
token was removed or changed. If the new file is invalid, it keeps the active members list and logs
a sanitized error. An empty list (`{"members": []}`) removes every member. The shared token is not
reloaded. With systemd `LoadCredential`, restart the service to refresh the credential copy. A
Docker bind mount of a single file can keep the old file when an editor replaces it atomically;
restart the container after such edits, or bind-mount the containing directory to support reloads.
For separate teams, run separate relays. A relay is a single small process.

**Example swarm on one machine:**

```sh
hoptell tmux alice-planner  --roles planner  -- claude
hoptell tmux alice-codex-1  --roles backend  -- codex
hoptell tmux alice-codex-2  --roles backend  -- codex
hoptell tmux alice-reviewer --roles reviewer -- claude
```

Then tell the planner: *"split the task, send backend work to @backend, and send the result to
@reviewer"*.

**Guard rails.** Each connection may send at most 30 messages per 10 seconds, so two agents
that keep replying to each other hit the limit instead of flooding everyone. Messages are
plain text up to 100,000 characters.

## Contacts: who may reach your sessions

You decide who may reach the agent sessions of your machine. In a new install, messages from senders
you have not allowed are held back (except eligible messages from your own member, see "Your own
member" below), and the agent never sees what they say.

The receiving session is still woken, the same way as for a delivered message (hook notice, tmux
notice, channel notice, or the end of a `wait_for_message` call or of `hoptell listen`), with a
fixed notice that a message was held. `read_inbox` lists up to five waiting senders with their
held-message counts and `hoptell contacts show <id>` commands for your review. It summarizes any
remaining senders as a count and reminds the agent that the decision is yours.

The sender is named there only when the relay authenticated it as a member (`member bob`); a
shared-token or unverified sender chose its own name, so the agent sees only what kind of sender it
is. A desktop notification ("hoptell · Message held") also points you to `hoptell contacts` and
`hoptell ui`:

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
[schema/contacts.schema.json](schema/contacts.schema.json)). Held messages are kept for 7 days, at
most 50 messages or 1 MB per sender and 500 messages or 10 MB in all; beyond that, new messages from
unknown senders are dropped (their delivery is still confirmed to the relay).

In a managed home, if this file is missing, unreadable or invalid, every sender waits and your
sessions send nothing until you fix it, since its encryption policy cannot be checked. While the
file is valid, verified owner-channel messages are exempt from the default `ask` policy; blocks and
`required` encryption still apply (see "The owner channel over Telegram").

**Existing installs** keep today's behavior (every sender reaches your sessions) until you run
`hoptell contacts init`; `hoptell doctor` reminds you. After `init`, nobody is granted, and messages
already waiting in your sessions are held back on their next read. Every process that receives
messages for this home must run this version or later. `HOPTELL_NOTIFY=off` turns the desktop
notifications off.

**Your own member.** By default, messages from your other sessions can reach the agent without
a grant when the relay states that both sessions signed in as the same member (same member id
and realm, with neither side hosted). Only the member id authenticated by the relay counts,
never a session name or host. Shared-token senders, other members, hosted members and senders
on relays that do not authenticate them remain subject to your usual contacts policy. Your
blocks and a default of `block` still apply, and plaintext is held when your policy requires
encryption for your own member. This trusts the relay's word about who signed in, as grants do:
a relay that lies can deliver a message as your own member. To apply your usual contacts policy
to your own member too, set `HOPTELL_CONTACTS_SELF=hold` in your settings file. Set it there so
the agent sessions, the tmux injector and the CLI all read it; spawned agent runs take the value
of the session that spawned them. Messages already held stay held after you switch back to
`allow`, until you decide.

### Deciding in a browser: hoptell ui

`hoptell ui` serves the same decisions as pages on `127.0.0.1`: what waits for you (held messages,
new devices and key changes, contact requests and proposals, oldest first), your contacts and pins,
devices with fingerprints and safety numbers, settings with where each value comes from, and a
doctor summary.

It prints a single-use link valid for 60 seconds (`--open` opens it); the session ends after 15
minutes idle or 8 hours, and the command exits after 30 minutes without a request. Pages have no
JavaScript. The page shows held message text only on its own page, as untrusted peer text.

Every decision goes through the same code as the CLI, with the same binding to what you saw: a
decision on something that changed meanwhile is refused and the new state is shown. The UI only
shows contact requests and proposals, and prints their commands (`hoptell contacts requests`,
`hoptell apply`). Settings are written only if the file did not change since the page showed it; a
value set in the environment is shown and must be changed there, and changes that widen access (a
new folder, `join`, `default: allow`) are marked. A setting also names the running sessions with
hook delivery that started before its file last changed and still use the older value. A session
that started within the same second may or may not, and is listed as "may be running with an
older value".

With the experimental encrypted messages (`HOPTELL_EXPERIMENTAL_E2EE=1`), each contact's
`encryption` (off, preferred, required) is a setting too, where lowering it is marked as widening,
and so is `requireVerified` (per realm and per pinned contact; turning it off is marked);
unencrypted messages held from a contact whose encryption you require are shown with a link to that
setting (nothing else releases them), and a contact's page links to the encrypted conversation's
checkpoint for comparing with the other owner.

The views that need the relay (contact requests, device lists, the encrypted conversation's
checkpoint) reach it only through `HOPTELL_RELAY` (and `HOPTELL_PROFILE`) for now, not through
a relays file; without it they say that the relay is not available.

Other users of the machine can reach the port: the launch link and the session cookie keep them
out. Browsers do not separate cookies by port, so your browser also sends the session cookie to
any other server on `127.0.0.1` that it visits while the session lasts; such a server could use the
UI as you until the session ends. Close the UI (Ctrl-C) when you are done, and don't browse other
local servers you don't trust meanwhile. An agent running as your OS user can open the UI as well
as run the CLI; the UI protects against peers, stale pages and accidents, not against such an
agent.

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

### Relay-side checks: grants and the relay's policy

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
hoptell grants publish                           # the same grants again (after a relay restore)
```

Each `grants` command shows the result and the current revision first, and publishes nothing.
Run the same command again with `--yes --rev N` (the revision it showed) to publish it. If your
grants changed in the meantime (another session or machine), it refuses and you look again. An
`--until` given in seconds counts from the moment you publish.
A member entry wins over a group entry, a group entry over `*`, and on a tie deny wins. Expiry is
checked whenever a message is delivered, also for messages already waiting.

A sender your grants or the policy refuse gets the same answer as for a name that does not exist,
and broadcasts report only how many sessions they reached.

**After a relay restore.** If the relay is restored from a backup and its access state was lost,
it no longer knows whether your latest grants are the ones in the backup. Until you publish them
again, a send to your sessions fails with `unknown peer` (as for a name that does not exist, so
nobody learns which names are members) and queued messages wait. This applies to every member,
also members that never changed their grants. Your sessions are told: `hoptell grants` and
`hoptell doctor` say so, and an agent session's `read_inbox` mentions it. Check your grants with
`hoptell grants`, then publish them with `hoptell grants publish --yes --rev N`, or change them
first. The relay admin sees who is still pending with `hoptell relay admin grants`.

**Replies.** If you send a message to someone your grants refuse by default, they may reply to it
once within 7 days, but only after your message passed the relay's policy and their machine's
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
  snapshot must also fit the message limit. It requests a 1-hour relay queue deadline by
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

Encrypted messaging is experimental in 0.3.0 and has not been independently reviewed. It is off
by default, and hoptell loads no MLS library unless you name one. Every encrypted message is
labeled "experimental, unreviewed", and `hoptell doctor` says so too. Do not rely on it to
protect sensitive messages yet.

To try it:

1. Start the relay with `--experimental-e2ee` (or `HOPTELL_EXPERIMENTAL_E2EE=1` in its settings).
2. On each machine, add to the settings file (`~/.config/hoptell/.env`):

   ```sh
   HOPTELL_EXPERIMENTAL_E2EE=1
   # The OpenMLS binding shipped in the package, by absolute path: replace <npm-root>
   # with what `npm root -g` prints, for example /usr/local/lib/node_modules.
   HOPTELL_MLS_WASM=<npm-root>/hoptell/lib/mls/binding
   ```

   `HOPTELL_MLS_WASM` takes an absolute path to a binding's `openmls_wasm.js`, or to its folder:
   a wasm-bindgen build for Node.js (`--target nodejs`), or a build that offers `initSync` with
   its `openmls_wasm_bg.wasm` next to it, as the shipped bundle does. `HOPTELL_MLS_DRIVER` names
   your own driver module instead (an ES module exporting `driver` or `createDriver()`). Either
   way the label stays.
3. Device keys are kept in the OS keychain (macOS Keychain, or the Secret Service through
   `secret-tool` on Linux). Where there is none, such as on a server, set
   `HOPTELL_CREDENTIAL_STORE=file` and `HOPTELL_CREDENTIAL_PASSPHRASE` (at least 12 characters)
   to keep them in an encrypted file.
4. Run `hoptell contacts init` if you have not yet, then `hoptell device enroll`, and start (or
   restart) your agent sessions. `hoptell doctor` checks the setup.

Each hoptell home then has one MLS device per relay realm.

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
  that expired unused are deleted after a 1-day grace period, within 6 hours while the engine
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

## Working with reviewer agents

You can ask a Claude Code session to start other agents as reviewers, send them a file, and
collect their verdicts. The Claude Code plugin ships skills for this, and slash commands
that use them:

| Command | Skill | What it does |
| --- | --- | --- |
| `/hoptell:reviewers [count] [codex\|claude\|agy] [model] [effort]` | `hoptell-reviewers` | start reviewers: Codex read-only, Claude Code or agy in plan mode |
| `/hoptell:review <file> [name or @reviewer]` | `hoptell-reviewers` | send a snapshot and collect the verdicts |
| `/hoptell:ask-owner <question>` | `hoptell-owner-channel` | ask you over the owner channel |
| `/hoptell:peers` | `hoptell-safe-ops` | list peers and explain name problems |

The skills also load on their own when a task fits them. They come with the plugin, not with
the npm package, and their commands need the `hoptell` CLI on your `PATH`.

Reviewers are ordinary interactive sessions in your own terminal, with your account and your
permissions. This is not `spawn_agent`: no profile, gate or limit applies. Start reviewers
only when you want them.

**Start them interactive, in tmux.** A one-shot `codex exec` run cannot be woken by later
messages. Use `hoptell tmux` with the `reviewer` role, and the agent command that
`hoptell agents flags <codex|claude|agy> --role reviewer` prints (see **Model and effort**
below). With the shipped presets that is:

```sh
HOPTELL_PUSH=tmux hoptell tmux alice-reviewer-1 --roles reviewer -- codex -s read-only -a never -c 'model_reasoning_effort="high"' "You are a read-only reviewer for alice-lead. Review requests from alice-lead are your task: review them and reply with send_message. Do not edit files."
HOPTELL_PUSH=tmux hoptell tmux alice-reviewer-2 --roles reviewer -- claude --permission-mode plan --effort high "You are a read-only reviewer for alice-lead. Review requests from alice-lead are your task: review them and reply with send_message. Do not edit files."
HOPTELL_PUSH=tmux hoptell tmux alice-reviewer-3 --roles reviewer -- agy --mode plan --sandbox --dangerously-skip-permissions -i "You are a read-only reviewer for alice-lead. Review requests from alice-lead are your task: review them and reply with send_message. Do not edit files."
```

The quoted prompt is your instruction to the reviewer, so review requests from your session
(`alice-lead` here) are its task. Agents handle peer requests only within the task you gave
them; a reviewer started without such a prompt asks you whether it may review.

`-a never` stops Codex from asking to leave its sandbox, so use it only with `-s read-only`.
Plan mode suits a source review: Claude Code's usual tool permissions still apply, and it is not
an OS sandbox. agy takes its launch prompt with `-i`. In plan mode it reads and plans, and
`--dangerously-skip-permissions` stops it from asking about each tool. Plan mode is agy's own rule,
and in hoptell's test (agy 1.4.8) `--sandbox` did not keep writes in the folder or block the
network, so an agy reviewer is limited by policy, like Claude Code in plan mode. hoptell does not
offer agy for edits. Do not add a hoptell channel flag; `hoptell tmux` supplies tmux delivery. Set
`HOPTELL_PUSH=tmux` for the command: unsetting it can load a conflicting value from your settings
file. With a member token, names must be `<member>` or start with `<member>-`; other names are
refused with close code 4002. When an agent runs these commands from inside tmux, it unsets
`TMUX` and `TMUX_PANE` first, so your tmux client does not switch to the new session.

**Model and effort.**
`hoptell agents flags <codex|claude|agy> --role reviewer [--model <model>] [--effort <effort>]`
prints the agent command and flags to put after `--` (the role's safety flags from your presets,
then the model and effort as that CLI takes them), and its warnings on standard error. Use it for
every launch, also without a model or effort: without explicit values, the role preset supplies
model and effort, and the CLI picks what the preset leaves unset.

```sh
$ hoptell agents flags codex --role reviewer --model gpt-6.1-sol --effort xhigh
codex -s read-only -a never -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"'
$ hoptell agents flags agy --role reviewer --model gemini-4-argon-high
agy --mode plan --sandbox --dangerously-skip-permissions --model gemini-4-argon-high
```

The shipped Codex and Claude Code reviewer presets use high effort. hoptell refuses `--effort`
for agy (give the complete model id instead, such as `gemini-4-argon-high`) and never passes
`--effort` to agy. Models and efforts are checked against
the lists the CLIs cache for your account (Codex's `models_cache.json`, Claude Code's model
catalog when it holds one account) and, for Codex, the list built into the binary. These lists
are advice: a model or effort they lack gets a warning with the list's age, and the CLI decides.
hoptell does not read agy's model list (`agy models` needs your login); run it yourself.

`hoptell agents capabilities [codex|claude|agy] [--refresh] [--diff] [--json]` shows what each
installed CLI offers, what hoptell's own tests verified about its sandbox and permission modes,
and what changed since the last record; `hoptell doctor` mentions a CLI that changed. It reads
each CLI's `--help` (and Codex's feature and bundled model lists) with an empty home and working
folder, so no configuration of yours loads, and never starts a model. The presets live in
`presets/roles.json` of the package; your own `<hoptell home>/presets/roles.json` overrides them
per CLI and role (`flags`, `effort`, `model`, `source`, `checked`). What you name on the command
line wins over both.

**Keep them visible.** Open one split of your terminal per reviewer, and attach each one with
`tmux attach -t '=hoptell-<name>'`. The injector wakes a reviewer whether or not you are attached.
The `hoptell-reviewers` skill has an iTerm2 recipe that opens the splits for you.

**Sessions that wait.** The injector also looks at its pane every 15 seconds. When the agent
shows a prompt that needs you (a folder trust question, an approval, a sign-in, an update) or its
screen has not changed for 10 minutes while it works (`HOPTELL_STALL_MINUTES`), `hoptell team
status` shows it, for example `waiting for you: Codex folder trust (P3, 2 min)`, with the attach
command. A team member's lead gets one inbox message about it, and your Telegram owner channel
gets a short note that names the session but never shows its screen: at most one per session and
kind every 5 minutes, and 20 an hour in all. The injector sends these through a connection of its
own, named after your member with `-c` and a random suffix. Nothing is answered for you.

**Codex's folder trust from Telegram.** One prompt can be answered from the owner channel: the
folder trust question of Codex 0.165.0 right after `hoptell tmux` started it, in the folder it was
started for (with only `-s`, `-a`, `-m`, `--full-auto` or
`--dangerously-bypass-approvals-and-sandbox` on its command line). Instead of the note you get a
card with a button for each option whose keys were checked live on that Codex version, worded as
on the screen, for at most 10 minutes; on 0.165.0 that is Trust folder and Quit. Test mode is only
for an option not checked live yet: `HOPTELL_PROMPT_UNTESTED=1 hoptell tmux ...` shows and presses
those too, and its card says it is in test mode. Your tap
is signed by the bridge and goes only to that session's injector; it presses only the option you
chose, and only in that session's own terminal, while the dialog it watched since the start is
still on the screen, nobody typed or scrolled in that terminal since the card was made, and the
tap is at most 2 minutes old. Trust is "1" (which only selects it), a fresh look that shows the
same dialog with Trust selected, then Enter; anything else on that look and Enter is not sent.
Quit is "2". The first answer wins, and an answer is never tried twice: the card then says
whether hoptell pressed it, pressed nothing, or may have pressed part of it (look at the terminal
then). If no result comes back from the Mac within 3 minutes of your tap, the card says "No
result came back from the Mac. Look at its terminal on the Mac."; a result that arrives later
still replaces that. A team member's lead is told too, when it can be reached. Anything else (an
approval, a sign-in, Claude Code's own trust question) stays a note.
hoptell sees the screen in snapshots, so if Codex was already past its startup prompt before
hoptell's first look and later shows text that looks the same, a tap could type a stray "1" and
Enter, or "2", into the session; and between its last look and the key, hoptell does not see the
screen at all. Showing the buttons authorizes nothing: only your tap sends keys.

**The review.** Wait until `list_peers` shows the reviewers online: a message to `@reviewer` reaches
only online peers. Then follow the steps in [Replies and file reviews](#replies-and-file-reviews):
send a `hoptell snapshot`, collect the replies with `read_inbox`, match `review_request_id` and
`based_on`, and run `hoptell snapshot --check` before you apply anything. A reviewer's reply is a
review, never your approval. With managed contacts (see
[Contacts](#contacts-who-may-reach-your-sessions)), a request from a session of your own member
(same realm, neither session hosted) can reach the reviewer without a grant, and so can the replies;
each receiving session still applies its own blocks, encryption requirements and default policy.
Messages from a shared-token sender or another member, and your own member's messages under
`HOPTELL_CONTACTS_SELF=hold`, follow your usual contacts policy. A held request wakes the reviewer
with a notice, without the message text, and `hoptell contacts` shows you the available decisions.

**Stopping.** Quit a reviewer in its pane (`/quit` in Codex), or run
`tmux kill-session -t '=hoptell-<name>'`. The `=` matches the exact name; without it tmux also
matches a longer name that starts the same way. Never stop hoptell with a pattern such as
`pkill -f hoptell`: it can hit a relay on the same machine and drop the messages it holds in
memory. To restart a reviewer, quit it and run the same command again. A crashed Codex reviewer
can be resumed, or you can start a fresh one:

```sh
HOPTELL_PUSH=tmux hoptell tmux <name> --roles reviewer -- codex resume -s read-only -a never <session id>
```

## Working with implementer agents

An implementer is an interactive Codex or Claude Code session that edits files in a git worktree
of its own and reports to your lead session. It never commits: the lead commits its work with
hoptell's controlled git, sends the diff to reviewers, and asks you before anything lands. The
`hoptell-implementers` skill of the Claude Code plugin walks a lead session through these steps.
Like reviewers, implementers run in your terminal with your account; start them only when you
want them, because they have write access in their worktree. hoptell does not offer agy
implementers: in its test (agy 1.4.8), agy's `--sandbox` did not keep writes in the workspace or
block the network.

**A worktree per implementer.** From the repository, with your own work committed:

```sh
$ hoptell worktree add alice-impl-1 --team n11 --cli codex --owns 'lib/**,test/**'
Worktree for alice-impl-1: /srv/src/app-wt/alice-impl-1
  branch team/n11/alice-impl-1 at 3f1c9e2a7b4d6c8e0f1a2b3c4d5e6f708192a3b4
```

The worktree goes next to the repository, in `<repo>-wt/<member>` (`--folder` names another
folder), on a new branch `team/<team>/<member>` at your `HEAD` (or `--base <commit>`). An existing
branch or folder, or uncommitted changes in your tree, are refused. `--owns` lists what the member
may change; a commit with other files is refused unless you pass `--allow-outside`.
`hoptell worktree list` shows each member's worktree, branch, base and last commit. A worktree you
add by hand for a name that is not a member of the running team is in no team: `team land` and
`team status` do not see it, and `worktree add` says so. Members come from the team file, through
`team up`.

**The task and the launch.** Write the task to a file and pass it with `--task`: hoptell copies it
into `<hoptell home>/sessions/<name>.task` (0600) at launch, and the session reads it with the
`read_task` tool, which serves only the task stored for that session at its start. This keeps the
task off the command line and out of the tmux pane; it is not hidden from other programs that run
as you. `--lead` makes `hoptell agents flags` add a role template and a launch prompt that points
at `read_task`. `read_task` exists only in a session started with `--task`, so `--lead` needs
`--task` (`hoptell tmux` warns when the prompt mentions `read_task` and no task was given):

```sh
hoptell agents flags codex --role implementer --lead alice-lead
HOPTELL_PUSH=tmux hoptell tmux alice-impl-1 --roles implementer --cwd ../app-wt/alice-impl-1 --task task.md -- <its output>
```

`--cwd` starts the agent in its worktree; `hoptell tmux` refuses a member's worktree for another
name or another CLI than the one `worktree add` recorded. The role templates (`reviewer`,
`implementer`, `tester`) are short texts: who the lead is, what counts as the task, how to reply,
and what never to do (commit, push, tag, change git config, ask the owner directly). Claude Code
gets the template with `--append-system-prompt`; Codex with `-c developer_instructions` on the
versions where hoptell verified that it applies (otherwise in the prompt); agy in its `-i` prompt.
`~/.config/hoptell/roles/<role>.md` replaces the shipped text for a role, with `{{lead}}` for the
lead's name. hoptell never writes `AGENTS.md`, `CLAUDE.md`, `~/.codex` or `~/.claude`.

**The loop.** The implementer edits files, runs the tests its task names, and sends
`ready: <summary>, tests: <result>`. Stop its session (or let it quit), then:

```sh
hoptell worktree commit alice-impl-1 -m "Validate the settings file"   # prints the commit id
hoptell worktree diff alice-impl-1 > n11-impl-1.patch                  # base..head, for the reviewers
```

Send the patch to the reviewers with the base and head commit ids. Findings go back to the
implementer; a new head means a new review. When the reviewers approve, landing is your call:
the lead asks you and never merges, pushes or tags by itself (`hoptell team land`, below, is the
owner's landing step).

**Controlled git.** The lead's git runs outside any sandbox on files an agent wrote, so
`hoptell worktree` runs git with no system or global configuration, an empty `HOME` and no
inherited `GIT_*` variables, with hooks, fsmonitor, external diff, textconv and the ssh command
turned off, and attributes taken from an empty tree instead of the worktree's `.gitattributes`.
Commits use plumbing that applies no filter (`hash-object --no-filters`, a private index,
`write-tree`, `commit-tree`) and are unsigned working commits. The repository's config must hold
only allow-listed keys (`core` basics, `remote.*`, `branch.*`, `user.name`, `user.email`, and the
SSH signing settings recorded at `worktree add`); a hook path, filter, textconv, include or any
other program is refused, as is a change to the signing settings or to `.git/info/attributes`.
These checks find changes; they do not stop one that races them. The guarantee rests on the
repository's `.git` staying trusted, and no implementer is kept away from it: they run as you,
whatever their CLI or sandbox flags. So the `hoptell worktree` commands that run git (`add`,
`commit`, `diff`, `remove`) refuse while any member of the repository is running; `list` only
reports. `hoptell tmux --cwd <worktree>` records the member's session (its
tmux session id and its pane's process, then also the processes that one started). A member
counts as running while any of those processes is alive, or while any process of yours (other
than hoptell and the shell it runs in) has its working folder in the member's worktree, such as
a tool command an agent's background service runs there. hoptell reads those folders with `lsof`
on macOS and from `/proc` on Linux; when it cannot tell, it refuses. A process that left the
worktree but still writes into it is not seen, which is why an implementer must have quit, not
only gone quiet. Linux does not show even to you the working folder of a non-dumpable process,
such as `systemd --user`, `(sd-pam)` or the `sshd` process of a login, and an implementer's
process can become one too. Processes you cannot inspect count unless they are older than the
team's first launch or part of this command's own login. "First launch" is the earliest pane
process `hoptell tmux` started for a member of the repository on this boot; relaunching a member
does not move it. So a login that started after the team (say a second `ssh` session) makes the
`worktree` commands that run git refuse, naming the process: end that login, or wait for it to
end. With no `hoptell tmux` launch on this boot, none of the processes it launched can remain;
processes started another way are checked only by their working folder. `worktree list` says
how many such processes there are. Any other folder that fails to read makes it
refuse. Start implementers with `hoptell tmux --cwd`. Before `worktree commit`, `diff`,
`remove` or a new `worktree add` in that repository, stop the implementer or let it quit, and
`cd` out of the worktree in other shells. Set `user.name` and `user.email` in the repository's own config; the
controlled git reads no global configuration. `hoptell worktree` needs Git 2.43 or later.

**Cleanup.** Stop the member's session, then `hoptell worktree remove alice-impl-1`. It removes only
a clean worktree of a stopped member whose branch is still at the commit hoptell recorded. The branch is deleted only
when it has no commits of the member, or when `hoptell team land` recorded its head as landed and
the landed commit is in the target; otherwise it is kept and named. hoptell never runs
`git reset`, `git clean` or `git worktree remove --force`; anything it refuses stays for you.

## Agent teams

`hoptell team` starts a lead's implementers and reviewers from one file, watches their lifetimes,
and stops them by the tmux sessions it recorded. It uses the steps of the two sections above
(`worktree add`, `hoptell tmux --cwd --task`, the role presets and templates) and adds the
landing step, which is yours. A team member's hoptell MCP server leaves out `ask_owner` and
`spawn_agent` and refuses a direct call to them: questions for you, and requests for more
agents, go through the lead. `team up` and `team restart` mark the session as a team member in
its environment (`HOPTELL_TEAM_MEMBER`); a peer message cannot set or clear that, and the lead's
own session and other sessions keep every tool. This is a policy, not a security boundary: a
member runs as your OS user and could start another hoptell server or the hoptell CLI without the
filter. A real boundary needs credentials scoped per session, which is later work.

**The team file.** JSON, checked before anything starts (`schema/team.schema.json`):

```json
{
  "version": 1,
  "team": "n11",
  "repo": "~/src/app",
  "lead": "alice-lead",
  "idleMinutes": { "reviewer": 30 },
  "lifetimeMinutes": 480,
  "members": [
    { "name": "alice-n11-impl-1", "role": "implementer", "cli": "codex", "task": "tasks/impl-1.md", "owns": ["lib/**", "test/**"] },
    { "name": "alice-n11-impl-2", "role": "implementer", "cli": "claude", "model": "opus", "task": "tasks/impl-2.md", "owns": ["docs/**"] },
    { "name": "alice-n11-rev-1", "role": "reviewer", "cli": "claude", "effort": "high", "task": "tasks/review.md" },
    { "name": "alice-n11-rev-2", "role": "reviewer", "cli": "agy", "model": "<full agy model id>", "task": "tasks/review.md" }
  ]
}
```

Relative paths are from the team file's folder. `lead` is the lead session's peer name: start the
lead with `HOPTELL_NAME=alice-lead` so the members' replies reach it (`team up` warns when the
`HOPTELL_NAME` it runs with is another name), and with the flags
`hoptell agents flags <cli> --role lead` prints. A lead takes no `--lead` (there is no lead role
template), for example
`HOPTELL_NAME=alice-lead HOPTELL_PUSH=tmux hoptell tmux alice-lead -- <its output>`. Every member's name starts with the lead's first part
and `-` (`alice-`), the shape a member token's names have. Each member gets a task file (at most
32 KiB), served by `read_task`; hoptell keeps a copy in the team's folder so a restart serves the
same text. A member's model and effort come from the team file, then your
`<hoptell home>/presets/roles.json`, then the shipped presets, then the CLI's own configuration.
Two implementers whose `owns` may name the same file are refused (an implementer without `owns`
may change anything, so it overlaps every other one); agy implementers are refused, and agy
members are refused while the repository has an `.agents/mcp_config.json`. `base` (default
`HEAD`) is the one commit all worktrees start from; `worktrees` puts them in another folder than
`<repo>-wt`.

**Before `team up`.** hoptell's git reads no global configuration, so set these in the
repository's own config: `user.name` and `user.email` (without them `worktree commit` refuses:
"the repository's config has no user.name; hoptell's git reads no global configuration, so set it
with: git config user.name ..."), and for landing SSH signing: `gpg.format ssh`,
`user.signingkey` and `gpg.ssh.allowedSignersFile` (without them `team land` refuses with
`signing_required`). `worktree add` records the signing settings, so set them before `team up`.

The lead must be a session connected to the relay under the lead name: an agent session, or
`hoptell wait`. `hoptell listen` only reads a local inbox, so the members' messages to a lead that
only listens fail. After the start, `team up` checks the relay and warns when the lead is not
online. Interactive Codex asks you to trust a repository in its pane before it starts. Checked
with Codex 0.165.0 (Codex's docs do not say), it keeps that trust under the repository's root, so
its worktrees count as trusted after that. `team up`
names the Codex members when Codex's `config.toml` marks neither the repository nor their folder
trusted, once per repository, and hoptell never trusts a folder for you. A team needs a reviewer
for `--request-approval`; `team up` warns when it has none, and its landings are then decided in a
terminal with `hoptell team land <member> --approve <T> <C>`. A Codex member's hoptell MCP server is the one in Codex's
`config.toml` (`[mcp_servers.hoptell]`), which can be another hoptell install than the one that
runs `team up`; `team up` warns when it is, and names both.

**Up, status, stop, restart, down.**

```sh
hoptell team up team.json --dry-run   # every worktree add and tmux command it would run
hoptell team up team.json             # asks you, since implementers can write; --yes answers yes
hoptell team status n11
hoptell team stop alice-n11-impl-1    # before you commit, diff or land its work
hoptell team restart alice-n11-impl-1 # a fresh session in the same worktree, same task
hoptell team down n11                 # stops everyone; removes what is safe to remove
```

`up` makes every implementer's worktree first and then starts each member in tmux with the role
`<role>,<team>` (so `@n11` reaches the whole team), its preset flags, role template and task.
Members run in your terminal with your account, like any `hoptell tmux` session. `status` shows
each member's state, CLI, the model and effort it was started with, its branch and commits, and
uncommitted changes; it runs git only while no implementer runs. `stop`, `restart` and `down` act
on the tmux session id and the process hoptell recorded at launch, never on a name pattern; a
session someone else replaced under the same name is left alone. A session is ended only while
its pane's process is still the one hoptell recorded; when hoptell cannot tell, it sends no
signal and says so. `restart` starts the CLI fresh (no conversation is resumed) and tells it its
branch and head. `down` removes a worktree only when the member is confirmed stopped and the
worktree is clean, and its branch only when nothing on it is unlanded; whatever it keeps, it
names; `down --keep-worktrees` stops the members and removes no worktree or branch. A team whose
stops are not all confirmed stays `stopping`, and `down` can be run again. A member name belongs
to one active team; a team that is down keeps its landing history.

A team is `starting` while `up` starts its members, `up` once all started, `partial` (shown as
"partly started") when some did not start, `stopping` while a `down` has stops not confirmed, and
`down` once every member is stopped. In `team status` a member is `not started`, `running`,
`exited`, `ended (<reason>)` or `unknown`. `ended (<reason>)` means the supervisor ended it for
idleness or lifetime; a confirmed manual stop shows as `exited`. `unknown` means hoptell cannot
confirm that process's state and sends it no signal; an unknown implementer also blocks the
commands that run git in its repository.

**Lifetimes and idle reviewers.** With `lifetimeMinutes` (team-wide or per member) or
`idleMinutes.reviewer`, `up` starts a supervisor in its own tmux session. A reviewer whose pane
printed nothing and who had no waiting message for `idleMinutes` is ended; any member is ended at
the end of its lifetime. Implementers are never ended for idleness. The supervisor first shows a
notice in the member's pane, ends it a minute later by its session id, and tells the lead once the
end is confirmed; a stop that did not work is noted and tried again. The supervisor is a hoptell
session of its own named `<prefix>-<team>-supervisor` (`alice-n11-supervisor`): its messages to
the lead come from that name. A reviewer whose CLI keeps
redrawing its screen counts as active, and so does one whose activity tmux cannot report.

**Review requests.** The lead asks the team's reviewers to review a member's commits and records
their verdicts:

```sh
hoptell review request --team n11 --base <commit> --head <commit> [--to alice-n11-rev-1]
hoptell review verdict --team n11 rv-1a2b3c4d alice-n11-rev-1 approve    # or changes
```

`review request` takes full commit ids that hoptell recorded in one member's worktree (its base or
a `hoptell worktree commit`), `--base` before `--head`, or exactly the target's commit `T` and the
candidate `C` of the team's landing candidate (`--base T --head C`), and reviewers of that team. It records the
request (an `rv-` id, base, head, member, reviewers asked) in the team's state first, then sends
it to each reviewer as `hoptell send` would. The request tells reviewers to read the range with
`git -C <repo> diff --no-ext-diff --no-textconv <base> <head>`, so no external diff program or
textconv filter of the repository runs for them. A send that fails leaves the request recorded and
prints its text. `review verdict` records what a reviewer replied, for that request's head only;
request ids are unique within a team, so it names the team. hoptell never reads a verdict out of a
message. `team status` lists the open requests and who has not answered, and the verdicts of the
latest finished one. A team keeps up to 200 requests: answered ones make room, and a new request
is refused while all 200 are open. Each reviewer's latest verdict is always kept. A fresh
`team up` starts an empty queue. A verdict is a review, not your approval.

**Team status in Telegram.** The lead's hoptell session publishes a short summary of the teams it
leads as its own status at the relay: each team's name and state, and per member its name, role,
CLI, the model and effort it was started with (shown only when set at launch) and state, plus
the open review requests and who has not answered. A member's state is `working`, `ready` (the
lead committed its work and has not asked for a review of it yet), `in review`, `approved` (every
reviewer asked approved its latest commit), `exited` or `unknown` (hoptell cannot tell whether it
still runs); a reviewer is `in review` while a request waits for its verdict, else `ready`. A
review is shown only when its member and the reviewers it waits for are in the team's list. The session updates the summary every 30 seconds while it leads a team
that is not down, and clears it when it leads none. A separate process reads the team states and
the process table for it and is ended after 5 seconds, so the session itself never waits for that
work. Team commands never wait for it either, and a relay
that refuses it changes nothing else. `/team` in the bot chat and the Teams tab of the app show
these summaries. Each team is shown under the session that published it; a member name that two
sessions both claim is shown under neither. Nothing in this view grants anything or can be
tapped. The relay lists a summary only to sessions of your own member that ask for it (your bridge),
never to other members or to shared-token sessions. It needs a relay with the `status` capability
(0.4.0); with an older relay, nothing is published and `/team` says that the server needs an
update.

**Landing.** The lead prepares a landing, and only you decide it. The lead may prepare a
candidate signed with the key you configured for the repository, and only your separate decision,
or an auto-land grant you gave, lets hoptell land it. The signature shows that the candidate was made with your key, not that
you decided anything: hoptell's own code uses the key only in `team land --target`, but a key
without a passphrase or a presence check can be used by any process of yours, your agents
included. Your decision is typed in your terminal, and typing `land` proves that a process typed
it, not that a person is present. The lead's route, then your one visit:

```sh
$ hoptell team stop alice-n11-impl-1
$ hoptell worktree commit alice-n11-impl-1 -m "Validate the settings file"
$ hoptell team land alice-n11-impl-1 --target main -m "Validate the settings file (n11)" --prepare
alice-n11-impl-1: exited.
Candidate 19380d22...7892 on main (at 96789d8a...28b7), signed and verified; squash of alice-n11-impl-1 at 893eb789...29f.
...
$ hoptell team evidence alice-n11-impl-1 --candidate 19380d22...7892 --tests pass --command "npm test" --report test.log
$ hoptell review request --team n11 --base 96789d8a...28b7 --head 19380d22...7892
$ hoptell review verdict --team n11 rv-1a2b3c4d alice-n11-rev-1 approve
$ hoptell team land alice-n11-impl-1 --request-approval
Landing L7: 19380d22...7892 on main (at 96789d8a...28b7), checked out in /srv/src/app; tests pass, review rv-1a2b3c4d: alice-n11-rev-1 approve.
The owner decides it in a terminal before 2026-10-29T10:15:00.000Z: hoptell team approve L7
```

The member's work is landed from its commits: stop it and commit what its worktree holds first
(`--prepare` never commits by itself). `--prepare` stops the member's session (by its recorded id;
another implementer of the repository that still runs stops the command) and makes the candidate.
When the target moved since the member started (another member landed), the candidate is the
member's change re-based onto the target, only when the two touch no common path (a file that
became a folder counts); otherwise it is refused, naming the paths. Either way the tests and the
review are of exactly `T..C`, never of the member's own commits. The lead tests exactly `C` in a
folder of its own and records the result with `team evidence`: the full `C`, which must be the
member's current candidate, `pass` or `fail`, each command it ran, and the report (a text file of
at most 64 KiB, stored by its digest). "pass" is the lead's claim, and a reviewer's verdict is a
reviewer's: neither signature nor hoptell makes either true. `--request-approval` works only when
evidence for exactly `C` is recorded and every reviewer asked in a review request of `T..C` has
answered. It freezes the evidence in the landing action's manifest (C's subject, the diffstat, the
patch, the test report and the verdicts, each with its digest) and prints the id. Then, in your
terminal:

```sh
$ hoptell team approve L7
Landing L7 of alice-n11-impl-1 (team n11) in /srv/src/app
  target     main, checked out in /srv/src/app (fast-forwarded there)
  candidate  19380d22...7892
  on         96789d8a...28b7
  subject    Validate the settings file (n11)
  tests      pass (the lead's report 5f0c2e9a41b7, 812 bytes): npm test
  reviews    review rv-1a2b3c4d: alice-n11-rev-1 approve
  patch      1311 bytes: hoptell team approve L7 --show-diff prints it
  expires    2026-10-29T10:15:00.000Z
   lib/x.js | 2 +-
   1 file changed, 1 insertion(+), 1 deletion(-)
The test result and the verdicts come from agents: they are claims, not proof. Typing land below decides this landing and runs it now.
Land L7 (19380d22...7892 on main)? Type land to confirm: land
Landed 19380d22...7892 on main (was 96789d8a...28b7), landing L7.
  worktree removed; branch team/n11/alice-n11-impl-1 deleted
```

`--show-diff` prints the frozen patch and changes nothing. A patch larger than 64 KiB, or one
whose record would grow past 90,000 bytes, is never cut: it is marked too large to show, and
`--show-diff` gives the record's path and the git command that shows `T..C` on your Mac. Failed
tests or a reviewer's "changes" are shown as such, and you may still land; a dirty checkout, two
checkouts of the target or an unknown outcome are refusals that no decision passes. A request is
for exactly its evidence: new evidence, a later verdict of its review, a new request or
`--discard` supersedes a request you have not decided, and a new candidate or `--discard` clears
the evidence. A request expires 15 minutes after it was made; `team approve` then says so and
asks you to have the lead request it again.

**From Telegram.** When your Telegram owner channel is set up and its bridge is up to date,
`--request-approval` also sends the request to the bridge, and prints:

```sh
Sent to the owner's Telegram. The owner decides it there, or in a terminal (hoptell team approve L7), before 2026-10-29T10:15:00.000Z.
When the owner's decision arrives in your inbox, run: hoptell team apply L7
```

The bridge checks the request itself (every digest again from its bytes, and the action's
digest from the manifest) and shows it as a card: what lands where, the tests and the verdicts,
the diffstat and the deadline, with **Land L7**, **Reject** and **Show diff**. Show diff sends
the frozen patch as an `L7.patch` file in the same chat; a patch too large to keep in the
request says "too large to show here; review it on the Mac". Your tap is signed with the
bridge's key and goes only to the lead's session, whose hoptell keeps the signed bytes next to
the action. The lead then runs `hoptell team apply L7`: it verifies that decision again against
the pin your Mac trusts, and lands it, or ends the action as rejected. A tap counts only before
the request expires, and `apply` works for 15 minutes after the tap; the target, the commits,
the mode and the checkout are checked again before anything moves, as with `team approve`. The
first decision hoptell records wins, in Telegram or in your terminal: a decision you confirm in
a terminal is recorded before the landing waits for the repository, a later tap is not used,
and `team approve` shows a tap that was already kept instead of asking again. The card shows
how the landing ended.
A message that only claims to be your decision, or a decision for another action, moves
nothing. With an older bridge, or with the bridge offline, `--request-approval` says "landing
approval needs a bridge update; use hoptell team approve in a terminal", and the request waits
for your terminal.

**Auto-land.** When you choose, landings of one team run go without a decision per landing:

```sh
$ hoptell team autoland n11 --target main --for 2h
While auto-land is on, the lead lands reviewed and tested work of team n11 (this run, in /Users/alice/src/app) on main without asking you, for 2 h. The reviewers' verdicts and the lead's test report become the only gate, and both come from agents.
It does not bypass a protected branch, a dirty checkout or any other safety check, and it is not a hardware presence check: given here, it is policy only (any process of yours could type it).
Turn auto-land on? Type autoland to confirm: autoland
Auto-land is on for team n11 on main until 2026-10-29T14:00:00.000Z. Turn it off with: hoptell team autoland n11 --off
```

While a grant is on, `--request-approval` lands at once when the lead's tests passed and every
reviewer asked approved exactly `T..C`, and the target is one the grant names; each landing is
still its own action with its own record, and your Telegram gets a notice ("L9 landed on main
under your auto-land for team n11 (1 h 20 min left)") instead of a card, one message per landing
and outcome. Failed tests, a "changes" verdict or another target go to you as a normal request,
whose card says why it wasn't auto-landed. Like the CLIs' bypass
modes, auto-land trusts the agents: the reviewers' verdicts and the lead's test report become the
only gate, and both come from agents. It does not bypass a dirty or ambiguous checkout, a moved
target, an unknown outcome or a protected branch on a remote, and it is not a hardware presence
check. A grant is for one team run and its repository (`team down` ends it), lasts at most 24
hours (2 hours by default), names its targets once, and may limit the number of landings
(`--count`). Given in a terminal it is policy only, like `team approve`: a process of yours could
type it; only a grant given on Telegram is signed by your bridge. `hoptell team autoland n11 --off`
revokes every grant of the team at once, also one given on Telegram that this Mac has not
received yet, whatever the clocks say (each grant names the revocation it was given after); a
landing already moving finishes or is reconciled. `hoptell team status` shows the grant and the time left. A notice the bridge cannot
take yet is kept and sent by a later team command; it never causes a move. The bridge keeps each
notice it took until Telegram shows it (while Telegram is not connected, or the bot is blocked),
up to 2,000 from all your teams and Macs, and shows it only to the Telegram account it came
under: if another account pairs meanwhile, it never sees them, and they are shown once the first
account pairs again. With 2,000 waiting, later messages to the bridge (cards and notes too) wait
at the hoptell server until one of them is shown.

On Telegram, a card from an up-to-date lead also has **Land this and auto-land n11 for 2 h**: one
tap sends the decision for this landing and, after it, a grant signed by your bridge for the
same team run and target, for 2 hours from the tap, with no count. The lead's hoptell keeps the
grant only if it is still for the team's current run and repository and was given after the last
`--off`; otherwise it refuses it, and Telegram says so ("Auto-land for team n11 not turned on: it
was given before auto-land was last turned off; give it again from a newer card or in a
terminal"). When it is kept, Telegram shows "Auto-land on: team n11, main, 2 h" and the lead's
session is told. Each message counts on its own: the decision lands this request even if the
grant never arrives, and a grant that arrives alone covers only the landings after it.

`/autoland` in the bot chat offers the teams whose lead asked you to land something in the last
24 hours: one confirmation each, with the repository, the team, every branch it asked for and
"2 h", and **Grant for 2 h** or **Cancel**. Grant sends a grant signed by your bridge to that
lead for exactly what the confirmation showed; if the team asked for more while it was open, the
confirmation is shown again with the new branches and needs a new tap. It has the same checks on
the Mac as the card button. With no recent request, it gives the terminal command instead.
`/autoland off` sends a signed revocation to every lead session that asked you something in the
last two days, and to every lead your bridge gave a grant that may still be valid; each one's
hoptell turns auto-land off for every team on its Mac, as `hoptell team autoland <team> --off`
does, and Telegram shows "revocation pending" until each Mac answers, once each, "Auto-land is
off for every team on the Mac of lead (n4, n5)". A revocation that arrives twice, even days later,
changes nothing the second time; after an unusual number of them (2,000 within about eight
days), a Mac pauses auto-land, refusing new grants, until the oldest one it had to let go can no
longer arrive (at most about eight days). A
Mac that is offline sees it only once it is back; with none seen, `/autoland off` gives the
terminal command. If the bridge had too many leads to keep track of, the reply says it may not
reach every Mac and gives the terminal command for the others. After very many recent `/autoland
off` (256 still awaiting confirmation), a new one is still sent, and its reply says its
confirmations will not be shown.

You can also land by hand, with the manual route: you make the candidate, the lead runs the tests
on it and has the reviewers review `T..C`, and then you approve exactly that pair. Stop every
implementer of the repository first. In this example `main` is not checked out in any worktree
(yours is on another branch); the case where it is follows below:

```sh
$ hoptell team land alice-n11-impl-1 --target main -m "Validate the settings file (n11)"
Candidate 19380d22...7892 on main (at 96789d8a...28b7), signed and verified; squash of alice-n11-impl-1 at 893eb789...29f.
 lib/x.js | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
Next: run the tests on the candidate, have the reviewers review it
  hoptell review request --team n11 --base 96789d8a...28b7 --head 19380d22...7892
  (they read git diff --no-ext-diff --no-textconv 96789d8a...28b7 19380d22...7892)
then the owner lands it in a terminal: hoptell team land alice-n11-impl-1 --approve 96789d8a...28b7 19380d22...7892
$ hoptell team land alice-n11-impl-1 --approve 96789d8a...28b7 19380d22...7892
Land 19380d22...7892 on its target (now 96789d8a...28b7)? Type land to confirm: land
Landed 19380d22...7892 on main (was 96789d8a...28b7), landing L1.
  worktree removed; branch team/n11/alice-n11-impl-1 deleted
```

(Commit ids shortened here; hoptell prints and takes them in full.) To run the tests on `C`,
check it out in a folder of its own: `git worktree add --detach <dir> <C>`, test there, then
`git worktree remove <dir>`. That is your own git, outside hoptell's checks. The candidate `C` is one
commit, signed with your SSH key, whose tree is the member's reviewed head and whose parent is the
target's commit `T`; it is made only while the target is still at the team's base, and kept on
`team/<team>/land`. hoptell verifies its signature before it shows it to you and again before it
lands. `--approve T C` lands exactly that pair, and only while the member's head is still the one
the candidate was made from and the candidate branch still points at `C`. hoptell moves the
target only by a compare-and-swap of `refs/heads/<target>` from `T` to `C`: if the target is at
any other commit at that moment, even an older one, nothing moves. It then reads the target back
and checks that it is at `C`.

When the target is checked out in a worktree (usually your main folder is on `main`), hoptell
fast-forwards that checkout itself, with `git merge --ff-only --no-autostash --no-overwrite-ignore
--no-verify C` and its own hardened git (no hooks, filters, external diff or textconv, no submodule
recursion). It does so only when exactly one worktree has the target checked out, and that folder
is a worktree of the repository the team enrolled at `team up` (its git folder leads back to that
repository; a folder replaced by another clone gets no git at all), its `HEAD` is the target at
`T`, the index and the tracked files are clean, nothing is unmerged and no merge, rebase,
cherry-pick, revert or bisect is in progress there. Untracked and ignored files stay, unless the
landing adds a file where one of them is: then it stops, and hoptell never deletes or stashes them. Afterwards it
checks that `HEAD` is still the target, the target is exactly `C`, the index matches `C` and the
tree is clean. A checkout that is dirty, busy or not the only one stops the landing before
anything moves, and says what to fix; run the same `--approve` command again once it is fixed, and
hoptell moves it then. A decision made with `team approve` ends there: once it is fixed, the lead
requests the landing again and you approve the new id.

Every request and every approval is one landing action with an id (`L1`, `L2`, ...) that is never
reused in your hoptell home. hoptell writes its manifest once (`teams/<team>/landings/<id>/manifest.json`: the
repository, target, `T`, the member's head, `C`, the mode, the worktree it checks out, the
frozen evidence of a request and an expiry 15 minutes later), and records the action's state in the team's state: ready, approved,
accepted (the journal is written), moving (the move may have been tried), landed, finished; or
blocked, expired, superseded or abandoned. An action that ends keeps a record next to its manifest
(`final.json`), also after `team down`; hoptell checks that record strictly, and one that is
malformed or belongs to another action stops the command. A manifest whose run stopped before
any decision was recorded is listed by `team status` as orphaned: nothing acts on it, its id is
not used again, and you remove it by hand when you like. A decision that did not start within 15 minutes expires, and the next
`--approve` is a new action. Once an action is moving, hoptell never moves the target again under
it. If a run stops or git fails while it moves, a later run only reads what happened: a target at
`C` with a clean checkout finishes the landing; anything else is an unknown outcome. Then the
action stays blocked, hoptell resets nothing, and `--confirm` is how you record the landing after
you checked it. If it did not land and you want to give it up, `hoptell team land <member>
--abandon <id>` (in your terminal, typing `abandon`) shows what the target and its checkout look
like now, without concluding anything from it, and ends the action for good: its record says
`abandoned`, with what it was for and what hoptell saw. It moves, merges and resets nothing,
records no landing, and keeps the candidate and the worktree (`--discard` then drops the
candidate and keeps the worktree). A new landing needs a new decision. Only when the target is still at `T` and its one checkout is clean does hoptell
print a line to paste in that folder:

```sh
main is still at 96789d8a...28b7 and /srv/src/app is clean. Check what happened there first; to land it by hand, run the line below in that folder: it checks again that HEAD is refs/heads/main at 96789d8a...28b7, and fast-forwards only when both checks pass.
  cd /srv/src/app
  test "$(git symbolic-ref HEAD)" = refs/heads/main && test "$(git rev-parse HEAD)" = 96789d8a...28b7 && git merge --ff-only 19380d22...7892
then record it: hoptell team land alice-n11-impl-1 --confirm 96789d8a...28b7 19380d22...7892
```

`--confirm T C` records the landing only when the target is exactly at `C`, `C` is still the
verified candidate (parent `T`, the member's tree, a good signature) and a checkout of the target,
if there is one, is the only one, on the target at `C` and clean. hoptell runs no merge and
resolves no conflicts: it re-bases a change onto a moved target only when no path overlaps, and
otherwise you land by hand. `--discard` drops a candidate.

hoptell holds its own lock while it lands, but it cannot lock out git commands you run yourself
at the same time. If a worktree checks out the target in the moment between hoptell's check and
its move, the branch moves but that worktree's index and files do not: they still hold `T`, so
`git status` there shows the landed change as undone. hoptell then does not finish the landing:
the action stays blocked with the candidate and the worktree, and the message says so.
`git read-tree -m -u T C` in that worktree brings it to `C` and keeps your own changes; then
`--confirm` records the landing. A checkout that appears already at `C` and clean is fine, and
the result names it. The
fast-forward of a checked-out target has gaps of its own: an editor that writes a file after the
clean check, `HEAD` switching to another branch at the same commit, and git changing the files
before it updates the ref. It suits a quiet repository; it is not free of races. Avoid running
git in the repository while a landing runs.

hoptell records which member head landed as which commit on which target, and keeps the evidence
until that record is written. Before the target moves, it writes a journal of the landing
(repository, member, head, target, `T`, `C`, the action) to the team's state. It records the
landing once the target is at `C`. Only then does it delete the candidate branch and remove the
worktree. If a step fails or the process stops on the way, the same `hoptell team land` command
finishes the landing. For a target that is not checked out, the journal is dropped only when the
target certainly did not move: git refused the compare-and-swap, and the target reads back at
another commit than `C`. A signal, a failed read or a target that reads `C` keeps it, with the
action blocked. A team started with an older hoptell lands nothing new: discard its candidate
(`--discard`), run `team down` and `team up` again, and build the candidate again; a landing it
already had pending still finishes with the same command. Publishing the candidate works the same way: hoptell journals the candidate before
it creates `team/<team>/land`, and the same `--target` command (or `--discard`) finishes a
publication that stopped half-way. A branch whose read fails is never taken for a branch that is
gone, and neither is one that git skips with a warning. hoptell never follows a symbolic ref:
a target, candidate branch or member branch that is one stops the command, and every ref update
it makes acts on the ref itself (`--no-deref`). A landing acts only on the worktree its team
registered: if the member's record now names another repository or worktree (a name reused
elsewhere), approve, discard and the rerun of a publication refuse and change nothing; `team
down` keeps such a worktree instead of removing it, and `team status` and `team restart` do not
use it.
`hoptell worktree add` and `remove` refuse a member name whose landing is pending in any team,
active or down. While a landing is pending,
or a candidate was neither approved nor discarded, `hoptell team down` stops the team's sessions
but keeps that member's worktree, candidate and journal, and says which command resolves it;
`--approve`, `--confirm` and `--discard` still reach the member of a team that is down. `hoptell
team up` of that team, or of a team with that member, waits until it is resolved.
The member's worktree and branch are removed only when the worktree is clean, the branch is still
at the head that landed, and the landed commit is in the target; hoptell never decides that
something landed by comparing patches.

Landing needs SSH commit signing set in the repository's own config when the worktree was added
(`gpg.format ssh`, `user.signingkey`, `gpg.ssh.allowedSignersFile`); a repository without it can
use teams, but you land its work yourself. hoptell runs `ssh-keygen` from a fixed path (`/usr/bin`,
`/bin`, `/usr/local/bin` or `/opt/homebrew/bin`) and passes your `SSH_AUTH_SOCK` only to the signing step.
`hoptell worktree remove` after a landing deletes the branch by the same rule.

## Spawning agents

An agent session of yours can start another agent on the same machine for one task, within
limits you set in advance. Only one setup is enabled: Codex in headless mode with its
`read-only` sandbox, on the tested Codex 0.164.0 build. Before each run, hoptell checks the
installed Codex files against that build and refuses others, unless you approved that exact
binary (see "Other Codex builds" below). Other CLIs, Codex in tmux and other argument shapes are
refused too.

**Other Codex builds.** Users update Codex, so a build hoptell has not gate-tested can run in the
`plain` mode after you approve that exact binary once: `hoptell agents trust-cli <profile>` shows
the Codex version, its launcher and native binary digests, the features that are new or whose
default changed against the tested build, and the checks below. It approves only after you type
`trust` in a terminal. At every spawn of an approved untested binary, hoptell checks again that
the help of `codex exec` still lists the flags the adapter uses, that `codex features list` with
the run's overrides shows every feature hoptell turns off as off and no feature on that was not
on in a gated build, and that no local managed Codex configuration (`/etc/codex`, and on macOS the
`com.openai.codex` managed preferences) is present. If any check fails, the spawn is refused, even
for an approved binary. The approval does not cover what only a gate run observes: the sandbox,
the approvals and the tool catalog. As for tested builds, the plain mode does not check
cloud-delivered Codex configuration. An update is a new binary and needs a new approval.
`hoptell agents trust-cli --list` lists approvals, and `--revoke <digest prefix>` removes one.
No MCP tool, peer message or setting can approve a binary. The command also refuses inside an
agent run and without a terminal, but that is a second line of defense, not the boundary.
Path-deny hardening never runs on an untested binary. Runs on one are marked "untested CLI,
approved by you" in `hoptell agents list`, in the run log and in the audit log.

**Profiles.** A profile is a JSON file you write in `~/.hoptell/agents/profiles/<id>.json`
(schema: `schema/agent-profile.schema.json`). It names the CLI, the mode and sandbox, the folders a
run may work in, the relays and roles the run gets, which sessions may use it (`spawners`),
whether you confirm each run (`confirm`), and limits: live runs, runs per hour, lifetime (30
minutes by default, at most 240 in headless mode), task size and result size. hoptell uses a
profile only while its content is exactly what you approved. After any edit, approve it again.

**Approving.** `hoptell agents profiles` lists your profiles and their state, and `hoptell ui`
shows the same view with the command line hoptell will run. For a Codex profile, `hoptell agents
profile approve <id>` first prints this warning and approves nothing:

> Spawned Codex runs use your macOS account. A run may read account-readable files, including
> relay member tokens and the sealed MLS device record. It could send a token in a hoptell
> message or its result even when direct shell writes and network access are denied. Anyone with
> that token can sign in as your member. Approve this profile only if you trust the tasks you
> assign and the files the run may read. Access to the Keychain and the device-state sealing key
> has not been tested.

After reading it, approve the profile with `hoptell agents profile approve <id> --accept-read-risk`.
`hoptell ui` shows the warning above its approve button.

**Running.** When a profile exists as an agent session starts, its hoptell MCP server offers
`spawn_agent`, `list_agents` and `stop_agent`. MCP over HTTP offers them only to clients added with
`hoptell mcp-http client add <label> --agents`, and hosted endpoints never offer them. The task goes
to the new agent on standard input, and a Codex run's working folder must be inside a Git work tree.

When the run ends, hoptell attempts to send the result to the spawning session as a peer message; if
delivery fails, the result stays available locally, and `hoptell agents result <run>` prints it.

With `"confirm": "always"`, a run waits for you: `hoptell agents confirm <run> --start` or
`--discard`, or `hoptell ui`. The default is `always` when a granted relay is not classified as
local; hoptell classifies an install-created entry or one named `local` as local. Otherwise, for a
read-only profile on your local relay, approving the profile is the only check: any of your agent
sessions can start its runs with tasks you never see, and a peer's message can influence those
tasks. Set `"confirm": "always"` on a profile when you want to confirm each run. A run waiting for
confirmation expires after an hour and is marked discarded at the next cleanup.

`hoptell agents list` shows runs, and `hoptell agents stop <run>` stops any run; `stop_agent` stops
only runs that the same session started (after a session restarts, stop its earlier runs with the
CLI).

**What a run can't do.** A run gets its own hoptell MCP server with six tools: `list_peers`,
`send_message`, `wait_for_message`, `read_inbox`, `ack_messages` and `read_task`. It can't spawn
agents, use `ask_owner`, see or answer your pending decisions, or send encrypted messages. Codex's
`read-only` sandbox denies its shell writes and network access. At the end of its lifetime, or when
you stop it, hoptell attempts to stop the run and its recorded descendants; it reports any it
cannot confirm stopped. Its messages, including its result, are peer messages, never your approval.
In `plain` mode, Codex can start a sub-agent. In real-spawn tests, a fresh Codex sub-agent received
the run-only hoptell tools, and its command writes and network requests were denied. If your
encryption policy for your own member is `required`, spawning is refused and results are not sent;
`hoptell agents result <run>` still prints them.

The hoptell tools limit what hoptell gives a run, not what the process can read: as the warning
says, a run uses your account. Use spawning only for tasks and folders you would trust with your
hoptell files.

**Path-deny hardening (opt-in, codex-cli 0.164.0 only).** A read-only Codex headless profile can
set `"codex": {"headlessMode": "hardening"}`. Changing the mode changes the profile, so you approve
it again. In this mode hoptell starts Codex with a per-run permission profile that asks Codex's OS
sandbox to deny reads of the hoptell home, your relays file and the token files it names, and
CODEX_HOME. Writes and network access stay denied, as in `plain`, and Codex sub-agents are turned
off. The mode is available only on the exact Codex 0.164.0 binaries of its gate record; any other
version is refused (`adapter_gate_unverified`).

What was tested: hoptell's gate run showed Codex's sandbox enforcing this profile for commands
and tools that a scripted test model called. The read checks used a local test model provider,
because the production model declines to probe these paths; the production model and provider
were not tested on these reads.

It is hardening, not containment:
- the run still uses your account and can read whatever else your account can read;
- Codex adds a read entry for its own per-session helper folder inside CODEX_HOME
  (`<CODEX_HOME>/tmp/arg0/...`), and a file placed there was readable;
- workspace-managed Codex configuration can change what applies. When Codex's cloud-config
  output is not the expected report of none, hoptell adds a note to the run's result and keeps the
  run going;
- other processes running as you are not affected.

Without the field, a profile uses `plain`, the mode described above.

## The owner channel over Telegram

Your agents can ask you a question with the `ask_owner` tool, and you can send them instructions,
from a Telegram chat on your phone. One bot serves your agents on every machine: a single
process, the bridge (`hoptell telegram run`), polls the bot and talks to your agents through the
relay as a peer of your own member. It is off until you set it up.

**Before you start.** You need a bot of your own: create one with Telegram's
[@BotFather](https://t.me/BotFather) and copy its token. The bridge needs a member token (not a
shared token) on a relay that supports the recipient check (`to_member`); the relay of this
version does, and an older relay must be upgraded first. Buttons and agent commands also need the
relay to confirm which agents are yours (`list_own`, the same version). Telegram is a third party,
and bot chats are not end-to-end encrypted: read
[The owner channel over Telegram](PRIVACY.md#the-owner-channel-over-telegram) in PRIVACY.md, and
never put secrets in a question.

**Setup (the bridge machine).**

```
hoptell telegram setup [--relay <alias>] [--name owner] < token.txt   # the token on standard input only
hoptell telegram run                                                    # keep it running
hoptell telegram pair                                                   # prints a one-time code
```

`setup` checks the bot with Telegram and stores the token in the OS keychain (or the encrypted
credential file). The first setup also creates the bridge's signing key there and prints its pin; a
setup with a new token for the same bot keeps the key and every pin. The bridge joins the relay
under its own name (`owner`, with the relay's name prefix, such as `me-owner`). If a webhook is set
on the bot, `setup` and `run` stop: hoptell never deletes it. One bridge per bot: a second poller
makes the bridge stop, not compete.

**Pairing.** `hoptell telegram pair` prints a code that works once, for 10 minutes. Send
`/start <code>` to your bot from your own account, in a private chat, while the bridge runs. That
binds your Telegram user id and that chat. Everything from any other user, group or chat is
dropped without an answer. The code is not case-sensitive. A wrong code gets no answer, and five
wrong codes void it.

**Trust (each agent machine).** Run the printed `hoptell telegram trust '<pin>'` on every machine
whose agents use the channel (setup trusts it on its own machine). Only a message signed with a
trusted bridge key is shown to an agent as yours. Without a pin, `ask_owner` is not offered.
Contacts do not hold these signed messages: an answer, instruction or status that the agent's
machine verified with a trusted key, sent by a session of your own member, reaches the agent
without a grant while your contacts file is valid. A block of your own member, or an encryption
policy of `required` for it, still applies. Other eligible messages from your own member also skip
the default hold unless `HOPTELL_CONTACTS_SELF=hold`; see
[Contacts](#contacts-who-may-reach-your-sessions).

**Questions.** An agent calls `ask_owner` with a question, optional choices (2 to 6) and an
expiry. You get a numbered card naming the agent ("❓ Question 3 · alice asks:"). Answer by
replying to the card, or tap a choice. The first answer is used, and the card is marked as
answered. Once your answer has been sent to the agent, the bot adds a 👍 to your reply or shows
"✅ Sent." after a button tap. The agent receives your answer as a message with the
Sender line "your owner, through the owner channel …". An unanswered question expires, and the
agent is told.

**Instructions and targeting.** Any of these sends a signed instruction to one of your own
agents:

- type your message without choosing first: the bot asks "Who is this for?" with your agents as
  buttons. Tap an agent to send the message. If an agent you named is now on another computer, the
  bot asks you to confirm first. `Cancel` drops the message. The buttons expire after 10 minutes;
  the bridge deletes any expired text at its next housekeeping pass;
- `/msg`, tap an agent's name, then reply to the prompt that opens;
- a favourite's own command from the bot's menu: `/<agent>` opens the same prompt, and
  `/<agent> <text>` sends at once;
- `@<name> <text>`, with the agent's name with or without the relay's prefix;
- a reply to a bot message about one agent (a prompt, a note from that agent, a "✅ Sent to …"
  confirmation or a "Not sent" message), or to your own earlier message to an agent.

Once the bridge has sent your message, it puts a 👍 on it (if Telegram refuses the reaction, it
replies "✅ Sent to <agent>." instead). The bridge finds the agent from the message you replied to,
never from that message's text: a reply to a forwarded or copied message, or to one the bridge no
longer knows, is not sent, and the bot answers "I can't tell who that message was for."

A reply to a question card that is already closed asks first: tap "Send to <agent>" within 10
minutes to send it as a new instruction. Tapping an agent's name and a bare `/<agent>` only open a
prompt; the explicit "Send to <agent>" tap sends your stored reply as an instruction. `@all` and
roles are not supported, and only your own member's agents can be reached: the relay checks the
recipient before delivery.

**Talking with your agents.** `/msg`, `/agents` and "Who is this for?" show one list of at most
10 agents.

- The list shows your favourites first (online ones, then the ones away), then up to 5 agents
  you talked with in the last 7 days, then the other agents online, newest first. `More…` pages
  through all of them, 8 at a time, and `🔍 Search` finds an agent by part of its name, hidden
  ones included.
- `/agents` shows how many favourites you have and how many agents are online. Tap an agent to
  see its details (🟢 Online or ⚪ Away, the computer it runs on, the time of the last message)
  with buttons to message it, add it as a favourite, rename it or hide it.
- A name you give an agent is only a label in your chat: messages still go to the agent's real
  name, and `@<name>` always means the real name.
- Hidden agents stay out of the list. Their new notes are skipped and won't appear later;
  questions from them still arrive. Search finds them, and `👁️ Show agent` or adding them as a
  favourite shows them again.
- When you named an agent and its name is later used on another computer, its button shows ⚠️
  and the bot asks before it sends ("⚠️ … reports running on … (previously …). Send once, or
  remember this computer?"): `Send once` sends this message once, `Remember & send` also accepts
  the new computer, and `Cancel` sends nothing. This is a hint: the relay still delivers only to
  your own member's agents.
- Favourites, names and hidden agents are kept on the bridge machine (`people.json`), for your
  Telegram account only: if another account pairs, it starts with none.

**Agents writing to you.** An agent can send you a short note with `send_message` to the
bridge's name (such as `me-owner`).

- Notes are text only, sent by name; the relay delivers them only to your own member's bridge.
  Files and roles are refused.
- A note shows as "💬 <agent>:" and its text, cut at 3,000 characters.
- It notifies you if the agent is a favourite, if you wrote to it in the last hour, or if it
  answers one of your messages from the last 7 days, up to 1,000 of them (it then appears as a
  reply).
- Reply to a note to answer that agent, for up to 24 hours. A note sent with `hoptell send`
  outside an agent session can't be answered.
- Limits: 10 notes per 10 minutes and 30 per hour per agent, 60 per hour from all agents. Extra
  notes are not shown; the bot warns in the chat, and the agent receives a status, at most once
  an hour.
- Notes from a hidden agent are not shown and won't appear later, and the agent is told (at most
  once an hour).

For a question, or a milestone you must see, agents use `ask_owner`: a note is best effort,
while a question stays open in `/pending`.

**Commands.** The bot's menu is set for your paired chat only.

- It holds `/msg` (pick an agent), `/agents` (your agents and favourites; `/peers` still works
  the same way), `/team` (your agent teams, see "Team status in Telegram" in "Agent teams"),
  `/pending` (open questions, oldest first: number, agent, the start of the
  question and its age; 8 per page, with a button to show a question's card again), `/help`
  and, when the app is on, `/app`.
- Then it has one command per favourite, online or not: its name, lower-cased, with `-` as `_`
  (`me-Big-Bot` becomes `/big_bot`).
- An agent gets no command when its name is longer than 32 characters or is a reserved word, or
  when two agents' names give the same command (`alice` and `Alice`, `my-bot` and `my_bot`):
  then neither gets one while both are online and normally for at least 24 hours after one of
  them was last seen. The bridge checks your agents again before it acts on a command and
  refuses one that is ambiguous. After the collision clears, the command may reach the
  remaining agent; use `@<name> <text>` to name the recipient exactly, or `/msg` when the
  agent's button is shown.
- The menu shows at most 100 commands, the ones above and up to 95 favourites (94 with `/app`).
  It is updated within about a minute as agents come and go.

**The app.** A small app inside Telegram shows all your agents at once, grouped by computer, with
search, your open questions and your agent teams (read-only). Turn it on with `hoptell telegram app --on` (with the bridge
stopped), then open it from `📱 Open the app` under `/msg`, `/agents` and `/pending`, or with
`/app`. Your phone loads the app from your hoptell server, so it must be able to reach that server.
For a company server, connect to the company network or VPN. It needs a relay whose operator has
turned the app on (`HOPTELL_OWNER_APP=on`; the relay must be served over HTTPS). If
`HOPTELL_APP_URL` is unset, the app's link uses the relay's address when the bridge connects with
`wss://` and a host name. If the bridge connects another way, for example with `ws://` to the
relay's private address, set `HOPTELL_APP_URL` in the bridge's environment to the relay's public
HTTPS address, such as `HOPTELL_APP_URL=https://hoptell.example.com`. Restart the bridge after
changing this setting. Without a usable address the bot shows no app button, and `/app` explains
what to set.

- Sends from the app ask for a tap in the chat first: the message appears in the chat with
  `Send to <agent>` and `Cancel`, and nothing reaches the agent until you tap Send. Unsent drafts
  expire after 10 minutes, and you can have 3 waiting at a time.
- Settings changed in the app (favourites, names, hidden agents) are listed in the chat with an
  `Undo` button. A change takes effect only once its line is in the chat.
- To answer a question, tap `Show in chat`: the question's card appears in the chat again.
- `/app off` in the chat turns the app off at once. With the bridge stopped, use `hoptell telegram
  app --off` to turn it off or `hoptell telegram app --rotate` to give it a new link. These CLI
  changes take effect when the bridge starts again; old links then stop working. `hoptell telegram
  app --status` shows whether the app is on. Drafts and `Undo` buttons already in the chat keep
  working until they expire.
- Only you can open it: Telegram signs who opened it, and the bridge checks that it is the Telegram
  account connected to this bot. Anyone who controls your hoptell server or its HTTPS endpoint can
  change what the app shows. Messages drafted in the app need your confirmation in the chat.
  Settings changes appear there with an Undo button.

**What it means.** A verified answer or instruction is your word for the agent's task. It never
approves a hoptell decision (contacts, devices, profiles, spawn confirmations) or a CLI permission
prompt. Statuses the bridge generates (expired, cancelled) are labelled as automatic.

**Status, unpairing and turning it off.**

- `hoptell telegram status` (and `hoptell doctor`) shows the bot, the run state, pairing, pins and
  counts, never the token, chat id or text.
- `hoptell telegram unpair` forgets the paired chat and tries to remove its command menu; if
  Telegram does not confirm the removal, the bridge tries again when it runs. Pair again with
  `hoptell telegram pair`. Your favourites, names and hidden agents are kept for the same Telegram
  account.
- `hoptell telegram unpair --all` (with the bridge stopped) tries to send cancellation statuses
  for open questions and to remove the menu, then clears the bridge's configuration, pairing and
  state, favourites, names and hidden agents, and tries to remove its token and signing key; check
  its output. If Telegram does not confirm the menu's removal, the command says so, and the next run
  of the same bot on this machine tries again.
- `hoptell telegram identity` shows the bot's name and descriptions as Telegram has them and the
  texts hoptell proposes; `hoptell telegram identity --apply` sets the ones that differ after you
  type `yes`. Add `--photo <file.jpg>` to request a profile photo upload (a JPG of at most 2 MB), or
  `--remove-photo` to request removal. The current photo isn't shown here. Photo changes also
  require `--apply` and confirmation; the requested change is applied on every confirmed run.
  The bridge never changes the bot's profile.
- To give the bot a profile photo, run `hoptell telegram identity --apply --photo <file.jpg>`, or
  send `/setuserpic` to @BotFather. The [hoptell icon](assets/icon.png) works (1024 × 1024);
  convert it to a JPG first, for example
  `sips -s format jpeg assets/icon.png --out icon.jpg`.
- `hoptell telegram fav <name>` and `unfav <name>` change your favourites, `hoptell telegram alias
  <name> <new name>` (or `--clear`) names an agent, and `hoptell telegram sessions` lists what is
  saved; run them on the bridge machine after pairing. `<name>` is the agent's name with or
  without the relay's prefix.
- Telegram and the Mini App label each agent with your alias. Without one, an agent that has a
  session title shows it first, with its name beside it (`Codex · hoptell (mac-61034)`). The
  title is shortened to 32 characters there. A title is self-reported and only a label: the
  name decides where a message goes.
- `hoptell telegram key next` and `key commit` rotate the signing key in stages; `trust --add`,
  `--remove-key` and `--revoke` manage pins.
- `HOPTELL_OWNER_CHANNEL=off` on an agent machine hides `ask_owner` and turns off verification:
  owner messages then show as ordinary peer messages.
- When your encryption policy for your own member is `required`, the owner channel does not run
  (it sends plaintext through the relay): `ask_owner` refuses, and `hoptell telegram run` exits
  with code 78, which a service manager should not restart on.

Telegram keeps undelivered updates for 24 hours: what you send while the bridge is down longer
than that is lost.

## Delivery modes in detail

Each MCP server chooses one delivery mode. Avoid registering hoptell twice in the same Claude
Code session. Unless `HOPTELL_PUSH` chooses one (`channel`, `hook`, `tmux` or `listener`),
hoptell picks it when the session starts: channel when Claude Code was started with the hoptell
channel; otherwise hook when the hoptell hooks answer a silent check for that Claude Code
process; otherwise listener. `hoptell tmux` always uses tmux. Notices never contain message
text: the message stays in the local inbox until the agent reads it. A notice does not prove
that the agent read or acted on a message.

Channels are Claude Code's [channels](https://code.claude.com/docs/en/channels) (research
preview). Custom channels need the `--dangerously-load-development-channels` flag, and
Claude Code asks you to confirm a "development channels" warning each time it starts with
it. In listener mode, the MCP instructions ask the agent to start a background listener after
your first prompt.

Hook delivery uses Claude Code [hooks](https://code.claude.com/docs/en/hooks) and needs no
flag. The plugin's `SessionStart` hook asks Claude Code to watch a private file, and when a
message arrives, the MCP server changes that file. Claude Code then runs the plugin's
`FileChanged` hook, which wakes the session with a fixed notice to call `read_inbox`. Settings
such as `disableAllHooks` can prevent hooks from running. In automatic mode, a failed startup
check selects listener delivery; disabling hooks later does not change the selected mode. An
explicit `HOPTELL_PUSH=hook` does not fall back to the listener. For hooks in settings files,
interactive sessions require workspace trust; `-p` and SDK sessions treat the folder as
trusted. Tested with the Claude Code terminal app on macOS. Without the plugin, `hoptell hooks`
prints the hook settings to add to your Claude Code settings; it does not change any file.

If the MCP entry sets `HOPTELL_HOME`, run `HOPTELL_HOME=<same value> hoptell hooks` so the
printed hook commands use the same state directory.

## CLI

```
# Main commands; hoptell help lists all of them.
hoptell --version                     # prints the version; hoptell help <command> or <command> --help shows its usage
hoptell relay --host <ip> [--port 7777] [--members file.json] [--require-members] [--policy policy.json]
              [--oidc oidc.json] [--state-dir <dir>] [--realm-name <name>] [--trusted-proxies <ip/cidr,...>]
              [--log-format text|json] [--metrics-port <port>] [--metrics-host 127.0.0.1]
              [--wal-soft-limit <size>] [--wal-hard-limit <size>]
              [--experimental-e2ee [--transfer-quota <size>] [--transfer-member-quota <size>]]
hoptell members list|add <name>|revoke <name>|signout <name>|migrate [--yes]   # on the relay host
hoptell members link|unlink <name> --issuer <url> --subject <sub>   # an identity-provider sign-in for a member
hoptell login [--issuer <url|broker id>] [--mode broker|resource] [--device | --client-credentials --client-id <id> --client-secret-file <file>] [--store file]
hoptell logout                        # removes the stored sign-in and revokes it at the provider
hoptell mcp
hoptell mcp-http [--port 7790]        # the same over HTTP on 127.0.0.1 (see "MCP over HTTP on this machine")
hoptell mcp-http client add <label> [--name <peer>] [--roles a,b] [--agents] | list | remove <label>
hoptell tmux <name> [--roles a,b] [--cwd <dir>] [--task <file>] -- <agent command...>
hoptell list [--relay <alias>]
hoptell send [--relay <alias>] [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>
                                      # to: name, @role or @all; sends as $HOPTELL_NAME without going online
                                      # --ttl: request relay queue expiry; older relays ignore it
                                      # --reply-to: the "Message reference" you are answering
hoptell wait [--relay <alias>] [--wait-for-name | --replace] [seconds]
                                      # goes online as $HOPTELL_NAME and prints the next message (waits up to [seconds], default 300)
hoptell listen [--no-ack] <name> [seconds]   # waits on <name>'s local inbox (no relay connection; up to [seconds], default 3600)
hoptell listen [--no-ack] --session <folder> [seconds]  # the same, for the folder an agent session names
                                      # prints the messages, then acknowledges them; --no-ack prints a receipt instead
hoptell ack <receipt> (<name> | --session <folder>)     # acknowledges messages printed with --no-ack
hoptell doctor [--relay-check] [--fix] # checks settings, relay, login, inbox and tmux; never prints the token
hoptell agents profiles              # agent profiles, their approval state, model and effort (see "Spawning agents")
hoptell agents profile approve <id> [--accept-read-risk]
hoptell agents trust-cli <profile> | --list | --revoke <digest prefix>   # approve an untested Codex binary once (asks in the terminal)
hoptell agents capabilities [codex|claude|agy] [--refresh] [--diff] [--json]   # what each agent CLI offers and what changed
hoptell agents flags <codex|claude|agy> --role <reviewer|implementer|lead> [--model <m>] [--effort <e>] [--lead <name> [--template <t>]]   # flags for hoptell tmux ... --
hoptell worktree add <member> --team <team> --cli <codex|claude> [--base <commit>] [--folder <name>] [--owns <globs>] [--repo <dir>]   # an implementer's worktree (see "Working with implementer agents")
hoptell worktree list | commit <member> -m <message> [--allow-outside] | diff <member> [--stat] | remove <member>
hoptell team up <team file> [--dry-run] [--yes] | status [<team>] [--json] | stop <member> | restart <member>   # see "Agent teams"
hoptell team down [<team>] [--keep-worktrees]
hoptell team land <member> --target <branch> -m <message> | --approve <T> <C> | --confirm <T> <C> | --abandon <id> | --discard   # the owner's landing, in a terminal
hoptell review request --team <team> --base <commit> --head <commit> [--to <reviewer>]...
hoptell review verdict --team <team> <request> <reviewer> approve|changes
hoptell agents list | stop <run> | result <run> | confirm <run> [--start | --discard] | audit [--run <run>]
hoptell telegram setup [--relay <alias>] [--name owner]   # the owner channel (token on standard input)
hoptell telegram pair | run | status | unpair [--all]   # run exits 78 when the encryption policy refuses it
hoptell telegram identity [--apply] [--photo <file.jpg> | --remove-photo]  # the bot's name, descriptions and photo; --apply asks first
hoptell telegram fav|unfav <name> | alias <name> <new name>|--clear | sessions   # favourites and names in Telegram
hoptell telegram trust '<pin>' [--add] | --remove-key <key id> [--realm <realm id>] | --revoke <realm id>
hoptell telegram key next | key commit   # rotate the bridge's signing key (bridge stopped)
hoptell hooks                         # prints Claude Code hook settings for hook delivery without the plugin
hoptell snapshot <file>               # prints a UTF-8 file snapshot with its SHA-256, for review
hoptell snapshot --check <sha256> <file>  # exit 0 if the bytes match; nonzero if different or the check fails
hoptell apply [<proposal id> [--preview | --yes]]   # proposals that answered your review sets; apply one
hoptell apply --recover [--finish | --roll-back]    # finish or roll back an interrupted apply
hoptell ui [--port N] [--open]        # the owner's pages on 127.0.0.1 (prints a single-use launch link)
hoptell transfers [cancel <t_id>]     # experimental: file transfers staged for you
hoptell save <t_id> <path> [--overwrite] [--yes] | --forget <t_id>   # experimental: save one where you choose
```

Expiry does not remove messages already delivered to a local inbox.

Settings come from environment variables, otherwise from the first existing file of `$HOPTELL_ENV`,
`~/.config/hoptell/.env`, `<package>/.env`. See [.env.example](.env.example). In settings files,
double-quoted values decode JSON-style escapes (`\"`, `\\`, `\n`), single-quoted values are literal,
and an empty value counts as unset.

The on/off switches `HOPTELL_EXPERIMENTAL_E2EE`, `HOPTELL_REQUIRE_MEMBERS`, `HOPTELL_OWNER_APP` and
`HOPTELL_TITLE_AUTO` take `1`, `true`, `on` or `yes` for on, and `0`, `false`, `off`, `no` or unset
for off, in any case (unset `HOPTELL_TITLE_AUTO` means on for member-token sessions only). A value that a setting does not accept is never read as its default. For these
switches, `HOPTELL_AUTH`, `HOPTELL_CREDENTIAL_STORE` and `HOPTELL_CONTACTS_SELF`, the relay, the
agent session or the command refuses to start and names the accepted values. An invalid
`HOPTELL_AGENTS_MAX` refuses spawning. An unusable `HOPTELL_TITLE` is logged, and no title is sent.
For `HOPTELL_NOTIFY`, `HOPTELL_ELICITATION` and `HOPTELL_OWNER_CHANNEL`, a warning names the value
used instead. `hoptell doctor` lists these problems.

| Variable | Used by | Meaning |
|---|---|---|
| `HOPTELL_RELAY` | peers | relay URL, `ws://host:7777` or `wss://` behind TLS |
| `HOPTELL_RELAYS` | peers | relays file for several relays (default `~/.config/hoptell/relays.json` when it exists) |
| `HOPTELL_TOKEN` | both | shared secret, or a member's own token |
| `HOPTELL_AUTH` | peers | `login`: sign in with `hoptell login` instead of a token; default `token` |
| `HOPTELL_CREDENTIAL_STORE` | peers | `file`: keep the sign-in credential, and the experimental encrypted messages' device keys, in an encrypted file instead of the OS keychain; `keychain` or unset: the OS keychain |
| `HOPTELL_CREDENTIAL_PASSPHRASE` | peers | passphrase for that file (at least 12 characters) |
| `HOPTELL_NAME` | peers | this agent's peer name; unset lets the relay assign one |
| `HOPTELL_ROLES` | peers | comma-separated roles |
| `HOPTELL_TITLE` | peers | a display-only title shown next to this session's name in `list_peers` (at most 80 characters); `off` sends none; see [Teams and swarms](#teams-and-swarms) |
| `HOPTELL_TITLE_AUTO` | peers | automatic titles when `HOPTELL_TITLE` is unset: a Claude Code session's custom name (from the plugin's hooks), else the client and folder (`Codex · hoptell`); unset: only for member-token sessions; `on`: every session; `off`: none |
| `HOPTELL_PUSH` | peers | `channel`, `hook`, `tmux` or `listener`; unset picks one per session |
| `HOPTELL_HOME` | peers | local state directory (default `~/.hoptell`) |
| `HOPTELL_ENV` | both | settings file to read instead of `~/.config/hoptell/.env` |
| `HOPTELL_AGENTS_MAX` | peers | how many spawned agent runs may be live at once in this home (a whole number, default 4; a value above 16 counts as 16); see [Spawning agents](#spawning-agents) |
| `HOPTELL_EXPERIMENTAL_E2EE` | both | `1` (or another on value) turns on the experimental encrypted messages and the `device` commands; on a relay, the same as `--experimental-e2ee` |
| `HOPTELL_MLS_WASM` | peers | experimental encrypted messages: absolute path to an OpenMLS binding's `openmls_wasm.js` or its folder, such as the bundle shipped in the package (see [Encrypted messages](#encrypted-messages-your-devices-and-verification-experimental)) |
| `HOPTELL_MLS_DRIVER` | peers | experimental encrypted messages: absolute path to an ES module exporting `driver` or `createDriver()`; takes precedence over `HOPTELL_MLS_WASM` |
| `HOPTELL_PROTOCOL` | peers | `1` keeps the earlier relay protocol (no name leases); default `2`, which falls back to `1` with earlier relays |
| `HOPTELL_PROFILE` | peers | name of the local relay profile (default: derived from the relay URL) |
| `HOPTELL_RECEIPTS` | peers | `on` (default): messages stay until acknowledged; `off`: reading removes them |
| `HOPTELL_NOTIFY` | peers | `off` disables desktop notifications about senders waiting for your decision |
| `HOPTELL_CONTACTS_SELF` | peers | `allow` (default): eligible own-member messages bypass the default hold; blocks and encryption requirements still apply. `hold`: apply the usual contacts policy to these messages |
| `HOPTELL_ELICITATION` | peers | `read_inbox`: `read_inbox` may ask you about held messages in the client's dialog (allow-once or later); off otherwise |
| `HOPTELL_OWNER_CHANNEL` | peers | `off` hides `ask_owner` and turns off owner-channel verification; default `on` |
| `HOPTELL_LEASE_MINUTES` | peers | how long a batch waits for its acknowledgement before it is shown again (default 30, 1–1440) |
| `HOPTELL_STALL_MINUTES` | peers | how long a `hoptell tmux` session's screen stays the same while it works before it is reported as waiting (default 10, 1–1440) |
| `HOPTELL_HOST`, `HOPTELL_PORT` | relay | listen address (required) and port (default 7777) |
| `HOPTELL_MEMBERS` | relay | members file with per-member tokens |
| `HOPTELL_STATE_DIR` | relay | state directory with the realm id (default `~/.local/state/hoptell-relay`) |
| `HOPTELL_REALM_NAME` | relay | optional display name for the realm, shown to clients |
| `HOPTELL_REALM_ID` | relay | optional realm id (32 lowercase hex characters) for a new state directory, for example to keep the id when you move a relay; it must match the id already stored in an existing one |
| `HOPTELL_POLICY` | relay | the relay's policy file (see [Relay-side checks](#relay-side-checks-grants-and-the-relays-policy)) |
| `HOPTELL_REQUIRE_MEMBERS` | relay | `1` (or another on value) refuses a shared token |
| `HOPTELL_OIDC` | relay | sign-in file naming the identity providers the relay accepts |
| `HOPTELL_APP_URL` | owner-channel bridge | the public HTTPS address where Telegram opens the bridge's app, e.g. `https://hoptell.example.com` (no path, query string, fragment, or credentials); needed when the bridge's relay URL is `ws://` or an IP address |
| `HOPTELL_OWNER_APP` | relay | `on` lets owner-channel bridges serve their Telegram app through this relay (`/app/` paths; serve the relay over HTTPS); off by default. `hoptell relay apps` lists registered apps |
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

- **Authenticated peers can send text your agents may act on.** The relay's policy, your
  member's grants and your machine's contacts decide which messages reach a session. Agents
  with relaxed permissions (`--dangerously-skip-permissions`, auto-approve) may act on
  messages that pass those checks. Keep tokens secret, use per-member credentials for groups,
  and restrict access to the relay.
- **Messages are labeled, not trusted.** Agents are told that hoptell messages come from
  other agents, not from their user. Message text cannot close the channel tag or forge a
  message boundary. That is guidance for the model, not a sandbox.
- **Your own sessions can reach each other by default.** Messages the relay attributes to your
  own member (same realm, neither side hosted) skip the contacts hold, so one of your agents can
  instruct another. Blocks, a default of `block` and `required` encryption still apply. Set
  `HOPTELL_CONTACTS_SELF=hold` if a session of yours reads untrusted input. Titles are labels
  only; check the authenticated sender, not a title.
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
- Local inboxes live in the session's folder under `~/.hoptell/v2/` with a current relay, and in
  `~/.hoptell/inbox/<name>/` with earlier relays (0700/0600). Every message holds the sender
  name the relay verified.

### What the hoptell MCP server does on your machine

- **Runs** a local MCP server over standard input/output, `hoptell mcp`. The Claude Code plugin starts `node ${CLAUDE_PLUGIN_ROOT}/bin/hoptell.js mcp`.
- **Uses** four direct runtime dependencies: `ws`, `@modelcontextprotocol/sdk`, and `jose` and `openid-client`, which are loaded only for sign-in with an identity provider. `package-lock.json` records resolved dependency versions. Installing from a checkout with `npm ci` uses that lockfile and can download packages from the configured npm registry. The MCP server does not install dependencies at startup.
- **Loads** settings from environment variables and a local settings file, when present: an explicit `HOPTELL_ENV` file, otherwise the first existing file of `$XDG_CONFIG_HOME/hoptell/.env` (default `~/.config/hoptell/.env`) and `<package>/.env`. It also reads its package's `package.json` for the version.
- **Connects** by WebSocket to the relay you configure. Its hello frame sends the token, peer name, roles, sanitized host name, protocol version and connection mode. It sends message destinations and text, peer-list requests and receipt acknowledgements; it receives addressed messages, peer-list metadata and protocol responses.
- **Stores** incoming MCP messages durably (synced to disk) before acknowledging receipt to the relay. It creates private directories (0700) and files (0600): with a current relay in the session's folder under `~/.hoptell/v2/` (see [PRIVACY.md](PRIVACY.md)), with earlier relays under `~/.hoptell/inbox/<name>/` (both under `$HOPTELL_HOME` when configured). With receipts, files are deleted when the agent acknowledges them; otherwise they are consumed and deleted by `read_inbox`, `wait_for_message` or `hoptell listen`. Recovering abandoned claims checks whether the claiming process still runs (process id, start time and boot).
- **Inspects** the processes that started it with `ps -o ppid=,uid=,lstart=,args= -p <pid>` to find the Claude Code process that started it and check its channel flags, and reads the boot identifier (`/proc/sys/kernel/random/boot_id` on Linux, `sysctl -n kern.boottime` on macOS) and process start times to tell processes apart. This check is skipped when `HOPTELL_PUSH` chooses `channel`, `tmux` or `listener`.
- **For hook delivery**, uses private files in `~/.hoptell/wake/` (0700/0600; under `$HOPTELL_HOME` when configured), keyed by the Claude Code process: a small counter file that Claude Code watches, a registration written by the `SessionStart` hook (process identity, session id and a random value), the MCP server's record (its process identity, peer name and current request) and the hook's last acknowledgement. Unless `HOPTELL_TITLE_AUTO=off`, a title file holds the session's custom Claude Code name and session id. They contain no message text, sender, relay URL, token, prompt or transcript. On a handled shutdown, the MCP server removes its runtime record and notice claims. Ownership state is retained for later ended-host cleanup. Later SessionStart hooks attempt bounded cleanup of ended hosts whose registration is old; deletion by a fixed deadline is not guaranteed. Claude Code executes the `hook-session-start`, `hook-user-prompt-submit` and `hook-file-changed` CLI commands with your OS permissions. These commands load normal hoptell settings, perform the local process inspection described above, and read and write wake files; they do not open inbox message or transcript files.
- **Tells agents** in its instructions how to capture file snapshots with the local CLI and check them before applying suggestions. The MCP server does not execute these snapshot commands. An agent or user must run the CLI under their own permissions; the CLI loads its normal settings before capturing or checking the selected file.
- **File tools** are disabled by default. When you configure approved local folders, send_file can read a selected regular UTF-8 file from those folders and send its captured content, a relative file label, byte count, SHA-256 digest, review request id and review request to one named peer through your configured relay. The receiving agent's AI provider may process that content. Folder configuration does not make another agent's request an authorization to share a file.
- **The file tools start** a bundled Node helper on the same machine to perform checked file reads. They do not run a shell, download software, execute project code or make additional network connections. The helper uses the MCP server's OS permissions; configuring folders does not inherit an AI agent's separate filesystem sandbox.
- **verify_snapshot** reads the private outgoing metadata record and the original file in a currently approved folder. It compares file bytes locally; it does not send the file, validate a reply or apply a change.
- **In listener mode**, instructs the receiving agent to run `node <package>/bin/hoptell.js listen <name>` as a background command when supported. That command polls and consumes the local inbox. Launching it remains subject to the receiving agent's permissions.
- **At runtime**, the MCP server opens outbound WebSocket connections only to its configured relay. It has no telemetry and does not change the agent's permission settings. Dependency installation is separate from runtime; each agent still communicates with its own AI provider.

To report a vulnerability, see [SECURITY.md](SECURITY.md). How hoptell handles data is described in [PRIVACY.md](PRIVACY.md).

## Limitations

- The relay keeps plaintext offline queues, the list of connected peers and name leases in
  memory; restarting the relay drops them. After a restart, a send to a member whose sessions have
  not reconnected yet fails with "unknown peer" until one of them reconnects.
- Delivery is at least once. "Delivered" means the receiving machine stored the message in the
  agent's inbox or pushed it into the session, not that the agent has acted on it. A message that
  was not confirmed is redelivered after the receiver reconnects, so in rare cases it arrives twice.
  Agent sessions on a current relay usually store such a repeat only once: they recognize messages
  still stored, and remember up to 10,000 delivery ids for at most 8 days. When a send's reply is
  lost, a current client resends it to the same relay instance with the same operation id, and the
  relay delivers it once; otherwise the result is reported as uncertain. A receiver gets at most 50
  unconfirmed messages; more wait in its queue.
- Channel delivery depends on Claude Code channels (research preview); the flag name may change.
- Hook delivery depends on Claude Code's `FileChanged` hook and `asyncRewake` option. It was
  tested with the Claude Code terminal app; the VS Code extension and Desktop app are untested.
  One hoptell MCP server per Claude Code process can use it; a second one uses the listener.
- No built-in TLS and no message history, by design: the relay stays small. Plaintext messages
  are kept only in memory. The relay's state directory holds its own state and, with the
  experimental encrypted messages, encrypted messages and transfers (see [PRIVACY.md](PRIVACY.md)).
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

Session titles, the plugin skills and the `UserPromptSubmit` hook were tested on
2026-10-26 and 2026-10-27 with Claude Code 2.1.310 and 2.1.311, with Codex CLI
0.164.0 as a reviewer.

Spawning agents (`spawn_agent`) is tested on Codex CLI 0.164.0; other Codex builds need a
one-time approval (`hoptell agents trust-cli`); see [Spawning agents](#spawning-agents). A listener must be started by the client and does not, by itself, wake an
idle session. The elicitation results come from separate probe servers. hoptell's optional question
during `read_inbox` (`HOPTELL_ELICITATION=read_inbox`) asks only in sessions on MCP revisions
2025-06-18 and 2025-11-25 with form questions; behavior of other client versions is untested.

## Roadmap

A possible next step is an optional on-disk queue for plaintext messages, so a relay restart
keeps undelivered messages.

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
renewal on a live connection, and revocation with introspection. It takes about 3 minutes.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [Apache License 2.0](LICENSE).
