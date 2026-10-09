# Changelog

## Unreleased

- Access control at the relay, in two parts. Each part can only refuse a message:
  - an operator policy (`hoptell relay --policy`), with groups of members or identity-provider
    groups;
  - per-member grants (`hoptell grants`), which say who may reach you, with expiry, revisions
    and hiding from lists. A grants change is published only against the revision you previewed.

  Refused senders get the same answer as for unknown names. They can reply once to a message
  that reached their session. They can also send a contact request with a fixed reason
  (`hoptell contacts request`, answered with `hoptell contacts requests`).

  Removing a member, unlinking an identity or revoking a token ends the group claims the relay
  holds for it. Messages queued by a broker sign-in that has ended are not delivered. Without a
  policy or grants, delivery does not change.
- Review sets: `send_review_set` sends several files from approved folders to one peer as one
  immutable manifest (per-file SHA-256, a `bundle_digest` over the RFC 8785 canonical JSON of
  the file list, optional Git provenance), and keeps the captured bytes locally.
  `verify_review_set` checks them later. The reviewer's hoptell checks every file against its
  hash. A reviewer answers with a proposal (replacements or single-file patches, by file id);
  it is checked completely before it is stored, and the agent only learns that it is waiting.
  A proposal is accepted only from the recipient the relay named when the set was sent: the
  relay's acknowledgement of a direct send (protocol 2) now names the recipient's member, or
  says that it used the shared token. With an older relay that names no recipient, the check is
  weaker (any authenticated sender with that name in the realm), and the tool result and the
  apply preview say so. A set whose confirmation was not saved accepts no proposal. Files inside
  `.git` cannot be part of a review set.
- `hoptell apply` lets the owner preview and apply a proposal from the terminal: changes are
  applied to the captured bytes in a temporary folder (Git 2.39.2 or a fixed release, no
  configuration, hooks or filters), every file is checked again before writing, and a recovery
  journal makes an interrupted apply recoverable with `hoptell apply --recover`. An apply is
  committed once its complete journal state is saved: recovery then only finishes it, and refuses
  a roll-back.
  Each file is replaced by a new file with the same permission bits; ACLs and extended
  attributes are not kept. `hoptell doctor` reports an unfinished journal.
- `hoptell mcp-http` serves MCP over HTTP on 127.0.0.1 for clients that only speak HTTP: per-client
  tokens (stored hashed), loopback Host check, no web-page requests, one agent session per client
  session, limits on sessions, calls and streams. Reads are held under receipts until they are
  acknowledged, so a response lost with its connection is shown again. `hoptell hook-header` lets
  such a client use Claude Code hook notices.
- One agent session can use several relays (a relays file): peers are addressed as `name@relay`,
  bare names go only to the default relay, and nothing is forwarded between relays. Reads merge
  every relay with one receipt; replies go back through the relay their message came from.
  Relays can be send-only. `hoptell send|list|wait` accept `--relay` and `name@relay`.
- Sign-in with an identity provider (OIDC), tested with Keycloak. A relay started with
  `--oidc <file>` accepts access tokens that the provider issues for the relay, checked with
  the provider's keys or by introspection. `hoptell members link` links an identity to a
  member. `hoptell login` signs in with the browser (authorization code with PKCE), with a code
  on another device, or as a service account. With `HOPTELL_AUTH=login`, sessions sign in
  without a token. Tokens are renewed on the live connection. Credentials are kept in the OS
  keychain or, by choice, an encrypted file. `hoptell logout` removes and revokes them.
  `hoptell doctor` shows the sign-in. Member tokens keep working.
- Broker mode for providers that only sign users in (ID tokens, no access tokens for the
  relay): the relay signs the user in at the provider and issues its own credential to
  `hoptell login`. Refresh tokens are used once; a reused one ends that sign-in everywhere.
  `hoptell members signout <name>` ends a member's broker sign-ins, and `hoptell relay
  broker-reset` recovers from a lost key.
- `hoptell local-relay` runs a private relay for your own sessions on this machine as a user
  service (macOS LaunchAgent, Linux systemd user unit): loopback only, members only, with a
  token only your account can read. `hoptell doctor` shows its state.
- Relays report whether names are authenticated with a shared token, per-member
  tokens or both. `hoptell doctor` displays the mode and warns when a shared-token
  holder can use a member's name.
- `hoptell send`, `list` and `wait` retry connection attempts within their time
  limits. `wait` also reconnects after a dropped connection. Rejected credentials
  and name takeovers stop retries. Sends with an uncertain outcome are never
  retried automatically.
- Closing a relay client cancels reconnects and name checks and settles pending
  waits and requests.
- `--trusted-proxies` enables client-address logging behind a reverse proxy.
  Forwarded headers are read only from configured proxies and used only in logs.
- Optional JSON Lines logging (`--log-format json`) replaces control characters
  in logged values. An optional metrics endpoint (`--metrics-port`) exposes
  aggregate counts, sizes and ages and binds to 127.0.0.1 by default.
- `hoptell doctor --relay-check` sends a test message to a temporary receiver and
  reports the elapsed time for connection setup, delivery and acknowledgement.
- Node.js 22 or newer is required. CI runs on Node.js 22 and 24.
- The README documents the observed client behavior and configurations.
- Peer names are leased (relay protocol 2). While a session is online, another
  connection cannot take its name. When a session's connection drops, other
  members cannot take the name for 30 seconds, but the same member can (for
  example a restarted session); a clean exit frees it at once. A second agent session with the same
  name waits for it. `hoptell wait` stops instead, or waits with
  `--wait-for-name`, or takes the name over once with `--replace`. Clients fall
  back to the earlier protocol with earlier relays; `HOPTELL_PROTOCOL=1` keeps it.
- Without `HOPTELL_NAME`, the relay assigns the name: `<member>-<host>-<n>` with a
  member token, `<host>-<n>` with the shared token.
- Each relay has a realm id, kept in its state directory (`--state-dir`,
  `HOPTELL_STATE_DIR`; the Docker image uses `/data`). Clients record it per relay
  and refuse a relay URL that starts answering with another realm.
- Messages show how the relay says the sender signed in: member name and id, the
  shared token, or unknown with earlier relays.
- Agent sessions keep messages in a folder bound to the relay realm, member and
  session, and usually store a redelivered message only once. `hoptell listen --session`
  reads such a folder.
- Messages stay until acknowledged (receipts). `read_inbox` and `wait_for_message`
  return a batch with a receipt, which the agent passes back as `ack` (or with the
  new `ack_messages` tool) once handled; unacknowledged batches are shown again
  after a lease (`HOPTELL_LEASE_MINUTES`, default 30). `hoptell listen` acknowledges
  after printing; `--no-ack` prints a receipt for `hoptell ack`. `HOPTELL_RECEIPTS=off`
  keeps read-means-removed.
- Received messages are written durably before they are confirmed; a session's
  inbox holds at most 1,000 messages or 50 MB, and further messages wait at the
  relay until room is freed.
- Sends carry an operation id on relays that support it: when a reply is lost, the
  client resends to the same relay instance and the relay delivers the message once.
- Contacts: you decide who may reach your agent sessions. In a new install, senders
  without a grant are held back until you decide with `hoptell contacts` (allow,
  allow once, block); the agent only sees how many messages wait, and a desktop
  notification points you to the command. Existing installs keep today's behavior
  until `hoptell contacts init`. Decisions name the exact revisions you were shown,
  so a newer block is never undone by an older allow. `hoptell doctor` summarizes it.
- `hoptell members list|add|revoke|migrate` manages the members file on the relay
  host. New tokens are shown once and stored as SHA-256. Members get immutable ids;
  `--require-members` refuses a shared token. The relay refuses duplicate ids and a
  token used by two credentials.
- `hoptell doctor` shows the relay realm, the member it signed in as, and whether
  the local relay profile agrees.

## 0.2.2 (2026-10-08)

- `hoptell tmux` now starts tmux servers without `HOPTELL_` variables in their
  global environment. Previously, later sessions could inherit the relay URL,
  token and `HOPTELL_PUSH=tmux`, causing Claude Code started in ordinary tmux
  to wait for notices from an injector that was not running.
  `hoptell doctor` detects these variables in an existing tmux server’s global
  environment and prints commands to remove them, without showing their values.

## 0.2.1 (2026-10-08)

- A replaced MCP session now reconnects automatically once its peer name is free again.
  Previously, it stayed offline until restarted. This lets it recover when an agent starts
  a temporary copy of its MCP server to list tools, as Codex does for `/mcp`. While the
  newer connection is online, the replaced session waits. It checks at increasing intervals,
  from two seconds up to one minute. Names longer than 58 characters still require a restart.
- For contributors: `npm run test:compat` tests every combination of old and current
  relays, senders and receivers. By default, it installs the newest npm release older than
  this checkout's version.
- Fixed an intermittent hang in the hook delivery tests. Cleanup now stops the stand-in
  Claude Code process and its MCP servers before removing their files. Closing a test
  relay also closes connections that have not finished sending their HTTP upgrade request.

## 0.2.0 (2026-10-08)

- `hoptell doctor` checks this machine's setup: Node.js version, settings file and its
  permissions, relay URL, token (never printed), peer name and roles, delivery mode, relay
  health and login, online peers, inbox, hook sessions and tmux. It exits with status 1 if any
  check fails.
- Message expiry: `send_message` accepts an optional `ttl_seconds`, and `hoptell send` accepts
  an optional `--ttl` (for example `--ttl 10m`, at most 7 days). If the message is still
  waiting in the relay's queue when its time-to-live expires, the relay drops it. Expiry
  does not delete messages already stored in a local inbox. Older relays ignore this setting.
- Message references: every accepted send gets a `Message reference`, shown by clients from
  0.2.0 after the message text and in the send result. `send_message` accepts `reply_to` and
  `hoptell send` accepts `--reply-to`, so the recipient sees which message an answer refers to.
  The relay logs references, routing events and receipt acknowledgements. Its logging calls do
  not explicitly include the message-text field.
- `hoptell snapshot <file>` prints a text file with the SHA-256 of its exact bytes for review,
  and `hoptell snapshot --check <sha256> <file>` reports whether the file still matches before
  a suggested change is applied.
- File tools, off by default: with approved folders configured (`HOPTELL_SNAPSHOT_ROOTS`, or
  the plugin's "Approved snapshot folders" setting), `send_file` sends a checked snapshot of a
  file to one peer and keeps a private local record, and `verify_snapshot` reports whether the
  file still matches. macOS and Linux only.
- Optional keyed fingerprints in relay logs on macOS and Linux:
  `HOPTELL_LOG_FINGERPRINTS=on` with `HOPTELL_LOG_FINGERPRINT_KEY_FILE` set to a private key
  file adds an HMAC-SHA-256 tag of the message text on routing and delivery events, using
  the message reference as a nonce. Off by default; tags are never sent to clients.
  `hoptell doctor` reports the local setting.
- The relay re-reads its members file on `SIGHUP`: connections authenticated with removed or
  changed member credentials are closed, and the relay stops serving them at once. Invalid
  updates leave the active members list unchanged.
- Hook delivery for Claude Code: the plugin's `SessionStart` hook registers a watched file,
  and its `FileChanged` hook wakes an idle session with a fixed notice when messages are
  waiting, without the channels flag. Automatic mode chooses an enabled hoptell channel
  first, then hooks if they answer a silent check at startup, otherwise listener delivery.
  `hoptell hooks` prints hook settings for setups without the plugin. Explicit
  `HOPTELL_PUSH=hook` does not fall back to listener delivery.
- `HOPTELL_PUSH` accepts `channel`, `hook`, `tmux` or `listener`. Each MCP server selects one
  delivery mode; in hook and tmux mode it does not ask the agent to run a background listener.
  `hoptell doctor` shows the setting and hook sessions running on this machine.
- tmux delivery types a fixed notice instead of the message text, and only when the agent's
  whole input is recognizably empty, no approval prompt is visible, the pane is not in copy
  mode and nobody attached has typed for a few seconds. Messages stay in the inbox until the
  agent reads them. Several waiting messages get one notice; unread ones are announced again a
  few times, at growing intervals, then not again. `hoptell tmux` refuses other
  `HOPTELL_PUSH` values and hoptell channel flags.
- The MCP instructions now fit within what Claude Code reads; longer guidance moved into the
  tool descriptions.
- README: what to do when a Claude Code session does not wake up.

## 0.1.1 (2026-10-06)

- Messages sent with `hoptell send` under a name that no agent used at the time are marked
  "sent from the command line; no reply destination was registered when sent", and the
  tmux injector tells the agent to check `list_peers` before replying, instead of
  suggesting a reply that would fail.
- README: demo recordings of a review handoff and a question to a PM's agent; the
  wake-up summary now describes the channel notice.

## 0.1.0 (2026-10-06)

First public version.

- Relay: a WebSocket hub with a shared token or per-member tokens (a member token allows
  the member's name and `<member>-...` aliases; overlapping names and non-string tokens
  are refused), offline queues, delivery acknowledgements with requeue on disconnect,
  `@role` / `@all` fan-out, a per-connection rate limit, at most 50 unconfirmed messages
  per receiver, `/healthz` and a protocol version check. Malformed traffic cannot crash it.
- MCP server: `list_peers`, `send_message`, `wait_for_message`, `read_inbox`. Every
  incoming message is stored in a private local inbox before it is acknowledged. In
  Claude Code with channels enabled, a channel notice wakes the agent, which reads the
  message with `read_inbox`; elsewhere a background listener or polling picks it up.
- `hoptell tmux`: runs Codex or any terminal agent in tmux and pastes incoming messages
  into exactly its pane while the original process runs there. It holds back while an
  approval prompt is on screen, and a message that itself looks like a prompt is left
  for `read_inbox` instead of being typed.
- CLI: `relay`, `mcp`, `tmux`, `list`, `send`, `wait`, `listen`.
- Tested with Claude Code, Codex and Antigravity (`agy`).
- Distribution: npm package `hoptell`, a Claude Code plugin and marketplace
  (`/plugin marketplace add EminUZUN/hoptell`, then `/plugin install hoptell@hoptell`;
  relay settings through `userConfig`), the relay image `ghcr.io/eminuzun/hoptell`
  (amd64 and arm64) and an MCP Registry entry (`io.github.EminUZUN/hoptell`).
- Releases: a version tag stages the npm version for a maintainer's approval
  (`npm stage publish`, trusted publishing), then publishes the relay image, the MCP
  Registry entry and a GitHub Release from this changelog. No publishing secrets are
  stored, and a failed release can be re-run safely.
- `npm run test:e2e`: optional tests with real Claude Code, Codex and Antigravity agents
  in two Docker containers, checking broadcasts and message passing through every agent.
  They run locally; CI runs the automated suite on Linux with Node.js 20 and 22.
- Dockerfile, Docker Compose and systemd examples that publish the relay on one private
  or VPN address; CI for GitHub and GitLab; ESLint.
