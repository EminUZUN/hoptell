---
description: 'A team review goes out as a commit-based request through hoptell review request with the full base and head ids; no verdict is recorded before a reviewer replies.'
tags: [reviewers, teams, trigger, behaviour]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

dana-n12-impl-1 is stopped and its work is committed. hoptell worktree list shows its base 1111111111111111111111111111111111111111 and head 2222222222222222222222222222222222222222 on team/n12/dana-n12-impl-1. Ask the reviewers of team n12 to review it.
