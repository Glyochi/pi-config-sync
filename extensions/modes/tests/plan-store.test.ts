import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlanStore, planIndexPath, planMarkdownPath } from "../plan-store.ts";

async function withTempProject(run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "modes-"));
	try { await run(cwd); }
	finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test("plan store creates project-local Markdown and blocks a second open plan", async () => {
	await withTempProject(async (cwd) => {
		const store = new PlanStore(cwd);
		const plan = await store.create("Learn parsing", "session-a");
		assert.equal(plan.status, "open");
		assert.equal(plan.path, `.pi/plans/${plan.id}.md`);
		assert.equal(fs.existsSync(planMarkdownPath(cwd, plan.id)), true);
		assert.equal(fs.existsSync(planIndexPath(cwd)), true);
		await assert.rejects(() => store.create("Another plan", "session-b"), /open plan/);
	});
});

test("resume transfers ownership and stale owners cannot update status", async () => {
	await withTempProject(async (cwd) => {
		const store = new PlanStore(cwd);
		const plan = await store.create("Learn parsing", "session-a");
		const originalMarkdown = store.readMarkdown(plan.id);
		const resumed = await store.claim(plan.id, "session-b");
		assert.equal(resumed.ownerSessionId, "session-b");
		await assert.rejects(() => store.setStatus(plan.id, "session-a", "completed"), /no longer owns/);
		const completed = await store.setStatus(plan.id, "session-b", "completed");
		assert.equal(completed.status, "completed");
		assert.equal(store.readMarkdown(plan.id), originalMarkdown, "status transitions must not rewrite plan Markdown");
	});
});

test("blocked plans can be resumed and reopened by their new owner", async () => {
	await withTempProject(async (cwd) => {
		const store = new PlanStore(cwd);
		const plan = await store.create("Learn parsing", "session-a");
		const blocked = await store.setStatus(plan.id, "session-a", "blocked", "Need an input.");
		assert.equal(blocked.blockedReason, "Need an input.");
		const reopened = await store.claim(plan.id, "session-b");
		assert.equal(reopened.status, "open");
		assert.equal(reopened.blockedReason, undefined);
	});
});
