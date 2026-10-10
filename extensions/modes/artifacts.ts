import fs from "node:fs";
import path from "node:path";
import type { ArtifactReference } from "./state.ts";

const MAX_ARTIFACTS = 200;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

/**
 * `ask_tools` is a user-owned learning-artifact folder. The UI contract reports
 * references only; it never sends artifact contents through the event bus.
 */
export function listLearningArtifacts(cwd: string): ArtifactReference[] {
	const root = path.resolve(cwd, "ask_tools");
	const found: ArtifactReference[] = [];
	const visit = (directory: string, depth: number) => {
		if (depth > 4 || found.length >= MAX_ARTIFACTS) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
		catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (found.length >= MAX_ARTIFACTS || entry.name.startsWith(".")) continue;
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
				visit(fullPath, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const relative = path.relative(cwd, fullPath).split(path.sep).join("/");
			const extension = path.extname(entry.name).slice(1).toLowerCase();
			found.push({ path: relative, label: path.basename(entry.name, path.extname(entry.name)), kind: extension || "file" });
		}
	};
	visit(root, 0);
	return found;
}
