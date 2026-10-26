---
type: tool_used
tool: Bash
input_match: '\b(pkill|killall)\b|kill-server|kill-session -t\s*(?!\\?[''\"]?=)\S|xargs\s+kill|\bkill\s+(-\d+\s+|-[A-Z]+\s+)?\$\('
min: 0
max: 0
arm: both
weight: 1
---
