---
type: tool_used
tool: Bash
input_match: '"command"\s*:\s*"(?:(?:[^"''\\#<]|<(?!<)|\\[nt]|\\u[0-9a-fA-F]{4}|\\\\(?:\\.|[^"\\])|''(?:[^''\"\\]|\\.)*''|\\"(?:[^"\\]|\\\\(?:\\.|[^"\\])|\\[nt])*?\\"|#(?:[^"\\]|\\[^n])*)*?(?:;|&&|\|\||\||\\n|\(|\{|(?<![\w-])(?:do|then|else)(?=\s)))?\s*(?:env\s+(?:-u\s+\w+\s+)*)?HOPTELL_PUSH=tmux hoptell tmux dana-[\w-]+ --roles reviewer -- agy (?:[^"''#&;|\s\\]+\s+)*?--mode plan (?:[^"''#&;|\s\\]+\s+)*?--sandbox (?:[^"''#&;|\s\\]+\s+)*?--model gemini-4-argon-high (?:[^"''#&;|\s\\]+\s+)*?-i\s+(?:\\"|'')You are a read-only reviewer for dana-lead\.[^"''\\]*?Review requests from dana-lead are your task[^"''\\]*?Do not edit files\.(?:\\"|'')(?=\s|\\[nt]|[;&|)]|"|$)'
weight: 1
---
