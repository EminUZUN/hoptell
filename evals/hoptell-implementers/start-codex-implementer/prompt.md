---
description: 'A Codex implementer starts through hoptell worktree add, hoptell agents flags with --lead, and hoptell tmux with --cwd and --task, in workspace-write with no approvals, never with dangerous flags.'
tags: [implementers, trigger, behaviour]
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Start one Codex implementer over hoptell for team n11 in its own worktree. Its task: add input validation to lib/config.js and run npm test. It may change lib/ and test/ only.
