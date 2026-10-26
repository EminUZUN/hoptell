---
description: 'A spawn_agent request with a profile is not a reviewer request: the reviewers skill stays out and nothing is launched with hoptell tmux.'
tags: [reviewers, no-trigger]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Spawn an agent with the profile nightly-tests and give it this task: run the full test suite and report any failures back to me.
