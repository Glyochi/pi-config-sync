/**
 * /abort — abort the current operation without a keyboard shortcut.
 *
 * Escape no longer interrupts (keybindings.json binds app.interrupt to alt+x),
 * so a typed command keeps abort reachable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("abort", {
		description: "Abort the current operation",
		handler: (_args, ctx) => {
			if (ctx.isIdle()) {
				ctx.ui.notify("Nothing to abort", "info");
				return;
			}
			ctx.abort();
		},
	});
}
