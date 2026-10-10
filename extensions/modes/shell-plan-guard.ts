import type { Mode } from "./state.ts";

const READ_ONLY_PREFIXES = [
	"ls", "cat", "bat", "head", "tail", "wc", "grep", "rg", "find", "fd", "tree",
	"pwd", "which", "type", "file", "stat", "du", "df", "env", "printenv", "jq",
	"sort", "uniq", "cut", "tr", "column", "less", "more", "man", "date",
	"git status", "git log", "git diff", "git show", "git branch", "git remote", "git describe",
	"git rev-parse", "git ls-files", "git blame", "git config --get", "cd",
];
const OPAQUE_OR_REDIRECT = /[<>`]|\$\(|\n/;
const MUTATING_FORMS = /-delete|-exec|-ok|-fprint|--delete|\bsort\s+-\S*o|\bdate\s+-\S*s|\benv\s+\S+=|\bgit\s+branch\s+-\S*[dDmMu]|\bgit\s+remote\s+(add|remove|rm|rename|set-url|set-head|prune|update)/;

function isReadOnlySegment(segment: string): boolean {
	const value = segment.trim();
	if (!value) return false;
	return READ_ONLY_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix} `));
}

/** Conservative: shell commands that mention the protected plan directory must be read-only. */
export function commandReferencesProjectPlans(command: string): boolean {
	return typeof command === "string" && /\.pi[\\/]plans[\\/]/i.test(command);
}

export function isClearlyReadOnlyCommand(command: string): boolean {
	if (typeof command !== "string" || !command.trim() || OPAQUE_OR_REDIRECT.test(command) || MUTATING_FORMS.test(command)) return false;
	const segments = command.split(/;|&&|\|\||\||&/).map((part) => part.trim()).filter(Boolean);
	return segments.length > 0 && segments.every(isReadOnlySegment);
}

export function shouldBlockShellCommand(mode: Mode, command: string): boolean {
	if (mode === "plan") return !isClearlyReadOnlyCommand(command);
	return commandReferencesProjectPlans(command) && !isClearlyReadOnlyCommand(command);
}

export function blockedPlanShellReason(command: string, mode: "ask" | "plan" | "build"): string {
	const guidance = mode === "plan"
		? "Plan mode permits only clearly read-only shell commands; use a path-bearing editor only for the attached plan Markdown."
		: "Ask/Build shell commands that target .pi/plans are blocked; use Plan mode for the attached plan Markdown and plan tools for status.";
	return `${guidance} Blocked command: ${command.slice(0, 240)}`;
}
