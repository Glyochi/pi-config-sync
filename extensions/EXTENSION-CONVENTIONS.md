# Personal Pi extension interaction conventions

This is guidance for extensions in `~/.pi/agent/extensions/`, not a required framework. Follow the parts that fit an extension’s role; document deliberate exceptions. Pi extensions remain independently loadable unless a shared contract is explicitly part of their integration.

## Choose the right communication boundary

- Use Pi’s built-in `pi.on()` lifecycle events for facts Pi already owns (session, agent, message, tool, and UI-prompt lifecycle).
- Use `pi.events` for live communication between extensions. Do not parse transcript prose, status-bar strings, notifications, or private files to discover another extension’s state.
- The extension that owns a value is its source of truth. Consumers observe it; they should not change or re-create its policy.
- Keep display extensions policy-read-only: subscribe to data and maintain derived presentation state; do not register tools or change producer-owned policy. A deliberately persistent display annotation may append a custom session entry, but document it and keep it out of model context.

## Public event contracts

- Treat every `pi.events` payload as `unknown` at the boundary. TypeScript types help producers and consumers agree, but do not validate runtime data; use a type guard before consuming it.
- Define cross-extension channel names and payload types in `shared/contracts.ts`. Keep that module free of Pi runtime imports so pure contract tests can run without starting Pi.
- Name state channels with a domain and explicit schema version, such as `modes:state.v1` or `permissions:state.v1`. The event name and `schemaVersion` must agree.
- Publish a complete `snapshot` at session startup/restoration and after a consumer could have missed prior changes. Publish `changed` snapshots after meaningful state transitions. Pi’s event bus does not replay old events.
- Include enough provenance to reject stale or foreign-session data (at least `sessionId`; include `cwd` when project scope matters) and an update timestamp when “latest wins” is useful.
- Keep payloads JSON-safe, bounded, and purpose-specific. Publish summaries or references, not full transcripts, credentials, or large private state.
- Add optional fields compatibly when possible. If a change alters the meaning or required shape of existing data, publish a new channel/schema version and support the old version for any consumers that still need it.
- Keep event handlers fast and non-blocking. A consumer or renderer failure must not interrupt the extension that owns the decision.

## Consumer behavior

- Subscribe during extension initialization, before session events begin. Expect to receive the startup snapshot after subscribing.
- Validate the schema version and required fields, scope updates to the active session/project, and ignore unknown or malformed payloads.
- Do not guess defaults for missing sources. Show an explicit unavailable/unknown state or omit the dependent row; do not represent missing data as `false` or “off.”
- Keep UI formatting in the consumer. Producers publish semantic values, not ANSI strings or layout-specific text.
- Guard terminal-only rendering with `ctx.mode === "tui"`; keep event/data behavior safe in RPC, JSON, and print modes.
- Unsubscribe listeners and remove session-scoped UI ownership in `session_shutdown`; cleanup should be safe to call more than once.

## Current shared state contracts

The TypeScript definitions and runtime guards live in [`shared/contracts.ts`](./shared/contracts.ts):

- `modes:state.v1` — mode, effective permission profile, active plan metadata, and artifact references. The optional `activePlan.goalSummary` contains bounded plain text extracted only from the plan’s `## Goal` section.
- `permissions:state.v1` — whether the overall gate is enabled, Jev/YOLO switches, confidence threshold, Jev model ID, and session classification count.
- `chatbox-status:composer.v1` — a bounded, session/cwd-scoped render view-model containing only the eligible plan summary and compact permission switches. The existing modes editor consumes it; do not install a competing editor or duplicate Pi's native model metadata row.
- `chatbox-status-timing` — a versioned custom session entry containing one agent-run duration, outcome, and optional mode (optional to preserve older v1 entries). Pi custom entries persist in the transcript but do not participate in LLM context.

The modes extension persists its own branch-sensitive mode/plan attachment state in session entries and publishes live snapshots. The permissions extension owns its session-local switches/counters and publishes snapshots when they change. `chatbox-status` derives presentation state and generation timing without owning policy. Its one deliberate persistence exception is `chatbox-status-timing`, a versioned custom entry rendered in the transcript but excluded from model context. UI consumers must not import private producer implementation modules.
