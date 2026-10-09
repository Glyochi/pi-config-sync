"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const VISUALIZER_PATH = path.join(__dirname, "../scripts/visualize.py");
const VISUALIZER_SOURCE = fs.readFileSync(VISUALIZER_PATH, "utf8");
const FRAMES = [
  {
    owner: "Root",
    children: ["Inner", "Root leaf"],
    members: ["Root", "Inner", "Inner leaf", "Root leaf"],
  },
  {
    owner: "Inner",
    children: ["Inner leaf"],
    members: ["Inner", "Inner leaf"],
  },
];

function sourceConstant(name) {
  const match = VISUALIZER_SOURCE.match(
    new RegExp("^" + name + ' = """([\\s\\S]*?)"""', "m")
  );
  assert.ok(match, `could not find ${name} in visualize.py`);
  return match[1]
    .replace(/^\s*<script[^>]*>/, "")
    .replace(/<\/script>\s*$/, "");
}

function containmentScript() {
  return sourceConstant("CONTAINMENT_FRAME_JS")
    .replace("__CONTAINMENT_FRAMES__", JSON.stringify(FRAMES))
    .replace("__FRAME_PADDING__", "24")
    .replace("__FRAME_HEADER_GAP__", "12")
    .replace("__FRAME_FILL_ALPHA__", "0.055")
    .replace("__FRAME_STROKE_WIDTH__", "1.5")
    .replace("__FRAME_BORDER_COLOR__", "#777777")
    .replace("__FRAME_HEADER_BORDER_COLOR__", "#444444")
    .replace("__HIGHLIGHT_BACKGROUND__", "#FFE08A")
    .replace("__HIGHLIGHT_BORDER__", "#E67700")
    .replace("__HIGHLIGHT_BORDER_WIDTH__", "4");
}

function layoutSaveScript() {
  return sourceConstant("LAYOUT_SAVE_JS")
    .replace("__LAYOUT_FILENAME__", JSON.stringify("test.layout.json"))
    .replace("__LAYOUT_VERSION__", "1");
}

function makeEnvironment() {
  const ids = ["Root", "Inner", "Inner leaf", "Root leaf"];
  const nodes = Object.create(null);
  const positions = Object.create(null);
  ids.forEach((id, index) => {
    const owner = id === "Root" || id === "Inner";
    nodes[id] = {
      id,
      label: id,
      mapContainer: owner,
      mapFrameReady: false,
      mapFrameHighlighted: false,
      mapBaseColor: owner ? "#E75C40" : "#E3E2DE",
      width: owner ? 96 : 70,
      height: owner ? 28 : 20,
      physics: true,
    };
    positions[id] = { x: index * 130, y: index * 90 };
  });

  const networkListeners = Object.create(null);
  const onceListeners = Object.create(null);
  const canvasListeners = Object.create(null);
  const documentListeners = Object.create(null);
  const buttonListeners = Object.create(null);
  let hitNode = null;
  let selectedNodes = [];
  let strokeColors = [];
  let savedLayoutText = null;

  const context = {
    strokeStyle: "#000000",
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {},
    setLineDash() {},
    fillText() {},
    stroke() { strokeColors.push(this.strokeStyle); },
  };

  const canvas = {
    addEventListener(name, listener) {
      canvasListeners[name] = listener;
    },
  };
  const container = {
    querySelector() { return canvas; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    appendChild() {},
  };
  const saveButton = {
    addEventListener(name, listener) {
      buttonListeners[name] = listener;
    },
  };
  const layoutStatus = { textContent: "" };
  const document = {
    body: { appendChild() {} },
    getElementById(id) {
      if (id === "mynetwork") return container;
      if (id === "save-layout-button") return saveButton;
      if (id === "layout-save-status") return layoutStatus;
      return null;
    },
    createElement() {
      return { style: {}, click() {}, remove() {} };
    },
    addEventListener(name, listener) {
      documentListeners[name] = listener;
    },
  };

  const network = {
    body: {
      data: {
        nodes: {
          get(id) { return nodes[String(id)]; },
          update(updates) {
            (Array.isArray(updates) ? updates : [updates]).forEach((update) => {
              const id = String(update.id);
              if (update.x !== undefined) positions[id].x = update.x;
              if (update.y !== undefined) positions[id].y = update.y;
              Object.assign(nodes[id], update);
            });
          },
        },
        edges: {
          get() { return []; },
          update() {},
        },
      },
    },
    on(name, listener) {
      (networkListeners[name] ||= []).push(listener);
    },
    once(name, listener) {
      (onceListeners[name] ||= []).push(listener);
    },
    getScale() { return 1; },
    getPositions() {
      return Object.fromEntries(
        Object.entries(positions).map(([id, point]) => [id, { ...point }])
      );
    },
    getBoundingBox(id) {
      const node = nodes[String(id)];
      const point = positions[String(id)];
      return {
        left: point.x - node.width / 2,
        right: point.x + node.width / 2,
        top: point.y - node.height / 2,
        bottom: point.y + node.height / 2,
      };
    },
    moveNode(id, x, y) {
      positions[String(id)] = { x, y };
    },
    getSelectedNodes() { return selectedNodes; },
    getSelectedEdges() { return []; },
    getNodeAt() { return hitNode; },
    getEdgeAt() { return undefined; },
    canvasToDOM(point) { return point; },
    selectNodes(ids) { selectedNodes = ids; },
    redraw() {
      strokeColors = [];
      (networkListeners.beforeDrawing || []).forEach((listener) => listener(context));
    },
  };

  const window = {
    mapContainmentLegendHighlight: false,
    requestAnimationFrame(callback) { callback(); },
  };
  const fakeUrl = {
    createObjectURL(blob) {
      savedLayoutText = blob.parts.join("");
      return "blob:layout";
    },
    revokeObjectURL() {},
  };
  class FakeBlob {
    constructor(parts) { this.parts = parts; }
  }
  const sandbox = {
    network,
    window,
    document,
    URL: fakeUrl,
    Blob: FakeBlob,
    setTimeout() { return 0; },
  };

  vm.runInNewContext(containmentScript(), sandbox, { filename: "containment.js" });
  vm.runInNewContext(sourceConstant("INTERACTION_JS"), sandbox, {
    filename: "interaction.js",
  });

  return {
    nodes,
    positions,
    network,
    window,
    canvasListeners,
    documentListeners,
    buttonListeners,
    fire(name, params) {
      (networkListeners[name] || []).forEach((listener) => listener(params));
    },
    fireOnce(name, params) {
      const listeners = onceListeners[name] || [];
      delete onceListeners[name];
      listeners.forEach((listener) => listener(params));
    },
    stabilize() { this.fireOnce("stabilizationIterationsDone"); },
    hit(id) { hitNode = id; },
    get strokeColors() { return strokeColors; },
    get savedLayoutText() { return savedLayoutText; },
    clickSave() {
      const script = layoutSaveScript();
      vm.runInNewContext(script, sandbox, { filename: "layout-save.js" });
      buttonListeners.click();
    },
  };
}

function clonePositions(positions) {
  return Object.fromEntries(
    Object.entries(positions).map(([id, point]) => [id, { ...point }])
  );
}

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.01, message);
}

function drag(env, nodeIds, dx, dy) {
  env.hit(nodeIds[0]);
  env.canvasListeners.mousedown({ clientX: 0, clientY: 0, shiftKey: false });
  env.fire("dragStart", {
    nodes: nodeIds,
    pointer: { canvas: { x: 0, y: 0 } },
  });
  env.fire("dragging", {
    nodes: nodeIds,
    pointer: { canvas: { x: dx, y: dy } },
  });
  nodeIds.forEach((id) => {
    env.positions[id].x += dx;
    env.positions[id].y += dy;
  });
  env.fire("dragEnd", {
    nodes: nodeIds,
    pointer: { canvas: { x: dx, y: dy } },
  });
  env.canvasListeners.mouseup({ clientX: 0, clientY: 0, shiftKey: false });
}

test("dragging one owner translates its nested subtree and Ctrl+Z restores it", () => {
  const env = makeEnvironment();
  env.stabilize();
  const before = clonePositions(env.positions);

  drag(env, ["Root"], 36, -22);
  for (const id of ["Root", "Inner", "Inner leaf", "Root leaf"]) {
    closeTo(env.positions[id].x, before[id].x + 36, `${id} x follows owner`);
    closeTo(env.positions[id].y, before[id].y - 22, `${id} y follows owner`);
  }

  env.documentListeners.keydown({
    ctrlKey: true,
    key: "z",
    preventDefault() {},
  });
  for (const id of Object.keys(before)) {
    closeTo(env.positions[id].x, before[id].x, `${id} x restored by undo`);
    closeTo(env.positions[id].y, before[id].y, `${id} y restored by undo`);
  }
});

test("dragging a non-owner leaf remains child-only", () => {
  const env = makeEnvironment();
  env.stabilize();
  const before = clonePositions(env.positions);

  drag(env, ["Inner leaf"], 18, 9);
  closeTo(env.positions["Inner leaf"].x, before["Inner leaf"].x + 18, "leaf x moved");
  closeTo(env.positions["Inner leaf"].y, before["Inner leaf"].y + 9, "leaf y moved");
  for (const id of ["Root leaf"]) {
    closeTo(env.positions[id].x, before[id].x, `${id} x stays put`);
    closeTo(env.positions[id].y, before[id].y, `${id} y stays put`);
  }
});

test("multi-selection does not expand an owner group", () => {
  const env = makeEnvironment();
  env.stabilize();
  const before = clonePositions(env.positions);

  drag(env, ["Root", "Root leaf"], 25, 14);
  for (const id of ["Inner", "Inner leaf"]) {
    closeTo(env.positions[id].x, before[id].x, `${id} x is not group-expanded`);
    closeTo(env.positions[id].y, before[id].y, `${id} y is not group-expanded`);
  }
  closeTo(env.positions["Root leaf"].x, before["Root leaf"].x + 25, "selected leaf x moved");
  closeTo(env.positions["Root leaf"].y, before["Root leaf"].y + 14, "selected leaf y moved");
});

test("hovering a nested owner glows only its own frame", () => {
  const env = makeEnvironment();
  env.stabilize();

  env.fire("hoverNode", { node: "Inner" });
  assert.equal(env.strokeColors[0], "#777777", "outer owner frame stays normal");
  assert.equal(env.strokeColors[1], "#E67700", "hovered owner frame glows");
});

test("layout save persists movable nodes but omits derived owner anchors", () => {
  const env = makeEnvironment();
  env.stabilize();
  env.clickSave();
  const saved = JSON.parse(env.savedLayoutText);
  assert.equal(saved.nodes.Root, undefined);
  assert.equal(saved.nodes.Inner, undefined);
  assert.ok(saved.nodes["Inner leaf"]);
  assert.ok(saved.nodes["Root leaf"]);
});

test("regenerated HTML embeds syntactically valid interaction scripts", () => {
  const htmlPath = process.env.VIS_MAP_HTML_PATH || "/workspace/map/map-graph.html";
  const html = fs.readFileSync(htmlPath, "utf8");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]);
  for (const marker of [
    "var FRAMES =",
    "var DATATYPE_NODE_COLORS =",
    "function undo() {",
    "var FILENAME =",
  ]) {
    const script = scripts.find((candidate) => candidate.includes(marker));
    assert.ok(script, `generated HTML is missing script containing ${marker}`);
    new vm.Script(script, { filename: `generated-${marker.replace(/\W/g, "-")}.js` });
  }
});
