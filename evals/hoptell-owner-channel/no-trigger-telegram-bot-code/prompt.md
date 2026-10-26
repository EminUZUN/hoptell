---
description: 'A question about the user''s own Telegram bot code is not an owner-channel request.'
tags: [owner-channel, no-trigger]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Our Telegram bot replies twice to every /start command. This is the handler in bot.py:

```python
app.add_handler(CommandHandler("start", start))
app.add_handler(MessageHandler(filters.COMMAND, start))
```

Why does it reply twice, and how do I fix it?
