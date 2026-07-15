import assert from "node:assert/strict";
import test from "node:test";
import { createGoalState } from "../src/state.ts";
import { detailContent, panelLayout, setupContent } from "../src/ui.ts";
import type { GoalDraft } from "../src/types.ts";

const draft: GoalDraft = {
	outcome: "Create a complete autonomous goal mode with a very long outcome that must remain readable in narrow terminals",
	criteria: ["One approval starts work", "Independent audit proves completion"],
	phases: [{ id: "P1", title: "Implement durable state" }, { id: "P2", title: "Verify everything", dependsOn: ["P1"] }],
	verificationChecks: [{ id: "V1", kind: "file_exists", label: "Package manifest exists", path: "package.json" }],
	authorities: [], constraints: [], nonGoals: [],
};

function state() {
	return createGoalState(draft, { cwd: "/tmp/workspace", sessionManager: { getSessionId: () => "s" } } as any);
}

test("setup and detail content remain useful at narrow, medium, and wide widths", () => {
	for (const width of [44, 90, 140]) {
		const proposed = state();
		proposed.authorities.push({ id: "A1", label: "Run exact tests", actionClass: "local_process", toolName: "bash", targets: [{ path: "cwd", equals: proposed.cwd }], command: { executable: "node", argsPrefix: ["--test"], trailingArgs: "workspace_paths" }, inputHash: "abc123", maxUses: 2, uses: 0, expiresAt: "2030-01-01T00:00:00.000Z" });
		const setup = setupContent(proposed, width);
		const detail = detailContent(state(), width);
		assert.ok(setup.some((line) => line.includes("Outcome")));
		assert.ok(setup.some((line) => line.includes("After approval")));
		assert.ok(setup.some((line) => line.includes("CREDENTIAL")));
		const setupText = setup.join("\n");
		assert.match(setupText, /class=local_process/);
		assert.match(setupText, /command=node\s+argvPrefix=/);
		assert.match(setupText, /targets=cwd=/);
		assert.match(setupText, /inputHash=abc123/);
		assert.match(setupText, /expiresAt=2030/);
		assert.ok(detail.some((line) => line.includes("Now / next")));
		assert.ok(detail.some((line) => line.includes("Controls")));
		assert.ok(Math.max(...setup.map((line) => line.length)) < width * 1.5, `setup has gross overflow at ${width}`);
	}
});

test("detail content surfaces actionable audit rejection diagnostics", () => {
	const rejected = state();
	rejected.status = "running";
	rejected.phase = "recovering";
	rejected.auditRejectionRepeatCount = 1;
	rejected.auditReports.push({
		id: "audit-1",
		verdict: "fail",
		reason: "Package loading was not demonstrated",
		criterionResults: [{ criterionId: "AC2", status: "failed", evidenceIds: [], note: "No package-load result" }],
		missingCriteria: ["AC2"],
		diagnostic: {
			code: "AUDIT_REJECTED",
			message: "Package loading was not demonstrated",
			missingCriteria: ["AC2"],
			gaps: [{ criterionId: "AC2", criterionText: "Independent audit proves completion", status: "failed", evidenceIds: [], note: "No package-load result", code: "criterion_missing", suggestedAction: "Record direct package-load evidence" }],
			failedCheckIds: [],
			suggestedAction: "Record direct package-load evidence",
			fingerprint: "fingerprint",
		},
		createdAt: new Date().toISOString(),
	});
	const text = detailContent(rejected, 80).join("\n");
	assert.match(text, /Latest audit rejection/);
	assert.match(text, /AUDIT_REJECTED/);
	assert.match(text, /AC2 criterion_missing/);
	assert.match(text, /Record direct package-load\s+evidence/);
	assert.match(text, /only after material evidence/);
});

test("setup and detail expose approved roots and bounded audit execution failure", () => {
	const value = state();
	value.workspaceRoots.push("/media/example/repo");
	value.auditExecution = { code: "AUDIT_TIMEOUT", stage: "prompt", message: "isolated auditor exceeded deadline", elapsedMs: 90000, attemptCount: 1, retryable: false, suggestedAction: "Do not retry unchanged", fingerprint: "audit-fingerprint", createdAt: new Date().toISOString() };
	value.auditExecutionRepeatCount = 1;
	const setup = setupContent(value, 90).join("\n");
	const detail = detailContent(value, 90).join("\n");
	assert.match(setup, /Approved workspace roots/);
	assert.match(setup, /\/media\/example\/repo/);
	assert.match(detail, /Latest audit execution failure/);
	assert.match(detail, /AUDIT_TIMEOUT at prompt/);
	assert.match(detail, /Do not retry unchanged/);
});

test("panel layout fits narrow terminals and avoids unnecessary wide scrolling", () => {
	const narrow = panelLayout(42, 30);
	assert.deepEqual(narrow, { viewport: 25, showIndicator: true, maxBoxRows: 28 });
	assert.equal(narrow.viewport + 1 + 2, narrow.maxBoxRows);
	const wide = panelLayout(29, 45);
	assert.deepEqual(wide, { viewport: 29, showIndicator: false, maxBoxRows: 34 });
	assert.equal(wide.viewport + 2, 31);
	const boundary = panelLayout(26, 30);
	assert.deepEqual(boundary, { viewport: 26, showIndicator: false, maxBoxRows: 28 });
	const tiny = panelLayout(100, 6);
	assert.deepEqual(tiny, { viewport: 1, showIndicator: true, maxBoxRows: 4 });
	assert.equal(tiny.viewport + 1 + 2, tiny.maxBoxRows);
});

test("detail content surfaces interruption controls and resumes only non-RISK blockers", () => {
	const risk = state();
	risk.status = "interrupted";
	risk.interrupt = { class: "RISK", message: "External write needed", attempts: ["Tried local path"], need: "Approval", recommendation: "Approve once", signature: "x", createdAt: new Date().toISOString(), pendingAction: { toolName: "publish", inputHash: "hash", label: "Publish once" } };
	const riskText = detailContent(risk, 80).join("\n");
	assert.match(riskText, /RISK interruption/);
	assert.match(riskText, /Tried:/);
	assert.match(riskText, /Need:/);
	assert.match(riskText, /Recommendation:/);
	assert.match(riskText, /A approve only the displayed pending action once/);
	assert.match(riskText, /not a general resume/);
	assert.match(riskText, /R reject or redirect/);
	assert.doesNotMatch(riskText, /P resume without changing/);
	assert.doesNotMatch(riskText, /P pause/);

	const amendment = state();
	amendment.status = "interrupted";
	amendment.interrupt = { class: "RISK", message: "Add runner", attempts: [], need: "Approval", recommendation: "Review", signature: "a", createdAt: new Date().toISOString(), pendingAuthorityAmendment: { authorities: [{ id: "A1", label: "pytest", actionClass: "local_process", toolName: "bash", targets: [{ path: "cwd", equals: amendment.cwd }], command: { executable: ".venv/bin/pytest", argsPrefix: [], trailingArgs: "any" }, maxUses: 10 }], rationale: "omitted runner", requestedAt: new Date().toISOString(), resumePhase: "executing", resumeCurrentAction: "Implement", resumeNextAction: "Test" } };
	const amendmentText = detailContent(amendment, 80).join("\n");
	assert.match(amendmentText, /Authority amendment: A1: pytest/);
	assert.match(amendmentText, /class=local_process/);
	assert.match(amendmentText, /command=\.venv\/bin\/pytest/);
	assert.match(amendmentText, /targets=cwd=/);
	assert.match(amendmentText, /A approve only the displayed typed authority amendment/);
	assert.doesNotMatch(amendmentText, /P resume without changing/);

	const blocker = state();
	blocker.status = "interrupted";
	blocker.interrupt = { class: "BLOCKER", message: "Retry needed", attempts: ["Recovered"], need: "Retry", recommendation: "Resume", signature: "b", createdAt: new Date().toISOString() };
	const blockerText = detailContent(blocker, 80).join("\n");
	assert.match(blockerText, /P resume without changing the approved contract/);
	assert.match(blockerText, /R provide blocker resolution/);
});
