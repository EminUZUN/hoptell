---
description: List hoptell peers and explain any name problem
allowed-tools: Skill, mcp__plugin_hoptell_hoptell__list_peers
disable-model-invocation: true
---

Call `list_peers`. Show online peers with names and roles, mark this session's own name, and
summarize offline peers as a count. Show offline names when the user asks for them or needs an
offline recipient.

If a peer name or a connection problem shows up (close code 4002, a name that waits, a name
without the member prefix), use the hoptell-safe-ops skill to explain it and suggest a fix.
