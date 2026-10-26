---
description: List hoptell peers and explain any name problem
allowed-tools: Skill, mcp__plugin_hoptell_hoptell__list_peers
disable-model-invocation: true
---

Call `list_peers` and show the peers: name, roles, and whether each is online. Mark this
session's own name.

If a peer name or a connection problem shows up (close code 4002, a name that waits, a name
without the member prefix), use the hoptell-safe-ops skill to explain it and suggest a fix.
