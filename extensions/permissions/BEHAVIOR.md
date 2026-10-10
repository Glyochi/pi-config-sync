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
| 4 | Mode | block — in Plan mode, a shell mutation or an effectful MCP call; Ask uses Build's permission profile | `modes` |
| 5 | Bash globs | allow / ask / deny — whole string, last match wins | `bash` |
| 6 | Jev | allow / ask / deny — only for a shell command that hides its intent, and a verdict below the confidence threshold becomes ask | `jev`, `destructive` |
| 7 | Doom loop | ask — the third identical call in a session | `doomLoop` |
| 8 | Nothing matched | allow | |

`classify` in the tables means the classifier decides; its verdict then becomes run,
prompt, or block. `ask` prompts, or blocks when there is no UI to prompt with. YOLO
auto-approves every `ask`. These tables describe this permissions layer; the independent
modes extension's plan-Markdown/path guard is not overridden by its YOLO switch.

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

### Ask mode, Jev on, YOLO off

Ask is a distinct mode label, but its permissions profile is Build. Plan-Markdown path guards are separately owned by the modes extension.

| command | outcome |
|---|---|
| `ls -la /workspace` | allow |
| `git push origin main` | ask |
| `rm -rf /workspace/build` | allow |
| `rm -rf /usr/share/x` | block |

With **Jev off** every `classify` row above becomes `allow` — nothing else changes, and
no classifier call is made. With **YOLO on** every row becomes `allow`, including the
`block` rows.

## What the classifier sees

Jev judges **shell commands only**. Everything else is trusted — `write`, `edit`, `mcp`
never reach it — with the deterministic layers still applying: the credential hard block
checks a file tool's target, and Plan mode refuses effectful MCP.

Within shell commands it is consulted only when the command hides its intent, which is
one of:

- a **destructive verb** — `rm`, `mv`, `cp`, `chmod`, `chown`, `chgrp`, `chattr`, `ln`,
  `install`, `tee`, `dd`, `truncate`, `shred`, `rmdir`, `unlink`, `mkfs`, `wipefs`,
  `mount`, `umount`, `blkdiscard` — or a destructive flag form (`sed -i`, `-delete`,
  `-exec`, `--delete`, `of=`), unless every target is a specific path inside the working
  directories;
- an **interpreter payload** — `bash -c`, `sh -c`, `python -c`, `node -e`, `eval`,
  `xargs … sh -c`;
- an **opaque command word** — a segment starting with `$VAR`, `$(…)`, or a backtick.

A verdict is then judged against `jev.confidenceThreshold` (default `0.3`): at or above
it the verdict stands, below it the verdict becomes `ask`, and a missing confidence
counts as below. Since YOLO auto-approves every ask, that is what makes a shaky verdict
run under YOLO and prompt without it.

## What is never the classifier's job

- Credential paths: blocked before anything else, and never prompts.
- Catastrophic directories: any modification is refused, never prompts.
- External-effect verbs: the bash globs ask deterministically, whether or not the
  command is chained, and regardless of session intent.
- Deletes of specific paths inside the working directories.
- Reads: `read`, `grep`, `find`, `ls` never reach the classifier.

## The footer indicator

The status line, below the stats line, reads `jev on · yolo off · thr 0.30 · jev-1.13`:
the two switches, the confidence threshold in force, and the classifier id. Once Jev has
classified something it gains ` · N reqs`, the number of classifications this session.
Cache hits are not classifications, so they do not count.

Only `jev on` is coloured, in the warning colour, and only `yolo on`, in the error
colour; nothing else is coloured and the line is never coloured as a whole. It reads
`permissions off` when the gate is disabled, because reporting switch values for a gate
that is not running would mislead.

It is one line rather than inline with the cwd: a replaced footer cannot reproduce the
`xp`, `(sub)`, routed-model and `(auto)` markers, which are not reachable from an
extension. Other extensions share that line and it is sorted by key, so `git-sync` and
other extension status entries appear alongside it.

## Asking at runtime

- `/permissions status` — the mode, both switches, the resulting behaviour, the
  threshold, the model, the call count, and a second line spelling the counters out:
  `counters: allow 2 high, 0 low · ask 1 high, 1 low · deny 0 high, 2 low`. The raw
  verdict is crossed with the confidence side, so `high + low` is the call total.
- `/permissions check <tool> <command-or-path>` — a faithful trace: it consults the
  classifier only when the pipeline would, and prints one line per check. Quote a
  command that contains spaces (`check bash "rm -rf /srv/data"`); one pair of
  surrounding quotes is stripped before the engine sees it.
- `/permissions jev on|off`, `/permissions yolo on|off` — the switches.
- `/permissions threshold <0..1>` — set the confidence threshold for this session only;
  bare, it reports the current value. Nothing is written to the file, so a value outside
  0..1 is rejected with a warning and `/permissions reload` restores the file's value.
- `/permissions reload` — re-read `permissions.jsonc`.

Typing `/permissions ` suggests the subcommands, then their values: `on|off` for the
switches, threshold presets, and `check` tool names. Tab reaches the same suggestions —
pi's editor otherwise sends Tab to file completion once the line has a space, so the
extension answers first. `check`'s command or path argument still completes files. A bare
`/permissions bogus` prints the same list as a usage block.

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
| How much a verdict is trusted | `jev.confidenceThreshold` (or `/permissions threshold` for one session) |
| Doom loop | `doomLoop.threshold`, `doomLoop.state` |
| What Jev is asked | `rules.instructions`, `rules.criteria`, `rules.environment` |
| The audit log | `audit.enabled` |
