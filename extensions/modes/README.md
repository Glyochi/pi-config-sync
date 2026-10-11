# Modes

A small, independent user extension providing **Ask**, **Plan**, and **Build** modes. It is not a runtime dependency of `@janvitos/pi-plan-build`.

## Modes

- `/ask`: research, explanation, learning visualizations, and explicit code requests. It uses the Build permission profile, has no attached-plan context by default, cites sources when researching current/external information, and writes useful artifacts under the project-local `ask_tools/` directory without executing them unless asked.
- `/plan`: read-only project research and plan creation/revision. The only editable Markdown is the attached plan in `.pi/plans/`.
- `/build`: ordinary implementation. Ask and Build cannot edit `.pi/plans/*.md`; update plan status through the extension's structured plan tool.

Tab cycles Build → Plan → Ask when autocomplete is closed; when suggestions are open, Tab still accepts the selected suggestion. Modes persist per session; new sessions start in Build. The `CustomEditor` wrapper preserves Pi's editor behavior and renders the chatbox-status plan summary and permission state in its top and lower border rows. The default file-completion use of Tab when autocomplete is closed is replaced by the mode toggle. If another extension owns the editor, the wrapper yields and slash commands remain available.

## Plans and recovery

Saved plans are project-local under `.pi/plans/`. One plan can be open per project. `/plan new`, `/plan list`, `/plan show`, `/plan resume <id>`, `/plan done`, and `/plan blocked <reason>` manage the lightweight lifecycle. `/plan list` inventories plans with their overall status; `/plan show [id]` displays the Markdown and numbered work items as a TUI custom entry or RPC notification, neither of which enters model context. Work items receive stable IDs and `planned` status for future UI/subagent use, but no per-step execution state is tracked yet. Plans have `open`, `completed`, and `blocked` statuses and a concise Verification section. Resuming claims exclusive ownership in the current session; the previous owner becomes stale. Resume requires the same project checkout.

Switching manually from Plan to Build authorizes work on the attached plan when the next user request asks to continue. It does not launch work automatically. The agent marks a plan completed or blocked in the same turn; there is no hidden follow-up or approval dialog.

## Extension state contract

The extension stores versioned `modes-state` session entries and emits JSON-safe `modes:state.v1` snapshots and changes on `pi.events`. Its public TypeScript contract and runtime guard live in [`../shared/contracts.ts`](../shared/contracts.ts); the session-scoped composer renderer consumes `chatbox-status:composer.v1` through that public contract. Interaction guidance is in [`../EXTENSION-CONVENTIONS.md`](../EXTENSION-CONVENTIONS.md). The payload includes the selected mode, effective permission profile, active plan title/status/owner, bounded plain-text content from only the plan's `## Goal` section, stable work-item IDs/orders/titles/status, and `ask_tools/` artifact references. It does not duplicate conversation or tool output. UI extensions should subscribe to the event rather than import private modules or parse Markdown prose.

The separate `permissions` extension consumes the persisted mode contract and `pi.events` updates, records Ask as a distinct mode, and maps it to Build's existing permission profile. Plan blocks non-read-only shell and MCP calls and may edit only its attached plan Markdown. Ask/Build path-bearing edits and detectable shell writes to `.pi/plans/` are blocked; pathless/private tools, scripts that hide their targets, and opaque MCP tools cannot be fully sandboxed by an extension hook.

The existing `@juicesharp/rpiv-ask-user-question` extension remains the owner of `ask_user_question` and its `rpiv:ask-user:prompt` event. Obsidian-specific behavior and automatic subagent spawning are intentionally deferred.

For architecture, state/persistence contracts, permission limits, recovery procedures, validation commands, and the future subagent roadmap, see [`docs/HANDOFF.md`](./docs/HANDOFF.md).

## Attribution

This extension is independent of `@janvitos/pi-plan-build`. A small number of implementation patterns were adapted from its MIT-licensed source; see [`LICENSE`](./LICENSE) for the applicable notice.
