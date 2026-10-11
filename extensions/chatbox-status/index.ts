import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	CHATBOX_TIMING_ENTRY_TYPE,
	COMPOSER_STATUS_EVENT,
	isModeStateSnapshot,
	isPermissionsStateSnapshot,
	isTimingEntryData,
	MODE_STATE_EVENT,
	PERMISSIONS_STATE_EVENT,
	type ModeStateSnapshot,
	type PermissionsStateSnapshot,
	type StateEventKind,
	type TimingEntryData,
} from "../shared/contracts.ts";
import { makeComposerStatusSnapshot } from "../shared/composer-status.ts";
import {
	emptyModelTimeState,
	finishModelGeneration,
	formatDuration,
	settleAgentRun,
	startAgentRun,
	startModelGeneration,
	type AgentOutcome,
	type ModelTimeState,
} from "./state.ts";

const PENDING_SESSION_LIMIT = 4;

let activeSessionId: string | undefined;
let activeCwd: string | undefined;
let modeSnapshot: ModeStateSnapshot | undefined;
let permissionsSnapshot: PermissionsStateSnapshot | undefined;
const pendingModeSnapshots = new Map<string, ModeStateSnapshot>();
const pendingPermissionsSnapshots = new Map<string, PermissionsStateSnapshot>();
let timing: ModelTimeState = emptyModelTimeState();
let pendingOutcome: AgentOutcome = "completed";

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

function clearSessionState(): void {
	modeSnapshot = undefined;
	permissionsSnapshot = undefined;
	timing = emptyModelTimeState();
	pendingOutcome = "completed";
}

function publishComposerStatus(pi: ExtensionAPI, kind: StateEventKind = "changed"): void {
	if (!activeSessionId || activeCwd === undefined) return;
	const snapshot = makeComposerStatusSnapshot({
		sessionId: activeSessionId,
		cwd: activeCwd,
		mode: modeSnapshot,
		permissions: permissionsSnapshot,
		kind,
		updatedAt: Date.now(),
	});
	try { pi.events.emit(COMPOSER_STATUS_EVENT, snapshot); }
	catch { /* Presentation events must never affect permission decisions or agent execution. */ }
}

function appendTimingEntry(pi: ExtensionAPI, data: TimingEntryData): void {
	try { pi.appendEntry(CHATBOX_TIMING_ENTRY_TYPE, data); }
	catch { /* Transcript decoration must never affect agent settlement. */ }
}

function handleModeSnapshot(pi: ExtensionAPI, payload: unknown): void {
	if (!isModeStateSnapshot(payload)) return;
	if (activeSessionId === payload.sessionId) {
		if (activeCwd && activeCwd !== payload.cwd) return;
		if (!modeSnapshot || payload.updatedAt >= modeSnapshot.updatedAt) {
			modeSnapshot = payload;
			publishComposerStatus(pi);
		}
		return;
	}
	remember(pendingModeSnapshots, payload.sessionId, payload);
}

function handlePermissionsSnapshot(pi: ExtensionAPI, payload: unknown): void {
	if (!isPermissionsStateSnapshot(payload)) return;
	if (activeSessionId === payload.sessionId) {
		if (!permissionsSnapshot || payload.updatedAt >= permissionsSnapshot.updatedAt) {
			permissionsSnapshot = payload;
			publishComposerStatus(pi);
		}
		return;
	}
	remember(pendingPermissionsSnapshots, payload.sessionId, payload);
}

export default function chatboxStatusExtension(pi: ExtensionAPI): void {
	const unsubscribeMode = pi.events.on(MODE_STATE_EVENT, (payload) => handleModeSnapshot(pi, payload));
	const unsubscribePermissions = pi.events.on(PERMISSIONS_STATE_EVENT, (payload) => handlePermissionsSnapshot(pi, payload));

	pi.registerEntryRenderer<TimingEntryData>(CHATBOX_TIMING_ENTRY_TYPE, (entry, _options, theme) => {
		if (!isTimingEntryData(entry.data)) return undefined;
		const data = entry.data;
		const label = `Model time: ${formatDuration(data.durationMs)} · ${data.outcome}`;
		const color = data.outcome === "completed" ? "dim" : data.outcome === "aborted" ? "warning" : "error";
		return new Text(theme.fg(color, label), 0, 0);
	});

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
			activeCwd = ctx.cwd;
			modeSnapshot = pendingModeSnapshots.get(nextSessionId) ?? modeSnapshot;
			permissionsSnapshot = pendingPermissionsSnapshots.get(nextSessionId) ?? permissionsSnapshot;
			pendingModeSnapshots.clear();
			pendingPermissionsSnapshots.clear();
		}
		publishComposerStatus(pi, "snapshot");
	});

	pi.on("agent_start", () => {
		timing = startAgentRun(timing);
		pendingOutcome = "completed";
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant" || !timing.current) return;
		timing = startModelGeneration(timing, performance.now());
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !timing.current) return;
		timing = finishModelGeneration(timing, performance.now());
	});

	pi.on("agent_before_settle", (event) => {
		pendingOutcome = event.outcome;
		timing = finishModelGeneration(timing, performance.now());
	});

	pi.on("agent_settled", () => {
		timing = settleAgentRun(timing, pendingOutcome, performance.now());
		const result = timing.last;
		if (result) {
			appendTimingEntry(pi, {
				schemaVersion: 1,
				durationMs: result.durationMs,
				outcome: result.outcome,
			});
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeMode();
		unsubscribePermissions();
		activeSessionId = undefined;
		activeCwd = undefined;
		clearSessionState();
	});
}
