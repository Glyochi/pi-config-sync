/**
 * Read-only bash for read-only modes (e.g. pi-modes Ask/Review).
 *
 * A "read-only session" is one where the file-mutation tools (`write`/`edit`)
 * are not active. In that case this extension:
 *   1. re-adds `bash` so read-only lookups are possible, and
 *   2. blocks any bash command that is not clearly read-only.
 *
 * Normal edit-capable sessions are left untouched. The extension is
 * self-contained and synced through pi-config-sync, so it survives package
 * updates and works on every machine without patching pi-modes.
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

function isReadOnlySession(active: readonly string[]): boolean {
	return !(active.includes("write") && active.includes("edit"));
}

export default function (pi: ExtensionAPI) {
	// In read-only modes, make read-only bash available.
	pi.on("before_agent_start", async () => {
		const active = pi.getActiveTools();
		if (!isReadOnlySession(active) || active.includes("bash")) return;
		if (pi.getAllTools().some((tool) => tool.name === "bash")) {
			pi.setActiveTools([...active, "bash"]);
		}
	});

	// Restrict bash to read-only commands in read-only modes.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		if (!isReadOnlySession(pi.getActiveTools())) return;
		if (!isReadOnlyCommand(event.input.command)) {
			return {
				block: true,
				reason: `Read-only session: blocked non-read-only command: ${event.input.command}`,
			};
		}
	});
}
