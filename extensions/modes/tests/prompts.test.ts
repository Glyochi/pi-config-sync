import test from "node:test";
import assert from "node:assert/strict";
import { buildModeContext } from "../prompts.ts";
import type { PlanStateView } from "../state.ts";

const plan: PlanStateView = {
	id: "plan-123456789abc",
	title: "Add the parser",
	status: "open",
	path: ".pi/plans/plan-123456789abc.md",
	ownerSessionId: "session-a",
	ownedByCurrentSession: true,
	steps: ["Add parser", "Verify behavior"],
};

test("Ask context stays independent from an attached plan", () => {
	const context = buildModeContext("ask", { view: plan, markdown: "# Add the parser" });
	assert.match(context, /Treat each question independently/);
	assert.doesNotMatch(context, /plan-123456789abc/);
	assert.match(context, /ask_tools\//);
	assert.match(context, /honor explicit project-code requests/);
});

test("Plan context is read-only except for its owned attached Markdown", () => {
	const context = buildModeContext("plan", { view: plan, markdown: "# Add the parser" });
	assert.match(context, /Plan mode is read-only/);
	assert.match(context, /only project file Plan mode may edit/);
	assert.match(context, /# Add the parser/);
});

test("Build context carries an open plan only after a user request", () => {
	const context = buildModeContext("build", { view: plan, markdown: "# Add the parser" });
	assert.match(context, /next user request asks to continue/);
	assert.match(context, /Plan file: \.pi\/plans\/plan-123456789abc\.md/);
});

test("blocked and stale plan contexts do not authorize implementation", () => {
	const blocked = buildModeContext("build", { view: { ...plan, status: "blocked", blockedReason: "Need input" }, markdown: "# Add the parser" });
	assert.match(blocked, /is blocked: Need input/);
	const stale = buildModeContext("build", { view: { ...plan, ownedByCurrentSession: false }, markdown: "# Add the parser" }, true);
	assert.match(stale, /owned by another session/);
});
