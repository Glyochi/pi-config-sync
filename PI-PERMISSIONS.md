# Pi permission policy rationale

Why the synced policy files are shaped the way they are. They travel with
pi-config-sync, so the reasoning reaches every machine.

- [`pi-permissions.jsonc`](./pi-permissions.jsonc) — the `pi-permission-system`
  policy: the declarative bash globs, plus file tools, MCP, skills, and special
  checks.
- [`bash-safety.jsonc`](./bash-safety.jsonc) — the `bash-safety` extension: the
  Jev rules, the credential matcher, and the working-directory guidance.
- `extensions/bash-safety/` — the extension itself, with its tests and its own
  [README](./extensions/bash-safety/README.md).

## The model

**Two bash layers, split by what a glob can read, plus the ordering fact that
makes the split work.**

Local `agentDir/extensions/` is discovered before configured package paths, so
`bash-safety` always runs *before* `pi-permission-system`, and `emitToolCall()`
returns on the first handler that blocks. Therefore:

- A rule in `bash-safety` runs first and can decide **without** paying for a
  classifier call.
- A glob in `pi-permissions.jsonc` runs second, so it cannot skip the classifier —
  it can only add a decision after Jev has made one.
- The credential check has to live in `bash-safety`, because it must precede
  classification.

The split itself:

| Command | Decided by | Cost |
|---|---|---|
| Single command, no shell syntax | `pi-permissions.jsonc` globs | instant, free |
| Compound command (`;`, `&&`, `\|\|`, `\|`, `&`, `>`, `<`, backtick, `$(`, newline) | Jev | one round trip |
| Interpreter payload (`bash -c`, `sh -c`, `python -c`, `node -e`, `eval`, `xargs … sh -c`, …) | Jev | one round trip |
| Compound, but every segment read-only and nothing redirected | neither — passes through | instant, free |
| Anything touching a credential path | `bash-safety` hard block | instant, free |

Everything else — file tools, MCP, skills, `special` — stays with
`pi-permission-system`: allow by default, ask when a path-bearing file tool
(`read`, `write`, `edit`, `grep`) touches credentials, `special.external_directory`
`allow`, `doom_loop` `ask`.

## The declarative bash policy

Rules are globs matched against the **whole command string**, with
**last-matching-rule-wins**, so the order is broad allow → asks → denies.

- **Ask** on external-effect verbs: `git push`, `gh`, `aws`, `gcloud`, `az`,
  `kubectl`, `terraform`, `docker push`, `npm publish`, `ssh`, `scp`, `rsync`,
  authenticated or uploading `curl`/`wget`, and `sudo`.
- **Deny** credential paths (see below).
- **Deny** catastrophic deletes last: `rm -rf`/`rm -fr` of `/usr`, `/bin`,
  `/sbin`, `/lib`, `/etc`, `/var`, `/boot`, `/opt`, `/root`, `/sys`, `/proc`,
  `~`, `$HOME`, and `/` as the final token.

There is deliberately **no bare `*rm -rf /*` rule**: it would also deny
`rm -rf /workspace/build` and `rm -rf /tmp/x`, which the working-directory policy
allows. Only the named system paths, home, and root-as-final-token are denied.

A single external-effect command asks **every time**, regardless of session
intent. That is the accepted price of deciding it without a model: a `git push`
in a session whose whole purpose is to push still asks.

## Credentials

Two mechanisms, by necessity:

1. **`bash-safety`'s matcher** — case-insensitive substring matching over the
   whole command, run before any classifier call, covering simple *and* compound
   commands. It returns `{ block: true }` and short-circuits. It never prompts,
   and YOLO never bypasses it. The pattern list carries no trailing slash on
   directories (`.ssh`, `.aws`, `.config/gh`) so `find ~/.ssh -name 'id_*'` matches
   too, and exemptions re-allow `.env.example`, `.env.sample`, and `.env.template`.
2. **`pi-permissions.jsonc` deny globs** — the declarative backstop. These are what
   keep credentials blocked when the gate is switched off with `/bash-safety off`.
   Globs cannot express a negative match, so the env-template exemptions are
   re-allowed *after* the denies.

`tests/lib.test.ts` asserts that the two lists cover exactly the same set, so the
duplication cannot drift.

This is the one risk the container does **not** mitigate. The agent process has to
read `~/.pi/agent/auth/auth.json` to talk to the model, the container has outbound
network access, and "re-authenticate" is not the same as "rotate a leaked key" — a
leaked key stays valid until revoked.

## Why the split, and why not pure globs

### The container removes the blast radius that globs were protecting

Pi runs inside the `linux-quick-setup` Docker container (see
`docker-compose.yaml`):

- Runs as uid 1000 `dev`, `CapEff=0`, no docker socket -> no privilege escalation
  and no container escape.
- `/` is an ephemeral overlay: package installs, `/etc` edits, and dotfiles vanish
  when the container is recreated and never touch the host.
- The only persistent mounts are `/workspace` (the host project directory,
  normally git-tracked) and the `pi-auth`, `pi-sessions`, `pi-state` volumes.

So the classic reason for a guarded shell does not apply, and the delete question
shrinks to *where*: files inside the working directories are cheap to lose, while a
recursive delete aimed at `/`, `/usr`, or `~` can break the container or the
mounted project. Those specific paths are denied by glob; the rest is left alone.

### The remaining risk is semantic, not lexical

What is actually expensive is an effect *outside* the container — a push, a cloud
or CI/CD mutation, an authenticated upload — and what makes a command dangerous can
be *how* it is written: `find ~/.pi/agent -name 'au*json' -exec cp -p {} /tmp/x \;`
never contains the literal `auth.json`, and `bash -c '…'` hides its payload behind a
single innocuous token. Globs read the first token; they cannot read a chain.

So Jev gets the command, `cwd`, the repo's remote and branch, the session intent
(session name, original task, latest user message), and an environment blurb, and
returns `allow` / `ask` / `deny` — but only for the commands a glob cannot read.

### Why not classify everything

Because it costs a round trip on every command. Measured against the real prompt:
**319 / 575 / 368 ms, 1026 input tokens, $0.000043 per call**, on the critical path,
since `tool_call` handlers are awaited before the tool executes. A session with 40
bash calls paid 15–25 s for judgements that were usually obvious. Single commands
and read-only chains now pay nothing.

## What each Jev verdict does

| Verdict | UI, YOLO off | UI, YOLO on | No UI (`print`/`json`, subagents) |
|---|---|---|---|
| `allow` | runs | runs | runs |
| `ask` | prompts — "Jev is unsure" | runs, with a session-once notice | blocked |
| `deny` | prompts — "Jev disapproves, be careful" | prompts | blocked |
| hard block | blocked | blocked | blocked |
| classifier failure | runs, with a warning | runs, with a warning | runs |

`deny` is an emphasis, not a hard stop, whenever a UI exists. Only the credential
hard block is absolute. `/bash-safety check` and the `ask`/`deny` dialogs print the
full `allow` / `ask` / `deny` probability distribution.

The glob layer behaves like `pi-permission-system` always has: `ask` prompts with
Allow Once / Allow Always / Reject, and **blocks** when no UI can resolve it
(`canResolveAskPermissionRequest` is true only with a UI, in a subagent, or under
YOLO). A configured `deny` is a hard boundary and is never relaxed by YOLO or by a
previous approval.

## YOLO

One shared switch. `bash-safety` reads and writes
`globalThis.__piPermissionSystem`, the runtime API `pi-permission-system` publishes,
so `/permission-system` and `/bash-safety yolo` flip the same state, persisted in
`extensions/pi-permission-system/config.json`.

Under YOLO, `ask` auto-runs in every mode — Jev's verdicts *and* the glob asks.
That is deliberate for delegated or unattended work, but it means **YOLO also
silently approves `git push`, `aws`, `sudo`, and uploads**. `deny` and the hard
block are unaffected.

> Check this before relying on the glob asks: that config's `yoloMode` has been
> observed set to `true`, which makes every external-effect ask auto-approve.
> `/bash-safety yolo off` turns it off.

## Failure handling

`classify()` never rejects, so the gate checks `stopReason` and `errorMessage`
itself. A failure (error, timeout, missing credentials, rate limit) allows the
command, notifies when a UI exists, and counts toward a per-session breaker: after
three consecutive failures the gate stops classifying for the rest of the session
and says so once. A success resets the counter.

Fail-open is deliberate. The glob layer and the credential hard block are
deterministic and unaffected by the breaker, so a classifier outage degrades the
gate rather than stopping work.

## Cost

`classify()` reports usage, and a `tool_result` handler attaches it to the bash
tool result, so an executed command's classifier cost lands in the session totals
under `Tools/summaries` in the footer and `/session` — about $0.000043 per
classified command at `jev-1.13` pricing, and now only for compound or interpreter
commands.

Blocked calls never produce a tool result, so their classifier cost stays
uncounted: a hard block, a no-UI `ask`/`deny`, an `ask`/`deny` you reject, and
`/bash-safety check` all spend a call the totals do not show. The pending-usage map
is bounded at 64 entries and cleared each session.

## Toggling

- `/bash-safety off` — session-scoped. Skips both the credential block and Jev,
  leaving the declarative globs as the only bash gate. `/bash-safety on` restores
  it. No file edit and no reload.
- `"enabled": false` in `bash-safety.jsonc`, then `/bash-safety reload` — the same
  thing at load time.
- `pi config` — disables the extension itself, persistently. Equivalent manual
  edit: `"extensions": ["-extensions/bash-safety"]` in `settings.json`.
- `/bash-safety yolo on|off` — not an off switch; it only relaxes `ask`.

## Delete guidance

The `workingDirectories` list (default `/workspace`, `/tmp`, plus the session
`cwd`) and the criteria that deletes inside them are `allow` while destructive
deletes outside them are `deny` now apply only to **compound** deletes, since a
single `rm` is decided by the globs. Measured behaviour is unchanged: a plain
`rm -rf` inside a working directory is a near coin flip (allow 0.42 vs deny 0.38),
so it prompts about half the time.

## Known limitations

- The bash hard block is best-effort string matching. `$VAR` indirection, base64,
  a globbed filename (`find ~/.pi/agent -name 'au*json'`), and file reads through a
  helper script are not caught. That glob form passes the hard block and the
  classifier returns `deny` (0.68 vs 0.26 ask).
- Bare words over-match: a command containing `token`, `secret`, or `credential`
  anywhere is blocked even when unrelated. The declarative globs repeat this.
- Single external-effect commands ask regardless of intent; a compound command Jev
  allows can still hit a glob ask afterwards, which can mean two dialogs.
- The interpreter-payload list is a fixed pattern set. `bash script.sh`,
  `python script.py`, and `make deploy` are single commands with no inline payload,
  so they are decided by the globs alone.
- No egress control is configured. A prompt-injected session can still exfiltrate
  whatever neither layer recognized.
- The `powershell` tool is not gated by `bash-safety`.
- The file-tool credential rules cover `read`/`write`/`edit`/`grep`; `find`/`ls`
  metadata on credential paths is not gated.

## How to change the policy

1. Single-command behaviour: edit the `bash` globs in `pi-permissions.jsonc`, then
   `/reload`. Validate with `tests/lib.test.ts`, which asserts the glob verdicts
   for a table of commands.
2. Compound-command behaviour and the rules Jev reads: edit
   `~/.pi/agent/bash-safety.jsonc`, then `/bash-safety reload`. Dry-run a command
   with `/bash-safety check <command>`.
3. Credential patterns: change them in *both* files; the sync check in
   `tests/lib.test.ts` fails if the two lists diverge.
4. pi-config-sync commits and pushes on the next sync; `/gitsync sync` does it now.
