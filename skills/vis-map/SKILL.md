---
name: vis-map
description: Deterministically render the independent MAP.md and FLOWS.md models as standalone HTML views.
---

# Vis-map

Run the bundled renderer without arguments:

```sh
python3 <skill-dir>/scripts/visualize.py
```

It discovers canonical `map/MAP.md` and `map/FLOWS.md` and renders each source that exists:

- `MAP.md` → `map/map-graph.html`
- `FLOWS.md` → `map/flow-graph.html`

The views are independent and are never cross-linked or reconciled. If neither Markdown source exists, the script reports that there is nothing to render and stops. Do not ask questions or create models from `/vis-map`; `/map` owns model authoring.

## MAP view

`MAP.md` must begin with `<!-- map-format: compact-v1 -->`; unmarked/legacy files are rejected rather than converted. The ownership/connection graph uses the shared `Entity` and `DataType` types and the relationship types stored in `MAP.md`. Nested Entity headings form containment frames. Entity color is derived from containment depth, not from a stored importance field; Entities outside a containment hierarchy use the unranked style. DataTypes retain their distinct shape. Styles are deterministic and unknown types use stable fallback styling.

Entities and DataTypes remain independently draggable. Dragging a containment-frame header moves its descendant subtree; frames refit around moved nodes. Use **Save layout** to download `map-graph.layout.json`; place it beside the canonical HTML before regenerating to preserve positions.

## Flow view

`FLOWS.md` uses the current compact Markdown format with `## Scenarios`, ordered steps, optional actors, nested `Group` headings, and optional labeled `Connections`. The renderer lays out the main path left-to-right, then leaves the canvas free for arrangement. Generic group frames can be nested and dragged as a whole; steps can be dragged independently. Frame bounds refit around their contents.

The left sidebar contains only **Scenarios**. Step, connection, and frame details appear in the inspector. Scenario links support navigation and breadcrumbs. The graph supports pan, wheel zoom, and a separate layout sidecar (`flow-graph.layout.json`) so saved coordinates do not pollute scenario meaning.

Flow rendering is offline and deterministic. Legacy TOML flow formats are unsupported: do not convert them; report the issue and ask before replacing the source through `/map`.
