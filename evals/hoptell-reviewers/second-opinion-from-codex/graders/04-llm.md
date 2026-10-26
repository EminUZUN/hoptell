---
type: llm
focus: trace
weight: 1
---

PASS if the run works toward a Codex reviewer that talks over hoptell: it launches (or tries to launch) one with
`hoptell tmux <name> --roles reviewer -- codex ...`, or it gives the user that command because it could not run it,
or it sends the file to a reviewer that is already online.
FAIL if it uses spawn_agent or `codex exec`, or if it only reviews the file itself and presents that as the second opinion.
