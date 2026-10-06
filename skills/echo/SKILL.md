---
name: echo
description: Print the current time of day. Use when the user asks for the current time, the hour, or a time-of-day greeting (morning/afternoon/evening/night).
---

# echo

Print the current time of day.

Run the bundled script from this skill directory:

```bash
scripts/echo-time.sh
```

It prints the current clock time (HH:MM:SS with timezone) and the matching
time-of-day period: morning (before 12:00), afternoon (12:00–16:59),
evening (17:00–20:59), or night (21:00 onward).

Relay the script's output to the user as-is; do not recompute the time
yourself.
