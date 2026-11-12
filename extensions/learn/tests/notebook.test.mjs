import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceState, createSection, GOAL_START, markerLines, progressPath, readSections, readState, renderGoal, renderMermaid, renderNavigation, renderSection, SECTION_ENTRY, TOC_END, TOC_START } from "../notebook.ts";
import { appendNotebook, checkpointNotebook, logMarker } from "../note-store.ts";
import { branchBlocks } from "../log-format.ts";
import { load, root } from "./helpers.mjs";

const entry = (id, role, content) => ({ id, type: "message", message: { role, content } });
const read = (file) => readFileSync(file, "utf8");
const update = (extra = {}) => ({ expectedRevision: 0, initialize: true, goal: "Understand transforms", nextStep: "Build coefficient extraction", topics: [{ id: "samples", title: "Samples and patterns", status: "current" }, { id: "coefficients", title: "Coefficient extraction", status: "upcoming", dependsOn: ["samples"] }], ...extra });
const call = (f, id, params) => f.tool("learn_checkpoint").execute(id, params, new AbortController().signal, undefined, f.ctx);
const state = () => advanceState(undefined, update(), "2026-11-12T00:00:00.000Z");
const status = async (f) => (await f.tool("learn_status").execute("status", {}, undefined, undefined, f.ctx)).details;
async function fixture(t) {
	const f = await load(); t.after(f.close);
	f.note = join(f.ctx.cwd, "A lesson.md");
	f.goal = progressPath(f.note);
	writeFileSync(f.note, "---\ntags: [learning]\n---\n# My notes\nKeep my introduction.\n");
	f.branch.push(entry("first", "user", "Teach me"), entry("second", "assistant", "An explanation with $x^2$."));
	await f.command("learn-log", f.note);
	return f;
}

// Pure state/formatting contracts.
test("navigation preserves frontmatter and source prose and links every unique section heading", () => {
	const s = state();
	const one = createSection("a".repeat(24), 1, { topic: "samples" }, s);
	const two = createSection("b".repeat(24), 2, { topic: "samples" }, s);
	const original = "---\ntags: [learning]\n---\n# Personal title\nMy prose stays.\n" + renderSection(one) + "\nA message.\n" + renderSection(two);
	const indexed = renderNavigation(original, s, "A lesson.goal.md");
	assert.ok(indexed.startsWith("---\ntags: [learning]\n---\n" + TOC_START));
	assert.ok(indexed.endsWith(original.slice(original.indexOf("# Personal title"))));
	assert.deepEqual(readState(indexed), s);
	assert.equal(renderNavigation(indexed, s, "A lesson.goal.md"), indexed);
	for (const section of readSections(indexed)) {
		assert.ok(indexed.includes(`[[#${section.heading}|`));
		assert.equal(indexed.split(`\n## ${section.heading}\n`).length - 1, 1);
	}
	assert.match(indexed, /A%20lesson\.goal\.md/);
	const goal = renderGoal("---\nprivate: true\n---\nMy personal remarks.\n", s, "A lesson.md", [one, two]);
	assert.match(goal, /A%20lesson\.md#01%20-%20Samples%20and%20patterns/);
	assert.ok(goal.endsWith("My personal remarks.\n"));
	assert.match(goal, /```mermaid\nflowchart TD/);
	assert.equal(renderGoal(goal, s, "A lesson.md", [one, two]), goal);
	assert.deepEqual(readState(indexed.replaceAll("\n", "\r\n")), s);
	assert.equal(readSections(indexed.replaceAll("\n", "\r\n")).length, 2);
	const bom = renderNavigation("\uFEFF# BOM note\n", s, "goal.md");
	assert.equal(readState(bom).revision, 1);
	assert.ok(bom.startsWith("\uFEFF" + TOC_START));
});

test("topic updates retain omitted topics, evidence and prerequisites; stale/cyclic/unsupported state is refused", () => {
	let s = state();
	s = advanceState(s, { expectedRevision: 1, topics: [{ id: "samples", title: "Samples", status: "completed", evidence: "Explained list entries and scaled whole patterns in several examples." }, { id: "coefficients", title: "Coefficients", status: "current" }] });
	assert.deepEqual(s.topics[1].dependsOn, ["samples"]);
	const next = advanceState(s, { expectedRevision: 2, topics: [{ id: "samples", title: "Samples", status: "review" }] });
	assert.ok(next.topics[0].evidence);
	assert.equal(next.topics.length, 2);
	assert.throws(() => advanceState(s, { expectedRevision: 1 }), /Read learn_status/);
	assert.throws(() => advanceState(undefined, { ...update(), initialize: false }), /permission/);
	assert.throws(() => advanceState(undefined, update({ topics: [{ id: "a", title: "A", status: "completed" }] })), /demonstrated/);
	assert.throws(() => advanceState(s, { expectedRevision: 2, topics: [{ id: "samples", title: "Samples", status: "current" }] }), /At most one/);
	assert.throws(() => advanceState(s, { expectedRevision: 2, topics: [{ id: "samples", title: "Samples", status: "completed", dependsOn: ["coefficients"] }] }), /cycles/);
	assert.throws(() => advanceState(s, { expectedRevision: 2, topics: [{ id: "samples", title: "Samples", status: "review", dependsOn: ["missing"] }] }), /Unknown prerequisite/);
	assert.throws(() => readState(TOC_START + "\n" + TOC_END), /missing/);
	assert.throws(() => renderNavigation(TOC_START + "\nBroken", s, "goal.md"), /Malformed/);
	assert.throws(() => renderNavigation("---\nUnclosed frontmatter\n", s, "goal.md"), /Unclosed/);
});

test("generated marker examples in fenced code are not adopted and state/diagram text is escaped", () => {
	const s = advanceState(undefined, update({ goal: "Understand --> <script>", topics: [{ id: "safe", title: 'A [quoted] "topic" <test>', status: "current" }] }));
	const code = "```md\n" + TOC_START + "\nExample\n" + TOC_END + "\n```\n";
	assert.equal(readState(code), undefined);
	const indexed = renderNavigation(code, s, "goal.md");
	assert.equal(readState(indexed).goal, s.goal);
	assert.ok(indexed.endsWith(code));
	assert.match(renderMermaid(s), /#34;topic#34;/);
	assert.doesNotMatch(renderMermaid(s), /<test>/);
	assert.equal(markerLines(indexed).filter((l) => l.text === TOC_START).length, 1);
});

// Real extension lifecycle + filesystem integration (no model calls).
test("linking remains opt-in and append-only until a consented checkpoint initializes both views", async (t) => {
	const f = await fixture(t), original = read(f.note);
	assert.equal(existsSync(f.goal), false);
	assert.equal((await status(f)).progressRevision, 0);
	await assert.rejects(call(f, "no-consent", { ...update(), initialize: false }), /permission/);
	assert.equal(read(f.note), original);
	const result = await call(f, "init", update({ sections: [{ topic: "samples" }] }));
	assert.equal(result.details.state.revision, 1);
	assert.equal(existsSync(f.goal), true);
	assert.match(read(f.note), /## Contents/);
	assert.match(read(f.goal), /Coefficient extraction/);
	assert.ok(read(f.note).includes(original.slice(original.indexOf("# My notes"))));
	assert.equal((await status(f)).progressRevision, 1);
	assert.equal(f.tool("learn_checkpoint").executionMode, "sequential");
	const after = read(f.note), companion = read(f.goal);
	await f.emit("agent_end"); await f.emit("session_start"); await f.command("learn-log", f.note);
	assert.equal(read(f.note), after);
	assert.equal(read(f.goal), companion);
});

test("historical backfill inserts only section boundaries and TOC; old markers/messages stay byte-for-byte", async (t) => {
	const f = await fixture(t), original = read(f.note);
	const first = logMarker("lesson-test", "message:first"), second = logMarker("lesson-test", "message:second");
	await call(f, "history", update({ sections: [{ title: "Setup", before: first }, { topic: "samples", before: second }] }));
	const after = read(f.note), sections = readSections(after);
	assert.equal(sections.length, 2);
	assert.ok(after.indexOf("## 01 - Setup") < after.indexOf(`<!-- pi-learn:${first} -->`));
	assert.ok(after.indexOf("## 02 - Samples and patterns") < after.indexOf(`<!-- pi-learn:${second} -->`));
	for (const marker of [first, second]) {
		const text = `<!-- pi-learn:${marker} -->`;
		const tail = original.slice(original.indexOf(text)).split(/\n\n<!-- pi-learn:/)[0];
		assert.ok(after.includes(tail));
	}
	const beforeFailure = read(f.note);
	await assert.rejects(call(f, "missing-marker", { expectedRevision: 1, sections: [{ topic: "samples", before: "f".repeat(24) }] }), /missing or ambiguous/);
	assert.equal(read(f.note), beforeFailure);
});

test("progress checkpoints preserve personal prose in both files and group future quizzes without exposing answers", async (t) => {
	const f = await fixture(t);
	await call(f, "init", update({ sections: [{ topic: "samples" }] }));
	writeFileSync(f.goal, read(f.goal) + "\n## My personal notes\nLeave this alone.\n");
	f.branch.push(entry("new", "assistant", "A later explanation."));
	await call(f, "next", { expectedRevision: 1, topics: [{ id: "samples", title: "Samples and patterns", status: "completed", evidence: "Correctly distinguished samples, whole patterns, and their coefficients in several tasks." }, { id: "coefficients", title: "Coefficient extraction", status: "current" }], sections: [{ topic: "coefficients" }] });
	assert.ok(read(f.goal).endsWith("\n## My personal notes\nLeave this alone.\n"));
	assert.match(read(f.goal), /Completed/);
	const pending = { question: "Which coefficient?", options: [{ label: "One" }, { label: "Two" }] };
	await f.emit("tool_execution_update", { toolName: "learn_quiz", toolCallId: "q", partialResult: { details: pending } });
	assert.match(read(f.note), /Which coefficient/);
	assert.doesNotMatch(read(f.note), /Secret explanation/);
	assert.ok(read(f.note).lastIndexOf("Which coefficient") > read(f.note).lastIndexOf("## 02 - Coefficient extraction"));
	const result = { content: [], details: { ...pending, status: "answered", answers: [{ index: 1, label: "One" }], correctIndices: [1], correct: true, explanation: "Secret explanation" } };
	await f.emit("tool_execution_end", { toolName: "learn_quiz", toolCallId: "q", result, isError: false });
	f.branch.push({ type: "message", message: { ...result, role: "toolResult", toolName: "learn_quiz", toolCallId: "q" } });
	const once = read(f.note); await f.emit("agent_end"); assert.equal(read(f.note), once);
	assert.equal(readState(once).topics[1].status, "current", "quiz scoring must not auto-promote topics");
});

test("fresh sessions recover note-owned progress and stale checkpoints cannot overwrite it", async (t) => {
	const f = await fixture(t); await call(f, "init", update({ sections: [{ topic: "samples" }] }));
	const other = await load(); t.after(other.close);
	assert.equal((await status(other)).progress, null);
	await other.command("learn-log", f.note);
	assert.equal((await status(other)).progressRevision, 1);
	await call(other, "fresh-update", { expectedRevision: 1, nextStep: "A newer goal" });
	const before = read(f.note), goal = read(f.goal);
	await assert.rejects(call(f, "stale-update", { expectedRevision: 1, nextStep: "An old goal" }), /Read learn_status/);
	assert.equal(read(f.note), before); assert.equal(read(f.goal), goal);
	await f.emit("session_tree");
	assert.equal(readState(read(f.note)).nextStep, "A newer goal", "tree navigation must not replay older progress");
});

test("returning to an older branch appends a chronological continuation without rewinding progress", async (t) => {
	const f = await fixture(t); await call(f, "init", update({ sections: [{ topic: "samples" }] }));
	const branchA = [...f.branch];
	await call(f, "topic-b", { expectedRevision: 1, topics: [{ id: "samples", title: "Samples", status: "completed", evidence: "Explained and applied the definitions repeatedly." }, { id: "coefficients", title: "Coefficients", status: "current" }], sections: [{ topic: "coefficients" }] });
	f.branch.splice(0, f.branch.length, ...branchA, entry("branch-question", "user", "Another question about samples"));
	await f.emit("session_tree");
	const sections = readSections(read(f.note));
	assert.deepEqual(sections.map((s) => s.topic), ["samples", "coefficients", "samples"]);
	assert.equal(sections[0].context, sections[2].context);
	assert.equal(readState(read(f.note)).revision, 2);
	assert.equal(readState(read(f.note)).topics[1].status, "current");
	const once = read(f.note); await f.emit("turn_end"); assert.equal(read(f.note), once);
	const foreign = branchBlocks(f.branch, "another-note.md");
	assert.equal(foreign.some((b) => b.section), false);
});

test("backfilled historical sections also supply context when an old branch has no topic annotations", async (t) => {
	const f = await fixture(t), originalBranch = [...f.branch];
	await call(f, "backfill", update({ sections: [{ topic: "samples", before: logMarker("lesson-test", "message:first") }, { topic: "coefficients", before: logMarker("lesson-test", "message:second") }] }));
	f.branch.splice(0, f.branch.length, ...originalBranch.filter((e) => e.type === "custom" || e.id === "first"), entry("old-branch", "user", "Return to the earlier topic"));
	await f.emit("session_tree");
	const sections = readSections(read(f.note));
	assert.deepEqual(sections.map((s) => s.topic), ["samples", "coefficients", "samples"]);
	assert.equal(sections[2].context, sections[0].context);
	assert.equal(readState(read(f.note)).revision, 1);
});

test("queued live logging and checkpoints preserve messages and only one concurrent revision wins", async (t) => {
	const f = await fixture(t); await call(f, "init", update());
	f.branch.push(entry("concurrent", "assistant", "Do not lose this message."));
	const results = await Promise.allSettled([f.emit("agent_end"), call(f, "one", { expectedRevision: 1, nextStep: "First update" }), call(f, "two", { expectedRevision: 1, nextStep: "Second update" })]);
	assert.equal(results.filter((r) => r.status === "rejected").length, 1);
	assert.equal(readState(read(f.note)).revision, 2);
	assert.equal(read(f.note).split("Do not lose this message.").length - 1, 1);
	assert.match(read(f.goal), /Revision: 2/);
	assert.equal(existsSync(f.note + ".learn-lock"), false);
});

test("Plan mode, unlinking, aborted calls, and missing notes cannot mutate navigation or create companions", async (t) => {
	const f = await fixture(t), original = read(f.note);
	f.branch.push({ type: "custom", customType: "modes-state", data: { version: 1, mode: "plan" } });
	await assert.rejects(call(f, "plan", update()), /Plan mode/);
	await f.emit("agent_end"); assert.equal(read(f.note), original); assert.equal(existsSync(f.goal), false);
	f.branch.push({ type: "custom", customType: "modes-state", data: { version: 1, mode: "build" } });
	const controller = new AbortController(); controller.abort();
	await assert.rejects(f.tool("learn_checkpoint").execute("abort", update(), controller.signal, undefined, f.ctx), /cancelled/);
	await f.command("learn-unlog", "");
	await assert.rejects(call(f, "unlinked", update()), /Link a writable/);
	assert.equal(existsSync(f.goal), false);
	await f.command("learn-log", f.note);
	unlinkSync(f.note);
	await assert.rejects(call(f, "missing", update()), /Link a writable/);
	assert.equal(existsSync(f.note), false); assert.equal(existsSync(f.goal), false);
});

test("unrecognized or deleted companions are not overwritten or silently recreated", async (t) => {
	const f = await fixture(t), original = read(f.note);
	writeFileSync(f.goal, "My unrelated note");
	await assert.rejects(call(f, "occupied", update()), /unrecognized/);
	assert.equal(read(f.note), original); assert.equal(read(f.goal), "My unrelated note");
	unlinkSync(f.goal); await call(f, "init", update()); unlinkSync(f.goal);
	const before = read(f.note);
	await assert.rejects(call(f, "deleted", { expectedRevision: 1, initialize: true, nextStep: "Do not recreate" }), /missing/);
	assert.equal(read(f.note), before); assert.equal(existsSync(f.goal), false);
	assert.match((await status(f)).progressWarning, /missing/);
	await assert.rejects(call(f, "bad-rebuild", { expectedRevision: 1, rebuildProgressNote: true, nextStep: "Not a projection" }), /no roadmap changes/);
	await call(f, "consented-rebuild", { expectedRevision: 1, rebuildProgressNote: true });
	assert.equal(readState(read(f.note)).revision, 1);
	assert.equal(existsSync(f.goal), true);
	assert.match(read(f.goal), /Revision: 1/);
});

test("replaced note/companion symlinks and protected paths are refused without changing their targets", async (t) => {
	const f = await fixture(t), original = read(f.note);
	const victim = join(f.ctx.cwd, "victim.md"); writeFileSync(victim, "Keep victim");
	symlinkSync(victim, f.goal);
	await assert.rejects(call(f, "goal-symlink", update()), /symlink/);
	assert.equal(read(victim), "Keep victim"); assert.equal(read(f.note), original);
	unlinkSync(f.goal);
	symlinkSync(join(root, "README.md"), f.goal);
	await assert.rejects(call(f, "config-symlink", update()), /synced Pi config/);
	unlinkSync(f.goal);
	unlinkSync(f.note); symlinkSync(victim, f.note);
	await f.emit("agent_end");
	await assert.rejects(call(f, "note-symlink", update()), /Link a writable/);
	assert.equal(read(victim), "Keep victim");
	const opts = { cwd: f.ctx.cwd, agentDir: join(f.ctx.cwd, "agent") };
	assert.throws(() => checkpointNotebook(join(f.ctx.cwd, ".pi/plans/x.md"), update(), "protected", opts), /extension-owned/);
});

test("read-only files are refused before either view is replaced and stale projections are detectable", async (t) => {
	const f = await fixture(t), opts = { cwd: f.ctx.cwd, agentDir: join(f.ctx.cwd, "agent") };
	await call(f, "init", update());
	const original = read(f.note), goal = read(f.goal);
	chmodSync(f.goal, 0o444);
	try { await assert.rejects(call(f, "readonly-goal", { expectedRevision: 1, nextStep: "No write" }), /EACCES|EPERM/); }
	finally { chmodSync(f.goal, 0o600); }
	assert.equal(read(f.note), original); assert.equal(read(f.goal), goal);
	chmodSync(f.note, 0o444);
	try {
		assert.throws(() => appendNotebook(f.note, [{ id: "e".repeat(24), text: "No append" }], opts), /EACCES|EPERM/);
		await assert.rejects(call(f, "readonly-source", { expectedRevision: 1, nextStep: "No write" }), /EACCES|EPERM/);
	} finally { chmodSync(f.note, 0o600); }
	assert.equal(read(f.note), original);
	writeFileSync(f.goal, goal.replace("pi-learn-goal-revision:1", "pi-learn-goal-revision:0"));
	assert.match((await status(f)).progressWarning, /out of date/);
	await call(f, "repair-view", { expectedRevision: 1, rebuildProgressNote: true });
	assert.equal((await status(f)).progressWarning, undefined);
});

test("cross-process locks refuse competing mutation without consuming progress revisions", async (t) => {
	const f = await fixture(t), original = read(f.note), lock = f.note + ".learn-lock";
	writeFileSync(lock, "another process owns this");
	assert.throws(() => checkpointNotebook(f.note, update(), "locked", { cwd: f.ctx.cwd, agentDir: join(f.ctx.cwd, "agent") }), /locked/);
	assert.equal(read(f.note), original); assert.equal(existsSync(f.goal), false);
	unlinkSync(lock);
	await call(f, "init", update());
	assert.equal(readState(read(f.note)).revision, 1);
});

test("large progress snapshots keep learn_status output bounded and point to the complete source", async (t) => {
	const f = await fixture(t);
	await call(f, "large-roadmap", update({ topics: Array.from({ length: 24 }, (_, i) => ({ id: `topic-${i}`, title: `Topic ${i}`, status: "upcoming", evidence: "e".repeat(1400) })) }));
	const result = await f.tool("learn_status").execute("bounded", {}, undefined, undefined, f.ctx);
	assert.equal(result.details.progressSummaryOnly, true);
	assert.equal(result.details.progress.topicCount, 24);
	assert.equal(result.details.progressStateSource, f.note);
	assert.ok(result.content[0].text.length < 24_000);
	assert.equal(readState(read(f.note)).topics[0].evidence.length, 1400, "bounding output must not truncate stored evidence");
});

test("standalone section session annotations are versioned and malformed ones are ignored", () => {
	const section = createSection("c".repeat(24), 1, { topic: "samples" }, state());
	const make = (version, s = section) => ({ type: "custom", customType: SECTION_ENTRY, data: { version, file: "note.md", section: s } });
	assert.equal(branchBlocks([make(1)], "note.md")[0].section.id, section.id);
	assert.equal(branchBlocks([make(2)], "note.md").length, 0);
	assert.equal(branchBlocks([make(1, { heading: "bad" })], "note.md").length, 0);
});

test("the actual generated Mermaid roadmap renders with punctuation safely escaped", { skip: process.env.PI_LEARN_RENDER_SMOKE !== "1" }, async (t) => {
	const f = await load("visual-tools/mermaid.ts"); t.after(f.close);
	const s = advanceState(undefined, update({ topics: [{ id: "a", title: 'Cosine [patterns] and "coefficients"', status: "completed", evidence: "Repeated applications" }, { id: "b", title: "Sums < products & phase", status: "current", dependsOn: ["a"] }, { id: "c", title: "FFT", status: "upcoming", dependsOn: ["b"] }] }));
	await f.tool("learn_write_mermaid").execute("write", { source: renderMermaid(s) }, undefined, undefined, f.ctx);
	const result = await f.tool("learn_render_mermaid").execute("render", {}, undefined, undefined, f.ctx);
	assert.equal(Buffer.from(result.content[1].data, "base64").subarray(1, 4).toString(), "PNG");
});
