import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	GOAL_SCHEMA_VERSION,
	type ActionAuthority,
	type GoalDraft,
	type GoalEventRecord,
	type GoalNode,
	type GoalState,
	type VerificationCheck,
} from "./types.ts";

export const STATE_CUSTOM_TYPE = "pi-goal-state-v1";
export const CONTEXT_CUSTOM_TYPE = "pi-goal-context-v1";
export const SETUP_TRANSCRIPT_CUSTOM_TYPE = "pi-goal-setup-transcript-v1";

export function now(): string {
	return new Date().toISOString();
}

export function makeId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonicalValue(item)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

export function inputHash(toolName: string, input: unknown): string {
	return sha256(`${toolName}\n${canonicalJson(input ?? null)}`);
}

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
	/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g,
	/\bAKIA[A-Z0-9]{16}\b/g,
	/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/g,
	/\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

export function redactText(value: string, maxLength = 500): { text: string; redacted: boolean } {
	let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
	let redacted = false;
	for (const pattern of SECRET_PATTERNS) {
		text = text.replace(pattern, () => {
			redacted = true;
			return "[REDACTED]";
		});
	}
	if (text.length > maxLength) {
		text = `${text.slice(0, maxLength)}…`;
		redacted = true;
	}
	return { text, redacted };
}

export function isSensitivePath(path: string): boolean {
	return /(^|[/\\])(?:\.env(?:\.|$)|auth\.json$|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|ed25519)$|[^/\\]+\.(?:pem|key|p12|pfx)$)|[/\\](?:\.ssh|\.aws|\.gnupg|keyrings?)(?:[/\\]|$)/i.test(path);
}

export function isWithinWorkspace(cwd: string, path: string): boolean {
	const root = resolve(cwd);
	const target = resolve(cwd, path);
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolvedThroughExistingAncestor(path: string): string | undefined {
	let cursor = resolve(path);
	const suffix: string[] = [];
	while (true) {
		try { lstatSync(cursor); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			const parent = dirname(cursor);
			if (parent === cursor) return undefined;
			suffix.unshift(basename(cursor));
			cursor = parent;
			continue;
		}
		try { return resolve(realpathSync.native(cursor), ...suffix); }
		catch { return undefined; }
	}
}

export function resolvedPathWithinWorkspace(cwd: string, path: string): string | undefined {
	if (!isWithinWorkspace(cwd, path)) return undefined;
	const root = resolvedThroughExistingAncestor(cwd);
	const target = resolvedThroughExistingAncestor(resolve(cwd, path));
	if (!root || !target) return undefined;
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? target : undefined;
}

export function safeEvidencePath(cwd: string, path: string): string {
	if (isSensitivePath(path)) return "[sensitive-path-redacted]";
	const resolved = resolvedPathWithinWorkspace(cwd, path);
	if (!resolved) return "[outside-workspace]";
	if (isSensitivePath(resolved)) return "[sensitive-path-redacted]";
	return relative(resolve(cwd), resolve(cwd, path)) || ".";
}

export function validateDag(nodes: GoalNode[]): string[] {
	const errors: string[] = [];
	const ids = new Set<string>();
	for (const node of nodes) {
		if (!node.id.trim()) errors.push("plan node has empty id");
		if (ids.has(node.id)) errors.push(`duplicate plan node: ${node.id}`);
		ids.add(node.id);
	}
	for (const node of nodes) {
		for (const dependency of node.dependsOn) {
			if (!ids.has(dependency)) errors.push(`${node.id} depends on missing node ${dependency}`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	function visit(id: string): void {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			errors.push(`cycle detected at ${id}`);
			return;
		}
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	}
	for (const id of ids) visit(id);
	const active = nodes.filter((node) => node.status === "in_progress");
	if (active.length > 1) errors.push("plan may have at most one in_progress node");
	return [...new Set(errors)];
}

function normalizeCheck(check: VerificationCheck, index: number): VerificationCheck {
	return { ...check, id: check.id?.trim() || `V${index + 1}`, label: check.label?.trim() || `Verification ${index + 1}` };
}

function normalizeAuthority(authority: Omit<ActionAuthority, "uses">, index: number): ActionAuthority {
	return {
		...authority,
		id: authority.id?.trim() || `A${index + 1}`,
		label: authority.label?.trim() || `${authority.actionClass}: ${authority.toolName}`,
		uses: 0,
		maxUses: Math.max(1, Math.min(100, authority.maxUses || 1)),
		targets: authority.targets ?? [],
	};
}

export function createGoalState(draft: GoalDraft, ctx: ExtensionContext, originalOutcome: string = draft.outcome): GoalState {
	const at = now();
	const criteria = draft.criteria.map((text, index) => ({
		id: `AC${index + 1}`,
		text: redactText(text, 500).text,
		status: "pending" as const,
		evidenceIds: [],
	}));
	const criterionIds = new Set(criteria.map((criterion) => criterion.id));
	const nodes: GoalNode[] = draft.phases.map((phase, index) => ({
		id: phase.id?.trim() || `P${index + 1}`,
		title: redactText(phase.title, 200).text,
		description: phase.description ? redactText(phase.description, 500).text : undefined,
		status: index === 0 ? "in_progress" : "pending",
		dependsOn: phase.dependsOn ?? (index > 0 ? [`P${index}`] : []),
		criterionIds: (phase.criterionIds ?? []).filter((id) => criterionIds.has(id)),
		evidenceIds: [],
		createdAt: at,
		updatedAt: at,
	}));
	const dagErrors = validateDag(nodes);
	if (dagErrors.length) throw new Error(`Invalid generated goal plan: ${dagErrors.join("; ")}`);
	return {
		schemaVersion: GOAL_SCHEMA_VERSION,
		goalId: makeId("goal"),
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		status: "awaiting_approval",
		phase: "setup",
		generation: 1,
		revision: 0,
		createdAt: at,
		updatedAt: at,
		outcome: {
			original: redactText(originalOutcome, Number.MAX_SAFE_INTEGER).text,
			current: redactText(draft.outcome, Number.MAX_SAFE_INTEGER).text,
			amendments: [],
		},
		criteria,
		plan: nodes,
		verificationChecks: draft.verificationChecks.map(normalizeCheck),
		authorities: draft.authorities.map(normalizeAuthority),
		evidence: [],
		observations: [],
		evaluatorReports: [],
		auditReports: [],
		currentAction: "Reviewing goal contract",
		nextAction: nodes[0]?.title ?? "Begin work",
		completionCandidate: false,
		continuationSequence: 0,
		turnCount: 0,
		recoveryCount: 0,
		auditFailureCount: 0,
		verificationFailureCount: 0,
		noProgressCount: 0,
		repeatedToolCalls: {},
		repeatedBlockers: {},
		activeToolCalls: {},
		backgroundWork: {},
	};
}

export function normalizeState(raw: unknown): GoalState | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Partial<GoalState>;
	if (
		value.schemaVersion !== GOAL_SCHEMA_VERSION ||
		typeof value.goalId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.cwd !== "string" ||
		!value.outcome ||
		!Array.isArray(value.criteria) ||
		!Array.isArray(value.plan)
	) return undefined;
	value.generation = Number.isInteger(value.generation) ? value.generation : 1;
	value.revision = Number.isInteger(value.revision) ? value.revision : 0;
	value.verificationChecks = Array.isArray(value.verificationChecks) ? value.verificationChecks : [];
	value.authorities = Array.isArray(value.authorities) ? value.authorities : [];
	value.evidence = Array.isArray(value.evidence) ? value.evidence : [];
	value.observations = Array.isArray(value.observations) ? value.observations : [];
	value.evaluatorReports = Array.isArray(value.evaluatorReports) ? value.evaluatorReports : [];
	value.auditReports = Array.isArray(value.auditReports) ? value.auditReports : [];
	value.repeatedToolCalls = value.repeatedToolCalls ?? {};
	value.repeatedBlockers = value.repeatedBlockers ?? {};
	value.activeToolCalls = {};
	value.backgroundWork = value.backgroundWork ?? {};
	value.continuationSequence = Number.isInteger(value.continuationSequence) ? value.continuationSequence : 0;
	value.turnCount = value.turnCount ?? 0;
	value.recoveryCount = value.recoveryCount ?? 0;
	value.auditFailureCount = value.auditFailureCount ?? 0;
	value.verificationFailureCount = value.verificationFailureCount ?? 0;
	value.noProgressCount = value.noProgressCount ?? 0;
	value.completionCandidate = !!value.completionCandidate;
	return value as GoalState;
}

export function progress(state: GoalState): { done: number; total: number; met: number; criteria: number } {
	return {
		done: state.plan.filter((node) => node.status === "done" || node.status === "skipped").length,
		total: state.plan.length,
		met: state.criteria.filter((criterion) => criterion.status === "met" || criterion.status === "waived").length,
		criteria: state.criteria.length,
	};
}

export function progressMarker(state: GoalState): string {
	const current = state.plan.find((node) => node.status === "in_progress")?.id ?? "none";
	return `${state.evidence.length}:${progress(state).done}:${progress(state).met}:${current}`;
}

export class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T> | T): Promise<T> {
		let release!: () => void;
		const previous = this.tail;
		this.tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, content, { mode: 0o600 });
	renameSync(temporary, path);
}

export class GoalStore {
	private state?: GoalState;
	private loadedKey?: string;
	private readonly pi: ExtensionAPI;
	private readonly agentDir: string;

	constructor(pi: ExtensionAPI, agentDir: string) {
		this.pi = pi;
		this.agentDir = agentDir;
	}

	private key(ctx: ExtensionContext): string {
		return `${ctx.sessionManager.getSessionId()}\u0000${ctx.cwd}`;
	}

	private sessionDir(ctx: ExtensionContext): string {
		const id = sha256(ctx.sessionManager.getSessionId()).slice(0, 24);
		return join(this.agentDir, "pi-goal", "sessions", id);
	}

	private statePath(ctx: ExtensionContext): string {
		return join(this.sessionDir(ctx), "state.json");
	}

	load(ctx: ExtensionContext): GoalState | undefined {
		const key = this.key(ctx);
		if (this.loadedKey === key) return this.state;
		this.loadedKey = key;
		const latest = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) as { data?: unknown } | undefined;
		const expectedSessionId = ctx.sessionManager.getSessionId();
		const sameContext = (state: GoalState | undefined): state is GoalState =>
			!!state && state.sessionId === expectedSessionId && state.cwd === ctx.cwd;
		const branchState = normalizeState(latest?.data === undefined ? undefined : structuredClone(latest.data));
		let mirrorState: GoalState | undefined;
		const path = this.statePath(ctx);
		if (existsSync(path)) {
			try { mirrorState = normalizeState(JSON.parse(readFileSync(path, "utf8"))); }
			catch (error) { console.warn(`[pi-goal] ignored malformed state ${path}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		const branchCandidate = sameContext(branchState) ? branchState : undefined;
		const mirrorCandidate = sameContext(mirrorState) ? mirrorState : undefined;
		this.state = mirrorCandidate && (!branchCandidate || mirrorCandidate.revision > branchCandidate.revision)
			? mirrorCandidate
			: branchCandidate;
		return this.state;
	}

	get(): GoalState | undefined {
		return this.state;
	}

	set(state: GoalState | undefined): void {
		this.state = state;
	}

	persist(ctx: ExtensionContext, type: string, summary: string): GoalState {
		if (!this.state) throw new Error("No goal state to persist");
		this.state.revision += 1;
		this.state.updatedAt = now();
		this.state.observations = this.state.observations.slice(-250);
		this.state.evidence = this.state.evidence.slice(-500);
		this.state.evaluatorReports = this.state.evaluatorReports.slice(-100);
		this.state.auditReports = this.state.auditReports.slice(-50);
		const safeSummary = redactText(summary, 300).text;
		atomicWrite(this.statePath(ctx), `${JSON.stringify(this.state, null, 2)}\n`);
		atomicWrite(join(this.sessionDir(ctx), "evidence.json"), `${JSON.stringify(this.state.evidence, null, 2)}\n`);
		const event: GoalEventRecord = {
			schemaVersion: GOAL_SCHEMA_VERSION,
			goalId: this.state.goalId,
			sessionId: this.state.sessionId,
			revision: this.state.revision,
			type,
			summary: safeSummary,
			at: this.state.updatedAt,
		};
		mkdirSync(this.sessionDir(ctx), { recursive: true, mode: 0o700 });
		appendFileSync(join(this.sessionDir(ctx), "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
		atomicWrite(join(this.agentDir, "pi-goal", "current", "index.json"), `${JSON.stringify({
			schemaVersion: GOAL_SCHEMA_VERSION,
			goalId: this.state.goalId,
			sessionId: this.state.sessionId,
			cwd: this.state.cwd,
			status: this.state.status,
			revision: this.state.revision,
			updatedAt: this.state.updatedAt,
		}, null, 2)}\n`);
		this.pi.appendEntry(STATE_CUSTOM_TYPE, this.state);
		return this.state;
	}

	flush(ctx: ExtensionContext, reason = "flush"): void {
		if (!this.state) return;
		this.state.revision += 1;
		this.state.updatedAt = now();
		atomicWrite(this.statePath(ctx), `${JSON.stringify(this.state, null, 2)}\n`);
		atomicWrite(join(this.sessionDir(ctx), "evidence.json"), `${JSON.stringify(this.state.evidence, null, 2)}\n`);
		atomicWrite(join(this.agentDir, "pi-goal", "current", "index.json"), `${JSON.stringify({
			schemaVersion: GOAL_SCHEMA_VERSION,
			goalId: this.state.goalId,
			sessionId: this.state.sessionId,
			cwd: this.state.cwd,
			status: this.state.status,
			revision: this.state.revision,
			updatedAt: this.state.updatedAt,
		}, null, 2)}\n`);
		const event: GoalEventRecord = {
			schemaVersion: GOAL_SCHEMA_VERSION,
			goalId: this.state.goalId,
			sessionId: this.state.sessionId,
			revision: this.state.revision,
			type: "checkpoint_flushed",
			summary: redactText(reason, 300).text,
			at: this.state.updatedAt,
		};
		mkdirSync(this.sessionDir(ctx), { recursive: true, mode: 0o700 });
		appendFileSync(join(this.sessionDir(ctx), "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
	}
}
