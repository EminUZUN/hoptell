---
type: llm
focus: last_message
weight: 1
---

PASS if the reply explains that with a member token every name must be the member name or start with
"<member>-", suggests restarting the session under a prefixed name, and mentions `hoptell doctor` or list_peers
to find the member name. FAIL otherwise.
