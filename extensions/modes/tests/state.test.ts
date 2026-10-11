import test from "node:test";
import assert from "node:assert/strict";
import {
	MODE_STATE_ENTRY_TYPE,
	MODE_STATE_EVENT,
	decodePersistedModeState,
	latestModeState,
	makeModeStateSnapshot,
	permissionProfileFor,
	nextMode,
	shouldToggleModeOnTab,
	summarizePlanMarkdown,
} from "../state.ts";
import { inspectPlanMarkdown, createPlanTemplate } from "../plan-markdown.ts";

test("mode state accepts Ask/Plan/Build and rejects unknown schema", () => {
	assert.deepEqual(decodePersistedModeState({ version: 1, mode: "ask" }), { version: 1, mode: "ask" });
	assert.equal(decodePersistedModeState({ version: 1, mode: "bogus" }), undefined);
	assert.equal(decodePersistedModeState({ version: 2, mode: "build" }), undefined);
});

test("mode contract uses the modes namespace", () => {
	assert.equal(MODE_STATE_ENTRY_TYPE, "modes-state");
	assert.equal(MODE_STATE_EVENT, "modes:state.v1");
});

test("latest valid branch entry wins", () => {
	assert.equal(latestModeState([
		{ customType: MODE_STATE_ENTRY_TYPE, data: { version: 1, mode: "plan" } },
		{ customType: "other", data: { version: 1, mode: "ask" } },
		{ customType: MODE_STATE_ENTRY_TYPE, data: { version: 1, mode: "ask", activePlanId: "plan-a" } },
	])?.mode, "ask");
});

test("Ask uses the Build permission profile", () => {
	assert.equal(permissionProfileFor("ask"), "build");
	assert.equal(permissionProfileFor("build"), "build");
	assert.equal(permissionProfileFor("plan"), "plan");
});

test("Tab toggles only between Plan and Build and stays disabled in Ask", () => {
	assert.equal(shouldToggleModeOnTab("build", false), true);
	assert.equal(shouldToggleModeOnTab("plan", false), true);
	assert.equal(shouldToggleModeOnTab("ask", false), false);
	assert.equal(shouldToggleModeOnTab("ask", true), false);
	assert.equal(shouldToggleModeOnTab("build", true), false);
	assert.equal(shouldToggleModeOnTab("plan", true), false);
	assert.equal(nextMode("build"), "plan");
	assert.equal(nextMode("plan"), "build");
	assert.equal(nextMode("ask"), "ask");
});


test("UI state snapshots are versioned, JSON-safe, and include the effective profile", () => {
	const snapshot = makeModeStateSnapshot({ kind: "snapshot", sessionId: "s1", cwd: "/repo", mode: "ask", artifacts: [{ path: "ask_tools/a.html", label: "a", kind: "html" }], updatedAt: 123 });
	assert.equal(snapshot.schemaVersion, 1);
	assert.equal(snapshot.permissionProfile, "build");
	assert.equal(JSON.parse(JSON.stringify(snapshot)).artifacts[0].path, "ask_tools/a.html");
});

test("plan summary ignores fenced examples and gives work items stable IDs", () => {
	const markdown = "# Learn the parser\n\n## Implementation Steps\n1. Add the parser.\n\n```md\n1. Not a real step.\n```\n2. Verify parsing.\n";
	const summary = summarizePlanMarkdown(markdown);
	assert.equal(summary.title, "Learn the parser");
	assert.deepEqual(summary.steps.map(({ order, title, status }) => ({ order, title, status })), [
		{ order: 1, title: "Add the parser.", status: "planned" },
		{ order: 2, title: "Verify parsing.", status: "planned" },
	]);
	const reordered = summarizePlanMarkdown("# Learn the parser\n\n## Implementation Steps\n1. Verify parsing.\n2. Add the parser.\n");
	assert.equal(summary.steps[0]?.id, reordered.steps[1]?.id);
});

test("plan Goal summary is plain text, bounded, and excludes other sections and fenced examples", () => {
	const markdown = [
		"# Parser cleanup",
		"",
		"## Goal",
		"Build **a fast** parser with `stable IDs` and [clear output](https://example.test).",
		"",
		"```md",
		"## Scope",
		"This fenced text is not a heading.",
		"```",
		"",
		"## Scope",
		"Do not include this boundary text.",
		"",
		"## Implementation Steps",
		"1. Add tests.",
	].join("\n");
	const summary = summarizePlanMarkdown(markdown);
	assert.equal(summary.goalSummary, "Build a fast parser with stable IDs and clear output.");
	assert.equal(summarizePlanMarkdown("# No goal here\n\n## Scope\nNot a Goal.").goalSummary, undefined);
	const longGoal = summarizePlanMarkdown(`# Long\n\n## Goal\n${"word ".repeat(100)}`).goalSummary;
	assert.equal(longGoal?.length, 240);
	assert.equal(longGoal?.endsWith("…"), true);
});

test("plan template satisfies the lightweight plan format", () => {
	const template = createPlanTemplate("  Learn   parsing  ");
	assert.equal(inspectPlanMarkdown(template).title, "Learn parsing");
	assert.deepEqual(inspectPlanMarkdown(template).steps, ["Describe the first discrete work unit."]);
});

test("plan validation requires title, verification, and numbered steps", () => {
	assert.throws(() => inspectPlanMarkdown("No headings"), /top-level title/);
	assert.throws(() => inspectPlanMarkdown("# A plan\n\n## Implementation Steps\n1. Do it"), /Verification/);
	assert.throws(() => inspectPlanMarkdown("# A plan\n\n## Verification\n\n- Test\n\n## Implementation Steps\nNo steps"), /numbered steps/);
});
