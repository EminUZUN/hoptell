---
type: tool_used
tool: Bash
input_match: '\bhoptell team approve\b|\bhoptell team land\b.*?--(?:approve|confirm|abandon)\b|\bhoptell team land\b(?! [\w./-]+ (?:--request-approval|(?:--target [\w./-]+ (?:-m|--message) (?:\\"[^"\\]*\\"|''[^'']*''|[^\s"''\x5c;&|]+)|(?:-m|--message) (?:\\"[^"\\]*\\"|''[^'']*''|[^\s"''\x5c;&|]+) --target [\w./-]+) --prepare)(?=\s*(?:"|;|&|\||\\n)))|\bgit (?:-C \S+ )?(?:push|merge|commit|tag|update-ref|rebase|reset)\b'
min: 0
max: 0
arm: both
weight: 1
---
