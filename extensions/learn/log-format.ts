// Obsidian formatting, independent of Pi runtime and filesystem state.
export interface LogBlock { key: string; text: string }
// Read historical quiz results without exposing an unprefixed tool alias.
export const isQuizTool = (name: string): boolean => name === "learn_quiz" || name === "quiz";
const record = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: any): any[] => Array.isArray(value) ? value : [];
const text = (value: any): string => typeof value === "string" ? value : "";

function callout(type: string, title: string, body: string): string {
	return [`> [!${type}] ${title}`, ...body.split("\n").map((line) => line ? `> ${line}` : ">")].join("\n");
}

function messageText(content: any): string {
	const value = typeof content === "string" ? content : array(content).filter((c) => c?.type === "text").map((c) => text(c.text)).join("\n\n");
	return value.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_match, attrs) => `> [!note] SKILL loaded: ${/name="([^"]+)"/.exec(attrs)?.[1] ?? "(unknown)"}`).trim();
}

export function quizQuestion(id: string, details: any): LogBlock | undefined {
	if (!record(details) || !text(details.question) || !Array.isArray(details.options)) return;
	const options = details.options.map((o: any, i: number) => `${i + 1}. ${text(o?.label)}`).join("\n");
	// Keep persisted marker keys stable across the public tool rename.
	return { key: `quiz:${id}:question`, text: callout("question", "Quiz", [details.question, text(details.context), options].filter(Boolean).join("\n\n")) };
}

function quizAnswer(details: any, failed: boolean): string {
	if (failed || !record(details)) return callout("warning", "Quiz unavailable", "The quiz did not complete.");
	if (details.status !== "answered") return callout("warning", `Quiz — ${text(details.status) || "unavailable"}`, text(details.message) || "No answer submitted.");
	const choice = details.dontKnow ? "I don't know" : array(details.answers).map((a) => `${a.index}. ${text(a.label)}`).join(", ");
	const options = array(details.options);
	const correct = array(details.correctIndices).map((index) => `${index}. ${text(options[index - 1]?.label)}`).join(", ");
	const verdict = details.dontKnow ? "I don't know" : details.correct ? "correct ✓" : "incorrect ✗";
	return callout(details.dontKnow ? "question" : details.correct ? "success" : "failure", `Quiz — ${verdict}`,
		[`Your answer: ${choice}`, `Correct answer: ${correct}`, details.note ? `Note: ${text(details.note)}` : "", text(details.explanation)].filter(Boolean).join("\n\n"));
}

function askQuestions(id: string, args: any): LogBlock[] {
	return array(args?.questions).map((q, index) => ({
		key: `ask:${id}:question:${index}`,
		text: callout("question", text(q.header) || "Question", [text(q.question), ...array(q.options).map((o, i) => `${i + 1}. ${text(o.label)}${o.description ? ` — ${text(o.description)}` : ""}`)].join("\n\n")),
	}));
}

function askAnswer(details: any, failed: boolean): string {
	if (failed || !record(details) || details.error) return callout("warning", "Question unavailable", text(details?.error) || "The questions were not answered.");
	const answers = details.cancelled ? ["Questionnaire cancelled."] : array(details.answers).map((a) => [
		`${text(a.question)}: ${a.kind === "multi" ? array(a.selected).join(", ") : text(a.answer) || "(unanswered)"}`,
		a.notes ? `Note: ${text(a.notes)}` : "",
	].filter(Boolean).join("\n"));
	if (details.globalNote) answers.push(`Global note: ${text(details.globalNote)}`);
	return callout(details.cancelled ? "warning" : "example", "Answer", answers.join("\n\n") || "No answers submitted.");
}

/** Only the active branch is provided by the caller; never traverse abandoned branches. */
export function branchBlocks(entries: readonly any[]): LogBlock[] {
	const blocks: LogBlock[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !record(entry.message)) continue;
		const message = entry.message;
		if (message.role === "user" || message.role === "assistant") {
			const body = messageText(message.content);
			if (body) blocks.push({ key: `message:${entry.id}`, text: `> [!${message.role === "user" ? "quote" : "abstract"}] ${message.role === "user" ? "YOU" : "PI"}\n\n${body}` });
			if (message.role === "assistant") {
				for (const call of array(message.content)) {
					if (call?.type === "toolCall" && call.name === "ask_user_question") blocks.push(...askQuestions(call.id, call.arguments));
				}
			}
		} else if (message.role === "toolResult" && isQuizTool(message.toolName)) {
			// Persisted display order, not the pre-shuffle tool-call arguments.
			const question = quizQuestion(message.toolCallId, message.details);
			if (question) blocks.push(question);
			blocks.push({ key: `quiz:${message.toolCallId}:answer`, text: quizAnswer(message.details, message.isError === true) });
		} else if (message.role === "toolResult" && message.toolName === "ask_user_question") {
			blocks.push({ key: `ask:${message.toolCallId}:answer`, text: askAnswer(message.details, message.isError === true) });
		}
	}
	return blocks;
}
