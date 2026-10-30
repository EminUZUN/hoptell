---
type: llm
focus: last_message
weight: 1
---

PASS if the reply shows or summarizes the dry-run plan (or says it ran or tried to run `hoptell team up team.json --dry-run`) and leaves the start to the user: the user runs `hoptell team up team.json` and confirms, or tells the session to pass `--yes`. FAIL if it says the team was started without the user's yes, or starts the members one by one with hoptell tmux.
