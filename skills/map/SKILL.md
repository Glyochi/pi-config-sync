---
name: map
description: Collaboratively model a repository's intended architecture, create a high-level ARCHITECTURE.md starter when absent unless the user opts out, answer codebase questions, and refine the model on request. Use when the user wants to understand or discuss a codebase's mental model.
---

# Map

`/map` is a collaborative repo-understanding workflow. It helps the user and agent form a shared mental model of the repository, using a graph of **Entities**, **DataTypes**, and their relationships. The model is intentionally selective: it should capture the important structure and guidance, not every file, class, or implementation detail.

The conversation is part of the work. The user may ask questions at any point; answer them using the repository and inspect relevant code when the question or conversation calls for it. Periodically give a brief checkpoint of the understanding so far and invite corrections. A checkpoint is not a request to approve or save a file.

## Guidance and implementation

- `ARCHITECTURE.md` is guidance for the repository: it describes the intended mental model, not necessarily the architecture currently implemented in code.
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

1. **Locate the map and scan the top level.** Check for `ARCHITECTURE.md` at the repository root. Identify major architectural units from the top-level structure. Use the code structure as the first signal for the initial map; consult repository documentation for context, but do not let documentation override the code structure when they conflict. Do not descend into individual files, classes, or functions during this initial scan.

2. **If `ARCHITECTURE.md` does not exist, create a high-level starter map before user feedback.** Build the first pass from the top-level scan and write it directly to `ARCHITECTURE.md` at the repository root. Do not wait for user steering or approval before this initial creation, unless the user explicitly asks for a conversation-only session or says not to create a file. Write it as working repo guidance and use it as the starting point for the conversation. Then briefly summarize its scope, key branches, and location; do not print the entire file unless the user asks. Invite questions, corrections, and user-directed deep dives. This is the one automatic map-file creation; later changes follow step 9.

3. **If `ARCHITECTURE.md` already exists, read it before proposing changes.** Preserve existing content where possible. If it describes observed implementation and has not been explicitly established as the intended model, treat it as legacy context—not as authoritative guidance. Discuss what the intended model should be before recasting or updating it; do not automatically convert or overwrite it. If its intended status is clear, continue from it rather than regenerating.

4. **Explore at the user's pace.** The initial pass stays at the top level. Inspect a deeper branch when the user asks about it or the conversation explicitly directs you there. Answer repo questions with relevant code evidence, and fold the user's corrections into the intended model. Do not try to map the entire repository just for completeness.

5. **Recheck saved code references on revisits.** When `/map` is run again, verify the paths and implementation statuses already recorded in the map, even if the user has not asked about those particular nodes. Do not treat this as permission to scan unreferenced branches. Report stale or changed references in the conversation; do not silently update `ARCHITECTURE.md` unless the user requests and approves a map update.

6. **Classify nodes.** For each deliberate unit, decide Entity vs DataType (or a new type the user steers in). A DataType has no logic and exists to define a data contract. Tag every node with `- **Type**: X`.

7. **Assign importance.** Give each Entity a tier from the current scale. DataTypes carry no importance level.

8. **Model edges.** Record `Contains` (hierarchy), `Interact` (with its data-type label or matching DataType node), and `Composed of` (DataType nesting). An `Interact` edge's `DataType` value references a node only when it exactly matches a heading under `## DataTypes`; do not create nodes just to resolve labels. Tag every non-hierarchical edge with `- **Type**: X` in the Relationships section.

9. **Update the file only when requested, except for the initial creation in step 2.** Conversation, questions, corrections, and checkpoints do not by themselves authorize a later file update. When the user requests an update, summarize what will change and show a focused diff (or concise before/after snippets) for the affected nodes and relationships. Do not print or draft the entire `ARCHITECTURE.md` in chat; omit unchanged sections. Let the user steer the proposed changes, then write only after the user explicitly confirms the update. Preserve content the user did not ask to change.

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

When re-triggered on a repository that already has `ARCHITECTURE.md`, read the existing map and its saved code references first. Recheck those references and statuses, then continue the conversation from the existing context. Treat implementation-oriented maps that were not explicitly agreed as intended guidance as legacy notes: use them to inform discussion, but do not assume they describe the target model or rewrite them automatically. Preserve confirmed guidance and all content the user has not asked to change.
