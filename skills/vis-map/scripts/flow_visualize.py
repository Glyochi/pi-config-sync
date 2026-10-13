#!/usr/bin/env python3
"""Parse compact Markdown scenarios and render a standalone Flow HTML graph."""

import html
import json
import math
import os
import re
import sys
import unicodedata
from collections import defaultdict, deque
from pathlib import Path

ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]*$")
HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
ID_SUFFIX_PATTERN = re.compile(r"\s+\{#([^{}]+)\}\s*$")
STEP_PATTERN = re.compile(r"^\s*\d+[.)]\s+(.+?)\s*$")
ACTOR_PATTERN = re.compile(r"\s+\[actor:\s*(.+?)\]\s*$", re.IGNORECASE)
LINK_PATTERN = re.compile(
    r"^\s*[-*]\s+([a-z][a-z0-9_-]*)\s*->\s*(@?[a-z][a-z0-9_-]*)"
    r"\s*(?::\s*(.*))?$"
)
REPEAT_PATTERN = re.compile(r"(?:^|\s+)\[repeat\]\s*$", re.IGNORECASE)
NODE_WIDTH = 260
NODE_HEIGHT = 116
COLUMN_GAP = 360
ROW_GAP = 190
FRAME_SPACING_SCALE = 4
FRAME_PADDING = 22 * FRAME_SPACING_SCALE
FRAME_NESTING_GAP = 12 * FRAME_SPACING_SCALE
FRAME_HEADER_HEIGHT = 34
LAYOUT_ITEM_GAP = 96
CANVAS_MARGIN = 60
LAYOUT_VERSION = 1
MIN_LAYOUT_X = 180
MIN_LAYOUT_Y = 160
MAX_LAYOUT_COORDINATE = 1_000_000


class FlowFormatError(ValueError):
    """Source-located Markdown-flow format or validation error."""


def fail(path, line, message):
    raise FlowFormatError("{}:{} [Scenarios] {}".format(path, max(1, line), message))


def slugify(value, fallback):
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")
    if not slug or not slug[0].isalpha():
        slug = fallback + ("-" + slug if slug else "")
    return slug


def split_title_id(value, fallback, used, path, line):
    explicit = None
    match = ID_SUFFIX_PATTERN.search(value)
    if match:
        explicit = match.group(1)
        value = value[:match.start()].rstrip()
        if not ID_PATTERN.fullmatch(explicit):
            fail(path, line, "ID {!r} must match [a-z][a-z0-9_-]*".format(explicit))
    if not value.strip():
        fail(path, line, "title must not be empty")
    base = explicit or slugify(value, fallback)
    identifier = base
    suffix = 2
    if explicit and identifier in used:
        fail(path, line, "duplicate ID {!r}".format(identifier))
    while identifier in used:
        identifier = "{}-{}".format(base, suffix)
        suffix += 1
    used.add(identifier)
    return value.strip(), identifier


def parse_link_line(line, path, number):
    match = LINK_PATTERN.fullmatch(line)
    if not match:
        fail(path, number, "connection must look like `source -> target: label`")
    source, target, label = match.groups()
    label = (label or "").strip()
    repeat = bool(REPEAT_PATTERN.search(label))
    if repeat:
        label = REPEAT_PATTERN.sub("", label).strip()
        if not label:
            fail(path, number, "a repeated connection needs a short condition/label before [repeat]")
    return {"source": source, "target": target, "label": label, "repeat": repeat, "_line": number}


def _close_group_stack(stack, level):
    while stack and stack[-1][0] >= level:
        stack.pop()


def parse_flows_text(text, path="FLOWS.md"):
    """Parse the current compact Markdown scenario format (legacy TOML is unsupported)."""
    lines = text.splitlines()
    legacy = next((index + 1 for index, line in enumerate(lines)
                   if line.strip().lower() == "## format" or "```toml" in line.lower()), None)
    if legacy is not None:
        fail(path, legacy, "legacy TOML flow files are unsupported; create a new Markdown Scenarios section (no conversion performed)")
    section_headers = [(index + 1, line) for index, line in enumerate(lines)
                       if line.strip().lower() == "## scenarios"]
    if not section_headers:
        fail(path, 1, "missing required `## Scenarios` section")
    if len(section_headers) > 1:
        fail(path, section_headers[1][0], "`## Scenarios` section appears more than once")

    start_line = section_headers[0][0]
    end_index = len(lines)
    for index in range(start_line, len(lines)):
        if re.match(r"^##\s+", lines[index]):
            end_index = index
            break
    scoped = list(enumerate(lines[start_line:end_index], start_line + 1))

    scenarios = []
    scenario_ids = set()
    current = None
    group_stack = []
    in_connections = False
    description_lines = []

    for number, raw in scoped:
        line = raw.rstrip()
        heading = HEADING_PATTERN.match(line)
        if heading:
            level = len(heading.group(1))
            title = heading.group(2).strip()
            if level == 2:
                fail(path, number, "only one `## Scenarios` section is supported")
            if level == 3:
                if not title.lower().startswith("scenario:"):
                    fail(path, number, "use `### Scenario: title` for each scenario")
                scenario_title, scenario_id = split_title_id(title[len("Scenario:"):].strip(), "scenario", scenario_ids, path, number)
                current = {"id": scenario_id, "title": scenario_title, "description": "",
                           "groups": [], "events": [], "links": [], "_line": number}
                scenarios.append(current)
                group_stack = []
                in_connections = False
                description_lines = []
                continue
            if level >= 4:
                if current is None:
                    fail(path, number, "a scenario heading must precede groups and connections")
                if title.lower() == "connections":
                    _close_group_stack(group_stack, level)
                    in_connections = True
                    continue
                if not title.lower().startswith("group:"):
                    fail(path, number, "use `#### Group: name` for frames or `#### Connections` for links")
                group_title, group_id = split_title_id(title[len("Group:"):].strip(), "group", {g["id"] for g in current["groups"]}, path, number)
                _close_group_stack(group_stack, level)
                parent = group_stack[-1][1] if group_stack else None
                depth = len(group_stack)
                group = {"id": group_id, "name": group_title, "parent": parent,
                         "depth": depth, "step_ids": [], "_line": number}
                current["groups"].append(group)
                group_stack.append((level, group_id))
                in_connections = False
                continue

        if current is None or not line.strip() or line.lstrip().startswith("<!--"):
            continue
        if line.lstrip().startswith("##"):
            fail(path, number, "unsupported heading in Scenarios section")

        if in_connections:
            current["links"].append(parse_link_line(line, path, number))
            continue

        step_match = STEP_PATTERN.match(line)
        if step_match:
            title_with_meta = step_match.group(1).strip()
            actor = None
            actor_match = ACTOR_PATTERN.search(title_with_meta)
            if actor_match:
                actor = actor_match.group(1).strip()
                title_with_meta = title_with_meta[:actor_match.start()].rstrip()
                if not actor:
                    fail(path, number, "actor label must not be empty")
            ids_used = {group["id"] for group in current["groups"]}
            ids_used.update(event["id"] for event in current["events"])
            title, step_id = split_title_id(title_with_meta, "step", ids_used, path, number)
            group_id = group_stack[-1][1] if group_stack else None
            current["events"].append({"id": step_id, "title": title,
                                      "actor": actor, "group": group_id, "_line": number})
            continue

        if line.lstrip().startswith(("- ", "* ")):
            fail(path, number, "bullets are only valid under a `Connections` heading; use numbered steps elsewhere")
        if not current["events"] and not current["groups"]:
            description_lines.append(line.strip())
            current["description"] = " ".join(description_lines).strip()
            continue
        fail(path, number, "use a numbered step, a `Group` heading, or a `Connections` heading")

    if not scenarios:
        fail(path, start_line, "at least one `### Scenario:` heading is required")

    scenario_by_id = {scenario["id"]: scenario for scenario in scenarios}
    for scenario in scenarios:
        if not scenario["events"]:
            fail(path, scenario["_line"], "scenario {!r} must contain at least one numbered step".format(scenario["id"]))

        event_ids = {event["id"] for event in scenario["events"]}
        groups_by_id = {group["id"]: group for group in scenario["groups"]}
        for event in scenario["events"]:
            group_id = event["group"]
            while group_id:
                groups_by_id[group_id]["step_ids"].append(event["id"])
                group_id = groups_by_id[group_id]["parent"]
        for group in scenario["groups"]:
            if not group["step_ids"]:
                fail(path, group["_line"], "group {!r} has no steps".format(group["id"]))

        links = []
        for index, (source, target) in enumerate(zip(scenario["events"], scenario["events"][1:]), 1):
            links.append({"id": "main-{}".format(index), "source": source["id"],
                          "target": target["id"], "target_scenario": None, "label": "",
                          "repeat": False, "implicit": True})

        explicit_pairs = {(link["source"], link["target"]) for link in links}
        for index, raw_link in enumerate(scenario["links"], 1):
            source = raw_link["source"]
            target = raw_link["target"]
            if source not in event_ids:
                fail(path, raw_link["_line"], "unknown source step {!r}".format(source))
            target_scenario = None
            target_step = target
            if target.startswith("@"):
                target_scenario = target[1:]
                if target_scenario not in scenario_by_id:
                    fail(path, raw_link["_line"], "unknown scenario target {!r}".format(target_scenario))
                if target_scenario == scenario["id"]:
                    fail(path, raw_link["_line"], "a scenario cannot link to itself")
                target_step = None
            elif target not in event_ids:
                fail(path, raw_link["_line"], "unknown target step {!r}".format(target))
            if raw_link["repeat"] and target_scenario:
                fail(path, raw_link["_line"], "[repeat] applies to step-to-step connections, not subscenario links")
            if not target_scenario and (source, target) in explicit_pairs:
                existing = next(link for link in links if link["source"] == source and link["target"] == target)
                if raw_link["repeat"]:
                    fail(path, raw_link["_line"], "use a distinct non-main-path target for a repeat connection")
                existing["label"] = raw_link["label"]
                continue
            links.append({"id": "link-{}".format(index), "source": source, "target": target_step,
                          "target_scenario": target_scenario, "label": raw_link["label"],
                          "repeat": raw_link["repeat"], "implicit": False,
                          "_line": raw_link["_line"]})
            if target_step and not raw_link["repeat"]:
                explicit_pairs.add((source, target_step))

        _validate_acyclic_steps(scenario, links, path)
        scenario["links"] = links

    # Strip parser-only fields after every cross-scenario reference has resolved.
    for scenario in scenarios:
        for group in scenario["groups"]:
            group.pop("_line", None)
        for event in scenario["events"]:
            event.pop("_line", None)
        for link in scenario["links"]:
            link.pop("_line", None)

    for scenario in scenarios:
        for link in scenario["links"]:
            if link["target_scenario"]:
                link["scenario_title"] = scenario_by_id[link["target_scenario"]]["title"]
    return {"scenarios": scenarios}


def _validate_acyclic_steps(scenario, links, path):
    ids = [event["id"] for event in scenario["events"]]
    adjacency = defaultdict(list)
    indegree = {event_id: 0 for event_id in ids}
    for link in links:
        if link["target"] is None or link["repeat"]:
            continue
        adjacency[link["source"]].append(link["target"])
        indegree[link["target"]] += 1
    ready = deque(event_id for event_id in ids if indegree[event_id] == 0)
    visited = 0
    while ready:
        source = ready.popleft()
        visited += 1
        for target in adjacency[source]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    if visited != len(ids):
        cycle_link = next((link for link in links if link.get("_line") and not link["repeat"]
                           and link["target"] and indegree[link["source"]] > 0), None)
        line = cycle_link["_line"] if cycle_link else scenario["_line"]
        fail(path, line, "step connections create a cycle; mark an intentional repeat with `[repeat]`")


def parse_flows_file(path):
    try:
        with open(path, encoding="utf-8") as source:
            return parse_flows_text(source.read(), path)
    except OSError as error:
        raise FlowFormatError("{}: cannot read flow source: {}".format(path, error)) from error


def _group_depths(scenario):
    return {group["id"]: group["depth"] for group in scenario["groups"]}


def refit_frames(scenario, positions):
    depths = _group_depths(scenario)
    max_depth = max(depths.values(), default=0)
    frames = []
    for group in sorted(scenario["groups"], key=lambda item: (item["depth"], item["id"])):
        points = [positions[step_id] for step_id in group["step_ids"] if step_id in positions]
        if not points:
            continue
        padding = FRAME_PADDING + (max_depth - group["depth"]) * FRAME_NESTING_GAP
        frames.append({
            "id": group["id"], "name": group["name"], "parent": group["parent"],
            "depth": group["depth"], "step_ids": list(group["step_ids"]),
            "left": min(point["x"] - NODE_WIDTH / 2 for point in points) - padding,
            "right": max(point["x"] + NODE_WIDTH / 2 for point in points) + padding,
            "top": min(point["y"] - NODE_HEIGHT / 2 for point in points) - padding - FRAME_HEADER_HEIGHT,
            "bottom": max(point["y"] + NODE_HEIGHT / 2 for point in points) + padding,
        })
    return frames


def _hierarchical_positions(scenario, depths):
    """Give each group its own vertical lane while keeping the main path left-to-right."""
    events = scenario["events"]
    groups = {group["id"]: group for group in scenario["groups"]}
    children = defaultdict(list)
    direct_events = defaultdict(list)
    event_order = {event["id"]: index for index, event in enumerate(events)}
    for group in scenario["groups"]:
        children[group["parent"]].append(group["id"])
    for event in events:
        direct_events[event["group"]].append(event)

    max_depth = max(group["depth"] for group in scenario["groups"])
    max_padding = FRAME_PADDING + max_depth * FRAME_NESTING_GAP
    first_x = max(MIN_LAYOUT_X, CANVAS_MARGIN + NODE_WIDTH / 2 + max_padding)

    def lane_positions(lane_events):
        columns = defaultdict(list)
        for event in lane_events:
            columns[depths[event["id"]]].append(event)
        positions = {}
        height = NODE_HEIGHT
        for column, column_events in columns.items():
            for row, event in enumerate(column_events):
                positions[event["id"]] = {
                    "x": first_x + column * COLUMN_GAP,
                    "y": NODE_HEIGHT / 2 + row * ROW_GAP,
                }
            height = max(height, NODE_HEIGHT + (len(column_events) - 1) * ROW_GAP)
        return positions, height

    def layout_group(group_id):
        group = groups[group_id]
        items = []
        if direct_events[group_id]:
            lane, height = lane_positions(direct_events[group_id])
            items.append((min(event_order[event["id"]] for event in direct_events[group_id]), lane, height))
        for child_id in children[group_id]:
            child = groups[child_id]
            block, height = layout_group(child_id)
            items.append((min(event_order[step_id] for step_id in child["step_ids"]), block, height))
        items.sort(key=lambda item: item[0])

        positions = {}
        cursor_y = 0
        for _, block, height in items:
            for step_id, point in block.items():
                positions[step_id] = {"x": point["x"], "y": point["y"] + cursor_y}
            cursor_y += height + LAYOUT_ITEM_GAP
        if items:
            cursor_y -= LAYOUT_ITEM_GAP

        padding = FRAME_PADDING + (max_depth - group["depth"]) * FRAME_NESTING_GAP
        left = min(point["x"] - NODE_WIDTH / 2 for point in positions.values()) - padding
        top = min(point["y"] - NODE_HEIGHT / 2 for point in positions.values()) - padding - FRAME_HEADER_HEIGHT
        bottom = max(point["y"] + NODE_HEIGHT / 2 for point in positions.values()) + padding
        return ({
            step_id: {"x": point["x"], "y": point["y"] - top}
            for step_id, point in positions.items()
        }, bottom - top)

    root_items = []
    if direct_events[None]:
        lane, height = lane_positions(direct_events[None])
        root_items.append((min(event_order[event["id"]] for event in direct_events[None]), lane, height))
    for group_id in children[None]:
        group = groups[group_id]
        block, height = layout_group(group_id)
        root_items.append((min(event_order[step_id] for step_id in group["step_ids"]), block, height))
    root_items.sort(key=lambda item: item[0])

    positions = {}
    cursor_y = 0
    for _, block, height in root_items:
        for step_id, point in block.items():
            positions[step_id] = {"x": point["x"], "y": point["y"] + cursor_y + CANVAS_MARGIN}
        cursor_y += height + LAYOUT_ITEM_GAP
    if root_items:
        cursor_y -= LAYOUT_ITEM_GAP
    return positions


def layout_scenario(scenario, saved_positions=None):
    events = scenario["events"]
    indegree = {event["id"]: 0 for event in events}
    adjacency = defaultdict(list)
    for link in scenario["links"]:
        if link["target"] and not link["repeat"]:
            adjacency[link["source"]].append(link["target"])
            indegree[link["target"]] += 1
    depths = {event["id"]: 0 for event in events}
    ready = deque(event["id"] for event in events if indegree[event["id"]] == 0)
    while ready:
        source = ready.popleft()
        for target in adjacency[source]:
            depths[target] = max(depths[target], depths[source] + 1)
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)

    if scenario["groups"]:
        positions = _hierarchical_positions(scenario, depths)
    else:
        columns = defaultdict(list)
        for event in events:
            columns[depths[event["id"]]].append(event["id"])
        positions = {}
        for column, step_ids in columns.items():
            for row, step_id in enumerate(step_ids):
                positions[step_id] = {"x": MIN_LAYOUT_X + column * COLUMN_GAP,
                                      "y": MIN_LAYOUT_Y + row * ROW_GAP}
    for step_id, point in (saved_positions or {}).items():
        if step_id in positions:
            positions[step_id] = dict(point)

    frames = refit_frames(scenario, positions)
    if frames:
        offset_x = max(0, CANVAS_MARGIN - min(frame["left"] for frame in frames))
        offset_y = max(0, CANVAS_MARGIN - min(frame["top"] for frame in frames))
        if offset_x or offset_y:
            positions = {
                step_id: {"x": point["x"] + offset_x, "y": point["y"] + offset_y}
                for step_id, point in positions.items()
            }
            frames = refit_frames(scenario, positions)
    width = max(700, max((point["x"] + NODE_WIDTH / 2 + 60 for point in positions.values()), default=0),
                max((frame["right"] + 40 for frame in frames), default=0))
    height = max(500, max((point["y"] + NODE_HEIGHT / 2 + 60 for point in positions.values()), default=0),
                 max((frame["bottom"] + 40 for frame in frames), default=0))
    return {"positions": positions, "frames": frames, "width": width, "height": height}


def render_model(flow, saved_layout=None):
    model = json.loads(json.dumps(flow))
    saved_layout = saved_layout or {}
    for scenario in model["scenarios"]:
        scenario["layout"] = layout_scenario(scenario, saved_layout.get(scenario["id"], {}))
        events = {event["id"]: event for event in scenario["events"]}
        for link in scenario["links"]:
            link["source_title"] = events[link["source"]]["title"]
            link["target_title"] = (events[link["target"]]["title"] if link["target"] else link.get("scenario_title", ""))
    incoming = {scenario["id"]: 0 for scenario in model["scenarios"]}
    for scenario in model["scenarios"]:
        for link in scenario["links"]:
            target = link.get("target_scenario")
            if target in incoming:
                incoming[target] += 1
    for scenario in model["scenarios"]:
        scenario["entrypoint"] = incoming[scenario["id"]] == 0
    return model


def json_for_script(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            .replace("<", "\\u003c").replace(">", "\\u003e")
            .replace("&", "\\u0026").replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


def layout_path_for_output(output_path):
    stem, _ = os.path.splitext(output_path)
    return stem + ".layout.json"


def _coordinate(value, minimum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    if not math.isfinite(number) or number < minimum or number > MAX_LAYOUT_COORDINATE:
        return None
    return number


def load_saved_layout(layout_path, flow):
    """Read a versioned Flow-only sidecar; unknown scenarios/steps are ignored."""
    try:
        with open(layout_path, encoding="utf-8") as source:
            saved = json.load(source)
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print("Warning: ignoring Flow layout {}: {}".format(layout_path, error), file=sys.stderr)
        return {}
    if (not isinstance(saved, dict) or type(saved.get("version")) is not int
            or saved.get("version") != LAYOUT_VERSION or not isinstance(saved.get("scenarios"), dict)):
        print("Warning: ignoring unsupported or invalid Flow layout {}.".format(layout_path), file=sys.stderr)
        return {}
    known = {scenario["id"]: {event["id"] for event in scenario["events"]}
             for scenario in flow["scenarios"]}
    result = {}
    for scenario_id, entries in saved["scenarios"].items():
        if scenario_id not in known or not isinstance(entries, dict):
            continue
        valid = {}
        for step_id, point in entries.items():
            if step_id not in known[scenario_id] or not isinstance(point, dict):
                continue
            x = _coordinate(point.get("x"), MIN_LAYOUT_X)
            y = _coordinate(point.get("y"), MIN_LAYOUT_Y)
            if x is None or y is None:
                print("Warning: ignoring invalid Flow layout coordinates for {}/{}.".format(scenario_id, step_id), file=sys.stderr)
                continue
            valid[step_id] = {"x": x, "y": y}
        if valid:
            result[scenario_id] = valid
    return result


def render_flow_html(flow, source_name="FLOWS.md", layout_filename="flow-graph.layout.json", saved_layout=None):
    model = render_model(flow, saved_layout)
    source = html.escape(os.path.basename(source_name))
    script_dir = Path(__file__).resolve().parent
    style = script_dir.joinpath("flow_view.css").read_text(encoding="utf-8")
    script = script_dir.joinpath("flow_view.js").read_text(encoding="utf-8")
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scenario flows</title><style>{css}</style></head>
<body><header><h1>Scenario flows</h1><span class="north-star">{source} · selective scenario guidance</span>
<div class="navigation"><button id="back-button" type="button" disabled>← Back</button><nav id="breadcrumbs" aria-label="Scenario breadcrumbs"></nav></div>
<div class="layout-tools"><span class="zoom-hint">Drag blank canvas to pan · Shift/middle-drag anywhere · Scroll to zoom</span><button id="save-flow-layout" type="button">Save flow layout</button><span id="layout-status" aria-live="polite"></span></div></header>
<div class="layout"><aside id="scenario-sidebar"><h2>Scenarios</h2><div id="scenario-index"></div></aside>
<main><section id="scenario-summary"></section><div id="graph-shell" class="graph-shell" title="Drag blank canvas to pan; Shift/middle-drag anywhere; scroll to zoom"><svg id="flow-graph" role="img" aria-label="Scenario steps and connections"></svg></div></main>
<aside id="details" aria-live="polite"><p class="note">Select a step, connection, or frame for details.</p></aside></div>
<script type="application/json" id="flow-data">{data}</script>
<script type="application/json" id="layout-info">{layout_info}</script><script>{script}</script></body></html>""".format(
        css=style, source=source, data=json_for_script(model),
        layout_info=json_for_script({"version": LAYOUT_VERSION, "filename": os.path.basename(layout_filename)}),
        script=script)


def render_flow_file(input_path="map/FLOWS.md", output_path="map/flow-graph.html"):
    """Validate the entire source before atomically replacing the HTML output."""
    flow = parse_flows_file(input_path)
    layout_path = layout_path_for_output(output_path)
    saved_layout = load_saved_layout(layout_path, flow)
    page = render_flow_html(flow, input_path, layout_path, saved_layout)
    output_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(output_dir, exist_ok=True)
    temporary = output_path + ".tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as output:
            output.write(page)
        os.replace(temporary, output_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    step_count = sum(len(scenario["events"]) for scenario in flow["scenarios"])
    print("Wrote {} ({} scenarios, {} steps)".format(output_path, len(flow["scenarios"]), step_count))


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in {"-h", "--help"}:
        print("Usage: flow_visualize.py [map/FLOWS.md [map/flow-graph.html]]")
        return 0
    if len(args) > 2:
        print("Usage: flow_visualize.py [map/FLOWS.md [map/flow-graph.html]]", file=sys.stderr)
        return 2
    try:
        render_flow_file(args[0] if args else "map/FLOWS.md",
                         args[1] if len(args) > 1 else "map/flow-graph.html")
    except FlowFormatError as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
