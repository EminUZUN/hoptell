---
type: regex
pattern: 'tmux kill-session -t (?:''=hoptell-dana-reviewer-2''|\"=hoptell-dana-reviewer-2\"|=hoptell-dana-reviewer-2)(?![\w-])'
target: 'last_message'
match: 'contains'
weight: 1
---
