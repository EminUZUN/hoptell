---
description: Start reviewer agents over hoptell (Codex read-only, Claude Code or agy in plan mode)
argument-hint: "[count] [codex|claude|agy] [model] [effort]"
allowed-tools: Skill, mcp__plugin_hoptell_hoptell__list_peers
disable-model-invocation: true
---

Use the hoptell-reviewers skill to start reviewer agents for this project.

Arguments: $ARGUMENTS

- The first argument is how many reviewers to start (default 1). The second is the agent:
  `codex` (default), `claude` or `agy`. A third and fourth are an optional model and effort.
  Without them, the role preset supplies model and effort, and the CLI picks what the preset
  leaves unset; the shipped Codex and Claude Code reviewer presets use high effort. hoptell
  refuses `--effort` for agy (give the complete model id, for example `gemini-4-argon-high`)
  and never passes `--effort` to agy.
- Get each reviewer's agent command and flags from
  `hoptell agents flags <agent> --role reviewer [--model <model>] [--effort <effort>]`, as the
  skill shows, also when no model or effort is given (it applies the presets and checks the
  CLI), and tell the user its warnings. If it refuses, say why and start nothing.
- The reviewer flags are Codex `-s read-only -a never`, Claude Code `--permission-mode plan` and
  agy `--mode plan --sandbox --dangerously-skip-permissions`; Codex and Claude Code may differ
  only when the user asks for edits, and agy always stays in plan mode. End
  each launch with the initial prompt from the skill (for agy after `-i`), naming this session as
  the lead, so that its review requests are the reviewer's task.
- Pick names that fit this session's member prefix, start the reviewers, help the user see them
  in their own terminal, and wait until `list_peers` shows them online.
- Report the names and how to attach to each one.
