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
		const setup = setupContent(state(), width);
		const detail = detailContent(state(), width);
		assert.ok(setup.some((line) => line.includes("Outcome")));
		assert.ok(setup.some((line) => line.includes("After approval")));
		assert.ok(setup.some((line) => line.includes("CREDENTIAL")));
		assert.ok(detail.some((line) => line.includes("Now / next")));
		assert.ok(detail.some((line) => line.includes("Controls")));
		assert.ok(Math.max(...setup.map((line) => line.length)) < width * 1.5, `setup has gross overflow at ${width}`);
	}
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

	const blocker = state();
	blocker.status = "interrupted";
	blocker.interrupt = { class: "BLOCKER", message: "Retry needed", attempts: ["Recovered"], need: "Retry", recommendation: "Resume", signature: "b", createdAt: new Date().toISOString() };
	const blockerText = detailContent(blocker, 80).join("\n");
	assert.match(blockerText, /P resume without changing the approved contract/);
	assert.match(blockerText, /R provide blocker resolution/);
});
