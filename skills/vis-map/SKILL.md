---
name: vis-map
description: Render the ARCHITECTURE.md produced by the map skill as an interactive directed graph using Pyvis, writing architecture-graph.html. Use when the user wants to visualize the architecture/knowledge map of a codebase.
---

# Vis-map

Run the bundled script to render `ARCHITECTURE.md` into `architecture-graph.html`:

```
python3 <skill-dir>/scripts/visualize.py ARCHITECTURE.md architecture-graph.html
```

Hover a node to open its detail box; it stays open while the pointer is over
that node or the box and closes after leaving both. Edges show their metadata
on hover, and parallel edges between the same nodes are routed into distinct
curved lanes regardless of their line styles. Do not improvise colors, shapes,
or labels per invocation: the script's style presets are the source of truth,
and other `- **Type**: X` tags use deterministic fallback styles.

If the script fails, do not debug on your own. Report the error and ask the user
for permission to debug before investigating.
