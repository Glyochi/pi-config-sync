# Modes — Maintainer Handoff

This document is the durable handoff for a future agent. It records the current design, implementation boundaries, validation, and the intended subagent roadmap. Read it with the source in `../` and the separate permissions extension at `~/.pi/agent/extensions/permissions/`.

## Purpose and installation

`modes` is a personal Pi extension under `~/.pi/agent/extensions/modes/`. It replaces the configured `npm:@janvitos/pi-plan-build` package; do not load both because they own the same `/plan` and `/build` commands. The replacement is deliberately independent of upstream code updates. A few implementation patterns were adapted from the upstream MIT-licensed package; the relevant notice is in `../LICENSE`.

The permissions extension remains separate and is the policy owner. The installed `@juicesharp/rpiv-ask-user-question` remains the owner of `ask_user_question`; do not register a duplicate. `pi-subagents` and `pi-web-access` are also separate installed packages and are not wrapped or copied by this extension.

Legacy Plan/Build files under `~/.pi/agent/plans/` and upstream `pi-plan-build` state are intentionally not migrated. New plans are project-local, so resume requires the same project checkout.

## Modes and shortcuts

| Mode | Default intent | Permission profile | Plan Markdown |
|---|---|---|---|
| **Ask** | Learn, explain, research, cite sources, and make topic-appropriate visual aids. Does not receive attached-plan context unless the user refers to it. Explicit product-code requests are still allowed. Formal saved-plan requests should be routed to `/plan`. | Build | Cannot edit `.pi/plans/*.md` |
| **Plan** | Read-only project research and author/revise a requested saved plan. Do not start implementation. | Plan | May edit only its attached open plan Markdown |
| **Build** | Normal coding. If an open plan is attached, use it when the next user request asks to continue. Switching modes does not start a turn. | Build | Cannot edit `.pi/plans/*.md` |

Commands are `/ask`, `/plan`, and `/build`. New sessions default to Build; mode selection persists in the session branch. With autocomplete closed, Tab toggles only between Build and Plan without a selection notification; in Ask it shows a hint to use `/plan` or `/build`. `/ask` is required to enter Ask, and `/plan` or `/build` is required to leave it. When autocomplete is open, Tab is passed to Pi and accepts the selected suggestion in every mode. This replaces the default closed-menu Tab file-completion trigger. The `CustomEditor` wrapper renders the centered active-plan summary in the top border and mode/permission metadata in the lower border from a versioned public snapshot. The top border uses the same mode color as the mode label; other composer lines are unchanged. If another extension owns the editor slot, this extension yields and slash commands remain available. There is no Alt+M shortcut or per-mode model selection.

## Ask behavior and artifacts

Ask is an informational/research focus, not a read-only sandbox. It uses the same Build permission profile as Build and may modify project code when the user explicitly asks. It should:

- Treat each question independently; do not inject the current plan's scope automatically.
- Inspect local source/docs for repository questions, and use available web/search/MCP tools when current or external information matters. Cite sources and separate evidence from inference.
- Generate Python, HTML, or another artifact only when useful for the learning goal. Put artifacts under `<project>/ask_tools/`, record references in the UI state snapshot, and do not execute/open them or start a server unless the user asks.
- Route a request for a formal saved implementation plan to `/plan`.
- Never edit `.pi/plans/` Markdown.

`artifacts.ts` scans `ask_tools/` when a state snapshot is emitted. It reports file paths/types/labels only, not file contents; hidden directories and `node_modules`/`.git` are skipped, recursion is capped, and the list is bounded.

## Plans, status, and recovery

Plan data is project-local:

```text
<project>/.pi/plans/<plan-id>.md
<project>/.pi/plans/state.json
<project>/.pi/plans/.modes.lock/   # transient lock while updating state
```

`PlanStore` in `plan-store.ts` validates the versioned index, writes atomically, and uses a lock directory with PID/stale-lock handling so two Pi processes cannot silently overwrite ownership/status. The Markdown is the human-readable plan; `state.json` owns title/status/owner metadata. Plan status changes never rewrite the Markdown.

There may be at most one `open` plan per project. Statuses are `open`, `completed`, and `blocked`. A blocked plan can be resumed (claiming it changes it back to open); a completed plan cannot be resumed. `/plan resume <id>` transfers exclusive ownership to the current session, but leaves the current mode unchanged and does not start work. The prior owner becomes stale: it may still do unrelated explicit Build work, but it must not revise that plan or update its status. Resume is project-checkout-local.

User commands:

- `/plan new <title>` — select Plan mode and create a template at the canonical `.pi/plans/<id>.md` path.
- `/plan list` — show one row per plan with title, overall status, and owner.
- `/plan show [id]` — show status/owner, stable work-item IDs, and Markdown.
- `/plan resume <id>` — claim an open or blocked plan in the current mode.
- `/plan done` — mark the attached open plan completed.
- `/plan blocked <reason>` — mark it blocked.

The model-callable `plan_create` tool is active only in Plan mode; `plan_status` is active only in Build with an owned open plan. Build records completed/blocked in the same turn after checks; there is no hidden reconciliation turn, validation dialog, formal plan approval dialog, fresh-session handoff, step runner, or sidebar. A manual switch from Plan to Build is authorization to work on the plan when the next user request asks for progress; it never auto-starts work.

### `/plan list` and `/plan show` do not enter model context

In TUI, both commands append a custom session entry rendered with `registerEntryRenderer`; Pi custom entries are durable session data but are not sent to the model. In RPC, they use `ctx.ui.notify`, also outside model context. They do not use `pi.sendMessage`. `/plan list` is plan-level inventory; `/plan show` displays the numbered work items as well as the Markdown.

## Plan Markdown, file guards, and limitations

New plan files use a concise Goal/Scope/Verification/Implementation Steps template. Top-level numbered work items are parsed from `## Implementation Steps`. In the public state event, each work item is `{ id, order, title, status: "planned" }`. The ID is a stable hash of normalized step text (duplicate identical steps receive an occurrence suffix); changing the instruction changes its ID. No per-step execution/completion state exists in this version.

The `modes` `tool_call` guard:

- In Plan, permits recognized file mutators only for the attached, open plan Markdown owned by this session. Other project-file mutations and pathless file mutators are blocked.
- In Ask/Build, blocks recognized path-bearing file mutators targeting any `.pi/plans/` data and blocks detectable non-read-only shell commands that mention `.pi/plans/`.
- In Plan, blocks non-read-only Bash/PowerShell commands and MCP calls.

The separate permissions extension maps Ask to Build's existing policy profile, keeps Ask as a distinct audit/status label, and preserves credential/catastrophe checks, external-effect asks, Jev, and YOLO semantics. Its `/permissions status` should report `mode=ask profile=build`.

These are extension-level guards, **not an OS sandbox**. Pathless/private editors, scripts that construct or hide the protected path, and opaque MCP calls can bypass a tool-call path check; visible MCP plan paths are blocked unless the tool declares `readOnlyHint`. The current scope deliberately preserves Build-level shell/MCP availability otherwise. With YOLO, the permissions layer's hard blocks are bypassed, but the separate modes guards for Plan shell writes and recognizable `.pi/plans/` targets still run.

## Public UI state contract

The shared [`../../shared/contracts.ts`](../../shared/contracts.ts) defines the durable mode entry type `modes-state`, event `modes:state.v1`, payload types, and runtime guards. The extension appends a version-1 session entry for mode/attached-plan changes, and emits a JSON-safe snapshot/change event at session startup/restoration and after mode, plan, or artifact changes. The snapshot includes:

- `schemaVersion`, `kind`, `sessionId`, `cwd`, and `mode`;
- `permissionProfile` (`plan` or `build`);
- active plan ID/title/path/status/owner, optional bounded plain-text `goalSummary` extracted only from `## Goal`, and stable work items;
- `ask_tools/` artifact references.

The permissions extension reads the durable entry and listens to the event so it sees live mode changes. The passive `chatbox-status` extension consumes mode and permission events, publishes the compact `chatbox-status:composer.v1` view-model, and appends a `chatbox-status-timing` custom entry after settlement with the mode captured at run start. The `modes` editor validates and renders that view-model without importing private producer state or parsing transcript prose. Pi custom entries persist in the transcript but do not participate in LLM context. Follow [`../../EXTENSION-CONVENTIONS.md`](../../EXTENSION-CONVENTIONS.md) for event versioning, snapshots, validation, and consumer behavior. Keep payloads JSON-safe and append-only. If a future change must break a field's meaning, add a new event version rather than silently changing version 1. The existing question extension separately emits `rpiv:ask-user:prompt`.

## Future subagent delegation (not implemented)

The current numbered work items are **not** a parallelization graph. Do not infer independence from numbering, and do not add a step runner as a shortcut to delegation. When this is authorized later:

1. Extend work items with explicit dependencies (for example `dependsOn: string[]`) and a persisted lifecycle such as planned → ready → assigned/running → completed/blocked.
2. Attach worker identity/run/session IDs and durable handoff/output references to the state/event contract. Preserve the parent as plan owner and final decision-maker; children receive scoped work-item context and do not edit plan Markdown/status.
3. Use the already-installed `pi-subagents` workflow (`runs.all` for independent tasks or `runs.lanes` for staged lanes), not a new process-spawner. Use separate worktrees for concurrent writers, one writer per worktree, explicit `cwd` and cold-start task packets, and parent-side review/arbitration.
4. Keep recovery data durable so a resumed parent can inspect running/completed/blocked workers without scraping terminal output. The existing permissions extension already has subagent approval forwarding.

Obsidian support is also deferred; implement it later as a skill, not special-case behavior in this extension.

## Tests and current validation

From the extension directory:

```bash
npm test
```

This runs the Node test suite for state/schema, plan-store ownership/status, file and shell guards, plan parsing, context policy, Tab/autocomplete policy, and stable work-item IDs. The separate permission policy suites are:

```bash
node --experimental-strip-types ~/.pi/agent/extensions/permissions/tests/lib.test.ts
node --experimental-strip-types ~/.pi/agent/extensions/permissions/tests/hardblock.test.ts
```

The RPC smoke checks exercised `/ask`, `/plan`, `/build`, `/permissions mode`, plan creation/list/status/resume, and context-free plan inspection. Fresh-session TUI checks verified the quiet Plan/Build Tab toggle, Ask-mode Tab hint without a switch, autocomplete acceptance, mode-colored top border, and resizing/narrow-width rendering. `settings.json` no longer loads the upstream npm package.
