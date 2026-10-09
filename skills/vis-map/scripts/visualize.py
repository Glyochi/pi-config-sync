#!/usr/bin/env python3
"""Render ARCHITECTURE.md as an interactive directed graph using Pyvis.

Reads the markdown produced by the `map` skill and writes an HTML graph. The
format is self-describing via `- **Type**: X` tags, so this script renders any
node/edge type generically: known types get their fixed styling, unknown types
get a deterministic fallback. Interact-edge DataType labels that exactly
match existing DataType nodes highlight those nodes when the edge is hovered or
selected; unmatched labels remain plain strings. All styling is hardcoded below
so the output is identical regardless of which model invokes this script.

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
IMPORTANCE_RANK = {tier: rank for rank, tier in enumerate(IMPORTANCE_ORDER)}

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
DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND = "#FFE08A"
DATATYPE_REFERENCE_HIGHLIGHT_BORDER = "#E67700"
DATATYPE_REFERENCE_HIGHLIGHT_BORDER_WIDTH = 4

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

# Known styles are declared centrally; unknown types use deterministic fallbacks.
NODE_STYLE_PRESETS = {
    "DataType": {"shape": DATATYPE_SHAPE, "color": DATATYPE_COLOR},
}
EDGE_STYLE_PRESETS = {
    "Contains": {"color": CONTAINS_COLOR, "dashes": CONTAINS_DASHES},
    "Interact": {"color": INTERACT_COLOR, "dashes": INTERACT_DASHES},
    "Composed of": {"color": COMPOSED_OF_COLOR, "dashes": COMPOSED_OF_DASHES},
}

# Hex colors render correctly but read poorly in the legend, so they are mapped
# to plain English names. The importance palette carries its own names.
COLOR_NAMES = {"#2B7CE9": "blue", "#A020F0": "purple", DATATYPE_COLOR: "light blue"}
COLOR_NAMES.update({color: name for name, color in IMPORTANCE_PALETTE})
COLOR_NAMES.update({color: name for name, color in NODE_FALLBACK_PALETTE})

OPTIONS = {
    "physics": {
        "enabled": True,
        "solver": "forceAtlas2Based",
        "forceAtlas2Based": {
            "gravitationalConstant": -120,
            "centralGravity": 0.005,
            "springLength": 250,
            "springConstant": 0.05,
            "damping": 0.4,
            "avoidOverlap": 0.5,
        },
        "stabilization": {
            "enabled": True,
            "iterations": 300,
            "updateInterval": 25,
        },
    },
    "edges": {"smooth": False},
    "interaction": {
        "hover": True,
        "tooltipDelay": 200,
        "multiselect": True,
        "dragNodes": True,
        "dragView": True,
    },
}

# Disable physics after initial layout so nodes can be dragged freely without
# pulling neighbors. Uses the stabilization event plus a timeout fallback.
PHYSICS_DISABLE_JS = """
<script type="text/javascript">
(function () {
  function disablePhysics() {
    network.setOptions({ physics: { enabled: false } });
  }
  network.once("stabilizationIterationsDone", disablePhysics);
  setTimeout(disablePhysics, 5000);
})();
</script>
"""

# Custom network interactions: undo node drags, select nodes with Shift-drag,
# and separate parallel edges or route around obstacles after layout settles.
INTERACTION_JS = """
<script type="text/javascript">
(function () {
  var container = document.getElementById("mynetwork");
  var canvas = container && container.querySelector("canvas");
  if (!canvas) return;

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
  var startX = 0;
  var startY = 0;

  // --- undo (Ctrl+Z) ---------------------------------------------------------
  // A layout snapshot is taken when a drag begins and pushed only if the layout
  // actually changed, so undo always steps back one real edit.
  var undoStack = [];
  var pending = null;

  function stateKey() {
    var parts = [];
    var positions = network.getPositions();
    Object.keys(positions).sort().forEach(function(id) {
      parts.push(
        id + ":" + Math.round(positions[id].x) + "," + Math.round(positions[id].y)
      );
    });
    return parts.join("|");
  }

  function snapshot() {
    var positions = network.getPositions();
    return Object.keys(positions).map(function(id) {
      return { id: id, x: positions[id].x, y: positions[id].y };
    });
  }

  function beginChange() {
    pending = { state: snapshot(), key: stateKey() };
  }

  function endChange() {
    if (pending && pending.key !== stateKey()) {
      undoStack.push(pending.state);
      if (undoStack.length > 100) undoStack.shift();
    }
    pending = null;
  }

  function undo() {
    var state = undoStack.pop();
    if (!state) return;
    network.body.data.nodes.update(state);
    rerouteEdges();
  }

  // --- separate parallel edges and route around blocking nodes --------------
  // Every edge between the same nodes gets its own curved lane, regardless of
  // direction or line style. Curve type is relative to edge direction, so map
  // each lane against a canonical endpoint order. Single edges stay straight
  // unless they cross an unrelated node; "dynamic" routing is not avoidance.
  var EDGE_CLEARANCE = 6;
  var BEND_ROUNDNESS = 0.3;
  var MAX_PARALLEL_ROUNDNESS = 0.9;

  function curve(type, roundness) {
    return { enabled: true, type: type, roundness: roundness };
  }

  function parallelRoundness(level) {
    return BEND_ROUNDNESS
      + (MAX_PARALLEL_ROUNDNESS - BEND_ROUNDNESS) * level / (level + 3);
  }

  // Parallel edges (any two edges joining the same pair of nodes, in either
  // direction) are fanned onto separate lanes instead of drawn on top of each
  // other. curvedCW bulges to the LEFT of from->to and curvedCCW to the right,
  // so a lane is picked as a geometric side and then flipped into a
  // travel-relative type: both directions of an anti-parallel pair must share
  // the same travel side to land on opposite sides of the chord.
  var LANE_ROUNDNESS = 0.2;

  // Segment vs axis-aligned box (Liang-Barsky), box inflated by the clearance.
  function segmentHitsBox(ax, ay, bx, by, box) {
    var x1 = box.left - EDGE_CLEARANCE;
    var x2 = box.right + EDGE_CLEARANCE;
    var y1 = box.top - EDGE_CLEARANCE;
    var y2 = box.bottom + EDGE_CLEARANCE;
    var dx = bx - ax;
    var dy = by - ay;
    var t0 = 0;
    var t1 = 1;
    var p = [-dx, dx, -dy, dy];
    var q = [ax - x1, x2 - ax, ay - y1, y2 - ay];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
      } else {
        var r = q[i] / p[i];
        if (p[i] < 0) {
          if (r > t1) return false;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return false;
          if (r < t1) t1 = r;
        }
      }
    }
    return true;
  }

  function edgePairKey(edge) {
    var ends = [String(edge.from), String(edge.to)];
    ends.sort();
    return JSON.stringify(ends);
  }

  // +1 when from->to runs in the canonical (lexicographic) direction.
  function dirSign(edge) {
    return String(edge.from) < String(edge.to) ? 1 : -1;
  }

  // Map of edge id -> smooth option, for edges sharing a node pair with at
  // least one other edge. Lane 0 takes one geometric side, lane 1 the other,
  // and higher lanes repeat the sides further out so same-direction duplicates
  // fan out as well. The order is deterministic so lanes stay stable across
  // reroutes.
  function parallelLanes(edges) {
    var groups = {};
    edges.forEach(function(edge) {
      var key = edgePairKey(edge);
      if (!groups[key]) groups[key] = [];
      groups[key].push(edge);
    });

    var lanes = {};
    Object.keys(groups).forEach(function(key) {
      var group = groups[key];
      if (group.length < 2) return;
      group.sort(function(x, y) {
        var dx = dirSign(x);
        var dy = dirSign(y);
        if (dx !== dy) return dy - dx;
        var sx = String(x.id);
        var sy = String(y.id);
        return sx < sy ? -1 : (sx > sy ? 1 : 0);
      });
      group.forEach(function(edge, i) {
        var side = i % 2 === 0 ? 1 : -1;
        var mag = Math.floor(i / 2) + 1;
        lanes[edge.id] = {
          enabled: true,
          type: side * dirSign(edge) > 0 ? "curvedCW" : "curvedCCW",
          roundness: Math.min(LANE_ROUNDNESS * mag, 1)
        };
      });
    });
    return lanes;
  }

  function rerouteEdges() {
    var positions = network.getPositions();
    var ids = Object.keys(positions);
    var boxes = {};
    ids.forEach(function(id) {
      boxes[id] = network.getBoundingBox(id);
    });

    var edges = network.body.data.edges.get();
    var lanes = parallelLanes(edges);

    var updates = [];
    var edges = network.body.data.edges.get();
    var parallelGroups = {};
    edges.forEach(function(edge) {
      if (edge.from === edge.to) return;
      var endpoints = [String(edge.from), String(edge.to)].sort();
      var key = JSON.stringify(endpoints);
      if (!parallelGroups[key]) {
        parallelGroups[key] = { canonicalFrom: endpoints[0], edges: [] };
      }
      parallelGroups[key].edges.push(edge);
    });

    var parallelCurves = new Map();
    Object.keys(parallelGroups).forEach(function(key) {
      var groupData = parallelGroups[key];
      var group = groupData.edges;
      if (group.length < 2) return;
      group.sort(function(a, b) {
        var aId = String(a.id);
        var bId = String(b.id);
        return aId < bId ? -1 : aId > bId ? 1 : 0;
      });
      var canonicalFrom = groupData.canonicalFrom;
      // Alternate sides first, then widen each side's lane for extra edges.
      group.forEach(function(edge, index) {
        var laneSide = index % 2 === 0 ? 1 : -1;
        var direction = String(edge.from) === canonicalFrom ? 1 : -1;
        parallelCurves.set(edge.id, curve(
          laneSide * direction > 0 ? "curvedCW" : "curvedCCW",
          parallelRoundness(Math.floor(index / 2))
        ));
      });
    });

    edges.forEach(function(edge) {
      var a = positions[edge.from];
      var b = positions[edge.to];
      if (!a || !b) return;

      var parallelCurve = parallelCurves.get(edge.id);
      if (parallelCurve) {
        updates.push({ id: edge.id, smooth: parallelCurve });
        return;
      }

      var blocked = null;
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (id === edge.from || id === edge.to) continue;
        if (segmentHitsBox(a.x, a.y, b.x, b.y, boxes[id])) {
          blocked = boxes[id];
          break;
        }
      }

      if (!blocked) {
        updates.push({ id: edge.id, smooth: lanes[edge.id] || false });
        return;
      }

      // Sign of the cross product says which side of a->b the obstacle sits on;
      // bend the other way so the edge curves around it.
      var cx = (blocked.left + blocked.right) / 2;
      var cy = (blocked.top + blocked.bottom) / 2;
      var side = (b.x - a.x) * (cy - a.y) - (b.y - a.y) * (cx - a.x);
      // The obstacle picks the side (clearance beats lane spacing), but a
      // parallel edge still adds its lane roundness to stay off its twin.
      var lane = lanes[edge.id];
      updates.push({
        id: edge.id,
        smooth: curve(
          side > 0 ? "curvedCW" : "curvedCCW",
          BEND_ROUNDNESS
        )
      });
    });

    network.body.data.edges.update(updates);
  }

  network.once("stabilizationIterationsDone", rerouteEdges);
  network.on("dragEnd", rerouteEdges);
  setTimeout(rerouteEdges, 2500);

  network.on("dragEnd", endChange);

  document.addEventListener("keydown", function(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      undo();
    }
  });

  canvas.addEventListener("mousedown", function(e) {
    var pos = getPos(e);
    if (network.getNodeAt(pos) !== undefined) {
      // Snapshot before the drag moves anything, so Ctrl+Z can step back.
      beginChange();
      return;
    }
    if (e.shiftKey) {
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
        if (
          domPos.x >= x1 && domPos.x <= x2 && domPos.y >= y1 && domPos.y <= y2
        ) {
          selected.push(id);
        }
      }
      network.selectNodes(selected);
    }
    endChange();
  });
})();
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

def order_importance_tiers(tiers):
    """Return ordered importance tiers and their assigned colors."""
    unique = {}
    for tier in tiers:
        if tier:
            label = tier.strip()
            if label:
                unique.setdefault(label.lower(), label)

    first_seen = {key: index for index, key in enumerate(unique)}

    def sort_key(tier):
        key = tier.lower()
        if key in IMPORTANCE_RANK:
            return 0, IMPORTANCE_RANK[key]
        return 1, first_seen[key]

    ordered = sorted(unique.values(), key=sort_key)
    last_color = len(IMPORTANCE_PALETTE) - 1
    tier_colors = {}
    for index, tier in enumerate(ordered):
        color_index = (
            0
            if len(ordered) <= 1
            else round(index * last_color / (len(ordered) - 1))
        )
        tier_colors[tier.lower()] = IMPORTANCE_PALETTE[color_index][1]
    return ordered, tier_colors


def entity_color(importance, tier_colors):
    """Return a readable entity color for its importance tier."""
    if not importance:
        return ENTITY_DEFAULT_COLOR
    return tier_colors.get(importance.strip().lower(), ENTITY_DEFAULT_COLOR)


def fallback_node_color(type_name):
    """Deterministic light background for an unknown node type."""
    idx = zlib.crc32(type_name.encode("utf-8")) % len(NODE_FALLBACK_PALETTE)
    return NODE_FALLBACK_PALETTE[idx][1]


def fallback_edge_color(type_name):
    """Deterministic saturated color for an unknown edge type."""
    idx = zlib.crc32(type_name.encode("utf-8")) % len(EDGE_FALLBACK_PALETTE)
    return EDGE_FALLBACK_PALETTE[idx]


def node_style(node_type, fields, tier_colors):
    if node_type == "Entity":
        return {
            "shape": ENTITY_SHAPE,
            "color": entity_color(fields.get("Importance"), tier_colors),
        }
    preset = NODE_STYLE_PRESETS.get(node_type)
    if preset is not None:
        return preset.copy()
    return {"shape": UNKNOWN_NODE_SHAPE, "color": fallback_node_color(node_type)}


def edge_style(edge_type):
    preset = EDGE_STYLE_PRESETS.get(edge_type)
    if preset is not None:
        return preset.copy()
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


# Keep edge tooltips and the interactive node detail box readable.
TOOLTIP_CSS = """
<style type="text/css">
  div.vis-tooltip {
    max-width: min(420px, calc(100vw - 16px)) !important;
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
  }
  div.architecture-node-tooltip {
    position: absolute;
    display: none;
    z-index: 2000;
    box-sizing: border-box;
    max-width: min(420px, calc(100% - 16px));
    max-height: min(50vh, calc(100% - 16px));
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.98);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    color: #222;
    font: 12px/1.5 sans-serif;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    cursor: text;
  }
</style>
"""

NODE_TOOLTIP_JS = """
<script type="text/javascript">
(function () {
  var NODE_DESCRIPTIONS = __NODE_DESCRIPTIONS__;
  var container = document.getElementById("mynetwork");
  if (!container) return;

  var tooltip = document.createElement("div");
  tooltip.className = "architecture-node-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  container.appendChild(tooltip);

  var activeNode = null;
  var nodeHovered = false;
  var tooltipHovered = false;
  var hideTimer = null;
  var HIDE_DELAY = 300;

  function clearHideTimer() {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hideIfOutside() {
    hideTimer = null;
    if (nodeHovered || tooltipHovered) return;
    tooltip.style.display = "none";
    tooltip.setAttribute("aria-hidden", "true");
    activeNode = null;
  }

  function scheduleHide() {
    if (hideTimer === null) {
      hideTimer = setTimeout(hideIfOutside, HIDE_DELAY);
    }
  }

  function pointerPosition(event) {
    var rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function isOverActiveNode(event) {
    return activeNode !== null
      && !tooltip.contains(event.target)
      && network.getNodeAt(pointerPosition(event)) === activeNode;
  }

  function positionTooltip(nodeId) {
    var bounds = network.getBoundingBox(nodeId);
    var topLeft = network.canvasToDOM({ x: bounds.left, y: bounds.top });
    var bottomRight = network.canvasToDOM({ x: bounds.right, y: bounds.bottom });
    var padding = 8;
    var gap = 12;
    var width = tooltip.offsetWidth;
    var height = tooltip.offsetHeight;
    var left = bottomRight.x + gap;
    var top = topLeft.y;

    if (left + width > container.clientWidth - padding) {
      left = topLeft.x - width - gap;
    }
    left = Math.max(
      padding,
      Math.min(left, container.clientWidth - width - padding)
    );
    top = Math.max(
      padding,
      Math.min(top, container.clientHeight - height - padding)
    );
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }

  function hideTooltip() {
    clearHideTimer();
    tooltip.style.display = "none";
    tooltip.setAttribute("aria-hidden", "true");
    activeNode = null;
    nodeHovered = false;
    tooltipHovered = false;
  }

  function showTooltip(nodeId) {
    var description = NODE_DESCRIPTIONS[String(nodeId)];
    if (description === undefined) return;
    clearHideTimer();
    activeNode = nodeId;
    nodeHovered = true;
    tooltip.textContent = description;
    tooltip.style.display = "block";
    tooltip.setAttribute("aria-hidden", "false");
    positionTooltip(nodeId);
  }

  network.on("hoverNode", function (params) {
    showTooltip(params.node);
  });
  network.on("blurNode", function (params) {
    if (params.node === activeNode) nodeHovered = false;
    scheduleHide();
  });

  tooltip.addEventListener("mouseenter", function () {
    tooltipHovered = true;
    clearHideTimer();
  });
  tooltip.addEventListener("mouseleave", function (event) {
    tooltipHovered = false;
    nodeHovered = isOverActiveNode(event);
    if (nodeHovered) clearHideTimer();
    else scheduleHide();
  });
  container.addEventListener("mousemove", function (event) {
    if (activeNode === null || tooltip.contains(event.target)) return;
    nodeHovered = isOverActiveNode(event);
    if (nodeHovered) clearHideTimer();
    else scheduleHide();
  });
  container.addEventListener("mouseleave", function () {
    nodeHovered = false;
    scheduleHide();
  });

  network.on("dragStart", hideTooltip);
  network.on("zoom", function () {
    if (activeNode !== null) positionTooltip(activeNode);
  });
  network.on("stabilizationIterationsDone", function () {
    if (activeNode !== null) positionTooltip(activeNode);
  });
  window.addEventListener("resize", function () {
    if (activeNode !== null) positionTooltip(activeNode);
  });
})();
</script>
"""

DATATYPE_REFERENCE_JS = """
<script type="text/javascript">
(function () {
  var DATATYPE_NODE_COLORS = __DATATYPE_NODE_COLORS__;
  var HIGHLIGHT_BACKGROUND = "__HIGHLIGHT_BACKGROUND__";
  var HIGHLIGHT_BORDER = "__HIGHLIGHT_BORDER__";
  var HIGHLIGHT_BORDER_WIDTH = __HIGHLIGHT_BORDER_WIDTH__;
  var hoveredEdge = null;
  var activeHighlights = Object.create(null);

  function addEdgeReferences(active, edgeId) {
    var edge = network.body.data.edges.get(edgeId);
    if (!edge || !Array.isArray(edge.dataTypeRefs)) return;
    edge.dataTypeRefs.forEach(function (nodeId) {
      active[String(nodeId)] = true;
    });
  }

  function updateHighlights() {
    var active = Object.create(null);
    var selectedEdges = network.getSelectedEdges
      ? network.getSelectedEdges()
      : [];
    selectedEdges.forEach(function (edgeId) {
      addEdgeReferences(active, edgeId);
    });
    if (hoveredEdge !== null) addEdgeReferences(active, hoveredEdge);

    Object.keys(DATATYPE_NODE_COLORS).forEach(function (nodeId) {
      var shouldHighlight = !!active[nodeId];
      if (shouldHighlight === !!activeHighlights[nodeId]) return;
      network.body.data.nodes.update({
        id: nodeId,
        color: shouldHighlight
          ? { background: HIGHLIGHT_BACKGROUND, border: HIGHLIGHT_BORDER }
          : DATATYPE_NODE_COLORS[nodeId],
        borderWidth: shouldHighlight ? HIGHLIGHT_BORDER_WIDTH : 1
      });
      activeHighlights[nodeId] = shouldHighlight;
    });
  }

  network.on("hoverEdge", function (params) {
    hoveredEdge = params.edge;
    updateHighlights();
  });
  network.on("blurEdge", function (params) {
    if (hoveredEdge === params.edge) hoveredEdge = null;
    updateHighlights();
  });
  ["selectEdge", "deselectEdge", "selectNode", "deselectNode"].forEach(
    function (eventName) {
      network.on(eventName, updateHighlights);
    }
  );
})();
</script>
"""


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_graph(entities, datatypes, relationships, tier_colors):
    net = Network(directed=True, height="750px", width="100%")
    node_types = {}
    edge_types = {}
    known_nodes = set()
    descriptions = {}

    def add_node(name, node_type, fields):
        style = node_style(node_type, fields, tier_colors)
        known_nodes.add(name)
        node_types[node_type] = style
        descriptions[name] = node_title(name, node_type, fields)
        net.add_node(
            name,
            label=name,
            shape=style["shape"],
            color=style["color"],
        )
        return style

    def ensure_node(name):
        """Resolve qualified references or add a generic unknown node."""
        if name in known_nodes:
            return name
        base = re.sub(r"\s*\([^)]*\)\s*$", "", name).strip()
        if base and base in known_nodes:
            return base
        add_node(name, "Unknown", {})
        return name

    def add_edge(
        source, target, edge_type, fields=None, bidirectional=False, label=None,
        datatype_refs=None
    ):
        style = edge_style(edge_type)
        edge_types[edge_type] = style
        options = {
            "color": style["color"],
            "dashes": style["dashes"],
            "arrows": "to,from" if bidirectional else "to",
            "title": edge_title(source, target, edge_type, fields or {}),
        }
        if label:
            options["label"] = label
        if datatype_refs:
            options["dataTypeRefs"] = datatype_refs
        net.add_edge(source, target, **options)

    for e in entities:
        add_node(e["name"], e["type"], e["fields"])

    for e in entities:
        if e["parent"]:
            add_edge(e["parent"], e["name"], "Contains")

    datatype_node_colors = {}
    for d in datatypes:
        style = add_node(d["name"], d["type"], d["fields"])
        if d["type"] == "DataType":
            datatype_node_colors[d["name"]] = style["color"]

    for d in datatypes:
        for entry in d["composed_of"]:
            for c in entry.split(","):
                c = c.strip()
                if not c:
                    continue
                add_edge(d["name"], ensure_node(c), "Composed of")

    for r in relationships:
        source = ensure_node(r["source"])
        target = ensure_node(r["target"])
        datatype_refs = []
        if r["type"] == "Interact":
            datatype_value = r["fields"].get("DataType", "").strip()
            if datatype_value in datatype_node_colors:
                datatype_refs.append(datatype_value)
        add_edge(
            source,
            target,
            r["type"],
            fields=r["fields"],
            bidirectional=r.get("bidirectional", False),
            label=r["fields"].get("DataType"),
            datatype_refs=datatype_refs,
        )

    return net, node_types, edge_types, descriptions, datatype_node_colors


def build_legend(node_types, edge_types, entity_tiers, tier_colors):
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
                "{}={}".format(
                    tier, color_label(entity_color(tier, tier_colors))
                )
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
    parts.append(
        (
            '<b>Reference highlight</b><br>'
            '<span style="display:inline-block;width:10px;height:10px;'
            'background:{background};border:{border_width}px solid {border};'
            'vertical-align:middle;"></span> '
            'DataType node highlighted on Interact edge hover/selection<br>'
        ).format(
            background=DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND,
            border=DATATYPE_REFERENCE_HIGHLIGHT_BORDER,
            border_width=DATATYPE_REFERENCE_HIGHLIGHT_BORDER_WIDTH,
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

    entity_tiers, tier_colors = order_importance_tiers(
        e["fields"].get("Importance") for e in entities
    )
    net, node_types, edge_types, descriptions, datatype_node_colors = build_graph(
        entities, datatypes, relationships, tier_colors
    )
    net.set_options(json.dumps(OPTIONS))
    net.write_html(output_path, open_browser=False)

    with open(output_path, "r", encoding="utf-8") as f:
        html = f.read()
    legend = build_legend(node_types, edge_types, entity_tiers, tier_colors)
    # Prevent map content from closing the injected script element.
    descriptions_json = json.dumps(descriptions).replace("<", r"\u003c")
    node_tooltip = NODE_TOOLTIP_JS.replace(
        "__NODE_DESCRIPTIONS__", descriptions_json
    )
    datatype_colors_json = json.dumps(datatype_node_colors).replace(
        "<", r"\u003c"
    )
    datatype_reference = (
        DATATYPE_REFERENCE_JS.replace(
            "__DATATYPE_NODE_COLORS__", datatype_colors_json
        )
        .replace("__HIGHLIGHT_BACKGROUND__", DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND)
        .replace("__HIGHLIGHT_BORDER__", DATATYPE_REFERENCE_HIGHLIGHT_BORDER)
        .replace(
            "__HIGHLIGHT_BORDER_WIDTH__",
            str(DATATYPE_REFERENCE_HIGHLIGHT_BORDER_WIDTH),
        )
    )
    additions = [
        legend,
        TOOLTIP_CSS,
        PHYSICS_DISABLE_JS,
        INTERACTION_JS,
        node_tooltip,
        datatype_reference,
        "</body>",
    ]
    html = html.replace("</body>", "\n".join(additions))
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(
        "Wrote {} ({} entities, {} datatypes, {} edges)".format(
            output_path, len(entities), len(datatypes), len(relationships)
        )
    )


if __name__ == "__main__":
    main()
