// Adapted from learn's managed write/edit/render loop; see ../README.md.
import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, assertCanMutate } from "../policy.ts";

export const MMDC = fileURLToPath(new URL("../node_modules/.bin/mmdc", import.meta.url));

export function findExecutable(names: string[]): string | undefined {
	for (const name of names) {
		const candidates = isAbsolute(name) ? [name] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
		for (const candidate of candidates) {
			try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try the next candidate */ }
		}
	}
}

export function chromePath(): string | undefined {
	return findExecutable(process.env.PI_LEARN_CHROME ? [process.env.PI_LEARN_CHROME] : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]);
}

export function chromeSandboxDisabled(): boolean {
	return process.env.PI_LEARN_CHROME_NO_SANDBOX === "1" ||
		(process.env.PI_LEARN_CHROME_NO_SANDBOX === undefined && existsSync("/.dockerenv"));
}

export function applyEdit(current: string, oldText: string, newText: string): string {
	if (!oldText || oldText === newText) throw new Error("old_text must be non-empty and different from new_text.");
	const at = current.indexOf(oldText);
	if (at < 0 || current.indexOf(oldText, at + 1) >= 0) throw new Error("old_text must match exactly once; include enough context.");
	return current.slice(0, at) + newText + current.slice(at + oldText.length);
}

export function validateSource(kind: "mermaid" | "svg", source: string): string {
	const value = source.trim();
	if (!value || value.length > 100_000) throw new Error("Provide non-empty source under 100,000 characters.");
	if (kind === "svg" && (!/<svg\b/i.test(value) || /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<\?xml-stylesheet|@import\b/i.test(value) || /(?:href|src)\s*=\s*["']\s*(?!#)[^"']+/i.test(value) || /url\(\s*["']?(?!#)[^)]/i.test(value))) {
		throw new Error("Use self-contained SVG only: no scripts, external resources, entities, or foreignObject.");
	}
	return value;
}

export function run(command: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error("Render cancelled")); return; }
		const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" } });
		let output = "";
		let reason: string | undefined;
		const stop = (message: string) => {
			reason = message;
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		};
		const abort = () => stop("Render cancelled");
		const timer = setTimeout(() => stop("Render timed out"), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
		child.stdout.on("data", (data) => { output = (output + data).slice(-16_000); });
		child.stderr.on("data", (data) => { output = (output + data).slice(-16_000); });
		child.on("error", (error) => { clean(); reject(error); });
		child.on("close", (code) => { clean(); code === 0 && !reason ? resolve() : reject(new Error(`${reason ?? `Renderer exited ${code}`}\n${output}`)); });
	});
}

/** State belongs to one extension factory, not one process (foreground children share a PID). */
export function registerVisualTools(pi: ExtensionAPI, kind: "mermaid" | "svg"): void {
	let workDir: string | undefined;
	const bodyName = kind === "svg" ? "diagram.svg" : "diagram.mmd";
	const cleanup = () => { if (workDir) rmSync(workDir, { recursive: true, force: true }); workDir = undefined; };
	pi.on("session_shutdown", cleanup);
	const bodyPath = () => {
		workDir ??= mkdtempSync(join(tmpdir(), `pi-learn-${kind}-`));
		return join(workDir, bodyName);
	};
	const mutation = { executionMode: "sequential" as const, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
	const result = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: { ok: true } });

	pi.registerTool({
		...mutation, name: `learn_write_${kind}`, label: `Learn write ${kind}`,
		description: `Write complete ${kind} source to this child's managed temporary file. Does not render. Use learn_edit_${kind} for a small change, then learn_render_${kind} to inspect the PNG.`,
		parameters: Type.Object({ source: Type.String({ minLength: 1, maxLength: 100_000 }) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertCanMutate(ctx);
			if (signal?.aborted) throw new Error("Cancelled");
			const source = validateSource(kind, params.source);
			const file = bodyPath();
			return withFileMutationQueue(file, async () => { writeFileSync(file, source, "utf8"); return result(`Source saved. Call learn_render_${kind} to inspect it.`); });
		},
	});
	pi.registerTool({
		...mutation, name: `learn_edit_${kind}`, label: `Learn edit ${kind}`,
		description: `Replace old_text exactly once in this child's managed ${kind} source. Call learn_write_${kind} first; this does not render.`,
		parameters: Type.Object({ old_text: Type.String({ minLength: 1 }), new_text: Type.String() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertCanMutate(ctx);
			if (signal?.aborted) throw new Error("Cancelled");
			if (!workDir) throw new Error(`Call learn_write_${kind} first.`);
			const file = bodyPath();
			return withFileMutationQueue(file, async () => {
				const updated = validateSource(kind, applyEdit(readFileSync(file, "utf8"), params.old_text, params.new_text));
				writeFileSync(file, updated, "utf8");
				return result(`Source updated. Call learn_render_${kind} to inspect it.`);
			});
		},
	});
	pi.registerTool({
		...mutation, name: `learn_render_${kind}`, label: `Learn render ${kind}`,
		description: `Render the managed ${kind} source to PNG and return the image for visual inspection. Omit save_as for a temporary preview. After verifying it, publish with save_as (topic slug) and output_dir (absolute <linked-note-directory>/viz from learn_status, or default <cwd>/viz). Return the published filename/path only after LOOKING at it.`,
		parameters: Type.Object({ save_as: Type.Optional(Type.String({ minLength: 1 })), output_dir: Type.Optional(Type.String({ minLength: 1 })) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertCanMutate(ctx);
			if (!workDir) throw new Error(`Call learn_write_${kind} first.`);
			const file = bodyPath();
			return withFileMutationQueue(file, async () => {
				if (signal?.aborted) throw new Error("Cancelled");
				const png = join(workDir!, `${randomUUID()}.png`);
				if (kind === "mermaid") {
					const chrome = chromePath();
					if (!existsSync(MMDC) || !chrome) throw new Error("Mermaid needs the learn npm dependencies and Chromium. Run bash install_pi_learn.sh --system-deps (see learn README).");
					const puppeteer = join(workDir!, "puppeteer.json");
					const config = join(workDir!, "mermaid.json");
					writeFileSync(puppeteer, JSON.stringify({ executablePath: chrome, args: ["--disable-dev-shm-usage", ...(chromeSandboxDisabled() ? ["--no-sandbox"] : [])] }));
					writeFileSync(config, JSON.stringify({ securityLevel: "strict", flowchart: { htmlLabels: false } }));
					await run(MMDC, ["-i", file, "-o", png, "-p", puppeteer, "-c", config, "-s", "2", "-b", "white"], workDir!, signal);
				} else {
					const renderer = findExecutable(["rsvg-convert"]);
					if (!renderer) throw new Error("SVG rendering needs librsvg2-bin (rsvg-convert). Run bash install_pi_learn.sh --system-deps.");
					await run(renderer, ["-z", "2", file, "-o", png], workDir!, signal, 60_000);
				}
				const image = readFileSync(png);
				if (image.length > 8 * 1024 * 1024) throw new Error("Image exceeds 8 MiB; simplify the visual.");
				let path = png;
				let filename: string | undefined;
				if (params.save_as) {
					const directory = artifactPath(params.output_dir ?? "viz", ctx.cwd, getAgentDir());
					mkdirSync(directory, { recursive: true });
					const slug = params.save_as.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "visual";
					filename = `viz-${slug}-${randomUUID()}.png`;
					path = join(directory, filename);
					copyFileSync(png, path, constants.COPYFILE_EXCL);
				}
				return {
					content: [{ type: "text" as const, text: `${filename ? `Published: ${filename}` : "Temporary preview"}\npath: ${path}\nLOOK at the image and confirm correctness and legibility before returning it.` }, { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }],
					details: { ok: true, path, filename },
				};
			});
		},
	});
}
