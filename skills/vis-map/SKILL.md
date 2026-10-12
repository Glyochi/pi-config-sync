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

`flow_visualize.py` validates the typed-Markdown versions documented by `/map` and emits standalone offline HTML. Version 1 retains its legacy left-to-right participant-badge view; it does not infer process/thread identity. Version 2 renders explicit OS-process frames containing sibling thread frames, with execution steps ordered top-to-bottom inside their executing thread. Component participation remains separate: a registry/allocator operation appears in its caller's thread, not in an invented component thread.

Process headers show modeled process counts and per-instance thread counts; dynamic families such as `0..n` HTTP request threads are labeled explicitly. Empty context-only frames remain visible and say that their steps are unexpanded, not unknown. Counts describe declared application contexts, not a measured runtime census. External actors appear outside application process frames.

The version-2 legend distinguishes gray execution-order arrows, purple dotted spawn arrows, blue dashed messages, amber dotted wake/signals, and red guarded execution-repeat arrows. Decision diamonds expose guarded branches; thread-entry and termination nodes are explicit. Spawn arrows connect creator actions to entry nodes, not to child readiness joins. Interaction arrows do not imply waiting unless waiting is explicitly modeled. Loop routes remain inside the executing thread for sequence repeats; cross-context repeated deliveries keep their message/signal style. Event/link/frame inspectors show execution context, contracts, and interaction details. The scenario index labels entrypoints and linked subflows. Select **Open** on a subflow event to navigate; Back and clickable breadcrumbs return through nested scenarios.

The global controls list scenario-qualified participant instances and, for version 2, executing threads. Selecting a component can highlight its calls in several threads; selecting a thread highlights its execution steps. **Highlight** dims unselected steps and unrelated links; **Filter** hides unselected steps and links with hidden endpoints. Filtering retains all declared frames/counts and labels the view as filtered with visible/total step counts, so the result cannot be mistaken for the full runtime. Selection persists across scenarios. **Clear selection** restores all steps. Event/link details remain accessible while filtered; there is no path tracing or runtime simulation.

Event nodes can be manually repositioned by dragging. In version 2, horizontal movement stays in the declared execution lane; vertical movement refits thread and process bounds. Dragging never changes the semantic thread/process assignment. Frames are derived from their members and are not separately persisted. **Save flow layout** downloads `map/flow-graph.layout.json`; for custom output names use the matching `.layout.json` stem. Place it beside the HTML before regenerating. The generator embeds positions to remain offline without fetching a neighboring file. The sidecar schema remains version 1, storing event-center coordinates under stable scenario/event IDs, e.g. `{"version":1,"scenarios":{"scenario-id":{"event-id":{"x":320,"y":480}}}}`. Stale IDs are ignored, new events use the deterministic layout, and malformed coordinates/files are ignored with a warning. Coordinates must be finite numbers (`x` 140–1,000,000; `y` 130–1,000,000). A saved version-2 coordinate outside its declared lane/header clearance is clamped with a warning rather than moving the step into another thread. Flow format version and layout-sidecar version are independent; neither refers to the ownership map or its sidecar.

Version-2 layout/style helpers live in `scripts/flow_runtime.py`, `scripts/flow_runtime.js`, and `scripts/flow_runtime.css`; their output is inlined into the generated HTML. Preserve the script's presets rather than improvising colors or frames per invocation. Use `tests/fixtures/execution-flows.md` for the synthetic grouped-flow contract; it is not real-repository guidance.

Invalid flows must be corrected at the reported source locations, not bypassed. For unrelated ownership-renderer failures, report the error and ask the user for permission before debugging.
