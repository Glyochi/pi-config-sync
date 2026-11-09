import assert from "node:assert/strict";
import test from "node:test";
import { load, tuiModule } from "./helpers.mjs";

const theme = { fg: (_color, value) => value, bg: (_color, value) => value, bold: (value) => value };
const params = {
	question: "Which number is even?", shuffle: false,
	options: [{ label: "One", value: "one" }, { label: "Two", value: "two" }],
	correctAnswer: "two", explanation: "Two is divisible by two.",
};
const down = "\x1b[B";

async function quizFixture(t, keys, overrides = {}) {
	const fixture = await load();
	t.after(fixture.close);
	const updates = [];
	let removed = 0;
	fixture.ctx.ui.onTerminalInput = () => () => { removed++; };
	fixture.ctx.ui.custom = (factory, options) => new Promise((resolve) => {
		assert.equal(options.overlay, true);
		const tui = { terminal: { rows: 30 }, requestRender() {} };
		const component = factory(tui, theme, {}, resolve);
		for (const width of [100, 40, 12]) {
			component.invalidate();
			const lines = component.render(width);
			assert.ok(lines.length <= 24);
			assert.ok(lines.every((line) => tuiModule.visibleWidth(line) <= width));
		}
		const before = component.render(100).join("\n");
		assert.ok(!before.includes(params.explanation));
		for (const key of typeof keys === "function" ? keys(updates.at(-1).details.options) : keys) component.handleInput(key);
	});
	const quiz = fixture.tool("learn_quiz");
	const result = await quiz.execute("quiz-test", { ...params, ...overrides }, new AbortController().signal, (update) => updates.push(update), fixture.ctx);
	assert.equal(quiz.executionMode, "sequential");
	assert.equal(quiz.exposure, "model-only");
	assert.ok(quiz.promptGuidelines[0].includes("explicitly asks"));
	assert.equal(removed, 1);
	for (const update of updates) {
		assert.equal(update.details.correctIndices, undefined);
		assert.equal(update.details.explanation, undefined);
		assert.doesNotThrow(() => quiz.renderResult(update, {}, theme).render(60));
	}
	return result;
}

test("single-select grades correctly and hides the answer before submission", async (t) => {
	const result = await quizFixture(t, [down, "\r", "\r"]);
	assert.equal(result.details.correct, true);
	assert.deepEqual(result.details.correctIndices, [2]);
});

test("wrong answers and I don't know remain distinct", async (t) => {
	const wrong = await quizFixture(t, ["\r", "\r"]);
	assert.equal(wrong.details.correct, false);
	assert.equal(wrong.details.dontKnow, false);
	const unknown = await quizFixture(t, [down, down, "\r", "\r"]);
	assert.equal(unknown.details.dontKnow, true);
	assert.deepEqual(unknown.details.answers, []);
});

test("cancel never reveals the answer", async (t) => {
	const result = await quizFixture(t, ["\x1b"]);
	assert.equal(result.details.status, "cancelled");
	assert.deepEqual(result.details.correctIndices, []);
	assert.equal(result.details.explanation, undefined);
});

test("shuffled options grade by value, not author position", async (t) => {
	const result = await quizFixture(t, (options) => [...Array(options.findIndex((o) => o.label === "Two")).fill(down), "\r", "\r"], { shuffle: true });
	assert.equal(result.details.correct, true);
	assert.equal(result.details.options[result.details.correctIndices[0] - 1].label, "Two");
});

test("multi-select uses exact-set grading and preserves notes", async (t) => {
	const result = await quizFixture(t, ["\t", "my reasoning", "\r", " ", down, " ", down, down, "\r", "\r"], { multiSelect: true, correctAnswer: ["one", "two"] });
	assert.equal(result.details.correct, true);
	assert.equal(result.details.note, "my reasoning");
	const partial = await quizFixture(t, [" ", down, down, down, "\r", "\r"], { multiSelect: true, correctAnswer: ["one", "two"] });
	assert.equal(partial.details.correct, false);
});

test("invalid answers, duplicate values, empty explanations, and non-TUI hosts fail safely", async (t) => {
	const fixture = await load(); t.after(fixture.close);
	const quiz = fixture.tool("learn_quiz");
	fixture.ctx.ui.custom = () => { throw new Error("must not open UI"); };
	for (const override of [{ correctAnswer: "missing" }, { correctAnswer: ["one", "two"] }, { explanation: " " }, { options: [{ label: "One", value: "a" }, { label: "Two", value: "a" }] }]) {
		const result = await quiz.execute("invalid", { ...params, ...override }, undefined, undefined, fixture.ctx);
		assert.equal(result.details.status, "unavailable");
		assert.deepEqual(result.details.correctIndices, []);
	}
	fixture.ctx.mode = "rpc";
	const result = await quiz.execute("rpc", params, undefined, undefined, fixture.ctx);
	assert.equal(result.details.status, "unavailable");
});

test("abort closes an open quiz and removes input handlers", async (t) => {
	const fixture = await load(); t.after(fixture.close);
	const controller = new AbortController();
	let removed = false;
	fixture.ctx.ui.onTerminalInput = () => () => { removed = true; };
	fixture.ctx.ui.custom = (factory) => new Promise((resolve) => {
		factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, resolve);
		controller.abort();
	});
	const result = await fixture.tool("learn_quiz").execute("abort", params, controller.signal, undefined, fixture.ctx);
	assert.equal(result.details.status, "cancelled");
	assert.equal(removed, true);
});
