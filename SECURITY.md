# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately to the
maintainers through the repository host's confidential issue or private security
advisory feature. Include:

- what an attacker can do and what access they need (network access to the relay, a valid
  token, a local account on a peer machine, ...)
- steps to reproduce, and the hoptell version (`package.json`)

We aim to acknowledge reports within 7 days.

## Threat model

hoptell delivers text written by one AI agent to another AI agent that may act on it.

**Trusted:** the relay operator, and every holder of a valid token. A token holder can
message any peer. With a shared `HOPTELL_TOKEN` they can also use any peer name; with
per-member tokens they can only use their own `<member>` / `<member>-*` names (the relay
refuses overlapping member names). Roles are self-chosen routing labels, not permissions.

**Protected against:**

- anyone without a token who can reach the relay: they cannot connect, read or send, and
  malformed traffic cannot crash the relay
- peer text that tries to escape its message: it cannot close the `<channel>` tag, forge
  a message boundary, or inject terminal control characters through the tmux injector
- other local users on a peer machine: inboxes are per-user (`~/.hoptell`, 0700/0600),
  and symlinked or foreign-owned directories are refused
- runaway agents: 30 messages per 10 seconds per connection, 100,000 characters per
  message, bounded queues, at most 50 unconfirmed messages per receiver
- typing into the wrong place: the tmux injector targets one pane by id, and holds the paste
  and the Enter that submits it while it recognizes an approval prompt on screen (best effort:
  it reads the screen, so an unfamiliar prompt, or one that appears in the instant before
  Enter, is not caught). Message text that looks like a prompt is never typed, so it cannot
  be mistaken for one; the agent is told to fetch that message with `read_inbox`

**Not protected against (by design, use your network for these):**

- eavesdropping on plain `ws://`: use a VPN or a TLS proxy (`wss://`)
- a token holder writing persuasive instructions: hoptell labels messages as coming from
  another agent, but the receiving agent's own permission settings are the real boundary
- availability: there is one relay with in-memory queues

## Hardening checklist

- Run the relay only on a private interface or VPN address (`--host`).
- Use per-member tokens (`--members`) when more than one person connects; store hashes
  (`sha256:...`) in the members file and keep it `chmod 600`.
- Keep `.env` files `chmod 600` and out of version control.
- Prefer agents that ask for approval on risky actions; avoid auto-approve modes for
  agents that receive messages from people you do not fully trust.
