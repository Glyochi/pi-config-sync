---
name: map
description: Explore a repository through a user-directed Entity/DataType map, scenario flows, or both.
---

# Map

`/map` helps the user understand selected parts of a repository. Keep durable models small and user-directed: the user decides what matters, and can request deeper detail at any time. Do not attempt to map a repository exhaustively.

## Choose the model

At the start of each session, ask whether to work on `MAP.md`, `FLOWS.md`, or both. The models are independent: do not add cross-references or require one to create the other. If the user chooses both, follow each workflow separately.

Answer questions throughout the conversation using repository evidence when useful. Inspect only the branch or scenario relevant to the user's question. A checkpoint is not permission to write a file.

## MAP.md: connected concepts

`MAP.md` is a concise graph in Markdown and begins with `<!-- map-format: compact-v1 -->`. Keep the existing node vocabulary (`Entity`, `DataType`) and relationship vocabulary (`Contains`, `Interact`, `Composed of`). Nested Entity headings express `Contains` and render as nested frames. DataTypes live under `## DataTypes`; record a `Composed of` reference on a DataType when relevant. Record `Interact` edges under `## Relationships`, with a short DataType label when useful.

A minimal file starts like this:

```markdown
<!-- map-format: compact-v1 -->

# Project
- **Type**: Entity
- **Responsibilities**: One-line summary.
```

A new map should contain only:

- a small set of high-level Entities with one-line responsibilities;
- one-line DataType summaries only when relevant to a question or chosen dyad;
- containment and other relationships the user wants to understand.

Do not bulk-inventory nodes or contracts. Do not add schemas, lifecycle/runtime detail, code references, or implementation-status claims unless the user asks to drill into them. The code can establish facts, but it does not decide the user's intended conceptual relationships.

### Start and scan

1. Read the existing canonical `map/MAP.md` only if it begins with the current format marker. If it is unmarked or uses an older format, report that it is unsupported and ask permission before replacing it; do not convert it. Use the repository's top-level structure to suggest a short candidate-node list; do not descend into implementation details during this scan.
2. If creating a map, present the candidates and ask what the user wants to focus on. Show the proposed minimal starter and wait for approval before its first write.
3. Suggest one useful pair of nodes at a time for **Dyadic Scanning**. Ask the user first whether and how the pair relates. Let the user redirect the next pair. Inspect implementation details only when the user asks for evidence or when clarification requires it.
4. The user's agreement about a dyad authorizes writing that concise change; do not request a second confirmation. Keep the update limited to the agreed nodes and relationships. User requests to drill into a node may add detail only when the user agrees that detail belongs in the durable map.

### Abstraction and frames

Abstraction is structural, not criticality or user priority. Derive it from Entity containment depth; do not store a separate per-node tier or infer a tier for an Entity outside a containment hierarchy. The visualizer colors Entities by that depth. Preserve DataType's distinct node type and containment/frame visualization.

## FLOWS.md: scenarios

A flow describes a high-level scenario the user wants to understand, not a runtime trace or a mandatory census of processes and threads. When FLOWS is selected, ask the user to name the behavior/scenario first. Inspect only relevant code, distinguish intended behavior from verified facts when that distinction matters, and agree on a concise scenario outline before writing. The agreed outline authorizes the initial write; agree on a revised outline before a later update.

Use compact Markdown with one `## Scenarios` section. A scenario is a heading, an optional short description, and ordered steps. List order implies the main path. Optional actor labels identify who or what performs a step. Use explicit nested `Group` headings to bundle steps into generic frames; these groups are conceptual and never imply process/thread identity.

Example:

```markdown
## Scenarios

### Scenario: Handle a request {#handle-request}
A high-level request path.

#### Group: Request handling {#request}
1. Client submits a request {#submit} [actor: Client]
2. Service validates the request {#validate} [actor: API]
3. Service returns a response [actor: API]

#### Connections
- submit -> validate: request received
- validate -> submit: retry while attempts remain [repeat]
```

Scenario, group, and step IDs may be generated deterministically from their titles; use `{#stable-id}` to override an ID when links or saved layout need to survive a rename. Connections are optional and use `source -> target: label`; `@scenario-id` may be used as a target to link to a subscenario. Mark intentional repeats with `[repeat]`. Do not require exhaustive branches or paths. Keep steps and labels short; the HTML inspector can expose the text present in the Markdown.

Do not add process/thread frames, global Flow Entity/DataType catalogs, mandatory event kinds, or fixed link categories. Do not infer or create unrequested scenarios. If the user asks for more detail, add only the relevant steps, groups, or links.

## Existing and legacy files

The current MAP format marker and compact FLOWS Markdown structure are the only supported formats; do not convert legacy files. If an unmarked/old-format `MAP.md` or TOML/old-format `FLOWS.md` is found, report that it is unsupported and ask permission before replacing it from scratch. Never silently overwrite or migrate it. Preserve current-format content not covered by the user's request.

## Resume

When `/map` resumes, inspect the selected current-format model and continue from the user's chosen focus. Do not automatically revisit unrelated branches or expand the model for completeness.
