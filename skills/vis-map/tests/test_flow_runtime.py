import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "execution-flows.md"
sys.path.insert(0, str(SCRIPTS))
from flow_visualize import FlowFormatError, parse_flows_file, parse_flows_text, render_flow_file, render_flow_html, render_model


class RuntimeFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = FIXTURE.read_text(encoding="utf-8")

    def invalid(self, source, message):
        with self.assertRaises(FlowFormatError) as caught:
            parse_flows_text(source, "execution-invalid.md")
        self.assertRegex(str(caught.exception), r"execution-invalid\.md:\d+ \[")
        self.assertIn(message, str(caught.exception))

    def test_explicit_contexts_and_component_execution_are_independent(self):
        flow = parse_flows_file(str(FIXTURE))
        self.assertEqual(flow["version"], 2)
        scenario = flow["scenarios"][0]
        self.assertEqual(len(scenario["processes"]), 3)
        self.assertEqual(len(scenario["threads"]), 8)
        self.assertEqual(next(t for t in scenario["threads"] if t["id"] == "requests")["count"], "0..n")
        calls = [e for e in scenario["events"] if e["participant"] == "store"]
        self.assertEqual({e["thread"] for e in calls}, {"reconciler", "control"})
        self.assertNotIn("store", {t["id"] for t in scenario["threads"]})
        self.assertEqual({l["category"] for l in scenario["links"]}, {"sequence", "spawn", "message", "signal"})

    def test_context_validation_is_strict_and_source_located(self):
        for old, new, message in [
            ('id = "child-b"', 'id = "child-a"', "duplicate processes ID"),
            ('id = "second-control"', 'id = "child-control"', "duplicate threads ID"),
            ('process = "parent"', 'process = "absent"', "unknown process reference"),
            ('thread = "main"', 'thread = "absent"', "unknown thread reference"),
            ('thread = "main"\nkind = "start"', 'kind = "start"', "missing required string field 'thread'"),
            ('count = "0..n"', 'count = true', "count must be"),
            ('count = 1', 'count = 0', "count must be"),
            ('role = "main"', 'role = "alien"', "thread role must be"),
            ('daemon = false', 'daemon = "false"', "must be a boolean"),
            ('kind = "trigger"', 'thread = "main"\nkind = "trigger"', "external events must not reference"),
            ('category = "signal"', 'category = "unknown"', "category must be"),
        ]:
            with self.subTest(new=new):
                self.invalid(self.source.replace(old, new, 1), message)
        duplicate_main = self.source.replace('name = "Supervisor loop thread"', 'name = "Supervisor loop thread"\nrole = "main"', 1)
        self.invalid(duplicate_main, "at most one modeled main thread")
        self.invalid(self.source.replace('role = "main"', 'role = "main"\ncount = "1..n"', 1), "at most one modeled main thread")

    def test_links_cannot_fake_execution_or_spawn_semantics(self):
        self.invalid(self.source.replace('category = "spawn"', 'category = "sequence"', 1), "sequence links must stay")
        self.invalid(self.source.replace('category = "spawn"', 'category = "message"', 1).replace('target = "loop-entry"', 'target = "snapshot"', 1), "spawn must target a start event")
        extra = '\n[[scenario.links]]\nid = "after-stop"\nsource = "stopped"\ntarget = "tick-complete"\ntype = "continues"\ncategory = "sequence"\n'
        self.invalid(self.source.replace('[[scenario]]\nid = "child-setup"', extra + '\n[[scenario]]\nid = "child-setup"', 1), "termination cannot continue")
        self.invalid(self.source.replace('loop = true\n', '', 1), "causal cycle")
        self.invalid(self.source.replace('guard = "until stopped"', '', 1), "require a guard")
        self.invalid(self.source.replace('guard = "child already present"', 'guard = "child missing"', 1), "distinct, guarded")
        self.invalid(self.source.replace('target = "settings", datatype = "settings"', 'target = "missing", datatype = "settings"', 1), "binding target port")

    def test_version_one_remains_supported_and_does_not_infer_contexts(self):
        legacy = parse_flows_file(str(FIXTURE.with_name("intended-flows.md")))
        self.assertEqual(legacy["version"], 1)
        self.assertNotIn("threads", legacy["scenarios"][0])
        self.assertNotIn("thread-frame", render_flow_html(legacy))
        self.invalid(self.source.replace('version = 2', 'version = 1', 1), "unknown field(s)")
        self.invalid(self.source.replace('version = 2', 'version = true', 1), "version must be integer")

    def test_deterministic_layout_nests_frames_and_orders_execution(self):
        flow = parse_flows_file(str(FIXTURE))
        model = render_model(flow)
        self.assertEqual(model, render_model(flow))
        s = model["scenarios"][0]
        layout = s["layout"]
        frames = {t["id"]: t for t in layout["frames"]["threads"]}
        processes = {p["id"]: p for p in layout["frames"]["processes"]}
        for thread in frames.values():
            process = processes[thread["process"]]
            self.assertGreater(thread["left"], process["left"])
            self.assertLess(thread["right"], process["right"])
            self.assertGreater(thread["top"], process["top"])
            self.assertLess(thread["bottom"], process["bottom"])
        for event in s["events"]:
            point = layout["positions"][event["id"]]
            if event.get("thread"):
                frame = frames[event["thread"]]
                self.assertGreaterEqual(point["x"] - 130, frame["left"])
                self.assertLessEqual(point["x"] + 130, frame["right"])
                self.assertGreater(point["y"] - 86, frame["top"] + 66)
                self.assertLess(point["y"] + 86, frame["bottom"])
        self.assertTrue(frames["second-main"]["context_only"])
        for link in s["links"]:
            if not link["loop"]:
                self.assertLess(layout["positions"][link["source"]]["y"], layout["positions"][link["target"]]["y"])
        parent_threads = [frame for frame in frames.values() if frame["process"] == "parent"]
        for first, second in zip(parent_threads, parent_threads[1:]):
            self.assertLess(first["right"], second["left"])

    def test_saved_positions_refit_frames_and_cannot_move_events_to_another_thread(self):
        flow = parse_flows_file(str(FIXTURE))
        original = render_model(flow)
        point = original["scenarios"][0]["layout"]["positions"]["snapshot"]
        moved = {"x": point["x"] + 20, "y": point["y"] + 600}
        model = render_model(flow, {"supervisor": {"snapshot": moved}})
        self.assertEqual(model["scenarios"][0]["layout"]["positions"]["snapshot"], moved)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            clamped = render_model(flow, {"supervisor": {"snapshot": {"x": 99999, "y": 140}}})
        self.assertIn("clamped saved flow position", stderr.getvalue())
        scenario = clamped["scenarios"][0]
        node = next(e for e in scenario["events"] if e["id"] == "snapshot")
        self.assertEqual(node["thread"], "reconciler")
        bounds = next(t for t in scenario["layout"]["frames"]["threads"] if t["id"] == node["thread"])
        actual = scenario["layout"]["positions"][node["id"]]
        self.assertLess(actual["x"] + 130, bounds["right"])
        self.assertGreater(actual["y"] - 86, bounds["top"])

    def test_grouped_html_is_offline_safe_and_invalid_v2_does_not_replace_output(self):
        flow = parse_flows_file(str(FIXTURE))
        page = render_flow_html(flow)
        self.assertIn("process-frame", page)
        self.assertIn("thread-frame", page)
        self.assertIn("data-execution-thread", page)
        self.assertIn("Execution threads", page)
        self.assertNotIn("map-graph.html", page)
        self.assertNotIn("fetch(", page)
        self.assertNotRegex(page, r'<(?:script|link)[^>]+(?:src|href)=["\']https?://')
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "FLOWS.md", Path(directory) / "flow.html"
            source.write_text(self.source, encoding="utf-8")
            render_flow_file(str(source), str(output))
            complete = output.read_text(encoding="utf-8")
            source.write_text(self.source.replace('thread = "main"', 'thread = "absent"', 1), encoding="utf-8")
            with self.assertRaises(FlowFormatError):
                render_flow_file(str(source), str(output))
            self.assertEqual(output.read_text(encoding="utf-8"), complete)


if __name__ == "__main__":
    unittest.main()
