export const MODE_STATE_ENTRY_TYPE = "learning-modes-state";
export const MODE_STATE_EVENT = "learning-modes:state.v1";
export const MODE_STATE_VERSION = 1 as const;

export type Mode = "ask" | "plan" | "build";
export type PlanStatus = "open" | "completed" | "blocked";
export type PermissionProfile = "plan" | "build";

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
	blockedReason?: string;
	steps: PlanWorkItem[];
}

export interface ArtifactReference {
	path: string;
	label: string;
	kind: string;
}

export interface ModeStateSnapshot {
	schemaVersion: typeof MODE_STATE_VERSION;
	kind: "snapshot" | "changed";
	sessionId: string;
	cwd: string;
	mode: Mode;
	permissionProfile: PermissionProfile;
	activePlan?: PlanStateView;
	artifacts: ArtifactReference[];
	updatedAt: number;
}

export function isMode(value: unknown): value is Mode {
	return value === "ask" || value === "plan" || value === "build";
}

export function permissionProfileFor(mode: Mode): PermissionProfile {
	return mode === "plan" ? "plan" : "build";
}

export function nextMode(mode: Mode): Mode {
	return mode === "build" ? "plan" : mode === "plan" ? "ask" : "build";
}

export function shouldToggleModeOnTab(autocompleteIsOpen: boolean): boolean {
	return !autocompleteIsOpen;
}

export function makeModeStateSnapshot(input: Omit<ModeStateSnapshot, "schemaVersion" | "permissionProfile">): ModeStateSnapshot {
	return { ...input, schemaVersion: MODE_STATE_VERSION, permissionProfile: permissionProfileFor(input.mode) };
}

export function decodePersistedModeState(value: unknown): PersistedModeState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as { version?: unknown; mode?: unknown; activePlanId?: unknown };
	if (candidate.version !== MODE_STATE_VERSION || !isMode(candidate.mode)) return undefined;
	if (candidate.activePlanId !== undefined && (typeof candidate.activePlanId !== "string" || !candidate.activePlanId.trim())) return undefined;
	return {
		version: MODE_STATE_VERSION,
		mode: candidate.mode,
		...(typeof candidate.activePlanId === "string" ? { activePlanId: candidate.activePlanId } : {}),
	};
}

/** Read the latest valid mode snapshot from a branch's ordered custom entries. */
export function latestModeState(entries: readonly { customType?: string; data?: unknown }[]): PersistedModeState | undefined {
	let found: PersistedModeState | undefined;
	for (const entry of entries) {
		if (entry.customType !== MODE_STATE_ENTRY_TYPE) continue;
		const decoded = decodePersistedModeState(entry.data);
		if (decoded) found = decoded;
	}
	return found;
}

/** Extract the plan heading and ordered steps without treating fenced examples as instructions. */
function stableStepId(normalized: string, occurrence: number): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalized.length; index += 1) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `step-${hash.toString(16).padStart(8, "0")}${occurrence > 1 ? `-${occurrence}` : ""}`;
}

export function summarizePlanMarkdown(markdown: string): { title?: string; steps: PlanWorkItem[] } {
	const lines = markdown.split(/\r?\n/);
	let inFence = false;
	let title: string | undefined;
	let inSteps = false;
	const stepTitles: string[] = [];
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
		if (!title && heading) title = heading[1]!.trim();
		if (/^\s*##\s+Implementation Steps\s*$/i.test(line)) {
			inSteps = true;
			continue;
		}
		if (inSteps && /^\s*##\s+/.test(line)) {
			inSteps = false;
			continue;
		}
		if (inSteps) {
			const item = /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
			if (item) stepTitles.push(item[1]!);
		}
	}
	const occurrences = new Map<string, number>();
	const steps = stepTitles.map((stepTitle, index) => {
		const normalized = stepTitle.trim().replace(/\s+/g, " ").toLocaleLowerCase();
		const occurrence = (occurrences.get(normalized) ?? 0) + 1;
		occurrences.set(normalized, occurrence);
		return { id: stableStepId(normalized, occurrence), order: index + 1, title: stepTitle.trim(), status: "planned" as const };
	});
	return { ...(title ? { title } : {}), steps };
}

export function cleanPlanTitle(value: string): string {
	return value
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}
