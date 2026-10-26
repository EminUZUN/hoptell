---
type: regex
pattern: 'tmux kill-session -t (?:''=hoptell-dana-reviewer-1''|\"=hoptell-dana-reviewer-1\"|=hoptell-dana-reviewer-1)(?![\w-])'
target: 'last_message'
match: 'contains'
weight: 1
---
