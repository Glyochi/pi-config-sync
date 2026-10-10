import {
	MODE_STATE_ENTRY_TYPE,
	MODE_STATE_EVENT,
	MODE_STATE_VERSION,
	isMode,
	type ArtifactReference,
	type Mode,
	type ModeStateSnapshot,
	type PermissionProfile,
	type PersistedModeState,
	type PlanStateView,
	type PlanStatus,
	type PlanWorkItem,
} from "../shared/contracts.ts";

export { MODE_STATE_ENTRY_TYPE, MODE_STATE_EVENT, MODE_STATE_VERSION } from "../shared/contracts.ts";
export { isMode } from "../shared/contracts.ts";
export type {
	ArtifactReference,
	Mode,
	ModeStateSnapshot,
	PermissionProfile,
	PersistedModeState,
	PlanStateView,
	PlanStatus,
	PlanWorkItem,
} from "../shared/contracts.ts";

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

/** Extract the plan heading, Goal summary, and ordered steps without treating fenced examples as instructions. */
function stableStepId(normalized: string, occurrence: number): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalized.length; index += 1) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `step-${hash.toString(16).padStart(8, "0")}${occurrence > 1 ? `-${occurrence}` : ""}`;
}

function cleanGoalSummary(lines: readonly string[]): string | undefined {
	const normalized = lines
		.map((line) => line.trim().replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+\.)\s+/, ""))
		.filter(Boolean)
		.join(" ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return undefined;
	if (normalized.length <= 240) return normalized;
	return `${normalized.slice(0, 239).trimEnd()}…`;
}

export function summarizePlanMarkdown(markdown: string): { title?: string; goalSummary?: string; steps: PlanWorkItem[] } {
	const lines = markdown.split(/\r?\n/);
	let inFence = false;
	let title: string | undefined;
	let inGoal = false;
	let inSteps = false;
	const goalLines: string[] = [];
	const stepTitles: string[] = [];
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
		if (!title && heading) title = heading[1]!.trim();
		if (/^\s*##\s+/.test(line)) {
			inGoal = /^\s*##\s+Goal\s*#*\s*$/i.test(line);
			inSteps = /^\s*##\s+Implementation Steps\s*#*\s*$/i.test(line);
			continue;
		}
		if (inGoal) goalLines.push(line);
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
	const goalSummary = cleanGoalSummary(goalLines);
	return { ...(title ? { title } : {}), ...(goalSummary ? { goalSummary } : {}), steps };
}

export function cleanPlanTitle(value: string): string {
	return value
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}
