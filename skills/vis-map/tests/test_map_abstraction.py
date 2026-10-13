import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import visualize  # noqa: E402


class MapAbstractionTests(unittest.TestCase):
    def test_depth_comes_only_from_entity_containment(self):
        entities = visualize.parse_entities([
            "# Project",
            "- **Type**: Entity",
            "## Backend",
            "- **Type**: Entity",
            "### Banking module",
            "- **Type**: Entity",
            "# Standalone tool",
            "- **Type**: Entity",
        ])
        depths = visualize.entity_abstraction_depths(entities)
        self.assertEqual(depths, {"Project": 0, "Backend": 1, "Banking module": 2})
        self.assertNotIn("Standalone tool", depths)

    def test_colors_are_sequential_and_uncontained_entities_are_neutral(self):
        depths = {"Project": 0, "Backend": 1, "Banking module": 2}
        colors = visualize.abstraction_depth_colors(depths)
        self.assertEqual(colors[0], visualize.ABSTRACTION_PALETTE[0][1])
        self.assertEqual(colors[2], visualize.ABSTRACTION_PALETTE[2][1])
        self.assertEqual(visualize.abstraction_depth_colors({"deep": 20})[20],
                         visualize.ABSTRACTION_PALETTE[-1][1])
        self.assertNotEqual(colors[0], colors[1])
        self.assertEqual(visualize.entity_color(None, colors), visualize.ENTITY_DEFAULT_COLOR)
        self.assertEqual(visualize.node_style("Entity", {}, colors, 1)["color"], colors[1])

    def test_legend_explains_depth_and_unranked_entities(self):
        self.assertEqual(visualize.OPTIONS["layout"]["randomSeed"], 1729)
        html = visualize.build_legend(
            {"Entity": {"shape": "box", "color": "red"}}, {}, [0, 1],
            {0: "#E75C40", 1: "#E27757"}, True,
        )
        self.assertIn("color by containment depth", html)
        self.assertIn("Level 1 (highest)", html)
        self.assertIn("Level 2", html)
        self.assertIn("Not ranked — no containment hierarchy", html)
        self.assertNotIn("Importance", html)


if __name__ == "__main__":
    unittest.main()
