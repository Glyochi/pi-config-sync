"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");

const scripts = path.join(__dirname, "../scripts");
const fixture = path.join(__dirname, "fixtures/intended-flows.md");
const runtimeFixture = path.join(__dirname, "fixtures/execution-flows.md");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ui-"));
const output = path.join(temp, "flow-graph.html");
const runtimeOutput = path.join(temp, "runtime-flow.html");
const generated = spawnSync("python3", [path.join(scripts, "flow_visualize.py"), fixture, output], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
const runtimeGenerated = spawnSync("python3", [path.join(scripts, "flow_visualize.py"), runtimeFixture, runtimeOutput], { encoding: "utf8" });
assert.equal(runtimeGenerated.status, 0, runtimeGenerated.stderr);
const source = fs.readFileSync(output, "utf8");
const dataMatch = source.match(/<script type="application\/json" id="flow-data">([\s\S]*?)<\/script>/);
const layoutMatch = source.match(/<script type="application\/json" id="layout-info">([\s\S]*?)<\/script>/);
const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(dataMatch && layoutMatch && scriptMatch);
const model = JSON.parse(dataMatch[1]);
const layoutInfo = JSON.parse(layoutMatch[1]);
const appScript = scriptMatch[1];
const runtimeSource = fs.readFileSync(runtimeOutput, "utf8");
const runtimeDataMatch = runtimeSource.match(/<script type="application\/json" id="flow-data">([\s\S]*?)<\/script>/);
const runtimeLayoutMatch = runtimeSource.match(/<script type="application\/json" id="layout-info">([\s\S]*?)<\/script>/);
const runtimeScriptMatch = runtimeSource.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(runtimeDataMatch && runtimeLayoutMatch && runtimeScriptMatch);
const runtimeModel = JSON.parse(runtimeDataMatch[1]);
const runtimeLayoutInfo = JSON.parse(runtimeLayoutMatch[1]);
const runtimeScript = runtimeScriptMatch[1];

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this._text = ""; this.disabled = false; this.checked = false; this.value = "";
    this.className = ""; this.download = ""; this.href = ""; this.clientWidth = 800; this.clientHeight = 600; this.scrollLeft = 0; this.scrollTop = 0;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this._text = ""; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: Number(this.attributes.width) || 1200, height: Number(this.attributes.height) || 800 };
  }
  trigger(name, event = {}) {
    const value = { key: "", button: 0, preventDefault() {}, stopPropagation() {}, ...event };
    (this.listeners[name] || []).forEach((handler) => handler(value));
  }
  click() { this.trigger("click"); }
  remove() {}
}
function environment(flowModel = model, flowScript = appScript, flowLayoutInfo = layoutInfo) {
  const ids = ["flow-data", "layout-info", "scenario-index", "participant-controls", "participant-list", "flow-graph", "graph-shell", "scenario-summary", "details", "back-button", "breadcrumbs", "highlight-mode", "filter-mode", "clear-participants", "save-flow-layout", "layout-status"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element("div")]));
  elements["flow-graph"].getBoundingClientRect = function () { return { left: -elements["graph-shell"].scrollLeft, top: -elements["graph-shell"].scrollTop, width: Number(this.attributes.width) || 1200, height: Number(this.attributes.height) || 800 }; };
  elements["flow-data"].textContent = JSON.stringify(flowModel);
  elements["layout-info"].textContent = JSON.stringify(flowLayoutInfo);
  const listeners = {};
  const downloads = { text: null, filename: null };
  const document = {
    body: new Element("body"),
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return new Element(tag); },
    createElementNS(_namespace, tag) { return new Element(tag); },
  };
  const window = {
    addEventListener(name, handler) { (listeners[name] ||= []).push(handler); },
    dispatch(name, event = {}) { (listeners[name] || []).forEach((handler) => handler(event)); },
  };
  class BlobMock { constructor(parts) { this.parts = parts; } }
  const URL = {
    createObjectURL(blob) { downloads.text = blob.parts.join(""); return "blob:layout"; },
    revokeObjectURL() {},
  };
  const sandbox = { document, window, Blob: BlobMock, URL, setTimeout() { return 0; } };
  const originalCreateElement = document.createElement;
  document.createElement = function (tag) {
    const element = originalCreateElement(tag);
    if (tag === "a") {
      const click = element.click.bind(element);
      element.click = function () { downloads.filename = element.download; click(); };
    }
    return element;
  };
  vm.runInNewContext(flowScript, sandbox, { filename: "flow-ui.js" });
  return { app: window.flowGraphApp, elements, window, downloads };
}
function find(element, predicate, results = []) {
  if (predicate(element)) results.push(element);
  element.children.forEach((child) => find(child, predicate, results));
  return results;
}
function byAttr(element, attr, value) {
  return find(element, (item) => item.getAttribute(attr) === value)[0];
}

test("embedded flow UI parses and has no external resource dependencies", () => {
  new vm.Script(appScript, { filename: "flow-ui.js" });
  assert.match(source, /title="Scroll over the graph to zoom"/);
  assert.match(appScript, /addEventListener\("wheel"/);
  assert.doesNotMatch(source, /id="zoom-(?:in|out|reset)"/);
  assert.doesNotMatch(source, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test("mouse-wheel zoom follows the pointer without changing saved event positions", () => {
  const { app, elements } = environment();
  const graph = elements["flow-graph"], shell = elements["graph-shell"];
  const initialWidth = Number(graph.getAttribute("width")), initialHeight = Number(graph.getAttribute("height"));
  const initialPosition = { ...app.positions["parse-options"] };
  let prevented = false;
  shell.trigger("wheel", { deltaY: -120, deltaMode: 0, clientX: 350, clientY: 260, preventDefault() { prevented = true; } });
  assert.ok(app.zoom > 1, "wheel up zooms in");
  assert.ok(Math.abs(app.zoom - Math.exp(0.6)) < 1e-9, "one 120px wheel notch uses sensitivity 0.005");
  assert.equal(Number(graph.getAttribute("width")), Math.round(initialWidth * app.zoom));
  assert.equal(Number(graph.getAttribute("height")), Math.round(initialHeight * app.zoom));
  assert.ok(shell.scrollLeft > 0, "zoom anchors the graph beneath the pointer");
  assert.ok(prevented, "the wheel is consumed over the graph instead of scrolling the page");
  assert.deepEqual(JSON.parse(JSON.stringify(app.positions["parse-options"])), initialPosition);
  shell.trigger("wheel", { deltaY: 120, deltaMode: 0, clientX: 350, clientY: 260, preventDefault() {} });
  assert.equal(Math.round(app.zoom * 100), 100, "wheel down returns to the original scale");
  assert.equal(Number(graph.getAttribute("width")), initialWidth);
  assert.equal(Number(graph.getAttribute("height")), initialHeight);
  assert.equal(shell.scrollLeft, 0, "zooming back out restores the original scroll position");
});

test("dragging the graph background pans while event nodes retain their drag behavior", () => {
  const { app, elements, window } = environment();
  const shell = elements["graph-shell"], initial = { ...app.positions["parse-options"] };
  shell.scrollLeft = 180; shell.scrollTop = 120;
  shell.trigger("pointerdown", { button: 0, clientX: 400, clientY: 300, target: shell, preventDefault() {} });
  window.dispatch("pointermove", { clientX: 450, clientY: 270, preventDefault() {} });
  assert.equal(shell.scrollLeft, 130);
  assert.equal(shell.scrollTop, 150);
  assert.deepEqual(JSON.parse(JSON.stringify(app.positions["parse-options"])), initial);
  assert.equal(shell.getAttribute("data-panning"), "true");
  window.dispatch("pointerup", {});
  assert.equal(shell.getAttribute("data-panning"), null);

  const eventNode = byAttr(elements["flow-graph"], "data-event-id", "parse-options"), left = shell.scrollLeft;
  shell.trigger("pointerdown", { button: 0, clientX: 400, clientY: 300, target: eventNode, preventDefault() {} });
  window.dispatch("pointermove", { clientX: 500, clientY: 350, preventDefault() {} });
  assert.equal(shell.scrollLeft, left, "an event drag is not treated as background panning");
  window.dispatch("pointerup", {});
});

test("nested subflow navigation supports back and breadcrumb return", () => {
  const { app, elements } = environment();
  assert.equal(app.currentScenario, "cli-startup");
  byAttr(elements["flow-graph"], "data-subflow-target", "client-setup").trigger("click");
  assert.equal(app.currentScenario, "client-setup");
  elements["back-button"].trigger("click");
  const queue = find(elements["scenario-index"], (item) => item.className === "scenario-button" && item.textContent.includes("Queue-triggered service"))[0];
  queue.trigger("click");
  byAttr(elements["flow-graph"], "data-subflow-target", "background-job").trigger("click");
  assert.equal(app.currentScenario, "background-job");
  byAttr(elements["flow-graph"], "data-subflow-target", "inventory-query").trigger("click");
  assert.equal(app.currentScenario, "inventory-query");
  assert.deepEqual(Array.from(app.breadcrumbs), ["queue-consumer", "background-job", "inventory-query"]);
  elements["back-button"].trigger("click");
  assert.equal(app.currentScenario, "background-job");
  elements["back-button"].trigger("click");
  assert.equal(app.currentScenario, "queue-consumer");
  byAttr(elements["flow-graph"], "data-subflow-target", "background-job").trigger("click");
  byAttr(elements["flow-graph"], "data-subflow-target", "inventory-query").trigger("click");
  const queueCrumb = find(elements.breadcrumbs, (item) => item.tag === "button" && item.textContent === "Queue-triggered service")[0];
  queueCrumb.trigger("click");
  assert.equal(app.currentScenario, "queue-consumer");
  assert.equal(elements["back-button"].disabled, true);
});

test("participant-instance highlight/filter state spans scenarios and clear restores all events", () => {
  const { app, elements } = environment();
  const participantBoxes = find(elements["participant-list"], (item) => item.getAttribute("data-participant-key") !== null);
  const worker = participantBoxes.find((item) => item.getAttribute("data-participant-key") === "background-job::worker-instance");
  const retry = participantBoxes.find((item) => item.getAttribute("data-participant-key") === "background-job::retry-worker");
  const consumer = participantBoxes.find((item) => item.getAttribute("data-participant-key") === "queue-consumer::consumer-instance");
  assert.ok(worker && retry && consumer);
  const bg = model.scenarios.find((item) => item.id === "background-job");
  assert.equal(bg.participants.find((item) => item.id === "worker-instance").entity, bg.participants.find((item) => item.id === "retry-worker").entity);
  assert.notEqual(worker.getAttribute("data-participant-key"), retry.getAttribute("data-participant-key"));

  worker.checked = true; worker.trigger("change");
  app.navigateTo("background-job", false);
  let accepted = byAttr(elements["flow-graph"], "data-event-id", "accept-job");
  let finished = byAttr(elements["flow-graph"], "data-event-id", "finish-job");
  assert.match(accepted.getAttribute("class"), /participant-highlight/);
  assert.match(finished.getAttribute("class"), /participant-dim/);
  assert.ok(find(accepted, (item) => (item.getAttribute("class") || "").includes("participant-instance-badge")).length, "event renders an instance badge");
  assert.ok(byAttr(accepted, "data-participant-key", "background-job::worker-instance"), "event is attributed to its instance key");

  retry.checked = true; retry.trigger("change");
  assert.match(byAttr(elements["flow-graph"], "data-event-id", "finish-job").getAttribute("class"), /participant-highlight/);
  retry.checked = false; retry.trigger("change");
  app.selectEvent("finish-job");
  elements["filter-mode"].trigger("click");
  finished = byAttr(elements["flow-graph"], "data-event-id", "finish-job");
  assert.equal(finished.getAttribute("display"), "none");
  assert.match(elements.details.textContent, /Finish processing/, "details remain accessible while the event is filtered");
  assert.equal(byAttr(elements["flow-graph"], "data-link-id", "gap-finish").getAttribute("display"), "none");

  consumer.checked = true; consumer.trigger("change");
  app.navigateTo("queue-consumer", false);
  assert.equal(byAttr(elements["flow-graph"], "data-event-id", "message-arrives").getAttribute("display"), "none");
  assert.notEqual(byAttr(elements["flow-graph"], "data-event-id", "schedule-job").getAttribute("display"), "none");
  assert.equal(consumer.checked, true, "participant selection persists when scenarios change");

  elements["clear-participants"].trigger("click");
  const allEvents = find(elements["flow-graph"], (item) => item.getAttribute("data-event-id") !== null);
  assert.ok(allEvents.length > 0);
  assert.ok(allEvents.every((item) => item.getAttribute("display") === null), "clear returns the complete graph");
  app.selectLink("queue-schedules");
  assert.match(elements.details.textContent, /schedules link/, "typed link details remain available after clearing");
});

test("manual event drag downloads a versioned scenario/event layout sidecar", () => {
  const { app, elements, window, downloads } = environment();
  const positions = app.positions;
  const original = { ...positions["parse-options"] };
  const node = byAttr(elements["flow-graph"], "data-event-id", "parse-options");
  node.trigger("pointerdown", { clientX: original.x, clientY: original.y });
  window.dispatch("pointermove", { clientX: original.x + 90, clientY: original.y + 45 });
  window.dispatch("pointerup");
  assert.equal(app.positions["parse-options"].x, original.x + 90);
  assert.equal(app.positions["parse-options"].y, original.y + 45);

  elements["save-flow-layout"].trigger("click");
  assert.equal(downloads.filename, "flow-graph.layout.json");
  const saved = JSON.parse(downloads.text);
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.scenarios["cli-startup"]["parse-options"], { x: original.x + 90, y: original.y + 45 });
  assert.ok(saved.scenarios["inventory-query"]["send-query"]);
  assert.match(elements["layout-status"].textContent, /Place it beside the HTML/);
  fs.writeFileSync(path.join(temp, downloads.filename), downloads.text, "utf8");
  const regenerated = spawnSync("python3", [path.join(scripts, "flow_visualize.py"), fixture, output], { encoding: "utf8" });
  assert.equal(regenerated.status, 0, regenerated.stderr);
  const regeneratedHtml = fs.readFileSync(output, "utf8");
  const regeneratedData = JSON.parse(regeneratedHtml.split('id="flow-data">')[1].split("</script>")[0]);
  const cli = regeneratedData.scenarios.find((item) => item.id === "cli-startup");
  assert.deepEqual(cli.layout.positions["parse-options"], { x: original.x + 90, y: original.y + 45 });
});

test("event/link details expose contracts, bindings, guards, and sync/async modes", () => {
  const { app, elements } = environment();
  app.selectEvent("initialize-client");
  assert.match(elements.details.textContent, /sync \(awaited\)/);
  assert.match(elements.details.textContent, /settings → settings/);
  app.openSubflow("initialize-client");
  app.selectEvent("read-settings");
  assert.match(elements.details.textContent, /Flow DataType shape/);
  app.navigateTo("cli-startup", false);
  app.selectLink("repeat-scan");
  assert.match(elements.details.textContent, /while arguments remain/);
  assert.match(elements.details.textContent, /Guarded repeat/);
  app.navigateTo("queue-consumer", false);
  app.selectEvent("schedule-job");
  assert.match(elements.details.textContent, /async/);
  assert.match(elements.details.textContent, /work_item → job/);
});

test("version-2 view groups process/thread frames and keeps output offline", () => {
  new vm.Script(runtimeScript, { filename: "flow-runtime-ui.js" });
  assert.equal(runtimeModel.version, 2);
  assert.match(runtimeSource, /title="Scroll over the graph to zoom"/);
  assert.match(runtimeScript, /addEventListener\("wheel"/);
  assert.doesNotMatch(runtimeSource, /id="zoom-(?:in|out|reset)"/);
  assert.match(runtimeSource, /class="runtime-view"/);
  assert.match(runtimeSource, /setAttribute\("id", "thread-list"\)/);
  assert.doesNotMatch(runtimeSource, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//);
  assert.doesNotMatch(runtimeSource, /\bfetch\s*\(/);
  const { app, elements } = environment(runtimeModel, runtimeScript, runtimeLayoutInfo);
  assert.equal(app.currentScenario, "supervisor");
  const main = byAttr(elements["flow-graph"], "data-process-frame", "parent");
  const requestThreads = byAttr(elements["flow-graph"], "data-thread-frame", "requests");
  const contextOnly = byAttr(elements["flow-graph"], "data-thread-frame", "second-main");
  assert.match(main.textContent, /Supervisor process/);
  assert.match(main.textContent, /fixed thread/);
  assert.match(requestThreads.textContent, /0\.\.n threads \(family\)/);
  assert.match(contextOnly.textContent, /Context only · steps not expanded/);
  assert.match(elements["flow-graph"].textContent, /External: Launcher/);
  const constructor = byAttr(elements["flow-graph"], "data-event-id", "construct");
  assert.match(constructor.getAttribute("class"), /action/);
  app.selectEvent("construct");
  assert.match(elements.details.textContent, /Main thread/);
  assert.match(elements.details.textContent, /Supervisor process/);
  app.selectLink("spawn-process");
  assert.match(elements.details.textContent, /starts-child-process link/);
  assert.match(elements.details.textContent, /spawn/);
  assert.match(elements.details.textContent, /does not stop the sender unless waiting is explicitly modeled/);
  const status = byAttr(elements["flow-graph"], "data-link-id", "status-message");
  assert.equal(status.getAttribute("data-link-category"), "message");
  const wake = byAttr(elements["flow-graph"], "data-link-id", "request-wake");
  assert.equal(wake.getAttribute("data-link-category"), "signal");
  app.selectEvent("tick-complete");
  assert.match(elements.details.textContent, /Continue independently of child readiness/);
  app.openSubflow("setup");
  assert.equal(app.currentScenario, "child-setup");
  app.selectEvent("initialize");
  assert.match(elements.details.textContent, /Flow DataType shape/);
  app.goBack();
  assert.equal(app.currentScenario, "supervisor");
  app.selectFrame("thread", "reconciler");
  assert.match(elements.details.textContent, /Supervisor process/);
});

test("version-2 context selection filters steps without hiding frames", () => {
  const { app, elements } = environment(runtimeModel, runtimeScript, runtimeLayoutInfo);
  const thread = byAttr(elements["participant-controls"], "data-thread-key", "supervisor::thread:reconciler");
  thread.checked = true;
  thread.trigger("change");
  assert.match(byAttr(elements["flow-graph"], "data-event-id", "snapshot").getAttribute("class"), /participant-highlight/);
  assert.match(byAttr(elements["flow-graph"], "data-event-id", "construct").getAttribute("class"), /participant-dim/);
  app.setParticipantMode("filter");
  assert.equal(byAttr(elements["flow-graph"], "data-event-id", "construct").getAttribute("display"), "none");
  assert.notEqual(byAttr(elements["flow-graph"], "data-event-id", "snapshot").getAttribute("display"), "none");
  assert.match(find(elements["scenario-summary"], item => item.className === "runtime-note")[0].textContent, /Filtered steps/);
  assert.ok(byAttr(elements["flow-graph"], "data-process-frame", "parent"));
  assert.ok(byAttr(elements["flow-graph"], "data-thread-frame", "second-main"));
  app.clearParticipantSelection();
  assert.equal(byAttr(elements["flow-graph"], "data-event-id", "construct").getAttribute("display"), null);
  const store = byAttr(elements["participant-list"], "data-participant-key", "supervisor::store");
  store.checked = true;
  store.trigger("change");
  assert.match(byAttr(elements["flow-graph"], "data-event-id", "snapshot").getAttribute("class"), /participant-highlight/);
  assert.match(byAttr(elements["flow-graph"], "data-event-id", "construct").getAttribute("class"), /participant-dim/);
});

test("version-2 dragging clamps events to their thread lane and saves layout", () => {
  const { app, elements, window, downloads } = environment(runtimeModel, runtimeScript, runtimeLayoutInfo);
  const scenario = runtimeModel.scenarios.find(item => item.id === "supervisor"), id = "construct", original = { ...app.positions[id] };
  const node = byAttr(elements["flow-graph"], "data-event-id", id);
  node.trigger("pointerdown", { clientX: original.x, clientY: original.y });
  window.dispatch("pointermove", { clientX: original.x + 10000, clientY: original.y + 800 });
  window.dispatch("pointerup");
  const moved = app.positions[id], lane = scenario.layout.lanes.main;
  assert.equal(moved.x, lane.right - 160);
  assert.equal(moved.y, original.y + 800);
  const mainFrame = byAttr(elements["flow-graph"], "data-process-frame", "parent");
  assert.ok(Number(mainFrame.children[0].getAttribute("height")) >= moved.y + 150 - 40);
  elements["save-flow-layout"].trigger("click");
  assert.equal(downloads.filename, "runtime-flow.layout.json");
  const saved = JSON.parse(downloads.text);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.scenarios.supervisor[id])), { x: moved.x, y: moved.y });
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
