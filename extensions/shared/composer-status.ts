import {
	COMPOSER_PLAN_SUMMARY_MAX_CHARS,
	type ComposerPermissionState,
	type ComposerStatusSnapshot,
	type Mode,
	type ModeStateSnapshot,
	type PermissionsStateSnapshot,
	type StateEventKind,
} from "./contracts.ts";

function plainInline(value: string): string {
	return value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function boundedText(value: string, maxChars: number): string {
	return Array.from(value).slice(0, maxChars).join("");
}

/** Build the plan text only for an eligible attached plan; it is presentation data, not policy. */
export function planSummaryForComposer(snapshot: ModeStateSnapshot | undefined): string | undefined {
	if (!snapshot || (snapshot.mode !== "plan" && snapshot.mode !== "build")) return undefined;
	const plan = snapshot.activePlan;
	if (!plan || plan.status !== "open" || !plan.ownedByCurrentSession) return undefined;
	const title = plainInline(plan.title);
	const goal = plainInline(plan.goalSummary ?? "");
	const summary = [title, goal].filter(Boolean).join(" — ");
	return summary ? boundedText(summary, COMPOSER_PLAN_SUMMARY_MAX_CHARS) : undefined;
}

export function modeColorToken(mode: Mode): "warning" | "thinkingLow" | "accent" {
	return mode === "plan" ? "warning" : mode === "build" ? "thinkingLow" : "accent";
}

export function compactPermissionState(snapshot: PermissionsStateSnapshot | undefined): ComposerPermissionState | undefined {
	if (!snapshot) return undefined;
	return {
		enabled: snapshot.enabled,
		jev: snapshot.jev,
		yolo: snapshot.yolo,
		threshold: snapshot.threshold,
	};
}

export function makeComposerStatusSnapshot(input: {
	sessionId: string;
	cwd: string;
	mode: ModeStateSnapshot | undefined;
	permissions: PermissionsStateSnapshot | undefined;
	kind: StateEventKind;
	updatedAt: number;
}): ComposerStatusSnapshot {
	const planSummary = planSummaryForComposer(input.mode);
	const permissions = compactPermissionState(input.permissions);
	return {
		schemaVersion: 1,
		kind: input.kind,
		sessionId: input.sessionId,
		cwd: input.cwd,
		...(planSummary ? { planSummary } : {}),
		...(permissions ? { permissions } : {}),
		updatedAt: input.updatedAt,
	};
}

export interface BorderTextLayout {
	leftBorder: string;
	label: string;
	rightBorder: string;
	overflowLabel: string;
}

/** Fit one inline label into a border, reserving room for Pi's vertical-scroll hint. */
export function layoutBorderText(
	text: string,
	width: number,
	alignment: "left" | "center",
	measure: (value: string) => number,
	truncate: (value: string, width: number, ellipsis: string) => string,
	overflowLabel = "",
): BorderTextLayout {
	const safeWidth = Math.max(0, Math.floor(width));
	const overflow = measure(overflowLabel) < safeWidth ? overflowLabel : "";
	const overflowWidth = measure(overflow);
	const contentWidth = Math.max(0, safeWidth - overflowWidth);
	if (contentWidth === 0) return { leftBorder: "", label: "", rightBorder: "".padEnd(safeWidth, "─"), overflowLabel: "" };

	const fitted = truncate(text, Math.max(0, contentWidth - 2), "…");
	const label = fitted ? ` ${fitted} ` : "";
	const labelWidth = Math.min(contentWidth, measure(label));
	const remaining = Math.max(0, contentWidth - labelWidth);
	const leftWidth = alignment === "center" ? Math.floor(remaining / 2) : 0;
	return {
		leftBorder: "─".repeat(leftWidth),
		label,
		rightBorder: "─".repeat(remaining - leftWidth),
		overflowLabel: overflow,
	};
}

export function compactPermissionsLabel(
	state: ComposerPermissionState | undefined,
	colorize: (kind: "jev" | "yolo", text: string) => string = (_kind, text) => text,
): string {
	if (!state) return "permissions unavailable";
	if (!state.enabled) return "permissions off";
	const jev = state.jev ? colorize("jev", "jev on") : "jev off";
	const yolo = state.yolo ? colorize("yolo", "yolo on") : "yolo off";
	return `${jev} · ${yolo} · thr ${state.threshold.toFixed(2)}`;
}
