#!/usr/bin/env python3
"""Exercise the `/permissions` command surface over RPC mode.

Print mode cannot run a slash command and the TUI is not scriptable, so this drives
`pi --mode rpc`, sends each subcommand as a prompt, and asserts on the notification the
handler sends back. It is the only automated check of the command surface itself; the
decisions behind it are covered by lib.test.ts.

Run: python3 ~/.pi/agent/extensions/permissions/tests/commands.py
"""
import json
import subprocess
import sys
import threading
import time

# (label, command, substring expected in the notification, optional substring that must NOT appear)
CASES = [
    ("status", "/permissions status", "mode=build", None),
    ("status config", "/permissions status", "config=loaded", None),
    ("mode", "/permissions mode", "mode=build", None),
    ("check simple", '/permissions check bash "ls -la"', "bash -> allow — the deterministic rules decided it", None),
    ("check workdir delete", '/permissions check bash "rm /tmp/a.txt"', "bash -> allow — the deterministic rules decided it", None),
    ("check glob wipe with jev off", '/permissions check bash "rm -rf /workspace/*"', "bash -> allow", None),
    ("jev on", "/permissions jev on", "jev=on", None),
    # The verdict, and so the exact phrasing, depends on the classifier's confidence:
    # at or above the threshold it reports the verdict, below it names the downgrade.
    # Assert only that the classifier was consulted.
    ("check outside workdir", '/permissions check bash "rm -rf /srv/data"', "Jev", None),
    ("check catastrophe", '/permissions check bash "rm -rf /usr/share/x"', "catastrophe gate", None),
    ("check read", "/permissions check read /workspace/AGENTS.md", "read -> allow", None),
    ("yolo on", "/permissions yolo on", "yolo=on", None),
    ("check under yolo", '/permissions check bash "rm -rf /usr/share/x"', "YOLO is on", "catastrophe gate"),
    ("yolo off", "/permissions yolo off", "yolo=off", None),
    ("jev off", "/permissions jev off", "jev=off", None),
    ("bad subcommand", "/permissions bogus", "usage:", None),
    ("threshold set", "/permissions threshold 0.5", "threshold=0.5", None),
    ("threshold report", "/permissions threshold", "threshold=0.5", None),
    ("threshold out of range", "/permissions threshold 2", "not a confidence threshold", None),
]


def notifications_for(command: str) -> int:
    """`status` emits the status line and then the counter line."""
    return 2 if command.split()[1:2] == ["status"] else 1

TIMEOUT = 300.0

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

notifications: list[str] = []
statuses: list[tuple[str, str]] = []
responses: dict[str, dict] = {}
lock = threading.Lock()


def reader() -> None:
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if record.get("type") == "extension_ui_request" and record.get("method") == "notify":
            with lock:
                notifications.append(record.get("message", ""))
        elif record.get("type") == "extension_ui_request" and record.get("method") == "setStatus":
            with lock:
                statuses.append((record.get("statusKey", ""), record.get("statusText", "")))
        elif record.get("type") == "response":
            with lock:
                responses[record.get("id", "")] = record


threading.Thread(target=reader, daemon=True).start()

deadline = time.time() + TIMEOUT
for index, (_, message, _, _) in enumerate(CASES):
    if time.time() > deadline:
        print("FAIL: timed out driving the command surface")
        proc.kill()
        sys.exit(1)
    proc.stdin.write(json.dumps({"id": f"c{index}", "type": "prompt", "message": message}) + "\n")
    proc.stdin.flush()
    time.sleep(1.2)

time.sleep(3)
proc.terminate()
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()

with lock:
    collected = list(notifications)
    indicator_updates = list(statuses)
    answered = dict(responses)

failures: list[str] = []
expected_notifications = sum(notifications_for(command) for _, command, _, _ in CASES)
if len(collected) != expected_notifications:
    failures.append(f"expected {expected_notifications} notifications, got {len(collected)}")

cursor = 0
for index, (label, command, expected, forbidden) in enumerate(CASES):
    if not answered.get(f"c{index}", {}).get("success"):
        failures.append(f"{label}: no successful response")
    note = collected[cursor] if cursor < len(collected) else ""
    cursor += 1
    if expected not in note:
        failures.append(f'{label}: expected "{expected}" in "{note[:120]}"')
    if forbidden is not None and forbidden in note:
        failures.append(f'{label}: did not expect "{forbidden}" in "{note[:120]}"')
    if notifications_for(command) == 2:
        counters_line = collected[cursor] if cursor < len(collected) else ""
        cursor += 1
        if not counters_line.startswith("counters: allow ") or " low · ask " not in counters_line or " low · deny " not in counters_line:
            failures.append(f'{label}: expected a counter line, got "{counters_line[:120]}"')

# The footer indicator: one setStatus key, updated on every switch flip.
if not indicator_updates:
    failures.append("no setStatus request was emitted for the footer indicator")
else:
    # Other extensions share the footer status line, so judge only our own key.
    mine = [text for key, text in indicator_updates if key == "permissions"]
    if not mine:
        failures.append("no setStatus request with the permissions key was emitted")
    # `threshold 0.5` is the last thing that refreshes the footer.
    if mine and mine[-1] != "jev off · yolo off · thr 0.50 · jev-1.13":
        failures.append(
            f'expected the final indicator to read "jev off · yolo off · thr 0.50 · jev-1.13", got "{mine[-1]}"'
        )
    if not any("jev on" in text for text in mine):
        failures.append("no indicator update reported jev on")
    if not any("yolo on" in text for text in mine):
        failures.append("no indicator update reported yolo on")
    if not any("thr 0.50" in text and "jev-1.13" in text for text in mine):
        failures.append("no indicator update carried the threshold and the model id")

for note in collected:
    print(f"- {note}")
print()
for key, text in indicator_updates:
    print(f"[footer {key}] {text}")

print()
if failures:
    print(f"FAIL: {len(failures)} of {len(CASES)} command cases")
    for failure in failures:
        print(f"  - {failure}")
    sys.exit(1)
print(f"ok: {len(CASES)} command cases passed")
