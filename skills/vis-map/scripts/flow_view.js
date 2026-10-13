/* Offline interactive viewer for compact Markdown scenarios. */
(function () {
  "use strict";
  const model = JSON.parse(document.getElementById("flow-data").textContent);
  const layoutInfo = JSON.parse(document.getElementById("layout-info").textContent);
  const scenarios = Object.fromEntries(model.scenarios.map(s => [s.id, s]));
  const get = id => document.getElementById(id);
  const graph = get("flow-graph"), shell = get("graph-shell");
  const summary = get("scenario-summary"), details = get("details");
  const index = get("scenario-index"), crumbs = get("breadcrumbs"), back = get("back-button");
  const layoutStatus = get("layout-status");
  let current = null, history = [], selectedStep = null, selectedLink = null, selectedFrame = null;
  let dragging = null, panning = null, zoom = 1, panX = 0, panY = 0;
  const MIN_ZOOM = 0.4, MAX_ZOOM = 3, NODE_WIDTH = 260, NODE_HEIGHT = 116;
  const FRAME_PADDING = 22 * 4, FRAME_NESTING_GAP = 12 * 4;
  const MIN_X = 180, MIN_Y = 160, MAX_COORD = 1000000;

  function el(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }
  function text(parent, cls, value, attrs = {}) {
    const node = svg("text", { class: cls, ...attrs });
    node.textContent = String(value);
    parent.appendChild(node);
    return node;
  }
  function row(list, name, value) {
    if (value === undefined || value === null || value === "") return;
    list.appendChild(el("dt", "", name));
    list.appendChild(el("dd", "", value));
  }
  function trim(value, limit = 42) {
    const string = String(value);
    return string.length > limit ? string.slice(0, limit - 1) + "…" : string;
  }
  function wrap(value, limit = 31) {
    const lines = [""];
    String(value).split(/\s+/).forEach(word => {
      const index = lines.length - 1;
      const next = lines[index] ? lines[index] + " " + word : word;
      if (next.length > limit && lines[index] && lines.length < 2) lines.push(word);
      else lines[index] = next;
    });
    return lines.map(line => trim(line, limit + 2));
  }
  function eventMap(s) { return Object.fromEntries(s.events.map(event => [event.id, event])); }
  function groupMap(s) { return Object.fromEntries(s.groups.map(group => [group.id, group])); }
  function minimumStepPosition(s, id) {
    const maxDepth = Math.max(0, ...s.groups.map(group => group.depth));
    const padding = Math.max(0, ...s.groups
      .filter(group => group.step_ids.includes(id))
      .map(group => FRAME_PADDING + (maxDepth - group.depth) * FRAME_NESTING_GAP));
    return {
      x: Math.max(MIN_X, 60 + NODE_WIDTH / 2 + padding),
      y: Math.max(MIN_Y, 60 + NODE_HEIGHT / 2 + padding + 34),
    };
  }
  function outgoing(s, id) { return s.links.filter(link => link.source === id); }
  function groupPath(s, groupId) {
    const groups = groupMap(s), names = [];
    while (groupId && groups[groupId]) {
      names.unshift(groups[groupId].name);
      groupId = groups[groupId].parent;
    }
    return names.join(" / ");
  }

  function refit(s) {
    const groups = groupMap(s), maxDepth = Math.max(0, ...s.groups.map(group => group.depth));
    s.layout.frames = s.groups.map(group => {
      const points = group.step_ids.map(id => s.layout.positions[id]).filter(Boolean);
      if (!points.length) return null;
      const padding = FRAME_PADDING + (maxDepth - group.depth) * FRAME_NESTING_GAP;
      return {
        id: group.id, name: group.name, parent: group.parent, depth: group.depth,
        step_ids: group.step_ids.slice(),
        left: Math.min(...points.map(point => point.x - NODE_WIDTH / 2)) - padding,
        right: Math.max(...points.map(point => point.x + NODE_WIDTH / 2)) + padding,
        top: Math.min(...points.map(point => point.y - NODE_HEIGHT / 2)) - padding - 34,
        bottom: Math.max(...points.map(point => point.y + NODE_HEIGHT / 2)) + padding,
      };
    }).filter(Boolean).sort((a, b) => a.depth - b.depth);
    const points = Object.values(s.layout.positions);
    s.layout.width = Math.max(700, ...points.map(point => point.x + NODE_WIDTH / 2 + 60),
      ...s.layout.frames.map(frame => frame.right + 40));
    s.layout.height = Math.max(500, ...points.map(point => point.y + NODE_HEIGHT / 2 + 60),
      ...s.layout.frames.map(frame => frame.bottom + 40));
    return groups;
  }

  function updateIndex() {
    index.replaceChildren();
    model.scenarios.forEach(s => {
      const button = el("button", "scenario-button" + (s.id === current ? " active" : ""));
      button.type = "button";
      button.appendChild(el("span", "", s.title));
      if (!s.entrypoint) button.appendChild(el("span", "scenario-role", "Linked subscenario"));
      button.addEventListener("click", () => navigateTo(s.id, false));
      index.appendChild(button);
    });
  }
  function updateCrumbs() {
    crumbs.replaceChildren();
    const chain = history.concat(current ? [current] : []);
    chain.forEach((id, i) => {
      if (i) crumbs.appendChild(el("span", "", "›"));
      const button = el("button", "", scenarios[id].title);
      if (i === chain.length - 1) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => { history = chain.slice(0, i); render(id); });
      crumbs.appendChild(button);
    });
    back.disabled = history.length === 0;
  }
  function updateSummary(s) {
    summary.replaceChildren();
    summary.appendChild(el("h2", "", s.title));
    if (s.description) summary.appendChild(el("p", "", s.description));
  }
  function frameGroup(frame) {
    const selected = selectedFrame === frame.id ? " selected" : "";
    const group = svg("g", { class: "flow-frame" + selected, "data-frame-id": frame.id });
    group.appendChild(svg("rect", { x: frame.left, y: frame.top, width: frame.right - frame.left,
      height: frame.bottom - frame.top, rx: 12 }));
    const header = svg("g", { class: "frame-header", tabindex: 0, role: "button",
      "aria-label": "Frame: " + frame.name, "data-frame-header": frame.id });
    text(header, "frame-label", trim(frame.name, Math.floor((frame.right - frame.left - 32) / 8)),
      { x: frame.left + 14, y: frame.top + 24 });
    header.addEventListener("click", () => selectFrame(frame.id));
    header.addEventListener("pointerdown", event => beginFrameDrag(event, frame.id));
    header.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectFrame(frame.id); }
    });
    group.appendChild(header);
    graph.appendChild(group);
  }
  function eventPosition(s, id) { return s.layout.positions[id]; }
  function routeLink(s, link, number) {
    const events = eventMap(s), source = events[link.source], target = events[link.target];
    const a = eventPosition(s, source.id), b = eventPosition(s, target.id);
    if (link.repeat) {
      if (source.id === target.id) {
        const x = a.x + NODE_WIDTH / 2 + 42 + (number % 3) * 12;
        return { d: `M ${a.x + NODE_WIDTH / 2} ${a.y} C ${x} ${a.y - 110}, ${x} ${a.y + 110}, ${a.x + NODE_WIDTH / 2} ${a.y + 12}`,
          x: x + 4, y: a.y - 52 };
      }
      const midX = (a.x + b.x) / 2;
      const archY = Math.min(a.y, b.y) - 100 - (number % 3) * 16;
      const startX = a.x + (b.x >= a.x ? NODE_WIDTH / 2 : -NODE_WIDTH / 2);
      const endX = b.x + (b.x >= a.x ? -NODE_WIDTH / 2 : NODE_WIDTH / 2);
      return { d: `M ${startX} ${a.y} C ${midX} ${archY}, ${midX} ${archY}, ${endX} ${b.y}`,
        x: midX, y: archY - 4 };
    }
    const right = b.x >= a.x;
    const startX = a.x + (right ? NODE_WIDTH / 2 : -NODE_WIDTH / 2);
    const endX = b.x + (right ? -NODE_WIDTH / 2 : NODE_WIDTH / 2);
    const control = Math.max(48, Math.abs(endX - startX) * 0.42);
    const c1 = startX + (right ? control : -control), c2 = endX - (right ? control : -control);
    return { d: `M ${startX} ${a.y} C ${c1} ${a.y}, ${c2} ${b.y}, ${endX} ${b.y}`,
      x: (startX + endX) / 2, y: (a.y + b.y) / 2 - 8 };
  }
  function renderLinks(s) {
    s.links.forEach((link, number) => {
      if (!link.target) return; // Subscenario links are opened from their source step.
      const route = routeLink(s, link, number);
      const group = svg("g", { class: "flow-link" + (link.id === selectedLink ? " selected" : ""),
        "data-link-id": link.id, tabindex: 0, role: "button", "aria-label": link.label || "Step connection" });
      group.appendChild(svg("path", { class: "edge-hit", d: route.d }));
      group.appendChild(svg("path", { class: "edge-path" + (link.repeat ? " repeat" : ""), d: route.d }));
      if (link.label) text(group, "edge-label", trim(link.label, 48),
        { x: route.x, y: route.y, "text-anchor": "middle" });
      group.addEventListener("click", () => selectLink(link.id));
      group.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectLink(link.id); }
      });
      graph.appendChild(group);
    });
  }
  function renderStep(s, step) {
    const point = eventPosition(s, step.id);
    const group = svg("g", { class: "flow-step" + (step.id === selectedStep ? " selected" : ""),
      "data-step-id": step.id, tabindex: 0, role: "button", "aria-label": step.title });
    group.appendChild(svg("rect", { class: "step-shape", x: point.x - NODE_WIDTH / 2,
      y: point.y - NODE_HEIGHT / 2, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 12 }));
    wrap(step.title).forEach((line, index) => text(group, "step-title", line,
      { x: point.x - NODE_WIDTH / 2 + 14, y: point.y - 18 + index * 18 }));
    if (step.actor) text(group, "step-actor", step.actor,
      { x: point.x - NODE_WIDTH / 2 + 14, y: point.y + 39 });
    group.addEventListener("click", () => selectStep(step.id));
    group.addEventListener("pointerdown", event => beginStepDrag(event, step.id));
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectStep(step.id); }
    });
    graph.appendChild(group);

    const targets = outgoing(s, step.id).filter(link => link.target_scenario);
    targets.forEach((link, index) => {
      const button = svg("g", { class: "subscenario-button", tabindex: 0, role: "button",
        "data-subscenario-target": link.target_scenario,
        "aria-label": "Open scenario " + link.scenario_title });
      const y = point.y + NODE_HEIGHT / 2 + 8 + index * 26;
      button.appendChild(svg("rect", { x: point.x - 104, y, width: 208, height: 22, rx: 4 }));
      text(button, "", trim("Open: " + link.scenario_title, 30),
        { x: point.x, y: y + 15, "text-anchor": "middle" });
      button.addEventListener("click", event => { event.stopPropagation(); openScenario(link.target_scenario); });
      button.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openScenario(link.target_scenario); }
      });
      graph.appendChild(button);
    });
  }
  function renderGraph(s) {
    refit(s);
    graph.replaceChildren();
    graph.setAttribute("viewBox", `0 0 ${s.layout.width} ${s.layout.height}`);
    graph.setAttribute("width", Math.round(s.layout.width * zoom));
    graph.setAttribute("height", Math.round(s.layout.height * zoom));
    applyPan();
    const defs = svg("defs");
    const marker = svg("marker", { id: "flow-arrow", markerWidth: 8, markerHeight: 8,
      refX: 7, refY: 4, orient: "auto" });
    marker.appendChild(svg("path", { d: "M0,0 L8,4 L0,8 z", fill: "context-stroke" }));
    defs.appendChild(marker); graph.appendChild(defs);
    s.layout.frames.forEach(frameGroup);
    renderLinks(s);
    s.events.forEach(step => renderStep(s, step));
  }
  function render(id) {
    if (!scenarios[id]) return;
    current = id; selectedStep = selectedLink = selectedFrame = null;
    const s = scenarios[id];
    renderGraph(s); updateSummary(s); updateIndex(); updateCrumbs();
    details.replaceChildren(el("p", "note", "Select a step, connection, or frame to inspect it."));
  }
  function navigateTo(id, push) {
    if (!scenarios[id]) return;
    if (push && current) history.push(current);
    else if (!push) history = [];
    render(id);
  }
  function openScenario(id) { navigateTo(id, true); }
  function goBack() { if (history.length) render(history.pop()); }
  function selectStep(id) {
    const s = scenarios[current], event = eventMap(s)[id];
    if (!event) return;
    selectedStep = id; selectedLink = selectedFrame = null; renderGraph(s);
    details.replaceChildren(el("h3", "", event.title));
    const list = el("dl");
    row(list, "Step ID", event.id);
    row(list, "Actor", event.actor);
    row(list, "Group", groupPath(s, event.group));
    details.appendChild(list);
    const links = outgoing(s, id);
    if (links.length) {
      details.appendChild(el("h4", "", "Connections"));
      const list = el("ul");
      links.forEach(link => list.appendChild(el("li", "", link.target_scenario
        ? `${link.label || "Opens"}: ${link.scenario_title}`
        : `${link.label || "Continues to"} ${eventMap(s)[link.target].title}${link.repeat ? " [repeat]" : ""}`)));
      details.appendChild(list);
      links.filter(link => link.target_scenario).forEach(link => {
        const button = el("button", "detail-action", "Open scenario: " + link.scenario_title);
        button.addEventListener("click", () => openScenario(link.target_scenario));
        details.appendChild(button);
      });
    }
  }
  function selectLink(id) {
    const s = scenarios[current], link = s.links.find(item => item.id === id);
    if (!link) return;
    selectedLink = id; selectedStep = selectedFrame = null; renderGraph(s);
    details.replaceChildren(el("h3", "", link.label || "Connection"));
    const list = el("dl");
    row(list, "From", eventMap(s)[link.source].title);
    row(list, "To", link.target ? eventMap(s)[link.target].title : link.scenario_title);
    row(list, "Repeat", link.repeat ? "Yes" : "No");
    details.appendChild(list);
    if (link.target_scenario) {
      const button = el("button", "detail-action", "Open scenario: " + link.scenario_title);
      button.addEventListener("click", () => openScenario(link.target_scenario));
      details.appendChild(button);
    }
  }
  function selectFrame(id) {
    const s = scenarios[current], group = groupMap(s)[id];
    if (!group) return;
    selectedFrame = id; selectedStep = selectedLink = null; renderGraph(s);
    details.replaceChildren(el("h3", "", group.name), el("span", "badge", "Frame"));
    const list = el("dl");
    row(list, "Group ID", group.id);
    row(list, "Contains", group.step_ids.length + " steps");
    row(list, "Parent", group.parent ? groupMap(s)[group.parent].name : "Top-level frame");
    details.appendChild(list);
  }
  function graphPoint(event, s) {
    const rect = graph.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * s.layout.width / (rect.width || s.layout.width),
      y: (event.clientY - rect.top) * s.layout.height / (rect.height || s.layout.height) };
  }
  function beginStepDrag(event, id) {
    if (event.shiftKey || event.button === 1) {
      beginPan(event, true);
      if (event.stopPropagation) event.stopPropagation();
      return;
    }
    if (event.button !== undefined && event.button !== 0) return;
    const s = scenarios[current], point = graphPoint(event, s), currentPoint = s.layout.positions[id];
    dragging = { kind: "step", scenario: current, ids: [id],
      offsets: { [id]: { x: currentPoint.x - point.x, y: currentPoint.y - point.y } } };
  }
  function beginFrameDrag(event, id) {
    if (event.shiftKey || event.button === 1) {
      beginPan(event, true);
      if (event.stopPropagation) event.stopPropagation();
      return;
    }
    if (event.button !== undefined && event.button !== 0) return;
    const s = scenarios[current], group = groupMap(s)[id];
    if (!group) return;
    const point = graphPoint(event, s), offsets = {};
    group.step_ids.forEach(stepId => {
      const position = s.layout.positions[stepId];
      offsets[stepId] = { x: position.x - point.x, y: position.y - point.y };
    });
    dragging = { kind: "frame", scenario: current, ids: group.step_ids.slice(), offsets };
  }
  function hasInteractiveGraphTarget(target) {
    while (target && target !== shell) {
      if (target.getAttribute) {
        const classes = (target.getAttribute("class") || "").split(/\s+/);
        if (["flow-step", "flow-link", "frame-header", "subscenario-button"].some(name => classes.includes(name))) return true;
      }
      target = target.parentNode;
    }
    return false;
  }
  function applyPan() {
    graph.style.transform = `translate(${panX}px, ${panY}px)`;
  }
  function beginPan(event, force = false) {
    if (event.button !== undefined && event.button !== 0 && event.button !== 1) return;
    const modified = force || event.shiftKey || event.button === 1;
    if (!modified && hasInteractiveGraphTarget(event.target)) return;
    panning = { x: event.clientX, y: event.clientY, left: panX, top: panY };
    shell.setAttribute("data-panning", "true");
    if (event.preventDefault) event.preventDefault();
  }
  function movePointer(event) {
    if (panning) {
      panX = panning.left + (event.clientX - panning.x);
      panY = panning.top + (event.clientY - panning.y);
      applyPan();
      if (event.preventDefault) event.preventDefault();
      return;
    }
    if (!dragging) return;
    const s = scenarios[dragging.scenario], point = graphPoint(event, s);
    dragging.ids.forEach(id => {
      const offset = dragging.offsets[id], minimum = minimumStepPosition(s, id);
      s.layout.positions[id] = { x: Math.max(minimum.x, Math.min(MAX_COORD, point.x + offset.x)),
        y: Math.max(minimum.y, Math.min(MAX_COORD, point.y + offset.y)) };
    });
    renderGraph(s);
    if (event.preventDefault) event.preventDefault();
  }
  function endPointer() {
    dragging = null; panning = null; shell.removeAttribute("data-panning");
  }
  function setZoomAt(next, clientX, clientY) {
    const value = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (Math.abs(value - zoom) < 0.001) return;
    const rect = shell.getBoundingClientRect();
    const pointerX = clientX - rect.left, pointerY = clientY - rect.top;
    const anchorX = (pointerX - panX) / zoom, anchorY = (pointerY - panY) / zoom;
    zoom = value;
    panX = pointerX - anchorX * zoom;
    panY = pointerY - anchorY * zoom;
    if (current) renderGraph(scenarios[current]);
  }
  function onWheel(event) {
    if (!event.deltaY) return;
    event.preventDefault();
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= shell.clientHeight || 800;
    setZoomAt(zoom * Math.exp(-delta * 0.005), event.clientX, event.clientY);
  }
  function saveLayout() {
    const data = { version: layoutInfo.version, scenarios: {} };
    model.scenarios.forEach(s => {
      data.scenarios[s.id] = JSON.parse(JSON.stringify(s.layout.positions));
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = el("a");
    link.href = url; link.download = layoutInfo.filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    layoutStatus.textContent = "Downloaded " + layoutInfo.filename + ". Place it beside the HTML before regenerating.";
  }

  get("save-flow-layout").addEventListener("click", saveLayout);
  shell.addEventListener("pointerdown", beginPan);
  shell.addEventListener("wheel", onWheel, { passive: false });
  back.addEventListener("click", goBack);
  window.addEventListener("pointermove", movePointer);
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);
  const root = model.scenarios.find(s => s.entrypoint) || model.scenarios[0];
  render(root.id);
  window.flowGraphApp = {
    navigateTo, openScenario, selectStep, selectLink, selectFrame,
    get currentScenario() { return current; },
    get breadcrumbs() { return history.concat(current ? [current] : []); },
    get positions() { return scenarios[current].layout.positions; },
    get frames() { return scenarios[current].layout.frames; },
    get zoom() { return zoom; },
  };
})();
