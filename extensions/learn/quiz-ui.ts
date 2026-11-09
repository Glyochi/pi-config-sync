import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, Key, matchesKey, truncateToWidth, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

/** A bounded, scrollable, cancellable overlay around upstream's quiz component. */
export async function showQuizUI<T>(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	factory: (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (result: T | null) => void) => Component,
): Promise<T | null> {
	if (signal?.aborted || ctx.mode !== "tui") return null;
	let handle: OverlayHandle | undefined;
	let finish: ((result: T | null) => void) | undefined;
	let cancelled = false;
	const abort = () => { cancelled = true; finish?.(null); };
	const removeInput = ctx.ui.onTerminalInput((data) => {
		if (!handle || (!handle.isHidden() && !handle.isFocused()) || !matchesKey(data, "ctrl+]")) return;
		if (!isKeyRelease(data) && !isKeyRepeat(data)) handle.setHidden(!handle.isHidden());
		return { consume: true };
	});
	signal?.addEventListener("abort", abort, { once: true });
	try {
		return await ctx.ui.custom<T | null>((tui, theme, kb, done) => {
			finish = done;
			const child = factory(tui, theme, kb, done);
			let offset = 0;
			let viewport = 10;
			const component: Component = {
				render(width) {
					const lines = child.render(width);
					viewport = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 2);
					offset = Math.max(0, Math.min(offset, lines.length - viewport));
					const hint = " Ctrl+] hide/show • PgUp/PgDn scroll";
					return [truncateToWidth(theme.fg("dim", hint), width), ...lines.slice(offset, offset + viewport),
						truncateToWidth(theme.fg("dim", lines.length > viewport ? ` ${offset + 1}–${Math.min(lines.length, offset + viewport)} / ${lines.length}` : ""), width)];
				},
				handleInput(data) {
					if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - viewport);
					else if (matchesKey(data, Key.pageDown)) offset += viewport;
					else child.handleInput?.(data);
					tui.requestRender();
				},
				invalidate() { child.invalidate(); },
			};
			if (cancelled || signal?.aborted) queueMicrotask(() => done(null));
			return component;
		}, {
			overlay: true,
			overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "80%" },
			onHandle: (value) => { handle = value; },
		});
	} finally {
		signal?.removeEventListener("abort", abort);
		removeInput();
		finish = undefined;
		handle = undefined;
	}
}
