"""Deterministic execution-context layout for version-2 intended flows.

Frames and lanes are presentation data. They never infer process/thread identity
from participants or turn component calls into additional execution contexts.
"""

from collections import defaultdict, deque

NODE_WIDTH = 260
NODE_HEIGHT = 152
ROW_GAP = 220
COLUMN_GAP = 340
FRAME_GAP = 70
THREAD_GAP = 30
PROCESS_TOP = 40
THREAD_TOP = 140
FIRST_ROW = 330
LINK_COLORS = {
    "sequence": "#475569",
    "spawn": "#7c3aed",
    "message": "#0369a1",
    "signal": "#b45309",
}


def causal_depths(scenario):
    indegree = {event["id"]: 0 for event in scenario["events"]}
    adjacency = defaultdict(list)
    for link in scenario["links"]:
        if not link["loop"]:
            adjacency[link["source"]].append(link["target"])
            indegree[link["target"]] += 1
    depths = {event_id: 0 for event_id in indegree}
    ready = deque(event_id for event_id in indegree if not indegree[event_id])
    while ready:
        current = ready.popleft()
        for target in adjacency[current]:
            depths[target] = max(depths[target], depths[current] + 1)
            indegree[target] -= 1
            if not indegree[target]:
                ready.append(target)
    return depths


def layout_runtime_scenario(scenario):
    depths = causal_depths(scenario)
    positions, lanes, process_lanes = {}, {}, {}
    groups = defaultdict(list)
    for event in scenario["events"]:
        group = event.get("thread") or "external:" + event["participant"]
        groups[group].append(event)

    def place(group, left):
        columns = defaultdict(list)
        for event in groups[group]:
            columns[depths[event["id"]]].append(event)
        width = max((len(items) for items in columns.values()), default=1) * COLUMN_GAP + 140
        lane = {"left": left, "right": left + width, "top": THREAD_TOP}
        lanes[group] = lane
        for depth, events in columns.items():
            for column, event in enumerate(events):
                positions[event["id"]] = {
                    "x": left + 190 + column * COLUMN_GAP,
                    "y": FIRST_ROW + depth * ROW_GAP,
                }
        return width

    left = 40
    for participant in scenario["participants"]:
        if participant["kind"] == "external":
            key = "external:" + participant["id"]
            left += place(key, left) + FRAME_GAP
    for process in scenario["processes"]:
        process_left = left
        left += 24
        for thread in scenario["threads"]:
            if thread["process"] == process["id"]:
                left += place(thread["id"], left) + THREAD_GAP
        # A declared process may have no modeled thread in a focused scenario.
        left = max(left - THREAD_GAP + 24, process_left + 380)
        process_lanes[process["id"]] = {"left": process_left, "right": left, "top": PROCESS_TOP}
        left += FRAME_GAP
    layout = {"positions": positions, "lanes": lanes, "process_lanes": process_lanes,
              "width": max(700, left), "height": 500, "first_row": FIRST_ROW, "orientation": "top-to-bottom"}
    refit_runtime_frames(scenario, layout)
    return layout


def clamp_runtime_position(scenario, layout, event_id, position):
    event = next(event for event in scenario["events"] if event["id"] == event_id)
    key = event.get("thread") or "external:" + event["participant"]
    lane = layout["lanes"][key]
    return {"x": max(lane["left"] + 160, min(lane["right"] - 160, position["x"])),
            "y": max(FIRST_ROW, position["y"])}


def refit_runtime_frames(scenario, layout):
    """Refit nested frames after saved coordinates are applied; never change lanes."""
    threads, processes = [], []
    for thread in scenario["threads"]:
        points = [layout["positions"][event["id"]] for event in scenario["events"]
                  if event.get("thread") == thread["id"]]
        lane = layout["lanes"][thread["id"]]
        threads.append({"id": thread["id"], "process": thread["process"], **lane,
                        "bottom": max((p["y"] + 150 for p in points), default=THREAD_TOP + 240),
                        "context_only": not points})
    for process in scenario["processes"]:
        children = [frame for frame in threads if frame["process"] == process["id"]]
        lane = layout["process_lanes"][process["id"]]
        processes.append({"id": process["id"], **lane,
                          "bottom": max((frame["bottom"] + 30 for frame in children), default=420)})
    layout["frames"] = {"processes": processes, "threads": threads}
    layout["height"] = max(500, max((frame["bottom"] + 40 for frame in processes), default=0),
                           max((point["y"] + 150 for point in layout["positions"].values()), default=0))
