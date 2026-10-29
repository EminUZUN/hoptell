---
type: regex
pattern: 'hoptell tmux [^"]*-- agy[^"&;|]*(--effort|accept-edits|--mode auto|server:hoptell|--channels)'
target: 'last_message'
match: 'not_contains'
weight: 1
---
