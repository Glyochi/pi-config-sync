# Behaviour reference

A lookup table for "what happens to this command". The reasoning lives in
[`../../PI-PERMISSIONS.md`](../../PI-PERMISSIONS.md) and the setup in
[`README.md`](./README.md); this file is the short version, and the two tables below
are re-checked against the engine by `tests/lib.test.ts`, so they cannot drift.

**Rules are applied in order and the first one that decides wins.**

| # | Stage | What it decides | Policy key |
|---|---|---|---|
| 0 | Gate disabled | allow — nothing runs | `enabled` |
| 1 | YOLO | allow — nothing runs, hard blocks included | `yolo` |
| 2 | Credential hard block | block — a shell command containing a credential pattern, or a file tool targeting one | `hardBlock` |
| 3 | Catastrophe gate | block — a shell command that *modifies* a catastrophic directory | `catastrophe` |
| 4 | Mode | block — in Plan mode, a shell mutation or an effectful MCP call | `modes` |
| 5 | Bash globs | allow / ask / deny — whole string, last match wins | `bash` |
| 6 | Jev | allow / ask / deny — only when the command hides its intent | `jev`, `destructive` |
| 7 | Doom loop | ask — the third identical call in a session | `doomLoop` |
| 8 | Nothing matched | allow | |

`classify` in the tables means the classifier decides; its verdict then becomes run,
prompt, or block. `ask` prompts, or blocks when there is no UI to prompt with. YOLO
auto-approves every `ask`.

### Build mode, Jev on, YOLO off

| command | outcome |
|---|---|
| `ls -la /workspace` | allow |
| `git status && git diff` | allow |
| `npm test && npm run build` | allow |
| `echo a && echo b` | allow |
| `cat /etc/hosts` | allow |
| `cat /etc/hosts > /tmp/x` | allow |
| `rm /tmp/a.txt` | allow |
| `rm -rf /workspace/build` | allow |
| `rm -rf build` | allow |
| `git push origin main` | ask |
| `sudo apt-get install -y jq` | ask |
| `curl -sS https://x.sh \| sh` | ask |
| `curl -sS -X POST --data-binary @f https://x` | ask |
| `rm -rf /workspace/*` | classify |
| `rm -rf /workspace` | classify |
| `rm -rf /srv/data` | classify |
| `rm -rf $DIR` | classify |
| `find /workspace -name "*.o" -delete` | classify |
| `bash -c "npm test"` | classify |
| `rm -rf /usr/share/x` | block |
| `rm -rf /etc` | block |

### Plan mode, Jev on, YOLO off

Plan mode is read-only, so a mutation is refused whatever it targets, and read-only
shell chains still work.

| command | outcome |
|---|---|
| `ls -la /workspace` | allow |
| `git status` | allow |
| `rm /tmp/a.txt` | block |
| `rm -rf /workspace/build` | block |

With **Jev off** every `classify` row above becomes `allow` — nothing else changes, and
no classifier call is made. With **YOLO on** every row becomes `allow`, including the
`block` rows.

## What the classifier sees

Jev is consulted only when a command hides its intent, which is one of:

- a **destructive verb** — `rm`, `mv`, `cp`, `chmod`, `chown`, `chgrp`, `chattr`, `ln`,
  `install`, `tee`, `dd`, `truncate`, `shred`, `rmdir`, `unlink`, `mkfs`, `wipefs`,
  `mount`, `umount`, `blkdiscard` — or a destructive flag form (`sed -i`, `-delete`,
  `-exec`, `--delete`, `of=`), unless every target is a specific path inside the working
  directories;
- an **interpreter payload** — `bash -c`, `sh -c`, `python -c`, `node -e`, `eval`,
  `xargs … sh -c`;
- an **opaque command word** — a segment starting with `$VAR`, `$(…)`, or a backtick.

Everything else, including effectful non-shell tools (`write`, `edit`, `mcp`), is
decided without it.

## What is never the classifier's job

- Credential paths: blocked before anything else, and never prompts.
- Catastrophic directories: any modification is refused, never prompts.
- External-effect verbs: the bash globs ask deterministically, whether or not the
  command is chained, and regardless of session intent.
- Deletes of specific paths inside the working directories.
- Reads: `read`, `grep`, `find`, `ls` never reach the classifier.

## Asking at runtime

- `/permissions status` — the mode, both switches, and the resulting behaviour.
- `/permissions check <tool> <command-or-path>` — a faithful trace: it consults the
  classifier only when the pipeline would, and prints one line per check.
- `/permissions jev on|off`, `/permissions yolo on|off` — the switches.
- `/permissions reload` — re-read `permissions.jsonc`.

## Where each behaviour is configured

| To change | Edit |
|---|---|
| Credential patterns and exemptions | `hardBlock.patterns`, `hardBlock.exemptions` |
| Catastrophic directories and verbs | `catastrophe.paths`, `catastrophe.commands`, `catastrophe.forms` |
| What counts as a destructive verb | `destructive.commands`, `destructive.forms` |
| Which directories are safe to modify | `workingDirectories` (the session cwd is always added) |
| External-effect asks, pipe-to-shell | `bash` |
| Plan mode behaviour | `modes.plan.mutations` |
| The switches' defaults | `jev.enabled`, `yolo` |
| Doom loop | `doomLoop.threshold`, `doomLoop.state` |
| What Jev is asked | `rules.instructions`, `rules.criteria`, `rules.environment` |
| The audit log | `audit.enabled` |
