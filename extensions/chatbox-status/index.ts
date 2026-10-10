import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	isModeStateSnapshot,
	isPermissionsStateSnapshot,
	MODE_STATE_EVENT,
	PERMISSIONS_STATE_EVENT,
	type ModeStateSnapshot,
	type PermissionsStateSnapshot,
} from "../shared/contracts.ts";
import {
	currentModelTimeMs,
	emptyModelTimeState,
	finishModelGeneration,
	settleAgentRun,
	startAgentRun,
	startModelGeneration,
	type AgentOutcome,
	type ModelTimeState,
} from "./state.ts";

const WIDGET_KEY = "chatbox-status";
const TIMER_TICK_MS = 200;
const PENDING_SESSION_LIMIT = 4;

let context: ExtensionContext | undefined;
let activeSessionId: string | undefined;
let activeCwd: string | undefined;
let modeSnapshot: ModeStateSnapshot | undefined;
let permissionsSnapshot: PermissionsStateSnapshot | undefined;
const pendingModeSnapshots = new Map<string, ModeStateSnapshot>();
const pendingPermissionsSnapshots = new Map<string, PermissionsStateSnapshot>();
let timing: ModelTimeState = emptyModelTimeState();
let pendingOutcome: AgentOutcome = "completed";
let timer: ReturnType<typeof setInterval> | undefined;

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() || "ephemeral";
}

function remember<T>(map: Map<string, T>, id: string, value: T): void {
	map.delete(id);
	map.set(id, value);
	while (map.size > PENDING_SESSION_LIMIT) {
		const oldest = map.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

function stopTimer(): void {
	if (timer !== undefined) clearInterval(timer);
	timer = undefined;
}

function clearSessionState(): void {
	stopTimer();
	modeSnapshot = undefined;
	permissionsSnapshot = undefined;
	timing = emptyModelTimeState();
	pendingOutcome = "completed";
}

function formatDuration(milliseconds: number): string {
	const safeMs = Math.max(0, milliseconds);
	if (safeMs < 1_000) return `${Math.round(safeMs)} ms`;
	if (safeMs < 60_000) return `${(safeMs / 1_000).toFixed(1)} s`;
	const minutes = Math.floor(safeMs / 60_000);
	const seconds = ((safeMs - minutes * 60_000) / 1_000).toFixed(1);
	return `${minutes} m ${seconds} s`;
}

function modeLabel(snapshot: ModeStateSnapshot | undefined): string {
	if (!snapshot) return "Mode: unavailable";
	const mode = snapshot.mode[0]!.toUpperCase() + snapshot.mode.slice(1);
	return `Mode: ${mode}`;
}

function planLine(snapshot: ModeStateSnapshot | undefined): string | undefined {
	if (!snapshot || (snapshot.mode !== "plan" && snapshot.mode !== "build")) return undefined;
	const plan = snapshot.activePlan;
	if (!plan || plan.status !== "open" || !plan.ownedByCurrentSession) return undefined;
	const title = plan.title.trim();
	const goal = plan.goalSummary?.trim();
	return `Plan: ${title}${goal ? ` — ${goal}` : ""}`;
}

function permissionsLine(snapshot: PermissionsStateSnapshot | undefined): string {
	if (!snapshot) return "Permissions: unavailable";
	if (!snapshot.enabled) return "Permissions: off";
	const parts = [
		`jev ${snapshot.jev ? "on" : "off"}`,
		`yolo ${snapshot.yolo ? "on" : "off"}`,
		`thr ${snapshot.threshold.toFixed(2)}`,
		snapshot.model,
	];
	if (snapshot.calls > 0) parts.push(`${snapshot.calls} reqs`);
	return `Permissions: ${parts.join(" · ")}`;
}

function timingLine(now: number): string {
	const current = currentModelTimeMs(timing, now);
	if (current !== undefined) return `Model time: ${formatDuration(current)} · in progress`;
	if (!timing.last) return "Model time: —";
	return `Model time: ${formatDuration(timing.last.durationMs)} · ${timing.last.outcome}`;
}

function renderWidget(): void {
	const ctx = context;
	if (!ctx || ctx.mode !== "tui") return;
	const lines = [modeLabel(modeSnapshot)];
	const plan = planLine(modeSnapshot);
	if (plan) lines.push(plan);
	lines.push(timingLine(performance.now()));
	lines.push(permissionsLine(permissionsSnapshot));
	try {
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
			const mode = theme.fg("accent", lines[0] ?? "Mode: unavailable");
			return new Text([mode, ...lines.slice(1)].join("\n"), 0, 0);
		}, { placement: "aboveEditor" });
	} catch {
		// The consumer is display-only; unsupported UI modes must not affect Pi.
	}
}

function startTimer(): void {
	if (timer !== undefined) return;
	timer = setInterval(renderWidget, TIMER_TICK_MS);
	timer.unref?.();
}

function handleModeSnapshot(payload: unknown): void {
	if (!isModeStateSnapshot(payload)) return;
	if (activeSessionId === payload.sessionId) {
		if (activeCwd && activeCwd !== payload.cwd) return;
		if (!modeSnapshot || payload.updatedAt >= modeSnapshot.updatedAt) modeSnapshot = payload;
		renderWidget();
		return;
	}
	remember(pendingModeSnapshots, payload.sessionId, payload);
}

function handlePermissionsSnapshot(payload: unknown): void {
	if (!isPermissionsStateSnapshot(payload)) return;
	if (activeSessionId === payload.sessionId) {
		if (!permissionsSnapshot || payload.updatedAt >= permissionsSnapshot.updatedAt) permissionsSnapshot = payload;
		renderWidget();
		return;
	}
	remember(pendingPermissionsSnapshots, payload.sessionId, payload);
}

export default function chatboxStatusExtension(pi: ExtensionAPI): void {
	pi.events.on(MODE_STATE_EVENT, handleModeSnapshot);
	pi.events.on(PERMISSIONS_STATE_EVENT, handlePermissionsSnapshot);

	pi.on("session_start", (_event, ctx) => {
		const nextSessionId = sessionId(ctx);
		if (activeSessionId !== nextSessionId) {
			clearSessionState();
			activeSessionId = nextSessionId;
			activeCwd = ctx.cwd;
			modeSnapshot = pendingModeSnapshots.get(nextSessionId);
			permissionsSnapshot = pendingPermissionsSnapshots.get(nextSessionId);
			pendingModeSnapshots.clear();
			pendingPermissionsSnapshots.clear();
		} else {
			modeSnapshot = pendingModeSnapshots.get(nextSessionId) ?? modeSnapshot;
			permissionsSnapshot = pendingPermissionsSnapshots.get(nextSessionId) ?? permissionsSnapshot;
			pendingModeSnapshots.clear();
			pendingPermissionsSnapshots.clear();
		}
		context = ctx;
		if (ctx.mode === "tui") renderWidget();
	});

	pi.on("agent_start", () => {
		timing = startAgentRun(timing);
		pendingOutcome = "completed";
		renderWidget();
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant" || !timing.current) return;
		timing = startModelGeneration(timing, performance.now());
		if (context?.mode === "tui") startTimer();
		renderWidget();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !timing.current) return;
		timing = finishModelGeneration(timing, performance.now());
		stopTimer();
		renderWidget();
	});

	pi.on("agent_before_settle", (event) => {
		pendingOutcome = event.outcome;
		timing = finishModelGeneration(timing, performance.now());
		stopTimer();
		renderWidget();
	});

	pi.on("agent_settled", () => {
		timing = settleAgentRun(timing, pendingOutcome, performance.now());
		stopTimer();
		renderWidget();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (context === ctx) context = undefined;
		activeSessionId = undefined;
		activeCwd = undefined;
		clearSessionState();
	});
}
