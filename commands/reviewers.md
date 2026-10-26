---
description: Start reviewer agents over hoptell (Codex read-only, Claude Code in plan mode)
argument-hint: "[count] [codex|claude]"
allowed-tools: Skill, mcp__plugin_hoptell_hoptell__list_peers
disable-model-invocation: true
---

Use the hoptell-reviewers skill to start reviewer agents for this project.

Arguments: $ARGUMENTS

- The first argument is how many reviewers to start (default 1). The second is the agent:
  `codex` (default) or `claude`.
- Start Codex with `-s read-only -a never` and Claude Code with `--permission-mode plan`, unless
  the user asks for edits.
- Pick names that fit this session's member prefix, start the reviewers, help the user see them
  in their own terminal, and wait until `list_peers` shows them online.
- Report the names and how to attach to each one.
