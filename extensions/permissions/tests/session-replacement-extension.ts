import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-only command that simulates resuming another session in the same Pi process. */
export default function sessionReplacementTest(pi: ExtensionAPI): void {
	pi.registerCommand("test-resume-target", {
		description: "Switch to the existing session selected by the regression test",
		handler: async (_args, ctx) => {
			await ctx.switchSession(process.env.PI_REPLACEMENT_TEST_TARGET!);
		},
	});
}
