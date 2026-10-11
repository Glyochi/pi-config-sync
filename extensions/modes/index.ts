import path from "node:path";
import { CustomEditor, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listLearningArtifacts } from "./artifacts.ts";
import { PlanStore, isPlanId } from "./plan-store.ts";
import { buildModeContext } from "./prompts.ts";
import {
	canMutateFile,
	isFileMutationTool,
	isProjectPlanPath,
	resolveToolPath,
	targetPathOf,
} from "./path-guard.ts";
import { blockedPlanShellReason, shouldBlockShellCommand } from "./shell-plan-guard.ts";
import { COMPOSER_STATUS_EVENT, isComposerStatusSnapshot, type ComposerStatusSnapshot } from "../shared/contracts.ts";
import { compactPermissionsLabel, layoutBorderText } from "../shared/composer-status.ts";
import {
	MODE_STATE_ENTRY_TYPE,
	MODE_STATE_EVENT,
	MODE_STATE_VERSION,
	latestModeState,
	makeModeStateSnapshot,
	nextMode,
	summarizePlanMarkdown,
	shouldToggleModeOnTab,
	type ArtifactReference,
	type Mode,
	type ModeStateSnapshot,
	type PlanStateView,
} from "./state.ts";

const CONTEXT_TYPE = "modes-context";
const PLAN_INSPECTION_ENTRY_TYPE = "modes-plan-inspection";
const MANAGED_TOOLS = new Set(["plan_create", "plan_status"]);
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
const PLAN_CREATE_DESCRIPTION = "In Plan mode only, create a project-local saved plan after the user requests a formal plan. Returns the canonical `.pi/plans/<id>.md` path. Then write a concise Goal/Scope/Verification/Implementation Steps document there. Do not use for ordinary research or discussion.";
const PLAN_STATUS_DESCRIPTION = "In Build mode, mark the attached owned plan completed after its work and required checks pass, or blocked with a concise reason. This updates structured plan state only; it never edits plan Markdown. Do not infer completion from idleness.";
const FILE_MUTATION_TOOLS = new Set(["edit", "write", "replace", "insert", "undo_last_change"]);

let selectedMode: Mode = "build";
let activePlanId: string | undefined;
let currentContext: ExtensionContext | undefined;
let lastPersistedMode = "";
let installedEditor: EditorFactory | undefined;
let requestComposerRender: (() => void) | undefined;
let composerStatus: ComposerStatusSnapshot | undefined;
const pendingComposerStatus = new Map<string, ComposerStatusSnapshot>();
let editorConflictNotified = false;

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() || "ephemeral";
}

function handleComposerStatus(payload: unknown): void {
	if (!isComposerStatusSnapshot(payload)) return;
	const ctx = currentContext;
	if (ctx && sessionId(ctx) === payload.sessionId && ctx.cwd === payload.cwd) {
		if (!composerStatus || payload.updatedAt >= composerStatus.updatedAt) {
			composerStatus = payload;
			requestComposerRender?.();
		}
		return;
	}
	pendingComposerStatus.delete(payload.sessionId);
	pendingComposerStatus.set(payload.sessionId, payload);
	while (pendingComposerStatus.size > 4) {
		const oldest = pendingComposerStatus.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		pendingComposerStatus.delete(oldest);
	}
}

function restoreComposerStatus(ctx: ExtensionContext): void {
	const id = sessionId(ctx);
	const pending = pendingComposerStatus.get(id);
	if (pending) composerStatus = pending;
	else if (composerStatus?.sessionId !== id || ctx.cwd !== composerStatus.cwd) composerStatus = undefined;
	pendingComposerStatus.clear();
}

function planStore(ctx: ExtensionContext): PlanStore {
	return new PlanStore(ctx.cwd);
}

function serializedModeState(): string {
	return JSON.stringify({ version: MODE_STATE_VERSION, mode: selectedMode, ...(activePlanId ? { activePlanId } : {}) });
}

function persistModeState(pi: ExtensionAPI): void {
	const serialized = serializedModeState();
	if (serialized === lastPersistedMode) return;
	pi.appendEntry(MODE_STATE_ENTRY_TYPE, JSON.parse(serialized));
	lastPersistedMode = serialized;
}

function planView(ctx: ExtensionContext, id: string): { view: PlanStateView; markdown: string } | undefined {
	try {
		const store = planStore(ctx);
		const record = store.get(id);
		if (!record) return undefined;
		let markdown = "";
		try { markdown = store.readMarkdown(id); }
		catch { /* The view still exposes a missing/unavailable plan path. */ }
		const summary = markdown ? summarizePlanMarkdown(markdown) : { steps: [] as PlanStateView["steps"] };
		return {
			view: {
				id: record.id,
				title: summary.title || record.title,
				status: record.status,
				path: record.path,
				ownerSessionId: record.ownerSessionId,
				ownedByCurrentSession: record.ownerSessionId === sessionId(ctx),
				...(summary.goalSummary ? { goalSummary: summary.goalSummary } : {}),
				...(record.blockedReason ? { blockedReason: record.blockedReason } : {}),
				steps: summary.steps,
			},
			markdown,
		};
	} catch {
		return undefined;
	}
}

function stateSnapshot(ctx: ExtensionContext, kind: ModeStateSnapshot["kind"]): ModeStateSnapshot {
	const attached = activePlanId ? planView(ctx, activePlanId) : undefined;
	const artifacts: ArtifactReference[] = listLearningArtifacts(ctx.cwd);
	return makeModeStateSnapshot({
		kind,
		sessionId: sessionId(ctx),
		cwd: ctx.cwd,
		mode: selectedMode,
		...(attached ? { activePlan: attached.view } : {}),
		artifacts,
		updatedAt: Date.now(),
	});
}

function publishState(pi: ExtensionAPI, ctx = currentContext, kind: ModeStateSnapshot["kind"] = "changed"): void {
	if (!ctx) return;
	let snapshot: ModeStateSnapshot;
	try { snapshot = stateSnapshot(ctx, kind); }
	catch { return; }
	try { pi.events.emit(MODE_STATE_EVENT, snapshot); }
	catch { /* State persistence remains authoritative if a UI listener fails. */ }
}

function restoreSession(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom").map((entry) => {
		const custom = entry as { customType?: string; data?: unknown };
		return { customType: custom.customType, data: custom.data };
	});
	const restored = latestModeState(entries);
	selectedMode = restored?.mode ?? "build";
	activePlanId = restored?.activePlanId;
	if (activePlanId) {
		try { if (!planStore(ctx).get(activePlanId)) activePlanId = undefined; }
		catch { /* Preserve the attachment; plan-state errors fail closed on mutation. */ }
	}
	lastPersistedMode = restored ? serializedModeState() : "";
}

function activeOwnedPlan(ctx: ExtensionContext) {
	if (!activePlanId) return undefined;
	const record = planStore(ctx).get(activePlanId);
	if (!record || record.ownerSessionId !== sessionId(ctx)) return undefined;
	return record;
}

function applyTools(pi: ExtensionAPI, ctx = currentContext): void {
	const active = pi.getActiveTools();
	const base = active.filter((name) => !MANAGED_TOOLS.has(name));
	let plan: ReturnType<PlanStore["get"]>;
	try { plan = ctx && activePlanId ? planStore(ctx).get(activePlanId) : undefined; }
	catch { plan = undefined; }
	const currentOwner = !!(ctx && plan && plan.ownerSessionId === sessionId(ctx));
	const modeTools = [
		...(selectedMode === "plan" && plan?.status !== "open" ? ["plan_create"] : []),
		...(selectedMode === "build" && plan?.status === "open" && currentOwner ? ["plan_status"] : []),
	];
	const next = [...new Set([...base, ...modeTools])];
	if (active.length !== next.length || active.some((name, index) => name !== next[index])) pi.setActiveTools(next);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try { ctx.ui.notify(message, level); }
	catch { /* No UI is available; command/tool results still carry the message. */ }
}

async function setMode(pi: ExtensionAPI, mode: Mode, ctx: ExtensionContext): Promise<boolean> {
	if (!ctx.isIdle()) {
		notify(ctx, "Wait for the agent to finish before switching modes.", "warning");
		return false;
	}
	if (selectedMode === mode) return true;
	selectedMode = mode;
	persistModeState(pi);
	applyTools(pi, ctx);
	installTabEditor(pi, ctx);
	publishState(pi, ctx);
	notify(ctx, `${mode[0]!.toUpperCase()}${mode.slice(1)} mode selected.`, "info");
	return true;
}

function installTabEditor(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const current = ctx.ui.getEditorComponent();
	if (current && current !== installedEditor) {
		if (!editorConflictNotified) {
			editorConflictNotified = true;
			notify(ctx, "Another extension owns Pi's editor; Tab mode switching and inline status are unavailable here. Use /ask, /plan, or /build.", "warning");
		}
		return;
	}
	if (installedEditor && current === installedEditor) {
		requestComposerRender?.();
		return;
	}
	class ModeSwitchEditor extends CustomEditor {
		protected override renderTopBorder(width: number, hiddenLineCount: number): string {
			const summary = composerStatus?.planSummary;
			if (!summary) return super.renderTopBorder(width, hiddenLineCount);
			const overflow = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : "";
			const layout = layoutBorderText(
				summary,
				width,
				"center",
				visibleWidth,
				(text, maxWidth, ellipsis) => truncateToWidth(text, maxWidth, ellipsis),
				overflow,
			);
			const header = layout.label ? currentContext?.ui.theme.fg("accent", layout.label) ?? layout.label : "";
			return `${this.borderColor(layout.leftBorder)}${header}${this.borderColor(layout.rightBorder + layout.overflowLabel)}`;
		}

		protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
			const theme = currentContext?.ui.theme;
			const modeColor = selectedMode === "plan" ? "warning" : selectedMode === "build" ? "thinkingLow" : "accent";
			const mode = theme ? theme.fg(modeColor, theme.bold(selectedMode)) : selectedMode;
			const permission = compactPermissionsLabel(composerStatus?.permissions, (kind, text) =>
				theme ? theme.fg(kind === "jev" ? "warning" : "error", text) : text,
			);
			const label = `${mode} · ${permission}`;
			const overflow = hiddenLineCount > 0 ? ` ↓ ${hiddenLineCount} more ` : "";
			const layout = layoutBorderText(
				label,
				width,
				"left",
				visibleWidth,
				(text, maxWidth, ellipsis) => truncateToWidth(text, maxWidth, ellipsis),
				overflow,
			);
			return `${this.borderColor(layout.leftBorder)}${layout.label}${this.borderColor(layout.rightBorder + layout.overflowLabel)}`;
		}

		override handleInput(data: string): void {
			if (matchesKey(data, "tab") && shouldToggleModeOnTab(this.isShowingAutocomplete())) {
				const liveContext = currentContext;
				if (liveContext) void setMode(pi, nextMode(selectedMode), liveContext);
				return;
			}
			super.handleInput(data);
		}
	}
	const factory: EditorFactory = (tui, theme, keybindings) => {
		requestComposerRender = () => tui.requestRender();
		return new ModeSwitchEditor(tui, theme, keybindings);
	};
	installedEditor = factory;
	ctx.ui.setEditorComponent(factory);
}

async function createPlan(pi: ExtensionAPI, title: string, ctx: ExtensionContext) {
	if (selectedMode !== "plan") throw new Error("Saved plans can only be created in Plan mode; switch with /plan first");
	const current = activePlanId ? planStore(ctx).get(activePlanId) : undefined;
	if (current?.status === "open") throw new Error("A plan is already attached to this session; complete or block it before starting another");
	const record = await planStore(ctx).create(title, sessionId(ctx));
	activePlanId = record.id;
	persistModeState(pi);
	applyTools(pi, ctx);
	publishState(pi, ctx);
	return record;
}

async function updatePlanStatus(pi: ExtensionAPI, id: string, status: "completed" | "blocked", reason: string | undefined, ctx: ExtensionContext) {
	const record = await planStore(ctx).setStatus(id, sessionId(ctx), status, reason);
	publishState(pi, ctx);
	applyTools(pi, ctx);
	return record;
}

function displayPlanInspection(pi: ExtensionAPI, ctx: ExtensionContext, markdown: string): void {
	if (ctx.mode === "tui") {
		// Session custom entries render for the user but are excluded from model context.
		pi.appendEntry(PLAN_INSPECTION_ENTRY_TYPE, { markdown });
	} else if (ctx.hasUI) {
		// RPC supports notifications but not custom TUI entry renderers.
		notify(ctx, markdown, "info");
	}
}

function showPlan(pi: ExtensionAPI, ctx: ExtensionContext, id?: string): void {
	const target = id ?? activePlanId;
	if (!target) {
		notify(ctx, "No plan is attached. Use /plan list or /plan resume <id>.", "warning");
		return;
	}
	try {
		const store = planStore(ctx);
		const record = store.get(target);
		if (!record) throw new Error(`Plan not found: ${target}`);
		const markdown = store.readMarkdown(target);
		const summary = summarizePlanMarkdown(markdown);
		const title = summary.title || record.title;
		const details = `# ${record.id} · ${title}\n\n**Plan status:** ${record.status}${record.blockedReason ? `\n\n**Blocked:** ${record.blockedReason}` : ""}\n**Owner session:** ${record.ownerSessionId}\n**File:** ${path.join(ctx.cwd, ".pi", "plans", `${record.id}.md`)}`;
		const workItems = summary.steps.map((step) => `${step.order}. ${step.id} — ${step.title} — ${step.status}`).join(String.fromCharCode(10));
		const workItemSection = workItems ? ["## Work items", workItems].join(String.fromCharCode(10)) : "";
		const report = [details, workItemSection, "---", markdown].filter(Boolean).join(String.fromCharCode(10) + String.fromCharCode(10));
		displayPlanInspection(pi, ctx, report);
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "warning");
	}
}

function listPlans(ctx: ExtensionContext): string {
	const store = planStore(ctx);
	const plans = store.list();
	if (!plans.length) return "# Plans in this project\n\nNo plans found. Use /plan new <title> to start one.";
	const rows = plans.map((plan) => {
		let title = plan.title;
		try { title = summarizePlanMarkdown(store.readMarkdown(plan.id)).title || title; }
		catch { /* Keep stored metadata when a plan file is unavailable. */ }
		const owner = plan.ownerSessionId === sessionId(ctx) ? "owned here" : "owned by another session";
		return `- **${plan.id} · ${title}** — ${plan.status} (${owner})`;
	});
	return ["# Plans in this project", "", ...rows].join("\n");
}

function resolvePlanPathFromInput(ctx: ExtensionContext, input: unknown): string | undefined {
	return resolveToolPath(ctx.cwd, targetPathOf(input));
}

function isMcpTool(name: string): boolean {
	return name === "mcp" || name.startsWith("mcp_") || name.startsWith("mcp__");
}

function stringifiesPlanPath(value: unknown): boolean {
	try { return /\.pi[\\/]plans[\\/]/i.test(JSON.stringify(value)); }
	catch { return false; }
}

function readOnlyMcp(pi: ExtensionAPI, toolName: string): boolean {
	return pi.getAllTools().find((tool) => tool.name === toolName)?.annotations?.readOnlyHint === true;
}

function planOwnershipIsCurrent(ctx: ExtensionContext): boolean {
	return !!activePlanId && !!activeOwnedPlan(ctx);
}

function restore(ctx: ExtensionContext, pi: ExtensionAPI): void {
	currentContext = ctx;
	restoreSession(ctx);
	restoreComposerStatus(ctx);
	persistModeState(pi);
	applyTools(pi, ctx);
	installTabEditor(pi, ctx);
	publishState(pi, ctx, "snapshot");
}

export default function modesExtension(pi: ExtensionAPI): void {
	const unsubscribeComposerStatus = pi.events.on(COMPOSER_STATUS_EVENT, handleComposerStatus);
	const renderPlanInspection = (entry: { data?: { markdown?: string } }) =>
		new Markdown(entry.data?.markdown ?? "Plan inspection unavailable", 0, 0, getMarkdownTheme());
	pi.registerEntryRenderer<{ markdown: string }>(PLAN_INSPECTION_ENTRY_TYPE, renderPlanInspection);

	pi.registerTool({
		name: "plan_create",
		label: "Create Saved Plan",
		description: PLAN_CREATE_DESCRIPTION,
		promptSnippet: "Create a canonical project-local plan file in Plan mode",
		promptGuidelines: ["Call plan_create only when the user requests a formal saved plan. After it returns, write the complete Markdown plan to its returned path; do not use it for Ask-mode research or ordinary discussion."],
		parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 160, description: "Short title for the requested saved plan" }) }),
		defaultActive: false,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Plan creation cancelled");
			const record = await createPlan(pi, params.title, ctx);
			return {
				content: [{ type: "text", text: `Plan ${record.id} created at ${path.join(ctx.cwd, ".pi", "plans", `${record.id}.md`)}. Write the complete plan there.` }],
				details: { id: record.id, title: record.title, status: record.status, path: record.path },
			};
		},
	});

	pi.registerTool({
		name: "plan_status",
		label: "Update Plan Status",
		description: PLAN_STATUS_DESCRIPTION,
		promptSnippet: "Record completion or a blocker for the attached plan",
		promptGuidelines: ["After required checks pass, record completed in the same Build turn. If blocked, record blocked with the concrete reason. Do not create hidden follow-up turns or edit plan Markdown to change status."],
		parameters: Type.Object({
			planId: Type.String({ minLength: 1 }),
			status: Type.String({ enum: ["completed", "blocked"] }),
			reason: Type.Optional(Type.String({ maxLength: 1000, description: "Required when status is blocked" })),
		}),
		defaultActive: false,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Plan status update cancelled");
			if (selectedMode !== "build") throw new Error("Plan status can only be updated in Build mode");
			if (params.planId !== activePlanId) throw new Error("The requested plan is not attached; resume it before changing status");
			if (!planOwnershipIsCurrent(ctx)) throw new Error("This session no longer owns the plan; resume it before changing status");
			const status = params.status as "completed" | "blocked";
			const record = await updatePlanStatus(pi, params.planId, status, params.reason, ctx);
			return { content: [{ type: "text", text: `Plan ${record.id} marked ${record.status}${record.blockedReason ? `: ${record.blockedReason}` : ""}.` }], details: { id: record.id, status: record.status, ...(record.blockedReason ? { reason: record.blockedReason } : {}) } };
		},
	});

	pi.registerCommand("ask", {
		description: "Switch to Ask mode for learning, research, and visualizations",
		handler: async (_args, ctx) => { await setMode(pi, "ask", ctx); },
	});
	pi.registerCommand("build", {
		description: "Switch to Build mode",
		handler: async (_args, ctx) => { await setMode(pi, "build", ctx); },
	});
	pi.registerCommand("plan", {
		description: "Plan mode and lightweight plan controls: new, list, show, resume, done, blocked",
		getArgumentCompletions: (prefix) => ["new", "list", "show", "resume", "done", "blocked"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) { await setMode(pi, "plan", ctx); return; }
			const [action, ...rest] = trimmed.split(/\s+/);
			const value = rest.join(" ").trim();
			if (!ctx.isIdle()) { notify(ctx, "Wait for the agent to finish before changing plan state.", "warning"); return; }
			try {
				switch (action) {
					case "new": {
						if (!(await setMode(pi, "plan", ctx))) return;
						const record = await createPlan(pi, value || "Untitled plan", ctx);
						notify(ctx, `Plan created: ${record.id} · ${path.join(ctx.cwd, ".pi", "plans", `${record.id}.md`)}`, "info");
						return;
					}
					case "list":
						displayPlanInspection(pi, ctx, listPlans(ctx));
						return;
					case "show":
						showPlan(pi, ctx, value || undefined);
						return;
					case "resume": {
						if (!isPlanId(value)) throw new Error("Usage: /plan resume <plan-id>");
						const record = await planStore(ctx).claim(value, sessionId(ctx));
						activePlanId = record.id;
						persistModeState(pi);
						applyTools(pi, ctx);
						publishState(pi, ctx);
						notify(ctx, `Plan ${record.id} resumed in ${selectedMode} mode; this session now owns it. No work has been started.`, "info");
						return;
					}
					case "done":
					case "blocked": {
						if (!activePlanId) throw new Error("No plan is attached");
						const status = action === "done" ? "completed" : "blocked";
						if (status === "blocked" && !value) throw new Error("Usage: /plan blocked <reason>");
						const record = await updatePlanStatus(pi, activePlanId, status, status === "blocked" ? value : undefined, ctx);
						notify(ctx, `Plan ${record.id} marked ${record.status}${record.blockedReason ? `: ${record.blockedReason}` : ""}.`, "info");
						return;
					}
					default:
						notify(ctx, "Usage: /plan [new <title>|list|show [id]|resume <id>|done|blocked <reason>]", "warning");
				}
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => restore(ctx, pi));
	pi.on("session_tree", (_event, ctx) => restore(ctx, pi));
	pi.on("session_compact", (_event, ctx) => { currentContext = ctx; publishState(pi, ctx, "snapshot"); });
	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeComposerStatus();
		if (currentContext === ctx) {
			currentContext = undefined;
			composerStatus = undefined;
			requestComposerRender = undefined;
			installedEditor = undefined;
		}
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === CONTEXT_TYPE));
		const ctx = currentContext;
		if (!ctx) return { messages };
		let plan = activePlanId ? planView(ctx, activePlanId) : undefined;
		const stale = !!plan && plan.view.status !== "completed" && !plan.view.ownedByCurrentSession;
		if (plan?.view.status === "completed") plan = undefined;
		const content = buildModeContext(selectedMode, plan, stale);
		const anchor = messages.findLastIndex((message) => message.role === "user");
		const insertAt = Math.max(0, anchor);
		messages.splice(insertAt, 0, {
			role: "custom",
			customType: CONTEXT_TYPE,
			content: `Background operational context, not a new user request. Do not acknowledge this block; follow the actual user request within these constraints.\n\n${content}`,
			display: false,
			timestamp: messages[insertAt]?.timestamp ?? Date.now(),
		} as (typeof messages)[number]);
		return { messages };
	});

	pi.on("tool_call", async (event, ctx) => {
		const mode = selectedMode;
		if (isFileMutationTool(event.toolName)) {
			const rawTarget = targetPathOf(event.input);
			const target = resolvePlanPathFromInput(ctx, event.input);
			let ownsOpenPlan = false;
			try { ownsOpenPlan = activeOwnedPlan(ctx)?.status === "open"; }
			catch (error) { return { block: true, reason: `Plan state is unavailable; refusing file mutation: ${String(error)}` }; }
			if (!canMutateFile(mode, ctx.cwd, target ?? rawTarget, activePlanId, ownsOpenPlan)) {
				return { block: true, reason: mode === "plan"
					? `Plan mode may edit only its attached open plan Markdown: ${activePlanId ?? "no plan attached"}.`
					: "Ask/Build cannot edit extension-owned files under .pi/plans/. Use Plan mode for the attached plan Markdown and plan tools for status." };
			}
		}
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string" && shouldBlockShellCommand(mode, command)) {
				return { block: true, reason: blockedPlanShellReason(command, mode) };
			}
		}
		if (isMcpTool(event.toolName) && (mode === "plan" || (stringifiesPlanPath(event.input) && !readOnlyMcp(pi, event.toolName)))) {
			return { block: true, reason: mode === "plan"
				? "Plan mode blocks effectful MCP calls. Use local read tools for exploration."
				: "MCP calls with a detectable .pi/plans/ target are blocked unless the tool declares a read-only annotation; opaque MCP tools without a visible target cannot be contained by this guard." };
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		const inputPath = resolvePlanPathFromInput(ctx, event.input);
		const relevantPlanWrite = isFileMutationTool(event.toolName) && inputPath !== undefined && isProjectPlanPath(ctx.cwd, inputPath);
		const askToolsRoot = path.resolve(ctx.cwd, "ask_tools");
		const relevantArtifactWrite = isFileMutationTool(event.toolName) && inputPath !== undefined && (() => {
			const resolved = path.resolve(ctx.cwd, inputPath);
			const relative = path.relative(askToolsRoot, resolved);
			return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		})();
		const command = (event.input as { command?: unknown } | undefined)?.command;
		const relevantShellWrite = (event.toolName === "bash" || event.toolName === "powershell") && typeof command === "string" && /ask_tools[\\/]/i.test(command);
		if (relevantPlanWrite || relevantArtifactWrite || relevantShellWrite) publishState(pi, ctx, "changed");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (installedEditor && ctx.ui.getEditorComponent() === installedEditor) ctx.ui.setEditorComponent(undefined);
		installedEditor = undefined;
		editorConflictNotified = false;
		currentContext = undefined;
	});
}
