/**
 * Read-only bash filter.
 *
 * When the active tool set has no file-mutation tools (`write`/`edit`), the
 * session is treated as read-only and only read-only bash commands are allowed.
 * In normal edit-capable sessions bash is left untouched.
 *
 * This extension only blocks tool calls; it never calls setActiveTools(), so it
 * does not conflict with mode extensions such as pi-modes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_COMMANDS = [
	"ls", "cat", "bat", "head", "tail", "wc", "grep", "rg", "find", "fd", "tree",
	"pwd", "which", "type", "file", "stat", "du", "df", "env", "printenv",
	"jq", "sort", "uniq", "cut", "tr", "column", "less", "more", "man", "date",
	"git status", "git log", "git diff", "git show", "git branch", "git remote",
	"git describe", "git rev-parse", "git ls-files", "git blame", "git config --get",
];

// Shell constructs that could chain or redirect into a mutation.
const UNSAFE = /[;&|><`]|\$\(|\n/;

function isReadOnlyCommand(command: string): boolean {
	const cmd = command.trim();
	if (UNSAFE.test(cmd)) return false;
	return READ_ONLY_COMMANDS.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `));
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;

		// Read-only session = file-mutation tools are not active.
		const active = new Set(pi.getActiveTools());
		const readOnlySession = !(active.has("write") && active.has("edit"));
		if (!readOnlySession) return;

		if (!isReadOnlyCommand(event.input.command)) {
			return {
				block: true,
				reason: `Read-only session: blocked non-read-only command: ${event.input.command}`,
			};
		}
	});
}
