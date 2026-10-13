"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");

const SCRIPT_DIR = path.join(__dirname, "../scripts");
const FIXTURE = path.join(__dirname, "fixtures/scenario-flows.md");
const FLOW_SCRIPT = path.join(SCRIPT_DIR, "flow_visualize.py");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-flow-ui-"));
const output = path.join(temp, "flow-graph.html");
const generated = spawnSync("python3", [FLOW_SCRIPT, FIXTURE, output], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
const source = fs.readFileSync(output, "utf8");
const model = JSON.parse(source.match(/id="flow-data">([\s\S]*?)<\/script>/)[1]);
const layoutInfo = JSON.parse(source.match(/id="layout-info">([\s\S]*?)<\/script>/)[1]);
const appScript = source.match(/<script>([\s\S]*?)<\/script>/)[1];

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this._text = ""; this.className = ""; this.scrollLeft = 0; this.scrollTop = 0;
    this.clientWidth = 800; this.clientHeight = 600; this.disabled = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) {
    this.children = children;
    children.forEach(child => { child.parentNode = this; });
    this._text = "";
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  trigger(name, event = {}) {
    const value = { button: 0, key: "", preventDefault() {}, stopPropagation() {}, target: this, ...event };
    (this.listeners[name] || []).forEach(handler => handler(value));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: Number(this.attributes.width) || 1200,
      height: Number(this.attributes.height) || 800 };
  }
  click() { this.trigger("click"); }
  remove() {}
}

function environment() {
  const ids = ["flow-data", "layout-info", "flow-graph", "graph-shell", "scenario-summary",
    "details", "scenario-index", "breadcrumbs", "back-button", "save-flow-layout", "layout-status"];
  const elements = Object.fromEntries(ids.map(id => [id, new Element("div")]));
  elements["flow-data"].textContent = JSON.stringify(model);
  elements["layout-info"].textContent = JSON.stringify(layoutInfo);
  elements["flow-graph"].getBoundingClientRect = function () {
    return { left: -elements["graph-shell"].scrollLeft, top: -elements["graph-shell"].scrollTop,
      width: Number(this.attributes.width) || 1200, height: Number(this.attributes.height) || 800 };
  };
  const listeners = {}, downloads = {};
  const document = {
    body: new Element("body"),
    getElementById(id) { return elements[id] || null; },
    createElement(tag) {
      const node = new Element(tag);
      if (tag === "a") node.click = () => { downloads.filename = node.download; };
      return node;
    },
    createElementNS(_namespace, tag) { return new Element(tag); },
  };
  const window = {
    addEventListener(name, handler) { (listeners[name] ||= []).push(handler); },
    dispatch(name, event = {}) { (listeners[name] || []).forEach(handler => handler(event)); },
  };
  class BlobMock { constructor(parts) { this.parts = parts; } }
  const URL = {
    createObjectURL(blob) { downloads.text = blob.parts.join(""); return "blob:layout"; },
    revokeObjectURL() {},
  };
  vm.runInNewContext(appScript, { document, window, Blob: BlobMock, URL, setTimeout() {} },
    { filename: "flow-view.js" });
  return { app: window.flowGraphApp, elements, document, window, downloads };
}
function find(element, predicate, result = []) {
  if (predicate(element)) result.push(element);
  element.children.forEach(child => find(child, predicate, result));
  return result;
}
function byAttr(element, name, value) {
  return find(element, node => node.getAttribute(name) === value)[0];
}

 test("generated view has only a Scenarios sidebar and renders nested generic frames", () => {
  new vm.Script(appScript);
  const env = environment(), graph = env.elements["flow-graph"];
  assert.equal(env.app.currentScenario, "process-request");
  assert.equal(env.document.getElementById("participant-controls"), null);
  assert.equal(env.document.getElementById("thread-list"), null);
  assert.equal(env.elements["scenario-index"].children.length, 2);
  const outer = byAttr(graph, "data-frame-id", "request-path");
  const inner = byAttr(graph, "data-frame-id", "handler-work");
  assert.ok(outer && inner);
  assert.match(source, /id="scenario-sidebar"/);
  assert.doesNotMatch(source, /Participant instances|Execution threads|Highlight|Filter/);
  assert.doesNotMatch(source, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test("steps move freely and dragging a frame header translates its nested subtree", () => {
  const env = environment(), app = env.app, graph = env.elements["flow-graph"];
  const originalReceive = { ...app.positions.receive };
  const receive = byAttr(graph, "data-step-id", "receive");
  receive.trigger("pointerdown", { clientX: originalReceive.x, clientY: originalReceive.y });
  env.window.dispatch("pointermove", { clientX: originalReceive.x + 760, clientY: originalReceive.y + 420 });
  env.window.dispatch("pointerup", {});
  assert.equal(app.positions.receive.x, originalReceive.x + 760);
  assert.equal(app.positions.receive.y, originalReceive.y + 420);
  assert.ok(app.frames.find(frame => frame.id === "request-path").right > originalReceive.x + 760);

  const original = Object.fromEntries(app.frames.find(frame => frame.id === "request-path").step_ids
    .map(id => [id, { ...app.positions[id] }]));
  const frame = app.frames.find(item => item.id === "request-path");
  const header = byAttr(graph, "data-frame-header", "request-path");
  const start = { x: frame.left + 45, y: frame.top + 20 };
  header.trigger("pointerdown", { clientX: start.x, clientY: start.y });
  env.window.dispatch("pointermove", { clientX: start.x + 65, clientY: start.y + 38 });
  env.window.dispatch("pointerup", {});
  Object.entries(original).forEach(([id, point]) => {
    assert.equal(app.positions[id].x, point.x + 65, `${id} x follows its frame`);
    assert.equal(app.positions[id].y, point.y + 38, `${id} y follows its frame`);
  });
});

test("step inspector opens linked scenarios and breadcrumbs return to the caller", () => {
  const env = environment();
  env.app.selectStep("validate");
  const open = find(env.elements.details, node => node.tag === "button" && node.textContent === "Open scenario: Validation details")[0];
  assert.ok(open);
  open.trigger("click");
  assert.equal(env.app.currentScenario, "validation-details");
  assert.deepEqual(Array.from(env.app.breadcrumbs), ["process-request", "validation-details"]);
  env.elements["back-button"].trigger("click");
  assert.equal(env.app.currentScenario, "process-request");
});

test("saved free-layout coordinates round-trip through regeneration", () => {
  const env = environment(), original = { ...env.app.positions.receive };
  const node = byAttr(env.elements["flow-graph"], "data-step-id", "receive");
  node.trigger("pointerdown", { clientX: original.x, clientY: original.y });
  env.window.dispatch("pointermove", { clientX: original.x + 85, clientY: original.y + 55 });
  env.window.dispatch("pointerup", {});
  env.elements["save-flow-layout"].trigger("click");
  assert.equal(env.downloads.filename, "flow-graph.layout.json");
  const saved = JSON.parse(env.downloads.text);
  assert.deepEqual(saved.scenarios["process-request"].receive,
    { x: original.x + 85, y: original.y + 55 });

  const sidecar = path.join(temp, env.downloads.filename);
  fs.writeFileSync(sidecar, env.downloads.text, "utf8");
  const rebuilt = spawnSync("python3", [FLOW_SCRIPT, FIXTURE, output], { encoding: "utf8" });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const regenerated = fs.readFileSync(output, "utf8");
  const embedded = JSON.parse(regenerated.match(/id="flow-data">([\s\S]*?)<\/script>/)[1]);
  const request = embedded.scenarios.find(scenario => scenario.id === "process-request");
  assert.deepEqual(request.layout.positions.receive, saved.scenarios["process-request"].receive);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
