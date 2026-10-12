/* Offline version-2 execution-context flow view. */
(function () {
  "use strict";
  const model = JSON.parse(document.getElementById("flow-data").textContent);
  const layoutInfo = JSON.parse(document.getElementById("layout-info").textContent);
  const scenarios = Object.fromEntries(model.scenarios.map(s => [s.id, s]));
  const entities = Object.fromEntries(model.entities.map(e => [e.id, e]));
  const datatypes = Object.fromEntries(model.datatypes.map(d => [d.id, d]));
  const get = id => document.getElementById(id);
  const graph = get("flow-graph"), summary = get("scenario-summary"), details = get("details");
  const index = get("scenario-index"), crumbs = get("breadcrumbs"), back = get("back-button");
  const participantList = get("participant-list"), layoutStatus = get("layout-status");
  document.body.className = "runtime-view";
  graph.setAttribute("aria-label", "Process and thread frames with top-to-bottom execution paths");
  let current = null, history = [], selectedEvent = null, selectedLink = null, selectedFrame = null;
  let mode = "highlight", selection = new Set(), dragging = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }
  function text(parent, cls, value, attrs) {
    const node = svg("text", { class: cls, ...attrs });
    node.textContent = value;
    parent.appendChild(node);
    return node;
  }
  function row(list, name, value) {
    if (value === undefined || value === null || value === "") return;
    list.appendChild(el("dt", "", name));
    list.appendChild(el("dd", "", value));
  }
  const trim = (value, limit = 45) => String(value).length > limit ? String(value).slice(0, limit - 1) + "…" : String(value);
  function wrap(value, limit = 31) {
    const lines = [""];
    String(value).split(/\s+/).forEach(word => {
      const n = lines.length - 1, next = lines[n] ? lines[n] + " " + word : word;
      if (next.length > limit && lines[n] && lines.length < 2) lines.push(word);
      else lines[n] = next;
    });
    return lines.map(line => trim(line, limit + 2));
  }
  const participantKey = (s, id) => s.id + "::" + id;
  const threadKey = (s, id) => s.id + "::thread:" + id;
  const chosen = (s, e) => selection.has(participantKey(s, e.participant)) || selection.has(threadKey(s, e.thread));
  const visible = (s, e) => mode !== "filter" || !selection.size || chosen(s, e);
  const eventMap = s => Object.fromEntries(s.events.map(e => [e.id, e]));
  function participantLabel(s, e) {
    const p = s.participants.find(p => p.id === e.participant);
    return p.name + (p.kind === "external" ? " · external" : "");
  }
  function countText(count, noun) {
    return typeof count === "number" ? `${count} ${noun}${count === 1 ? "" : "s"}` : `${count} ${noun}s (family)`;
  }
  function threadCounts(threads) {
    const fixed = threads.reduce((sum, t) => sum + (typeof t.count === "number" ? t.count : 0), 0);
    const families = threads.filter(t => typeof t.count !== "number");
    return `${fixed} fixed thread${fixed === 1 ? "" : "s"}` + families.map(t => ` + ${t.count} ${t.name}`).join("");
  }

  const threadControls = el("section", "", "");
  threadControls.setAttribute("id", "thread-controls");
  threadControls.appendChild(el("h3", "", "Execution threads"));
  const threadList = el("div");
  threadList.setAttribute("id", "thread-list");
  threadControls.appendChild(threadList);
  get("participant-controls").appendChild(threadControls);
  function checkbox(list, key, labelText, attr) {
    const label = el("label", "participant-option"), box = el("input");
    box.type = "checkbox";
    box.checked = selection.has(key);
    box.setAttribute(attr, key);
    box.addEventListener("change", () => {
      if (box.checked) selection.add(key); else selection.delete(key);
      if (current) { renderGraph(scenarios[current]); updateSummary(scenarios[current]); }
    });
    label.appendChild(box);
    label.appendChild(el("span", "", labelText));
    list.appendChild(label);
  }
  function updateControls() {
    participantList.replaceChildren();
    threadList.replaceChildren();
    model.scenarios.forEach(s => {
      s.participants.forEach(p => checkbox(participantList, participantKey(s, p.id), `${p.name} — ${s.title}`, "data-participant-key"));
      s.threads.forEach(t => checkbox(threadList, threadKey(s, t.id), `${t.name} — ${s.title}`, "data-thread-key"));
    });
    ["highlight", "filter"].forEach(value => {
      get(value + "-mode").className = mode === value ? "active" : "";
      get(value + "-mode").setAttribute("aria-pressed", mode === value);
    });
  }
  function setParticipantMode(value) {
    if (!["highlight", "filter"].includes(value)) return;
    mode = value;
    updateControls();
    if (current) { renderGraph(scenarios[current]); updateSummary(scenarios[current]); }
  }
  function clearParticipantSelection() {
    selection = new Set(); mode = "highlight";
    updateControls();
    if (current) { renderGraph(scenarios[current]); updateSummary(scenarios[current]); }
  }
  function updateIndex() {
    index.replaceChildren();
    model.scenarios.forEach(s => {
      const button = el("button", "scenario-button" + (s.id === current ? " active" : ""));
      button.appendChild(el("span", "", s.title));
      button.appendChild(el("span", "scenario-role", s.entrypoint ? "Entrypoint" : "Linked subflow"));
      button.addEventListener("click", () => navigateTo(s.id, false));
      index.appendChild(button);
    });
  }
  function updateCrumbs() {
    crumbs.replaceChildren();
    const chain = history.concat(current ? [current] : []);
    chain.forEach((id, n) => {
      if (n) crumbs.appendChild(el("span", "", "›"));
      const button = el("button", "", scenarios[id].title);
      if (n === chain.length - 1) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => { history = chain.slice(0, n); render(id); });
      crumbs.appendChild(button);
    });
    back.disabled = !history.length;
  }
  function updateSummary(s) {
    summary.replaceChildren();
    summary.appendChild(el("h2", "", s.title));
    summary.appendChild(el("p", "", s.description));
    const fixed = s.processes.reduce((sum, p) => sum + (typeof p.count === "number" ? p.count : 0), 0);
    const families = s.processes.filter(p => typeof p.count !== "number").length;
    summary.appendChild(el("div", "runtime-counts", `Modeled contexts: ${fixed} fixed process instances` + (families ? ` + ${families} process families` : "") + "; " + threadCounts(s.threads) + " per represented process frames."));
    summary.appendChild(el("p", "runtime-note", mode === "filter" && selection.size ? "Filtered steps; all declared frames and counts remain visible. This is not a complete runtime census." : "Declared application contexts, not an observed runtime census. Helper threads/processes are excluded."));
    const legend = el("div", "runtime-legend");
    [["sequence", "Execution order"], ["spawn", "Process/thread spawn"], ["message", "Message"], ["signal", "Wake/signal"], ["loop", "Execution repeat"]].forEach(([category, title]) => {
      const item = el("span");
      item.appendChild(el("i", "legend-line " + category));
      item.appendChild(el("span", "", title));
      legend.appendChild(item);
    });
    summary.appendChild(legend);
  }
  function fit(s) {
    s.layout.frames.threads.forEach(frame => {
      const points = s.events.filter(e => e.thread === frame.id).map(e => s.layout.positions[e.id]);
      frame.bottom = Math.max(frame.top + 240, ...points.map(p => p.y + 150));
    });
    s.layout.frames.processes.forEach(frame => {
      const children = s.layout.frames.threads.filter(t => t.process === frame.id);
      frame.bottom = Math.max(420, ...children.map(t => t.bottom + 30));
    });
    s.layout.height = Math.max(500, ...s.layout.frames.processes.map(p => p.bottom + 40), ...Object.values(s.layout.positions).map(p => p.y + 150));
  }
  function frameGroup(type, record, bounds, caption, cls = "") {
    const group = svg("g", { class: type + "-frame " + cls, ["data-" + type + "-frame"]: record.id });
    group.appendChild(svg("rect", { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }));
    const header = svg("g", { class: "frame-header", tabindex: 0, role: "button", "aria-label": type + ": " + record.name });
    text(header, type + "-label", trim(record.name, Math.floor((bounds.right - bounds.left - 40) / (type === "process" ? 9 : 7))), { x: bounds.left + 16, y: bounds.top + 26 });
    text(header, "frame-meta", caption, { x: bounds.left + 16, y: bounds.top + 47 });
    const select = () => selectFrame(type, record.id);
    header.addEventListener("click", select);
    header.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
    group.appendChild(header);
    return group;
  }
  function renderFrames(s) {
    s.processes.forEach(process => {
      const bounds = s.layout.frames.processes.find(f => f.id === process.id);
      const threads = s.threads.filter(t => t.process === process.id);
      const group = frameGroup("process", process, bounds, countText(process.count, "process") + " · per instance: " + threadCounts(threads), selectedFrame === "process:" + process.id ? "selected" : "");
      threads.forEach(thread => {
        const box = s.layout.frames.threads.find(f => f.id === thread.id);
        const events = s.events.filter(e => e.thread === thread.id);
        const shown = events.filter(e => visible(s, e)).length;
        let cls = box.context_only ? "context-only" : "";
        if (selectedFrame === "thread:" + thread.id) cls += " selected";
        if (selection.size && mode === "highlight") cls += selection.has(threadKey(s, thread.id)) || events.some(e => chosen(s, e)) ? " participant-highlight" : " participant-dim";
        const label = countText(thread.count, "thread") + " · " + thread.role + (thread.daemon === undefined ? "" : thread.daemon ? " · daemon" : " · non-daemon");
        const inner = frameGroup("thread", thread, box, label, cls);
        text(inner, "frame-caption", events.length ? `${shown}/${events.length} steps visible` : "Context only · steps not expanded", { x: box.left + 16, y: box.top + 66 });
        group.appendChild(inner);
      });
      graph.appendChild(group);
    });
    s.participants.filter(p => p.kind === "external").forEach(p => {
      const lane = s.layout.lanes["external:" + p.id];
      text(graph, "thread-label", "External: " + p.name, { x: lane.left + 15, y: lane.top + 26 });
    });
  }
  function route(s, link, number) {
    const map = eventMap(s), source = map[link.source], target = map[link.target];
    const a = s.layout.positions[source.id], b = s.layout.positions[target.id];
    const laneA = s.layout.lanes[source.thread || "external:" + source.participant];
    const laneB = s.layout.lanes[target.thread || "external:" + target.participant];
    if (link.category === "sequence") {
      if (link.loop) {
        const gutter = laneA.right - 22 - (number % 2) * 10;
        if (source.id === target.id) {
          return { d: `M ${a.x + 130} ${a.y} L ${gutter} ${a.y} L ${gutter} ${a.y + 120} L ${a.x} ${a.y + 120} L ${a.x} ${a.y + 76}`, x: gutter - 6, y: a.y + 105, anchor: "end" };
        }
        return { d: `M ${a.x + 130} ${a.y} L ${gutter} ${a.y} L ${gutter} ${b.y} L ${b.x + 130} ${b.y}`, x: gutter - 6, y: (a.y + b.y) / 2, anchor: "end" };
      }
      const y1 = a.y + (source.kind === "decision" ? 86 : 76), y2 = b.y - (target.kind === "decision" ? 86 : 76);
      const mid = (y1 + y2) / 2;
      return { d: `M ${a.x} ${y1} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${y2}`, x: (a.x + b.x) / 2 + 9, y: mid, anchor: "start" };
    }
    const right = b.x >= a.x, x1 = a.x + (right ? 130 : -130), x2 = b.x + (right ? -130 : 130);
    const gutterA = right ? laneA.right - 18 : laneA.left + 18;
    const gutterB = right ? laneB.left + 18 : laneB.right - 18;
    const channel = a.y + 110 + (number % 3) * 7;
    return { d: `M ${x1} ${a.y} L ${gutterA} ${a.y} L ${gutterA} ${channel} L ${gutterB} ${channel} L ${gutterB} ${b.y} L ${x2} ${b.y}`, x: (gutterA + gutterB) / 2, y: channel - 6, anchor: "middle" };
  }
  function renderLinks(s) {
    const map = eventMap(s);
    s.links.forEach((link, number) => {
      const a = map[link.source], b = map[link.target], geometry = route(s, link, number);
      let cls = "flow-link" + (link.id === selectedLink ? " selected" : "");
      if (selection.size && mode === "highlight") cls += chosen(s, a) || chosen(s, b) ? " participant-highlight" : " participant-dim";
      const group = svg("g", { class: cls, "data-link-id": link.id, "data-link-category": link.category, tabindex: 0, role: "button", "aria-label": link.category + ": " + link.type });
      if (!visible(s, a) || !visible(s, b)) group.setAttribute("display", "none");
      group.appendChild(svg("path", { class: "edge-hit", d: geometry.d }));
      group.appendChild(svg("path", { class: "edge-path " + link.category + (link.loop ? " loop" : ""), d: geometry.d, stroke: link.color }));
      const lines = [trim(link.label || link.type.replace(/-/g, " "), 43)];
      if (link.guard) lines.push(trim((link.loop ? "↻ " : "") + link.guard, 43));
      lines.forEach((line, n) => text(group, "edge-label", line, { x: geometry.x, y: geometry.y + n * 13, "text-anchor": geometry.anchor }));
      group.addEventListener("click", () => selectLink(link.id));
      group.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectLink(link.id); } });
      graph.appendChild(group);
    });
  }
  function renderEvent(s, event) {
    const p = s.layout.positions[event.id];
    let cls = "event-node " + event.kind + (event.id === selectedEvent ? " selected" : "");
    if (selection.size && mode === "highlight") cls += chosen(s, event) ? " participant-highlight" : " participant-dim";
    const group = svg("g", { class: cls, "data-event-id": event.id, "data-participant-key": participantKey(s, event.participant), "data-execution-thread": event.thread || "external", tabindex: 0, role: "button", "aria-label": event.title + ", " + participantLabel(s, event) });
    if (!visible(s, event)) group.setAttribute("display", "none");
    if (event.kind === "decision") {
      group.appendChild(svg("polygon", { class: "event-shape", points: `${p.x},${p.y - 86} ${p.x + 130},${p.y} ${p.x},${p.y + 86} ${p.x - 130},${p.y}` }));
      text(group, "event-kind", "DECISION", { x: p.x, y: p.y - 53, "text-anchor": "middle" });
      wrap(event.title, 25).forEach((line, n) => text(group, "event-title", line, { x: p.x, y: p.y - 8 + n * 18, "text-anchor": "middle" }));
    } else {
      group.appendChild(svg("rect", { class: "event-shape", x: p.x - 130, y: p.y - 76, width: 260, height: 152 }));
      text(group, "event-id", trim(event.id, 25), { x: p.x - 116, y: p.y - 55 });
      text(group, "event-kind", event.kind === "subflow" ? event.mode.toUpperCase() + " SUBFLOW" : event.kind.toUpperCase(), { x: p.x + 116, y: p.y - 55, "text-anchor": "end" });
      wrap(event.title).forEach((line, n) => text(group, "event-title", line, { x: p.x - 116, y: p.y - 29 + n * 17 }));
      const badge = svg("g", { class: "participant-instance-badge", "data-participant-key": participantKey(s, event.participant) });
      badge.appendChild(svg("rect", { x: p.x - 116, y: p.y + 2, width: 232, height: 21 }));
      text(badge, "event-owner", trim(participantLabel(s, event), 39), { x: p.x - 106, y: p.y + 16 });
      group.appendChild(badge);
      const meta = event.kind === "gap" ? "Unexplored behavior" : event.contract_name ? "Shape: " + event.contract_name : event.timing || event.delivery || "";
      text(group, "event-meta", trim(meta, 38), { x: p.x - 116, y: p.y + 38 });
    }
    group.addEventListener("click", () => selectEvent(event.id));
    group.addEventListener("pointerdown", e => beginDrag(e, event.id));
    group.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectEvent(event.id); } });
    graph.appendChild(group);
    if (event.kind === "subflow" && visible(s, event)) {
      const button = svg("g", { class: "subflow-button", "data-subflow-target": event.subflow, tabindex: 0, role: "button", "aria-label": "Open subflow " + event.subflow_title });
      button.appendChild(svg("rect", { x: p.x - 102, y: p.y + 47, width: 204, height: 22 }));
      text(button, "", trim("Open: " + event.subflow_title, 28), { x: p.x, y: p.y + 62, "text-anchor": "middle" });
      button.addEventListener("click", e => { e.stopPropagation(); openSubflow(event.id); });
      button.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSubflow(event.id); } });
      graph.appendChild(button);
    }
  }
  function renderGraph(s) {
    fit(s);
    graph.replaceChildren();
    graph.setAttribute("viewBox", `0 0 ${s.layout.width} ${s.layout.height}`);
    graph.setAttribute("width", s.layout.width); graph.setAttribute("height", s.layout.height);
    const defs = svg("defs"), marker = svg("marker", { id: "flow-arrow", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    marker.appendChild(svg("path", { d: "M0,0 L8,4 L0,8 z", fill: "context-stroke" }));
    defs.appendChild(marker); graph.appendChild(defs);
    renderFrames(s); renderLinks(s); s.events.forEach(event => renderEvent(s, event));
  }
  function render(id) {
    if (!scenarios[id]) return;
    current = id; selectedEvent = selectedLink = selectedFrame = null;
    renderGraph(scenarios[id]); updateSummary(scenarios[id]); updateIndex(); updateControls(); updateCrumbs();
    details.replaceChildren(el("p", "note", "Select an event, link, or frame. Steps belong to their executing thread; components are not additional threads."));
  }
  function navigateTo(id, push) {
    if (!scenarios[id]) return;
    if (push && current) history.push(current); else if (!push) history = [];
    render(id);
  }
  function openSubflow(eventId) {
    const event = eventMap(scenarios[current])[eventId];
    if (event && event.kind === "subflow") navigateTo(event.subflow, true);
  }
  function goBack() { if (history.length) render(history.pop()); }
  function selectEvent(id) {
    const s = scenarios[current], event = eventMap(s)[id];
    if (!event) return;
    selectedEvent = id; selectedLink = selectedFrame = null; renderGraph(s);
    details.replaceChildren(el("h3", "", event.title), el("span", "badge", event.kind));
    if (event.description) details.appendChild(el("p", "", event.description));
    const list = el("dl"), participant = s.participants.find(p => p.id === event.participant);
    row(list, "Participant", participantLabel(s, event)); row(list, "Event ID", event.id);
    if (event.thread) {
      const thread = s.threads.find(t => t.id === event.thread), process = s.processes.find(p => p.id === thread.process);
      row(list, "Thread", thread.name); row(list, "Process", process.name);
    } else row(list, "Context", "External actor");
    row(list, "Timing", event.timing); row(list, "Delivery", event.delivery); details.appendChild(list);
    if (event.contract) {
      const datatype = datatypes[event.contract];
      details.appendChild(el("h4", "", "Flow DataType shape · " + datatype.name));
      details.appendChild(el("p", "", datatype.summary));
      const fields = el("ul");
      datatype.fields.forEach(field => fields.appendChild(el("li", "", `${field.name}: ${field.type} (${field.required ? "required" : "optional"})`)));
      details.appendChild(fields);
    }
    if (event.kind === "decision") {
      details.appendChild(el("h4", "", "Guarded branches"));
      const branches = el("ul");
      s.links.filter(l => l.source === id && !l.loop).forEach(l => branches.appendChild(el("li", "", l.guard + " · " + l.type)));
      details.appendChild(branches);
    }
    if (event.kind === "join") details.appendChild(el("p", "", `Explicit join after ${event.join_input_count} incoming causal links.`));
    if (event.kind === "gap") details.appendChild(el("p", "", "Open question: " + event.open_question));
    if (event.kind === "subflow") {
      details.appendChild(el("h4", "", "Invokes " + event.subflow_title + " · " + (event.mode === "sync" ? "sync (awaited)" : "async (not awaited)")));
      const bindings = el("ul");
      event.bindings.forEach(b => bindings.appendChild(el("li", "", `${b.direction}: ${b.source} → ${b.target} · ${b.datatype_name}`)));
      details.appendChild(bindings);
      const open = el("button", "detail-action", "Open subflow: " + event.subflow_title);
      open.addEventListener("click", () => openSubflow(id)); details.appendChild(open);
    }
    if (participant.entity) {
      const entity = entities[participant.entity];
      details.appendChild(el("h4", "", "Flow Entity · " + entity.name)); details.appendChild(el("p", "", entity.summary));
      if (entity.code_refs.length) details.appendChild(el("p", "note", "Code navigation hints (not verification): " + entity.code_refs.join(", ")));
    }
  }
  function selectLink(id) {
    const s = scenarios[current], link = s.links.find(l => l.id === id);
    if (!link) return;
    selectedLink = id; selectedEvent = selectedFrame = null; renderGraph(s);
    details.replaceChildren(el("h3", "", link.type + " link"));
    const list = el("dl"), events = eventMap(s);
    row(list, "Category", link.category); row(list, "From", events[link.source].title); row(list, "To", events[link.target].title);
    row(list, "Label", link.label); row(list, "Guard", link.guard); row(list, "Repeat", link.loop ? "Guarded repeat" : "No");
    row(list, "Timing", link.timing); row(list, "Delivery", link.delivery); details.appendChild(list);
    if (link.category !== "sequence") details.appendChild(el("p", "note", "An interaction crosses contexts; it does not stop the sender unless waiting is explicitly modeled."));
  }
  function selectFrame(type, id) {
    const s = scenarios[current], record = s[type === "process" ? "processes" : "threads"].find(x => x.id === id);
    if (!record) return;
    selectedFrame = type + ":" + id; selectedEvent = selectedLink = null; renderGraph(s);
    details.replaceChildren(el("h3", "", record.name), el("span", "badge", type));
    if (record.description) details.appendChild(el("p", "", record.description));
    details.appendChild(el("p", "", countText(record.count, type)));
    if (type === "process") details.appendChild(el("p", "", "Per process instance: " + threadCounts(s.threads.filter(t => t.process === id))));
    else details.appendChild(el("p", "", "Owner: " + s.processes.find(p => p.id === record.process).name));
    details.appendChild(el("p", "note", "Counts describe modeled contexts, not an observed runtime census. Empty frames are deliberately unexpanded context, not unknown gaps."));
  }
  function graphPoint(event, s) {
    const rect = graph.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * s.layout.width / (rect.width || s.layout.width), y: (event.clientY - rect.top) * s.layout.height / (rect.height || s.layout.height) };
  }
  function beginDrag(event, id) {
    if (event.button !== undefined && event.button !== 0) return;
    const s = scenarios[current], point = graphPoint(event, s), p = s.layout.positions[id];
    dragging = { scenario: current, id, dx: p.x - point.x, dy: p.y - point.y };
  }
  function moveDrag(event) {
    if (!dragging) return;
    const s = scenarios[dragging.scenario], node = eventMap(s)[dragging.id], point = graphPoint(event, s);
    const lane = s.layout.lanes[node.thread || "external:" + node.participant];
    s.layout.positions[node.id] = { x: Math.max(lane.left + 160, Math.min(lane.right - 160, point.x + dragging.dx)), y: Math.max(s.layout.first_row, Math.min(1000000, point.y + dragging.dy)) };
    renderGraph(s);
  }
  function saveLayout() {
    const data = { version: layoutInfo.version, scenarios: {} };
    model.scenarios.forEach(s => { data.scenarios[s.id] = JSON.parse(JSON.stringify(s.layout.positions)); });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob), link = el("a");
    link.href = url; link.download = layoutInfo.filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    layoutStatus.textContent = "Downloaded " + layoutInfo.filename + ". Place it beside the HTML before regenerating.";
  }
  get("highlight-mode").addEventListener("click", () => setParticipantMode("highlight"));
  get("filter-mode").addEventListener("click", () => setParticipantMode("filter"));
  get("clear-participants").addEventListener("click", clearParticipantSelection);
  get("save-flow-layout").addEventListener("click", saveLayout);
  back.addEventListener("click", goBack);
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", () => { dragging = null; });
  window.addEventListener("pointercancel", () => { dragging = null; });
  const root = model.scenarios.find(s => s.entrypoint);
  render(root ? root.id : model.scenarios[0].id);
  window.flowGraphApp = {
    navigateTo, openSubflow, goBack, selectEvent, selectLink, selectFrame, setParticipantMode, clearParticipantSelection,
    get currentScenario() { return current; }, get breadcrumbs() { return history.concat(current ? [current] : []); },
    get positions() { return scenarios[current].layout.positions; }, get frames() { return scenarios[current].layout.frames; }
  };
})();
