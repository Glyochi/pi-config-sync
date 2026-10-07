# Pi permission policy rationale

Why the two synced policy files are shaped the way they are. Both travel with
pi-config-sync, so the reasoning reaches every machine.

- [`pi-permissions.jsonc`](./pi-permissions.jsonc) — the `pi-permission-system`
  policy: file tools, MCP, skills, and special checks.
- [`bash-safety.jsonc`](./bash-safety.jsonc) — the `bash-safety` extension: the
  Jev-classified bash gate and its credential hard block.

Extension: `pi-permission-system` (`~/.pi/agent/npm/node_modules/pi-permission-system`)
and `bash-safety` (`~/.pi/agent/extensions/bash-safety`).

## The model

**Two layers, split by what can actually be decided by pattern matching.**

- `pi-permission-system`: allow by default. Ask when a path-bearing file tool
  (`read`, `write`, `edit`, `grep`) touches credentials. `special.external_directory`
  is `allow`; `doom_loop` stays `ask`. Its `bash` section is a single
  `"*": "allow"` — bash is **not** glob-gated.
- `bash-safety`: every bash command the model issues is classified by the
  TypeSafe **Jev** classifier against an editable rule prompt. Credential paths
  are hard-blocked deterministically before the classifier is consulted.

## Why bash moved to a classifier

### The container removes the blast radius that globs were protecting

Pi runs inside the `linux-quick-setup` Docker container (see
`docker-compose.yaml`). The relevant facts:

- Runs as uid 1000 `dev`, `CapEff=0`, no docker socket -> no privilege
  escalation and no container escape.
- `/` is an ephemeral overlay: package installs, `/etc` edits, and dotfiles
  vanish when the container is recreated and never touch the host.
- The only persistent mounts are `/workspace` (the host project directory,
  normally git-tracked) and the `pi-auth`, `pi-sessions`, `pi-state` volumes.

So the classic reason for a guarded shell — protecting the host OS — does not
apply, and the delete question shrinks to *where*: files inside the working
directories are cheap to lose, while a recursive delete aimed at `/`, `/usr`, or
`~` can break the container or the mounted project.

### The remaining risk is semantic, not lexical

What is actually expensive is an effect *outside* the container: a push, a cloud
or CI/CD mutation, an authenticated upload. Whether one is justified depends on
what the session was asked to do, which no glob can know. `git push` in a
"land this fix" session is routine; the same command in a "read this file and
summarize it" session is a red flag.

Jev is given the command, `cwd`, the repo's remote and branch, the session intent
(session name, original task, latest user message), and an environment blurb, and
returns one of `allow` / `ask` / `deny`.

## What each verdict does

| Verdict | UI, YOLO off | UI, YOLO on | No UI (`print`/`json`, subagents) |
|---|---|---|---|
| `allow` | runs | runs | runs |
| `ask` | prompts — "Jev is unsure" | runs, with a session-once notice | blocked |
| `deny` | prompts — "Jev disapproves, be careful" | prompts | blocked |
| hard block | blocked | blocked | blocked |
| classifier failure | runs, with a warning | runs, with a warning | runs |

`deny` is an emphasis, not a hard stop, whenever a UI exists: the user can still
approve the command. Only the credential hard block is absolute.

`/bash-safety check` and the `ask`/`deny` confirmation dialogs print the full
`allow` / `ask` / `deny` probability distribution, not just the winning label, so
a low-confidence verdict (for example `deny 0.52` against `ask 0.38`) is visible
when deciding.

## The credential hard block

Case-insensitive substring matching over the whole command string against
`auth.json`, `.pi/agent/auth`, `.git-credentials`, `.netrc`, `.npmrc`, `.ssh/`,
`.aws/`, `.config/gh/`, `.docker/config.json`, `.env`, `token`, `secret`, and
`credential`, with exemptions for `.env.example`, `.env.sample`, and
`.env.template`. A match returns `{ block: true }` before any classifier call.
It never prompts, and YOLO never bypasses it.

This is the one risk the container does **not** mitigate. The agent process has
to read `~/.pi/agent/auth/auth.json` to talk to the model, the container has
outbound network access, and "re-authenticate" is not the same as "rotate a
leaked key" — a leaked key stays valid until revoked.

The pattern list is also a built-in default, so a missing or unparsable
`bash-safety.jsonc` still blocks credentials.

## Delete guidance: working directories

`bash-safety.jsonc` has a `workingDirectories` list (default `/workspace` and
`/tmp`), and the session `cwd` is always added to it at runtime. The resolved
list reaches Jev as part of the state, and the criteria spell out the
consequence:

- A delete inside a working directory is `allow` — the normal case for the
  task's own files.
- A destructive delete outside them is `deny`, naming `rm -rf /`, `rm -rf /*`,
  `rm -rf /usr`, and `rm -rf ~`, plus any recursive force delete aimed at the
  container root or a system path.
- A delete target that is neither clearly inside nor clearly outside is `ask`.

This is prompt-level guidance, not a hard block. A `deny` verdict still prompts
rather than blocking whenever a UI exists, and Jev can still be wrong. The reason
it is guidance rather than a matcher is that "outside the working directories"
cannot be decided by string matching — `/workspace/../..` and
`$(git rev-parse --show-toplevel)` both defeat it, and a false hard block on a
legitimate `rm` costs more than a prompt. The only deterministic delete-adjacent
rule remains the credential hard block.

## Why the file-tool credential asks stay

`read:*/.pi/agent/auth/*`, `read:*/.git-credentials*`, and the rest of the
`tools` rules gate the path-bearing built-ins. Those calls never reach the bash
gate, so the two layers are complementary: bash-shaped checks cannot see
`read`/`write`/`edit`/`grep`, and a command-string classifier cannot see a tool's
target path.

## Why chains, pipes, and redirection are allowed

`;`, `&&`, `||`, `|`, `$( )`, backticks, and `>` are not separately gated. The
classifier receives the whole command string as one blob, which is exactly the
input it is good at reading. Blocking chaining produced far more prompts than
safety.

## YOLO

YOLO is a single shared switch. `bash-safety` reads and writes
`globalThis.__piPermissionSystem`, the runtime API `pi-permission-system`
publishes, so `/permission-system` and `/bash-safety yolo` flip the same state
(persisted in `extensions/pi-permission-system/config.json`).

Under YOLO, `ask` auto-runs in every mode, including without a UI — that is the
deliberate escape hatch for delegated or unattended work. `deny` and the hard
block are unaffected.

## Failure handling

`classify()` never rejects, so the gate checks `stopReason` and `errorMessage`
itself. A failure (error, timeout, missing credentials, rate limit) allows the
command, notifies when a UI exists, and counts toward a per-session breaker: after
three consecutive failures the gate stops classifying for the rest of the session
and says so once. A success resets the counter.

Fail-open is deliberate. `pi-permission-system`'s file-tool rules remain in force,
and the credential hard block is deterministic and unaffected by the breaker, so a
classifier outage degrades the gate rather than stopping work.

## Cost

`classify()` reports usage, and a `tool_result` handler attaches it to the bash
tool result, combined with any usage the tool itself reported. An executed
command's classifier cost therefore lands in the session totals under
`Tools/summaries` in the footer and `/session`. Measured at about $0.00004 per
command at `jev-1.13` pricing.

Blocked calls never produce a tool result, so their classifier cost stays
uncounted: a hard block, a no-UI `ask`/`deny`, an `ask`/`deny` you reject, and
`/bash-safety check` all spend a call that the totals do not show. The pending
usage map is bounded at 64 entries and cleared each session, because those
entries never get a result to consume them.

## No UI, and subagents

In `print`/`json` mode and inside subagents there is no way to prompt, so `ask`
and `deny` both block with distinct reasons and no subagent permission forwarding
is implemented. YOLO is the supported way to let delegated work run.

## How the matching works in `pi-permissions.jsonc`

- `tools` patterns are matched against resource keys of the form
  `<action>:<normalized-absolute-path>` with **last-matching-rule-wins**, so a
  later credential `ask` beats the earlier `"*": "allow"`.
- `*` matches any characters, including `;`, `|`, and newlines.
- The config is JSONC: comments and trailing commas are supported.
  `pi-permission-system` only **reads** this file (the `/permission-system` modal
  writes the extension `config.json`), so comments are safe.

## Known limitations

- The bash hard block is best-effort string matching. `$VAR` indirection, base64,
  and file reads through a helper script are not caught.
- Bare words over-match: a command containing `token`, `secret`, or `credential`
  anywhere is blocked even when unrelated.
- No egress control is configured. A prompt-injected session can still exfiltrate
  whatever the gate did not recognize over the network.
- The classifier is a network call: one round trip per bash command (identical
  commands are served from a bounded per-session cache). At `jev-1.13` pricing
  this is about $0.042 per 1M input tokens.
- Delete guidance is a prompt, not a matcher: an out-of-bounds delete relies on
  the classifier noticing it, and a `deny` verdict only prompts in the TUI.
- The `powershell` tool is not gated by `bash-safety`.
- The file-tool credential rules cover `read`/`write`/`edit`/`grep`; `find`/`ls`
  metadata on credential paths is not gated.
- `mv` deletes its source but is allowed, and `> existing-file` overwrites without
  asking; both now fall to the classifier's judgement when run through bash.

## How to change the policy

1. Bash behaviour and rules: edit `~/.pi/agent/bash-safety.jsonc` (including
   `workingDirectories`), then run `/bash-safety reload`. Inspect with
   `/bash-safety status` and dry-run a command with `/bash-safety check <command>`.
2. File-tool, MCP, skill, and special behaviour: edit
   `~/.pi/agent/pi-permissions.jsonc`, then `/reload` (or restart Pi).
3. Validate: the file must parse as JSONC.
4. pi-config-sync commits and pushes the change on the next sync; run
   `/gitsync sync` to do it immediately.
