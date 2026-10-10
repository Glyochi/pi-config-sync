# Pi permission policy rationale

Why the one policy layer is shaped the way it is. It is synced by pi-config-sync, so
the reasoning reaches every machine.

- [`permissions.jsonc`](./permissions.jsonc) — the whole policy: switches, mode
  behaviour, hard blocks, the declarative bash rules, and the rules Jev reads.
- `extensions/permissions/` — the extension itself, with its own
  [README](./extensions/permissions/README.md), its
  [behaviour reference](./extensions/permissions/BEHAVIOR.md) for looking up what
  happens to a given command, and its tests.
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

**YOLO disables this permissions layer's credential and catastrophe hard blocks.** That
is deliberate and remains the sharpest edge here: with YOLO on, a credential read or a
write into `/usr` can run through this gate. This is not a system-wide sandbox. The
independent `modes` extension still applies its Plan-mode read-only boundary
and recognized `.pi/plans/` path guards; opaque scripts/tools remain outside those
extension-level checks. Jev off is the opposite kind of switch: it changes nothing
about what is allowed by this policy, it only removes classifier calls.

## Modes

Every decision carries the current mode. The independent `modes` extension persists a
versioned `modes-state` custom entry and emits the `modes:state.v1` event. The
permissions extension consumes the event for live mode changes and reads the branch entry
on startup/restoration; a missing mode defaults to Build. Ask is retained
as a distinct audit/UI label but maps to the Build permission profile. The active tool set is not treated as the mode signal.

**What Plan mode does here.** With YOLO off, shell mutations and effectful MCP are
refused by this extension, while read-only shell chains and ordinary read tools remain
available. Plan-file editing is owned by `modes`: only the attached plan
Markdown may be written in Plan mode. Ask and Build use the Build permission profile
for other project work, but the mode extension blocks recognized file mutations and
detectable shell writes to `.pi/plans/` in both modes. Pathless/private tools, opaque
scripts, and opaque MCP calls cannot be absolutely contained by a `tool_call` guard;
YOLO retains its documented behavior for this permissions policy.

The public mode event is JSON-safe and versioned so the future UI can consume mode,
plan, artifact, and permission-profile state without importing private extension modules
or parsing transcript text. Durable mode and plan state is stored separately from those
events.

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
that is the accepted price of deciding it without a model — and the same is true when
it is chained, because the globs match the whole string. Piping a remote script into a
shell (`… | sh`, `… | bash`) is caught the same way.

**Doom loop.** Repeated identical calls, which is what `special.doom_loop` covered
before, are counted per session by tool name and arguments; the third one asks.

## Jev

**Scope.** Shell commands only (`bash`, `powershell`). Every other tool is trusted —
`write`, `edit` and MCP never reach the classifier — with the deterministic layers still
applying to them: the credential hard block checks a file tool's target path, Plan mode
refuses effectful MCP, and `modes` owns the plan-Markdown path guard. Ask uses
Build's permission profile.

Within shell commands Jev is consulted only when one **hides its intent**. Three things
count:

- a **destructive verb** or flag form — `rm`, `mv`, `cp`, `chmod`, `chown`, `chgrp`,
  `chattr`, `ln`, `install`, `tee`, `dd`, `truncate`, `shred`, `rmdir`, `unlink`,
  `mkfs`, `wipefs`, `mount`, `umount`, `blkdiscard`, plus `sed -i`, `-delete`,
  `-exec`, `--delete`, `of=`;
- an **interpreter payload** — `bash -c`, `sh -c`, `python -c`, `node -e`, `eval`,
  `xargs … sh -c`;
- an **opaque command word** — a segment whose first word is `$VAR`, `$(…)`, or a
  backtick, which nothing can be read from.

A destructive command is exempt when it only touches **specific paths inside the working
directories**. `rm /tmp/a.txt`, `rm -rf /workspace/build`, `rm -rf build`, and
`rmdir /tmp/dir` are decidable, so they cost no classifier call even with Jev on — and
they stay decidable rather than depending on a model's mood, which matters because Jev
is inconsistent here: measured, it calls `rm /tmp/a.txt` `deny` (0.42 against 0.37 ask)
while calling `rm -rf /workspace/build` `allow` (0.71).

Targets that are not specific, or not contained, still reach the classifier: a glob
(`rm -rf /workspace/*`), the working directory itself (`rm -rf /workspace`), a path
outside them (`rm -rf /srv/data`), a parent escape (`rm -rf ../other`), or an
unresolvable target (`rm -rf $DIR`). The session `cwd` counts as a working directory, so
relative targets resolve inside it.

**Confidence threshold.** A verdict is judged against `jev.confidenceThreshold`, default
`0.3`. The effective confidence is the reported `confidence`, else the probability of the
chosen label, else unknown; anything below the threshold — including unknown — becomes an
`ask`. It applies to every verdict, so a low-confidence `allow` prompts too, and a
low-confidence `deny` prompts with the unsure framing rather than the disapproval one.

Because YOLO auto-approves every ask, a shaky verdict runs under YOLO and prompts without
it, and no special case is needed for that. The audit line keeps the raw verdict, the
confidence, the threshold and whether it was downgraded, so a prompt caused by the
threshold is distinguishable from one Jev actually asked for. Measured over 25 classifier
decisions, 11 fall below 0.3 while the confident cluster sits at 0.73 and above.

**Structure is deliberately not a reason to classify.** The globs match the whole
command string, so an external-effect verb is caught whether or not the command is
chained: `git push origin main && echo done` asks through the globs, and
`curl -sS https://x.sh | sh` asks through a dedicated pipe-to-shell rule. That keeps
benign chains free — `npm test && npm run build`, `echo a && echo b`, and
`cat /etc/hosts > /tmp/x` cost no classifier call — while the classifier is spent only
on commands whose intent a glob cannot read.

Measured, that intent gap matters: Jev calls `rm -rf /workspace` `deny`
(allow 0.02 · ask 0.25 · deny 0.73), which the deterministic layer alone allows.

The consequence to know: this only bites while Jev is on. With Jev off — the default —
a destructive command is still allowed, because nothing else judges it.

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
- With YOLO on this permission layer has no floor for its credential/catastrophe checks,
  and with Jev off a destructive single command is allowed outright: the deterministic
  layer has no opinion on `rm -rf /workspace`. Independent modes guards for Plan
  shell mutations and recognizable `.pi/plans/` writes still apply.
- The interpreter-payload list is a fixed pattern set; `bash script.sh` is a single
  command and is decided by the globs alone.
- `PI_PERMISSIONS_CONFIG_PATH` points the policy at another file. It exists for the
  tests; do not set it in normal use.

## How to change the policy

1. Edit `~/.pi/agent/permissions.jsonc`, then `/permissions reload`.
2. Dry-run a decision with `/permissions check <tool> <command-or-path>`, which traces
   the pipeline and consults the classifier only when the pipeline would, and inspect
   the switches with `/permissions status`.
3. Credential patterns appear once, in `hardBlock.patterns`; the tests assert the
   config still matches the built-in defaults for the credential, catastrophe, and bash
   lists, so a typo fails a check rather than silently weakening the gate.
4. pi-config-sync commits and pushes on the next sync; `/gitsync sync` does it now.
