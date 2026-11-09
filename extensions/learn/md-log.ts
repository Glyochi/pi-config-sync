import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename, extname } from "node:path";
import { branchBlocks, isQuizTool, quizQuestion, type LogBlock } from "./log-format.ts";
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

/** Explicit opt-in, append-only, branch-aware mirror. Existing note prose is never replaced. */
export default function mdLog(pi: ExtensionAPI): void {
	let file: string | undefined;
	let sessionId: string | undefined;
	let paused = false;
	let seen = new Set<string>();
	const marker = (key: string) => createHash("sha256").update(`${sessionId}:${key}`).digest("hex").slice(0, 24);

	function status(ctx: ExtensionContext): void {
		if (ctx.mode === "tui") ctx.ui.setStatus("learn-log", file ? `🗒 ${basename(file)}${paused || isPlan(ctx) ? " (paused)" : ""}` : undefined);
	}

	function restore(ctx: ExtensionContext): void {
		const nextFile = linkedNote(ctx);
		const nextId = ctx.sessionManager.getSessionId();
		if (nextFile === file && nextId === sessionId) return;
		file = nextFile;
		sessionId = nextId;
		paused = false;
		seen = new Set();
		if (file) {
			try {
				file = artifactPath(file, ctx.cwd, getAgentDir());
				if (extname(file).toLowerCase() !== ".md" || !statSync(file).isFile()) throw new Error("Not an existing .md note");
				seen = new Set([...readFileSync(file, "utf8").matchAll(/<!-- pi-learn:([a-f0-9]{24}) -->/g)].map((m) => m[1]));
			} catch (error) {
				paused = true;
				if (ctx.hasUI) ctx.ui.notify(`learn-log paused: ${String(error)}`, "warning");
			}
		}
		status(ctx);
	}

	function append(ctx: ExtensionContext, blocks: LogBlock[]): void {
		restore(ctx);
		status(ctx);
		if (!file || paused || isPlan(ctx)) return;
		const fresh = blocks.map((block) => ({ ...block, id: marker(block.key) })).filter((block) => !seen.has(block.id));
		if (!fresh.length) return;
		let fd: number | undefined;
		try {
			// No O_CREAT: a deleted note must not silently reappear. Refuse a replaced symlink.
			fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
			if (!fstatSync(fd).isFile()) throw new Error("Linked note is no longer a regular file");
			writeSync(fd, fresh.map((block) => `\n\n<!-- pi-learn:${block.id} -->\n${block.text}\n`).join(""));
			for (const block of fresh) seen.add(block.id);
		} catch (error) {
			paused = true;
			if (ctx.hasUI) ctx.ui.notify(`learn-log paused: ${String(error)}. Relink with /learn-log after fixing the file.`, "warning");
			status(ctx);
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	const sync = (ctx: ExtensionContext) => append(ctx, branchBlocks(ctx.sessionManager.getBranch()));
	pi.on("session_start", (_event, ctx) => { restore(ctx); sync(ctx); });
	pi.on("session_tree", (_event, ctx) => { restore(ctx); sync(ctx); });
	// Pi emits message_end before persisting the message. These later boundaries
	// see committed entries, including prose/questions before an interactive wait.
	pi.on("message_end", (_event, ctx) => sync(ctx));
	pi.on("turn_end", (_event, ctx) => sync(ctx));
	pi.on("agent_end", (_event, ctx) => sync(ctx));
	pi.on("tool_execution_start", (_event, ctx) => sync(ctx));
	pi.on("tool_execution_end", (event, ctx) => {
		if (!isQuizTool(event.toolName) && event.toolName !== "ask_user_question") return;
		append(ctx, branchBlocks([{ type: "message", message: { ...event.result, role: "toolResult", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError } }]));
	});
	pi.on("tool_execution_update", (event, ctx) => {
		if (!isQuizTool(event.toolName)) return;
		sync(ctx);
		const block = quizQuestion(event.toolCallId, event.partialResult?.details);
		if (block) append(ctx, [block]);
	});
	pi.on("session_shutdown", () => { file = undefined; sessionId = undefined; paused = false; seen.clear(); });

	pi.registerCommand("learn-log", {
		description: "Append this session to an existing Obsidian .md note, backfilling without overwriting",
		handler: async (args, ctx) => {
			try {
				assertCanMutate(ctx);
				if (!ctx.isIdle()) throw new Error("Wait for the agent to finish before linking.");
				const input = args.trim().replace(/^(["'])(.*)\1$/, "$2");
				if (!input) throw new Error("Usage: /learn-log <existing-note.md>");
				const target = artifactPath(input, ctx.cwd, getAgentDir());
				if (extname(target).toLowerCase() !== ".md" || !statSync(target).isFile()) throw new Error("Choose an existing .md note; learn-log does not create files.");
				// Force marker reconciliation even when retrying the same note after an error.
				file = undefined;
				pi.appendEntry(LOG_ENTRY, { version: 1, file: target });
				sync(ctx);
				if (!paused) ctx.ui.notify(`Linked: ${target}`, "info");
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
	pi.registerCommand("learn-unlog", {
		description: "Stop mirroring this session to the linked note",
		handler: async (_args, ctx) => {
			pi.appendEntry(LOG_ENTRY, { version: 1, file: null });
			restore(ctx);
			ctx.ui.notify("Lesson logging stopped", "info");
		},
	});
}
