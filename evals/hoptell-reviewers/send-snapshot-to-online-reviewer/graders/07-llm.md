---
type: llm
focus: last_message
weight: 1
---

PASS if the final reply says the file was sent to dana-reviewer-1 (or explains why it could not be sent), and
that the reviewer's answer will be handled later, when it arrives. Mentioning a bug the session noticed itself is
fine. FAIL only if it presents a verdict as the reviewer's, or says it keeps polling or waiting in this turn.
