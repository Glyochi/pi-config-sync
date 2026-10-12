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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ui-"));
const output = path.join(temp, "flow-graph.html");
const generated = spawnSync("python3", [path.join(scripts, "flow_visualize.py"), fixture, output], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
const source = fs.readFileSync(output, "utf8");
const dataMatch = source.match(/<script type="application\/json" id="flow-data">([\s\S]*?)<\/script>/);
const layoutMatch = source.match(/<script type="application\/json" id="layout-info">([\s\S]*?)<\/script>/);
const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(dataMatch && layoutMatch && scriptMatch);
const model = JSON.parse(dataMatch[1]);
const layoutInfo = JSON.parse(layoutMatch[1]);
const appScript = scriptMatch[1];

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this._text = ""; this.disabled = false; this.checked = false; this.value = "";
    this.className = ""; this.download = ""; this.href = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this._text = ""; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
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
function environment() {
  const ids = ["flow-data", "layout-info", "scenario-index", "participant-list", "flow-graph", "scenario-summary", "details", "back-button", "breadcrumbs", "highlight-mode", "filter-mode", "clear-participants", "save-flow-layout", "layout-status"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element("div")]));
  elements["flow-data"].textContent = JSON.stringify(model);
  elements["layout-info"].textContent = JSON.stringify(layoutInfo);
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
  vm.runInNewContext(appScript, sandbox, { filename: "flow-ui.js" });
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
  assert.doesNotMatch(source, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
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

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
