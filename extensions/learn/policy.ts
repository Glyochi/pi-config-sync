import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MODE_STATE_ENTRY_TYPE } from "../shared/contracts.ts";

export function isPlan(ctx: { sessionManager: { getBranch(): readonly any[] } }): boolean {
	let mode = "build";
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === MODE_STATE_ENTRY_TYPE && entry.data?.version === 1) mode = entry.data.mode;
	}
	return mode === "plan";
}

export function assertCanMutate(ctx: Parameters<typeof isPlan>[0]): void {
	if (isPlan(ctx)) throw new Error("Learning file writes and rendering are paused in Plan mode. Use /ask or /build first.");
}

/** Resolve existing ancestors too, so a missing output directory cannot hide a symlink escape. */
export function canonicalPath(input: string): string {
	const target = resolve(input);
	if (existsSync(target)) return realpathSync(target);
	const parent = dirname(target);
	return parent === target ? target : join(canonicalPath(parent), basename(target));
}

export function artifactPath(input: string, cwd: string, agentDir: string): string {
	const target = canonicalPath(resolve(cwd, input));
	const config = canonicalPath(agentDir);
	const inside = relative(config, target);
	if (inside === "" || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`))) {
		throw new Error("Keep lesson notes and generated images outside the synced Pi config directory.");
	}
	if (target.split(sep).some((part, i, parts) => part === "plans" && parts[i - 1] === ".pi")) {
		throw new Error("Learning tools cannot write extension-owned .pi/plans files.");
	}
	return target;
}
