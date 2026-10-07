/**
 * bash-safety — a semantic bash gate backed by the TypeSafe Jev classifier.
 *
 * Every bash command the model issues is classified against an editable rule
 * prompt (see ~/.pi/agent/bash-safety.jsonc). Credential paths are blocked
 * deterministically before the classifier is consulted. See PI-PERMISSIONS.md
 * for why the policy is shaped this way.
 *
 * Pure logic lives in ./lib.ts so it can be tested without pi's module alias.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
	addUsage,
	buildQuestion,
	capText,
	cacheKey,
	CircuitBreaker,
	confirmMessage,
	decide,
	effectiveWorkingDirectories,
	formatDistribution,
	hardBlockReason,
	matchHardBlock,
	normalizeConfig,
	parseJsonc,
	setBounded,
	snapshotIntent,
	verdictFromChoice,
	VerdictCache,
	type BashSafetyConfig,
	type IntentSnapshot,
	type UsageTotals,
	type Verdict,
} from "./lib.js";

/** Pending classifier usage entries kept while a bash call is in flight. */
const PENDING_USAGE_LIMIT = 64;

interface YoloControlResult {
	yoloMode: boolean;
	changed: boolean;
	persisted: boolean;
	error?: string;
}

interface PermissionSystemRuntimeApi {
	getYoloMode(): boolean;
	setYoloMode(enabled: boolean, options?: { persist?: boolean; source?: string }): YoloControlResult;
	toggleYoloMode(options?: { persist?: boolean; source?: string }): YoloControlResult;
}

/** What a cache entry remembers about one command's classification. */
interface CachedVerdict {
	verdict: Verdict;
	confidence: number | undefined;
	probabilities: Record<string, number> | undefined;
}

interface GateState {
	config: BashSafetyConfig;
	configPath: string;
	configStatus: "loaded" | "missing" | "invalid";
	configError: string | undefined;
	cache: VerdictCache<CachedVerdict>;
	breaker: CircuitBreaker;
	intent: IntentSnapshot;
	git: { remote: string; branch: string } | undefined;
	pendingUsage: Map<string, UsageTotals>;
	lastVerdict: string;
	yoloNotified: boolean;
	configNotified: boolean;
	breakerNotified: boolean;
}

interface ClassifyOutcome {
	kind: "ok" | "failure";
	verdict: Verdict;
	confidence: number | undefined;
	probabilities: Record<string, number> | undefined;
	usage: UsageTotals | undefined;
	error: string | undefined;
}

let gateState: GateState | undefined;

// --- config ---------------------------------------------------------------

function configPath(): string {
	return join(getAgentDir(), "bash-safety.jsonc");
}

function loadConfig(): { config: BashSafetyConfig; status: GateState["configStatus"]; error: string | undefined } {
	const path = configPath();
	try {
		const raw = readFileSync(path, "utf8");
		return { config: normalizeConfig(parseJsonc(raw)), status: "loaded", error: undefined };
	} catch (error) {
		const code = (error as { code?: string }).code;
		const message = error instanceof Error ? error.message : String(error);
		if (code === "ENOENT") return { config: normalizeConfig(null), status: "missing", error: undefined };
		return { config: normalizeConfig(null), status: "invalid", error: message };
	}
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// No UI in this mode; the model still sees block reasons.
	}
}

// --- session context ------------------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("\n");
	}
	return "";
}

function readIntent(ctx: ExtensionContext, maxChars: number): IntentSnapshot {
	let sessionName: string | undefined;
	let originalTask: string | undefined;
	let latestUserMessage: string | undefined;
	try {
		sessionName = ctx.sessionManager.getSessionName();
		const userTexts: string[] = [];
		let compactionSummary: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim() !== "") {
				compactionSummary = entry.summary;
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; content?: unknown };
			if (message.role !== "user") continue;
			const text = textOf(message.content);
			if (text.trim() !== "") userTexts.push(text);
		}
		originalTask = compactionSummary ?? userTexts[0];
		latestUserMessage = userTexts[userTexts.length - 1];
	} catch {
		// Session introspection is best effort.
	}
	return snapshotIntent({ sessionName, originalTask, latestUserMessage }, maxChars);
}

function readGit(cwd: string): { remote: string; branch: string } | undefined {
	const run = (args: string[]): string =>
		execFileSync("git", args, { cwd, timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		const remote = run(["remote", "get-url", "origin"]);
		let branch = "";
		try {
			branch = run(["branch", "--show-current"]);
		} catch {
			branch = "";
		}
		return { remote, branch };
	} catch {
		return undefined;
	}
}

// --- shared YOLO state ----------------------------------------------------

function permissionSystemApi(): PermissionSystemRuntimeApi | undefined {
	return (globalThis as unknown as { __piPermissionSystem?: PermissionSystemRuntimeApi }).__piPermissionSystem;
}

function readYolo(config: BashSafetyConfig): boolean {
	if (!config.usePermissionSystemYolo) return false;
	const api = permissionSystemApi();
	if (!api) return false;
	try {
		return api.getYoloMode() === true;
	} catch {
		return false;
	}
}

// --- state ----------------------------------------------------------------

function resetState(ctx: ExtensionContext): GateState {
	const loaded = loadConfig();
	const state: GateState = {
		config: loaded.config,
		configPath: configPath(),
		configStatus: loaded.status,
		configError: loaded.error,
		cache: new VerdictCache<CachedVerdict>(loaded.config.cacheEntries),
		breaker: new CircuitBreaker(loaded.config.failureThreshold),
		intent: readIntent(ctx, loaded.config.maxIntentChars),
		git: readGit(ctx.cwd),
		pendingUsage: new Map<string, UsageTotals>(),
		lastVerdict: "none",
		yoloNotified: false,
		configNotified: false,
		breakerNotified: false,
	};
	gateState = state;
	return state;
}

function ensureState(ctx: ExtensionContext): GateState {
	return gateState ?? resetState(ctx);
}

function warnConfigOnce(ctx: ExtensionContext, state: GateState): void {
	if (state.configStatus === "loaded" || state.configNotified) return;
	state.configNotified = true;
	const detail =
		state.configStatus === "missing"
			? "not found; using built-in defaults"
			: `could not be parsed (${state.configError ?? "unknown error"}); using built-in defaults`;
	notify(ctx, `bash-safety: ${state.configPath} ${detail}`, "warning");
}

// --- classifier -----------------------------------------------------------

async function resolveClassifier(ctx: ExtensionContext, config: BashSafetyConfig) {
	const { provider, id } = config.model;
	const exact = ctx.modelRegistry.findOfType("classifier", provider, id);
	if (exact) return exact;
	try {
		const available = await ctx.modelRegistry.getAvailableOfType("classifier", provider);
		return available[0];
	} catch {
		return undefined;
	}
}

async function classify(command: string, ctx: ExtensionContext, state: GateState): Promise<ClassifyOutcome> {
	const config = state.config;
	try {
		const model = await resolveClassifier(ctx, config);
		if (!model) {
			return {
				kind: "failure",
				verdict: "ask",
				confidence: undefined,
				probabilities: undefined,
				usage: undefined,
				error: `no classifier model for provider ${config.model.provider}`,
			};
		}
		const signals: AbortSignal[] = [AbortSignal.timeout(config.timeoutMs)];
		if (ctx.signal) signals.push(ctx.signal);
		const payload = {
			command: capText(command, config.maxCommandChars),
			cwd: ctx.cwd,
			workingDirectories: effectiveWorkingDirectories(config.workingDirectories, ctx.cwd),
			git: state.git,
			session: state.intent,
			environment: config.rules.environment,
		};
		const result = await ctx.modelRegistry.classify(
			model,
			{ state: payload, questions: buildQuestion(config.rules) as never },
			{ signal: AbortSignal.any(signals) },
		);
		if (result.stopReason !== "stop") {
			return {
				kind: "failure",
				verdict: "ask",
				confidence: undefined,
				probabilities: undefined,
				usage: undefined,
				error: result.errorMessage ?? result.stopReason,
			};
		}
		const answer = (
			result.answers as Record<
				string,
				{ type?: string; choice?: unknown; confidence?: unknown; probabilities?: unknown }
			>
		).verdict;
		const choice = answer && answer.type === "choice" ? answer.choice : undefined;
		const confidence = answer && typeof answer.confidence === "number" ? answer.confidence : undefined;
		const probabilities =
			answer && typeof answer.probabilities === "object" && answer.probabilities !== null
				? (answer.probabilities as Record<string, number>)
				: undefined;
		return {
			kind: "ok",
			verdict: verdictFromChoice(choice),
			confidence,
			probabilities,
			usage: result.usage as UsageTotals | undefined,
			error: undefined,
		};
	} catch (error) {
		return {
			kind: "failure",
			verdict: "ask",
			confidence: undefined,
			probabilities: undefined,
			usage: undefined,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// --- gate -----------------------------------------------------------------

async function gate(command: unknown, toolCallId: string, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	if (typeof command !== "string" || command.trim() === "") return undefined;
	const state = ensureState(ctx);
	if (!state.config.enabled) return undefined;

	const pattern = matchHardBlock(command, state.config.hardBlock.patterns, state.config.hardBlock.exemptions);
	if (pattern) {
		state.lastVerdict = `hard-block (${pattern})`;
		notify(ctx, `bash-safety: blocked credential access matching "${pattern}"`, "error");
		return { block: true, reason: hardBlockReason(pattern) };
	}

	const key = cacheKey(command, state.intent);
	let cached = state.cache.get(key);
	let source = "cache";

	if (cached === undefined) {
		if (state.breaker.tripped) return undefined;
		const outcome = await classify(command, ctx, state);
		if (outcome.kind === "failure") {
			const tripped = state.breaker.recordFailure();
			state.lastVerdict = "error (fail open)";
			notify(ctx, `bash-safety: classifier unavailable (${outcome.error}); allowing the command`, "warning");
			if (tripped && !state.breakerNotified) {
				state.breakerNotified = true;
				notify(ctx, "bash-safety: disabling the Jev gate for this session after repeated failures", "warning");
			}
			return undefined;
		}
		state.breaker.recordSuccess();
		cached = { verdict: outcome.verdict, confidence: outcome.confidence, probabilities: outcome.probabilities };
		source = "classifier";
		state.cache.set(key, cached);
		// Held until the tool result so the classifier cost lands in session totals.
		// A blocked call never produces one; setBounded keeps the map from growing.
		if (outcome.usage !== undefined) setBounded(state.pendingUsage, toolCallId, outcome.usage, PENDING_USAGE_LIMIT);
	}

	const verdict = cached.verdict;
	const action = decide(verdict, { hasUI: ctx.hasUI, yolo: readYolo(state.config) });
	state.lastVerdict = `${verdict} (${source})`;         

	if (action.kind === "run") {
		if (action.auto && !state.yoloNotified) {
			state.yoloNotified = true;
			notify(ctx, "bash-safety: YOLO is on — Jev's 'ask' verdicts now run without a prompt (deny still prompts)", "info");
		}
		return undefined;
	}

	if (action.kind === "block") {
		notify(ctx, `bash-safety: Jev said '${verdict}' and no UI is available to confirm; blocking`, "warning");
		return { block: true, reason: action.reason };
	}

	const approved = await ctx.ui.confirm(
		action.title,
		confirmMessage(verdict, capText(command, state.config.maxCommandChars), cached.confidence, cached.probabilities),
	);
	if (approved) return undefined;
	return { block: true, reason: `Rejected by the user after a Jev '${verdict}' verdict.` };
}

// --- extension ------------------------------------------------------------

function statusLine(state: GateState): string {
	const yolo = state.config.usePermissionSystemYolo ? (readYolo(state.config) ? "on" : "off") : "disabled";
	const configNote = state.configStatus === "loaded" ? "loaded" : state.configStatus;
	return [
		`bash-safety: enabled=${state.config.enabled ? "yes" : "no"}`,
		`model=${state.config.model.provider}/${state.config.model.id}`,
		`yolo=${yolo} (shared with pi-permission-system)`,
		`breaker=${state.breaker.tripped ? "open" : "closed"}`,
		`cache=${state.cache.size}`,
		`config=${configNote} (${state.configPath})`,
		`last=${state.lastVerdict}`,
	].join("  ");
}

export default function bashSafetyExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const state = resetState(ctx);
		warnConfigOnce(ctx, state);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		return await gate(event.input.command, event.toolCallId, ctx);
	});

	// Attach the classifier's usage to the bash result so it counts toward the
	// session cost. details and structuredContent are passed through because a
	// returned hook result replaces them.
	pi.on("tool_result", (event) => {
		const state = gateState;
		if (state === undefined) return;
		const usage = state.pendingUsage.get(event.toolCallId);
		if (usage === undefined) return;
		state.pendingUsage.delete(event.toolCallId);
		return {
			details: event.details,
			structuredContent: event.structuredContent,
			usage: addUsage(event.usage as UsageTotals | undefined, usage),
		};
	});

	pi.registerCommand("bash-safety", {
		description: "Inspect or control the Jev bash safety gate",
		handler: async (args, ctx) => {
			const state = ensureState(ctx);
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const sub = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

			switch (sub) {
				case "":
				case "status": {
					notify(ctx, statusLine(state), "info");
					return;
				}
				case "yolo": {
					const api = permissionSystemApi();
					if (!api) {
						notify(ctx, "bash-safety: pi-permission-system runtime API is unavailable; cannot control YOLO", "warning");
						return;
					}
					const mode = rest.toLowerCase();
					try {
						const result =
							mode === "on" ? api.setYoloMode(true, { source: "bash-safety" })
							: mode === "off" ? api.setYoloMode(false, { source: "bash-safety" })
							: api.toggleYoloMode({ source: "bash-safety" });
						if (result.error) {
							notify(ctx, `bash-safety: YOLO update failed (${result.error})`, "error");
							return;
						}
						notify(ctx, `bash-safety: YOLO ${result.yoloMode ? "on" : "off"}`, "info");
					} catch (error) {
						notify(ctx, `bash-safety: YOLO update failed (${error instanceof Error ? error.message : String(error)})`, "error");
					}
					return;
				}
				case "check": {
					if (rest === "") {
						notify(ctx, "bash-safety: usage: /bash-safety check <command>", "warning");
						return;
					}
					const pattern = matchHardBlock(rest, state.config.hardBlock.patterns, state.config.hardBlock.exemptions);
					if (pattern) {
						notify(ctx, `bash-safety: hard-block (matched "${pattern}") — never prompts, never bypassed by YOLO`, "warning");
						return;
					}
					const outcome = await classify(rest, ctx, state);
					if (outcome.kind === "failure") {
						notify(ctx, `bash-safety: classifier failed (${outcome.error}) — would fail open and run`, "warning");
						return;
					}
					const yolo = readYolo(state.config);
					const action = decide(outcome.verdict, { hasUI: ctx.hasUI, yolo });
					const confidence = outcome.confidence === undefined ? "n/a" : outcome.confidence.toFixed(2);
					const distribution = formatDistribution(outcome.probabilities);
					const auto = action.kind === "run" && action.auto ? " (yolo)" : "";
					const detail = distribution === "" ? "" : `  [${distribution}]`;
					notify(
						ctx,
						`bash-safety: ${outcome.verdict} (confidence ${confidence}) -> ${action.kind}${auto}${detail}`,
						outcome.verdict === "allow" ? "info" : "warning",
					);
					return;
				}
				case "reload": {
					const reloaded = resetState(ctx);
					warnConfigOnce(ctx, reloaded);
					notify(ctx, `bash-safety: reloaded — ${statusLine(reloaded)}`, "info");
					return;
				}
				default: {
					notify(ctx, "bash-safety: usage: /bash-safety [status|yolo [on|off|toggle]|check <command>|reload]", "warning");
				}
			}
		},
	});
}
