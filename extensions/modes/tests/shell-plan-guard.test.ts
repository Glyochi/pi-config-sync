import test from "node:test";
import assert from "node:assert/strict";
import { commandReferencesProjectPlans, isClearlyReadOnlyCommand, shouldBlockShellCommand } from "../shell-plan-guard.ts";

test("shell guard detects recognizable project plan paths and leaves unrelated commands alone", () => {
	assert.equal(commandReferencesProjectPlans("echo x > .pi/plans/plan-a.md"), true);
	assert.equal(commandReferencesProjectPlans("sed -i s/a/b/ /workspace/.pi/plans/plan-a.md"), true);
	assert.equal(commandReferencesProjectPlans("python -c 'open(\".pi/plans/plan-a.md\", \"w\")'"), true);
	assert.equal(commandReferencesProjectPlans("git status --short"), false);
	assert.equal(isClearlyReadOnlyCommand("cat .pi/plans/plan-a.md"), true);
	assert.equal(isClearlyReadOnlyCommand("git status && cat .pi/plans/plan-a.md"), true);
	assert.equal(isClearlyReadOnlyCommand("sed -i s/a/b/ .pi/plans/plan-a.md"), false);
	assert.equal(isClearlyReadOnlyCommand("echo x > .pi/plans/plan-a.md"), false);
	assert.equal(shouldBlockShellCommand("plan", "npm test"), true);
	assert.equal(shouldBlockShellCommand("plan", "git status && git diff"), false);
	assert.equal(shouldBlockShellCommand("ask", "echo x > .pi/plans/plan-a.md"), true);
	assert.equal(shouldBlockShellCommand("build", "python make_visual.py"), false);
	assert.equal(shouldBlockShellCommand("ask", "cat .pi/plans/plan-a.md"), false);
});
