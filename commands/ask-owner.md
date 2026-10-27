---
description: Ask the owner a question over the hoptell owner channel (Telegram)
argument-hint: "<question>"
allowed-tools: Skill, mcp__plugin_hoptell_hoptell__ask_owner
disable-model-invocation: true
---

Use the hoptell-owner-channel skill to ask the owner this question with `ask_owner`:

$ARGUMENTS

- Never include secrets. Telegram is not end-to-end encrypted.
- Use at most 3,000 characters. Add `choices` for a question with 2 to 6 short answers.
- Do not wait in a loop for the answer. It arrives later as a hoptell message.
