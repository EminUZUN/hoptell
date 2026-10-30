---
type: tool_used
tool: Bash
input_match: 'HOPTELL_PUSH=tmux hoptell tmux dana-[\w-]+ (?:--\w+ \S+ )*?--cwd \S+ (?:--\w+ \S+ )*?--task \S+ (?:--\w+ \S+ )*?-- codex -s workspace-write -a never\b|HOPTELL_PUSH=tmux hoptell tmux dana-[\w-]+ (?:--\w+ \S+ )*?--task \S+ (?:--\w+ \S+ )*?--cwd \S+ (?:--\w+ \S+ )*?-- codex -s workspace-write -a never\b'
weight: 1
---
