---
name: dashboard
description: Report this project's Claude session results as cards on a local dashboard (http://127.0.0.1:7357) and take instructions from dashboard replies. Use when the user turns the dashboard on (/ddashboard:dashboard) or off (/ddashboard:dashboard off).
---

# ddashboard

The hooks have already turned the dashboard on or off. Check the `[ddashboard]` instructions in your context and only do the following.

1. If the instructions are present, tell the user the dashboard URL in one line, then run the wait command from the instructions in the background.
2. If they are missing (you invoked this skill yourself), run `node "<this skill's base directory>/../../scripts/control.js" start` and tell the user to type `/ddashboard:dashboard` once to connect this session.
3. For an `off` request, report the result in one line.

Read `<base directory>/../../scripts/dashboard.html` only when the user asks to change the dashboard UI. Don't read it otherwise.
