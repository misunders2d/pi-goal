import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalStore, createGoalState, isSensitivePath, isWithinWorkspace, normalizeState, normalizeWorkspaceRoots, redactText, resolvedPathWithinWorkspaces, sha256, validateDag } from "../src/state.ts";
import type { GoalDraft } from "../src/types.ts";

function fakeContext(cwd: string, branch: any[] = []) {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branch,
		},
	} as any;
}

const draft: GoalDraft = {
	outcome: "Build the complete product",
	criteria: ["Tests pass", "Package loads"],
	phases: [
		{ id: "P1", title: "Implement", criterionIds: ["AC1"] },
		{ id: "P2", title: "Verify", dependsOn: ["P1"], criterionIds: ["AC2"] },
	],
	verificationChecks: [{ id: "V1", kind: "file_exists", label: "manifest", path: "package.json" }],
	authorities: [],
	constraints: [],
	nonGoals: [],
};

test("creates a deterministic complete state shape", () => {
	const state = createGoalState(draft, fakeContext("/tmp/work"));
	assert.equal(state.status, "awaiting_approval");
	assert.equal(state.phase, "setup");
	assert.equal(state.plan.filter((node) => node.status === "in_progress").length, 1);
	assert.deepEqual(state.plan[1]?.dependsOn, ["P1"]);
	assert.equal(state.criteria.length, 2);
});

test("criterion references accept Cn aliases and reject unknown IDs instead of dropping them", () => {
	const aliased = createGoalState({ ...draft, phases: [{ id: "P1", title: "Implement", criterionIds: ["C1", "ac2", "C1"] }] }, fakeContext("/tmp/work"));
	assert.deepEqual(aliased.plan[0].criterionIds, ["AC1", "AC2"]);
	assert.throws(
		() => createGoalState({ ...draft, phases: [{ id: "P1", title: "Implement", criterionIds: ["BAD"] }] }, fakeContext("/tmp/work")),
		/Unknown criterion IDs: BAD.*Valid criteria: AC1, AC2/,
	);
});

test("planned roots remain exact and fail closed after symlink substitution", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-planned-root-"));
	try {
		const primary = join(root, "primary"); mkdirSync(primary);
		const planned = join(root, "planned");
		assert.deepEqual(normalizeWorkspaceRoots(primary, [planned]), [primary, planned]);
		assert.equal(resolvedPathWithinWorkspaces(primary, [primary, planned], join(planned, "artifact.txt")), join(planned, "artifact.txt"));
		const outside = join(root, "outside"); mkdirSync(outside);
		symlinkSync(outside, planned);
		assert.equal(resolvedPathWithinWorkspaces(primary, [primary, planned], join(planned, "artifact.txt")), undefined);
		const raw: any = createGoalState(draft, fakeContext(primary));
		raw.workspaceRoots = [primary, planned];
		const restored = normalizeState(raw)!;
		assert.equal(restored.status, "interrupted");
		assert.equal(restored.phase, "blocked");
		assert.deepEqual(restored.workspaceRoots, [primary, "/"]);
		assert.match(restored.interrupt?.message ?? "", /canonical revalidation/);
		assert.equal(resolvedPathWithinWorkspaces(primary, restored.workspaceRoots, join(primary, "still-denied.txt")), undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("planned root below a symlinked ancestor is rejected", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-planned-root-alias-"));
	try {
		const primary = join(root, "primary"); const outside = join(root, "outside"); mkdirSync(primary); mkdirSync(outside);
		const alias = join(root, "alias"); symlinkSync(outside, alias);
		assert.throws(() => normalizeWorkspaceRoots(primary, [join(alias, "planned")]), /canonical non-symlink path/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("preserves the complete authoritative user request separately from planner outcome", () => {
	const original = `Original request:\n${"Exact requirement. ".repeat(300)}`;
	const state = createGoalState({ ...draft, outcome: "Planner contract summary" }, fakeContext("/tmp/work"), original);
	assert.ok(original.length > 2_000);
	assert.equal(state.outcome.original, original);
	assert.equal(state.outcome.current, "Planner contract summary");
});

test("DAG validation rejects missing dependencies, cycles, and multiple active nodes", () => {
	const at = new Date().toISOString();
	const node = (id: string, dependsOn: string[], status: any = "pending") => ({ id, title: id, status, dependsOn, criterionIds: [], evidenceIds: [], createdAt: at, updatedAt: at });
	assert.match(validateDag([node("A", ["missing"])])[0]!, /missing/);
	assert.ok(validateDag([node("A", ["B"]), node("B", ["A"])]).some((error) => error.includes("cycle")));
	assert.ok(validateDag([node("A", [], "in_progress"), node("B", [], "in_progress")]).some((error) => error.includes("at most one")));
});

test("schema-1 normalization preserves legacy blocker counters and defaults new recovery fields", () => {
	const raw: any = createGoalState(draft, fakeContext("/tmp/work"));
	raw.repeatedBlockers = { legacy: 2 };
	delete raw.recoveryEvidence;
	delete raw.auditRejectionRepeatCount;
	delete raw.auditExecutionRepeatCount;
	delete raw.workspaceRoots;
	delete raw.lastRejectedAuditInputFingerprint;
	delete raw.setupSubmissionFailureCount;
	delete raw.setupSubmissionFailureRepeatCount;
	delete raw.lastSetupSubmissionFailureFingerprint;
	delete raw.setupSubmissionDiagnostic;
	delete raw.plan[0].commands;
	const restored = normalizeState(raw)!;
	assert.deepEqual(restored.repeatedBlockers, { legacy: 2 });
	assert.deepEqual(restored.recoveryEvidence, []);
	assert.equal(restored.auditRejectionRepeatCount, 0);
	assert.equal(restored.auditExecutionRepeatCount, 0);
	assert.deepEqual(restored.workspaceRoots, ["/tmp/work"]);
	assert.equal(restored.setupSubmissionFailureCount, 0);
	assert.equal(restored.setupSubmissionFailureRepeatCount, 0);
	assert.equal(restored.lastSetupSubmissionFailureFingerprint, undefined);
	assert.equal(restored.setupSubmissionDiagnostic, undefined);
	assert.deepEqual(restored.plan[0].commands, []);
	delete raw.repeatedBlockers;
	assert.deepEqual(normalizeState(raw)!.repeatedBlockers, {});
});

test("schema-1 normalization restores capped setup as awaiting user", () => {
	const raw: any = createGoalState(draft, fakeContext("/tmp/work"));
	raw.status = "setting_up";
	raw.phase = "setup";
	raw.setupAwaitingUser = false;
	raw.setupSubmissionFailureCount = 2;
	raw.setupSubmissionFailureRepeatCount = 2;
	const restored = normalizeState(raw)!;
	assert.equal(restored.setupAwaitingUser, true);
});

test("schema-1 normalization rebuilds criterion evidence links from canonical evidence", () => {
	const raw: any = createGoalState(draft, fakeContext("/tmp/work"));
	raw.evidence.push({ id: "e1", kind: "tool_result", summary: "first proof", criterionIds: ["AC1", "BAD", "AC1"], paths: [], createdAt: new Date().toISOString() });
	raw.evidence.push({ id: "e2", kind: "test_result", summary: "second proof", criterionIds: ["AC2"], paths: [], createdAt: new Date().toISOString() });
	raw.criteria[0].evidenceIds = [];
	raw.criteria[1].evidenceIds = ["stale"];
	const restored = normalizeState(raw)!;
	assert.deepEqual(restored.criteria[0].evidenceIds, ["e1"]);
	assert.deepEqual(restored.criteria[1].evidenceIds, ["e2"]);
});

test("redaction and path boundaries fail closed", () => {
	const value = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
	assert.equal(value.redacted, true);
	assert.doesNotMatch(value.text, /abcdefghijklmnopqrstuvwxyz/);
	assert.equal(isSensitivePath("/tmp/.env.production"), true);
	assert.equal(isSensitivePath("/home/u/.ssh/id_ed25519"), true);
	assert.equal(isWithinWorkspace("/tmp/work", "src/a.ts"), true);
	assert.equal(isWithinWorkspace("/tmp/work", "../secret"), false);
});

test("store mirrors atomically and restores only the same session/cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-state-"));
	try {
		const workspace = join(root, "workspace");
		const branch: any[] = [];
		const ctx = fakeContext(workspace, branch);
		const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as any;
		const store = new GoalStore(pi, join(root, "agent"));
		store.set(createGoalState(draft, ctx));
		store.persist(ctx, "test", "Bearer abcdefghijklmnopqrstuvwxyz123456");
		const eventPath = join(root, "agent", "pi-goal", "sessions");
		const eventText = readFileSync(join(eventPath, sha256("session-1").slice(0, 24), "events.jsonl"), "utf8");
		assert.doesNotMatch(eventText, /abcdefghijklmnopqrstuvwxyz/);
		const restored = new GoalStore(pi, join(root, "agent")).load(ctx);
		assert.equal(restored?.goalId, store.get()?.goalId);
		const staleRevision = restored!.revision;
		store.get()!.continuationSequence = 41;
		store.flush(ctx, "shutdown checkpoint");
		const freshest = new GoalStore(pi, join(root, "agent")).load(ctx);
		assert.equal(freshest?.continuationSequence, 41);
		assert.ok(freshest!.revision > staleRevision);
		const foreign = fakeContext(join(root, "other"), branch);
		assert.equal(new GoalStore(pi, join(root, "agent")).load(foreign), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
