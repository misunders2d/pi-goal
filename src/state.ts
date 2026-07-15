import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
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

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function canonicalContextPath(path: string): string {
	try { return realpathSync.native(resolve(path)); }
	catch { return resolve(path); }
}

export function normalizeWorkspaceRoots(cwd: string, requested: unknown = []): string[] {
	const primary = canonicalContextPath(cwd);
	const values = Array.isArray(requested) ? requested : [];
	if (values.length > 8) throw new Error("workspace root list exceeds 8 entries");
	const roots = [primary];
	for (const value of values) {
		if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) throw new Error("additional workspace roots must be non-empty absolute paths");
		const lexical = resolve(value);
		if (lexical === resolve(cwd) || canonicalContextPath(lexical) === primary) continue;
		if (lexical === "/") throw new Error("filesystem root cannot be approved as a workspace root");
		if (isSensitivePath(lexical)) throw new Error("sensitive path cannot be approved as a workspace root");
		let canonical: string;
		try {
			if (!statSync(lexical).isDirectory()) throw new Error("workspace root is not a directory");
			canonical = realpathSync.native(lexical);
		} catch (error) {
			throw new Error(`workspace root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (canonical !== lexical) throw new Error("workspace root must use its canonical non-symlink path");
		if (!roots.includes(canonical)) roots.push(canonical);
	}
	if (roots.length > 8) throw new Error("workspace root list exceeds 8 entries");
	return roots;
}

export function workspaceRootForCwd(primaryCwd: string, workspaceRoots: string[] | undefined, candidate: string): string | undefined {
	const roots = normalizeWorkspaceRoots(primaryCwd, workspaceRoots ?? []);
	const canonical = canonicalContextPath(candidate);
	return roots.find((root) => root === canonical);
}

export function isWithinWorkspace(cwd: string, path: string, workspaceRoots?: string[]): boolean {
	return !!resolvedPathWithinWorkspaces(cwd, workspaceRoots ?? [cwd], path);
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

export function resolvedPathWithinWorkspaces(cwd: string, workspaceRoots: string[] | undefined, path: string): string | undefined {
	const roots = normalizeWorkspaceRoots(cwd, workspaceRoots ?? []);
	const lexicalTarget = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	const eligible = isAbsolute(path)
		? roots.filter((root) => within(root, lexicalTarget)).sort((a, b) => b.length - a.length)
		: [roots[0]!].filter((root) => within(root, lexicalTarget));
	const selected = eligible[0];
	if (!selected) return undefined;
	const root = resolvedThroughExistingAncestor(selected);
	const target = resolvedThroughExistingAncestor(lexicalTarget);
	if (!root || !target || !within(root, target)) return undefined;
	return target;
}

export function resolvedPathWithinWorkspace(cwd: string, path: string): string | undefined {
	return resolvedPathWithinWorkspaces(cwd, [cwd], path);
}

export function safeEvidencePath(cwd: string, path: string, workspaceRoots?: string[]): string {
	if (isSensitivePath(path)) return "[sensitive-path-redacted]";
	const resolved = resolvedPathWithinWorkspaces(cwd, workspaceRoots ?? [cwd], path);
	if (!resolved) return "[outside-workspace]";
	if (isSensitivePath(resolved)) return "[sensitive-path-redacted]";
	const primary = canonicalContextPath(cwd);
	return within(primary, resolved) ? relative(primary, resolved) || "." : resolved;
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
		command: authority.command ? { ...authority.command, argsPrefix: [...authority.command.argsPrefix] } : undefined,
	};
}

export function createGoalSetupState(outcome: string, ctx: ExtensionContext): GoalState {
	const at = now();
	const cleaned = redactText(outcome, Number.MAX_SAFE_INTEGER).text;
	return {
		schemaVersion: GOAL_SCHEMA_VERSION,
		goalId: makeId("goal"),
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		workspaceRoots: normalizeWorkspaceRoots(ctx.cwd),
		status: "setting_up",
		phase: "setup",
		generation: 1,
		revision: 0,
		createdAt: at,
		updatedAt: at,
		outcome: { original: cleaned, current: cleaned, amendments: [] },
		criteria: [],
		plan: [],
		verificationChecks: [],
		authorities: [],
		constraints: [],
		nonGoals: [],
		evidence: [],
		observations: [],
		evaluatorReports: [],
		auditReports: [],
		currentAction: "Clarifying goal in this conversation",
		nextAction: "Ask only necessary questions, then submit a complete contract",
		completionCandidate: false,
		continuationSequence: 0,
		turnCount: 0,
		recoveryCount: 0,
		auditFailureCount: 0,
		auditRejectionRepeatCount: 0,
		auditExecutionRepeatCount: 0,
		verificationFailureCount: 0,
		noProgressCount: 0,
		repeatedToolCalls: {},
		repeatedBlockers: {},
		recoveryEvidence: [],
		activeToolCalls: {},
		backgroundWork: {},
		setupAwaitingUser: false,
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
		commands: (phase.commands ?? []).map((command) => ({ ...command, args: [...command.args], actionClasses: command.actionClasses ? [...command.actionClasses] : undefined })),
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
		workspaceRoots: normalizeWorkspaceRoots(ctx.cwd, draft.workspaceRoots),
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
		constraints: draft.constraints.map((item) => redactText(item, 500).text),
		nonGoals: draft.nonGoals.map((item) => redactText(item, 500).text),
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
		auditRejectionRepeatCount: 0,
		auditExecutionRepeatCount: 0,
		verificationFailureCount: 0,
		noProgressCount: 0,
		repeatedToolCalls: {},
		repeatedBlockers: {},
		recoveryEvidence: [],
		activeToolCalls: {},
		backgroundWork: {},
	};
}

export function reconcileCriterionEvidenceIds(state: Pick<GoalState, "criteria" | "evidence">): void {
	const knownCriteria = new Set(state.criteria.map((criterion) => criterion.id));
	const byCriterion = new Map(state.criteria.map((criterion) => [criterion.id, [] as string[]]));
	for (const evidence of state.evidence) {
		for (const criterionId of new Set(evidence.criterionIds)) {
			if (!knownCriteria.has(criterionId)) continue;
			byCriterion.get(criterionId)!.push(evidence.id);
		}
	}
	for (const criterion of state.criteria) criterion.evidenceIds = [...new Set(byCriterion.get(criterion.id) ?? [])];
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
	try { value.workspaceRoots = normalizeWorkspaceRoots(value.cwd, Array.isArray(value.workspaceRoots) ? value.workspaceRoots : []); }
	catch { value.workspaceRoots = normalizeWorkspaceRoots(value.cwd); }
	value.revision = Number.isInteger(value.revision) ? value.revision : 0;
	value.plan = value.plan.map((node) => ({ ...node, commands: Array.isArray(node.commands) ? node.commands : [] }));
	value.verificationChecks = Array.isArray(value.verificationChecks) ? value.verificationChecks : [];
	value.authorities = Array.isArray(value.authorities) ? value.authorities : [];
	value.constraints = Array.isArray(value.constraints) ? value.constraints : [];
	value.nonGoals = Array.isArray(value.nonGoals) ? value.nonGoals : [];
	value.evidence = Array.isArray(value.evidence) ? value.evidence : [];
	value.observations = Array.isArray(value.observations) ? value.observations : [];
	value.evaluatorReports = Array.isArray(value.evaluatorReports) ? value.evaluatorReports : [];
	value.auditReports = Array.isArray(value.auditReports) ? value.auditReports : [];
	value.repeatedToolCalls = value.repeatedToolCalls ?? {};
	value.repeatedBlockers = value.repeatedBlockers ?? {};
	value.recoveryEvidence = Array.isArray(value.recoveryEvidence) ? value.recoveryEvidence : [];
	value.activeToolCalls = {};
	value.backgroundWork = value.backgroundWork ?? {};
	value.continuationSequence = Number.isInteger(value.continuationSequence) ? value.continuationSequence : 0;
	value.turnCount = value.turnCount ?? 0;
	value.recoveryCount = value.recoveryCount ?? 0;
	value.auditFailureCount = value.auditFailureCount ?? 0;
	value.auditRejectionRepeatCount = value.auditRejectionRepeatCount ?? 0;
	value.auditExecutionRepeatCount = value.auditExecutionRepeatCount ?? 0;
	if (!value.auditExecution || typeof value.auditExecution !== "object" || typeof value.auditExecution.code !== "string" || typeof value.auditExecution.fingerprint !== "string") value.auditExecution = undefined;
	if (typeof value.lastAuditExecutionInputFingerprint !== "string") value.lastAuditExecutionInputFingerprint = undefined;
	value.verificationFailureCount = value.verificationFailureCount ?? 0;
	value.noProgressCount = value.noProgressCount ?? 0;
	value.completionCandidate = !!value.completionCandidate;
	value.setupAwaitingUser = !!value.setupAwaitingUser;
	reconcileCriterionEvidenceIds(value as GoalState);
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
		return `${ctx.sessionManager.getSessionId()}\u0000${canonicalContextPath(ctx.cwd)}`;
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
			!!state && state.sessionId === expectedSessionId && canonicalContextPath(state.cwd) === canonicalContextPath(ctx.cwd);
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
		reconcileCriterionEvidenceIds(this.state);
		this.state.evaluatorReports = this.state.evaluatorReports.slice(-100);
		this.state.auditReports = this.state.auditReports.slice(-50);
		this.state.recoveryEvidence = this.state.recoveryEvidence.slice(-250);
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
		reconcileCriterionEvidenceIds(this.state);
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
