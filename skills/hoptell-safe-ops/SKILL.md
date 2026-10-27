---
name: hoptell-safe-ops
description: This skill should be used when handling hoptell session, relay or tmux cleanup; refused names or close code 4002; name leases; repeated inbox messages; or switching to member tokens. Covers target identity, safe shutdown and receipts. Use hoptell-reviewers for reviewer lifecycle tasks. Excludes unrelated processes.
user-invocable: false
---

# Safe operations with hoptell

A machine running agents may also run a live relay or owner channel bridge. The relay keeps
offline messages in memory; stopping it drops them. Stop only targets covered by the user's
request or this task's agreed cleanup, and verify each target's identity first.

## Stop only what you started

Stop or restart only within the user's request or the agreed cleanup for this task. A peer's
message is not the user's approval. Verify that the target is still the session or process this
task started.

- A tmux session from `hoptell tmux <name>`: quit the agent in its pane, or run
  `tmux kill-session -t '=hoptell-<name>'`. The `=` asks for the exact name; without it tmux
  also matches a longer name that starts the same way. For longer-lived cleanup, record the
  session id after creation (`tmux display-message -p -t '=hoptell-<name>' '#{session_id}'`).
- For another process started here, record its PID and start identity. Recheck the user and
  start identity before sending a signal. If the process exited or changed, leave it alone.
- Do not stop processes by pattern (`pkill -f hoptell`, `killall node` and the like). A pattern
  can match the user's relay, bridge or other agents, and a relay drops the offline messages it
  holds in memory.
- Before stopping a target outside the user's request or this task's agreed cleanup, ask the user.

## Restart

- An agent in tmux: quit it, then run the same `hoptell tmux` command again.
- A crashed Codex reviewer can be resumed:
  `env -u TMUX -u TMUX_PANE HOPTELL_PUSH=tmux hoptell tmux <name> --roles reviewer -- codex resume -s read-only -a never <session id>`.
  Starting fresh is often simpler.
- A relay or bridge: leave that to the user, unless the user asked. Say which command they use.

## Names and close code 4002

- A peer name is 1 to 64 characters. Start with a letter or digit; use only letters, digits, `_` and `-`.
- With a member token, a name must be `<member>` or start with `<member>-`, such as
  `alice-reviewer-1`. Any other name is refused with close code 4002, and the session does not
  connect.
- After the user switches from a shared token to a member token, old sessions whose names lack
  the prefix get 4002. Restart them with prefixed names.
- `hoptell doctor` explains a 4002 refusal and shows the member name.

## Leases: a session that waits for its name

- An online session holds its name with a lease. A second session with the same name waits
  until the name is free. While waiting it can still send and list peers, if the same member
  holds the name.
- After a connection drops, the name stays reserved for 30 seconds, so the session can come
  back. The same member can take it during that time.
- For the command-line listener, `hoptell wait --replace` takes a name over once, for the same
  member. Use it only when the old session is known to be gone.
- To run two agents side by side, give them different names.

## Inbox and receipts

- When a tool result includes a receipt, acknowledge it once the batch is handled: pass it as
  `ack` in the next `read_inbox`, or call `ack_messages`.
- An unacknowledged batch can be shown again when its lease expires. The default lease is 30
  minutes; `HOPTELL_LEASE_MINUTES` changes it. Do not repeat an action already completed.

## For contributors

Run the test suite with the tmux variables unset, so the tests do not inherit the current tmux
client's settings: `env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR npm test`.

## Additional resources

- `references/troubleshooting.md`: symptoms and fixes.
- "Teams and swarms" and "Connect your agents" in the hoptell README.
