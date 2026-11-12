import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lstatSync } from "node:fs";
import { basename, extname } from "node:path";
import { branchBlocks, isQuizTool, quizQuestion, type LogBlock } from "./log-format.ts";
import { appendNotebook, checkpointNotebook, logMarker } from "./note-store.ts";
import { progressPath, SECTION_ENTRY, type Checkpoint, type Section } from "./notebook.ts";
import { artifactPath, assertCanMutate, isPlan } from "./policy.ts";

export const LOG_ENTRY = "learn-md-log";
export function linkedNote(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	let file: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== LOG_ENTRY) continue;
		const data = entry.data as { version?: unknown; file?: unknown } | undefined;
		if (data?.version === 1) file = typeof data.file === "string" ? data.file : undefined;
	}
	return file;
}
const options = (ctx: ExtensionContext) => ({ cwd: ctx.cwd, agentDir: getAgentDir() });

/** Branch-aware chronological mirror. Only explicitly managed navigation may be replaced. */
export default function mdLog(pi: ExtensionAPI): void {
	let file: string | undefined, sessionId: string | undefined;
	let paused = false;
	function status(ctx: ExtensionContext): void {
		if (ctx.mode === "tui") ctx.ui.setStatus("learn-log", file ? `🗒 ${basename(file)}${paused || isPlan(ctx) ? " (paused)" : ""}` : undefined);
	}
	function restore(ctx: ExtensionContext): void {
		const nextFile = linkedNote(ctx), nextId = ctx.sessionManager.getSessionId();
		if (nextFile === file && nextId === sessionId) return;
		file = nextFile; sessionId = nextId; paused = false;
		if (file) {
			try {
				if (extname(file).toLowerCase() !== ".md" || !lstatSync(file).isFile()) throw new Error("Not an existing regular .md note");
				file = artifactPath(file, ctx.cwd, getAgentDir());
			} catch (error) {
				paused = true;
				if (ctx.hasUI) ctx.ui.notify(`learn-log paused: ${String(error)}`, "warning");
			}
		}
		status(ctx);
	}
	function activeContext(ctx: ExtensionContext): Section | undefined {
		const blocks = branchBlocks(ctx.sessionManager.getBranch(), file);
		return blocks.at(-1)?.topicContext;
	}
	async function append(ctx: ExtensionContext, blocks: LogBlock[]): Promise<void> {
		restore(ctx); status(ctx);
		if (!file || paused || isPlan(ctx) || !blocks.length) return;
		const target = file, owner = sessionId!;
		try {
			await withFileMutationQueue(target, async () => {
				if (file !== target || sessionId !== owner || linkedNote(ctx) !== target || paused || isPlan(ctx)) return;
				appendNotebook(target, blocks.map((b) => ({ ...b, id: b.id ?? logMarker(owner, b.key) })), options(ctx));
			});
		} catch (error) {
			if (file !== target || sessionId !== owner) return;
			paused = true;
			if (ctx.hasUI) ctx.ui.notify(`learn-log paused: ${String(error)}. Relink with /learn-log after fixing the file.`, "warning");
			status(ctx);
		}
	}
	const sync = (ctx: ExtensionContext) => { restore(ctx); return append(ctx, branchBlocks(ctx.sessionManager.getBranch(), file)); };
	pi.on("session_start", (_event, ctx) => sync(ctx));
	pi.on("session_tree", (_event, ctx) => sync(ctx));
	// These later boundaries see committed entries, including prose before an interactive wait.
	pi.on("message_end", (_event, ctx) => sync(ctx));
	pi.on("turn_end", (_event, ctx) => sync(ctx));
	pi.on("agent_end", (_event, ctx) => sync(ctx));
	pi.on("tool_execution_start", (_event, ctx) => sync(ctx));
	pi.on("tool_execution_end", (event, ctx) => {
		if (!isQuizTool(event.toolName) && event.toolName !== "ask_user_question") return;
		const context = activeContext(ctx);
		const blocks = branchBlocks([{ type: "message", message: { ...event.result, role: "toolResult", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError } }]);
		return append(ctx, blocks.map((b) => ({ ...b, ...(context ? { topicContext: context } : {}) })));
	});
	pi.on("tool_execution_update", async (event, ctx) => {
		if (!isQuizTool(event.toolName)) return;
		await sync(ctx);
		const block = quizQuestion(event.toolCallId, event.partialResult?.details);
		if (block) await append(ctx, [{ ...block, topicContext: activeContext(ctx) }]);
	});
	pi.on("session_shutdown", () => { file = undefined; sessionId = undefined; paused = false; });

	const topicId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
	pi.registerTool({
		name: "learn_checkpoint", label: "Learn checkpoint", executionMode: "sequential", exposure: "model-only",
		description: "During an explicitly requested lesson with a linked note, maintain its topic TOC and per-note .goal.md roadmap. Read learn_status first for expectedRevision. Initialize only with permission to create the companion. Upsert topics at meaningful milestones; Completed requires evidence of demonstrated understanding. Sections start a topic now, or backfill before an exact pi-learn marker without changing messages. Revisited topics get new chronological sections. Does not infer mastery from quiz scores.",
		promptSnippet: "Maintain topic navigation and the progress roadmap during an explicitly requested, linked lesson.",
		promptGuidelines: ["Use learn_checkpoint only for requested lessons or explicit notebook organization. Obtain consent before initialize:true creates the companion. Read learn_status and the progress note on resume. Update topic statuses at milestones, not every message; never mark Completed merely because content was explained or one answer was correct. Do not call in Plan mode or without a linked note."],
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		parameters: Type.Object({
			expectedRevision: Type.Integer({ minimum: 0, description: "The current progressRevision from learn_status, or 0 for initialization." }),
			initialize: Type.Optional(Type.Boolean({ description: "Explicit consent to create the per-note companion on first use; not a recovery override." })),
			rebuildProgressNote: Type.Optional(Type.Boolean({ description: "Rebuild only the derived progress view from the current revision. If the companion was deleted, obtain the user's permission first. Do not combine with roadmap changes or sections." })),
			goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
			nextStep: Type.Optional(Type.String({ maxLength: 2000 })),
			topics: Type.Optional(Type.Array(Type.Object({ id: topicId, title: Type.String({ minLength: 1, maxLength: 160 }), status: Type.Union([Type.Literal("upcoming"), Type.Literal("current"), Type.Literal("completed"), Type.Literal("review")]), dependsOn: Type.Optional(Type.Array(topicId, { maxItems: 16 })), evidence: Type.Optional(Type.String({ maxLength: 2000 })) }), { maxItems: 64, description: "Upsert only changed/new topics. Omitted topics, prerequisites, and evidence are retained. At most one topic may be Current." })),
			sections: Type.Optional(Type.Array(Type.Object({ topic: Type.Optional(topicId), title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), before: Type.Optional(Type.String({ pattern: "^[a-f0-9]{24}$", description: "For an explicitly requested historical backfill, insert before this existing message marker. Omit to start a new section at the end." })) }), { maxItems: 128, description: "Normally one section at a major topic transition. Use a title without topic for setup or other non-roadmap material." })),
		}),
		async execute(id, params, signal, _onUpdate, ctx) {
			assertCanMutate(ctx);
			await sync(ctx);
			if (!file || paused) throw new Error("Link a writable, existing note with /learn-log first.");
			const target = file, owner = sessionId!;
			return withFileMutationQueue(target, () => withFileMutationQueue(progressPath(target), async () => {
				assertCanMutate(ctx);
				if (signal?.aborted || file !== target || sessionId !== owner || linkedNote(ctx) !== target) throw new Error("Lesson checkpoint cancelled or session changed.");
				const result = checkpointNotebook(target, params as Checkpoint, logMarker(owner, id), options(ctx));
				for (const section of result.sections) pi.appendEntry(SECTION_ENTRY, { version: 1, file: target, section });
				return { content: [{ type: "text", text: `Saved learning progress revision ${result.state.revision}.\nLesson: ${result.note}\nProgress: ${result.progressNote}` }], details: result };
			}));
		},
	});
	pi.registerCommand("learn-log", {
		description: "Append this session to an existing Obsidian .md note, backfilling without replacing conversation",
		handler: async (args, ctx) => {
			try {
				assertCanMutate(ctx);
				if (!ctx.isIdle()) throw new Error("Wait for the agent to finish before linking.");
				const input = args.trim().replace(/^(['"])(.*)\1$/, "$2");
				if (!input) throw new Error("Usage: /learn-log <existing-note.md>");
				const target = artifactPath(input, ctx.cwd, getAgentDir());
				if (extname(target).toLowerCase() !== ".md" || !lstatSync(target).isFile()) throw new Error("Choose an existing .md note; learn-log does not create files.");
				file = undefined;
				pi.appendEntry(LOG_ENTRY, { version: 1, file: target });
				await sync(ctx);
				if (!paused) ctx.ui.notify(`Linked: ${target}`, "info");
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
	pi.registerCommand("learn-unlog", {
		description: "Stop mirroring this session to the linked note",
		handler: async (_args, ctx) => {
			pi.appendEntry(LOG_ENTRY, { version: 1, file: null }); restore(ctx);
			ctx.ui.notify("Lesson logging stopped", "info");
		},
	});
}
