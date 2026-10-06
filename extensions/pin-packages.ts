/**
 * /pin-packages — pin every npm package in settings.json to its installed version.
 *
 * `pi install npm:<pkg>` records the raw spec in the agent settings, so a freshly
 * installed package lands unpinned in the synced config repo. Pi has no option to
 * save exact versions, so this command resolves the version from the local npm
 * tree and rewrites the entry.
 *
 * Manual only: nothing is written on session start and no hooks are installed.
 * The sweep is exported so it can be exercised outside a pi session.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NPM_PREFIX = "npm:";

export interface PinChange { from: string; to: string }
export interface PinResult {
	changes: PinChange[];
	warnings: string[];
	/** True when the settings file was rewritten. */
	changed: boolean;
	dryRun: boolean;
}
export interface PinOptions { dir?: string; dryRun?: boolean }

/** Resolve the agent directory the way git-sync does. */
export function agentDir(dir?: string): string {
	const value = dir ?? process.env.PI_CODING_AGENT_DIR?.trim();
	if (!value) return path.join(os.homedir(), ".pi", "agent");
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return path.resolve(value);
}

/**
 * Split an npm source into name and ref using the same rule the Dockerfile seed
 * uses: the last `@` after index 0 separates them, so scoped names survive.
 */
export function splitNpmSource(source: string): { name: string; ref: string } | undefined {
	if (!source.startsWith(NPM_PREFIX)) return undefined;
	const rest = source.slice(NPM_PREFIX.length);
	const at = rest.lastIndexOf("@");
	const name = at > 0 ? rest.slice(0, at) : rest;
	if (!name) return undefined;
	return { name, ref: at > 0 ? rest.slice(at + 1) : "" };
}

async function readJson(file: string): Promise<Record<string, any> | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, any>;
	} catch {
		return undefined;
	}
}

/** Installed version from the npm tree, then the lockfile; never the network. */
async function installedVersion(npmDir: string, name: string): Promise<string | undefined> {
	const manifest = await readJson(path.join(npmDir, "node_modules", name, "package.json"));
	if (typeof manifest?.version === "string" && manifest.version.trim() !== "") return manifest.version;
	const lock = await readJson(path.join(npmDir, "package-lock.json"));
	const locked = lock?.packages?.[`node_modules/${name}`]?.version;
	if (typeof locked === "string" && locked.trim() !== "") return locked;
	return undefined;
}

function entrySource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
		return (entry as { source: string }).source;
	}
	return undefined;
}

/** Rewrite every npm entry whose ref differs from the installed version. */
export async function pinNpmPackages(options: PinOptions = {}): Promise<PinResult> {
	const dryRun = options.dryRun === true;
	const dir = agentDir(options.dir);
	const settingsPath = path.join(dir, "settings.json");
	const npmDir = path.join(dir, "npm");

	let raw: string;
	try {
		raw = await fs.readFile(settingsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { changes: [], warnings: [`no settings.json at ${settingsPath}`], changed: false, dryRun };
		}
		throw error;
	}

	let settings: Record<string, any>;
	try {
		settings = JSON.parse(raw) as Record<string, any>;
	} catch (error) {
		throw new Error(`${settingsPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const packages = settings.packages;
	if (!Array.isArray(packages)) {
		return { changes: [], warnings: ["settings.json declares no packages"], changed: false, dryRun };
	}

	const changes: PinChange[] = [];
	const warnings: string[] = [];
	for (let index = 0; index < packages.length; index++) {
		const entry = packages[index];
		const source = entrySource(entry);
		if (source === undefined) continue;
		const parsed = splitNpmSource(source);
		if (!parsed) continue;

		const version = await installedVersion(npmDir, parsed.name);
		if (version === undefined) {
			warnings.push(`${parsed.name} is not installed; left as ${source}`);
			continue;
		}
		if (parsed.ref === version) continue;

		const pinned = `${NPM_PREFIX}${parsed.name}@${version}`;
		changes.push({ from: source, to: pinned });
		if (dryRun) continue;
		if (typeof entry === "string") packages[index] = pinned;
		else (entry as { source: string }).source = pinned;
	}

	if (changes.length === 0 || dryRun) return { changes, warnings, changed: false, dryRun };

	// Pi writes settings.json without a trailing newline; preserve whatever the file had.
	const output = JSON.stringify(settings, null, 2) + (raw.endsWith("\n") ? "\n" : "");
	const temporary = `${settingsPath}.pin-packages.tmp`;
	await fs.writeFile(temporary, output, "utf8");
	await fs.rename(temporary, settingsPath);
	return { changes, warnings, changed: true, dryRun };
}

export function summarize(result: PinResult): string {
	const list = result.changes.map((change) => change.to.slice(NPM_PREFIX.length)).join(", ");
	const verb = result.dryRun ? "would pin" : "pinned";
	const parts = result.changes.length > 0
		? [`${verb} ${result.changes.length} npm ${result.changes.length === 1 ? "package" : "packages"}: ${list}`]
		: ["all npm packages already pinned"];
	if (result.warnings.length > 0) parts.push(result.warnings.join("; "));
	return parts.join(" — ");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pin-packages", {
		description: "Pin npm packages in settings.json to their installed versions (--dry-run to preview)",
		handler: async (args, ctx) => {
			const dryRun = (args ?? "").trim().split(/\s+/).includes("--dry-run");
			try {
				const result = await pinNpmPackages({ dryRun });
				ctx.ui.notify(summarize(result), result.warnings.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`pin-packages: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
