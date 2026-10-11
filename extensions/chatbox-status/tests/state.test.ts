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
