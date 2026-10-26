---
type: regex
pattern: '--roles reviewer -- codex(?![^"`\n&;|]*-s read-only)'
target: 'last_message'
match: 'not_contains'
weight: 1
---
