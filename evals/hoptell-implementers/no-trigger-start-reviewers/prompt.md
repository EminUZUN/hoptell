---
description: 'The user asks for read-only reviewers only: the implementers skill does not load and no worktree is made.'
tags: [implementers, no-trigger]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Start two Codex reviewers over hoptell for this repo. They should only review, not edit.
