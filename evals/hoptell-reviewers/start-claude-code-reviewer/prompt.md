---
description: 'A Claude Code reviewer for a source review starts in plan mode, without a hoptell channel flag, through hoptell tmux.'
tags: [reviewers, trigger, behaviour]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Start one Claude Code reviewer for this repo over hoptell. It should only review, not edit.
