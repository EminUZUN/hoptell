# Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Close code 4002 | The relay refused the name, roles or claim | Read the refusal reason and `hoptell doctor` output. For a member-name refusal, use the reported member prefix; for invalid roles, correct `HOPTELL_ROLES`. |
| Old sessions fail after a token change | The new member token needs prefixed names | Restart each old session with a prefixed name |
| A session waits for its name | Another connection holds the name | Receiving waits for the name; send and list may still work through a separate connection. Use a different name, or stop the holder only within the user's request or agreed cleanup. |
| `hoptell tmux` says the tmux session already exists | A session `hoptell-<name>` is still running | Attach with `tmux attach -t '=hoptell-<name>'`, or end it with `tmux kill-session -t '=hoptell-<name>'` |
| A message to `@reviewer` reached nobody | No reviewer was online at that moment; role messages are not queued | Wait until `list_peers` shows them online, then send again |
| A reviewer never answers | Its request may be held by the contacts policy in the reviewer's hoptell home (a shared-token sender, another member, or `HOPTELL_CONTACTS_SELF=hold`), or the reviewer may be offline, waiting for a name, awaiting a client prompt, or using delivery without a wake path | Ask the user to check `hoptell contacts` (the decision is theirs). Check `list_peers` and `hoptell doctor`, then inspect the reviewer terminal. Do not restart an online reviewer automatically. |
| A Codex reviewer never sees requests | It was started with `codex exec`, or not through `hoptell tmux` | Start it with `env -u TMUX -u TMUX_PANE HOPTELL_PUSH=tmux hoptell tmux <name> --roles reviewer -- codex -s read-only -a never` |
| The same messages are shown again | Their receipt was not acknowledged before the lease expired | Pass the receipt as `ack` in the next `read_inbox`, or call `ack_messages`; do not repeat actions already done |
| A session in tmux is not woken | The injector stopped with the agent, or the prompt is busy | Check `hoptell doctor`; restart the session if needed |

## Before stopping anything

1. List what this session started: tmux sessions named `hoptell-<name>` (and their recorded
   session ids) and recorded PIDs with their start identity.
2. Check that each one is still what this task started, then stop those only.
3. For anything else, such as a relay, a bridge or another person's agent, ask the user first.
