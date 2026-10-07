/**
 * permissions — one policy layer for every tool.
 *
 * A deterministic core decides what it can for free: credential and catastrophe hard
 * blocks, the mode dimension, and the declarative bash rules. The TypeSafe Jev
 * classifier is consulted only for effectful tools a rule cannot read, and only while
 * the Jev switch is on. Two independent switches give four combinations; see
 * PI-PERMISSIONS.md for the table and for why YOLO removes the hard blocks too.
 *
 * Pure logic lives in ./lib.ts so plain node can test it without pi's module alias.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
	buildJevPayload,
	buildQuestion,
	capText,
	cacheKey,
	CircuitBreaker,
	confirmMessage,
	decide,
	describeCheckDecision,
	describeCheckFailure,
	describeCheckJev,
	effectiveVerdict,
	effectiveWorkingDirectories,
	emptyJevCounters,
	formatJevCounters,
	FORWARDING_AGENT_DIR_ENV_KEY,
	isMcpTool,
	isShellTool,
	modeFromEntries,
	normalizeConfig,
	PARENT_SESSION_ENV_KEY,
	permissionIndicator,
	parseJsonc,
	parseForwardedResponse,
	parseThreshold,
	permissionArgumentCompletion,
	permissionCompletions,
	permissionsUsage,
	PLAN_BUILD_STATE_TYPE,
	recordClassification,
	resolveDeterministic,
	resolveMode,
	setBounded,
	stripSurroundingQuotes,
	snapshotIntent,
	toolCategory,
	verdictFromChoice,
	VerdictCache,
	forwardingPaths,
	isSubagentEnv,
	type Decision,
	type IntentSnapshot,
	type JevCounters,
	type Mode,
	type PermissionsConfig,
	type SwitchState,
	type UsageTotals,
	type Verdict,
} from "./lib.js";

/** Pending classifier usage entries kept while a tool call is in flight. */
const PENDING_USAGE_LIMIT = 64;
const FORWARD_POLL_MS = 2000;
const FORWARD_TIMEOUT_MS = 10 * 60 * 1000;

interface CachedVerdict {
	verdict: Verdict;
	confidence: number | undefined;
	probabilities: Record<string, number> | undefined;
}

interface State {
	config: PermissionsConfig;
	configPath: string;
	configStatus: "loaded" | "missing" | "invalid";
	configError: string | undefined;
	switches: SwitchState;
	mode: Mode;
	cache: VerdictCache<CachedVerdict>;
	breaker: CircuitBreaker;
	intent: IntentSnapshot;
	pendingUsage: Map<string, UsageTotals>;
	/** Classifier calls this session, by raw verdict and confidence side. */
	counters: JevCounters;
	/** Identical-call counters, which is what `special.doom_loop` covered before. */
	dooms: Map<string, number>;
	lastDecision: string;
	yoloNotified: boolean;
	configNotified: boolean;
	breakerNotified: boolean;
	leafId: string | null;
}

interface ClassifyOutcome {
	kind: "ok" | "failure";
	verdict: Verdict;
	confidence: number | undefined;
	probabilities: Record<string, number> | undefined;
	usage: UsageTotals | undefined;
	error: string | undefined;
}

let state: State | undefined;

// --- paths and config -----------------------------------------------------

/** `PI_PERMISSIONS_CONFIG_PATH` points the policy at another file, for tests. */
function configPath(): string {
	return process.env.PI_PERMISSIONS_CONFIG_PATH ?? join(getAgentDir(), "permissions.jsonc");
}

function auditPath(): string {
	return join(getAgentDir(), "extensions", "permissions", "logs", "permissions.jsonl");
}

function loadConfig(): { config: PermissionsConfig; status: State["configStatus"]; error: string | undefined } {
	try {
		const raw = readFileSync(configPath(), "utf8");
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
		// No UI in this mode; block reasons still reach the model.
	}
}

/** One JSONL line per decision. The directory is on pi-config-sync's denylist. */
function audit(entry: Record<string, unknown>): void {
	if (state === undefined || !state.config.audit.enabled) return;
	try {
		const path = auditPath();
		mkdirSync(join(path, ".."), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		// An unwritable log must never break a decision.
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

/** pi-plan-build publishes no API and emits no events, so the mode comes from state. */
function readMode(ctx: ExtensionContext, pi: ExtensionAPI): Mode {
	let persisted: Mode | undefined;
	try {
		persisted = modeFromEntries(
			ctx.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom")
				.map((entry) => {
					const custom = entry as { customType?: string; data?: unknown };
					return { customType: custom.customType, data: custom.data };
				}),
		);
	} catch {
		persisted = undefined;
	}
	return resolveMode({
		planFlag: pi.getFlag("plan") === true,
		buildFlag: pi.getFlag("build") === true,
		persisted,
	});
}

// --- state ----------------------------------------------------------------

function resetState(ctx: ExtensionContext, pi: ExtensionAPI): State {
	const loaded = loadConfig();
	// The session cwd counts as a working directory, so a relative target like `build`
	// resolves inside it and a delete there stays decidable.
	const config: PermissionsConfig = {
		...loaded.config,
		workingDirectories: effectiveWorkingDirectories(loaded.config.workingDirectories, ctx.cwd),
	};
	const next: State = {
		config,
		configPath: configPath(),
		configStatus: loaded.status,
		configError: loaded.error,
		switches: { jev: loaded.config.jev.enabled, yolo: loaded.config.yolo },
		mode: readMode(ctx, pi),
		cache: new VerdictCache<CachedVerdict>(loaded.config.cacheEntries),
		breaker: new CircuitBreaker(loaded.config.failureThreshold),
		intent: readIntent(ctx, loaded.config.maxIntentChars),
		pendingUsage: new Map<string, UsageTotals>(),
		counters: emptyJevCounters(),
		dooms: new Map<string, number>(),
		lastDecision: "none",
		yoloNotified: false,
		configNotified: false,
		breakerNotified: false,
		leafId: null,
	};
	state = next;
	syncStatus(ctx, next);
	return next;
}

function ensureState(ctx: ExtensionContext, pi: ExtensionAPI): State {
	return state ?? resetState(ctx, pi);
}

/**
 * The footer indicator, on the built-in footer's extension status line. Guarded like
 * `notify`, so a non-UI mode is a no-op.
 */
function syncStatus(ctx: ExtensionContext, current: State): void {
	try {
		const indicator = permissionIndicator({
			enabled: current.config.enabled,
			jev: current.switches.jev,
			yolo: current.switches.yolo,
			threshold: current.config.jev.confidenceThreshold,
			model: current.config.jev.model.id,
			calls: current.counters.total,
		});
		// Only the two `on` words carry a colour; the line is never coloured as a whole.
		const line = indicator.segments
			.map((segment) => (segment.color === undefined ? segment.text : ctx.ui.theme.fg(segment.color, segment.text)))
			.join(" · ");
		ctx.ui.setStatus("permissions", line);
	} catch {
		// No UI in this mode.
	}
}

/**
 * pi's editor routes Tab to file completion once the line has a space, which skips a
 * command's own argument completions. Answering for `/permissions` here keeps Tab on the
 * subcommands and their values; `check`'s value still falls through to files.
 */
function installArgumentCompletions(ctx: ExtensionContext): void {
	try {
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const ours = permissionArgumentCompletion(textBeforeCursor);
				if (ours !== undefined) return ours;
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	} catch {
		// No editor to attach to (print or RPC mode).
	}
}

/**
 * Re-read the mode when the session moved on. A composer toggle appends a
 * `pi-plan-build-state` entry, which moves the leaf, so this is what keeps the gate
 * and the `/permissions` command from evaluating against a stale mode.
 */
function refreshMode(ctx: ExtensionContext, pi: ExtensionAPI, current: State): void {
	const leafId = ctx.sessionManager.getLeafId();
	if (leafId === current.leafId) return;
	current.leafId = leafId;
	current.mode = readMode(ctx, pi);
}

function warnConfigOnce(ctx: ExtensionContext, current: State): void {
	if (current.configStatus === "loaded" || current.configNotified) return;
	current.configNotified = true;
	const detail =
		current.configStatus === "missing"
			? "not found; using built-in defaults"
			: `could not be parsed (${current.configError ?? "unknown error"}); using built-in defaults`;
	notify(ctx, `permissions: ${current.configPath} ${detail}`, "warning");
}

// --- classifier -----------------------------------------------------------

async function resolveClassifier(ctx: ExtensionContext, config: PermissionsConfig) {
	const { provider, id } = config.jev.model;
	const exact = ctx.modelRegistry.findOfType("classifier", provider, id);
	if (exact) return exact;
	try {
		const available = await ctx.modelRegistry.getAvailableOfType("classifier", provider);
		return available[0];
	} catch {
		return undefined;
	}
}

async function classify(payload: Record<string, unknown>, ctx: ExtensionContext, current: State): Promise<ClassifyOutcome> {
	const config = current.config;
	try {
		const model = await resolveClassifier(ctx, config);
		if (!model) {
			return failure(`no classifier model for provider ${config.jev.model.provider}`);
		}
		const signals: AbortSignal[] = [AbortSignal.timeout(config.jev.timeoutMs)];
		if (ctx.signal) signals.push(ctx.signal);
		const result = await ctx.modelRegistry.classify(
			model,
			{ state: payload, questions: buildQuestion(config.rules) as never },
			{ signal: AbortSignal.any(signals) },
		);
		if (result.stopReason !== "stop") return failure(result.errorMessage ?? result.stopReason);
		const answer = (
			result.answers as Record<string, { type?: string; choice?: unknown; confidence?: unknown; probabilities?: unknown }>
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
		return failure(error instanceof Error ? error.message : String(error));
	}
}

function failure(message: string): ClassifyOutcome {
	return { kind: "failure", verdict: "ask", confidence: undefined, probabilities: undefined, usage: undefined, error: message };
}

// --- approvals ------------------------------------------------------------

/**
 * Ask the user, or forward the question to the interactive parent when this is a
 * subagent with no UI of its own. One-shot: Allow once or Reject, nothing stored.
 */
async function requestApproval(title: string, message: string, toolCallId: string, ctx: ExtensionContext): Promise<boolean> {
	if (ctx.hasUI) {
		try {
			return await ctx.ui.confirm(title, message);
		} catch {
			return false;
		}
	}
	if (!isSubagentEnv(process.env)) return false;
	return await forwardApproval(toolCallId, title, message);
}

function forwardingRoot(): string {
	return process.env[FORWARDING_AGENT_DIR_ENV_KEY] ?? getAgentDir();
}

/** Requester side: write a request, then wait for the parent's response. */
async function forwardApproval(toolCallId: string, title: string, message: string): Promise<boolean> {
	const parentSessionId = process.env[PARENT_SESSION_ENV_KEY];
	if (!parentSessionId) return false;
	const { requests, responses } = forwardingPaths(forwardingRoot(), parentSessionId);
	const requestId = `${toolCallId}-${Date.now()}`;
	try {
		mkdirSync(requests, { recursive: true });
		mkdirSync(responses, { recursive: true });
		appendFileSync(
			join(requests, `${requestId}.json`),
			JSON.stringify({ id: requestId, toolName: title, message, createdAt: Date.now() }),
			"utf8",
		);
	} catch {
		return false;
	}
	const deadline = Date.now() + FORWARD_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const raw = readFileSync(join(responses, `${requestId}.json`), "utf8");
			const parsed = parseForwardedResponse(raw, requestId);
			if (parsed !== undefined) return parsed.approved;
		} catch {
			// Not answered yet.
		}
		await new Promise((resolve) => setTimeout(resolve, FORWARD_POLL_MS));
	}
	return false;
}

/** Parent side: scan for forwarded requests, prompt, and answer. */
function startForwardingWatcher(ctx: ExtensionContext): void {
	if (!ctx.hasUI || isSubagentEnv(process.env)) return;
	const sessionId = ctx.sessionManager.getSessionId();
	const { requests, responses } = forwardingPaths(forwardingRoot(), sessionId);
	let busy = false;
	const timer = setInterval(() => {
		if (busy) return;
		busy = true;
		void (async () => {
			try {
				const { readdirSync } = await import("node:fs");
				let names: string[] = [];
				try {
					names = readdirSync(requests).filter((name) => name.endsWith(".json"));
				} catch {
					return;
				}
				for (const name of names) {
					let parsed: { id?: unknown; message?: unknown } = {};
					try {
						parsed = JSON.parse(readFileSync(join(requests, name), "utf8")) as { id?: unknown; message?: unknown };
					} catch {
						continue;
					}
					const id = typeof parsed.id === "string" ? parsed.id : undefined;
					if (id === undefined) continue;
					const approved = await ctx.ui.confirm("Subagent permission request", String(parsed.message ?? ""));
					mkdirSync(responses, { recursive: true });
					appendFileSync(join(responses, `${id}.json`), JSON.stringify({ id, approved, respondedAt: Date.now() }), "utf8");
					audit({ tool: "forwarded", decision: approved ? "allow" : "block", source: "forwarding" });
				}
			} catch {
				// A watcher failure must not disturb the session.
			} finally {
				busy = false;
			}
		})();
	}, FORWARD_POLL_MS);
	timer.unref?.();
}

// --- the gate -------------------------------------------------------------

function targetPathOf(event: { toolName: string; input: Record<string, unknown> }): string | undefined {
	const input = event.input as { path?: unknown; file_path?: unknown; target?: unknown };
	const candidate = input.path ?? input.file_path ?? input.target;
	return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

function previewOf(event: { input: Record<string, unknown> }, max: number): string | undefined {
	const input = event.input as { content?: unknown; newText?: unknown; oldText?: unknown; command?: unknown };
	const candidate = input.content ?? input.newText ?? input.oldText ?? input.command;
	if (typeof candidate !== "string" || candidate === "") return undefined;
	return capText(candidate, max);
}

function commandOf(event: { toolName: string; input: Record<string, unknown> }): string | undefined {
	if (!isShellTool(event.toolName)) return undefined;
	const candidate = (event.input as { command?: unknown }).command;
	return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

async function gate(
	event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<ToolCallEventResult | undefined> {
	const current = ensureState(ctx, pi);
	if (!current.config.enabled) return undefined;

	refreshMode(ctx, pi, current);

	const command = commandOf(event);
	const targetPath = targetPathOf(event);
	const category = toolCategory(event.toolName);

	const decision = resolveDeterministic({
		toolName: event.toolName,
		mode: current.mode,
		switches: current.switches,
		policy: current.config,
		cwd: ctx.cwd,
		command,
		targetPath,
	});
	current.lastDecision = decision.kind;

	if (decision.kind === "allow") {
		// The same call with the same arguments, over and over, is what the old
		// `special.doom_loop` check caught; ask before it runs a fourth time.
		const signature = `${event.toolName}\u0000${JSON.stringify(event.input ?? {})}`;
		const count = (current.dooms.get(signature) ?? 0) + 1;
		setBounded(current.dooms, signature, count, 200);
		if (current.config.doomLoop.state !== "allow" && count >= current.config.doomLoop.threshold) {
			const reason = `permissions: '${event.toolName}' has been called with identical arguments ${count} times, which looks like a loop.`;
			audit({ tool: event.toolName, mode: current.mode, switches: current.switches, decision: "ask", source: "doom-loop", reason });
			return await resolveAsk("permissions: repeated identical call", reason, event.toolCallId, ctx, current);
		}
		audit({ tool: event.toolName, mode: current.mode, switches: current.switches, decision: "allow", source: "deterministic" });
		return undefined;
	}
	if (decision.kind === "block") {
		audit({ tool: event.toolName, mode: current.mode, switches: current.switches, decision: "block", source: "deterministic", reason: decision.reason });
		notify(ctx, `permissions: blocked ${event.toolName}`, "error");
		return { block: true, reason: decision.reason };
	}
	if (decision.kind === "ask") {
		audit({ tool: event.toolName, mode: current.mode, switches: current.switches, decision: "ask", source: "deterministic", reason: decision.reason });
		return await resolveAsk("permissions", decision.reason, event.toolCallId, ctx, current);
	}

	// Classify. Cached per payload so an identical call in the same session is free.
	// `decision.reason` records why this needed the classifier at all.
	const judgement = decision.reason;
	const key = cacheKey(JSON.stringify({ tool: event.toolName, command, targetPath }), current.intent);
	const cachedBefore = current.cache.get(key);
	let cached = cachedBefore;
	let source = "cache";
	if (cached === undefined) {
		if (current.breaker.tripped) {
			audit({ tool: event.toolName, mode: current.mode, switches: current.switches, decision: "allow", source: "breaker-open" });
			return undefined;
		}
		const outcome = await classify(
			buildJevPayload({
				toolName: event.toolName,
				mode: current.mode,
				cwd: ctx.cwd,
				command,
				targetPath,
				preview: previewOf(event, current.config.maxPreviewChars),
				intent: current.intent,
				environment: current.config.rules.environment,
				maxCommandChars: current.config.maxCommandChars,
				maxPreviewChars: current.config.maxPreviewChars,
			}),
			ctx,
			current,
		);
		if (outcome.kind === "failure") {
			const tripped = current.breaker.recordFailure();
			notify(ctx, `permissions: classifier unavailable (${outcome.error}); allowing ${event.toolName}`, "warning");
			if (tripped && !current.breakerNotified) {
				current.breakerNotified = true;
				notify(ctx, "permissions: stopping classification for this session after repeated failures", "warning");
			}
			audit({ tool: event.toolName, mode: current.mode, switches: current.switches, decision: "allow", source: "classifier-failure", reason: outcome.error });
			return undefined;
		}
		current.breaker.recordSuccess();
		cached = { verdict: outcome.verdict, confidence: outcome.confidence, probabilities: outcome.probabilities };
		source = "classifier";
		current.cache.set(key, cached);
		if (outcome.usage !== undefined) setBounded(current.pendingUsage, event.toolCallId, outcome.usage, PENDING_USAGE_LIMIT);
	}

	// A verdict below the threshold is not trusted: it becomes an ask, which YOLO then
	// auto-approves. The audit keeps the raw verdict and the confidence so a threshold
	// prompt is distinguishable from one Jev actually asked for.
	// A cache hit is not a classification, so it does not move the counters; the threshold
	// in force now decides the side, not whatever it is at the end of the session.
	const threshold = current.config.jev.confidenceThreshold;
	current.counters = recordClassification(current.counters, {
		counted: cachedBefore === undefined,
		verdict: cached.verdict,
		confidence: cached.confidence,
		probabilities: cached.probabilities,
		threshold,
	});
	if (cachedBefore === undefined) syncStatus(ctx, current);
	const { verdict, downgraded } = effectiveVerdict(cached.verdict, cached.confidence, cached.probabilities, threshold);
	const action = decide(verdict, { hasUI: ctx.hasUI, yolo: false });
	audit({
		tool: event.toolName,
		mode: current.mode,
		switches: current.switches,
		decision: verdict,
		source,
		judgement,
		confidence: cached.confidence,
		threshold,
		downgraded,
	});
	if (action.kind === "run") return undefined;
	if (action.kind === "block") {
		notify(ctx, `permissions: Jev said '${cached.verdict}' and no UI is available; blocking`, "warning");
		return { block: true, reason: action.reason };
	}
	const detail = confirmMessage(
		verdict,
		capText(command ?? targetPath ?? event.toolName, current.config.maxCommandChars),
		cached.confidence,
		cached.probabilities,
	);
	const approved = await requestApproval(action.title, detail, event.toolCallId, ctx);
	if (approved) return undefined;
	return { block: true, reason: `Rejected by the user after a Jev '${verdict}' verdict.` };
}

async function resolveAsk(
	title: string,
	reason: string,
	toolCallId: string,
	ctx: ExtensionContext,
	current: State,
): Promise<ToolCallEventResult | undefined> {
	if (current.switches.yolo) return undefined;
	if (!ctx.hasUI && !isSubagentEnv(process.env)) {
		return { block: true, reason: `${reason} No interactive UI is available to approve it.` };
	}
	const approved = await requestApproval(title, reason, toolCallId, ctx);
	if (approved) return undefined;
	return { block: true, reason: `Rejected by the user: ${reason}` };
}

// --- prompt sanitization --------------------------------------------------

/**
 * Tools denied for the current mode. Only effectful MCP is denied outright today;
 * `write` and `edit` stay listed in Plan mode because pi-plan-build still permits the
 * plan Markdown, and shell tools stay listed because reads are allowed there.
 */
function deniedTools(current: State): string[] {
	return current.mode === "plan" && current.config.modes.plan.mutations !== "allow" ? ["mcp"] : [];
}

function isDenied(name: string, denied: string[]): boolean {
	return denied.some((entry) => name === entry || name.startsWith(`${entry}_`) || name.startsWith(`${entry}__`));
}

function sanitizePrompt(event: { systemPromptOptions: Record<string, unknown> }, denied: string[]): void {
	const options = event.systemPromptOptions as {
		selectedTools?: string[];
		toolSnippets?: Record<string, string>;
		toolGuidelines?: Record<string, string[]>;
		promptGuidelines?: string[];
	};
	if (Array.isArray(options.selectedTools)) {
		options.selectedTools = options.selectedTools.filter((name) => !isDenied(name, denied));
	}
	for (const key of Object.keys(options.toolSnippets ?? {})) {
		if (isDenied(key, denied)) delete options.toolSnippets?.[key];
	}
	for (const key of Object.keys(options.toolGuidelines ?? {})) {
		if (isDenied(key, denied)) delete options.toolGuidelines?.[key];
	}
	if (Array.isArray(options.promptGuidelines)) {
		options.promptGuidelines = options.promptGuidelines.filter(
			(guideline) => !denied.some((entry) => new RegExp(`\\b${entry}\\b`).test(guideline)),
		);
	}
}

// --- extension ------------------------------------------------------------

function statusLine(current: State): string {
	const combination = `jev=${current.switches.jev ? "on" : "off"} yolo=${current.switches.yolo ? "on" : "off"}`;
	const effect = current.switches.yolo
		? "no gating at all, hard blocks included"
		: current.switches.jev
			? "deterministic rules, then Jev; ask prompts"
			: "deterministic rules only, no classifier call";
	return [
		`permissions: enabled=${current.config.enabled ? "yes" : "no"}`,
		`mode=${current.mode}`,
		combination,
		`(${effect})`,
		`threshold=${current.config.jev.confidenceThreshold}`,
		`model=${current.config.jev.model.provider}/${current.config.jev.model.id}`,
		`calls=${current.counters.total}`,
		`breaker=${current.breaker.tripped ? "open" : "closed"}`,
		`config=${current.configStatus}`,
		`last=${current.lastDecision}`,
	].join("  ");
}

export default function permissionsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const current = resetState(ctx, pi);
		warnConfigOnce(ctx, current);
		startForwardingWatcher(ctx);
		installArgumentCompletions(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const current = ensureState(ctx, pi);
		current.mode = readMode(ctx, pi);
		current.leafId = ctx.sessionManager.getLeafId();
		const denied = deniedTools(current);
		if (denied.length > 0) {
			sanitizePrompt(event as unknown as { systemPromptOptions: Record<string, unknown> }, denied);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		return await gate({ toolName: event.toolName, toolCallId: event.toolCallId, input: event.input as Record<string, unknown> }, ctx, pi);
	});

	// Attach the classifier's usage to the tool result so it counts toward the
	// session cost. details and structuredContent are passed through because a
	// returned hook result replaces them.
	pi.on("tool_result", (event) => {
		const current = state;
		if (current === undefined) return;
		const usage = current.pendingUsage.get(event.toolCallId);
		if (usage === undefined) return;
		current.pendingUsage.delete(event.toolCallId);
		return {
			details: event.details,
			structuredContent: event.structuredContent,
			usage: addUsage(event.usage as UsageTotals | undefined, usage),
		};
	});

	pi.registerCommand("permissions", {
		description: "Inspect or control the permissions policy",
		getArgumentCompletions: (prefix) => permissionCompletions(prefix),
		handler: async (args, ctx) => {
			const current = ensureState(ctx, pi);
			// The composer can change the mode without a turn boundary, so read it live
			// rather than using whatever `before_agent_start` last cached.
			refreshMode(ctx, pi, current);
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const sub = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

			switch (sub) {
				case "":
				case "status": {
					notify(ctx, statusLine(current), "info");
					notify(ctx, formatJevCounters(current.counters), "info");
					return;
				}
				case "jev":
				case "yolo": {
					const mode = rest.toLowerCase();
					const next = mode === "on" ? true : mode === "off" ? false : !current.switches[sub];
					current.switches[sub] = next;
					syncStatus(ctx, current);
					notify(
						ctx,
						`permissions: ${sub} ${next ? "on" : "off"} — ${statusLine(current)}`,
						next && sub === "yolo" ? "warning" : "info",
					);
					return;
				}
				case "mode": {
					notify(ctx, `permissions: mode=${current.mode} (read from pi-plan-build state)`, "info");
					return;
				}
				case "threshold": {
					// Session-scoped: the in-memory config changes and nothing is written, so
					// `reload` restores the file's value.
					if (rest === "") {
						notify(ctx, `permissions: threshold=${current.config.jev.confidenceThreshold} (session)`, "info");
						return;
					}
					const value = parseThreshold(rest);
					if (value === undefined) {
						notify(
							ctx,
							`permissions: '${rest}' is not a confidence threshold in 0..1; keeping ${current.config.jev.confidenceThreshold}`,
							"warning",
						);
						return;
					}
					current.config = { ...current.config, jev: { ...current.config.jev, confidenceThreshold: value } };
					syncStatus(ctx, current);
					notify(ctx, `permissions: threshold=${value} for this session (not saved)`, "info");
					return;
				}
				case "check": {
					if (rest === "") {
						notify(ctx, "permissions: usage: /permissions check <tool> <command-or-path>", "warning");
						return;
					}
					const split = rest.indexOf(" ");
					const toolName = (split === -1 ? rest : rest.slice(0, split)).toLowerCase();
					// Quoted, because a command with spaces has to be.
					const value = stripSurroundingQuotes(split === -1 ? "" : rest.slice(split + 1));
					const command = isShellTool(toolName) ? value : undefined;
					const targetPath =
						toolCategory(toolName) === "read" || toolName === "write" || toolName === "edit" ? value : undefined;
					const decision: Decision = resolveDeterministic({
						toolName,
						mode: current.mode,
						switches: current.switches,
						policy: current.config,
						cwd: ctx.cwd,
						command,
						targetPath,
					});
					// A check is a faithful trace: it consults the classifier only when the pipeline
					// would, so one line always says what would actually happen.
					if (decision.kind !== "classify") {
						notify(
							ctx,
							describeCheckDecision({
								toolName,
								decision,
								gateEnabled: current.config.enabled,
								yolo: current.switches.yolo,
							}),
							decision.kind === "allow" ? "info" : "warning",
						);
						return;
					}
					const outcome = await classify(
						buildJevPayload({
							toolName,
							mode: current.mode,
							cwd: ctx.cwd,
							command,
							targetPath,
							preview: value,
							intent: current.intent,
							environment: current.config.rules.environment,
							maxCommandChars: current.config.maxCommandChars,
							maxPreviewChars: current.config.maxPreviewChars,
						}),
						ctx,
						current,
					);
					if (outcome.kind === "failure") {
						notify(ctx, describeCheckFailure(toolName, outcome.error), "warning");
						return;
					}
					notify(
						ctx,
						describeCheckJev({
							toolName,
							verdict: outcome.verdict,
							confidence: outcome.confidence,
							probabilities: outcome.probabilities,
							hasUI: ctx.hasUI,
							threshold: current.config.jev.confidenceThreshold,
						}),
						outcome.verdict === "allow" ? "info" : "warning",
					);
					return;
				}
				case "reload": {
					const reloaded = resetState(ctx, pi);
					warnConfigOnce(ctx, reloaded);
					notify(ctx, `permissions: reloaded — ${statusLine(reloaded)}`, "info");
					return;
				}
				default: {
					notify(ctx, permissionsUsage(), "warning");
				}
			}
		},
	});
}
