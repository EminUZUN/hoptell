# Changelog

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
