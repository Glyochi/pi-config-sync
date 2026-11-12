import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { branchBlocks } from "../log-format.ts";
import { load, root, sdk } from "./helpers.mjs";

const agentDir = resolve(root, "../..");

test("all toolkit commands, tools, and the extension package share the learn prefix", async (t) => {
	const f = await load(); t.after(f.close);
	assert.equal(basename(root), "learn");
	assert.deepEqual([...f.extension.commands.keys()].sort(), ["learn-doctor", "learn-log", "learn-unlog"]);
	assert.deepEqual([...f.extension.tools.keys()].sort(), ["learn_checkpoint", "learn_quiz", "learn_status"]);
	for (const { definition } of f.extension.tools.values()) assert.ok(definition.label.startsWith("Learn "));
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	assert.equal(manifest.name, "learn-toolkit");
	assert.equal(lock.name, manifest.name);
	assert.equal(lock.packages[""].name, manifest.name);
	const info = await f.tool("learn_status").execute("info", {}, undefined, undefined, f.ctx);
	assert.ok(info.details.teachingSkillPath.endsWith(join("skills", "learn-teach", "SKILL.md")));
});

test("prefixed skills are discoverable under matching directories and remain opt-in", async (t) => {
	const f = await load(); t.after(f.close);
	const loader = new sdk.DefaultResourceLoader({
		cwd: f.ctx.cwd, agentDir: join(f.ctx.cwd, "agent"),
		settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalSkillPaths: ["learn-teach", "learn-visualize"].map((name) => join(agentDir, "skills", name)),
	});
	await loader.reload();
	const { skills, diagnostics } = loader.getSkills();
	assert.deepEqual(diagnostics, []);
	assert.deepEqual(skills.map((skill) => skill.name).sort(), ["learn-teach", "learn-visualize"]);
	for (const skill of skills) {
		assert.equal(skill.disableModelInvocation, true);
		assert.equal(basename(dirname(skill.filePath)), skill.name);
	}
});

test("maker tool registrations match the prefixed agent allowlists and prompts", async (t) => {
	for (const kind of ["mermaid", "svg"]) {
		const f = await load(`visual-tools/${kind}.ts`); t.after(f.close);
		const tools = [...f.extension.tools.keys()];
		assert.deepEqual(tools, [`learn_write_${kind}`, `learn_edit_${kind}`, `learn_render_${kind}`]);
		const agent = readFileSync(join(agentDir, "agents", "learn", `${kind}-maker.md`), "utf8");
		assert.match(agent, /^package: learn$/m);
		assert.deepEqual(/^tools: (.+)$/m.exec(agent)[1].split(", "), [...tools, "read"]);
		assert.deepEqual(/^mutationTools: (.+)$/m.exec(agent)[1].split(", "), tools);
		assert.doesNotMatch(agent, /\b(?:write|edit|render)_(?:mermaid|svg)\b/);
	}
});

test("historical quiz results retain identical note marker keys after the tool rename", () => {
	const result = (toolName) => [{ type: "message", message: {
		role: "toolResult", toolName, toolCallId: "same-call", details: {
			status: "answered", question: "A or B?", options: [{ index: 1, label: "A" }, { index: 2, label: "B" }],
			answers: [{ index: 1, label: "A" }], correctIndices: [1], correct: true, explanation: "A is correct.",
		},
	} }];
	const legacy = branchBlocks(result("quiz"));
	assert.equal(legacy.length, 2);
	assert.deepEqual(branchBlocks(result("learn_quiz")), legacy);
});
