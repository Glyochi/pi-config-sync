import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchBlocks } from "../log-format.ts";
import { load, root } from "./helpers.mjs";

const entry = (id, role, content) => ({ id, type: "message", message: { role, content } });
const read = (file) => readFileSync(file, "utf8");

test("backfill appends to existing note and repeated links/resumes are idempotent", async (t) => {
	const f = await load(); t.after(f.close);
	const note = join(f.ctx.cwd, "lesson.md"); writeFileSync(note, "# My existing note\nKeep this.\n");
	f.branch.push(entry("user", "user", "Teach me a topic"), entry("assistant", "assistant", [{ type: "text", text: "A lesson with $x^2$." }]));
	await f.command("learn-log", note);
	const first = read(note);
	assert.ok(first.startsWith("# My existing note\nKeep this.\n"));
	assert.match(first, /A lesson with \$x\^2\$/);
	await f.command("learn-log", note);
	await f.emit("session_start");
	await f.emit("turn_end");
	assert.equal(read(note), first);
	assert.equal(f.notices.some(([message]) => message.startsWith("Error")), false);
});

test("live quiz questions use display order and do not leak answers; results deduplicate", async (t) => {
	const f = await load(); t.after(f.close);
	const note = join(f.ctx.cwd, "lesson.md"); writeFileSync(note, "# Lesson");
	await f.command("learn-log", note);
	f.branch.push(entry("assistant", "assistant", [{ type: "toolCall", id: "q1", name: "learn_quiz", arguments: { question: "Question?", correctAnswer: "author-two", explanation: "Secret explanation", options: [{ label: "Author one" }, { label: "Author two" }] } }]));
	await f.emit("tool_execution_start");
	assert.ok(!read(note).includes("Author one"));
	const display = { status: "pending", question: "Question?", options: [{ index: 1, label: "Author two" }, { index: 2, label: "Author one" }] };
	await f.emit("tool_execution_update", { toolName: "learn_quiz", toolCallId: "q1", partialResult: { details: display } });
	assert.match(read(note), /1\. Author two\n> 2\. Author one/);
	assert.ok(!read(note).includes("Secret explanation"));
	const result = { content: [], details: { ...display, status: "answered", answers: [{ index: 1, label: "Author two" }], correctIndices: [1], correct: true, explanation: "Secret explanation" } };
	await f.emit("tool_execution_end", { toolName: "learn_quiz", toolCallId: "q1", result, isError: false });
	assert.match(read(note), /Secret explanation/);
	f.branch.push({ id: "answer", type: "message", message: { ...result, role: "toolResult", toolName: "learn_quiz", toolCallId: "q1" } });
	const after = read(note);
	await f.emit("agent_end");
	assert.equal(read(note), after);
});

test("rpiv question arrays, multi-select answers, custom answers, and notes are recorded", () => {
	const entries = [entry("a", "assistant", [{ type: "toolCall", id: "ask1", name: "ask_user_question", arguments: { questions: [{ header: "Goal", question: "What next?", options: [{ label: "Theory", description: "Foundations" }, { label: "Practice", description: "Exercises" }] }] } }]),
		{ type: "message", message: { role: "toolResult", toolName: "ask_user_question", toolCallId: "ask1", details: { cancelled: false, answers: [{ question: "What next?", kind: "multi", selected: ["Theory", "Practice"], notes: "Both please" }, { question: "Topic?", kind: "custom", answer: "Networks" }], globalNote: "Briefly" } } }];
	const log = branchBlocks(entries).map((b) => b.text).join("\n");
	assert.match(log, /What next\?/); assert.match(log, /Theory, Practice/);
	assert.match(log, /Both please/); assert.match(log, /Networks/); assert.match(log, /Briefly/);
	assert.ok(!log.includes("undefined"));
});

test("logging stops on unlink, session replacement, and Plan mode", async (t) => {
	const f = await load(); t.after(f.close);
	const note = join(f.ctx.cwd, "lesson.md"); writeFileSync(note, "# Note");
	await f.command("learn-log", note);
	const before = read(note);
	f.branch.push({ type: "custom", customType: "modes-state", data: { version: 1, mode: "plan" } });
	f.branch.push(entry("p", "user", "Do not write this in Plan"));
	await f.emit("agent_end"); assert.equal(read(note), before);
	await f.command("learn-unlog", "");
	f.branch.push({ type: "custom", customType: "modes-state", data: { version: 1, mode: "build" } });
	await f.emit("agent_end"); assert.equal(read(note), before);
	f.branch.length = 0;
	f.branch.push(entry("fresh", "user", "A different session"));
	await f.emit("session_start"); assert.equal(read(note), before);
});

test("deleted notes are not recreated; relinking recovers without overwriting", async (t) => {
	const f = await load(); t.after(f.close);
	const note = join(f.ctx.cwd, "lesson.md"); writeFileSync(note, "# Original");
	await f.command("learn-log", note); unlinkSync(note);
	f.branch.push(entry("new", "user", "New text"));
	await f.emit("agent_end"); assert.equal(existsSync(note), false);
	writeFileSync(note, "# Recreated\n"); await f.command("learn-log", note);
	assert.ok(read(note).startsWith("# Recreated\n")); assert.match(read(note), /New text/);
});

test("rejects config notes, symlink escapes, plan Markdown, non-md and missing files", async (t) => {
	const f = await load(); t.after(f.close);
	const link = join(f.ctx.cwd, "config.md"); symlinkSync(join(root, "README.md"), link);
	for (const target of [link, join(f.ctx.cwd, ".pi/plans/plan.md"), join(f.ctx.cwd, "missing.md"), join(f.ctx.cwd, "data.json")]) {
		const customCount = f.branch.length;
		await f.command("learn-log", target);
		assert.equal(f.branch.length, customCount);
		assert.equal(f.notices.at(-1)[1], "error");
	}
});
