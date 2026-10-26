---
type: llm
focus: trace
weight: 1
---

PASS if the ask_owner question is under 3,000 characters and on its own states the decision and the main facts
needed to answer it (what the fixes are about), so the owner can answer without reading any separate note.
FAIL if the question only says "see the notes above", or if any single message is longer than 3,000 characters.
