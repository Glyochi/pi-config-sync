---
name: vis-map
description: Render independent map/MAP.md ownership and map/FLOWS.md intended runtime-flow graphs to self-contained HTML.
---

# Vis-map

Run the bundled script with no arguments to render whichever canonical sources exist:

```
python3 <skill-dir>/scripts/visualize.py
```

`map/MAP.md` writes the existing ownership view to `map/map-graph.html`; `map/FLOWS.md` independently writes `map/flow-graph.html`. Both are rendered when both inputs exist, or only the existing artifact is rendered. Neither view links to or reconciles with the other. A flow-only model does not require `MAP.md`. If neither file exists, ask whether the user wants an ownership map or an intended runtime-flow model.

Positional `visualize.py [MAP.md [map-graph.html]]` remains MAP-only. To render a custom flow input, run `python3 <skill-dir>/scripts/flow_visualize.py [FLOWS.md [flow-graph.html]]`. Flow validation completes before its HTML output is atomically replaced; validation errors include file and line locations.

The ownership graph HTML inlines Pyvis resources, so it renders without a sibling
`lib/` directory. The legend pairs descriptions with matching node, relationship,
and owner-frame swatches; Entity importance colors each get an indented row.
Hovering or focusing a legend row highlights its matching nodes, edges, or
containment frames in the graph.

Node positions are presentation state, separate from the semantic content in
`map/MAP.md`; the sidecar preserves hand-arranged nodes when `/vis-map`
regenerates its HTML. The **Save layout** button downloads a versioned
`map-graph.layout.json` containing coordinates for independently movable nodes;
owner-header positions are derived from their contents. Place it at
`map/map-graph.layout.json` beside the default HTML before regenerating. For a
custom output path, the sidecar uses the same stem with `.layout.json`. Edge
routes and owner-frame bounds are recalculated from node positions; frames are
not saved separately. The Python script reads the sidecar during generation
and embeds valid positions into the new HTML instead of having a local-file
page fetch a neighboring JSON file, which browsers commonly block. Positions match by node
ID: missing or invalid entries use the normal layout, new nodes are laid out as
usual, and stale IDs are ignored. The versioned schema can be extended without
changing `map/MAP.md`.

Hover an ownership-map node to open its detail box; it stays open while the pointer is over
that node or the box and closes after leaving both. Ownership-map edges show their metadata
on hover. An `Interact` edge's `DataType` value links to a DataType node only
when it exactly matches a node heading. Hovering or selecting an `Interact`
edge highlights the referenced DataType node; hovering or selecting a DataType
node highlights the `Interact` edges that reference it and any incident
`Composed of` edges. If no matching node exists, the value remains a plain edge
label; no node is invented and no warning is emitted.

Nested entity headings in the ownership map render as owner frames around the full descendant
subtree. The owner's importance-colored label sits on and interrupts the top
border (`-- [owner] --`). It remains a graph anchor for links, hover details, and
selection, and its resting position is derived from its child frames. Dragging
a single owner header translates its full descendant subtree, including nested
frames. Dragging a non-owner node remains child-only; multi-selection retains
its existing selected-node-only behavior without expanding owner groups. Leaf
nodes and DataTypes remain individually draggable.
`Contains` edges are hidden from the canvas but remain physics-enabled springs,
so the initial layout retains hierarchy clustering. Parent frames pad around
their direct child nodes or frames, leaving visible space between nested boxes.
Frames refit as members move; moving a movable member far away expands its
ancestor frames rather than constraining or moving the group. Hovering or
selecting an owner highlights only its own frame, not ancestor frames. DataType
nodes remain outside these entity frames.

The initial layout seeds DataType nodes on the right and all other nodes on the
left, then uses the existing force-directed clustering. The split is only a
starting arrangement; after stabilization independently movable nodes remain
free to drag in both directions, while owner headers stay aligned to their
frames. Parallel visible edges between the same nodes are routed into distinct
curved lanes regardless of their line styles. Do not improvise
colors, shapes, or labels per invocation:
the script's style presets are the source of truth, and other
`- **Type**: X` tags use deterministic fallback styles.

## Intended-flow view

`flow_visualize.py` validates the typed-Markdown format documented by `/map` and emits standalone offline HTML. Each scenario is laid out left-to-right by causal order, with participant-instance badges, typed/annotated links, guarded repeats, explicit joins, visible unknown gaps, and an event/link detail inspector. The scenario index labels entrypoints and linked subflows. Select **Open** on a subflow event to navigate; Back and clickable breadcrumbs return through nested scenarios.

The global participant controls list scenario-qualified participant instances (including separate instances of the same Flow Entity). **Highlight** dims non-selected events and their unrelated links; **Filter** hides non-selected events and links whose endpoints are hidden. Selection persists across scenario changes. **Clear selection** restores the full graph. Filtering affects presentation only; event/link details remain available, and there is no path tracing or runtime simulation.

Event nodes can be manually repositioned by dragging. **Save flow layout** downloads a versioned `map/flow-graph.layout.json` beside the default HTML; for custom output names, use the matching `.layout.json` stem. Place the downloaded file beside the HTML before regenerating. The generator embeds valid positions so the HTML remains offline and does not fetch a neighboring file. Version 1 stores event-center coordinates under stable scenario/event IDs, e.g. `{"version":1,"scenarios":{"scenario-id":{"event-id":{"x":320,"y":180}}}}`; stale IDs are ignored, new events use the causal layout, and malformed files or coordinates are ignored with a warning. Coordinates must be finite numbers (`x` 140–1,000,000; `y` 130–1,000,000). This sidecar is independent of both `FLOWS.md` and the MAP layout sidecar.

Invalid flows must be corrected at the reported source locations, not bypassed. For unrelated ownership-renderer failures, report the error and ask the user for permission before debugging.
