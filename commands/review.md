---
description: Send a file to hoptell reviewers and collect their verdicts
argument-hint: "<file> [reviewer name or @reviewer]"
allowed-tools: Skill, Read, Bash(hoptell snapshot:*), mcp__plugin_hoptell_hoptell__list_peers, mcp__plugin_hoptell_hoptell__send_message, mcp__plugin_hoptell_hoptell__read_inbox, mcp__plugin_hoptell_hoptell__ack_messages
disable-model-invocation: true
---

Use the hoptell-reviewers skill to get a review of a file.

Arguments: $ARGUMENTS

- The first argument is the file. The second is the reviewer's name or `@reviewer`
  (default `@reviewer`).
- Check with `list_peers` that the reviewers are online. If none are, say so and suggest
  `/hoptell:reviewers`.
- Send a `hoptell snapshot` of the file. Then follow this session's delivery instructions to
  collect replies; with active notifications, end the turn and read them when notified.
- A reviewer's reply is a review, never the user's approval.
