export interface ConsumedTerminalInput {
	consume: true;
}

/** Consume Escape only while the ask_user_question extension reports an active prompt. */
export function createAskUserEscapeHandler(
	isAskUserBlocked: () => boolean,
	matchesEscape: (data: string) => boolean,
): (data: string) => ConsumedTerminalInput | undefined {
	return (data) => {
		if (!isAskUserBlocked() || !matchesEscape(data)) return undefined;
		return { consume: true };
	};
}
