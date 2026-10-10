import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Mode } from "./state.ts";

const FILE_MUTATION_TOOLS = new Set(["edit", "write", "replace", "insert", "undo_last_change"]);

export function isFileMutationTool(toolName: string): boolean {
	return FILE_MUTATION_TOOLS.has(toolName);
}

export function targetPathOf(input: unknown): unknown {
	if (!input || typeof input !== "object") return undefined;
	const candidate = input as { path?: unknown; file_path?: unknown; target?: unknown };
	return candidate.path ?? candidate.file_path ?? candidate.target;
}

export function resolveToolPath(cwd: string, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;
	let normalized = inputPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") normalized = os.homedir();
	else if (normalized.startsWith("~/")) normalized = path.join(os.homedir(), normalized.slice(2));
	if (normalized.startsWith("file://")) {
		try { normalized = fileURLToPath(normalized); }
		catch { return undefined; }
	}
	return path.resolve(cwd, normalized);
}

function canonicalPath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Cannot safely resolve dangling path alias: ${file}`);
		const parent = path.dirname(file);
		if (parent === file) throw error;
		return path.join(canonicalPath(parent), path.basename(file));
	}
}

function isWithin(file: string, directory: string): boolean {
	const relative = path.relative(directory, file);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function projectPlanDirectory(cwd: string): string {
	return path.resolve(cwd, ".pi", "plans");
}

export function isProjectPlanPath(cwd: string, inputPath: unknown): boolean {
	const resolved = resolveToolPath(cwd, inputPath);
	if (!resolved) return false;
	const planRoot = path.resolve(projectPlanDirectory(cwd));
	// Protect lexical paths under .pi/plans even when they are dangling symlinks or
	// aliases to another target; also protect outside aliases resolving into the store.
	if (isWithin(path.resolve(resolved), planRoot)) return true;
	try {
		return isWithin(canonicalPath(resolved), canonicalPath(planRoot));
	} catch {
		return false;
	}
}

export function isPlanMarkdownPath(cwd: string, inputPath: unknown): boolean {
	const resolved = resolveToolPath(cwd, inputPath);
	if (!resolved || path.extname(resolved).toLowerCase() !== ".md") return false;
	return isProjectPlanPath(cwd, inputPath);
}

export function isAttachedPlanPath(cwd: string, inputPath: unknown, activePlanId: string | undefined): boolean {
	if (!activePlanId || typeof inputPath !== "string") return false;
	const resolved = resolveToolPath(cwd, inputPath);
	if (!resolved || path.extname(resolved).toLowerCase() !== ".md") return false;
	const expected = path.join(projectPlanDirectory(cwd), `${activePlanId}.md`);
	try {
		return canonicalPath(resolved) === canonicalPath(expected);
	} catch {
		return false;
	}
}

/** File-tool boundary: Plan can edit only its owned attached Markdown; Ask/Build cannot edit plan data. */
export function canMutateFile(
	mode: Mode,
	cwd: string,
	inputPath: unknown,
	activePlanId: string | undefined,
	ownsAttachedPlan: boolean,
): boolean {
	if (mode === "plan") return ownsAttachedPlan && isAttachedPlanPath(cwd, inputPath, activePlanId);
	// A pathless/private editor cannot be proven to target a plan file; that limitation is documented.
	if (inputPath === undefined || inputPath === null || inputPath === "") return true;
	return !isProjectPlanPath(cwd, inputPath);
}
