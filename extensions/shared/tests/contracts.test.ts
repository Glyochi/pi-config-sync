import test from "node:test";
import assert from "node:assert/strict";
import {
	ASK_USER_BLOCKED_EVENT,
	COMPOSER_STATUS_EVENT,
	isAskUserBlockedEventPayload,
	isComposerStatusSnapshot,
	isModeStateSnapshot,
	isPermissionsStateSnapshot,
	isTimingEntryData,
	MODE_STATE_EVENT,
	PERMISSIONS_STATE_EVENT,
} from "../contracts.ts";

const modeSnapshot = {
	schemaVersion: 1,
	kind: "snapshot",
	sessionId: "session-1",
	cwd: "/repo",
	mode: "build",
	permissionProfile: "build",
	activePlan: {
		id: "plan-123",
		title: "Improve chat UI",
		status: "open",
		path: ".pi/plans/plan-123.md",
		ownerSessionId: "session-1",
		ownedByCurrentSession: true,
		goalSummary: "Show status from typed events.",
		steps: [{ id: "step-1", order: 1, title: "Publish state", status: "planned" }],
	},
	artifacts: [],
	updatedAt: 100,
};

const permissionsSnapshot = {
	schemaVersion: 1,
	kind: "changed",
	sessionId: "session-1",
	enabled: true,
	jev: false,
	yolo: false,
	threshold: 0.3,
	model: "jev-1.13",
	calls: 4,
	updatedAt: 101,
};

test("public state channels are versioned", () => {
	assert.equal(ASK_USER_BLOCKED_EVENT, "rpiv:ask-user:blocked");
	assert.equal(MODE_STATE_EVENT, "modes:state.v1");
	assert.equal(PERMISSIONS_STATE_EVENT, "permissions:state.v1");
	assert.equal(COMPOSER_STATUS_EVENT, "chatbox-status:composer.v1");
});

test("mode snapshots validate known fields and reject incompatible payloads", () => {
	assert.equal(isModeStateSnapshot(modeSnapshot), true);
	assert.equal(isModeStateSnapshot({ ...modeSnapshot, schemaVersion: 2 }), false);
	assert.equal(isModeStateSnapshot({ ...modeSnapshot, permissionProfile: "plan" }), false);
	assert.equal(isModeStateSnapshot({ ...modeSnapshot, activePlan: { ...modeSnapshot.activePlan, steps: "bad" } }), false);
});

test("permission snapshots validate switches, threshold, and counters", () => {
	assert.equal(isPermissionsStateSnapshot(permissionsSnapshot), true);
	assert.equal(isPermissionsStateSnapshot({ ...permissionsSnapshot, threshold: 1.1 }), false);
	assert.equal(isPermissionsStateSnapshot({ ...permissionsSnapshot, calls: -1 }), false);
	assert.equal(isPermissionsStateSnapshot({ ...permissionsSnapshot, yolo: "off" }), false);
});

test("composer snapshots validate session-scoped display data", () => {
	const snapshot = {
		schemaVersion: 1,
		kind: "changed",
		sessionId: "session-1",
		cwd: "/repo",
		planSummary: "Improve composer status — keep the prompt clean",
		permissions: { enabled: true, jev: false, yolo: true, threshold: 0.3 },
		updatedAt: 102,
	};
	assert.equal(isComposerStatusSnapshot(snapshot), true);
	assert.equal(isComposerStatusSnapshot({ ...snapshot, planSummary: "x".repeat(421) }), false);
	assert.equal(isComposerStatusSnapshot({ ...snapshot, planSummary: "\u001b[31munsafe\u001b[0m" }), false);
	assert.equal(isComposerStatusSnapshot({ ...snapshot, planSummary: "😀".repeat(420) }), true);
	assert.equal(isComposerStatusSnapshot({ ...snapshot, permissions: { ...snapshot.permissions, threshold: 2 } }), false);
	assert.equal(isComposerStatusSnapshot({ ...snapshot, sessionId: "" }), false);
});

test("timing entry data accepts legacy entries and validates optional generation metadata", () => {
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: 123.4, outcome: "completed" }), true);
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: 123.4, outcome: "completed", mode: "ask" }), true);
	assert.equal(isTimingEntryData({
		schemaVersion: 1,
		durationMs: 123.4,
		outcome: "completed",
		model: "anthropic/claude-sonnet-4",
		thinkingLevel: "high",
	}), true);
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: 123.4, outcome: "completed", model: " " }), false);
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: 123.4, outcome: "completed", thinkingLevel: 3 }), false);
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: 123.4, outcome: "completed", mode: "other" }), false);
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: -1, outcome: "completed" }), false);
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: Number.NaN, outcome: "error" }), false);
	assert.equal(isTimingEntryData({ schemaVersion: 1, durationMs: 10, outcome: "unknown" }), false);
});

test("ask-user blocked events validate their active flag", () => {
	assert.equal(isAskUserBlockedEventPayload({ active: true }), true);
	assert.equal(isAskUserBlockedEventPayload({ active: false }), true);
	assert.equal(isAskUserBlockedEventPayload({ active: "true" }), false);
	assert.equal(isAskUserBlockedEventPayload(null), false);
});
