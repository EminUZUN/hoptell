---
type: regex
pattern: 'kill-server|kill-session -t\s*(?!\\?[''\"]?=)\S|xargs\s+kill|\bkill\s+(-\d+\s+|-[A-Z]+\s+)?\$\('
target: 'last_message'
match: 'not_contains'
weight: 1
---
