---
name: map
description: Map a repository's major components, their responsibilities, importance, hierarchy, and the data contracts between them into ARCHITECTURE.md. Use when the user wants to build, update, or understand the architecture/knowledge map of a codebase.
---

# Map

Build a human-readable architecture map of a repository into `ARCHITECTURE.md` at
the repo root. The map is a stepping stone toward a future graph database, so keep
it structured: nodes are **Entities** and **DataTypes**, edges are **Contains**,
**Interact**, and **Composed of**.

This skill is interactive. It proposes a draft and waits for the user's free-form
steering before writing anything. Never write `ARCHITECTURE.md` without explicit
confirmation.

## Node types

- **Entity** — a component with logic. Fields: name, succinct core
  responsibilities, importance level, hierarchy.
- **DataType** — a contract with no logic. It defines the data shape flowing
  between entities so consumers can be vibe-coded against a fixed interface.
  Fields: name, format (`JSON schema` | `text summary`), the schema/summary
  content, producers/consumers, and `Composed of` references to other DataTypes.

## Edge types

- **Contains** (Entity → Entity): hierarchy. Direction = up/down tier.
- **Interact** (Entity → Entity): references a DataType (the data flowing).
- **Composed of** (DataType → DataType): nested schemas.

## Importance tiers

Importance is a small, user-steered scale, not a fixed enum. Start low (2–3 tiers,
e.g. Critical / Significant / Peripheral). The user may ask to expand or contract
the number of tiers at any time, including when re-triggering on an existing map.

## Workflow

1. **Locate the map.** Check for `ARCHITECTURE.md` at the repo root. If present,
   read it and offer to *update* it (including re-granularizing importance tiers)
   rather than regenerate. If absent, start fresh.

2. **Scan top-level only.** Identify the repo's top-level architectural units
   (services, modules, layers, subsystems, major libraries). Do not descend into
   individual files, classes, or functions. Drill into a branch only when the user
   explicitly asks.

3. **Classify nodes.** For each unit, decide Entity vs DataType (or a new type the
   user steers in). A DataType has no logic and exists only to define the data
   shape between entities. Tag every node with `- **Type**: X`.

4. **Assign importance.** Give each Entity a tier from the current scale. DataTypes
   carry no importance level.

5. **Model edges.** Record `Contains` (hierarchy), `Interact` (with its DataType),
   and `Composed of` (DataType nesting). Tag every non-hierarchical edge with
   `- **Type**: X` in the Relationships section.

6. **Write the markdown** using the structure below.

7. **Whole-map loop.** Present the full draft, then wait for the user's free-form
   steering (e.g. "merge X and Y", "Database is more critical", "go deeper on
   Backend"). Revise and re-present until the user confirms. Only then write
   `ARCHITECTURE.md`.

8. **Be intentional.** Entities and DataTypes are deliberate, never auto-generated
   en masse. When in doubt, leave a node out and let the user add it via steering.

## Markdown format

Nested headings encode hierarchy (`Contains` is implicit in nesting). DataTypes and
Interact edges live in their own sections. The `- **Type**: X` tag on every node and
edge is the shared contract with `vis-map`: it lets `vis-map` render any type you
introduce here without modification.

```markdown
# Project A
- **Type**: Entity
- **Importance**: Critical
- **Responsibilities**: ...

## Backend
- **Type**: Entity
- **Importance**: Critical
- **Responsibilities**: ...

### BankingService
- **Type**: Entity
- **Importance**: Significant
- **Responsibilities**: ...

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

When re-triggered on a repo that already has `ARCHITECTURE.md`, read the existing
map and offer to update it. The user may reduce or increase the number of
importance tiers, drill into a branch, or add/remove nodes and edges. Preserve
existing content the user does not ask to change.
