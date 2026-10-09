---
name: vis-map
description: Render the map/MAP.md produced by the map skill as an interactive graph using Pyvis, writing map/map-graph.html. Use when the user wants to visualize a repository map.
---

# Vis-map

Run the bundled script with no arguments to render the canonical map to its
default graph path:

```
python3 <skill-dir>/scripts/visualize.py
```

By default it reads `map/MAP.md` and writes `map/map-graph.html`. It
uses only the requested input file; if `map/MAP.md` is missing, ask the user to
run `/map` to create it rather than looking for another input file.

The generated HTML inlines Pyvis resources, so it renders without a sibling
`lib/` directory. The legend pairs descriptions with matching node-shape and
edge-line swatches; Entity importance colors each get an indented row. Hovering
or focusing a legend row highlights its matching nodes or edges in the graph.

Node positions are presentation state, separate from the semantic content in
`map/MAP.md`; the sidecar preserves hand-arranged nodes when `/vis-map`
regenerates its HTML. The **Save layout** button downloads a versioned
`map-graph.layout.json` containing node coordinates only; place it at
`map/map-graph.layout.json` beside the default HTML before regenerating. For a
custom output path, the sidecar uses the same stem with `.layout.json`. Edge
routes are recalculated from node positions. The Python script reads the
sidecar during generation and embeds
valid positions into the new HTML instead of having a local-file page fetch a
neighboring JSON file, which browsers commonly block. Positions match by node
ID: missing or invalid entries use the normal layout, new nodes are laid out as
usual, and stale IDs are ignored. The versioned schema can be extended without
changing `map/MAP.md`.

Hover a node to open its detail box; it stays open while the pointer is over
that node or the box and closes after leaving both. Edges show their metadata
on hover. An `Interact` edge's `DataType` value links to a DataType node only
when it exactly matches a node heading. Hovering or selecting an `Interact`
edge highlights the referenced DataType node; hovering or selecting a DataType
node highlights the `Interact` edges that reference it and any incident
`Composed of` edges. If no matching node exists, the value remains a plain edge
label; no node is invented and no warning is emitted. The initial
layout seeds DataType nodes on the right and all other nodes on the left, then
uses the existing force-directed clustering. The split is only a starting
arrangement; after stabilization every node remains freely draggable in both
directions. Parallel edges between the same nodes are routed into distinct
curved lanes regardless of their line styles. Do not improvise colors, shapes,
or labels per invocation:
the script's style presets are the source of truth, and other
`- **Type**: X` tags use deterministic fallback styles.

If the script fails, do not debug on your own. Report the error and ask the user
for permission to debug before investigating.
