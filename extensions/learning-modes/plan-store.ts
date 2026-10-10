import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPlanTemplate } from "./plan-markdown.ts";
import type { PlanStatus } from "./state.ts";

export interface PlanRecord {
	id: string;
	title: string;
	path: string;
	status: PlanStatus;
	ownerSessionId: string;
	createdAt: number;
	updatedAt: number;
	blockedReason?: string;
}

export interface PlanIndex {
	version: 1;
	plans: PlanRecord[];
}

const INDEX_FILE = "state.json";
const LOCK_DIR = ".learning-modes.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

export function planDirectory(cwd: string): string {
	return path.resolve(cwd, ".pi", "plans");
}

export function planIndexPath(cwd: string): string {
	return path.join(planDirectory(cwd), INDEX_FILE);
}

export function isPlanId(value: unknown): value is string {
	return typeof value === "string" && /^plan-[a-f0-9-]{12,36}$/i.test(value);
}

export function planMarkdownPath(cwd: string, id: string): string {
	if (!isPlanId(id)) throw new Error("Invalid plan id");
	return path.join(planDirectory(cwd), `${id}.md`);
}

function decodePlan(value: unknown): PlanRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const item = value as Partial<PlanRecord>;
	if (!isPlanId(item.id) || typeof item.title !== "string" || !item.title.trim() || item.path !== `.pi/plans/${item.id}.md` ||
		(item.status !== "open" && item.status !== "completed" && item.status !== "blocked") ||
		typeof item.ownerSessionId !== "string" || !item.ownerSessionId.trim() ||
		!Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) ||
		(item.blockedReason !== undefined && typeof item.blockedReason !== "string")) return undefined;
	if (item.status !== "blocked" && item.blockedReason !== undefined) return undefined;
	return {
		id: item.id,
		title: item.title.trim(),
		path: item.path,
		status: item.status,
		ownerSessionId: item.ownerSessionId,
		createdAt: item.createdAt!,
		updatedAt: item.updatedAt!,
		...(item.status === "blocked" && item.blockedReason?.trim() ? { blockedReason: item.blockedReason.trim() } : {}),
	};
}

export function decodePlanIndex(value: unknown): PlanIndex | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as { version?: unknown; plans?: unknown };
	if (raw.version !== 1 || !Array.isArray(raw.plans)) return undefined;
	const plans: PlanRecord[] = [];
	for (const item of raw.plans) {
		const plan = decodePlan(item);
		if (!plan || plans.some((candidate) => candidate.id === plan.id)) return undefined;
		plans.push(plan);
	}
	if (plans.filter((plan) => plan.status === "open").length > 1) return undefined;
	return { version: 1, plans };
}

function emptyIndex(): PlanIndex {
	return { version: 1, plans: [] };
}

function readIndexSync(cwd: string): PlanIndex {
	try {
		const parsed = JSON.parse(fs.readFileSync(planIndexPath(cwd), "utf8")) as unknown;
		const decoded = decodePlanIndex(parsed);
		if (!decoded) throw new Error("Plan state has an unsupported or malformed format");
		return decoded;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
		throw error;
	}
}

async function readIndex(cwd: string): Promise<PlanIndex> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(planIndexPath(cwd), "utf8")) as unknown;
		const decoded = decodePlanIndex(parsed);
		if (!decoded) throw new Error("Plan state has an unsupported or malformed format");
		return decoded;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
		throw error;
	}
}

async function writeIndex(cwd: string, index: PlanIndex): Promise<void> {
	const file = planIndexPath(cwd);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.promises.rename(temporary, file);
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}

interface LockOwner {
	pid: number;
	token: string;
	createdAt: number;
}

async function lockIsStale(lockDir: string): Promise<boolean> {
	try {
		const owner = JSON.parse(await fs.promises.readFile(path.join(lockDir, "owner.json"), "utf8")) as Partial<LockOwner>;
		if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0) {
			const stat = await fs.promises.stat(lockDir);
			return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
		}
		try {
			process.kill(owner.pid!, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	} catch {
		try {
			const stat = await fs.promises.stat(lockDir);
			return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
		} catch {
			return true;
		}
	}
}

async function withStoreLock<T>(cwd: string, work: () => Promise<T>): Promise<T> {
	const directory = planDirectory(cwd);
	await fs.promises.mkdir(directory, { recursive: true });
	const lockDir = path.join(directory, LOCK_DIR);
	const token = randomUUID();
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let acquired = false;
	while (Date.now() <= deadline) {
		try {
			await fs.promises.mkdir(lockDir);
			const owner: LockOwner = { pid: process.pid, token, createdAt: Date.now() };
			await fs.promises.writeFile(path.join(lockDir, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
			acquired = true;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				await fs.promises.rm(lockDir, { recursive: true, force: true });
				throw error;
			}
			if (await lockIsStale(lockDir)) {
				await fs.promises.rm(lockDir, { recursive: true, force: true });
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
	}
	if (!acquired) throw new Error("Plan state is busy in another session; retry the operation");
	try {
		return await work();
	} finally {
		try {
			const owner = JSON.parse(await fs.promises.readFile(path.join(lockDir, "owner.json"), "utf8")) as Partial<LockOwner>;
			if (owner.token === token) await fs.promises.rm(lockDir, { recursive: true, force: true });
		} catch {
			// A failed cleanup must not change the already completed state transition.
		}
	}
}

export class PlanStore {
	readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	list(): PlanRecord[] {
		return readIndexSync(this.cwd).plans.slice().sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): PlanRecord | undefined {
		if (!isPlanId(id)) return undefined;
		return readIndexSync(this.cwd).plans.find((plan) => plan.id === id);
	}

	readMarkdown(id: string): string {
		return fs.readFileSync(planMarkdownPath(this.cwd, id), "utf8");
	}

	async create(title: string, ownerSessionId: string): Promise<PlanRecord> {
		const cleanTitle = title.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
		if (!cleanTitle) throw new Error("A plan requires a title");
		if (!ownerSessionId.trim()) throw new Error("A plan requires an owner session");
		return withStoreLock(this.cwd, async () => {
			const index = await readIndex(this.cwd);
			const active = index.plans.find((plan) => plan.status === "open");
			if (active) throw new Error(`An open plan already exists (${active.id}: ${active.title}); resume or close it before starting another`);
			const now = Date.now();
			const id = `plan-${randomUUID()}`;
			const record: PlanRecord = { id, title: cleanTitle, path: `.pi/plans/${id}.md`, status: "open", ownerSessionId, createdAt: now, updatedAt: now };
			const file = planMarkdownPath(this.cwd, record.id);
			await fs.promises.writeFile(file, createPlanTemplate(cleanTitle), { encoding: "utf8", flag: "wx", mode: 0o600 });
			try {
				index.plans.push(record);
				await writeIndex(this.cwd, index);
			} catch (error) {
				await fs.promises.rm(file, { force: true });
				throw error;
			}
			return record;
		});
	}

	async claim(id: string, ownerSessionId: string): Promise<PlanRecord> {
		if (!isPlanId(id)) throw new Error("Invalid plan id");
		if (!ownerSessionId.trim()) throw new Error("A plan requires an owner session");
		return withStoreLock(this.cwd, async () => {
			const index = await readIndex(this.cwd);
			const record = index.plans.find((plan) => plan.id === id);
			if (!record) throw new Error(`Plan not found: ${id}`);
			if (record.status === "completed") throw new Error("A completed plan cannot be resumed");
			const otherActive = index.plans.find((plan) => plan.status === "open" && plan.id !== id);
			if (otherActive) throw new Error(`Another plan is already open (${otherActive.id}: ${otherActive.title})`);
			record.ownerSessionId = ownerSessionId;
			record.status = "open";
			delete record.blockedReason;
			record.updatedAt = Date.now();
			await writeIndex(this.cwd, index);
			return { ...record };
		});
	}

	async setStatus(id: string, ownerSessionId: string, status: "completed" | "blocked", reason?: string): Promise<PlanRecord> {
		if (!isPlanId(id)) throw new Error("Invalid plan id");
		if (status === "blocked" && !reason?.trim()) throw new Error("Blocking a plan requires a concise reason");
		return withStoreLock(this.cwd, async () => {
			const index = await readIndex(this.cwd);
			const record = index.plans.find((plan) => plan.id === id);
			if (!record) throw new Error(`Plan not found: ${id}`);
			if (record.ownerSessionId !== ownerSessionId) throw new Error("This session no longer owns the plan; resume it before changing status");
			if (record.status !== "open") throw new Error(`Only an open plan can be marked ${status}`);
			record.status = status;
			record.updatedAt = Date.now();
			if (status === "blocked") record.blockedReason = reason!.trim().slice(0, 1000);
			else delete record.blockedReason;
			await writeIndex(this.cwd, index);
			return { ...record };
		});
	}

	isOwner(id: string, sessionId: string): boolean {
		return this.get(id)?.ownerSessionId === sessionId;
	}
}
