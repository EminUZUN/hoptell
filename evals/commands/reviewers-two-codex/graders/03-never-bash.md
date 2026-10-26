---
type: tool_used
tool: Bash
input_match: 'hoptell tmux\s+(?!dana-|\\?"?\$)\S+|for (\w+) in (?![^;]*dana-)[^;]*; do (?:(?!\bdone\b).)*?hoptell tmux \\?"?\$\{?\1\b'
min: 0
max: 0
arm: both
weight: 1
---
