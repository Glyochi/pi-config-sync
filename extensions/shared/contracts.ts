/**
 * Public, JSON-safe contracts for communication between personal Pi extensions.
 *
 * `pi.events` deliberately accepts unknown payloads, so consumers should validate
 * every event with the guards below before using it. Keep producers authoritative:
 * consumers observe snapshots/changes and do not import private implementation state.
 */
export const MODE_STATE_ENTRY_TYPE = "modes-state";
export const MODE_STATE_EVENT = "modes:state.v1";
export const MODE_STATE_VERSION = 1 as const;

export const PERMISSIONS_STATE_EVENT = "permissions:state.v1";
export const PERMISSIONS_STATE_VERSION = 1 as const;

export const COMPOSER_STATUS_EVENT = "chatbox-status:composer.v1";
export const COMPOSER_STATUS_VERSION = 1 as const;
export const COMPOSER_PLAN_SUMMARY_MAX_CHARS = 420;
export const CHATBOX_TIMING_ENTRY_TYPE = "chatbox-status-timing";

export type Mode = "ask" | "plan" | "build";
export type PlanStatus = "open" | "completed" | "blocked";
export type PermissionProfile = "plan" | "build";
export type StateEventKind = "snapshot" | "changed";

export interface PersistedModeState {
	version: typeof MODE_STATE_VERSION;
	mode: Mode;
	activePlanId?: string;
}

export interface PlanWorkItem {
	/** Stable for the same normalized instruction, even if its numbered position changes. */
	id: string;
	order: number;
	title: string;
	/** Step execution is intentionally deferred; v1 reports the planned state only. */
	status: "planned";
}

export interface PlanStateView {
	id: string;
	title: string;
	status: PlanStatus;
	path: string;
	ownerSessionId: string;
	ownedByCurrentSession: boolean;
	/** Plain-text summary extracted only from the plan's `## Goal` section. */
	goalSummary?: string;
	blockedReason?: string;
	steps: PlanWorkItem[];
}

export interface ArtifactReference {
	path: string;
	label: string;
	kind: string;
}

/** Public mode/plan snapshot published on `modes:state.v1`. */
export interface ModeStateSnapshot {
	schemaVersion: typeof MODE_STATE_VERSION;
	kind: StateEventKind;
	sessionId: string;
	cwd: string;
	mode: Mode;
	permissionProfile: PermissionProfile;
	activePlan?: PlanStateView;
	artifacts: ArtifactReference[];
	updatedAt: number;
}

/** Public permission snapshot published on `permissions:state.v1`. */
export interface PermissionsStateSnapshot {
	schemaVersion: typeof PERMISSIONS_STATE_VERSION;
	kind: StateEventKind;
	sessionId: string;
	/** The overall permissions gate, separate from the Jev classifier switch. */
	enabled: boolean;
	jev: boolean;
	yolo: boolean;
	threshold: number;
	/** Jev model ID as displayed in the existing permission indicator. */
	model: string;
	/** Jev classifications made in this session (cache hits are excluded). */
	calls: number;
	updatedAt: number;
}

/** Compact display state handed from chatbox-status to the existing modes composer. */
export interface ComposerPermissionState {
	enabled: boolean;
	jev: boolean;
	yolo: boolean;
	threshold: number;
}

/** Public render-only snapshot consumed by the existing modes editor. */
export interface ComposerStatusSnapshot {
	schemaVersion: typeof COMPOSER_STATUS_VERSION;
	kind: StateEventKind;
	sessionId: string;
	cwd: string;
	planSummary?: string;
	permissions?: ComposerPermissionState;
	updatedAt: number;
}

/** Durable timing data rendered after an agent run; custom entries are not model context. */
export interface TimingEntryData {
	schemaVersion: 1;
	durationMs: number;
	outcome: "completed" | "aborted" | "error";
	/** Optional for compatibility with existing v1 entries created before mode was recorded. */
	mode?: Mode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isMode(value: unknown): value is Mode {
	return value === "ask" || value === "plan" || value === "build";
}

export function isPlanStatus(value: unknown): value is PlanStatus {
	return value === "open" || value === "completed" || value === "blocked";
}

function isPlanWorkItem(value: unknown): value is PlanWorkItem {
	if (!isRecord(value)) return false;
	return isNonEmptyString(value.id) && Number.isInteger(value.order) && (value.order as number) > 0 &&
		typeof value.title === "string" && value.status === "planned";
}

function isPlanStateView(value: unknown): value is PlanStateView {
	if (!isRecord(value)) return false;
	return isNonEmptyString(value.id) && typeof value.title === "string" && isPlanStatus(value.status) &&
		typeof value.path === "string" && isNonEmptyString(value.ownerSessionId) &&
		typeof value.ownedByCurrentSession === "boolean" &&
		(value.goalSummary === undefined || typeof value.goalSummary === "string") &&
		(value.blockedReason === undefined || typeof value.blockedReason === "string") &&
		Array.isArray(value.steps) && value.steps.every(isPlanWorkItem);
}

function isArtifactReference(value: unknown): value is ArtifactReference {
	if (!isRecord(value)) return false;
	return typeof value.path === "string" && typeof value.label === "string" && typeof value.kind === "string";
}

/** Runtime guard for the versioned event payload; unknown fields are ignored. */
export function isModeStateSnapshot(value: unknown): value is ModeStateSnapshot {
	if (!isRecord(value)) return false;
	return value.schemaVersion === MODE_STATE_VERSION && (value.kind === "snapshot" || value.kind === "changed") &&
		isNonEmptyString(value.sessionId) && typeof value.cwd === "string" && isMode(value.mode) &&
		value.permissionProfile === (value.mode === "plan" ? "plan" : "build") &&
		(value.activePlan === undefined || isPlanStateView(value.activePlan)) &&
		Array.isArray(value.artifacts) && value.artifacts.every(isArtifactReference) && Number.isFinite(value.updatedAt);
}

/** Runtime guard for the versioned event payload; unknown fields are ignored. */
export function isPermissionsStateSnapshot(value: unknown): value is PermissionsStateSnapshot {
	if (!isRecord(value)) return false;
	return value.schemaVersion === PERMISSIONS_STATE_VERSION && (value.kind === "snapshot" || value.kind === "changed") &&
		isNonEmptyString(value.sessionId) && typeof value.enabled === "boolean" && typeof value.jev === "boolean" &&
		typeof value.yolo === "boolean" && typeof value.threshold === "number" && Number.isFinite(value.threshold) &&
		value.threshold >= 0 && value.threshold <= 1 && typeof value.model === "string" &&
		Number.isInteger(value.calls) && (value.calls as number) >= 0 && Number.isFinite(value.updatedAt);
}

function isComposerPermissionState(value: unknown): value is ComposerPermissionState {
	if (!isRecord(value)) return false;
	return typeof value.enabled === "boolean" && typeof value.jev === "boolean" && typeof value.yolo === "boolean" &&
		typeof value.threshold === "number" && Number.isFinite(value.threshold) && value.threshold >= 0 && value.threshold <= 1;
}

function isComposerPlanSummary(value: unknown): value is string {
	return typeof value === "string" && Array.from(value).length <= COMPOSER_PLAN_SUMMARY_MAX_CHARS &&
		!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
}

/** Runtime guard for the versioned composer view-model event. */
export function isComposerStatusSnapshot(value: unknown): value is ComposerStatusSnapshot {
	if (!isRecord(value)) return false;
	return value.schemaVersion === COMPOSER_STATUS_VERSION && (value.kind === "snapshot" || value.kind === "changed") &&
		isNonEmptyString(value.sessionId) && typeof value.cwd === "string" &&
		(value.planSummary === undefined || isComposerPlanSummary(value.planSummary)) &&
		(value.permissions === undefined || isComposerPermissionState(value.permissions)) && Number.isFinite(value.updatedAt);
}

export function isTimingEntryData(value: unknown): value is TimingEntryData {
	if (!isRecord(value)) return false;
	return value.schemaVersion === 1 && typeof value.durationMs === "number" && Number.isFinite(value.durationMs) &&
		value.durationMs >= 0 && (value.outcome === "completed" || value.outcome === "aborted" || value.outcome === "error") &&
		(value.mode === undefined || isMode(value.mode));
}
