import test from "node:test";
import assert from "node:assert/strict";
import {
	currentModelTimeMs,
	emptyModelTimeState,
	formatDuration,
	finishModelGeneration,
	settleAgentRun,
	startAgentRun,
	startModelGeneration,
} from "../state.ts";

test("model time accumulates generations and excludes gaps for tools or prompts", () => {
	let state = startAgentRun(emptyModelTimeState());
	state = startModelGeneration(state, 10);
	assert.equal(currentModelTimeMs(state, 110), 100);
	state = finishModelGeneration(state, 110);
	assert.equal(currentModelTimeMs(state, 1_000), 100);
	state = startModelGeneration(state, 1_000);
	state = finishModelGeneration(state, 1_250);
	state = settleAgentRun(state, "completed", 5_000);
	assert.deepEqual(state.last, { durationMs: 350, outcome: "completed" });
	assert.equal(state.current, undefined);
});

test("interrupted runs retain their measured duration and outcome", () => {
	let state = startAgentRun(emptyModelTimeState());
	state = startModelGeneration(state, 50);
	state = settleAgentRun(state, "aborted", 450);
	assert.deepEqual(state.last, { durationMs: 400, outcome: "aborted" });
});

test("settled runs keep only the final assistant generation's model and thinking level", () => {
	let state = startAgentRun(emptyModelTimeState());
	state = startModelGeneration(state, 0, { model: "model-a", thinkingLevel: "high" });
	state = finishModelGeneration(state, 2_000);
	state = startModelGeneration(state, 10_000, { model: "model-b", thinkingLevel: "low" });
	state = settleAgentRun(state, "completed", 15_000);
	assert.deepEqual(state.last, {
		durationMs: 7_000,
		outcome: "completed",
		model: "model-b",
		thinkingLevel: "low",
	});
});

test("metadata available on the final assistant message is retained when it was missing at generation start", () => {
	let state = startAgentRun(emptyModelTimeState());
	state = startModelGeneration(state, 0, { model: "model-a" });
	state = finishModelGeneration(state, 2_000, { model: "model-a", thinkingLevel: "high" });
	state = settleAgentRun(state, "completed", 5_000);
	assert.deepEqual(state.last, {
		durationMs: 2_000,
		outcome: "completed",
		model: "model-a",
		thinkingLevel: "high",
	});
});

test("missing metadata on the final generation does not fall back to an earlier generation", () => {
	let state = startAgentRun(emptyModelTimeState());
	state = startModelGeneration(state, 0, { model: "model-a", thinkingLevel: "high" });
	state = finishModelGeneration(state, 1_000);
	state = startModelGeneration(state, 2_000, { model: "model-b" });
	state = settleAgentRun(state, "completed", 3_000);
	assert.deepEqual(state.last, {
		durationMs: 2_000,
		outcome: "completed",
		model: "model-b",
	});
});

test("a new run resets duration and omits metadata missing from its final generation", () => {
	let state = startAgentRun(emptyModelTimeState());
	state = startModelGeneration(state, 0, { model: "previous-model", thinkingLevel: "high" });
	state = settleAgentRun(state, "completed", 2_000);
	assert.equal(state.last?.durationMs, 2_000);

	state = startAgentRun(state);
	state = startModelGeneration(state, 10_000, { model: "final-model" });
	state = settleAgentRun(state, "completed", 15_000);
	assert.deepEqual(state.last, {
		durationMs: 5_000,
		outcome: "completed",
		model: "final-model",
	});
});

test("starting another run keeps the previous settled result until replacement settles", () => {
	let state = startAgentRun(emptyModelTimeState());
	state = settleAgentRun(state, "error", 25);
	const previous = state.last;
	state = startAgentRun(state);
	assert.deepEqual(state.last, previous);
	assert.equal(currentModelTimeMs(state, 50), 0);
});

test("model time renders compactly across milliseconds, seconds, and minutes", () => {
	assert.equal(formatDuration(89), "89 ms");
	assert.equal(formatDuration(1_234), "1.2 s");
	assert.equal(formatDuration(65_432), "1 m 5.4 s");
});
