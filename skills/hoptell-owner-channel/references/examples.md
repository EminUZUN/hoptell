# Owner channel examples

## A question with buttons

```json
{
  "question": "The migration is ready. It rewrites 1,200 rows in the staging database. Run it now?",
  "choices": ["Run it", "Wait until tomorrow", "Show me the plan first"]
}
```

## A milestone the owner must see

```json
{
  "question": "Done: the release branch builds and all tests pass. Next step is yours: push and tag. Anything else before I stop?",
  "choices": ["No, stop here", "Write the release notes"]
}
```

## An action only the owner can take

```json
{
  "question": "I am blocked. The relay refused the name alice-build with code 4002. Please restart the session with HOPTELL_NAME set to a name that starts with your member name. Reply when done.",
  "expires_in_s": 14400
}
```

## A decision after a long review

Keep the question complete on its own. Notes may go unread, so the decision must not depend
on them:

```json
{
  "question": "The review found three fixes: reject invalid option values, preserve unread messages on upgrade, and check the sender before showing an owner label. Should I make these changes?",
  "choices": ["Make the changes", "Discuss them here"]
}
```

## What not to send

- "Here is the new token: ..." Never send a secret. Say where it is stored instead.
- "Approve the device key for laptop-2?" The owner approves device keys on their own machine.
  Ask the owner to run the command, and name it.
