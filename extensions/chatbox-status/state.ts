export type AgentOutcome = "completed" | "aborted" | "error";

export function formatDuration(milliseconds: number): string {
	const safeMs = Math.max(0, milliseconds);
	if (safeMs < 1_000) return `${Math.round(safeMs)} ms`;
	if (safeMs < 60_000) return `${(safeMs / 1_000).toFixed(1)} s`;
	const minutes = Math.floor(safeMs / 60_000);
	const seconds = ((safeMs - minutes * 60_000) / 1_000).toFixed(1);
	return `${minutes} m ${seconds} s`;
}

export interface ModelTimeResult {
	durationMs: number;
	outcome: AgentOutcome;
	model?: string;
	thinkingLevel?: string;
}

export interface ActiveModelTime {
	accumulatedMs: number;
	generationStartedAt?: number;
	model?: string;
	thinkingLevel?: string;
}

export interface ModelTimeState {
	current?: ActiveModelTime;
	last?: ModelTimeResult;
}

export function emptyModelTimeState(): ModelTimeState {
	return {};
}

/** Start measuring one agent run while retaining the previous settled result. */
export function startAgentRun(state: ModelTimeState): ModelTimeState {
	return { ...state, current: { accumulatedMs: 0 } };
}

/** Begin counting only while Pi is streaming an assistant generation. */
export function startModelGeneration(
	state: ModelTimeState,
	now: number,
	metadata: { model?: string; thinkingLevel?: string } = {},
): ModelTimeState {
	const current = state.current;
	if (!current || current.generationStartedAt !== undefined) return state;
	return {
		...state,
		current: {
			accumulatedMs: current.accumulatedMs,
			generationStartedAt: now,
			...(isNonEmptyString(metadata.model) ? { model: metadata.model } : {}),
			...(isNonEmptyString(metadata.thinkingLevel) ? { thinkingLevel: metadata.thinkingLevel } : {}),
		},
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** End one generation interval; tool execution and user-facing prompts are not counted. */
export function finishModelGeneration(state: ModelTimeState, now: number): ModelTimeState {
	const current = state.current;
	if (!current || current.generationStartedAt === undefined) return state;
	return {
		...state,
		current: {
			accumulatedMs: current.accumulatedMs + Math.max(0, now - current.generationStartedAt),
			...(current.model ? { model: current.model } : {}),
			...(current.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {}),
		},
	};
}

export function currentModelTimeMs(state: ModelTimeState, now: number): number | undefined {
	const current = state.current;
	if (!current) return undefined;
	return current.accumulatedMs + (current.generationStartedAt === undefined ? 0 : Math.max(0, now - current.generationStartedAt));
}

/** Freeze the total on completion, cancellation, or failure. */
export function settleAgentRun(state: ModelTimeState, outcome: AgentOutcome, now: number): ModelTimeState {
	if (!state.current) return state;
	const finished = finishModelGeneration(state, now);
	const current = finished.current;
	return {
		last: {
			durationMs: current?.accumulatedMs ?? 0,
			outcome,
			...(current?.model ? { model: current.model } : {}),
			...(current?.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {}),
		},
	};
}
