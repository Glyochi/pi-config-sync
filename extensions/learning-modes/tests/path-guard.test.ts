import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canMutateFile, isAttachedPlanPath, isPlanMarkdownPath, isProjectPlanPath, resolveToolPath } from "../path-guard.ts";

test("plan guard normalizes relative, absolute, tilde, and @ paths", () => {
	const cwd = "/tmp/mode-guard-project";
	assert.equal(isPlanMarkdownPath(cwd, ".pi/plans/plan-a.md"), true);
	assert.equal(isPlanMarkdownPath(cwd, path.join(cwd, ".pi", "plans", "plan-a.md")), true);
	assert.equal(isProjectPlanPath(cwd, ".pi/plans/state.json"), true);
	assert.equal(isPlanMarkdownPath(cwd, ".pi/plans/notes.txt"), false);
	assert.equal(isProjectPlanPath(cwd, "src/plan.md"), false);
	assert.equal(resolveToolPath(cwd, "@.pi/plans/plan-a.md"), path.join(cwd, ".pi", "plans", "plan-a.md"));
});

test("attached plan guard resolves symlink aliases", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mode-guard-"));
	try {
		const plans = path.join(cwd, ".pi", "plans");
		fs.mkdirSync(plans, { recursive: true });
		const plan = path.join(plans, "plan-a.md");
		fs.writeFileSync(plan, "# plan\n");
		const alias = path.join(cwd, "alias.md");
		fs.symlinkSync(plan, alias);
		assert.equal(isAttachedPlanPath(cwd, alias, "plan-a"), true);
		const outside = path.join(cwd, "outside.md");
		fs.writeFileSync(outside, "# outside\n");
		const insideAlias = path.join(plans, "outside-link.md");
		fs.symlinkSync(outside, insideAlias);
		assert.equal(isProjectPlanPath(cwd, insideAlias), true);
	} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("only an owning Plan session can edit its attached plan Markdown", () => {
	const cwd = "/tmp/mode-guard-project";
	assert.equal(canMutateFile("plan", cwd, ".pi/plans/plan-a.md", "plan-a", true), true);
	assert.equal(canMutateFile("plan", cwd, ".pi/plans/plan-b.md", "plan-a", true), false);
	assert.equal(canMutateFile("plan", cwd, ".pi/plans/plan-a.md", "plan-a", false), false);
	assert.equal(canMutateFile("plan", cwd, "src/app.ts", "plan-a", true), false);
	assert.equal(canMutateFile("plan", cwd, undefined, "plan-a", true), false);
	assert.equal(canMutateFile("ask", cwd, ".pi/plans/plan-a.md", "plan-a", true), false);
	assert.equal(canMutateFile("build", cwd, ".pi/plans/state.json", "plan-a", true), false);
	assert.equal(canMutateFile("ask", cwd, "ask_tools/visual.html", "plan-a", true), true);
	assert.equal(canMutateFile("build", cwd, "src/app.ts", "plan-a", true), true);
	// Pathless editors remain available in Ask/Build but cannot be proven safe.
	assert.equal(canMutateFile("ask", cwd, undefined, "plan-a", true), true);
});
