import contextlib
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "intended-flows.md"
EXECUTION_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "execution-flows.md"
sys.path.insert(0, str(SCRIPT_DIR))

from flow_visualize import (FlowFormatError, layout_path_for_output, load_saved_layout,
                            parse_flows_file, parse_flows_text, render_flow_file,
                            render_flow_html, render_model)


class FlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = FIXTURE.read_text(encoding="utf-8")

    def invalid(self, source, message):
        with self.assertRaises(FlowFormatError) as error:
            parse_flows_text(source, "synthetic-invalid.md")
        result = str(error.exception)
        self.assertIn("synthetic-invalid.md:", result)
        self.assertIn(message, result)
        return result

    def test_fixture_covers_cli_service_multiple_roots_and_flow_semantics(self):
        model = parse_flows_file(str(FIXTURE))
        roots = [scenario["id"] for scenario in model["scenarios"] if scenario["entrypoint"]]
        self.assertEqual(roots, ["cli-startup", "queue-consumer"])
        self.assertTrue(any(link["loop"] and link["guard"] for link in model["scenarios"][0]["links"]))
        self.assertTrue(any(event["kind"] == "join" for event in model["scenarios"][0]["events"]))
        self.assertTrue(any(event["kind"] == "gap" for scenario in model["scenarios"] for event in scenario["events"]))
        modes = {event["mode"] for scenario in model["scenarios"] for event in scenario["events"] if event["kind"] == "subflow"}
        self.assertEqual(modes, {"sync", "async"})
        self.assertTrue(any(person["kind"] == "external" for scenario in model["scenarios"] for person in scenario["participants"]))
        self.assertTrue(model["datatypes"][0]["fields"])

    def test_duplicate_ids_missing_references_and_broken_bindings_are_actionable(self):
        duplicate = self.source.replace('id = "parse-options"', 'id = "invoke-cli"', 1)
        self.assertRegex(self.invalid(duplicate, "duplicate event ID"), r"synthetic-invalid\.md:\d+ \[Scenarios\]")
        missing_owner = self.source.replace('participant = "terminal"', 'participant = "absent"', 1)
        self.invalid(missing_owner, "unknown participant reference 'absent'")
        missing_scenario = self.source.replace('subflow = "client-setup"', 'subflow = "undefined"', 1)
        self.invalid(missing_scenario, "unknown subflow scenario reference 'undefined'")
        broken_binding = self.source.replace('target = "settings", datatype = "settings"', 'target = "missing", datatype = "settings"', 1)
        message = self.invalid(broken_binding, "binding target port 'missing' does not exist")
        self.assertIn("initialize-client", message)

    def test_unmarked_cycles_are_rejected(self):
        insertion = '\n[[scenario.links]]\nid = "bad-cycle"\nsource = "command-ready"\ntarget = "parse-options"\ntype = "causes"\n'
        invalid = self.source.replace('[[scenario]]\nid = "client-setup"', insertion + '\n[[scenario]]\nid = "client-setup"', 1)
        self.invalid(invalid, "causal cycle must be an intentional loop=true edge")

    def test_version_two_context_layout_counts_and_cross_context_links(self):
        source = EXECUTION_FIXTURE.read_text(encoding="utf-8")
        flow = parse_flows_text(source, str(EXECUTION_FIXTURE))
        first, second = render_model(flow), render_model(flow)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        scenario = next(item for item in first["scenarios"] if item["id"] == "supervisor")
        self.assertEqual(first["version"], 2)
        self.assertEqual(scenario["layout"]["orientation"], "top-to-bottom")
        self.assertEqual({p["id"] for p in scenario["processes"]}, {"parent", "child-a", "child-b"})
        self.assertEqual(next(t for t in scenario["threads"] if t["id"] == "requests")["count"], "0..n")
        frames = scenario["layout"]["frames"]
        processes = {frame["id"]: frame for frame in frames["processes"]}
        threads = {frame["id"]: frame for frame in frames["threads"]}
        self.assertTrue(threads["second-main"]["context_only"])
        for thread in threads.values():
            parent = processes[thread["process"]]
            self.assertGreaterEqual(thread["left"], parent["left"])
            self.assertLessEqual(thread["right"], parent["right"])
            self.assertGreater(thread["top"], parent["top"])
            self.assertLess(thread["bottom"], parent["bottom"])
        self.assertLess(frames["external"][0]["right"], processes["parent"]["left"])
        events = {event["id"]: event for event in scenario["events"]}
        positions = scenario["layout"]["positions"]
        warning = io.StringIO()
        with contextlib.redirect_stderr(warning):
            clamped_model = render_model(flow, {"supervisor": {"construct": {"x": 1, "y": 1}}})
        clamped = next(item for item in clamped_model["scenarios"] if item["id"] == "supervisor")
        self.assertEqual(clamped["layout"]["positions"]["construct"], {
            "x": clamped["layout"]["lanes"]["main"]["left"] + 160,
            "y": clamped["layout"]["first_row"],
        })
        self.assertIn("clamped saved flow position", warning.getvalue())
        for link in scenario["links"]:
            if link["category"] == "sequence" and not link["loop"]:
                self.assertEqual(events[link["source"]]["thread"], events[link["target"]]["thread"])
                self.assertGreater(positions[link["target"]]["y"], positions[link["source"]]["y"])
            if link["category"] == "spawn":
                self.assertEqual(events[link["target"]]["kind"], "start")
        self.assertTrue(any(link["category"] == "message" for link in scenario["links"]))
        self.assertTrue(any(link["category"] == "signal" for link in scenario["links"]))
        self.assertTrue(any(link["loop"] and link["category"] == "sequence" for link in scenario["links"]))
        page = render_flow_html(flow, "execution-flows.md")
        for marker in ('class="runtime-view"', 'setAttribute("id", "thread-list")', "top-to-bottom execution paths"):
            self.assertIn(marker, page)
        self.assertIn('"count":"0..n"', page)
        self.assertNotIn("map-graph.html", page)
        self.assertNotRegex(page, r"<(?:script|link)[^>]+(?:src|href)=[\"']https?://")

    def test_version_two_rejects_unresolved_contexts_invalid_containment_and_cycles(self):
        source = EXECUTION_FIXTURE.read_text(encoding="utf-8")
        invalid_process = source.replace('process = "parent"', 'process = "missing-process"', 1)
        self.assertRegex(self.invalid(invalid_process, "unknown process reference 'missing-process'"), r"synthetic-invalid\.md:\d+ \[Scenarios\]")
        invalid_thread = source.replace('thread = "main"', 'thread = "missing-thread"', 1)
        self.assertRegex(self.invalid(invalid_thread, "unknown thread reference 'missing-thread'"), r"synthetic-invalid\.md:\d+ \[Scenarios\]")
        duplicate_thread = source.replace('id = "second-control"', 'id = "child-main"', 1)
        self.invalid(duplicate_thread, "duplicate threads ID 'child-main'")
        invalid_main = source.replace('id = "reconciler"\nname = "Supervisor loop thread"\nprocess = "parent"\ndaemon = true', 'id = "reconciler"\nname = "Supervisor loop thread"\nprocess = "parent"\nrole = "main"\ndaemon = true', 1)
        self.invalid(invalid_main, "at most one modeled main thread")
        cross_sequence = source.replace('source = "construct"\ntarget = "start-loop"\ntype = "continues"', 'source = "construct"\ntarget = "snapshot"\ntype = "continues"', 1)
        self.invalid(cross_sequence, "sequence links must stay in one executing thread")
        bad_spawn = source.replace('source = "spawn-child"\ntarget = "child-entry"', 'source = "spawn-child"\ntarget = "setup"', 1)
        self.invalid(bad_spawn, "spawn must target a start event in a different thread")
        unmarked_cycle = source.replace('[[scenario]]\nid = "child-setup"', '\n[[scenario.links]]\nid = "bad-cycle"\nsource = "diff"\ntarget = "snapshot"\ntype = "cycles"\ncategory = "sequence"\nguard = "unexpected recovery"\n\n[[scenario]]\nid = "child-setup"', 1)
        self.assertRegex(self.invalid(unmarked_cycle, "causal cycle must be an intentional loop=true edge"), r"synthetic-invalid\.md:\d+ \[Scenarios\]")
        bad_message = source.replace('source = "send-status"\ntarget = "read-status"\ntype = "status-pipe"', 'source = "send-status"\ntarget = "send-status"\ntype = "invalid same-thread message"', 1)
        self.invalid(bad_message, "message and signal links must cross execution contexts")
        missing_start = source.replace('id = "request-entry"\ntitle = "Enter request-handler thread"\nparticipant = "controller"\nthread = "requests"\nkind = "start"', 'id = "request-entry"\ntitle = "Enter request-handler thread"\nparticipant = "controller"\nthread = "requests"\nkind = "action"', 1)
        self.invalid(missing_start, "a thread with expanded events must have exactly one start event")

    def test_graph_model_is_deterministic_and_non_loop_edges_flow_left_to_right(self):
        flow = parse_flows_file(str(FIXTURE))
        first, second = render_model(flow), render_model(flow)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        for scenario in first["scenarios"]:
            positions = scenario["layout"]["positions"]
            for link in scenario["links"]:
                if not link["loop"]:
                    self.assertLess(positions[link["source"]]["x"], positions[link["target"]]["x"])

    def test_html_is_self_contained_and_inspectable(self):
        page = render_flow_html(parse_flows_file(str(FIXTURE)), "fixture.md")
        for marker in ('id="flow-data"', 'id="scenario-index"', "Open subflow", "UNKNOWN GAP", "data-link-id"):
            self.assertIn(marker, page)
        self.assertNotIn("map-graph.html", page)
        self.assertNotRegex(page, r"<(?:script|link)[^>]+(?:src|href)=[\"']https?://")
        self.assertNotIn("fetch(", page)

    def test_invalid_source_never_writes_plausible_partial_html(self):
        invalid = self.source.replace('id = "parse-options"', 'id = "invoke-cli"', 1)
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / "FLOWS.md", Path(temp) / "flow-graph.html"
            source.write_text(invalid, encoding="utf-8")
            with self.assertRaises(FlowFormatError):
                render_flow_file(str(source), str(output))
            self.assertFalse(output.exists())
            output.write_text("prior complete html", encoding="utf-8")
            with self.assertRaises(FlowFormatError):
                render_flow_file(str(source), str(output))
            self.assertEqual(output.read_text(encoding="utf-8"), "prior complete html")

    def test_default_cli_smokes_flow_only_map_only_both_and_neither(self):
        visualizer = SCRIPT_DIR / "visualize.py"
        owner_map = FIXTURE.parent / "owner-map.md"
        for has_flow, has_map in ((True, False), (False, True), (True, True), (False, False)):
            with self.subTest(flow=has_flow, map=has_map), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                folder = root / "map"
                folder.mkdir()
                if has_flow:
                    (folder / "FLOWS.md").write_text(self.source, encoding="utf-8")
                if has_map:
                    (folder / "MAP.md").write_text(owner_map.read_text(encoding="utf-8"), encoding="utf-8")
                command = [sys.executable, str(visualizer)]
                if has_flow and not has_map:
                    command.insert(1, "-S")  # flow-only mode must not depend on Pyvis
                result = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
                if has_flow or has_map:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                self.assertEqual((folder / "flow-graph.html").exists(), has_flow)
                self.assertEqual((folder / "map-graph.html").exists(), has_map)

    def test_layout_sidecar_validates_versions_coordinates_and_stale_ids(self):
        flow = parse_flows_file(str(FIXTURE))
        layout = {
            "version": 1,
            "scenarios": {
                "cli-startup": {
                    "parse-options": {"x": 910, "y": 460},
                    "removed-event": {"x": 500, "y": 300},
                    "invoke-cli": {"x": True, "y": 300},
                    "scan-argument": {"x": 400, "y": float("nan")},
                    "choose-settings": {"x": 1_000_001, "y": 300},
                },
                "deleted-scenario": {"obsolete": {"x": 400, "y": 300}},
            },
        }
        with tempfile.TemporaryDirectory() as temp:
            sidecar = Path(temp) / "flow-graph.layout.json"
            sidecar.write_text(json.dumps(layout), encoding="utf-8")
            loaded = load_saved_layout(str(sidecar), flow)
            self.assertEqual(loaded, {"cli-startup": {"parse-options": {"x": 910.0, "y": 460.0}}})
            rendered = render_model(flow, loaded)
            cli = next(item for item in rendered["scenarios"] if item["id"] == "cli-startup")
            self.assertEqual(cli["layout"]["positions"]["parse-options"], {"x": 910.0, "y": 460.0})
            self.assertNotIn("removed-event", cli["layout"]["positions"])

            sidecar.write_text(json.dumps({"version": True, "scenarios": {}}), encoding="utf-8")
            self.assertEqual(load_saved_layout(str(sidecar), flow), {})
            sidecar.write_text(json.dumps({"version": 2, "scenarios": {}}), encoding="utf-8")
            self.assertEqual(load_saved_layout(str(sidecar), flow), {})
            sidecar.write_text("{ malformed json", encoding="utf-8")
            self.assertEqual(load_saved_layout(str(sidecar), flow), {})
            self.assertEqual(layout_path_for_output("/tmp/custom-flow.html"), "/tmp/custom-flow.layout.json")

    def test_layout_round_trip_preserves_positions_and_new_events_use_causal_layout(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "map"
            folder.mkdir()
            source, output = folder / "FLOWS.md", folder / "flow-graph.html"
            source.write_text(self.source, encoding="utf-8")
            sidecar = folder / "flow-graph.layout.json"
            sidecar.write_text(json.dumps({"version": 1, "scenarios": {
                "cli-startup": {"parse-options": {"x": 820, "y": 420}, "stale-event": {"x": 400, "y": 300}},
                "stale-scenario": {"anything": {"x": 500, "y": 500}},
            }}), encoding="utf-8")
            original_source = source.read_text(encoding="utf-8")
            map_sidecar = folder / "map-graph.layout.json"
            map_sidecar.write_text("ownership layout stays untouched", encoding="utf-8")
            render_flow_file(str(source), str(output))
            html = output.read_text(encoding="utf-8")
            match = re.search(r'<script type="application/json" id="flow-data">([\s\S]*?)</script>', html)
            self.assertIsNotNone(match)
            embedded = json.loads(match.group(1))
            cli = next(item for item in embedded["scenarios"] if item["id"] == "cli-startup")
            self.assertEqual(cli["layout"]["positions"]["parse-options"], {"x": 820.0, "y": 420.0})
            self.assertEqual(source.read_text(encoding="utf-8"), original_source)
            self.assertEqual(map_sidecar.read_text(encoding="utf-8"), "ownership layout stays untouched")

            with_event = original_source.replace(
                '[[scenario.events]]\nid = "parse-options"',
                '''[[scenario.events]]
id = "new-step"
title = "New step"
participant = "cli-process"
kind = "action"

[[scenario.events]]
id = "parse-options"''',
                1,
            )
            source.write_text(with_event, encoding="utf-8")
            render_flow_file(str(source), str(output))
            embedded = json.loads(re.search(r'<script type="application/json" id="flow-data">([\s\S]*?)</script>', output.read_text(encoding="utf-8")).group(1))
            cli = next(item for item in embedded["scenarios"] if item["id"] == "cli-startup")
            self.assertNotEqual(cli["layout"]["positions"]["new-step"], {"x": 820.0, "y": 420.0})
            for link in cli["links"]:
                if not link["loop"]:
                    self.assertLess(cli["layout"]["positions"][link["source"]]["x"], cli["layout"]["positions"][link["target"]]["x"])

    def test_invalid_flow_does_not_suppress_map_output(self):
        owner_map = FIXTURE.parent / "owner-map.md"
        invalid = self.source.replace('id = "parse-options"', 'id = "invoke-cli"', 1)
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "map"
            folder.mkdir()
            (folder / "MAP.md").write_text(owner_map.read_text(encoding="utf-8"), encoding="utf-8")
            (folder / "FLOWS.md").write_text(invalid, encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT_DIR / "visualize.py")], cwd=temp, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((folder / "map-graph.html").exists())
            self.assertFalse((folder / "flow-graph.html").exists())


if __name__ == "__main__":
    unittest.main()
