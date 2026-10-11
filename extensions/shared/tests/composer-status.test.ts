import test from "node:test";
import assert from "node:assert/strict";
import type { ModeStateSnapshot, PermissionsStateSnapshot } from "../contracts.ts";
import {
	compactPermissionsLabel,
	layoutBorderText,
	makeComposerStatusSnapshot,
	modeColorToken,
	planSummaryForComposer,
} from "../composer-status.ts";

const mode = (overrides: Partial<ModeStateSnapshot> = {}): ModeStateSnapshot => ({
	schemaVersion: 1,
	kind: "snapshot",
	sessionId: "session-1",
	cwd: "/repo",
	mode: "build",
	permissionProfile: "build",
	activePlan: {
		id: "plan-1",
		title: "Composer status",
		status: "open",
		path: ".pi/plans/plan-1.md",
		ownerSessionId: "session-1",
		ownedByCurrentSession: true,
		goalSummary: "Keep status out of prompt context",
		steps: [],
	},
	artifacts: [],
	updatedAt: 10,
	...overrides,
});

const permissions: PermissionsStateSnapshot = {
	schemaVersion: 1,
	kind: "snapshot",
	sessionId: "session-1",
	enabled: true,
	jev: false,
	yolo: true,
	threshold: 0.3,
	model: "classifier-model-not-shown",
	calls: 4,
	updatedAt: 11,
};

const truncate = (text: string, width: number, ellipsis: string) =>
	text.length <= width ? text : width <= ellipsis.length ? ellipsis.slice(0, width) : `${text.slice(0, width - ellipsis.length)}${ellipsis}`;

test("mode color tokens match the composer mode label", () => {
	assert.equal(modeColorToken("plan"), "warning");
	assert.equal(modeColorToken("build"), "thinkingLow");
	assert.equal(modeColorToken("ask"), "accent");
});

test("composer plan summary requires an open plan owned in Plan or Build", () => {
	assert.equal(planSummaryForComposer(mode()), "Composer status — Keep status out of prompt context");
	assert.equal(planSummaryForComposer(mode({ mode: "ask", permissionProfile: "build" })), undefined);
	assert.equal(planSummaryForComposer(mode({ activePlan: { ...mode().activePlan!, status: "completed" } })), undefined);
	assert.equal(planSummaryForComposer(mode({ activePlan: { ...mode().activePlan!, ownedByCurrentSession: false } })), undefined);
});

test("composer summary is plain text and bounded", () => {
	const long = "g".repeat(500);
	const result = planSummaryForComposer(mode({ activePlan: { ...mode().activePlan!, goalSummary: `\u001b[31m${long}\u001b[0m` } }));
	assert.equal(result?.includes("\u001b"), false);
	assert.equal(Array.from(result ?? "").length, 420);
});

test("compact permissions omit classifier model and count, and preserve disabled state", () => {
	const view = makeComposerStatusSnapshot({
		sessionId: "session-1",
		cwd: "/repo",
		mode: mode(),
		permissions,
		kind: "snapshot",
		updatedAt: 12,
	});
	assert.deepEqual(view.permissions, { enabled: true, jev: false, yolo: true, threshold: 0.3 });
	assert.equal(compactPermissionsLabel(view.permissions), "jev off · yolo on · thr 0.30");
	assert.equal(compactPermissionsLabel({ enabled: false, jev: true, yolo: true, threshold: 0.3 }), "permissions off");
	assert.equal(compactPermissionsLabel(undefined), "permissions unavailable");
});

test("border labels center, left-align, truncate, and reserve scroll indicators", () => {
	const centered = layoutBorderText("abc", 12, "center", (text) => text.length, truncate);
	assert.equal(`${centered.leftBorder}${centered.label}${centered.rightBorder}`, "─── abc ────");
	const left = layoutBorderText("plan · permissions off", 12, "left", (text) => text.length, truncate);
	assert.equal(`${left.leftBorder}${left.label}${left.rightBorder}`.length, 12);
	assert.ok(left.label.includes("…"));
	const scrolling = layoutBorderText("abc", 24, "center", (text) => text.length, truncate, " ↓ 2 more ");
	assert.equal(scrolling.overflowLabel, " ↓ 2 more ");
	assert.equal(`${scrolling.leftBorder}${scrolling.label}${scrolling.rightBorder}${scrolling.overflowLabel}`.length, 24);
});
