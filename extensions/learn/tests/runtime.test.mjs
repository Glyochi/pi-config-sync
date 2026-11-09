import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { hostRequire, load } from "./helpers.mjs";

const { Agent } = await import(join(dirname(hostRequire.resolve("@earendil-works/pi-agent-core/package.json")), "dist/index.js"));
const model = { provider: "test", api: "openai-completions", id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 };

test("native Pi tool execution serializes mixed question and quiz batches", async (t) => {
	const f = await load(); t.after(f.close);
	let active = 0, maximum = 0, turn = 0;
	const order = [];
	const wait = async (name) => {
		maximum = Math.max(maximum, ++active); order.push(`${name}:start`);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--; order.push(`${name}:end`);
	};
	f.ctx.ui.custom = async () => { await wait("quiz"); return { dontKnow: false, answers: [{ index: 1, label: "A", value: "a" }] }; };
	const quiz = f.tool("learn_quiz");
	const quizArgs = { question: "A or B?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "a", explanation: "A is the supplied answer.", shuffle: false };
	const calls = [{ type: "toolCall", id: "ask", name: "ask_user_question", arguments: {} }, { type: "toolCall", id: "quiz", name: "learn_quiz", arguments: quizArgs }];
	const agent = new Agent({
		initialState: { model, tools: [
			{ name: "ask_user_question", label: "Ask", description: "Test question", parameters: { type: "object", properties: {} }, execute: async () => { await wait("ask"); return { content: [{ type: "text", text: "Answered" }], details: {} }; } },
			{ ...quiz, execute: (id, args, signal, update) => quiz.execute(id, args, signal, update, f.ctx) },
		] },
		streamFn: () => {
			const first = turn++ === 0;
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: first ? "toolUse" : "stop", content: first ? calls : [{ type: "text", text: "Done" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
		},
	});
	await agent.prompt("Run the simulated UI batch");
	assert.equal(maximum, 1);
	assert.deepEqual(order, ["ask:start", "ask:end", "quiz:start", "quiz:end"]);
});

test("the quiz collapse key hides/reopens only its own focused overlay", async (t) => {
	const f = await load(); t.after(f.close);
	let rawInput, hidden = false, focused = true, removed = false;
	f.ctx.ui.onTerminalInput = (handler) => { rawInput = handler; return () => { removed = true; }; };
	f.ctx.ui.custom = async (_factory, options) => {
		options.onHandle({ isHidden: () => hidden, isFocused: () => focused, setHidden: (value) => { hidden = value; } });
		assert.deepEqual(rawInput("\x1d"), { consume: true }); assert.equal(hidden, true);
		assert.deepEqual(rawInput("\x1d"), { consume: true }); assert.equal(hidden, false);
		focused = false; assert.equal(rawInput("\x1d"), undefined); assert.equal(hidden, false);
		return null;
	};
	const result = await f.tool("learn_quiz").execute("collapse", { question: "Q?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "a", explanation: "A", shuffle: false }, undefined, undefined, f.ctx);
	assert.equal(result.details.status, "cancelled"); assert.equal(removed, true);
});
