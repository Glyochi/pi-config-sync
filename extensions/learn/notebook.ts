// Pure notebook state and Obsidian formatting. No model calls or filesystem effects.
export const TOC_START = "<!-- pi-learn-toc:start -->";
export const TOC_END = "<!-- pi-learn-toc:end -->";
export const GOAL_START = "<!-- pi-learn-goal:start -->";
export const GOAL_END = "<!-- pi-learn-goal:end -->";
export const SECTION_ENTRY = "learn-topic-section";
const STATE_START = "<!-- pi-learn-state\n";
const STATE_END = "\n-->";
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MARKER = /^[a-f0-9]{24}$/;
export const STATUS = { upcoming: "Upcoming", current: "Current", completed: "Completed", review: "Needs review" } as const;
export type TopicStatus = keyof typeof STATUS;
export interface Topic {
	id: string; title: string; status: TopicStatus; dependsOn: string[]; evidence: string;
}
export interface NotebookState {
	version: 1; revision: number; goal: string; nextStep: string; updatedAt: string; topics: Topic[];
}
export interface TopicUpdate {
	id: string; title: string; status: TopicStatus; dependsOn?: string[]; evidence?: string;
}
export interface Section {
	id: string; context: string; topic?: string; title: string; number: number; heading: string;
}
export interface SectionRequest { topic?: string; title?: string; before?: string }
export interface Checkpoint {
	expectedRevision: number; initialize?: boolean; rebuildProgressNote?: boolean; goal?: string; nextStep?: string;
	topics?: TopicUpdate[]; sections?: SectionRequest[];
}

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
function line(v: unknown, name: string, max: number, allowEmpty = false): string {
	if (typeof v !== "string" || v.length > max || (!allowEmpty && !v.trim()) || /[\r\n\x00-\x1f]/.test(v)) throw new Error(`Invalid ${name}: use a single line of at most ${max} characters.`);
	return v.trim();
}
function topicId(v: unknown): string {
	if (typeof v !== "string" || !ID.test(v)) throw new Error("Topic IDs must start with a lowercase letter and contain only lowercase letters, numbers, and dashes (max 64 characters).");
	return v;
}

/** Ignore marker examples inside fenced code blocks. Only extension-owned, top-level markers count. */
export function markerLines(source: string): { text: string; offset: number }[] {
	const result: { text: string; offset: number }[] = [];
	let fence: string | undefined, offset = 0;
	for (const raw of source.split(/(?<=\n)/)) {
		const bom = offset === 0 && raw.startsWith("\uFEFF") ? 1 : 0;
		const text = raw.slice(bom).replace(/\r?\n$/, "");
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
		if (match) {
			if (!fence) fence = match[1];
			else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
		} else if (!fence && text.startsWith("<!-- pi-learn")) result.push({ text, offset: offset + bom });
		offset += raw.length;
	}
	return result;
}

function region(source: string, start: string, end: string): { start: number; end: number; body: string } | undefined {
	const lines = markerLines(source);
	const starts = lines.filter((l) => l.text === start), ends = lines.filter((l) => l.text === end);
	if (!starts.length && !ends.length) return;
	if (starts.length !== 1 || ends.length !== 1 || starts[0].offset >= ends[0].offset) throw new Error(`Malformed or duplicated managed region: ${start}`);
	return { start: starts[0].offset, end: ends[0].offset + end.length, body: source.slice(starts[0].offset + start.length, ends[0].offset) };
}
export function hasNavigation(source: string): boolean { return !!region(source, TOC_START, TOC_END); }
export function hasGoalRegion(source: string): boolean { return !!region(source, GOAL_START, GOAL_END); }

export function validateState(value: unknown): NotebookState {
	if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Unsupported or malformed learning progress state.");
	const goal = line(value.goal, "goal", 2000);
	const nextStep = line(value.nextStep, "next step", 2000, true);
	const updatedAt = line(value.updatedAt, "update timestamp", 40);
	if (!Number.isFinite(Date.parse(updatedAt)) || !Array.isArray(value.topics) || !value.topics.length || value.topics.length > 64) throw new Error("A roadmap needs 1–64 topics and a valid update timestamp.");
	const topics: Topic[] = value.topics.map((t: unknown) => {
		if (!record(t) || !Object.hasOwn(STATUS, t.status) || !Array.isArray(t.dependsOn) || t.dependsOn.length > 16) throw new Error("Invalid topic status or dependencies.");
		const evidence = line(t.evidence, "topic evidence", 2000, true);
		if (t.status === "completed" && !evidence) throw new Error("Completed topics need a short description of demonstrated understanding.");
		return { id: topicId(t.id), title: line(t.title, "topic title", 160), status: t.status as TopicStatus, dependsOn: t.dependsOn.map(topicId), evidence };
	});
	const byId = new Map(topics.map((t) => [t.id, t]));
	if (byId.size !== topics.length) throw new Error("Duplicate topic ID.");
	if (topics.filter((t) => t.status === "current").length > 1) throw new Error("At most one topic may be Current; update the previous topic's status too.");
	const visiting = new Set<string>(), visited = new Set<string>();
	function visit(id: string): void {
		if (visiting.has(id)) throw new Error("Roadmap dependencies must not contain cycles.");
		if (visited.has(id)) return;
		const topic = byId.get(id);
		if (!topic) throw new Error(`Unknown prerequisite topic: ${id}`);
		visiting.add(id);
		for (const dep of topic.dependsOn) visit(dep);
		visiting.delete(id); visited.add(id);
	}
	for (const topic of topics) visit(topic.id);
	return { version: 1, revision: value.revision, goal, nextStep, updatedAt, topics };
}

export function readState(source: string): NotebookState | undefined {
	const toc = region(source, TOC_START, TOC_END);
	if (!toc) return;
	const matches = [...toc.body.matchAll(/<!-- pi-learn-state\r?\n([\s\S]*?)\r?\n-->/g)];
	if (matches.length !== 1) throw new Error("The learning TOC has missing or duplicated progress state; restore it before updating.");
	return validateState(JSON.parse(matches[0][1]));
}

export function advanceState(previous: NotebookState | undefined, input: Checkpoint, now = new Date().toISOString()): NotebookState {
	if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== (previous?.revision ?? 0)) throw new Error(`Progress changed. Read learn_status again; expected revision ${previous?.revision ?? 0}.`);
	if (!previous && input.initialize !== true) throw new Error("Navigation is not initialized. Obtain permission to create the companion progress note, then use initialize: true.");
	const topics = new Map(previous?.topics.map((t) => [t.id, t]) ?? []);
	if (input.topics !== undefined && (!Array.isArray(input.topics) || input.topics.length > 64)) throw new Error("A checkpoint accepts at most 64 topic updates.");
	const updates = new Set<string>();
	for (const update of input.topics ?? []) {
		if (!record(update)) throw new Error("Invalid topic update.");
		if (updates.has(update.id)) throw new Error("Duplicate topic update.");
		updates.add(update.id);
		const old = topics.get(update.id);
		topics.set(update.id, { ...update, dependsOn: update.dependsOn ?? old?.dependsOn ?? [], evidence: update.evidence ?? old?.evidence ?? "" });
	}
	return validateState({ version: 1, revision: (previous?.revision ?? 0) + 1, goal: input.goal ?? previous?.goal, nextStep: input.nextStep ?? previous?.nextStep ?? "", updatedAt: now, topics: [...topics.values()] });
}

function json(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e"); }
const inline = (value: string): string => value.replace(/[&<>\[\]|]/g, (c) => `&#${c.charCodeAt(0)};`);
const headingTitle = (value: string): string => value.replace(/[#[\]^|<>`\\*_]/g, "").replace(/\s+/g, " ").trim() || "Topic";
export function progressPath(note: string): string {
	if (!/\.md$/i.test(note)) throw new Error("A linked learning note must have a .md extension.");
	return note.replace(/\.md$/i, ".goal.md");
}

export function readSections(source: string): Section[] {
	const sections: Section[] = [], ids = new Set<string>(), numbers = new Set<number>();
	for (const { text, offset } of markerLines(source)) {
		const match = /^<!-- pi-learn-section:(.+) -->$/.exec(text);
		if (!match) continue;
		const s = JSON.parse(match[1]);
		if (!record(s) || !MARKER.test(s.id) || !MARKER.test(s.context) || !Number.isSafeInteger(s.number) || s.number < 1 || ids.has(s.id) || numbers.has(s.number)) throw new Error("Malformed or duplicate learning section.");
		if (s.topic !== undefined) topicId(s.topic);
		line(s.title, "section title", 160); line(s.heading, "section heading", 200);
		if (/^\r?\n## ([^\r\n]+)\r?\n/.exec(source.slice(offset + text.length))?.[1] !== s.heading) throw new Error("A generated topic heading was changed without its metadata. Restore the heading before updating navigation.");
		ids.add(s.id); numbers.add(s.number); sections.push(s as Section);
	}
	return sections;
}
export function createSection(id: string, number: number, request: SectionRequest, state: NotebookState, context = id): Section {
	if (!MARKER.test(id) || !MARKER.test(context)) throw new Error("Invalid section ID.");
	const topic = request.topic ? state.topics.find((t) => t.id === request.topic) : undefined;
	if (request.topic && !topic) throw new Error(`Unknown section topic: ${request.topic}`);
	const title = line(request.title ?? topic?.title, "section title", 160);
	return { id, context, ...(topic ? { topic: topic.id } : {}), title, number, heading: `${String(number).padStart(2, "0")} - ${headingTitle(title)}` };
}
export function renderSection(section: Section): string { return `<!-- pi-learn-section:${json(section)} -->\n## ${section.heading}\n`; }

/** Only generated regions change; handwritten prose/frontmatter outside them stays byte-for-byte. */
export function replaceRegion(source: string, start: string, end: string, body: string): string {
	const existing = region(source, start, end), replacement = `${start}\n${body.trim()}\n${end}`;
	if (existing) return source.slice(0, existing.start) + replacement + source.slice(existing.end);
	let at = source.startsWith("\uFEFF") ? 1 : 0;
	if (/^---\r?\n/.test(source.slice(at))) {
		const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(source.slice(at));
		if (!frontmatter) throw new Error("Unclosed YAML frontmatter; refusing to insert navigation.");
		at += frontmatter[0].length;
	}
	return source.slice(0, at) + replacement + "\n\n" + source.slice(at);
}

export function renderNavigation(source: string, state: NotebookState, goalFilename: string): string {
	const sections = readSections(source), topics = new Map(state.topics.map((t) => [t.id, t]));
	const current = state.topics.find((t) => t.status === "current");
	const items = sections.map((s) => {
		const status = s.topic ? topics.get(s.topic)?.status : undefined;
		return `- [[#${s.heading}|${inline(s.title)}]]${status ? ` — ${STATUS[status]}` : ""}`;
	});
	const body = ["## Contents", `[Goal and progress](./${encodeURIComponent(goalFilename)})`, current ? `**Current:** ${inline(current.title)}` : "", ...items, !items.length ? "Topic sections will appear here as the lesson proceeds." : "", `${STATE_START}${json(state)}${STATE_END}`].filter(Boolean).join("\n\n");
	return replaceRegion(source, TOC_START, TOC_END, body);
}

export function renderMermaid(state: NotebookState): string {
	const ids = new Map(state.topics.map((t, i) => [t.id, `t${i}`]));
	const escape = (s: string) => s.replace(/["<>&#\[\]`]/g, (c) => `#${c.charCodeAt(0)};`);
	return ["flowchart TD", ...state.topics.map((t) => `    ${ids.get(t.id)}["${escape(`${STATUS[t.status]}: ${t.title}`)}"]:::${t.status}`), ...state.topics.flatMap((t) => t.dependsOn.map((dep) => `    ${ids.get(dep)} --> ${ids.get(t.id)}`)), "    classDef completed fill:#e0f2e9,stroke:#39845c,color:#173c28", "    classDef current fill:#fff0c2,stroke:#b48720,color:#513c08,stroke-width:3px", "    classDef upcoming fill:#eef2f7,stroke:#6b7280,color:#1f2937", "    classDef review fill:#fde6e6,stroke:#b45353,color:#612626"].join("\n");
}
export function goalRevision(source: string): number | undefined {
	const body = region(source, GOAL_START, GOAL_END)?.body;
	const matches = body ? [...body.matchAll(/^<!-- pi-learn-goal-revision:(\d+) -->\r?$/gm)] : [];
	return matches.length === 1 ? Number(matches[0][1]) : undefined;
}
export function renderGoal(source: string, state: NotebookState, noteFilename: string, sections: Section[]): string {
	const link = (topic: Topic) => {
		const section = sections.find((s) => s.topic === topic.id);
		return section ? `[${inline(topic.title)}](./${encodeURIComponent(noteFilename)}#${encodeURIComponent(section.heading)})` : inline(topic.title);
	};
	const current = state.topics.find((t) => t.status === "current");
	const body = [`<!-- pi-learn-goal-revision:${state.revision} -->`, "# Goal and progress", `**Goal:** ${inline(state.goal)}`, `[Lesson contents](./${encodeURIComponent(noteFilename)})`, `**Current:** ${current ? link(current) : "Between topics"}`, `**Next step:** ${inline(state.nextStep || "Not set")}`, `Updated: ${state.updatedAt} · Revision: ${state.revision}`, "## Progress map", "```mermaid\n" + renderMermaid(state) + "\n```", "Completed = demonstrated understanding, not a claim of permanent mastery.", "## Topics", "| Topic | Status | Evidence / remaining gap |\n| --- | --- | --- |\n" + state.topics.map((t) => `| ${link(t)} | ${STATUS[t.status]} | ${inline(t.evidence || "Not assessed yet")} |`).join("\n")].join("\n\n");
	return replaceRegion(source, GOAL_START, GOAL_END, body);
}
