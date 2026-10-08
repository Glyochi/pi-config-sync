---
name: vis-map
description: Render the ARCHITECTURE.md produced by the map skill as an interactive directed graph using Pyvis, writing architecture-graph.html. Use when the user wants to visualize the architecture/knowledge map of a codebase.
---

# Vis-map

Run the bundled script to render `ARCHITECTURE.md` into `architecture-graph.html`:

```
python3 <skill-dir>/scripts/visualize.py ARCHITECTURE.md architecture-graph.html
```

That is the whole job. Do not improvise colors, shapes, or labels — the script
hardcodes all styling and renders any `- **Type**: X` tag generically.

If the script fails, do not debug on your own. Report the error and ask the user
for permission to debug before investigating.
