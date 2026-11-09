import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import quiz from "./quiz.ts";
import mdLog, { linkedNote } from "./md-log.ts";
import { artifactPath, isPlan } from "./policy.ts";
import { chromePath, chromeSandboxDisabled, findExecutable, MMDC } from "./visual-tools/common.ts";

export default function learn(pi: ExtensionAPI): void {
	quiz(pi);
	mdLog(pi);

	function inspect(ctx: ExtensionContext) {
		const note = linkedNote(ctx);
		let outputDirectory = join(ctx.cwd, "viz");
		let noteError: string | undefined;
		try { outputDirectory = artifactPath(join(note ? dirname(note) : ctx.cwd, "viz"), ctx.cwd, getAgentDir()); }
		catch (error) { noteError = String(error); }
		return {
			teachingSkillPath: join(getAgentDir(), "skills", "learn-teach", "SKILL.md"),
			note: note ?? null,
			outputDirectory: noteError ? null : outputDirectory,
			...(noteError ? { noteError } : {}),
			fileWritesPaused: isPlan(ctx),
			mermaidCliInstalled: existsSync(MMDC),
			chromium: chromePath() ?? null,
			svgRenderer: findExecutable(["rsvg-convert"]) ?? null,
			chromiumSandboxDisabled: chromeSandboxDisabled(),
			questionToolAvailable: pi.getAllTools().some((tool) => tool.name === "ask_user_question"),
		};
	}
	pi.registerTool({
		name: "learn_status", label: "Learn status",
		description: "Inspect the opt-in learning toolkit before a requested lesson: linked Obsidian note, absolute image output directory to pass to makers, and renderer availability. Does not start a lesson or write files.",
		promptSnippet: "Inspect setup and the teaching skill path for an explicitly requested lesson.",
		promptGuidelines: ["If the user explicitly asks for a structured lesson, call learn_status and read teachingSkillPath before teaching. Do not activate the lesson workflow for ordinary coding explanations. /skill:learn-teach is the direct user shortcut."],
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const details = inspect(ctx);
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
		},
	});
	pi.registerCommand("learn-doctor", {
		description: "Check lesson logging, the existing question tool, and Mermaid/SVG dependencies",
		handler: async (_args, ctx) => {
			const state = inspect(ctx);
			const ready = state.mermaidCliInstalled && state.chromium && state.svgRenderer && state.questionToolAvailable;
			ctx.ui.notify(`${JSON.stringify(state, null, 2)}${ready ? "" : "\nInstall missing renderers: bash install_pi_learn.sh --system-deps; then /reload."}`, ready ? "info" : "warning");
		},
	});
}
