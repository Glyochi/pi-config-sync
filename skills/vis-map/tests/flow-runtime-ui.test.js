"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "execution-flow-ui-"));
const fixture = path.join(__dirname, "fixtures/execution-flows.md");
const script = path.join(__dirname, "../scripts/flow_visualize.py");
const output = path.join(temp, "flow-graph.html");
const generated = spawnSync("python3", [script, fixture, output], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
assert.equal(generated.status, 0, generated.stderr);
const source = fs.readFileSync(output, "utf8");
const model = JSON.parse(source.match(/id="flow-data">([\s\S]*?)<\/script>/)[1]);
const layoutInfo = JSON.parse(source.match(/id="layout-info">([\s\S]*?)<\/script>/)[1]);
const appScript = source.match(/<script>([\s\S]*?)<\/script>/)[1];

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this._text = ""; this.className = ""; this.clientWidth = 800; this.clientHeight = 600; this.scrollLeft = 0; this.scrollTop = 0; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this._text = ""; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  trigger(name, event = {}) { const value = { button: 0, key: "", preventDefault() {}, stopPropagation() {}, ...event }; (this.listeners[name] || []).forEach(h => h(value)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: Number(this.attributes.width) || 1200, height: Number(this.attributes.height) || 800 }; }
  click() { this.trigger("click"); }
  remove() {}
}
function environment() {
  const names = ["flow-data", "layout-info", "flow-graph", "graph-shell", "scenario-summary", "details", "scenario-index", "breadcrumbs", "back-button", "participant-list", "participant-controls", "highlight-mode", "filter-mode", "clear-participants", "save-flow-layout", "layout-status"];
  const elements = Object.fromEntries(names.map(id => [id, new Element("div")]));
  elements["flow-graph"].getBoundingClientRect = function () { return { left: -elements["graph-shell"].scrollLeft, top: -elements["graph-shell"].scrollTop, width: Number(this.attributes.width) || 1200, height: Number(this.attributes.height) || 800 }; };
  elements["flow-data"].textContent = JSON.stringify(model); elements["layout-info"].textContent = JSON.stringify(layoutInfo);
  const listeners = {}, downloads = {};
  const document = {
    body: new Element("body"), getElementById(id) { return elements[id]; },
    createElement(tag) {
      const node = new Element(tag);
      if (tag === "a") node.click = () => { downloads.filename = node.download; };
      return node;
    },
    createElementNS(ns, tag) { return new Element(tag); },
  };
  const window = { addEventListener(name, handler) { (listeners[name] ||= []).push(handler); }, dispatch(name, e) { (listeners[name] || []).forEach(h => h(e)); } };
  class BlobMock { constructor(parts) { this.parts = parts; } }
  const URL = { createObjectURL(blob) { downloads.text = blob.parts.join(""); return "blob:flow"; }, revokeObjectURL() {} };
  vm.runInNewContext(appScript, { document, window, Blob: BlobMock, URL, setTimeout() {} }, { filename: "flow-runtime.js" });
  return { app: window.flowGraphApp, elements, document, window, downloads };
}
function find(element, predicate, all = []) { if (predicate(element)) all.push(element); element.children.forEach(c => find(c, predicate, all)); return all; }
function attr(element, name, value) { return find(element, e => e.getAttribute(name) === value)[0]; }
const graphOf = env => env.elements["flow-graph"];

 test("grouped offline view parses and nests thread frames under process frames", () => {
  new vm.Script(appScript);
  const env = environment(), graph = graphOf(env);
  assert.equal(env.document.body.className, "runtime-view");
  const processes = find(graph, n => n.getAttribute("data-process-frame") !== null);
  assert.equal(processes.length, 3);
  const parent = attr(graph, "data-process-frame", "parent");
  assert.equal(find(parent, n => n.getAttribute("data-thread-frame") !== null).length, 4);
  assert.match(parent.textContent, /3 fixed threads \+ 0\.\.n HTTP request threads/);
  const second = attr(graph, "data-thread-frame", "second-main");
  assert.match(second.textContent, /Context only/);
  assert.doesNotMatch(source, /id="zoom-(?:in|out|reset)"/);
  assert.match(source, /title="Scroll over the graph to zoom"/);
  assert.match(appScript, /addEventListener\("wheel"/);
  assert.doesNotMatch(source, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test("mouse-wheel zoom follows the pointer without moving events or frames", () => {
  const env = environment(), graph = graphOf(env), shell = env.elements["graph-shell"];
  const initialWidth = Number(graph.getAttribute("width")), initialHeight = Number(graph.getAttribute("height"));
  const position = { ...env.app.positions.snapshot }, threadLeft = env.app.frames.threads.find(t => t.id === "reconciler").left;
  let prevented = false;
  shell.trigger("wheel", { deltaY: -120, deltaMode: 0, clientX: 350, clientY: 260, preventDefault() { prevented = true; } });
  assert.ok(env.app.zoom > 1);
  assert.ok(Math.abs(env.app.zoom - Math.exp(0.6)) < 1e-9, "one 120px wheel notch uses sensitivity 0.005");
  assert.equal(Number(graph.getAttribute("width")), Math.round(initialWidth * env.app.zoom));
  assert.equal(Number(graph.getAttribute("height")), Math.round(initialHeight * env.app.zoom));
  assert.ok(shell.scrollLeft > 0, "zoom anchors the graph beneath the pointer");
  assert.ok(prevented, "the wheel is consumed over the graph instead of scrolling the page");
  assert.deepEqual(JSON.parse(JSON.stringify(env.app.positions.snapshot)), position);
  assert.equal(env.app.frames.threads.find(t => t.id === "reconciler").left, threadLeft);
  shell.trigger("wheel", { deltaY: 120, deltaMode: 0, clientX: 350, clientY: 260, preventDefault() {} });
  assert.equal(Math.round(env.app.zoom * 100), 100);
  assert.equal(Number(graph.getAttribute("width")), initialWidth);
  assert.equal(Number(graph.getAttribute("height")), initialHeight);
  assert.equal(shell.scrollLeft, 0, "zooming back out restores the original scroll position");
});

test("dragging the background pans the canvas without moving frame events", () => {
  const env = environment(), shell = env.elements["graph-shell"], initial = { ...env.app.positions.snapshot };
  shell.scrollLeft = 180; shell.scrollTop = 120;
  shell.trigger("pointerdown", { button: 0, clientX: 400, clientY: 300, target: shell, preventDefault() {} });
  env.window.dispatch("pointermove", { clientX: 450, clientY: 270, preventDefault() {} });
  assert.equal(shell.scrollLeft, 130);
  assert.equal(shell.scrollTop, 150);
  assert.deepEqual(JSON.parse(JSON.stringify(env.app.positions.snapshot)), initial);
  assert.equal(shell.getAttribute("data-panning"), "true");
  env.window.dispatch("pointerup", {});
  assert.equal(shell.getAttribute("data-panning"), null);

  const eventNode = attr(graphOf(env), "data-event-id", "snapshot"), left = shell.scrollLeft;
  shell.trigger("pointerdown", { button: 0, clientX: 400, clientY: 300, target: eventNode, preventDefault() {} });
  env.window.dispatch("pointermove", { clientX: 500, clientY: 350, preventDefault() {} });
  assert.equal(shell.scrollLeft, left, "an event drag is not treated as background panning");
  env.window.dispatch("pointerup", {});
});

test("decision, termination, repeats and interaction categories are visible and inspectable", () => {
  const env = environment(), graph = graphOf(env);
  const decision = attr(graph, "data-event-id", "diff");
  assert.ok(find(decision, n => n.tag === "polygon").length);
  assert.match(attr(graph, "data-event-id", "stopped").getAttribute("class"), /terminate/);
  for (const category of ["sequence", "spawn", "message", "signal"]) {
    assert.ok(find(graph, n => n.getAttribute("data-link-category") === category).length);
  }
  env.app.selectEvent("snapshot");
  assert.match(env.elements.details.textContent, /Supervisor loop thread/);
  assert.match(env.elements.details.textContent, /State store/);
  env.app.selectLink("repeat-tick");
  assert.match(env.elements.details.textContent, /Guarded repeat/);
  assert.match(env.elements.details.textContent, /until stopped/);
  env.app.selectEvent("diff");
  assert.match(env.elements.details.textContent, /child missing/);
  assert.match(env.elements.details.textContent, /child already present/);
});

test("thread filtering retains frames and honest counts and clear restores steps", () => {
  const env = environment();
  const checkbox = attr(env.elements["participant-controls"], "data-thread-key", "supervisor::thread:reconciler");
  assert.ok(checkbox);
  checkbox.checked = true; checkbox.trigger("change");
  env.elements["filter-mode"].trigger("click");
  let graph = graphOf(env);
  assert.equal(attr(graph, "data-event-id", "child-entry").getAttribute("display"), "none");
  assert.notEqual(attr(graph, "data-event-id", "snapshot").getAttribute("display"), "none");
  assert.equal(find(graph, n => n.getAttribute("data-process-frame") !== null).length, 3);
  assert.match(env.elements["scenario-summary"].textContent, /Filtered steps/);
  assert.match(attr(graph, "data-thread-frame", "child-main").textContent, /0\/3 steps visible/);
  env.app.selectEvent("child-entry");
  assert.match(env.elements.details.textContent, /Enter child/);
  env.elements["clear-participants"].trigger("click");
  graph = graphOf(env);
  assert.ok(find(graph, n => n.getAttribute("data-event-id") !== null).every(n => n.getAttribute("display") === null));
});

test("component selection can highlight calls in different executing threads", () => {
  const env = environment();
  const checkbox = attr(env.elements["participant-list"], "data-participant-key", "supervisor::store");
  checkbox.checked = true; checkbox.trigger("change");
  for (const id of ["snapshot", "store-status"]) assert.match(attr(graphOf(env), "data-event-id", id).getAttribute("class"), /participant-highlight/);
  assert.equal(attr(graphOf(env), "data-event-id", "snapshot").getAttribute("data-execution-thread"), "reconciler");
  assert.equal(attr(graphOf(env), "data-event-id", "store-status").getAttribute("data-execution-thread"), "control");
});

test("dragging preserves execution membership, refits frames, and round-trips saved coordinates", () => {
  const env = environment(), original = { ...env.app.positions.snapshot };
  const node = attr(graphOf(env), "data-event-id", "snapshot");
  node.trigger("pointerdown", { clientX: original.x, clientY: original.y });
  env.window.dispatch("pointermove", { clientX: original.x + 20, clientY: original.y + 800 });
  env.window.dispatch("pointerup", {});
  assert.equal(env.app.positions.snapshot.x, original.x + 20);
  assert.equal(env.app.positions.snapshot.y, original.y + 800);
  const thread = env.app.frames.threads.find(t => t.id === "reconciler"), process = env.app.frames.processes.find(p => p.id === "parent");
  assert.ok(thread.bottom > env.app.positions.snapshot.y + 76);
  assert.ok(process.bottom > thread.bottom);
  const moved = { ...env.app.positions.snapshot };
  const movedNode = attr(graphOf(env), "data-event-id", "snapshot");
  movedNode.trigger("pointerdown", { clientX: moved.x, clientY: moved.y });
  env.window.dispatch("pointermove", { clientX: 999999, clientY: moved.y });
  env.window.dispatch("pointerup", {});
  assert.ok(env.app.positions.snapshot.x + 130 < thread.right);
  assert.equal(attr(graphOf(env), "data-event-id", "snapshot").getAttribute("data-execution-thread"), "reconciler");
  env.elements["save-flow-layout"].trigger("click");
  const saved = JSON.parse(env.downloads.text);
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.scenarios.supervisor.snapshot, JSON.parse(JSON.stringify(env.app.positions.snapshot)));
  fs.writeFileSync(path.join(temp, env.downloads.filename), env.downloads.text);
  const rebuilt = spawnSync("python3", [script, fixture, output], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const embedded = JSON.parse(fs.readFileSync(output, "utf8").match(/id="flow-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(embedded.scenarios[0].layout.positions.snapshot, saved.scenarios.supervisor.snapshot);
});

test("grouped subflow navigation, sync bindings and frame details remain available", () => {
  const env = environment();
  env.app.selectEvent("setup");
  assert.match(env.elements.details.textContent, /sync \(awaited\)/);
  assert.match(env.elements.details.textContent, /settings → settings/);
  env.app.openSubflow("setup");
  assert.equal(env.app.currentScenario, "child-setup");
  assert.deepEqual(Array.from(env.app.breadcrumbs), ["supervisor", "child-setup"]);
  env.app.selectEvent("initialize");
  assert.match(env.elements.details.textContent, /Flow DataType shape/);
  env.app.goBack();
  assert.equal(env.app.currentScenario, "supervisor");
  env.app.selectFrame("process", "parent");
  assert.match(env.elements.details.textContent, /not an observed runtime census/);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
