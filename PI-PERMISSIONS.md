# Pi permission policy rationale

Why the one policy layer is shaped the way it is. It is synced by pi-config-sync, so
the reasoning reaches every machine.

- [`permissions.jsonc`](./permissions.jsonc) — the whole policy: switches, mode
  behaviour, hard blocks, the declarative bash rules, and the rules Jev reads.
- `extensions/permissions/` — the extension itself, with its own
  [README](./extensions/permissions/README.md) and tests.
- Command: `/permissions`.

This replaced two things: `pi-permission-system` (removed from `settings.json`) and
the `bash-safety` extension (absorbed and deleted), along with the retired
`pi-permissions.jsonc` and `bash-safety.jsonc`.

## The model

One `tool_call` handler, applied in this order:

1. **YOLO on** → allow. No gating at all.
2. **Hard blocks** — credential patterns, and the catastrophe gate for shell commands.
3. **Mode** — shell mutations and effectful MCP are refused in Plan mode.
4. **Declarative bash globs** — whole-string, last-match-wins.
5. **Jev**, when the Jev switch is on, for effectful tools a rule cannot read.
6. **Approvals** — one-shot `Allow once` / `Reject`.

Every registered tool is covered. Reads (`read`, `grep`, `find`, `ls`) are decided
deterministically only. Effectful tools (`bash`, `powershell`, `write`, `edit`, the
`mcp` proxy and directly registered `mcp__*` tools) can reach Jev. Anything else —
the plan tools, `question` — is neutral and passes.

## The two switches

Independent, so there are four combinations:

| JEV | YOLO | Behaviour |
|---|---|---|
| on | off | deterministic rules, then Jev; `ask` prompts; hard blocks absolute |
| on | on | deterministic rules, then Jev; `ask` auto-approved; **hard blocks disabled** |
| off | off | deterministic rules only, no classifier call; `ask` prompts; hard blocks absolute |
| off | on | deterministic rules only; `ask` auto-approved; **hard blocks disabled** |

Both default from the policy file — Jev off, YOLO off — and `/permissions jev on|off`
and `/permissions yolo on|off` flip them for the session.

**YOLO disables the credential and catastrophe hard blocks.** That is deliberate and it
is the sharpest edge in the system: with YOLO on there is no floor at all, so a
credential read or a write into `/usr` runs untouched, in any mode. The audit log is
then the only record. Jev off is the opposite kind of switch: it changes nothing about
what is allowed, it only removes the classifier calls.

## Modes

Every decision carries the current mode. The mode comes from `pi-plan-build`, which
publishes no runtime API and emits no events, so it is read in this order:

1. `pi.getFlag("plan")` / `pi.getFlag("build")` — the only signal available before the
   first state entry exists.
2. The newest `pi-plan-build-state` custom session entry from the session branch,
   reading `data.selectedMode`.
3. `"build"`.

Resolved per turn in `before_agent_start`, and refreshed on a tool call when the
session leaf moved, so a mid-turn switch is seen. The active tool set is **not** a
signal: `stableToolCatalog` defaults to `true`, so both modes receive the same managed
plan tools.

**What Plan mode does here.** Shell mutations are refused — anything that is not a
read-only chain, so `rm`, `mv`, `sed -i`, `git reset --hard`, and a redirect are all
blocked while `ls`, `cat`, `git status && git diff` still work. Effectful MCP is
refused too, and effectful MCP tools are removed from the prompt for the turn.

**What Plan mode deliberately does not own.** `write` and `edit` stay with
`pi-plan-build`, which already blocks them in Plan mode and already exempts the plan
Markdown that Plan mode has to be able to revise. Duplicating that here would have
either blocked plan revision or required copying pi-plan-build's plan-path logic.

Observed detail: `pi -p --plan` does **not** persist a state entry in print mode, so
headless Plan testing drives the mode from a session that already carries the entry.
The TUI path is the real one and is covered by the human checks.

## The deterministic core

**Hard blocks.** Credential patterns are matched case-insensitively as substrings: a
shell command against its whole string, and a path-bearing file tool against its target
path. A shell match blocks outright; a file-tool match follows `fileTools.credential`,
which is `ask` — that preserves the behaviour `pi-permission-system` had for those
tools. Directory patterns carry no trailing slash (`.ssh`, `.aws`, `.config/gh`) so
`find ~/.ssh -name 'id_*'` matches too, and the env templates are exempt.

**Catastrophe gate.** Any *modification* of a catastrophic directory is refused, not
just `rm -rf`. `catastrophe.paths` and `catastrophe.commands` are listed separately and
combined at match time, so one new entry covers it against every entry of the other
list. Matching is command-position aware, after skipping `sudo`, `env`, `nohup`,
`nice`, `ionice`, `time`, `timeout`, `xargs`, `command`, `exec`, `setsid`, and `stdbuf`
plus their flags, so `git commit -m "fix rm handling in /etc"` is not blocked.
Redirection targets are parsed, so `cat /etc/hosts > /tmp/x` passes while
`echo x > /etc/hosts` does not, and `2>/dev/null` is ignored. Deny never prompts.

**Declarative bash rules.** Whole-string globs, last-match-wins, ordered allow → ask →
deny. They decide single commands for free: an external-effect verb (`git push`, `gh`,
`aws`, `gcloud`, `az`, `kubectl`, `terraform`, `docker push`, `npm publish`, `ssh`,
`scp`, `rsync`, an uploading `curl`/`wget`, `sudo`) asks; everything else is allowed.
A single external-effect command asks **every time**, regardless of session intent —
that is the accepted price of deciding it without a model.

**Doom loop.** Repeated identical calls, which is what `special.doom_loop` covered
before, are counted per session by tool name and arguments; the third one asks.

## Jev

**Scope.** Effectful tools only, and for shell tools only when a glob cannot read the
command. That means a compound command, an interpreter payload, or a **destructive
verb** — `rm`, `mv`, `chmod`, `dd`, `tee`, `truncate`, `shred`, `cp`, `ln`, `install`,
`chown`, `chgrp`, `chattr`, `rmdir`, `unlink`, `mkfs`, `wipefs`, `mount`, `umount`,
`blkdiscard` — or a destructive flag form (`sed -i`, `-delete`, `-exec`, `--delete`,
`of=`).

A read-only chain and a single command that changes nothing are decided by the globs,
so they cost no classifier call. A destructive verb is the case a glob cannot judge:
`rm -rf /workspace` is one command, but whether it fits the task is a question only the
model can answer. Measured, Jev calls it `deny` (allow 0.02 · ask 0.25 · deny 0.73),
which the deterministic layer alone would have allowed.

The consequence to know: this only bites while Jev is on. With Jev off — the default —
a destructive single command is still allowed, because nothing else judges it.

**Payload.** Tool name, mode, the command or target path, a capped preview of the
content or arguments, the session intent (session name, original task or latest
compaction summary, latest user message), and the environment blurb.

**Failure handling.** `classify()` never rejects, so the gate checks `stopReason` and
`errorMessage` itself. A failure allows the action, notifies when a UI exists, and
counts toward a per-session breaker: after three consecutive failures the gate stops
classifying for the rest of the session and says so once. Fail-open is deliberate — the
deterministic layers are unaffected, so an outage degrades the gate rather than
stopping work.

**Cost.** Usage rides on the tool result through a `tool_result` handler, so it lands in
the session totals under `Tools/summaries`. A blocked call never produces a tool result,
so its cost stays uncounted. At `jev-1.13` pricing a call is about $0.00004.

## Approvals

One-shot: `Allow once` or `Reject`. Nothing is stored, so there is no "Allow Always" —
YOLO is the answer for repeated approval. With no UI and no forwarding, an `ask`
blocks.

## Subagent forwarding

A subagent has no UI, so an `ask` travels to the interactive parent. The protocol is
files under `<agentDir>/permission-forwarding/sessions/<sessionId>/{requests,responses}`:
the requester writes a request and waits, the parent scans every 2 seconds, prompts, and
answers, with a 10-minute timeout. Subagent detection uses `PI_IS_SUBAGENT`,
`PI_SUBAGENT_SESSION_ID`, and `PI_AGENT_ROUTER_SUBAGENT`; the parent session id comes
from `PI_AGENT_ROUTER_PARENT_SESSION_ID`; the root can be redirected with
`PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR`.

## Audit log

One JSONL line per decision at `extensions/permissions/logs/permissions.jsonl`, with the
tool, mode, both switches, the decision, its source (`deterministic`, `classifier`,
`cache`, `doom-loop`, `breaker-open`, `classifier-failure`, `forwarding`), and the
reason or confidence. That directory is on pi-config-sync's denylist, so it never leaves
the machine. Disable with `audit.enabled: false`.

## What was dropped

Removed with `pi-permission-system`: skill gating and skill prompt sanitization, the
config modal and Zellij modal, JSON-schema validation, the `globalThis.__piPermissionSystem`
runtime API, and per-agent frontmatter policy. `skills` and
`special.external_directory` were both `allow` before, so leaving them ungated preserves
their behaviour rather than changing it. `special.doom_loop: ask` is reimplemented as
`doomLoop`.

## Known limitations

- Credential matching is substring based, so a bare word over-matches: a command
  containing `token` anywhere is blocked even when unrelated.
- The catastrophe gate resolves one command word per segment, so a wrapper given a
  value-taking flag hides it (`sudo -u root chmod 000 /etc/passwd` is not blocked), and
  `tar -xf x.tar -C /usr` is missed because `tar` is not in `commands`. `cp` and `ln`
  are blunt: copying a file *out* of a system directory is denied even though it only
  reads.
- Jev's verdicts are probabilistic, and its failure mode is fail-open.
- Forwarding is implemented but has not been exercised against a live subagent.
- With YOLO on there is no floor at all, and with Jev off a destructive single command
  is allowed outright: the deterministic layer has no opinion on `rm -rf /workspace`.
- The interpreter-payload list is a fixed pattern set; `bash script.sh` is a single
  command and is decided by the globs alone.
- `PI_PERMISSIONS_CONFIG_PATH` points the policy at another file. It exists for the
  tests; do not set it in normal use.

## How to change the policy

1. Edit `~/.pi/agent/permissions.jsonc`, then `/permissions reload`.
2. Dry-run a decision with `/permissions check <tool> <command-or-path>`, and inspect
   the switches with `/permissions status`.
3. Credential patterns appear once, in `hardBlock.patterns`; the tests assert the
   config still matches the built-in defaults for the credential, catastrophe, and bash
   lists, so a typo fails a check rather than silently weakening the gate.
4. pi-config-sync commits and pushes on the next sync; `/gitsync sync` does it now.
