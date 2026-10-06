# Changelog

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
