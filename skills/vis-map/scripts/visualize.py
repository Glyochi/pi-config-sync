#!/usr/bin/env python3
"""Render map/MAP.md as an interactive directed graph using Pyvis.

Reads the markdown produced by the `map` skill and writes a self-contained
HTML graph with Pyvis resources inlined. A neighboring layout sidecar preserves
node positions across HTML regeneration without changing `map/MAP.md`.
The format is self-describing via
`- **Type**: X` tags, so this script renders any
node/edge type generically: known types get their fixed styling, unknown types
get a deterministic fallback. Interact-edge DataType labels that exactly
match existing DataType nodes highlight those nodes when the edge is hovered or
selected; hovering a DataType node also highlights its associated edges.
Unmatched labels remain plain strings. DataType nodes are seeded on the right
and all other nodes on the left before force-directed clustering; after
stabilization, dragging an owner header moves its subtree while other nodes
remain independently draggable.
Nested heading containment is drawn as a live owner frame; hidden `Contains`
edges remain physics springs for layout. All styling is hardcoded below so the
output is identical regardless of which model invokes this script.

Usage:
    python3 visualize.py [map/MAP.md] [map/map-graph.html]
"""

import json
import math
import os
import re
import sys
import zlib
from html import escape as html_escape

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

# Seed starting sides before force-directed clustering; do not lock nodes there.
OTHER_NODE_COLUMN_X = -450
DATATYPE_COLUMN_X = 450
COLUMN_VERTICAL_SPACING = 120
LAYOUT_VERSION = 1

DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND = "#FFE08A"
DATATYPE_REFERENCE_HIGHLIGHT_BORDER = "#E67700"
DATATYPE_REFERENCE_HIGHLIGHT_BORDER_WIDTH = 4
DATATYPE_REFERENCE_HIGHLIGHT_EDGE_WIDTH = 4

# Container frames are derived from live node bounds and never persisted.
CONTAINMENT_FRAME_PADDING = 24
CONTAINMENT_FRAME_HEADER_GAP = 12
CONTAINMENT_FRAME_FILL_ALPHA = 0.055
CONTAINMENT_FRAME_STROKE_WIDTH = 1.5
CONTAINMENT_FRAME_BORDER_COLOR = "#777777"
CONTAINMENT_FRAME_HEADER_BORDER_COLOR = "#444444"

# Unknown edge types keep saturated colors so the lines stay visible on white.
EDGE_FALLBACK_PALETTE = [
    "purple", "teal", "brown", "pink", "olive",
    "cyan", "magenta", "lime", "navy", "maroon",
]

# Known visible edge types use (color, dash pattern). Contains remains a hidden
# physics edge; its visible style is the dynamically drawn owner frame.
CONTAINS_COLOR = CONTAINMENT_FRAME_BORDER_COLOR
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
COLOR_NAMES = {
    "#2B7CE9": "blue",
    "#A020F0": "purple",
    DATATYPE_COLOR: "light blue",
    DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND: "pale yellow",
    DATATYPE_REFERENCE_HIGHLIGHT_BORDER: "orange",
}
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

# Ownership is shown as live frames around a container and all its descendants.
# Owner nodes remain graph anchors and are aligned to the frame's top-border
# title after layout; dragging one translates its descendant subtree.
CONTAINMENT_FRAME_JS = """
<script type="text/javascript">
(function () {
  var FRAMES = __CONTAINMENT_FRAMES__;
  var FRAME_PADDING = __FRAME_PADDING__;
  var FRAME_HEADER_GAP = __FRAME_HEADER_GAP__;
  var FRAME_FILL_ALPHA = __FRAME_FILL_ALPHA__;
  var FRAME_STROKE_WIDTH = __FRAME_STROKE_WIDTH__;
  var FRAME_BORDER_COLOR = "__FRAME_BORDER_COLOR__";
  var FRAME_HEADER_BORDER_COLOR = "__FRAME_HEADER_BORDER_COLOR__";
  var HIGHLIGHT_BACKGROUND = "__HIGHLIGHT_BACKGROUND__";
  var HIGHLIGHT_BORDER = "__HIGHLIGHT_BORDER__";
  var HIGHLIGHT_BORDER_WIDTH = __HIGHLIGHT_BORDER_WIDTH__;
  var hoveredNode = null;
  var syncingOwners = false;
  var syncScheduled = false;
  var ownerGroupDrag = null;
  var FRAME_BY_OWNER = Object.create(null);
  FRAMES.forEach(function (frame) {
    FRAME_BY_OWNER[String(frame.owner)] = frame;
  });
  window.mapContainmentLegendHighlight = false;

  function rgba(color, alpha) {
    var match = /^#([0-9a-f]{6})$/i.exec(String(color || ""));
    if (!match) return color || "#E3E2DE";
    var value = parseInt(match[1], 16);
    return "rgba(" + ((value >> 16) & 255) + ","
      + ((value >> 8) & 255) + "," + (value & 255) + "," + alpha + ")";
  }

  function drawRoundedRect(ctx, bounds, radius) {
    var left = bounds.left;
    var top = bounds.top;
    var right = bounds.right;
    var bottom = bounds.bottom;
    var r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.lineTo(right - r, top);
    ctx.quadraticCurveTo(right, top, right, top + r);
    ctx.lineTo(right, bottom - r);
    ctx.quadraticCurveTo(right, bottom, right - r, bottom);
    ctx.lineTo(left + r, bottom);
    ctx.quadraticCurveTo(left, bottom, left, bottom - r);
    ctx.lineTo(left, top + r);
    ctx.quadraticCurveTo(left, top, left + r, top);
    ctx.closePath();
  }

  function nodeBounds(nodeId) {
    try {
      var bounds = network.getBoundingBox(nodeId);
      if (
        !bounds
        || !Number.isFinite(bounds.left)
        || !Number.isFinite(bounds.top)
        || !Number.isFinite(bounds.right)
        || !Number.isFinite(bounds.bottom)
      ) return null;
      return bounds;
    } catch (error) {
      return null;
    }
  }

  function mergeBounds(bounds, next) {
    if (!next) return bounds;
    if (!bounds) {
      return {
        left: next.left,
        top: next.top,
        right: next.right,
        bottom: next.bottom
      };
    }
    bounds.left = Math.min(bounds.left, next.left);
    bounds.top = Math.min(bounds.top, next.top);
    bounds.right = Math.max(bounds.right, next.right);
    bounds.bottom = Math.max(bounds.bottom, next.bottom);
    return bounds;
  }

  function contentBounds(frame, scale, memo) {
    var bounds = null;
    frame.children.forEach(function (childId) {
      var childFrame = FRAME_BY_OWNER[String(childId)];
      var childGeometry = childFrame
        ? frameGeometry(childFrame, scale, memo)
        : null;
      var childBounds = childFrame
        ? (childGeometry ? childGeometry.visual : null)
        : nodeBounds(childId);
      bounds = mergeBounds(bounds, childBounds);
    });
    return bounds;
  }

  function frameGeometry(frame, scale, memo) {
    var key = String(frame.owner);
    if (memo[key]) return memo[key];

    var owner = network.body.data.nodes.get(frame.owner);
    var header = nodeBounds(frame.owner);
    var content = contentBounds(frame, scale, memo);
    if (!owner || !header || !content) return null;

    var padding = FRAME_PADDING / scale;
    var border;
    if (owner.mapFrameReady) {
      border = {
        left: Math.min(content.left - padding, header.left),
        top: (header.top + header.bottom) / 2,
        right: Math.max(content.right + padding, header.right),
        bottom: Math.max(content.bottom + padding, header.bottom)
      };
    } else {
      border = {
        left: Math.min(content.left, header.left) - padding,
        top: Math.min(content.top, header.top) - padding,
        right: Math.max(content.right, header.right) + padding,
        bottom: Math.max(content.bottom, header.bottom) + padding
      };
    }
    var visual = {
      left: Math.min(border.left, header.left),
      top: Math.min(border.top, header.top),
      right: Math.max(border.right, header.right),
      bottom: Math.max(border.bottom, header.bottom)
    };
    memo[key] = {
      owner: owner,
      header: header,
      border: border,
      visual: visual
    };
    return memo[key];
  }

  function syncOwnerAnchors() {
    if (syncingOwners || !FRAMES.length) return;
    syncingOwners = true;
    try {
      var scale = network.getScale();
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;

      // Inner frames are positioned first; parent frames then use their full
      // bounds, including the child frame's title and padding.
      for (var i = FRAMES.length - 1; i >= 0; i--) {
        var frame = FRAMES[i];
        var content = contentBounds(frame, scale, Object.create(null));
        var owner = network.body.data.nodes.get(frame.owner);
        var header = nodeBounds(frame.owner);
        if (!content || !owner || !header) continue;

        var headerHeight = Math.max(header.bottom - header.top, 18 / scale);
        var x = (content.left + content.right) / 2;
        var y = content.top - headerHeight / 2 - FRAME_HEADER_GAP / scale;
        var current = network.getPositions()[String(frame.owner)];
        var moved = !current
          || Math.abs(current.x - x) > 0.25 / scale
          || Math.abs(current.y - y) > 0.25 / scale;
        var stateChanged = !owner.mapFrameReady
          || owner.fixed !== false
          || owner.physics !== false;

        if (moved) network.moveNode(frame.owner, x, y);
        if (stateChanged) {
          network.body.data.nodes.update({
            id: frame.owner,
            fixed: false,
            physics: false,
            mapFrameReady: true
          });
        }
        if (moved || stateChanged) network.redraw();
      }
    } finally {
      syncingOwners = false;
    }
    network.redraw();
  }

  function scheduleOwnerSync(params) {
    if (
      ownerGroupDrag
      || syncScheduled
      || (params && Array.isArray(params.nodes) && params.nodes.length > 1)
    ) return;
    syncScheduled = true;
    window.requestAnimationFrame(function () {
      syncScheduled = false;
      syncOwnerAnchors();
    });
  }

  function beginOwnerGroupDrag(params) {
    ownerGroupDrag = null;
    if (!params || !Array.isArray(params.nodes) || params.nodes.length !== 1) {
      return;
    }
    var ownerId = String(params.nodes[0]);
    var frame = FRAME_BY_OWNER[ownerId];
    var position = network.getPositions()[ownerId];
    if (!frame || !position) return;
    var pointer = params.pointer && params.pointer.canvas;
    ownerGroupDrag = {
      owner: ownerId,
      members: frame.members.slice(),
      lastOwner: { x: position.x, y: position.y },
      lastPointer: pointer ? { x: pointer.x, y: pointer.y } : null
    };
  }

  function translateOwnerGroup(params) {
    if (!ownerGroupDrag) return;
    if (params && Array.isArray(params.nodes)) {
      if (
        params.nodes.length > 1
        || (params.nodes.length === 1
          && String(params.nodes[0]) !== ownerGroupDrag.owner)
      ) {
        ownerGroupDrag = null;
        return;
      }
    }

    var positions = network.getPositions();
    var currentOwner = positions[ownerGroupDrag.owner];
    if (!currentOwner) return;
    // vis-network emits `dragging` before it moves the owner anchor, so prefer
    // the canvas-pointer delta and use actual positions as the dragEnd fallback.
    var pointer = params && params.pointer && params.pointer.canvas;
    var dx;
    var dy;
    if (pointer && ownerGroupDrag.lastPointer) {
      dx = pointer.x - ownerGroupDrag.lastPointer.x;
      dy = pointer.y - ownerGroupDrag.lastPointer.y;
      ownerGroupDrag.lastPointer = { x: pointer.x, y: pointer.y };
    } else {
      dx = currentOwner.x - ownerGroupDrag.lastOwner.x;
      dy = currentOwner.y - ownerGroupDrag.lastOwner.y;
    }
    if (dx === 0 && dy === 0) return;

    ownerGroupDrag.members.forEach(function (nodeId) {
      var key = String(nodeId);
      if (key === ownerGroupDrag.owner) return;
      var position = positions[key];
      if (position) network.moveNode(key, position.x + dx, position.y + dy);
    });
    ownerGroupDrag.lastOwner = {
      x: currentOwner.x + dx,
      y: currentOwner.y + dy
    };
  }

  function finishOwnerGroupDrag() {
    if (ownerGroupDrag) {
      // At dragEnd use the actual owner position, since vis-network has already
      // applied the last pointer movement before emitting this event.
      translateOwnerGroup({ nodes: [ownerGroupDrag.owner] });
    }
    ownerGroupDrag = null;
    syncOwnerAnchors();
  }

  function drawFrames(ctx) {
    if (!ctx || !FRAMES.length) return;
    var scale = network.getScale();
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;

    var selected = Object.create(null);
    (network.getSelectedNodes ? network.getSelectedNodes() : []).forEach(
      function (nodeId) { selected[String(nodeId)] = true; }
    );

    var memo = Object.create(null);
    var drawn = [];
    FRAMES.forEach(function (frame) {
      var geometry = frameGeometry(frame, scale, memo);
      if (!geometry) return;
      var ownerId = String(frame.owner);
      var active = !!window.mapContainmentLegendHighlight
        || !!geometry.owner.mapFrameHighlighted
        || !!selected[ownerId]
        || ownerId === hoveredNode;
      drawn.push({
        frame: frame,
        owner: geometry.owner,
        geometry: geometry,
        active: active
      });
    });

    // Frames are ordered outermost first; each parent pads around its child
    // frame bounds, leaving a clear gap between nested ownership regions.
    drawn.forEach(function (item) {
      ctx.save();
      drawRoundedRect(ctx, item.geometry.border, 8 / scale);
      ctx.fillStyle = item.active
        ? rgba(HIGHLIGHT_BACKGROUND, 0.12)
        : rgba(item.owner.mapBaseColor, FRAME_FILL_ALPHA);
      ctx.fill();
      ctx.strokeStyle = item.active ? HIGHLIGHT_BORDER : FRAME_BORDER_COLOR;
      ctx.lineWidth = (item.active
        ? HIGHLIGHT_BORDER_WIDTH
        : FRAME_STROKE_WIDTH) / scale;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    });

    // The owner header is centered on the frame's top border. Its opaque fill
    // interrupts the line, producing a clear `-- [owner] --` label treatment.
    drawn.forEach(function (item) {
      var header = item.geometry.header;
      var owner = item.owner;
      var label = String(owner.label || item.frame.owner);
      ctx.save();
      drawRoundedRect(ctx, header, 3 / scale);
      ctx.fillStyle = item.active ? HIGHLIGHT_BACKGROUND : owner.mapBaseColor;
      ctx.strokeStyle = item.active
        ? HIGHLIGHT_BORDER
        : FRAME_HEADER_BORDER_COLOR;
      ctx.lineWidth = (item.active ? 2 : 1) / scale;
      ctx.fill();
      ctx.stroke();
      ctx.font = "14px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#222222";
      ctx.fillText(
        label,
        (header.left + header.right) / 2,
        (header.top + header.bottom) / 2
      );
      ctx.restore();
    });
  }

  window.mapSyncContainmentOwners = syncOwnerAnchors;
  network.once("stabilizationIterationsDone", syncOwnerAnchors);
  setTimeout(syncOwnerAnchors, 5200);
  network.on("dragStart", beginOwnerGroupDrag);
  network.on("dragging", translateOwnerGroup);
  network.on("dragging", scheduleOwnerSync);
  network.on("dragEnd", finishOwnerGroupDrag);
  network.on("beforeDrawing", drawFrames);
  network.on("hoverNode", function (params) {
    hoveredNode = String(params.node);
    network.redraw();
  });
  network.on("blurNode", function (params) {
    if (hoveredNode === String(params.node)) {
      hoveredNode = null;
      network.redraw();
    }
  });
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
    if (window.mapSyncContainmentOwners) {
      window.mapSyncContainmentOwners();
    }
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
  div.map-node-tooltip {
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
  tooltip.className = "map-node-tooltip";
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
  var HIGHLIGHT_EDGE_WIDTH = __HIGHLIGHT_EDGE_WIDTH__;
  var hoveredEdge = null;
  var hoveredDataType = null;
  var hoveredLegendRow = null;
  var focusedLegendRow = null;
  var activeLegendRow = null;
  var activeNodeHighlights = Object.create(null);
  var activeEdgeHighlights = Object.create(null);
  var originalEdgeStyles = Object.create(null);

  function isDataTypeNode(nodeId) {
    return Object.prototype.hasOwnProperty.call(
      DATATYPE_NODE_COLORS, String(nodeId)
    );
  }

  function addEdgeReferences(active, edgeId) {
    var edge = network.body.data.edges.get(edgeId);
    if (!edge || !Array.isArray(edge.dataTypeRefs)) return;
    edge.dataTypeRefs.forEach(function (nodeId) {
      active[String(nodeId)] = true;
    });
  }

  function addDataTypeEdges(active, nodeId) {
    var key = String(nodeId);
    network.body.data.edges.get().forEach(function (edge) {
      var referencesNode = Array.isArray(edge.dataTypeRefs)
        && edge.dataTypeRefs.some(function (reference) {
          return String(reference) === key;
        });
      var touchesNode = String(edge.from) === key || String(edge.to) === key;
      if (referencesNode || touchesNode) active[String(edge.id)] = true;
    });
  }

  function addLegendTargets(activeNodes, activeDataTypes, activeEdges) {
    if (!activeLegendRow) return;
    var kind = activeLegendRow.getAttribute("data-legend-kind");
    var value = activeLegendRow.getAttribute("data-legend-value");

    if (kind === "edge-type") {
      if (value === "Contains") {
        window.mapContainmentLegendHighlight = true;
        return;
      }
      network.body.data.edges.get().forEach(function (edge) {
        if (String(edge.mapType) === value) {
          activeEdges[String(edge.id)] = true;
        }
      });
      return;
    }
    if (kind === "references") {
      window.mapContainmentLegendHighlight = true;
      Object.keys(DATATYPE_NODE_COLORS).forEach(function (nodeId) {
        activeDataTypes[nodeId] = true;
      });
      return;
    }

    network.body.data.nodes.get().forEach(function (node) {
      var matches = false;
      if (kind === "node-type") {
        matches = String(node.mapType) === value;
      } else if (kind === "importance") {
        matches = node.mapType === "Entity"
          && String(node.mapImportance) === value;
      } else if (kind === "unrated-entity") {
        matches = node.mapType === "Entity"
          && !node.mapImportance;
      }
      if (!matches) return;
      var nodeId = String(node.id);
      activeNodes[nodeId] = true;
      if (isDataTypeNode(nodeId)) activeDataTypes[nodeId] = true;
    });
  }

  function updateEdgeHighlights(active) {
    network.body.data.edges.get().forEach(function (edge) {
      var edgeId = String(edge.id);
      var shouldHighlight = !!active[edgeId];
      if (shouldHighlight === !!activeEdgeHighlights[edgeId]) return;

      var update = { id: edge.id };
      if (shouldHighlight) {
        originalEdgeStyles[edgeId] = {
          color: edge.color,
          width: edge.width
        };
        update.color = HIGHLIGHT_BORDER;
        update.width = HIGHLIGHT_EDGE_WIDTH;
      } else {
        var original = originalEdgeStyles[edgeId] || {};
        update.color = original.color;
        update.width = original.width === undefined ? 1 : original.width;
        delete originalEdgeStyles[edgeId];
      }
      network.body.data.edges.update(update);
      activeEdgeHighlights[edgeId] = shouldHighlight;
    });
  }

  function updateHighlights() {
    window.mapContainmentLegendHighlight = false;
    var activeNodes = Object.create(null);
    var activeDataTypes = Object.create(null);
    var activeEdges = Object.create(null);
    var selectedEdges = network.getSelectedEdges
      ? network.getSelectedEdges()
      : [];
    var selectedNodes = network.getSelectedNodes
      ? network.getSelectedNodes()
      : [];

    selectedEdges.forEach(function (edgeId) {
      addEdgeReferences(activeNodes, edgeId);
    });
    if (hoveredEdge !== null) addEdgeReferences(activeNodes, hoveredEdge);

    selectedNodes.forEach(function (nodeId) {
      if (isDataTypeNode(nodeId)) activeDataTypes[String(nodeId)] = true;
    });
    if (hoveredDataType !== null) {
      activeDataTypes[String(hoveredDataType)] = true;
    }
    addLegendTargets(activeNodes, activeDataTypes, activeEdges);

    Object.keys(activeDataTypes).forEach(function (nodeId) {
      activeNodes[nodeId] = true;
      addDataTypeEdges(activeEdges, nodeId);
    });

    network.body.data.nodes.get().forEach(function (node) {
      var nodeId = String(node.id);
      var shouldHighlight = !!activeNodes[nodeId];
      if (shouldHighlight === !!activeNodeHighlights[nodeId]) return;
      var update = { id: node.id };
      if (node.mapContainer) {
        var transparent = "rgba(0,0,0,0)";
        update.color = {
          background: transparent,
          border: transparent,
          highlight: { background: transparent, border: transparent },
          hover: { background: transparent, border: transparent }
        };
        update.borderWidth = 0;
        update.borderWidthSelected = 0;
        update.mapFrameHighlighted = shouldHighlight;
      } else {
        update.color = shouldHighlight
          ? { background: HIGHLIGHT_BACKGROUND, border: HIGHLIGHT_BORDER }
          : node.mapBaseColor;
        update.borderWidth = shouldHighlight ? HIGHLIGHT_BORDER_WIDTH : 1;
      }
      network.body.data.nodes.update(update);
      activeNodeHighlights[nodeId] = shouldHighlight;
    });
    updateEdgeHighlights(activeEdges);
    network.redraw();
  }

  network.on("hoverNode", function (params) {
    hoveredDataType = isDataTypeNode(params.node) ? params.node : null;
    updateHighlights();
  });
  network.on("blurNode", function (params) {
    if (String(hoveredDataType) === String(params.node)) hoveredDataType = null;
    updateHighlights();
  });
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

  var legend = document.querySelector(".map-legend");
  if (legend) {
    function legendRowFromEvent(event) {
      if (!event.target || !event.target.closest) return null;
      var row = event.target.closest("[data-legend-kind]");
      return row && legend.contains(row) ? row : null;
    }

    function refreshLegendTarget() {
      var next = hoveredLegendRow || focusedLegendRow;
      if (next === activeLegendRow) return;
      if (activeLegendRow) activeLegendRow.style.backgroundColor = "";
      activeLegendRow = next;
      if (activeLegendRow) {
        activeLegendRow.style.backgroundColor = "rgba(230,119,0,0.12)";
      }
      updateHighlights();
    }

    legend.addEventListener("mouseover", function (event) {
      var row = legendRowFromEvent(event);
      if (row) {
        hoveredLegendRow = row;
        refreshLegendTarget();
      }
    });
    legend.addEventListener("mouseout", function (event) {
      var row = legendRowFromEvent(event);
      if (row && row === hoveredLegendRow && !row.contains(event.relatedTarget)) {
        hoveredLegendRow = null;
        refreshLegendTarget();
      }
    });
    legend.addEventListener("focusin", function (event) {
      focusedLegendRow = legendRowFromEvent(event);
      refreshLegendTarget();
    });
    legend.addEventListener("focusout", function (event) {
      var row = legendRowFromEvent(event);
      if (row && row === focusedLegendRow && !row.contains(event.relatedTarget)) {
        focusedLegendRow = null;
        refreshLegendTarget();
      }
    });
  }
})();
</script>
"""

LAYOUT_SAVE_UI = (
    '<div style="position:fixed;top:10px;right:10px;z-index:1100;'
    'max-width:320px;padding:8px;background:rgba(255,255,255,0.95);'
    'border:1px solid #ccc;font:12px/1.4 sans-serif;">'
    '<button id="save-layout-button" type="button">Save layout</button>'
    '<div id="layout-save-status" aria-live="polite"></div>'
    '</div>'
)

LAYOUT_SAVE_JS = """
<script type="text/javascript">
(function () {
  var FILENAME = __LAYOUT_FILENAME__;
  var VERSION = __LAYOUT_VERSION__;
  var button = document.getElementById("save-layout-button");
  if (!button) return;

  button.addEventListener("click", function () {
    var positions = network.getPositions();
    var nodes = Object.create(null);
    Object.keys(positions).forEach(function (id) {
      var node = network.body.data.nodes.get(id);
      if (node && node.mapContainer) return;
      var position = positions[id];
      if (
        !position
        || !Number.isFinite(position.x)
        || !Number.isFinite(position.y)
      ) return;
      nodes[id] = { x: position.x, y: position.y };
    });

    var layout = { version: VERSION, nodes: nodes };
    var blob = new Blob([JSON.stringify(layout, null, 2)], {
      type: "application/json"
    });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = FILENAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    var status = document.getElementById("layout-save-status");
    if (status) {
      status.textContent = "Downloaded " + FILENAME
        + ". Place it beside this HTML to restore positions on regeneration.";
    }
  });
})();
</script>
"""


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def seed_nodes_in_columns(net, datatype_node_colors):
    """Seed two starting sides while leaving physics and manual movement enabled."""
    columns = {False: [], True: []}
    datatype_ids = set(datatype_node_colors)
    for node in net.nodes:
        columns[node["id"] in datatype_ids].append(node)

    for is_datatype, nodes in columns.items():
        x = DATATYPE_COLUMN_X if is_datatype else OTHER_NODE_COLUMN_X
        midpoint = (len(nodes) - 1) / 2
        for index, node in enumerate(nodes):
            node.update({
                "x": x,
                "y": (index - midpoint) * COLUMN_VERTICAL_SPACING,
            })


def build_containment_frames(entities):
    """Return direct children and transitive members, outermost first."""
    children = {}
    for entity in entities:
        parent = entity["parent"]
        if parent:
            children.setdefault(parent, []).append(entity["name"])

    frames = []
    for entity in entities:
        owner = entity["name"]
        direct_children = children.get(owner, [])
        if not direct_children:
            continue

        descendants = []
        visited = {owner}
        pending = list(reversed(direct_children))
        while pending:
            child = pending.pop()
            if child in visited:
                continue
            visited.add(child)
            descendants.append(child)
            pending.extend(reversed(children.get(child, [])))
        frames.append({
            "owner": owner,
            "children": list(direct_children),
            "members": [owner] + descendants,
        })

    frames.sort(key=lambda frame: len(frame["members"]), reverse=True)
    return frames


def build_graph(entities, datatypes, relationships, tier_colors):
    containment_frames = build_containment_frames(entities)
    container_owners = {frame["owner"] for frame in containment_frames}
    net = Network(
        directed=True,
        height="750px",
        width="100%",
        cdn_resources="in_line",
    )
    node_types = {}
    edge_types = {}
    known_nodes = set()
    descriptions = {}

    def add_node(name, node_type, fields, container=False):
        style = node_style(node_type, fields, tier_colors)
        known_nodes.add(name)
        node_types[node_type] = style
        descriptions[name] = node_title(name, node_type, fields)
        options = {
            "label": name,
            "shape": style["shape"],
            "color": style["color"],
            "mapType": node_type,
            "mapImportance": fields.get("Importance", ""),
            "mapBaseColor": style["color"],
            "mapContainer": container,
            "mapFrameHighlighted": False,
        }
        if container:
            transparent = "rgba(0,0,0,0)"
            options.update({
                "color": {
                    "background": transparent,
                    "border": transparent,
                    "highlight": {
                        "background": transparent,
                        "border": transparent,
                    },
                    "hover": {
                        "background": transparent,
                        "border": transparent,
                    },
                },
                "font": {"color": transparent},
                "borderWidth": 0,
                "borderWidthSelected": 0,
            })
        net.add_node(name, **options)
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
            "mapType": edge_type,
        }
        if edge_type == "Contains":
            # Keep containment springs in the force layout without drawing or
            # exposing them as selectable edge objects.
            options.update({
                "hidden": True,
                "physics": True,
                "arrows": "",
                "title": "",
            })
        if label:
            options["label"] = label
        if datatype_refs:
            options["dataTypeRefs"] = datatype_refs
        net.add_edge(source, target, **options)

    for e in entities:
        add_node(
            e["name"],
            e["type"],
            e["fields"],
            container=e["name"] in container_owners,
        )

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

    seed_nodes_in_columns(net, datatype_node_colors)
    return (
        net,
        node_types,
        edge_types,
        descriptions,
        datatype_node_colors,
        containment_frames,
    )


def node_swatch(shape, fill, border="#444444", border_width=1):
    """Return a small SVG sample matching a graph node's shape and color."""
    fill = html_escape(str(fill), quote=True)
    border = html_escape(str(border), quote=True)
    if shape == "box":
        mark = '<rect x="2" y="2" width="28" height="14" rx="2"'
    elif shape == "diamond":
        mark = '<polygon points="16,1 30,9 16,17 2,9"'
    else:
        mark = '<ellipse cx="16" cy="9" rx="14" ry="7"'
    return (
        '<svg aria-hidden="true" focusable="false" width="32" height="18" '
        'viewBox="0 0 32 18">{} fill="{}" stroke="{}" '
        'stroke-width="{}"/></svg>'
    ).format(mark, fill, border, border_width)


def edge_swatch(color, dashes, width=3):
    """Return a line sample whose color and dash pattern match an edge style."""
    color = html_escape(str(color), quote=True)
    dash = ""
    if dashes:
        pattern = " ".join(str(length) for length in dashes)
        dash = ' stroke-dasharray="{}"'.format(html_escape(pattern, quote=True))
    return (
        '<svg aria-hidden="true" focusable="false" width="42" height="18" '
        'viewBox="0 0 42 18"><line x1="2" y1="9" x2="40" y2="9" '
        'stroke="{}" stroke-width="{}"{} stroke-linecap="round"/></svg>'
    ).format(color, width, dash)


def containment_swatch(color=CONTAINMENT_FRAME_BORDER_COLOR, width=2):
    """Return a sample of the enclosure used for Contains relationships."""
    color = html_escape(str(color), quote=True)
    return (
        '<svg aria-hidden="true" focusable="false" width="42" height="18" '
        'viewBox="0 0 42 18"><rect x="3" y="2" width="36" height="14" '
        'rx="3" fill="rgba(0,0,0,0.03)" stroke="{}" '
        'stroke-width="{}"/></svg>'
    ).format(color, width)


def legend_row(sample, label, indent=0, target_kind=None, target_value=""):
    """Render a legend item and optionally mark its graph elements as targets."""
    gap = 8 if sample else 0
    attrs = ""
    cursor = ""
    if target_kind:
        attrs = (
            ' class="map-legend-row" data-legend-kind="{}" '
            'data-legend-value="{}" tabindex="0" role="button"'
        ).format(
            html_escape(target_kind, quote=True),
            html_escape(target_value, quote=True),
        )
        cursor = "cursor:pointer;"
    return (
        '<div{} style="display:flex;align-items:center;gap:{}px;min-height:22px;'
        'margin-left:{}px;{}">{}<span>{}</span></div>'
    ).format(attrs, gap, indent, cursor, sample, label)


def build_legend(
    node_types, edge_types, entity_tiers, tier_colors, has_unrated_entities=False
):
    parts = [
        '<div class="map-legend" '
        'style="position:fixed;top:10px;left:10px;box-sizing:border-box;'
        'max-width:min(380px,calc(100vw - 20px));max-height:80vh;overflow:auto;'
        'padding:10px;background:rgba(255,255,255,0.95);border:1px solid #ccc;'
        'z-index:1000;font:12px/1.45 sans-serif;">',
        "<b>Legend</b><br><b>Nodes</b><br>",
    ]

    for node_type, style in sorted(node_types.items()):
        if node_type == "Entity":
            parts.append(legend_row(
                "",
                "<b>Entity</b> — box or owner frame; color by importance",
                target_kind="node-type",
                target_value="Entity",
            ))
            entity_colors = [
                (tier, entity_color(tier, tier_colors), "importance")
                for tier in entity_tiers
            ]
            if has_unrated_entities or not entity_colors:
                entity_colors.append((
                    "No importance", ENTITY_DEFAULT_COLOR, "unrated-entity"
                ))
            for tier, color, target_kind in entity_colors:
                label = "{} — {}".format(
                    html_escape(tier), html_escape(color_label(color))
                )
                parts.append(legend_row(
                    node_swatch(ENTITY_SHAPE, color),
                    label,
                    indent=18,
                    target_kind=target_kind,
                    target_value="" if target_kind == "unrated-entity" else tier,
                ))
            continue

        label = "<b>{}</b> — {}, {}".format(
            html_escape(node_type),
            html_escape(style["shape"]),
            html_escape(color_label(style["color"])),
        )
        parts.append(legend_row(
            node_swatch(style["shape"], style["color"]),
            label,
            target_kind="node-type",
            target_value=node_type,
        ))

    parts.append("<b>Relationships</b><br>")
    for edge_type, style in sorted(edge_types.items()):
        if edge_type == "Contains":
            label = "<b>Contains</b> — owner frame; color by importance"
            sample = containment_swatch(CONTAINMENT_FRAME_BORDER_COLOR)
        else:
            label = "<b>{}</b> — {}, {}".format(
                html_escape(edge_type),
                html_escape(dashes_label(style["dashes"])),
                html_escape(color_label(style["color"])),
            )
            sample = edge_swatch(style["color"], style["dashes"])
        parts.append(legend_row(
            sample,
            label,
            target_kind="edge-type",
            target_value=edge_type,
        ))

    highlight_sample = (
        '<span style="display:inline-flex;align-items:center;gap:4px;">'
        + node_swatch(
            DATATYPE_SHAPE,
            DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND,
            DATATYPE_REFERENCE_HIGHLIGHT_BORDER,
            DATATYPE_REFERENCE_HIGHLIGHT_BORDER_WIDTH,
        )
        + edge_swatch(
            DATATYPE_REFERENCE_HIGHLIGHT_BORDER,
            False,
            DATATYPE_REFERENCE_HIGHLIGHT_EDGE_WIDTH,
        )
        + containment_swatch(
            DATATYPE_REFERENCE_HIGHLIGHT_BORDER,
            DATATYPE_REFERENCE_HIGHLIGHT_EDGE_WIDTH,
        )
        + "</span>"
    )
    highlight_label = (
        "<b>Reference/frame highlight</b> — {} fill, {} border/line/frame"
    ).format(
        html_escape(color_label(DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND)),
        html_escape(color_label(DATATYPE_REFERENCE_HIGHLIGHT_BORDER)),
    )
    parts.append(legend_row(
        highlight_sample,
        highlight_label,
        target_kind="references",
        target_value="all",
    ))
    parts.append("</div>")
    return "".join(parts)


def default_input_path(requested_path=None):
    """Use the requested input or the canonical map file, with no legacy fallback."""
    return requested_path or "map/MAP.md"


def layout_path_for_output(output_path):
    stem, _ = os.path.splitext(output_path)
    return stem + ".layout.json"


def finite_coordinate(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    return number if math.isfinite(number) else None


def load_saved_layout(layout_path):
    try:
        with open(layout_path, "r", encoding="utf-8") as f:
            saved = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(
            "Warning: ignoring saved layout {}: {}".format(layout_path, error),
            file=sys.stderr,
        )
        return {}

    if (
        not isinstance(saved, dict)
        or type(saved.get("version")) is not int
        or saved["version"] != LAYOUT_VERSION
        or not isinstance(saved.get("nodes"), dict)
    ):
        print(
            "Warning: ignoring unsupported or invalid layout file {}.".format(
                layout_path
            ),
            file=sys.stderr,
        )
        return {}

    positions = {}
    for node_id, coordinates in saved["nodes"].items():
        if not isinstance(node_id, str) or not isinstance(coordinates, dict):
            continue
        x = finite_coordinate(coordinates.get("x"))
        y = finite_coordinate(coordinates.get("y"))
        if x is not None and y is not None:
            positions[node_id] = {"x": x, "y": y}
    return positions


def apply_saved_layout(net, positions):
    """Restore movable nodes; owner headers are derived from child positions."""
    applied = 0
    for node in net.nodes:
        if node.get("mapContainer"):
            continue
        position = positions.get(str(node["id"]))
        if position is None:
            continue
        node.update({
            "x": position["x"],
            "y": position["y"],
            "physics": False,
        })
        applied += 1
    return applied


def main():
    requested_input = sys.argv[1] if len(sys.argv) > 1 else None
    input_path = default_input_path(requested_input)
    output_path = (
        sys.argv[2] if len(sys.argv) > 2 else "map/map-graph.html"
    )
    layout_path = layout_path_for_output(output_path)

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
    (
        net,
        node_types,
        edge_types,
        descriptions,
        datatype_node_colors,
        containment_frames,
    ) = build_graph(entities, datatypes, relationships, tier_colors)
    saved_positions = load_saved_layout(layout_path)
    applied_positions = apply_saved_layout(net, saved_positions)
    if applied_positions:
        print(
            "Loaded saved positions for {} of {} nodes from {}.".format(
                applied_positions, len(net.nodes), layout_path
            )
        )

    output_directory = os.path.dirname(output_path)
    if output_directory:
        os.makedirs(output_directory, exist_ok=True)
    net.set_options(json.dumps(OPTIONS))
    net.write_html(output_path, open_browser=False)

    with open(output_path, "r", encoding="utf-8") as f:
        html = f.read()
    has_unrated_entities = any(
        not e["fields"].get("Importance") for e in entities
    )
    legend = build_legend(
        node_types,
        edge_types,
        entity_tiers,
        tier_colors,
        has_unrated_entities,
    )
    # Prevent map content from closing the injected script element.
    descriptions_json = json.dumps(descriptions).replace("<", r"\u003c")
    node_tooltip = NODE_TOOLTIP_JS.replace(
        "__NODE_DESCRIPTIONS__", descriptions_json
    )
    containment_frames_json = json.dumps(containment_frames).replace(
        "<", r"\u003c"
    )
    containment_frames_js = (
        CONTAINMENT_FRAME_JS.replace(
            "__CONTAINMENT_FRAMES__", containment_frames_json
        )
        .replace("__FRAME_PADDING__", str(CONTAINMENT_FRAME_PADDING))
        .replace(
            "__FRAME_HEADER_GAP__",
            str(CONTAINMENT_FRAME_HEADER_GAP),
        )
        .replace("__FRAME_FILL_ALPHA__", str(CONTAINMENT_FRAME_FILL_ALPHA))
        .replace("__FRAME_STROKE_WIDTH__", str(CONTAINMENT_FRAME_STROKE_WIDTH))
        .replace("__FRAME_BORDER_COLOR__", CONTAINMENT_FRAME_BORDER_COLOR)
        .replace(
            "__FRAME_HEADER_BORDER_COLOR__",
            CONTAINMENT_FRAME_HEADER_BORDER_COLOR,
        )
        .replace("__HIGHLIGHT_BACKGROUND__", DATATYPE_REFERENCE_HIGHLIGHT_BACKGROUND)
        .replace("__HIGHLIGHT_BORDER__", DATATYPE_REFERENCE_HIGHLIGHT_BORDER)
        .replace(
            "__HIGHLIGHT_BORDER_WIDTH__",
            str(DATATYPE_REFERENCE_HIGHLIGHT_BORDER_WIDTH),
        )
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
        .replace(
            "__HIGHLIGHT_EDGE_WIDTH__",
            str(DATATYPE_REFERENCE_HIGHLIGHT_EDGE_WIDTH),
        )
    )
    layout_filename_json = json.dumps(os.path.basename(layout_path)).replace(
        "<", r"\u003c"
    )
    layout_save_js = (
        LAYOUT_SAVE_JS.replace("__LAYOUT_FILENAME__", layout_filename_json)
        .replace("__LAYOUT_VERSION__", str(LAYOUT_VERSION))
    )
    additions = [
        legend,
        LAYOUT_SAVE_UI,
        TOOLTIP_CSS,
        PHYSICS_DISABLE_JS,
        containment_frames_js,
        INTERACTION_JS,
        node_tooltip,
        datatype_reference,
        layout_save_js,
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
