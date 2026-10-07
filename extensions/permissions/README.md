# permissions

One policy layer for every tool. A deterministic core decides what it can for free —
credential and catastrophe hard blocks, the mode dimension, and the declarative bash
rules — and the TypeSafe **Jev** classifier is consulted only for effectful tools a rule
cannot read, and only while the Jev switch is on.

Policy: [`../../permissions.jsonc`](../../permissions.jsonc). Rationale:
[`../../PI-PERMISSIONS.md`](../../PI-PERMISSIONS.md). Command: `/permissions`.
Quick lookup for "what happens to this command": [`BEHAVIOR.md`](./BEHAVIOR.md).

This extension replaced `pi-permission-system` and absorbed the former `bash-safety`
extension.

| File | Purpose |
|---|---|
| `index.ts` | Pi wiring: the `tool_call` pipeline, `before_agent_start` prompt sanitization, `tool_result` usage attribution, subagent forwarding, the audit log, and `/permissions` |
| `lib.ts` | Pure helpers with no `@earendil-works/...` imports, so plain `node` can test them |
| `tests/lib.test.ts` | The policy engine: config normalisation, mode resolution, the switch matrix, tool categories, the glob table, both matchers, the Jev payload, and the forwarding protocol |
| `tests/hardblock.test.ts` | Which command shapes the credential matcher catches and which it must not |
| `tests/e2e.sh` | End-to-end probes through real headless Pi sessions |
| `tests/commands.py` | Drives the `/permissions` command surface over RPC mode, since print mode cannot run a slash command and the TUI is not scriptable |
| `BEHAVIOR.md` | The quick lookup: the pipeline in order and a command table per switch and mode. Its tables are executed by `tests/lib.test.ts`, so they cannot drift from the engine. |

## The two switches

Independent, four combinations. `/permissions status` shows which is active.

| JEV | YOLO | Behaviour |
|---|---|---|
| on | off | deterministic rules, then Jev; `ask` prompts; hard blocks absolute |
| on | on | deterministic rules, then Jev; `ask` auto-approved; **hard blocks disabled** |
| off | off | deterministic rules only, no classifier call; `ask` prompts; hard blocks absolute |
| off | on | deterministic rules only; `ask` auto-approved; **hard blocks disabled** |

Jev defaults **off** in `permissions.jsonc`, so the fast path is the default; turn it on
per session with `/permissions jev on`. YOLO defaults off too, and with it on there is no
floor at all.

## Running the tests

Deterministic suites, no credentials or network needed:

```bash
node --experimental-strip-types ~/.pi/agent/extensions/permissions/tests/lib.test.ts
node --experimental-strip-types ~/.pi/agent/extensions/permissions/tests/hardblock.test.ts
```

Both print `ok: N checks passed` and exit non-zero with a failure list. End-to-end
probes, one model call each plus a classifier call when the tool is effectful and Jev is
on:

```bash
bash ~/.pi/agent/extensions/permissions/tests/e2e.sh
PROBE_TIMEOUT=600 PI_E2E_MODEL=opencode/deepseek-v4.1-flash \
  bash ~/.pi/agent/extensions/permissions/tests/e2e.sh
```

| Probe | Assertion |
|---|---|
| `simple-not-classified` | `echo probe-ok` runs and its result carries **no** usage, so it was never classified |
| `compound-jevv-off` | `echo a && echo b` runs with no usage |
| `benign-chain-jevv-on` | the same command with Jev on still runs with **no** usage — structure is not a reason to classify |
| `chained-external-effect` | `git push origin main && echo done` asks through the globs, with no classifier call |
| `delete-in-working-dir` | `rm -rf /tmp/permissions-probe` runs with Jev **on** and no usage — a specific target inside a working directory is decidable |
| `delete-outside-working-dir` | `rm -rf /srv/permissions-probe` reaches the classifier: either it ran and carries usage, or it was blocked with a Jev reason |
| `destructive-jevv-off` | the same command with Jev off is neither classified nor blocked |
| `hard-block` | `echo token` returns the credential-gate reason |
| `yolo-disables-blocks` | the same command under YOLO does **not** return it |
| `plan-blocks-mutation` | a compound command in Plan mode returns the read-only reason |
| `plan-allows-read` | `ls -la /workspace` in Plan mode runs |

Two harness facts worth knowing:

- The probes use commands a driving model will actually issue. Anything whose *point* is
  destructive (`rm -rf /usr/...`, `cat ~/.git-credentials`) measures the model, not the
  gate — it refuses, or quietly substitutes a read. Those verdicts are asserted
  deterministically in `lib.test.ts` instead.
- Plan mode is driven from a session that already carries the `pi-plan-build-state`
  entry, because `pi -p --plan` does not persist one in print mode, and `--mode json`
  together with `--plan` produces only a session header.

The switch matrix runs against temp configs through `PI_PERMISSIONS_CONFIG_PATH`; the
real `permissions.jsonc` is never modified.

The command surface has its own harness, because print mode cannot run a slash command:

```bash
python3 ~/.pi/agent/extensions/permissions/tests/commands.py
```

It starts `pi --mode rpc`, sends each `/permissions` subcommand as a prompt, and asserts
on the notification the handler sends back — 15 cases covering `status`, `mode`, the
switches, every `check` shape, and the usage line.

## What the engine decides

Reads (`read`, `grep`, `find`, `ls`) are deterministic only. Jev judges **shell commands
only** (`bash`, `powershell`); `write`, `edit` and MCP are trusted, with the
deterministic layers still applying to them. Plan tools are neutral.

- **Hard blocks**: credential patterns, substring matched, blocked outright for shell
  commands and asked about for path-bearing file tools.
- **Catastrophe gate**: any modification of a catastrophic directory is refused, not
  just `rm -rf`. Paths and commands are combined at match time, matching is
  command-position aware, and redirection targets are parsed.
- **Declarative bash globs**: whole-string, last-match-wins. A single command is decided
  here for free, so `git push` asks and `ls` does not.
- **Jev**: for a shell command only, and only when it hides its intent — a destructive
  verb or flag form, an interpreter payload, or an opaque command word like `$VAR`.
  Structure is not a reason: the globs match the whole string, so a chained
  external-effect command is decided without the classifier, and benign chains stay
  free. A verdict below `jev.confidenceThreshold` (default `0.3`) is not trusted and
  becomes an ask, so it runs under YOLO and prompts without it.
- **Working-directory deletes are decidable.** `rm /tmp/a.txt`, `rm -rf
  /workspace/build`, and `rm -rf build` touch specific paths inside the working
  directories, so they are allowed without a classifier call even with Jev on. A glob
  (`rm -rf /workspace/*`), the working directory itself, a path outside them, a parent
  escape, or an unresolvable target still reaches Jev.
- **Doom loop**: the third identical call in a session asks.

Approvals are one-shot — `Allow once` or `Reject`, nothing stored. YOLO is the answer for
repeated approval. With no UI and no forwarding, an `ask` blocks.

Every decision is appended to `logs/permissions.jsonl` (tool, mode, both switches,
decision, source, reason), which is denylisted from pi-config-sync.

## Checks that need a human

- `/permissions status` shows the mode, both switches, the resulting behaviour, and
  `config=loaded`.
- `/permissions jev on`, then a compound command runs and the footer or `/session` shows
  a `Tools/summaries` cost for it; `/permissions jev off` and the next one adds none.
- `/permissions yolo on`, then a credential read succeeds — expected, and the point of
  the switch.
- Switch to Plan mode in the TUI: a shell mutation is refused while `ls` and
  `git status` still work, and effectful MCP tools disappear from the tool list.
- `/permissions check bash "git push origin main"` reports `ask`; `/permissions check
  read ~/.git-credentials` reports `ask`; `/permissions check bash "ls -la"` reports
  `allow — the deterministic rules decided it, so Jev is not consulted`.
- A subagent that hits an `ask` shows the prompt in this session rather than failing
  closed.

## Changing the policy

Edit `~/.pi/agent/permissions.jsonc`, then `/permissions reload`. Dry-run with
`/permissions check <tool> <command-or-path>`, which is a faithful trace: it consults
the classifier only when the pipeline would, so every line reads
`permissions: <tool> -> <outcome> — <explanation>` and never presents an opinion as a
decision. Re-run both deterministic suites, and
update the tables in `PI-PERMISSIONS.md` if behaviour shifts.
