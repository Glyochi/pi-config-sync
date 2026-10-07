# permissions

One policy layer for every tool. A deterministic core decides what it can for free —
credential and catastrophe hard blocks, the mode dimension, and the declarative bash
rules — and the TypeSafe **Jev** classifier is consulted only for effectful tools a rule
cannot read, and only while the Jev switch is on.

Policy: [`../../permissions.jsonc`](../../permissions.jsonc). Rationale:
[`../../PI-PERMISSIONS.md`](../../PI-PERMISSIONS.md). Command: `/permissions`.

This extension replaced `pi-permission-system` and absorbed the former `bash-safety`
extension.

| File | Purpose |
|---|---|
| `index.ts` | Pi wiring: the `tool_call` pipeline, `before_agent_start` prompt sanitization, `tool_result` usage attribution, subagent forwarding, the audit log, and `/permissions` |
| `lib.ts` | Pure helpers with no `@earendil-works/...` imports, so plain `node` can test them |
| `tests/lib.test.ts` | The policy engine: config normalisation, mode resolution, the switch matrix, tool categories, the glob table, both matchers, the Jev payload, and the forwarding protocol |
| `tests/hardblock.test.ts` | Which command shapes the credential matcher catches and which it must not |
| `tests/e2e.sh` | End-to-end probes through real headless Pi sessions |

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
| `compound-jevv-on` | the same command, with Jev switched on, runs **with** usage |
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

## What the engine decides

Reads (`read`, `grep`, `find`, `ls`) are deterministic only. Effectful tools (`bash`,
`powershell`, `write`, `edit`, `mcp`, `mcp__*`) can reach Jev. Plan tools are neutral.

- **Hard blocks**: credential patterns, substring matched, blocked outright for shell
  commands and asked about for path-bearing file tools.
- **Catastrophe gate**: any modification of a catastrophic directory is refused, not
  just `rm -rf`. Paths and commands are combined at match time, matching is
  command-position aware, and redirection targets are parsed.
- **Declarative bash globs**: whole-string, last-match-wins. A single command is decided
  here for free, so `git push` asks and `ls` does not.
- **Jev**: only for compound or interpreter shell commands, and for effectful non-shell
  tools.
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
- `/permissions check bash "git push origin main"` reports `ask`;
  `/permissions check read ~/.git-credentials` reports `ask`.
- A subagent that hits an `ask` shows the prompt in this session rather than failing
  closed.

## Changing the policy

Edit `~/.pi/agent/permissions.jsonc`, then `/permissions reload`. Dry-run with
`/permissions check <tool> <command-or-path>`. Re-run both deterministic suites, and
update the tables in `PI-PERMISSIONS.md` if behaviour shifts.
