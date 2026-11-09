import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let sdkPath;
try { sdkPath = require.resolve("@earendil-works/pi-coding-agent"); }
catch { sdkPath = join(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "index.js"); }
export const hostRequire = createRequire(sdkPath);
export const sdk = await import(pathToFileURL(sdkPath).href);
export const tuiModule = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);
export const root = fileURLToPath(new URL("..", import.meta.url));
export const temporary = () => mkdtempSync(join(tmpdir(), "pi-learn-test-"));

export async function load(source = "index.ts") {
	const cwd = temporary();
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir: join(cwd, "agent"), settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [join(root, source)],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	const branch = [];
	const notices = [];
	loaded.runtime.appendEntry = (customType, data) => branch.push({ type: "custom", customType, data, id: `custom-${branch.length}` });
	loaded.runtime.getAllTools = () => [...extension.tools.keys()].map((name) => ({ name }));
	const ctx = {
		cwd, hasUI: true, mode: "tui", isIdle: () => true,
		sessionManager: { getBranch: () => branch, getSessionId: () => "lesson-test" },
		ui: { notify: (...args) => notices.push(args), setStatus() {}, onTerminalInput: () => () => {} },
	};
	return {
		ctx, branch, notices, extension, loaded,
		tool: (name) => extension.tools.get(name).definition,
		command: (name, args) => extension.commands.get(name).handler(args, ctx),
		emit: async (name, event = {}) => { for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx); },
		close: async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx); rmSync(cwd, { recursive: true, force: true }); },
	};
}
