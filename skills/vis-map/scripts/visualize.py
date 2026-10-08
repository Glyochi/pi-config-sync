#!/usr/bin/env python3
"""Render ARCHITECTURE.md as an interactive directed graph using Pyvis.

Reads the markdown produced by the `map` skill and writes an HTML graph. The
format is self-describing via `- **Type**: X` tags, so this script renders any
node/edge type generically: known types get their fixed styling, unknown types
get a deterministic fallback. All styling is hardcoded below so the output is
identical regardless of which model invokes this script.

Usage:
    python3 visualize.py [ARCHITECTURE.md] [output.html]
"""

import json
import re
import sys
import zlib

try:
    from pyvis.network import Network
except ImportError:
    print("Error: pyvis is not installed. Run: pip install pyvis", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Styling standard (source of truth — do not change per-invocation)
# ---------------------------------------------------------------------------

ENTITY_SHAPE = "box"
DATATYPE_SHAPE = "diamond"
UNKNOWN_NODE_SHAPE = "ellipse"

# Entity importance palette: a sequential ramp, strongest -> palest, with hue
# drifting red -> amber. Importance is ordinal, so the palette varies lightness
# monotonically (the one visual variable every reader can order, including with
# colour-vision deficiency and in greyscale) while chroma falls off too. Every
# step keeps >= 4.5:1 contrast against the default black label (WCAG AA).
IMPORTANCE_PALETTE = [
    ("strong red", "#E75C40"),   # contrast 6.00
    ("red", "#E27757"),          # 7.01
    ("soft red", "#DD8E6D"),     # 8.16
    ("orange", "#DAA181"),       # 9.40
    ("soft orange", "#D8B194"),  # 10.64
    ("amber", "#D8BEA5"),        # 11.83
    ("pale amber", "#D8C9B5"),   # 12.94
    ("pale tan", "#DBD2C4"),     # 14.03
    ("pale gray", "#DEDAD2"),    # 15.07
    ("light gray", "#E3E2DE"),   # 16.20
]

ENTITY_DEFAULT_COLOR = "#E3E2DE"

# Canonical importance order, highest -> lowest. The scale the map skill starts
# with (Critical / Significant / Peripheral) is pinned first; any other tier the
# user steers in is ranked after these, in order of first appearance.
IMPORTANCE_ORDER = [
    "critical",
    "very high",
    "high",
    "significant",
    "medium",
    "moderate",
    "peripheral",
    "low",
    "minor",
    "trivial",
]

# Unknown node types are categorical, not ordinal, so they get a deterministic
# light color from a qualitative (hue-distinct) palette rather than the ramp.
NODE_FALLBACK_PALETTE = [
    ("light green", "#A9DBA4"),
    ("light teal", "#9BD6CE"),
    ("light blue", "#A9CCEF"),
    ("light violet", "#C3B4E8"),
    ("light pink", "#E8B4D8"),
    ("light yellow", "#EAD98A"),
    ("light olive", "#D6D69B"),
    ("light brown", "#D8BFA8"),
    ("light cyan", "#B7E3E6"),
    ("light magenta", "#EBB9E6"),
]

DATATYPE_COLOR = "#A9CCEF"

# Unknown edge types keep saturated colors so the lines stay visible on white.
EDGE_FALLBACK_PALETTE = [
    "purple", "teal", "brown", "pink", "olive",
    "cyan", "magenta", "lime", "navy", "maroon",
]

# Known edge types: (color, dash pattern). vis-network edges use `dashes`
# (false = solid, or an array of dash/gap pixel lengths), NOT `style` — `style`
# is a node option and is silently ignored on edges, so every edge renders solid.
CONTAINS_COLOR = "gray"
CONTAINS_DASHES = False
INTERACT_COLOR = "#2B7CE9"
INTERACT_DASHES = [5, 5]
COMPOSED_OF_COLOR = "#A020F0"
COMPOSED_OF_DASHES = [2, 6]
UNKNOWN_EDGE_DASHES = False

# Hex colors render correctly but read poorly in the legend, so they are mapped
# to plain English names. The importance palette carries its own names.
COLOR_NAMES = {"#2B7CE9": "blue", "#A020F0": "purple", DATATYPE_COLOR: "light blue"}
COLOR_NAMES.update({color: name for name, color in IMPORTANCE_PALETTE})
COLOR_NAMES.update({color: name for name, color in NODE_FALLBACK_PALETTE})

OPTIONS = """
{
  "physics": {
    "enabled": true,
    "solver": "forceAtlas2Based",
    "forceAtlas2Based": {
      "gravitationalConstant": -120,
      "centralGravity": 0.005,
      "springLength": 250,
      "springConstant": 0.05,
      "damping": 0.4,
      "avoidOverlap": 0.5
    },
    "stabilization": {"enabled": true, "iterations": 300, "updateInterval": 25}
  },
  "interaction": {
    "multiselect": true,
    "dragNodes": true,
    "dragView": true
  }
}
"""

# Disable physics after initial layout so nodes can be dragged freely without
# pulling neighbors. Uses the stabilization event plus a timeout fallback.
PHYSICS_DISABLE_JS = """
<script type="text/javascript">
  function disablePhysics() {
    network.setOptions({ physics: { enabled: false } });
  }
  network.once("stabilizationIterationsDone", disablePhysics);
  setTimeout(disablePhysics, 5000);
</script>
"""

# Marquee (drag-box) multi-select on the background, and edge bending by dragging
# an edge. Background drag selects nodes; edge drag adjusts the edge curve.
INTERACTION_JS = """
<script type="text/javascript">
  var container = document.getElementById("mynetwork");
  var canvas = container.getElementsByTagName("canvas")[0];

  function getPos(e) {
    var rect = container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  var selectionBox = document.createElement("div");
  selectionBox.style.position = "absolute";
  selectionBox.style.border = "1px dashed #333";
  selectionBox.style.background = "rgba(0,0,0,0.08)";
  selectionBox.style.display = "none";
  selectionBox.style.pointerEvents = "none";
  container.appendChild(selectionBox);

  var selecting = false;
  var startX = 0, startY = 0;
  var draggingEdge = null;
  var edgeStart = null;

  canvas.addEventListener("mousedown", function(e) {
    var pos = getPos(e);
    var edgeId = network.getEdgeAt(pos);
    if (edgeId !== undefined) {
      draggingEdge = edgeId;
      edgeStart = pos;
      return;
    }
    if (e.shiftKey && network.getNodeAt(pos) === undefined) {
      selecting = true;
      startX = pos.x;
      startY = pos.y;
      selectionBox.style.display = "block";
      selectionBox.style.left = startX + "px";
      selectionBox.style.top = startY + "px";
      selectionBox.style.width = "0px";
      selectionBox.style.height = "0px";
    }
  });

  canvas.addEventListener("mousemove", function(e) {
    var pos = getPos(e);
    if (draggingEdge) {
      var dx = pos.x - edgeStart.x;
      var dy = pos.y - edgeStart.y;
      var roundness = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 200);
      network.body.data.edges.update({ id: draggingEdge, smooth: { type: "curvedCW", roundness: roundness } });
      return;
    }
    if (selecting) {
      var x = Math.min(startX, pos.x);
      var y = Math.min(startY, pos.y);
      var w = Math.abs(pos.x - startX);
      var h = Math.abs(pos.y - startY);
      selectionBox.style.left = x + "px";
      selectionBox.style.top = y + "px";
      selectionBox.style.width = w + "px";
      selectionBox.style.height = h + "px";
    }
  });

  canvas.addEventListener("mouseup", function(e) {
    if (draggingEdge) {
      draggingEdge = null;
      return;
    }
    if (selecting) {
      selecting = false;
      selectionBox.style.display = "none";
      var pos = getPos(e);
      var x1 = Math.min(startX, pos.x);
      var y1 = Math.min(startY, pos.y);
      var x2 = Math.max(startX, pos.x);
      var y2 = Math.max(startY, pos.y);
      var selected = [];
      var positions = network.getPositions();
      for (var id in positions) {
        var domPos = network.canvasToDOM(positions[id]);
        if (domPos.x >= x1 && domPos.x <= x2 && domPos.y >= y1 && domPos.y <= y2) {
          selected.push(id);
        }
      }
      network.selectNodes(selected);
    }
  });
</script>
"""

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def split_sections(lines):
    """Split the file into entity, datatype, and relationship line groups."""
    datatypes_idx = None
    relationships_idx = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "## DataTypes":
            datatypes_idx = i
        elif stripped.startswith("## Relationships"):
            relationships_idx = i

    entity_lines = lines[:datatypes_idx] if datatypes_idx is not None else lines
    datatype_lines = (
        lines[datatypes_idx:relationships_idx]
        if datatypes_idx is not None
        else []
    )
    relationship_lines = (
        lines[relationships_idx:] if relationships_idx is not None else []
    )
    return entity_lines, datatype_lines, relationship_lines


def parse_field(line):
    """Parse a `- **Key**: Value` line into (key, value), or (None, None)."""
    stripped = line.strip()
    if not stripped.startswith("- **"):
        return None, None
    rest = stripped[4:]
    if "**:" in rest:
        key, value = rest.split("**:", 1)
        return key.strip(), value.strip()
    return None, None


def parse_entities(lines):
    """Parse nested headings into nodes with a parent (Contains) link."""
    entities = []
    stack = []  # (name, level)
    for line in lines:
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            name = line.lstrip("#").strip()
            while stack and stack[-1][1] >= level:
                stack.pop()
            parent = stack[-1][0] if stack else None
            stack.append((name, level))
            entities.append({
                "name": name,
                "parent": parent,
                "type": "Entity",
                "fields": {},
            })
        elif entities:
            key, value = parse_field(line)
            if key == "Type":
                entities[-1]["type"] = value
            elif key is not None:
                entities[-1]["fields"][key] = value
    return entities


def parse_datatypes(lines):
    """Parse the DataTypes section into nodes (with Composed of edges)."""
    datatypes = []
    current = None
    for line in lines:
        if line.startswith("###"):
            name = line.lstrip("#").strip()
            current = {
                "name": name,
                "type": "DataType",
                "fields": {},
                "composed_of": [],
            }
            datatypes.append(current)
        elif current is not None:
            key, value = parse_field(line)
            if key == "Type":
                current["type"] = value
            elif key == "Composed of":
                current["composed_of"].append(value)
            elif key is not None:
                current["fields"][key] = value
    return datatypes


def parse_relationships(lines):
    """Parse the Relationships section into edges with a type tag."""
    edges = []
    current = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("- ") and (
            "\u2192" in stripped or "\u2194" in stripped
        ):
            if "\u2194" in stripped:
                source, target = stripped[2:].split("\u2194", 1)
                bidirectional = True
            else:
                source, target = stripped[2:].split("\u2192", 1)
                bidirectional = False
            current = {
                "source": source.strip(),
                "target": target.strip(),
                "type": "Interact",
                "fields": {},
                "bidirectional": bidirectional,
            }
            edges.append(current)
        elif current is not None:
            key, value = parse_field(line)
            if key == "Type":
                current["type"] = value
            elif key is not None:
                current["fields"][key] = value
    return edges


# ---------------------------------------------------------------------------
# Styling
# ---------------------------------------------------------------------------

_tier_rank = {}
_tier_colors = {}


def importance_rank(importance):
    """Sort key: canonical scale position, then order of first appearance."""
    key = importance.strip().lower()
    if key in IMPORTANCE_ORDER:
        return IMPORTANCE_ORDER.index(key)
    if key not in _tier_rank:
        _tier_rank[key] = len(IMPORTANCE_ORDER) + len(_tier_rank)
    return _tier_rank[key]


def order_importance_tiers(tiers):
    """Sort the tiers present highest -> lowest and assign ramp colors.

    Colors are sampled across the whole sequential ramp, so the top tier is
    always the strongest color and the bottom the palest, whatever the count.
    """
    unique = {}
    for tier in tiers:
        if tier and tier.strip():
            unique.setdefault(tier.strip().lower(), tier.strip())
    ordered = sorted(unique.values(), key=importance_rank)
    last = len(IMPORTANCE_PALETTE) - 1
    for i, tier in enumerate(ordered):
        idx = 0 if len(ordered) <= 1 else int(round(i * last / (len(ordered) - 1)))
        _tier_colors[tier.lower()] = IMPORTANCE_PALETTE[idx]
    return ordered


def entity_color(importance):
    """Light background for an importance tier (black label stays readable)."""
    if importance is None:
        return ENTITY_DEFAULT_COLOR
    entry = _tier_colors.get(importance.strip().lower())
    return entry[1] if entry else ENTITY_DEFAULT_COLOR


def fallback_node_color(type_name):
    """Deterministic light background for an unknown node type."""
    idx = zlib.crc32(type_name.encode("utf-8")) % len(NODE_FALLBACK_PALETTE)
    return NODE_FALLBACK_PALETTE[idx][1]


def fallback_edge_color(type_name):
    """Deterministic saturated color for an unknown edge type."""
    idx = zlib.crc32(type_name.encode("utf-8")) % len(EDGE_FALLBACK_PALETTE)
    return EDGE_FALLBACK_PALETTE[idx]


def node_style(node_type, fields):
    if node_type == "Entity":
        return {"shape": ENTITY_SHAPE, "color": entity_color(fields.get("Importance"))}
    if node_type == "DataType":
        return {"shape": DATATYPE_SHAPE, "color": DATATYPE_COLOR}
    return {"shape": UNKNOWN_NODE_SHAPE, "color": fallback_node_color(node_type)}


def edge_style(edge_type):
    if edge_type == "Contains":
        return {"color": CONTAINS_COLOR, "dashes": CONTAINS_DASHES}
    if edge_type == "Interact":
        return {"color": INTERACT_COLOR, "dashes": INTERACT_DASHES}
    if edge_type == "Composed of":
        return {"color": COMPOSED_OF_COLOR, "dashes": COMPOSED_OF_DASHES}
    return {"color": fallback_edge_color(edge_type), "dashes": UNKNOWN_EDGE_DASHES}


def dashes_label(dashes):
    """Human-readable name for a dash pattern (used in the legend)."""
    if not dashes:
        return "solid"
    if dashes == COMPOSED_OF_DASHES:
        return "dotted"
    return "dashed"


def color_label(color):
    """Human-readable color name for the legend (hex values get a plain name)."""
    key = color.upper() if isinstance(color, str) else color
    return COLOR_NAMES.get(key, color)


def node_title(name, node_type, fields):
    lines = [name, "Type: " + node_type]
    for k, v in fields.items():
        lines.append("{}: {}".format(k, v))
    return "\n".join(lines)


def edge_title(source, target, edge_type, fields):
    lines = ["{} \u2192 {}".format(source, target), "Type: " + edge_type]
    for k, v in fields.items():
        lines.append("{}: {}".format(k, v))
    return "\n".join(lines)


# Cap the built-in vis-network tooltip (still used for edges) so long text wraps
# instead of stretching the popover across the screen.
TOOLTIP_CSS = """
<style type="text/css">
  div.vis-tooltip {
    max-width: 340px !important;
    white-space: pre-wrap !important;
    word-break: break-word !important;
  }
</style>
"""

# Node hover popover. Uses vis-network's own hit-testing (getNodeAt on the
# canvas) but draws our own box, so it can be width-capped and left in place long
# enough to select the text. The box is anchored beside the node, not under the
# cursor: a box under the cursor both chases the mouse and covers the node, which
# breaks hit-testing and makes the hover feel random.
POPOVER_JS = """
<script type="text/javascript">
var NODE_DESCRIPTIONS = __DESCRIPTIONS__;
(function () {
  if (typeof canvas === "undefined" || !canvas || typeof getPos !== "function") return;

  var box = document.createElement("div");
  box.style.cssText = "position:fixed;display:none;max-width:340px;max-height:50vh;"
    + "overflow:auto;background:rgba(255,255,255,0.98);border:1px solid #ccc;"
    + "border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.2);padding:8px 10px;"
    + "z-index:2000;font-family:sans-serif;font-size:12px;line-height:1.5;color:#222;"
    + "white-space:pre-wrap;word-break:break-word;"
    + "user-select:text;-webkit-user-select:text;cursor:text;";
  document.body.appendChild(box);

  var hideTimer = null;
  var shown = null;

  function hide() {
    clearTimeout(hideTimer);
    shown = null;
    box.style.display = "none";
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 400);
  }

  // Sit just outside the node, so the box never covers the node and never sits
  // under the cursor; the mouse can then travel from the node onto the box.
  function place(nodeId) {
    var w = box.offsetWidth;
    var h = box.offsetHeight;
    var left;
    var top;
    try {
      var rect = network.getBoundingBox(nodeId);
      var tl = network.canvasToDOM({ x: rect.left, y: rect.top });
      var br = network.canvasToDOM({ x: rect.right, y: rect.bottom });
      left = br.x + 12;
      top = tl.y;
      if (left + w > window.innerWidth - 8) left = tl.x - w - 12;
    } catch (err) {
      var p = network.canvasToDOM(network.getPositions()[nodeId]);
      left = p.x + 24;
      top = p.y + 24;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    box.style.left = left + "px";
    box.style.top = top + "px";
  }

  function show(nodeId) {
    clearTimeout(hideTimer);
    if (shown === nodeId) return;
    shown = nodeId;
    box.textContent = NODE_DESCRIPTIONS[nodeId];
    box.style.display = "block";
    place(nodeId);
  }

  box.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
  box.addEventListener("mouseleave", scheduleHide);

  canvas.addEventListener("mousemove", function (e) {
    var nodeId = network.getNodeAt(getPos(e));
    if (nodeId !== undefined && NODE_DESCRIPTIONS[nodeId]) show(nodeId);
    else scheduleHide();
  });
  canvas.addEventListener("mouseleave", scheduleHide);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hide();
  });
})();
</script>
"""


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_graph(entities, datatypes, relationships):
    net = Network(directed=True, height="750px", width="100%")
    node_types = {}
    edge_types = {}
    known_nodes = set()
    descriptions = {}

    def ensure_node(name):
        """Resolve an edge endpoint, auto-creating it if it is not defined.

        A trailing qualifier such as ``Worker Process (data plane)`` resolves to
        the base node when one exists; otherwise the referenced name is added as
        an Unknown node so the edge is never dropped.
        """
        if name in known_nodes:
            return name
        base = re.sub(r"\s*\([^)]*\)\s*$", "", name).strip()
        if base and base in known_nodes:
            return base
        known_nodes.add(name)
        style = node_style("Unknown", {})
        node_types["Unknown"] = style
        descriptions[name] = node_title(name, "Unknown", {})
        net.add_node(
            name,
            label=name,
            shape=style["shape"],
            color=style["color"],
        )
        return name

    for e in entities:
        known_nodes.add(e["name"])
        style = node_style(e["type"], e["fields"])
        node_types[e["type"]] = style
        descriptions[e["name"]] = node_title(e["name"], e["type"], e["fields"])
        net.add_node(
            e["name"],
            label=e["name"],
            shape=style["shape"],
            color=style["color"],
        )

    for e in entities:
        if e["parent"]:
            style = edge_style("Contains")
            edge_types["Contains"] = style
            net.add_edge(
                e["parent"],
                e["name"],
                color=style["color"],
                dashes=style["dashes"],
                arrows="to",
            )

    for d in datatypes:
        known_nodes.add(d["name"])
        style = node_style(d["type"], d["fields"])
        node_types[d["type"]] = style
        descriptions[d["name"]] = node_title(d["name"], d["type"], d["fields"])
        net.add_node(
            d["name"],
            label=d["name"],
            shape=style["shape"],
            color=style["color"],
        )

    for d in datatypes:
        for entry in d["composed_of"]:
            for c in entry.split(","):
                c = c.strip()
                if not c:
                    continue
                style = edge_style("Composed of")
                edge_types["Composed of"] = style
                net.add_edge(
                    d["name"],
                    ensure_node(c),
                    color=style["color"],
                    dashes=style["dashes"],
                    arrows="to",
                )

    for r in relationships:
        source = ensure_node(r["source"])
        target = ensure_node(r["target"])
        style = edge_style(r["type"])
        edge_types[r["type"]] = style
        label = r["fields"].get("DataType", "")
        net.add_edge(
            source,
            target,
            color=style["color"],
            dashes=style["dashes"],
            arrows="to,from" if r.get("bidirectional") else "to",
            label=label,
            title=edge_title(source, target, r["type"], r["fields"]),
        )

    return net, node_types, edge_types, descriptions


def build_legend(node_types, edge_types, entity_tiers):
    parts = [
        '<div style="position: fixed; top: 10px; left: 10px; background: rgba(255,255,255,0.95);'
        ' border: 1px solid #ccc; padding: 10px; z-index: 1000; font-family: sans-serif;'
        ' font-size: 12px; max-height: 80vh; overflow: auto;">',
        "<b>Legend</b><br>",
        "<b>Nodes</b><br>",
    ]
    for t, s in sorted(node_types.items()):
        if t == "Entity":
            tiers = ", ".join(
                "{}={}".format(tier, color_label(entity_color(tier)))
                for tier in entity_tiers
            )
            detail = "box, color by importance: " + tiers if tiers else "box"
            parts.append("Entity ({})<br>".format(detail))
        else:
            parts.append(
                "{} ({} {})<br>".format(t, s["shape"], color_label(s["color"]))
            )
    parts.append("<b>Edges</b><br>")
    for t, s in sorted(edge_types.items()):
        parts.append(
            "{} ({} {})<br>".format(
                t, dashes_label(s["dashes"]), color_label(s["color"])
            )
        )
    parts.append("</div>")
    return "".join(parts)


def main():
    input_path = sys.argv[1] if len(sys.argv) > 1 else "ARCHITECTURE.md"
    output_path = sys.argv[2] if len(sys.argv) > 2 else "architecture-graph.html"

    try:
        with open(input_path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        print(
            "Error: {} not found. Run /skill:map first.".format(input_path),
            file=sys.stderr,
        )
        sys.exit(1)

    entity_lines, datatype_lines, relationship_lines = split_sections(lines)
    entities = parse_entities(entity_lines)
    datatypes = parse_datatypes(datatype_lines)
    relationships = parse_relationships(relationship_lines)

    entity_tiers = order_importance_tiers(
        e["fields"].get("Importance") for e in entities
    )
    net, node_types, edge_types, descriptions = build_graph(
        entities, datatypes, relationships
    )
    net.set_options(OPTIONS)
    net.write_html(output_path, open_browser=False)

    with open(output_path, "r", encoding="utf-8") as f:
        html = f.read()
    legend = build_legend(node_types, edge_types, entity_tiers)
    popover = POPOVER_JS.replace("__DESCRIPTIONS__", json.dumps(descriptions))
    injected = (
        legend
        + "\n"
        + TOOLTIP_CSS
        + "\n"
        + PHYSICS_DISABLE_JS
        + "\n"
        + INTERACTION_JS
        + "\n"
        + popover
        + "\n</body>"
    )
    html = html.replace("</body>", injected)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(
        "Wrote {} ({} entities, {} datatypes, {} edges)".format(
            output_path, len(entities), len(datatypes), len(relationships)
        )
    )


if __name__ == "__main__":
    main()
