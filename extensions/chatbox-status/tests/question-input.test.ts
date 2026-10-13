import test from "node:test";
import assert from "node:assert/strict";
import { createAskUserEscapeHandler } from "../question-input.ts";

test("Escape is consumed only for an active ask_user_question prompt", () => {
	let blocked = false;
	const handleInput = createAskUserEscapeHandler(
		() => blocked,
		(data) => data === "escape",
	);

	assert.equal(handleInput("escape"), undefined);
	blocked = true;
	assert.deepEqual(handleInput("escape"), { consume: true });
	assert.equal(handleInput("ctrl+c"), undefined);
	blocked = false;
	assert.equal(handleInput("escape"), undefined);
});
