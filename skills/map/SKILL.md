---
name: map
description: Collaboratively model a repository's intended ownership architecture or opt-in runtime flows, create a high-level MAP.md starter for ownership-map requests, answer codebase questions, and refine models on request.
---

# Map

`/map` is a collaborative repo-understanding workflow. It helps the user and agent form a shared mental model of the repository, using a graph of **Entities**, **DataTypes**, and their relationships. The model is intentionally selective: it should capture the important structure and guidance, not every file, class, or implementation detail.

The conversation is part of the work. The user may ask questions at any point; answer them using the repository and inspect relevant code when the question or conversation calls for it. Periodically give a brief checkpoint of the understanding so far and invite corrections. A checkpoint is not a request to approve or save a file.

## Intended runtime flows (opt-in)

`map/FLOWS.md` is an optional, standalone description of **intended** runtime lifecycles. It is not an execution trace and is independent of `map/MAP.md`: flow entities, Flow DataTypes, scenario IDs, and HTML views are flow-local. Never infer correspondence to ownership-map nodes or add cross-view links. Optional code references on Flow Entities are navigation hints, not implementation-status claims.

Create or update `FLOWS.md` only when the user asks for runtime-flow modeling. Before its first creation, inspect the relevant entrypoints and discuss the intended high-level behavior with the user; write only after you agree on the scenario outline. Distinguish what the user intends from what code inspection confirms. If meaningful behavior differs, surface the evidence and ask how to represent it; never silently reconcile the intended model to the code. A flow-only request does not require or create `MAP.md`.

Start at the high-level scenario. When deeper exploration would help, offer concrete, code-grounded choices and let the user choose the depth. Preserve overview events as linked subflows rather than replacing the overview with implementation detail. Confirm with the user before **each subsequent file update**. Deliberately deferred detail is not an unknown gap; do not require shutdown, failure, or other unrequested paths in the initial scope.

### Execution-first flow authoring

A runtime flow must make execution boundaries legible, not merely attach component names to steps. For new flows use version 2: real OS-process frames contain their thread frames, and execution nodes sit inside the thread that performs them. Multiple threads in the same process share one outer frame. External actors remain outside application frames. The flow model remains independent of the ownership map.

- Inspect the entrypoint, thread targets, process creation, and synchronous calls needed for the agreed scenario. Establish who executes each step before attributing events. An object such as a registry or allocator is a participant, **not an extra thread**: its synchronous operations execute in the calling thread. Constructor initialization before `.start()` belongs to the creator's thread, not the newly started thread.
- Distinguish the creator's start operation from the new thread's entry event. Show one-time setup followed by the recurring wait/check/action loop; use visible guarded back-edges for repetition. Show a local stop/termination branch when it is in the agreed scope, without requiring a full shutdown or crash scenario. Do not invent initialization or termination behavior.
- Model actual choices with `decision` events and labeled guarded branches, e.g. diff desired vs actual → missing/changed/matching → spawn/restart/no change. A plain message send is an action, not automatically a decision. Model synchronous branch convergence separately from genuinely awaited parallel joins.
- Give communication explicit send/receive or wake/wait steps and `message`/`signal` links. `spawn` links lead to the new executing thread's entry. A sender continues unless an explicit wait is modeled; do not make a supervisor await child READY merely because startup and readiness appear in one diagram.
- Deliberately choose represented process/thread instances. Known distinct workers can have separate frames; dynamic request/worker families carry explicit counts and descriptions. Counts describe modeled application contexts, not a measured OS census. Do not silently count queue feeder threads or resource-tracker helpers as application threads/processes.
- Focused scenarios may retain context-only frames with no expanded steps. These are deliberate context, not unknown gaps. Preserve overview/subflow navigation instead of expanding every loop implementation in one scenario.

### `FLOWS.md` authoring contract, version 2

Use one typed Markdown file with exactly one `toml` fenced block under each of `## Format`, `## Flow Entities`, `## Flow DataTypes`, and `## Scenarios`. TOML provides the typed records; Markdown holds framing prose. Version 1 remains supported for legacy participant-only flows; do not infer missing execution contexts or silently migrate existing files. Confirm each requested update before writing.

```toml
# Under ## Format
version = 2
```

- All IDs use lowercase stable slugs matching `[a-z][a-z0-9_-]*`. Entity, DataType, and scenario IDs are unique in their own namespaces. Process, thread, participant, event, and link IDs each have their own scenario-local namespace; the same ID may be reused in another scenario. None references ownership-map nodes.
- `## Flow Entities`: repeated `[[entity]]` records with stable `id`, `name`, `summary`, and optional `code_refs = ["path/to/source::symbol"]`. These identify conceptual participants, not execution frames. Code references are navigation hints, not implementation-status claims.
- `## Flow DataTypes`: repeated `[[datatype]]` records with stable `id`, `name`, `summary`, and a `fields` array of `{ name, type, required, description? }` inline tables. These describe **shape only**; timing and delivery belong on events/links.
- `## Scenarios`: repeated `[[scenario]]` records with stable `id`, `title`, optional `description`, `entrypoint` boolean, and optional `inputs`/`outputs` port arrays. Each port has `name`, `datatype` (a Flow DataType ID), optional `required` (default true), and optional `description`.
- Nest `[[scenario.processes]]` records with `id`, `name`, optional `description`, and optional `count` (default 1). A count is a positive integer or `"0..n"` / `"1..n"` for an explicitly modeled family. Each record represents an OS-process instance or family, not a logical service box.
- Nest `[[scenario.threads]]` records with `id`, `name`, owning `process` ID, optional `count` (same rules), optional `role = "main" | "background"` (default background), optional boolean `daemon`, and optional `description`. Counts are **per process instance**. A process has at most one modeled main thread, with count 1. Unexpanded threads/processes may be declared as context only; do not manufacture events to populate frames.
- Nest `[[scenario.participants]]` records with `id`, `name`, `kind = "runtime" | "external"`, and optional `description`. Runtime participants require `entity` referencing a Flow Entity; external actors must not reference one. Multiple participant instances may use the same Flow Entity. Participants describe components/actors, independently of process/thread identity.
- Nest `[[scenario.events]]` records with `id`, `title`, participant ID, and `kind = "trigger" | "start" | "action" | "decision" | "join" | "subflow" | "gap" | "return" | "terminate"`. Runtime events **require `thread`** referencing their actual executing thread. External events must not have `thread`. `start` means entry into an executing thread, not the creator's `.start()` call; `terminate` is its local endpoint. Both belong to runtime participants. `trigger` belongs to an external actor. Optional `description`, `contract`, `timing`, and `delivery` carry detail. A `gap` requires `open_question` and means genuinely unexplored behavior, not deliberately deferred detail.
- A `subflow` event requires `subflow` (target scenario ID), `mode = "sync" | "async"`, and `bindings`. `sync` means the caller awaits it; `async` means work is scheduled without awaiting completion. An `in` binding maps a caller input/output port to a child input; an `out` binding maps a child output to a caller output. Both endpoints and the binding name the same Flow DataType; every required child input must be bound. Bindings never imply cross-scenario execution-context or ownership identity.
- Nest `[[scenario.links]]` records with `id`, `source`, `target`, non-empty semantic `type`, and **required `category = "sequence" | "spawn" | "message" | "signal"`**. `sequence` stays in one executing thread (or one external actor). `spawn` targets a `start` event in a different executing thread and cannot itself be a loop; an external launcher may spawn the scenario's initial application process. Each thread with expanded events has exactly one `start`, which can only be reached by `spawn`. `message` carries data; `signal` communicates a wake/control condition. Both must cross execution contexts and neither implies that the sender awaits the receiver. Optional `label`, `guard`, `loop`, `timing`, and `delivery` annotate the relation.
- `loop = true` requires a guard and marks an intentional causal back-edge. Sequence repeats stay inside their executing thread. A cyclic message/signal handoff can be guarded as repeated delivery, but must not masquerade as that thread's execution loop. A `decision` needs at least two distinct guarded outgoing non-loop branches; a `join` needs at least two incoming non-loop links. A `terminate` event cannot have any outgoing link.
- Every reference must resolve; every scenario not called as a subflow must say `entrypoint = true`. Unknown fields, invalid execution contexts/counts, unmarked causal cycles, duplicate IDs, and broken bindings are errors, not partially renderable graphs. Deliberately deferred paths are not gaps.

Focused containment syntax (inside the Scenarios TOML block):

```toml
[[scenario.processes]]
id = "main-process"
name = "Main application process"

[[scenario.threads]]
id = "reconciler"
name = "Reconciler thread"
process = "main-process"
daemon = true

[[scenario.events]]
id = "read-actual"
title = "Read registry snapshot"
participant = "registry"
thread = "reconciler"
kind = "action"
```

See `../vis-map/tests/fixtures/execution-flows.md` for a complete synthetic version-2 example and `../vis-map/tests/fixtures/intended-flows.md` for legacy version-1 syntax. Do not copy fixtures as a real-repository model.

## Guidance and implementation

- `map/MAP.md` is the canonical guidance file for the repository: it describes the intended mental model, not necessarily the architecture currently implemented in code.
- The code is the source of truth for current behavior. The guidance and implementation may intentionally diverge; divergence is not automatically a defect or a request to change code.
- Use concise source paths and key symbols as optional references from model nodes to code. When verified, note whether the implementation is aligned, partial, or divergent from the guidance. These references explain where the code relates to the model; they do not turn the map into a duplicate description of the implementation.
- If a divergence matters to the user's question or goal, explain it and offer code alignment as an option. Do not edit implementation code unless the user explicitly asks you to do so.
- Keep the durable model graph-based: Entities, DataTypes, hierarchy, and relationships. Do not add a separate free-form design-principles section. The graph need not be exhaustive.

## Node types

- **Entity** — a component with logic. Fields: name, succinct core responsibilities, importance level, hierarchy. An Entity may include optional `Code References` and `Implementation Status` fields when the related code has been inspected.
- **DataType** — a contract with no logic. It defines the data shape flowing between entities so consumers can rely on a stable interface. Fields: name, format (`JSON schema` | `text summary`), schema/summary content, producers/consumers, and `Composed of` references to other DataTypes. DataTypes may also include optional code references and implementation status when the related code has been inspected.

For code-reference metadata:

- Use concise file/module paths and key symbols, not exhaustive source inventories.
- Only claim an implementation status after inspecting the relevant code. Use `aligned`, `partial`, or `divergent`; omit the status when it is unknown or not yet inspected.
- An absent code reference does not mean a component does not exist. It may mean that branch has not been inspected or the guidance is intentionally ahead of the implementation.

## Edge types

- **Contains** (Entity → Entity): hierarchy. Direction = up/down tier.
- **Interact** (Entity → Entity): references a DataType (the data flowing).
- **Composed of** (DataType → DataType): nested schemas.

An `Interact` edge's `DataType` field may be a simple string label. When its value exactly matches a `###` heading under `## DataTypes`, it also references that DataType node. Do not create a DataType node solely to resolve an edge label; keep the string when no node is modeled.

## Importance tiers

Importance is a small, user-steered scale, not a fixed enum. Start low (2–3 tiers, e.g. Critical / Significant / Peripheral). The user may expand or contract the number of tiers at any time, including when revisiting an existing map.

## Workflow

1. **Locate the requested model and scan at the right depth.** For ownership maps, check the canonical `map/MAP.md` at the repository root. For runtime-flow requests, also check for `map/FLOWS.md` and inspect only relevant entrypoints needed to discuss intended behavior. Identify major architectural units from the top-level structure. Use code structure as the first signal for ownership maps. Do not descend during an ownership-map initial scan; flow entrypoint inspection is the exception.

2. **If `map/MAP.md` does not exist and the request is for an ownership map, create a high-level starter before user feedback.** Build the first pass from the top-level scan, create the `map/` directory if needed, and write it to `map/MAP.md` at the repository root. Do not wait for user steering or approval before this initial creation, unless the user explicitly asks for a conversation-only session or says not to create a file. Write it as working repo guidance and use it as the starting point for the conversation. Then briefly summarize its scope, key branches, and location; do not print the entire file unless the user asks. Invite questions, corrections, and user-directed deep dives. This is the one automatic ownership-map creation; later changes follow step 9. For a flow-only request, follow the opt-in workflow above and do not create `MAP.md` as a side effect.

3. **For ownership-map work, if `map/MAP.md` exists, read it before proposing changes.** Preserve existing content where possible. If its intended status is unclear, discuss the intended model before recasting it. Do not use or migrate other root-level architecture files as substitutes. When a map update is requested and confirmed, write the updated guidance to `map/MAP.md`.

4. **Explore at the user's pace.** For ownership maps, the initial pass stays at the top level. For flow requests, inspect the entrypoints as directed by the opt-in workflow. Inspect a deeper branch when the user asks about it or the conversation explicitly directs you there. Answer repo questions with relevant code evidence, and fold the user's corrections into the intended model. Do not try to map the entire repository just for completeness.

5. **Recheck ownership-map code references on revisits.** When `/map` revisits `map/MAP.md`, verify the paths and implementation statuses recorded there, even if the user has not asked about those particular nodes. Do not treat this as permission to scan unreferenced branches. Report stale or changed references in the conversation; do not silently update `map/MAP.md` unless the user requests and approves a map update.

6. **Classify nodes.** For each deliberate unit, decide Entity vs DataType (or a new type the user steers in). A DataType has no logic and exists to define a data contract. Tag every node with `- **Type**: X`.

7. **Assign importance.** Give each Entity a tier from the current scale. DataTypes carry no importance level.

8. **Model edges.** Record `Contains` (hierarchy), `Interact` (with its data-type label or matching DataType node), and `Composed of` (DataType nesting). An `Interact` edge's `DataType` value references a node only when it exactly matches a heading under `## DataTypes`; do not create nodes just to resolve labels. Tag every non-hierarchical edge with `- **Type**: X` in the Relationships section.

9. **Update `MAP.md` only when requested, except for the initial creation in step 2.** Conversation, questions, corrections, and checkpoints do not by themselves authorize a later ownership-map update. Flow updates follow the opt-in workflow above and require confirmation before each subsequent file update. When the user requests an update, summarize what will change and show a focused diff (or concise before/after snippets) for the affected nodes and relationships. Do not print or draft the entire `map/MAP.md` in chat; omit unchanged sections. Let the user steer the proposed changes, then write only after the user explicitly confirms the update. Preserve content the user did not ask to change.

10. **Be intentional.** Entities and DataTypes are deliberate, never auto-generated en masse. Leave out low-value details and let the user add nodes, relationships, or deeper branches through steering. When implementation differs from the guidance, explain the difference without assuming it must be fixed; offer a possible code change only when relevant, and wait for an explicit request before editing code.

## Markdown format

Nested headings encode hierarchy (`Contains` is implicit in nesting). DataTypes and Interact edges live in their own sections. Every node must have a `- **Type**: X` tag, and every non-hierarchical edge must have one too; this is the shared contract with `vis-map`. Optional code-reference metadata is plain node metadata and does not replace the `Type` tag.

```markdown
# Project A
- **Type**: Entity
- **Importance**: Critical
- **Responsibilities**: ...

## Backend
- **Type**: Entity
- **Importance**: Critical
- **Responsibilities**: ...
- **Code References**: `src/backend/`
- **Implementation Status**: Partial

### BankingService
- **Type**: Entity
- **Importance**: Significant
- **Responsibilities**: ...
- **Code References**: `src/banking/service.py::BankingService`
- **Implementation Status**: Aligned

## Database
- **Type**: Entity
- **Importance**: Critical
- **Responsibilities**: ...

## DataTypes

### Transaction
- **Type**: DataType
- **Format**: JSON schema
- **Schema**: { "id": "string", "amount": "number" }
- **Produced by**: BankingService
- **Consumed by**: LedgerService

### Order
- **Type**: DataType
- **Format**: JSON schema
- **Schema**: { "items": [LineItem] }
- **Composed of**: LineItem

## Relationships

- BankingService → LedgerService
  - **Type**: Interact
  - **DataType**: Transaction
```

## Resume / re-trigger

When re-triggered on a repository, read `map/MAP.md` and its saved code references first. If it does not exist, follow workflow step 2. Recheck saved references and statuses, then continue from the existing context. Treat implementation-oriented content that was not explicitly agreed as intended guidance with care: use it to inform discussion, but do not assume it describes the target model or rewrite it automatically. Preserve confirmed guidance and all content the user has not asked to change.
