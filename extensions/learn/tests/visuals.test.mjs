import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { load } from "./helpers.mjs";

const svg = (color) => `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="${color}"/></svg>`;
const call = (f, name, args = {}) => f.tool(name).execute(name, args, new AbortController().signal, undefined, f.ctx);

test("maker tools load only in the requested child provider", async (t) => {
	const parent = await load(); t.after(parent.close);
	assert.deepEqual([...parent.extension.tools.keys()], ["learn_quiz", "learn_checkpoint", "learn_status"]);
	const child = await load("visual-tools/svg.ts"); t.after(child.close);
	assert.deepEqual([...child.extension.tools.keys()], ["learn_write_svg", "learn_edit_svg", "learn_render_svg"]);
	for (const { definition } of child.extension.tools.values()) assert.equal(definition.executionMode, "sequential");
});

test("source/editor validation and Plan mode guards", async (t) => {
	const f = await load("visual-tools/svg.ts"); t.after(f.close);
	await assert.rejects(call(f, "learn_render_svg"), /learn_write_svg first/);
	await call(f, "learn_write_svg", { source: svg("red") });
	await call(f, "learn_edit_svg", { old_text: 'fill="red"', new_text: 'fill="blue"' });
	await assert.rejects(call(f, "learn_edit_svg", { old_text: "missing", new_text: "x" }), /exactly once/);
	await assert.rejects(call(f, "learn_edit_svg", { old_text: "120", new_text: "100" }), /exactly once/);
	for (const source of ["", '<svg><script>alert(1)</script></svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>', '<svg><image href="file:///etc/passwd"/></svg>', '<svg><rect style="fill:url(https://example.com/x)"/></svg>', '<svg><style>@import "https://example.com/style.css";</style></svg>']) {
		await assert.rejects(call(f, "learn_write_svg", { source }));
	}
	f.branch.push({ type: "custom", customType: "modes-state", data: { version: 1, mode: "plan" } });
	for (const [name, args] of [["learn_write_svg", { source: svg("red") }], ["learn_edit_svg", { old_text: "blue", new_text: "red" }], ["learn_render_svg", {}]]) {
		await assert.rejects(call(f, name, args), /Plan mode/);
	}
});

test("SVG rendering isolates same-PID children, uses ctx.cwd, and cleans previews", { skip: process.env.PI_LEARN_RENDER_SMOKE !== "1" }, async (t) => {
	const a = await load("visual-tools/svg.ts"), b = await load("visual-tools/svg.ts");
	t.after(a.close); t.after(b.close);
	await call(a, "learn_write_svg", { source: svg("red") });
	await call(b, "learn_write_svg", { source: svg("blue") });
	const [first, second] = await Promise.all([call(a, "learn_render_svg"), call(b, "learn_render_svg")]);
	assert.notEqual(first.details.path, second.details.path);
	assert.notEqual(first.content[1].data, second.content[1].data);
	assert.equal(Buffer.from(first.content[1].data, "base64").subarray(1, 4).toString(), "PNG");
	const directory = join(a.ctx.cwd, "vault/notes/viz");
	const output = await call(a, "learn_render_svg", { save_as: "a test", output_dir: directory });
	assert.equal(output.details.path, join(directory, output.details.filename));
	assert.equal(existsSync(output.details.path), true);
	await assert.rejects(call(a, "learn_render_svg", { save_as: "bad", output_dir: join(a.ctx.cwd, ".pi/plans") }), /extension-owned/);
	await a.emit("session_shutdown"); assert.equal(existsSync(first.details.path), false);
	assert.equal(existsSync(output.details.path), true);
});

test("Mermaid renders a valid PNG and reports invalid diagram failures", { skip: process.env.PI_LEARN_RENDER_SMOKE !== "1" }, async (t) => {
	const f = await load("visual-tools/mermaid.ts"); t.after(f.close);
	await call(f, "learn_write_mermaid", { source: "graph LR\n  A[Foundation] --> B[Understanding]" });
	const result = await call(f, "learn_render_mermaid", { save_as: "foundations" });
	assert.ok(result.details.path.startsWith(join(f.ctx.cwd, "viz")));
	assert.equal(Buffer.from(result.content[1].data, "base64").subarray(1, 4).toString(), "PNG");
	await call(f, "learn_write_mermaid", { source: "this is not Mermaid" });
	await assert.rejects(call(f, "learn_render_mermaid"), /Renderer exited/);
});
