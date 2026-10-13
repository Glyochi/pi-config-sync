import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "scenario-flows.md"
MAP_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "owner-map.md"
sys.path.insert(0, str(SCRIPT_DIR))

from flow_visualize import (  # noqa: E402
    FlowFormatError,
    layout_path_for_output,
    load_saved_layout,
    FRAME_PADDING,
    FRAME_NESTING_GAP,
    CANVAS_MARGIN,
    parse_flows_file,
    parse_flows_text,
    render_flow_file,
    render_flow_html,
    render_model,
)


class ScenarioFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = FIXTURE.read_text(encoding="utf-8")

    def invalid(self, source, message):
        with self.assertRaises(FlowFormatError) as caught:
            parse_flows_text(source, "invalid-flows.md")
        self.assertIn("invalid-flows.md:", str(caught.exception))
        self.assertIn(message, str(caught.exception))
        return str(caught.exception)

    def test_compact_markdown_parses_ordered_steps_actors_groups_links_and_subscenarios(self):
        flow = parse_flows_file(str(FIXTURE))
        self.assertEqual([scenario["id"] for scenario in flow["scenarios"]],
                         ["process-request", "validation-details"])
        request = flow["scenarios"][0]
        self.assertEqual(request["events"][0]["actor"], "Client")
        self.assertEqual(request["events"][0]["group"], "request-path")
        self.assertEqual(request["events"][2]["group"], "handler-work")
        groups = {group["id"]: group for group in request["groups"]}
        self.assertEqual(groups["handler-work"]["parent"], "request-path")
        self.assertEqual(groups["request-path"]["step_ids"],
                         ["receive", "validate", "handle", "return"])
        self.assertEqual(groups["handler-work"]["step_ids"], ["handle", "return"])
        self.assertEqual([(link["source"], link["target"]) for link in request["links"][:3]],
                         [("receive", "validate"), ("validate", "handle"), ("handle", "return")])
        invalid_branch = next(link for link in request["links"] if link["label"] == "request is invalid")
        self.assertEqual((invalid_branch["source"], invalid_branch["target"]), ("validate", "return"))
        repeated = next(link for link in request["links"] if link["repeat"])
        self.assertEqual((repeated["source"], repeated["target"]), ("return", "receive"))
        subscenario = next(link for link in request["links"] if link["target_scenario"])
        self.assertEqual(subscenario["target_scenario"], "validation-details")
        self.assertEqual(subscenario["scenario_title"], "Validation details")

    def test_ids_are_generated_deterministically_and_explicit_ids_override(self):
        source = """## Scenarios

### Scenario: Simple flow
1. Check a value
2. Check a value
3. Finish {#stable-finish}
"""
        flow = parse_flows_text(source)
        self.assertEqual([event["id"] for event in flow["scenarios"][0]["events"]],
                         ["check-a-value", "check-a-value-2", "stable-finish"])
        self.assertEqual(flow["scenarios"][0]["id"], "simple-flow")

    def test_invalid_or_legacy_markdown_fails_with_source_location(self):
        self.invalid("# Old\n", "missing required `## Scenarios` section")
        error = self.invalid("## Format\n```toml\nversion = 2\n```\n", "legacy TOML flow files are unsupported")
        self.assertIn("no conversion performed", error)
        self.invalid("## Scenarios\n```toml\n[[scenario]]\n```\n", "legacy TOML flow files are unsupported")
        self.invalid("## Scenarios\n", "at least one `### Scenario:` heading")
        self.invalid("## Scenarios\n### Scenario: Empty\n", "must contain at least one numbered step")
        self.invalid("## Scenarios\n### Scenario: X\n1. Step {#bad id}\n", "must match [a-z][a-z0-9_-]*")
        self.invalid(self.source.replace("{#return}", "{#validate}", 1), "duplicate ID 'validate'")

    def test_unknown_links_and_unmarked_cycles_are_rejected(self):
        self.invalid(self.source.replace("validate -> return:", "missing -> return:", 1),
                     "unknown source step 'missing'")
        self.invalid(self.source.replace("@validation-details", "@missing-scenario", 1),
                     "unknown scenario target 'missing-scenario'")
        cycle = """## Scenarios
### Scenario: Cycle
1. First {#first}
2. Second {#second}
#### Connections
- second -> first: backwards edge
"""
        self.invalid(cycle, "create a cycle; mark an intentional repeat with `[repeat]`")
        self.invalid(cycle.replace("backwards edge", "[repeat]"),
                     "a repeated connection needs a short condition/label")

    def test_causal_layout_is_deterministic_and_nested_frames_fit_members(self):
        flow = parse_flows_file(str(FIXTURE))
        first, second = render_model(flow), render_model(flow)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        request = first["scenarios"][0]
        positions = request["layout"]["positions"]
        for source, target in zip(["receive", "validate", "handle"], ["validate", "handle", "return"]):
            self.assertLess(positions[source]["x"], positions[target]["x"])
        frames = {frame["id"]: frame for frame in request["layout"]["frames"]}
        self.assertLess(frames["request-path"]["left"], frames["handler-work"]["left"])
        self.assertGreater(frames["request-path"]["right"], frames["handler-work"]["right"])
        self.assertLess(frames["request-path"]["top"], frames["handler-work"]["top"])
        self.assertEqual(frames["handler-work"]["step_ids"], ["handle", "return"])
        max_depth = max(group["depth"] for group in request["groups"])
        for frame in frames.values():
            rightmost_node = max(positions[step_id]["x"] + 130 for step_id in frame["step_ids"])
            expected_padding = FRAME_PADDING + (max_depth - frame["depth"]) * FRAME_NESTING_GAP
            self.assertEqual(frame["right"] - rightmost_node, expected_padding)
        self.assertEqual(FRAME_PADDING, 88)
        self.assertEqual(FRAME_NESTING_GAP, 48)

    def test_first_grouped_layout_keeps_peer_frames_and_nodes_disjoint(self):
        source = """## Scenarios
### Scenario: Process work
#### Group: Main process
##### Group: Main thread
1. Start the service {#start}
2. Serve requests {#serve}
##### Group: Control thread
3. Read worker status {#read-status}
4. Update the registry {#update-registry}
#### Group: Worker process
##### Group: Worker thread
5. Process data {#process}
6. Stop the worker {#stop}
"""
        scenario = render_model(parse_flows_text(source))["scenarios"][0]
        positions = scenario["layout"]["positions"]
        frames = {frame["id"]: frame for frame in scenario["layout"]["frames"]}
        groups = {group["id"]: group for group in scenario["groups"]}

        def overlaps(a, b):
            return (a["left"] < b["right"] and b["left"] < a["right"]
                    and a["top"] < b["bottom"] and b["top"] < a["bottom"])

        def node_bounds(step_id):
            point = positions[step_id]
            return {"left": point["x"] - 130, "right": point["x"] + 130,
                    "top": point["y"] - 58, "bottom": point["y"] + 58}

        def is_ancestor(ancestor, child):
            parent = groups[child]["parent"]
            while parent:
                if parent == ancestor:
                    return True
                parent = groups[parent]["parent"]
            return False

        step_ids = list(positions)
        for index, first in enumerate(step_ids):
            for second in step_ids[index + 1:]:
                self.assertFalse(overlaps(node_bounds(first), node_bounds(second)),
                                 "steps {} and {} overlap".format(first, second))
        frame_ids = list(frames)
        for index, first in enumerate(frame_ids):
            self.assertGreaterEqual(frames[first]["left"], CANVAS_MARGIN)
            self.assertGreaterEqual(frames[first]["top"], CANVAS_MARGIN)
            for second in frame_ids[index + 1:]:
                if is_ancestor(first, second) or is_ancestor(second, first):
                    continue
                self.assertFalse(overlaps(frames[first], frames[second]),
                                 "peer frames {} and {} overlap".format(first, second))
        for step_id in step_ids:
            for frame_id, frame in frames.items():
                if step_id in frame["step_ids"]:
                    continue
                self.assertFalse(overlaps(node_bounds(step_id), frame),
                                 "step {} overlaps unrelated frame {}".format(step_id, frame_id))

    def test_saved_layout_overrides_steps_and_ignores_stale_or_invalid_entries(self):
        flow = parse_flows_file(str(FIXTURE))
        with tempfile.TemporaryDirectory() as directory:
            sidecar = Path(directory) / "flow-graph.layout.json"
            sidecar.write_text(json.dumps({"version": 1, "scenarios": {
                "process-request": {
                    "receive": {"x": 850, "y": 430},
                    "removed-step": {"x": 400, "y": 300},
                    "validate": {"x": True, "y": 300},
                },
                "removed-scenario": {"old": {"x": 400, "y": 300}},
            }}), encoding="utf-8")
            warning = io.StringIO()
            with contextlib.redirect_stderr(warning):
                saved = load_saved_layout(str(sidecar), flow)
            self.assertEqual(saved, {"process-request": {"receive": {"x": 850.0, "y": 430.0}}})
            self.assertIn("invalid Flow layout coordinates", warning.getvalue())
            rendered = render_model(flow, saved)
            request = rendered["scenarios"][0]
            self.assertEqual(request["layout"]["positions"]["receive"], {"x": 850.0, "y": 430.0})
            self.assertEqual(layout_path_for_output("/tmp/flow.html"), "/tmp/flow.layout.json")

    def test_html_is_standalone_and_contains_only_scenarios_sidebar(self):
        page = render_flow_html(parse_flows_file(str(FIXTURE)), "scenario-flows.md")
        self.assertIn('id="scenario-sidebar"', page)
        self.assertIn('id="scenario-index"', page)
        self.assertNotIn("participant-controls", page)
        self.assertNotIn("participant-list", page)
        self.assertNotIn("Execution threads", page)
        self.assertIn('id="flow-data"', page)
        self.assertIn("data-frame-id", page)
        self.assertNotIn("map-graph.html", page)
        self.assertNotIn("fetch(", page)
        self.assertNotRegex(page, r'<(?:script|link)[^>]+(?:src|href)=["\']https?://')

    def test_invalid_source_does_not_replace_previous_html(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "FLOWS.md"
            output = Path(directory) / "flow-graph.html"
            source.write_text(self.source, encoding="utf-8")
            render_flow_file(str(source), str(output))
            previous = output.read_text(encoding="utf-8")
            source.write_text(self.source.replace("validate -> return:", "missing -> return:", 1), encoding="utf-8")
            with self.assertRaises(FlowFormatError):
                render_flow_file(str(source), str(output))
            self.assertEqual(output.read_text(encoding="utf-8"), previous)

    def test_default_cli_renders_map_flow_both_and_reports_no_sources(self):
        visualizer = SCRIPT_DIR / "visualize.py"
        for has_map, has_flow in ((True, False), (False, True), (True, True), (False, False)):
            with self.subTest(map=has_map, flow=has_flow), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                map_dir = root / "map"
                map_dir.mkdir()
                if has_map:
                    (map_dir / "MAP.md").write_text(MAP_FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")
                if has_flow:
                    (map_dir / "FLOWS.md").write_text(self.source, encoding="utf-8")
                result = subprocess.run([sys.executable, str(visualizer)], cwd=root,
                                        capture_output=True, text=True, check=False)
                if has_map or has_flow:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Nothing to render", result.stderr)
                self.assertEqual((map_dir / "map-graph.html").exists(), has_map)
                self.assertEqual((map_dir / "flow-graph.html").exists(), has_flow)
                if has_map:
                    self.assertIn("Abstraction level", (map_dir / "map-graph.html").read_text(encoding="utf-8"))
                if has_flow:
                    self.assertIn("scenario-sidebar", (map_dir / "flow-graph.html").read_text(encoding="utf-8"))

    def test_unmarked_legacy_map_is_rejected_without_conversion(self):
        visualizer = SCRIPT_DIR / "visualize.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            map_dir = root / "map"
            map_dir.mkdir()
            old = MAP_FIXTURE.read_text(encoding="utf-8").replace("<!-- map-format: compact-v1 -->\n\n", "", 1)
            (map_dir / "MAP.md").write_text(old, encoding="utf-8")
            result = subprocess.run([sys.executable, str(visualizer)], cwd=root,
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsupported MAP format", result.stderr)
            self.assertFalse((map_dir / "map-graph.html").exists())


if __name__ == "__main__":
    unittest.main()
