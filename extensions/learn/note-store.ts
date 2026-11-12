import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { artifactPath } from "./policy.ts";
import { advanceState, createSection, goalRevision, hasGoalRegion, markerLines, progressPath, readSections, readState, renderGoal, renderNavigation, renderSection, type Checkpoint, type NotebookState, type Section } from "./notebook.ts";

export interface StoreOptions { cwd: string; agentDir: string }
export interface StoredBlock { id: string; text: string; section?: Section; topicContext?: Section }
interface Snapshot { text: string; stat: Stats }
export const logMarker = (session: string, key: string): string => createHash("sha256").update(`${session}:${key}`).digest("hex").slice(0, 24);

function readRegular(file: string, missing = false): Snapshot | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
		return { text: readFileSync(fd, "utf8"), stat };
	} catch (error) {
		if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	} finally { if (fd !== undefined) closeSync(fd); }
}
function unchanged(file: string, old: Snapshot): void {
	const latest = readRegular(file)!;
	if (latest.stat.dev !== old.stat.dev || latest.stat.ino !== old.stat.ino || latest.text !== old.text) throw new Error(`Note changed while updating: ${file}. No replacement was made; retry after the editor finishes saving.`);
}

/** Same-directory temp + optimistic content/inode check. Never truncate a live note. */
function replaceChecked(file: string, old: Snapshot | undefined, text: string): void {
	if (old?.text === text) return;
	if (old) accessSync(file, constants.W_OK);
	const temporary = join(dirname(file), `.${basename(file)}.learn-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, old ? old.stat.mode & 0o777 : 0o600);
		writeFileSync(fd, text, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
		if (old) { unchanged(file, old); renameSync(temporary, file); }
		else {
			// link is exclusive: unlike rename, initial creation cannot overwrite a file that appeared meanwhile.
			linkSync(temporary, file);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
function appendChecked(file: string, old: Snapshot, text: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.dev !== old.stat.dev || stat.ino !== old.stat.ino) throw new Error("Linked note was replaced during append.");
		unchanged(file, old);
		const bytes = Buffer.from(text);
		let written = 0;
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
	} finally { if (fd !== undefined) closeSync(fd); }
}

/** Pi's in-process mutation queue wraps callers. This exclusive lock also coordinates other Pi processes. */
function locked<T>(note: string, options: StoreOptions, action: (note: string) => T): T {
	const target = artifactPath(note, options.cwd, options.agentDir);
	if (target !== resolve(options.cwd, note)) throw new Error("The linked note path was replaced by a symlink; relink explicitly.");
	// Check the note before creating a lock; missing/deleted notes must never be recreated.
	readRegular(target);
	const lock = `${target}.learn-lock`;
	let fd: number;
	try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Learning note is locked: ${lock}. Another process may be updating it. Remove a stale lock only after confirming that process has stopped.`);
		throw error;
	}
	try { writeFileSync(fd, `pid=${process.pid}\n`); return action(target); }
	finally { closeSync(fd); unlinkSync(lock); }
}
function existingMarkers(source: string): Set<string> {
	return new Set(markerLines(source).flatMap(({ text }) => /^<!-- pi-learn:([a-f0-9]{24}) -->$/.exec(text)?.slice(1) ?? []));
}

export function appendNotebook(note: string, blocks: StoredBlock[], options: StoreOptions): void {
	if (!blocks.length) return;
	locked(note, options, (target) => {
		const old = readRegular(target)!, seen = existingMarkers(old.text);
		let next = old.text;
		const state = readState(next), sections = readSections(next);
		// Historical backfills predate session annotations. Existing message markers still
		// tell us which structural section an older branch was discussing; no prose inference.
		const byId = new Map(sections.map((s) => [s.id, s])), contexts = new Map<string, Section>();
		let cursor: Section | undefined, inherited: Section | undefined;
		for (const { text } of markerLines(next)) {
			const id = /^<!-- pi-learn:([a-f0-9]{24}) -->$/.exec(text)?.[1];
			if (!id) continue;
			cursor = byId.get(id) ?? cursor;
			if (cursor) contexts.set(id, cursor);
		}
		let last = sections.at(-1), number = Math.max(0, ...sections.map((s) => s.number));
		for (const block of blocks) {
			inherited = block.topicContext ?? contexts.get(block.id) ?? inherited;
			if (seen.has(block.id)) continue;
			if (state && !block.section && inherited && last?.context !== inherited.context) {
				const id = logMarker(block.id, "continuation");
				last = createSection(id, ++number, inherited, state, inherited.context);
				next += `\n\n<!-- pi-learn:${id} -->\n${renderSection(last)}\n`;
			}
			if (block.section) { last = block.section; number = Math.max(number, last.number); }
			next += `\n\n<!-- pi-learn:${block.id} -->\n${block.text}\n`;
			seen.add(block.id);
		}
		if (next === old.text) return;
		if (state) next = renderNavigation(next, state, basename(progressPath(target)));
		if (next.startsWith(old.text)) appendChecked(target, old, next.slice(old.text.length));
		else replaceChecked(target, old, next);
	});
}

export interface CheckpointResult { note: string; progressNote: string; state: NotebookState; sections: Section[] }
/** State lives in the managed TOC; the companion is a derived Markdown view, not a second database. */
export function checkpointNotebook(note: string, input: Checkpoint, token: string, options: StoreOptions): CheckpointResult {
	return locked(note, options, (target) => {
		const old = readRegular(target)!, previous = readState(old.text);
		accessSync(target, constants.W_OK);
		if (input.rebuildProgressNote && (!previous || input.expectedRevision !== previous.revision || input.goal !== undefined || input.nextStep !== undefined || input.topics !== undefined || input.sections !== undefined)) throw new Error("Rebuilding a progress note requires the current revision and no roadmap changes or section boundaries.");
		const state = input.rebuildProgressNote ? previous! : advanceState(previous, input);
		const goalFile = progressPath(target);
		if (artifactPath(goalFile, options.cwd, options.agentDir) !== goalFile) throw new Error("The companion note must not be a symlink.");
		// A symlink to the same path is caught by O_NOFOLLOW as well.
		const goalOld = readRegular(goalFile, true);
		if (goalOld && !hasGoalRegion(goalOld.text)) throw new Error(`Companion path already contains an unrecognized note: ${goalFile}. Move it or choose a different lesson note; it will not be overwritten.`);
		if (goalOld) accessSync(goalFile, constants.W_OK);
		if (!goalOld && previous && !input.rebuildProgressNote) throw new Error(`Companion note is missing: ${goalFile}. Restore it, or obtain permission to use rebuildProgressNote: true; it will not be silently recreated.`);
		const requests = input.sections ?? [];
		if (!Array.isArray(requests) || requests.length > 128) throw new Error("A checkpoint accepts at most 128 section boundaries.");
		let next = old.text;
		const known = readSections(next), receipts: Section[] = [];
		let number = Math.max(0, ...known.map((s) => s.number));
		for (const [index, request] of requests.entries()) {
			const section = createSection(logMarker(token, `section:${index}`), ++number, request, state);
			if (known.some((s) => s.id === section.id)) throw new Error("This section boundary was already written. Read learn_status before retrying.");
			const block = `\n\n<!-- pi-learn:${section.id} -->\n${renderSection(section)}\n`;
			if (request.before !== undefined) {
				if (!/^[a-f0-9]{24}$/.test(request.before)) throw new Error("A historical boundary needs a 24-character pi-learn message marker.");
				const matches = markerLines(next).filter((l) => l.text === `<!-- pi-learn:${request.before} -->`);
				if (matches.length !== 1) throw new Error(`Historical message marker missing or ambiguous: ${request.before}`);
				next = next.slice(0, matches[0].offset) + block + "\n" + next.slice(matches[0].offset);
			} else next += block;
			receipts.push(section);
		}
		next = renderNavigation(next, state, basename(goalFile));
		const goalNext = renderGoal(goalOld?.text ?? "", state, basename(target), readSections(next));
		// Validate both snapshots before committing either file. Filesystem failures between the two
		// commits are reported; the TOC's revision is authoritative. An existing companion can
		// be refreshed by the next checkpoint; a missing one must be explicitly restored.
		unchanged(target, old);
		if (goalOld) unchanged(goalFile, goalOld);
		else if (lstatSync(goalFile, { throwIfNoEntry: false })) throw new Error("Companion note appeared while initializing; retry.");
		replaceChecked(target, old, next);
		try { replaceChecked(goalFile, goalOld, goalNext); }
		catch (error) { throw new Error(`Progress revision ${state.revision} was saved to ${target}, but the companion update failed: ${String(error)}. Read learn_status before retrying.`); }
		return { note: target, progressNote: goalFile, state, sections: receipts };
	});
}

/** Read-only status works across fresh sessions without replaying old branch progress over newer state. */
export function notebookStatus(note: string, options: StoreOptions) {
	const target = artifactPath(note, options.cwd, options.agentDir);
	if (target !== resolve(options.cwd, note)) throw new Error("The linked note path was replaced by a symlink; relink explicitly.");
	const source = readRegular(target)!;
	const state = readState(source.text), companion = progressPath(target);
	if (artifactPath(companion, options.cwd, options.agentDir) !== companion) throw new Error("The companion note must not be a symlink.");
	const goal = readRegular(companion, true);
	return {
		progressNote: companion, progressNoteExists: !!goal, progressRevision: state?.revision ?? 0,
		progress: state ?? null,
		...(state && !goal ? { progressWarning: "Companion note is missing; restore it or obtain permission to rebuildProgressNote before updating." } : {}),
		...(goal && !hasGoalRegion(goal.text) ? { progressWarning: "The companion path contains an unrecognized note; initialization will not overwrite it." } : {}),
		...(state && goal && hasGoalRegion(goal.text) && goalRevision(goal.text) !== state.revision ? { progressWarning: "Companion view is out of date. Use the authoritative progress state here and refresh it at the next checkpoint, or rebuildProgressNote without changing progress." } : {}),
	};
}
