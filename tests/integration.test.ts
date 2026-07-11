import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IsolatedModelRunner, SETUP_PLANNER_SYSTEM_PROMPT, normalizeAuditDecision, normalizeDraft, normalizePlanningResult, withDeadline } from "../src/evaluator.ts";
import piGoalExtension, { isExplicitGoalSteeringInput, isInformationalGoalInput, validateAuditCompletion, verificationRecoveryWindow } from "../src/index.ts";
import { SETUP_TRANSCRIPT_CUSTOM_TYPE, STATE_CUSTOM_TYPE, createGoalState, sha256 } from "../src/state.ts";
import type { GoalDraft } from "../src/types.ts";

const draft: GoalDraft = {
	outcome: "Complete integration",
	criteria: ["State is durable"],
	phases: [{ id: "P1", title: "Implement", criterionIds: ["AC1"] }],
	verificationChecks: [{ id: "V1", kind: "file_exists", label: "manifest", path: "package.json" }],
	authorities: [], constraints: [], nonGoals: [],
};

function makeHarness(root: string, mode = "tui") {
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const messages: any[] = [];
	const notifications: any[] = [];
	const statuses: any[] = [];
	const widgets: any[] = [];
	const branch: any[] = [];
	let aborts = 0;
	const bus = new Map<string, Set<(data: unknown) => void>>();
	const pi: any = {
		on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerCommand(name: string, spec: any) { commands.set(name, spec); },
		registerTool(spec: any) { tools.set(spec.name, spec); },
		getAllTools() { return [
			{ name: "read", description: "Read file", parameters: {} },
			{ name: "write", description: "Write file", parameters: {} },
			{ name: "bash", description: "Run command", parameters: {} },
			{ name: "records_create", description: "Create external record", parameters: {} },
			{ name: "job_start", description: "Start one read-only job in the background and return a job ID", parameters: {} },
		]; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
		events: {
			on(channel: string, fn: (data: unknown) => void) { const set = bus.get(channel) ?? new Set(); set.add(fn); bus.set(channel, set); return () => set.delete(fn); },
			emit(channel: string, data: unknown) { for (const fn of bus.get(channel) ?? []) fn(data); },
		},
	};
	piGoalExtension(pi);
	const ctx: any = {
		cwd: join(root, "workspace"), mode, hasUI: mode === "tui", model: undefined, modelRegistry: {},
		isIdle: () => true, hasPendingMessages: () => false, abort: () => { aborts += 1; },
		sessionManager: {
			getSessionId: () => "session-integration",
			getBranch: () => branch,
			buildContextEntries: () => branch,
		},
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			setStatus(id: string, value?: unknown) { statuses.push({ id, value }); },
			setWidget(id: string, value?: unknown, options?: unknown) { widgets.push({ id, value, options }); },
			setWorkingMessage() {},
			theme: { fg: (_color: string, text: string) => text },
			custom: async () => "close", confirm: async () => true, editor: async () => undefined,
		},
	};
	return {
		pi, ctx, branch, commands, tools, messages, notifications, statuses, widgets, get aborts() { return aborts; },
		async emit(name: string, event: any) { const results = []; for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx)); return results; },
		async command(name: string, args: string) { return commands.get(name).handler(args, ctx); },
		async tool(name: string, params: any) { return tools.get(name).execute(`${name}-call`, params, undefined, undefined, ctx); },
	};
}

function injectRunning(harness: ReturnType<typeof makeHarness>) {
	const state = createGoalState(draft, harness.ctx);
	state.status = "running"; state.phase = "executing"; state.approvedAt = new Date().toISOString();
	harness.branch.push({ type: "custom", customType: STATE_CUSTOM_TYPE, data: state });
	return state;
}

function latestState(harness: ReturnType<typeof makeHarness>) {
	return harness.branch.filter((entry) => entry.customType === STATE_CUSTOM_TYPE).at(-1).data;
}

function goalArtifact(root: string, name: "state.json" | "events.jsonl" | "evidence.json"): string {
	const sessionKey = sha256("session-integration").slice(0, 24);
	return join(root, "agent", "pi-goal", "sessions", sessionKey, name);
}

test("registers only canonical /goal and rejects noninteractive starts", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root, "print");
		assert.equal(harness.commands.has("goal"), true);
		assert.equal(harness.commands.has("plan"), false);
		await harness.command("goal", "Do work");
		assert.match(harness.notifications.at(-1).message, /requires interactive Pi TUI/);
		assert.equal(harness.branch.length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("goal setup immediately shows persistent planning feedback", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const pending = harness.command("goal", "Check system health");
		assert.match(JSON.stringify(harness.statuses), /designing/);
		assert.match(JSON.stringify(harness.widgets), /Checking clarity and designing goal contract/);
		assert.match(JSON.stringify(harness.widgets), /ask before creating the contract/);
		await pending;
		assert.match(harness.notifications.at(-1).message, /requires an active model/);
		assert.equal(harness.widgets.at(-1).value, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("planner requests clarification without workspace tools", async () => {
	const runner = new IsolatedModelRunner("/tmp/pi-goal-test-agent");
	let options: any;
	(runner as any).run = async (value: unknown) => {
		options = value;
		return JSON.stringify({ status: "needs_clarification", questions: ["Which goal-mode lifecycle should be tested?"] });
	};
	const result = await runner.plan({ cwd: "/tmp/workspace", sessionManager: { buildContextEntries: () => [] } } as any, "testing the goal mode", []);
	assert.deepEqual(result, { kind: "clarification", questions: ["Which goal-mode lifecycle should be tested?"] });
	assert.deepEqual(options.tools, []);
	assert.match(options.systemPrompt, /Never infer unclear intent by inspecting the workspace/);
});

test("planner clarifies explicitly contradictory requirements without tools", async () => {
	const runner = new IsolatedModelRunner("/tmp/pi-goal-test-agent");
	const input = "Create conflict.txt; the final file must both exist with READY content and not exist.";
	let options: any;
	(runner as any).run = async (value: any) => {
		options = value;
		assert.equal(JSON.parse(value.prompt).userOutcome, input);
		return JSON.stringify({ status: "needs_clarification", questions: ["Should conflict.txt exist with READY content, or should its final state be absent?"] });
	};
	const result = await runner.plan({ cwd: "/tmp/workspace", sessionManager: { buildContextEntries: () => [] } } as any, input, [{ name: "read", description: "Read file", parameters: {} } as any]);
	assert.deepEqual(result, { kind: "clarification", questions: ["Should conflict.txt exist with READY content, or should its final state be absent?"] });
	assert.deepEqual(options.tools, []);
	assert.match(options.systemPrompt, /If multiple materially different contracts are plausible/);
});

test("planner preserves long authoritative setup text without silent truncation", async () => {
	const runner = new IsolatedModelRunner("/tmp/pi-goal-test-agent");
	const outcome = `Build the complete target.\n${"Detailed requirement with exact semantics. ".repeat(180)}`;
	const answer = `Clarification answer:\n${"Preserve this answered detail. ".repeat(100)}`;
	let payload: any;
	(runner as any).run = async (value: any) => {
		payload = JSON.parse(value.prompt);
		return JSON.stringify({ status: "needs_clarification", questions: ["One final question?"] });
	};
	await runner.plan({ cwd: "/tmp/workspace", model: { contextWindow: 128_000 }, sessionManager: { buildContextEntries: () => [] } } as any, outcome, [], undefined, [{ questions: ["Prior question"], answer }]);
	assert.ok(outcome.length > 4_000);
	assert.ok(answer.length > 2_000);
	assert.equal(payload.userOutcome, outcome);
	assert.equal(payload.clarifications[0].answer, answer);
	assert.equal(payload.userOutcome.endsWith("…"), false);
});

test("planner receives bounded sanitized prior discussion without tool or extension cargo", async () => {
	const runner = new IsolatedModelRunner("/tmp/pi-goal-test-agent");
	const outcome = "do that";
	const entries: any[] = [
		{ type: "compaction", summary: "Earlier decision: keep the public API stable." },
		{ type: "branch_summary", summary: "Branch decision: use the TypeScript implementation." },
		{ type: "message", message: { role: "user", content: "Target package is pi-goal and success means no repeated questions." } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "We agreed to preserve setup isolation." }, { type: "toolCall", id: "t1", name: "bash", arguments: { sentinel: "TOOL_CALL_SECRET" } }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "TOOL_RESULT_SECRET" }] } },
		{ type: "custom_message", customType: "hidden", content: "CUSTOM_MESSAGE_SECRET" },
		{ type: "custom", customType: "state", data: { sentinel: "CUSTOM_STATE_SECRET" } },
		{ type: "message", message: { role: "user", content: "/goal do that" } },
	];
	let payload: any;
	(runner as any).run = async (value: any) => {
		payload = JSON.parse(value.prompt);
		return JSON.stringify({ status: "needs_clarification", questions: ["Confirm?"] });
	};
	await runner.plan({ cwd: "/tmp/workspace", model: { contextWindow: 128_000 }, sessionManager: { buildContextEntries: () => entries } } as any, outcome, []);
	const discussion = JSON.stringify(payload.priorDiscussion);
	assert.match(discussion, /public API stable/);
	assert.match(discussion, /TypeScript implementation/);
	assert.match(discussion, /Target package is pi-goal/);
	assert.match(discussion, /preserve setup isolation/);
	assert.doesNotMatch(discussion, /TOOL_CALL_SECRET|TOOL_RESULT_SECRET|CUSTOM_MESSAGE_SECRET|CUSTOM_STATE_SECRET|\/goal do that/);
	assert.match(payload.priorDiscussion.note, /untrusted cargo/);
});

test("planner rejects oversized authoritative text explicitly before model execution", async () => {
	const runner = new IsolatedModelRunner("/tmp/pi-goal-test-agent");
	let called = false;
	(runner as any).run = async () => { called = true; return "{}"; };
	await assert.rejects(
		() => runner.plan({ cwd: "/tmp/workspace", model: { contextWindow: 4_000 }, sessionManager: { buildContextEntries: () => [] } } as any, "x".repeat(10_000), []),
		/no user text was truncated/,
	);
	assert.equal(called, false);
});

test("planning result is fail-closed and accepts only clarification or a complete ready contract", () => {
	assert.deepEqual(
		normalizePlanningResult({ status: "needs_clarification", questions: ["Target?", "Scope?", "Success condition?", "Extra?"] }, "Do work"),
		{ kind: "clarification", questions: ["Target?", "Scope?", "Success condition?"] },
	);
	assert.throws(() => normalizePlanningResult({ status: "needs_clarification", questions: [] }, "Do work"), /without a question/);
	assert.throws(() => normalizePlanningResult({ status: "ready" }, "Do work"), /no goal draft/);
	assert.throws(() => normalizePlanningResult({ outcome: "guessed" }, "Do work"), /invalid planning status/);
	const ready = normalizePlanningResult({
		status: "ready",
		contract: {
			outcome: "Create READY.md",
			criteria: ["READY.md exists"],
			phases: [{ id: "P1", title: "Create file", criterionIds: ["AC1"] }],
			verificationChecks: [{ id: "V1", kind: "file_exists", label: "READY.md exists", path: "READY.md" }],
			authorities: [], constraints: [], nonGoals: [],
		},
	}, "Create READY.md");
	assert.equal(ready.kind, "draft");
});

test("ambiguous goal setup asks before creating or persisting a contract", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	const originalPlan = IsolatedModelRunner.prototype.plan;
	try {
		const harness = makeHarness(root);
		let calls = 0;
		IsolatedModelRunner.prototype.plan = async (_ctx, _outcome, _tools, _refinement, clarifications = []) => {
			calls += 1;
			assert.equal(harness.branch.length, 0, "setup state must not persist before clarification completes");
			if (!clarifications.length) return { kind: "clarification", questions: ["Which goal-mode lifecycle should be tested?"] };
			assert.equal(clarifications[0]?.answer, "Full end-to-end lifecycle");
			return { kind: "draft", draft };
		};
		harness.ctx.ui.editor = async (_title: string, prefilled: string) => `${prefilled}Full end-to-end lifecycle`;
		harness.ctx.ui.custom = async () => "cancel";
		await harness.command("goal", "testing the goal mode");
		assert.equal(calls, 2);
		assert.match(JSON.stringify(harness.widgets), /Goal clarification needed/);
		assert.equal(latestState(harness).status, "cancelled");
	} finally {
		IsolatedModelRunner.prototype.plan = originalPlan;
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed clarification setup persists a copyable sanitized transcript and bare goal reopens it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	const originalPlan = IsolatedModelRunner.prototype.plan;
	try {
		const harness = makeHarness(root);
		let plannerCalls = 0;
		let transcriptOpens = 0;
		let lastTranscriptText = "";
		IsolatedModelRunner.prototype.plan = async () => {
			plannerCalls += 1;
			return { kind: "clarification", questions: [`Question for round ${plannerCalls}?`] };
		};
		harness.ctx.ui.editor = async (title: string, prefilled: string) => {
			if (title.startsWith("Goal setup transcript")) { transcriptOpens += 1; lastTranscriptText = prefilled; return undefined; }
			return `${prefilled}Answer ${plannerCalls} with ghp_abcdefghijklmnopqrstuvwxyz1234`;
		};
		await harness.command("goal", "Diagnose setup without losing the final sentinel FINAL-SETUP-SENTINEL");
		assert.equal(plannerCalls, 3);
		assert.equal(harness.branch.some((entry) => entry.customType === STATE_CUSTOM_TYPE), false);
		const transcriptEntries = harness.branch.filter((entry) => entry.customType === SETUP_TRANSCRIPT_CUSTOM_TYPE);
		assert.equal(transcriptEntries.length, 1);
		const transcript = transcriptEntries[0].data;
		assert.equal(transcript.status, "failed");
		assert.equal(transcript.exchanges.length, 3);
		assert.match(transcript.outcome, /FINAL-SETUP-SENTINEL/);
		assert.doesNotMatch(JSON.stringify(transcript), /ghp_abcdefghijklmnopqrstuvwxyz1234/);
		assert.match(JSON.stringify(transcript), /\[REDACTED\]/);
		assert.equal(transcriptOpens, 1);
		assert.match(lastTranscriptText, /Clarification round 3/);
		await harness.command("goal", "");
		assert.equal(transcriptOpens, 2);
		assert.match(lastTranscriptText, /Question for round 1/);
	} finally {
		IsolatedModelRunner.prototype.plan = originalPlan;
		rmSync(root, { recursive: true, force: true });
	}
});

test("restores running state, injects it every turn, and blocks out-of-workspace mutation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const context = (await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "x" })).find(Boolean);
		assert.match(JSON.stringify(context), /GOAL MODE ACTIVE/);
		assert.match(JSON.stringify(context), new RegExp(initial.goalId));
		const allowed = (await harness.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "w1", input: { path: "src/a.ts", content: "x" } })).find(Boolean);
		assert.equal(allowed, undefined);
		const blocked = (await harness.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "w2", input: { path: "../outside", content: "x" } })).find(Boolean);
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /Goal blocked unapproved action/);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.phase, "recovering");
		assert.equal(persisted.interrupt, undefined);
		assert.equal(persisted.deferredRisk.toolName, "write");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("complex verification shell soft-denies without user interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const messagesBefore = harness.messages.length;
		const currentActionBefore = latestState(harness).currentAction;
		const command = "test -f READY.md && printf 'exists '; wc -c < READY.md && grep -qx 'READY' READY.md";
		const blocked = (await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "b1", input: { command } })).find(Boolean);
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /Goal recoverable denial/);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.phase, "executing");
		assert.equal(persisted.currentAction, currentActionBefore);
		assert.equal(persisted.interrupt, undefined);
		assert.equal(harness.messages.length, messagesBefore);
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "safe-read", input: { path: "READY.md" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: persisted.goalId, generation: persisted.generation, summary: "safe typed fallback succeeded", criterionIds: ["AC1"] });
		assert.equal(latestState(harness).phase, "executing");
		assert.equal(latestState(harness).plan[0].status, "done");
		const events = readFileSync(goalArtifact(root, "events.jsonl"), "utf8");
		assert.match(events, /tool_soft_denied/);
		assert.doesNotMatch(events, /printf 'exists '/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepted evidence reconciles a stale non-verification recovery phase", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const state = injectRunning(harness);
		state.phase = "recovering";
		state.currentAction = "Recovering from refused tool shape";
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "safe-read", input: { path: "READY.md" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: state.goalId, generation: state.generation, summary: "safe progress", criterionIds: ["AC1"] });
		const persisted = latestState(harness);
		assert.equal(persisted.phase, "executing");
		assert.equal(persisted.plan[0].status, "done");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("private and secret reads soft-deny without persisting sensitive input", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const privateFile = join(root, "agent", "pi-goal", "sessions", "any", "state.json");
		const privateBlocked = (await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "private", input: { path: privateFile } })).find(Boolean);
		assert.match(privateBlocked.reason, /recoverable denial/);
		assert.equal(latestState(harness).interrupt, undefined);
		const secret = "not-a-real-secret-DO-NOT-PERSIST";
		const secretBlocked = (await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "secret", input: { api_token: secret } })).find(Boolean);
		assert.match(secretBlocked.reason, /recoverable denial/);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.interrupt, undefined);
		for (const name of ["state.json", "events.jsonl", "evidence.json"] as const) assert.doesNotMatch(readFileSync(goalArtifact(root, name), "utf8"), new RegExp(secret));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unapproved destructive and external attempts stay blocked while goal recovers autonomously", async () => {
	const cases: Array<[string, string, Record<string, unknown>]> = [
		["complex deletion", "bash", { command: "echo ok; rm -rf dist" }],
		["remote git", "bash", { command: "git push origin main" }],
		["package install", "bash", { command: "npm install" }],
		["outside write", "write", { path: "../outside", content: "x" }],
		["unknown mutation", "records_create", { name: "x" }],
	];
	for (const [label, toolName, input] of cases) {
		const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
		try {
			const harness = makeHarness(root);
			injectRunning(harness);
			await harness.emit("session_start", { type: "session_start", reason: "resume" });
			const blocked = (await harness.emit("tool_call", { type: "tool_call", toolName, toolCallId: `hard-${label}`, input })).find(Boolean);
			assert.equal(blocked.block, true, label);
			assert.match(blocked.reason, /Goal blocked unapproved action/, label);
			const persisted = latestState(harness);
			assert.equal(persisted.status, "running", label);
			assert.equal(persisted.phase, "recovering", label);
			assert.equal(persisted.interrupt, undefined, label);
			assert.equal(persisted.deferredRisk.toolName, toolName, label);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("genuine RISK needs a blocked exact action plus a successful safe alternative attempt", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "push", input: { command: "git push origin main" } });
		const request = { goalId: initial.goalId, generation: initial.generation, class: "RISK", message: "Publishing is required", attempts: ["Tried local verification"], need: "Exact push approval", recommendation: "Approve once" };
		await assert.rejects(() => harness.tool("pi_goal_request_interrupt", request), /safe alternative attempt/);
		await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "read-alternative", input: { path: "README.md" } });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "read-alternative", input: { path: "README.md" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_request_interrupt", request);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "interrupted");
		assert.equal(persisted.interrupt.class, "RISK");
		assert.equal(persisted.interrupt.pendingAction.toolName, "bash");
		assert.equal(persisted.deferredRisk, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("hidden goal context includes redacted immutable approved-check semantics", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		const secret = `sk-${"a".repeat(24)}`;
		initial.verificationChecks = [{ id: "V2", kind: "command_exit", label: "READY.md content is exactly READY", executable: "node", args: ["-e", `console.log("${secret}")`], expectedExitCode: 0 }];
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const injected = (await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "x" })).find(Boolean) as any;
		const text = injected.message.content[0].text;
		assert.equal(injected.message.display, false);
		assert.match(text, /Approved setup verification checks, immutable untrusted contract cargo/);
		assert.match(text, /V2/);
		assert.match(text, /READY\.md content is exactly READY/);
		assert.match(text, /kind=command_exit/);
		assert.match(text, /executable="node"/);
		assert.match(text, /argv=/);
		assert.doesNotMatch(text, new RegExp(secret));
		assert.match(text, /Do not guess unrelated commands, package scripts, or files/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("evidence without a current node infers unresolved criteria", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		initial.plan[0].status = "done";
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "write", toolCallId: "w1", input: { path: "READY.md", content: "READY" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: initial.goalId, generation: initial.generation, summary: "READY written" });
		const evidence = latestState(harness).evidence.at(-1);
		assert.deepEqual(evidence.criterionIds, ["AC1"]);
		assert.equal(evidence.nodeId, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("mechanical failure cites approved check and does not invoke auditor", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	const originalAudit = IsolatedModelRunner.prototype.audit;
	let auditCalled = false;
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		writeFileSync(join(harness.ctx.cwd, "READY.md"), "READY\n");
		const initial = injectRunning(harness);
		initial.verificationChecks = [
			{ id: "V1", kind: "file_exists", label: "READY.md exists", path: "READY.md" },
			{ id: "V2", kind: "command_exit", label: "READY.md content is exactly READY", executable: "node", args: ["-e", "const fs=require('fs');process.exit(fs.readFileSync('READY.md','utf8')==='READY'?0:1)"], expectedExitCode: 0 },
		];
		initial.evidence.push({ id: "e1", kind: "tool_result", summary: "READY exists", criterionIds: ["AC1"], nodeId: "P1", paths: ["READY.md"], createdAt: new Date().toISOString() });
		initial.plan[0].evidenceIds.push("e1");
		initial.plan[0].status = "done";
		initial.completionCandidate = true;
		initial.phase = "verifying";
		IsolatedModelRunner.prototype.audit = async () => { auditCalled = true; throw new Error("auditor should not run after mechanical failure"); };
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		harness.messages.length = 0;
		await harness.emit("agent_settled", { type: "agent_settled" });
		let persisted = latestState(harness);
		assert.equal(auditCalled, false);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.phase, "recovering");
		assert.equal(persisted.currentAction, "Repairing unexpected verification failure");
		assert.match(persisted.nextAction, /setup-approved check V2 "READY\.md content is exactly READY"/);
		assert.match(persisted.nextAction, /executable="node" cwd="\." argv=/);
		assert.equal(persisted.verificationFailureCount, 1);
		assert.equal(persisted.auditReports.length, 0);
		assert.equal(harness.messages.length, 1, "first verification failure must queue autonomous recovery");
		assert.match(JSON.stringify(harness.messages[0]), /Repair the displayed approved check target/);

		const retry = await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "bounded repair attempted" });
		assert.match(retry.content[0].text, /Completion candidate rejected by approved checks/);
		assert.match(retry.content[0].text, /executable="node" cwd="\." argv=/);
		persisted = latestState(harness);
		assert.equal(persisted.status, "interrupted");
		assert.equal(persisted.phase, "blocked");
		assert.equal(persisted.interrupt.class, "BLOCKER");
		assert.match(persisted.interrupt.message, /failed identically after a bounded repair attempt/);
		assert.equal(persisted.verificationFailureCount, 2);
		assert.equal(harness.messages.length, 1, "identical second failure must stop instead of queueing another turn");
		const events = readFileSync(goalArtifact(root, "events.jsonl"), "utf8");
		assert.match(events, /verification_failed/);
		assert.doesNotMatch(events, /audit_rejected/);
	} finally {
		IsolatedModelRunner.prototype.audit = originalAudit;
		rmSync(root, { recursive: true, force: true });
	}
});

test("completion preflight defects stay in execution instead of normalizing recovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-preflight-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const initial = injectRunning(harness);
		initial.evidence.push({ id: "e1", kind: "tool_result", summary: "attempted", criterionIds: ["AC1"], nodeId: "P1", paths: [], createdAt: new Date().toISOString() });
		initial.plan[0].evidenceIds.push("e1"); initial.plan[0].status = "done";
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const result = await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "premature" });
		assert.match(result.content[0].text, /Completion candidate rejected/);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.phase, "executing");
		assert.equal(persisted.currentAction, "Completion preflight rejected");
		assert.equal(persisted.auditFailureCount, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("informational goal questions do not mutate generation or become steering", async () => {
	assert.equal(isInformationalGoalInput('why is it "recovering" again?'), true);
	assert.equal(isInformationalGoalInput("what is the goal status?"), true);
	assert.equal(isInformationalGoalInput("so? is anything happening?"), true);
	assert.equal(isInformationalGoalInput("are you done?"), true);
	assert.equal(isInformationalGoalInput("Also verify documentation"), false);
	assert.equal(isExplicitGoalSteeringInput("steer goal: also add documentation"), true);
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		for (const text of ['why is it "recovering" again?', "so? is anything happening?", "are you done?"]) {
			const results = await harness.emit("input", { type: "input", source: "interactive", text });
			assert.equal(results.find(Boolean), undefined);
		}
		const persisted = latestState(harness);
		assert.equal(persisted.generation, initial.generation);
		assert.equal(persisted.outcome.amendments.length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit-time questions are non-mutating while explicit steering exits auditing atomically", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-audit-input-"));
	try {
		const harness = makeHarness(root);
		const state = createGoalState(draft, harness.ctx);
		state.status = "auditing"; state.phase = "auditing"; state.completionCandidate = true;
		harness.branch.push({ type: "custom", customType: STATE_CUSTOM_TYPE, data: state });
		await harness.emit("input", { type: "input", source: "interactive", text: "so? is anything happening?" });
		let persisted = latestState(harness);
		assert.equal(persisted.generation, state.generation);
		assert.equal(persisted.status, "auditing");
		assert.equal(persisted.outcome.amendments.length, 0);
		await harness.emit("input", { type: "input", source: "interactive", text: "steer goal: add documentation" });
		persisted = latestState(harness);
		assert.equal(persisted.generation, state.generation + 1);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.phase, "planning");
		assert.equal(persisted.completionCandidate, false);
		assert.equal(persisted.outcome.amendments.length, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("isolated model deadline rejects never-resolving work and invokes abort", async () => {
	let aborted = false;
	await assert.rejects(() => withDeadline(new Promise<never>(() => {}), 10, () => { aborted = true; }), /timed out after 10ms/);
	assert.equal(aborted, true);
});

test("verification recovery timeout boundary is deterministic without wall-clock waiting", () => {
	const started = "2026-07-10T00:00:00.000Z";
	const startMs = Date.parse(started);
	assert.deepEqual(verificationRecoveryWindow(started, startMs + 599_999), { elapsedMs: 599_999, timedOut: false });
	assert.deepEqual(verificationRecoveryWindow(started, startMs + 600_000), { elapsedMs: 600_000, timedOut: true });
	assert.deepEqual(verificationRecoveryWindow(undefined, startMs + 600_000), { elapsedMs: 0, timedOut: false });
});

test("stale internal tool generations fail and user steering increments generation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		const initialGeneration = initial.generation;
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await assert.rejects(() => harness.tool("pi_goal_update_plan", { goalId: initial.goalId, generation: initialGeneration + 1, reason: "stale", nodes: [{ id: "P1", title: "x", status: "in_progress" }] }), /Stale goal ID or generation/);
		await harness.emit("input", { type: "input", source: "interactive", text: "Also verify documentation" });
		const result = await harness.tool("pi_goal_status", {});
		const payload = JSON.parse(result.content[0].text);
		assert.equal(payload.generation, initialGeneration + 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("evidence links recent successful observations without exposing tool-call IDs", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "write", toolCallId: "write-hidden-id", input: { path: "README.md", content: "x" }, isError: false, content: [], details: {} });
		const result = await harness.tool("pi_goal_record_evidence", { goalId: initial.goalId, generation: initial.generation, summary: "README created" });
		assert.match(result.content[0].text, /Evidence recorded/);
		const persisted = harness.branch.filter((entry) => entry.customType === STATE_CUSTOM_TYPE).at(-1).data;
		assert.equal(persisted.evidence.length, 1);
		assert.deepEqual(persisted.evidence[0].criterionIds, ["AC1"]);
		assert.equal(persisted.evidence[0].nodeId, "P1");
		assert.equal(persisted.plan[0].status, "done");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("multi-criterion nodes require specific evidence and remain active until all criteria are covered", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const multi = createGoalState({
			outcome: "Prove two outcomes",
			criteria: ["First result", "Second result"],
			phases: [{ id: "P1", title: "Prove both", criterionIds: ["AC1", "AC2"] }],
			verificationChecks: [{ id: "V1", kind: "file_exists", label: "manifest", path: "package.json" }],
			authorities: [], constraints: [], nonGoals: [],
		}, harness.ctx);
		multi.status = "running"; multi.phase = "executing"; harness.branch.push({ type: "custom", customType: STATE_CUSTOM_TYPE, data: multi });
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "r1", input: { path: "one.md" }, isError: false, content: [], details: {} });
		await assert.rejects(() => harness.tool("pi_goal_record_evidence", { goalId: multi.goalId, generation: multi.generation, summary: "ambiguous" }), /maps multiple criteria/);
		await harness.tool("pi_goal_record_evidence", { goalId: multi.goalId, generation: multi.generation, summary: "first", criterionIds: ["AC1"] });
		assert.equal(latestState(harness).plan[0].status, "in_progress");
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "r2", input: { path: "two.md" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: multi.goalId, generation: multi.generation, summary: "second", criterionIds: ["AC2"] });
		assert.equal(latestState(harness).plan[0].status, "done");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit unknown evidence IDs fail before state mutation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "write", toolCallId: "write-hidden-id", input: { path: "README.md", content: "x" }, isError: false, content: [], details: {} });
		await assert.rejects(() => harness.tool("pi_goal_record_evidence", { goalId: initial.goalId, generation: initial.generation, summary: "bad", criterionIds: ["BAD"] }), /Valid criteria: AC1/);
		await assert.rejects(() => harness.tool("pi_goal_record_evidence", { goalId: initial.goalId, generation: initial.generation, summary: "bad", criterionIds: ["AC1"], nodeId: "BAD" }), /Valid nodes: P1/);
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "persist-after-rejection", input: { path: "package.json" }, isError: false, content: [], details: {} });
		const persisted = harness.branch.filter((entry) => entry.customType === STATE_CUSTOM_TYPE).at(-1).data;
		assert.equal(persisted.evidence.length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("planner rejects circular audit-process criteria before approval", () => {
	assert.match(SETUP_PLANNER_SYSTEM_PROMPT, /Never add criteria about submitting completion/);
	assert.throws(() => normalizeDraft({ ...draft, criteria: ["The goal is complete when the isolated auditor reports pass"] }, draft.outcome), /process-only audit criteria/);
	assert.throws(() => normalizeDraft({
		outcome: "Create READY.md",
		criteria: ["READY.md exists", "Completion is submitted to the independent verifier/auditor and accepted before finishing."],
		phases: [{ id: "P1", title: "Create", criterionIds: ["AC1", "AC2"] }],
		verificationChecks: [{ id: "V1", kind: "file_exists", label: "READY exists", path: "READY.md" }],
		authorities: [], constraints: [], nonGoals: [],
	}, "Create READY.md"), /process-only audit criteria.*Completion is submitted/);
	const substantive = normalizeDraft({
		outcome: "Create READY.md",
		criteria: ["READY.md exists"],
		phases: [{ id: "P1", title: "Create", criterionIds: ["AC1"] }],
		verificationChecks: [{ id: "V1", kind: "file_exists", label: "READY exists", path: "READY.md" }],
		authorities: [], constraints: [], nonGoals: [],
	}, "Create READY.md");
	assert.deepEqual(substantive.criteria, ["READY.md exists"]);
});

test("planner rejects development-only checks against installed packages", () => {
	const base = {
		outcome: "Validate installed goal package",
		criteria: ["Installed package is healthy"],
		phases: [{ id: "P1", title: "Validate", criterionIds: ["AC1"] }],
		authorities: [], constraints: [], nonGoals: [],
	};
	assert.match(SETUP_PLANNER_SYSTEM_PROMPT, /installed packages beneath node_modules/);
	assert.match(SETUP_PLANNER_SYSTEM_PROMPT, /never generate multiline python\/node scripts/);
	assert.throws(() => normalizeDraft({
		...base,
		verificationChecks: [{ id: "V0", kind: "command_exit", label: "multiline python", executable: "python3", args: ["-c", "print('one')\nprint('two')"] }],
	}, base.outcome, "/home/user"), /verifier-incompatible.*V0.*argv contains an invalid value/);
	assert.throws(() => normalizeDraft({
		...base,
		verificationChecks: [{ id: "V1", kind: "command_exit", label: "complete package check", executable: "npm", args: ["run", "check"], cwd: "/home/user/.pi/agent/npm/node_modules/@scope/pkg" }],
	}, base.outcome, "/home/user"), /development-only verification.*V1.*complete package check/);
	assert.throws(() => normalizeDraft({
		...base,
		verificationChecks: [{ id: "V1", kind: "command_exit", label: "tests", executable: "npm", args: ["--prefix", ".pi/agent/npm/node_modules/@scope/pkg", "test"] }],
	}, base.outcome, "/home/user"), /development-only verification/);
	const sourceCheck = normalizeDraft({
		...base,
		verificationChecks: [{ id: "V1", kind: "command_exit", label: "source package check", executable: "npm", args: ["run", "check"], cwd: "/home/user/src/pi-goal" }],
	}, base.outcome, "/home/user");
	assert.equal(sourceCheck.verificationChecks.length, 1);
});

test("audit normalization accepts explicit pass aliases and rejects ambiguous status", () => {
	const normalized = normalizeAuditDecision({ verdict: "pass", reason: "ok", criterionResults: [{ criterionId: "AC1", status: "pass", evidenceIds: ["e1"], note: "ok" }], missingCriteria: [] });
	assert.equal(normalized.criterionResults[0].status, "met");
	assert.throws(() => normalizeAuditDecision({ verdict: "pass", reason: "ok", criterionResults: [{ criterionId: "AC1", status: "approved", evidenceIds: ["e1"], note: "ok" }], missingCriteria: [] }), /unsupported criterion status/);
});

test("audit completion requires exact criterion coverage and never partially mutates", () => {
	const completeDraft: GoalDraft = {
		outcome: "Complete audit",
		criteria: ["One", "Two"],
		phases: [{ id: "P1", title: "Work", criterionIds: ["AC1", "AC2"] }],
		verificationChecks: [{ id: "V1", kind: "file_exists", label: "manifest", path: "package.json" }],
		authorities: [], constraints: [], nonGoals: [],
	};
	const value = createGoalState(completeDraft, { cwd: "/tmp/work", sessionManager: { getSessionId: () => "audit" } } as any);
	value.status = "running";
	value.evidence.push({ id: "e1", kind: "tool_result", summary: "one", criterionIds: ["AC1"], paths: [], createdAt: new Date().toISOString() });
	value.evidence.push({ id: "e2", kind: "tool_result", summary: "two", criterionIds: ["AC2"], paths: [], createdAt: new Date().toISOString() });
	const before = structuredClone(value.criteria);
	const duplicate = validateAuditCompletion(value, { verdict: "pass", reason: "bad coverage", criterionResults: [
		{ criterionId: "AC1", status: "met", evidenceIds: ["e1"], note: "one" },
		{ criterionId: "AC1", status: "met", evidenceIds: ["e1"], note: "duplicate" },
	], missingCriteria: [] });
	assert.equal(duplicate.valid, false);
	assert.deepEqual(value.criteria, before);
	const missing = validateAuditCompletion(value, { verdict: "pass", reason: "missing", criterionResults: [{ criterionId: "AC1", status: "met", evidenceIds: ["e1"], note: "one" }], missingCriteria: [] });
	assert.equal(missing.valid, false);
	const unknown = validateAuditCompletion(value, { verdict: "pass", reason: "unknown", criterionResults: [
		{ criterionId: "AC1", status: "met", evidenceIds: ["e1"], note: "one" },
		{ criterionId: "BAD", status: "met", evidenceIds: ["e2"], note: "bad" },
	], missingCriteria: [] });
	assert.equal(unknown.valid, false);
});

test("full candidate audit normalizes pass to met and completes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	const originalAudit = IsolatedModelRunner.prototype.audit;
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		writeFileSync(join(harness.ctx.cwd, "package.json"), "{}\n");
		const initial = injectRunning(harness);
		initial.evidence.push({ id: "e1", kind: "tool_result", summary: "manifest exists", criterionIds: ["AC1"], nodeId: "P1", paths: ["package.json"], createdAt: new Date().toISOString() });
		initial.plan[0].evidenceIds.push("e1");
		initial.plan[0].status = "done";
		IsolatedModelRunner.prototype.audit = async () => normalizeAuditDecision({ verdict: "pass", reason: "All evidence and checks passed", criterionResults: [{ criterionId: "AC1", status: "pass", evidenceIds: ["e1", "V1"], note: "verified" }], missingCriteria: [] });
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const candidate = await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "ready" });
		assert.match(candidate.content[0].text, /Approved checks passed/);
		assert.equal(latestState(harness).completionCandidate, true);
		await harness.emit("agent_settled", { type: "agent_settled" });
		const persisted = harness.branch.filter((entry) => entry.customType === STATE_CUSTOM_TYPE).at(-1).data;
		assert.equal(persisted.status, "completed");
		assert.equal(persisted.criteria[0].status, "met");
		assert.equal(persisted.auditReports.at(-1).verdict, "pass");
		assert.equal(persisted.auditFailureCount, 0);
		assert.equal(persisted.verificationFailureCount, 0);
		assert.match(JSON.stringify(harness.messages), /Goal complete and independently verified/);
		assert.doesNotMatch(readFileSync(goalArtifact(root, "events.jsonl"), "utf8"), /verification_failed|completion_preflight_failed/);
	} finally {
		IsolatedModelRunner.prototype.audit = originalAudit;
		rmSync(root, { recursive: true, force: true });
	}
});

test("replanning cannot self-certify a node done without evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await assert.rejects(() => harness.tool("pi_goal_update_plan", { goalId: initial.goalId, generation: initial.generation, reason: "claim done", nodes: [{ id: "P1", title: "Implement", status: "done", criterionIds: ["AC1"] }] }), /without linked evidence/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("declared background work blocks continuation until a correlated terminal message", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const allowed = (await harness.emit("tool_call", { type: "tool_call", toolName: "job_start", toolCallId: "j1", input: { task: "inspect" } })).find(Boolean);
		assert.equal(allowed, undefined);
		await harness.emit("tool_result", { type: "tool_result", toolName: "job_start", toolCallId: "j1", input: { task: "inspect" }, isError: false, content: [], details: { job_id: "job-1", state: "running" } });
		let persisted = harness.branch.filter((entry) => entry.customType === STATE_CUSTOM_TYPE).at(-1).data;
		assert.ok(persisted.backgroundWork["job-1"]);
		await harness.emit("message_end", { type: "message_end", message: { role: "custom", customType: "job-completion", content: "done", details: { job_id: "job-1", state: "completed" } } });
		persisted = harness.branch.filter((entry) => entry.customType === STATE_CUSTOM_TYPE).at(-1).data;
		assert.equal(persisted.backgroundWork["job-1"], undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("declared background tool without a job identity fails closed", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "job_start", toolCallId: "j1", input: { task: "inspect" }, isError: false, content: [], details: { state: "running" } });
		const persisted = harness.branch.filter((entry) => entry.customType === STATE_CUSTOM_TYPE).at(-1).data;
		assert.equal(persisted.interrupt.class, "BLOCKER");
		assert.match(persisted.interrupt.message, /no trackable job identity/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("third identical call triggers autonomous recovery guard", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const event = { type: "tool_call", toolName: "read", toolCallId: "r", input: { path: "README.md" } };
		assert.equal((await harness.emit("tool_call", event)).find(Boolean), undefined);
		assert.equal((await harness.emit("tool_call", { ...event, toolCallId: "r2" })).find(Boolean), undefined);
		for (let attempt = 3; attempt <= 5; attempt += 1) {
			const blocked = (await harness.emit("tool_call", { ...event, toolCallId: `r${attempt}` })).find(Boolean);
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /Repeated identical call/);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("pause, steering, resume, and cancellation invalidate queued work", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-controls-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const stale = { role: "custom", ...harness.messages.at(-1).message };
		await harness.emit("input", { type: "input", source: "interactive", text: "pause goal" });
		assert.equal(latestState(harness).status, "paused");
		assert.equal(harness.aborts, 1);
		assert.equal((await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "x" })).find(Boolean), undefined);
		const filtered = (await harness.emit("context", { type: "context", messages: [stale] })).find(Boolean);
		assert.equal(filtered.messages.length, 0);
		await harness.emit("input", { type: "input", source: "interactive", text: "Also verify documentation" });
		assert.equal(latestState(harness).status, "paused");
		assert.match(latestState(harness).outcome.amendments.at(-1).text, /verify documentation/);
		await harness.emit("input", { type: "input", source: "interactive", text: "resume goal" });
		assert.equal(latestState(harness).status, "running");
		assert.match(JSON.stringify(harness.messages.at(-1)), /Resume from durable state/);
		await harness.emit("input", { type: "input", source: "interactive", text: "cancel goal" });
		assert.equal(latestState(harness).status, "cancelled");
		assert.equal(harness.aborts, 2);
		assert.equal((await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "x" })).find(Boolean), undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BLOCKER opens on the third durable identical encounter", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-blocker-"));
	try {
		const harness = makeHarness(root);
		const state = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const request = {
			goalId: state.goalId,
			generation: state.generation,
			class: "BLOCKER",
			message: "Immutable approved check cannot execute",
			attempts: ["Validated the same deterministic contract defect"],
			need: "A new valid contract",
			recommendation: "Cancel and recreate after fixing setup validation",
		};
		await assert.rejects(() => harness.tool("pi_goal_request_interrupt", request), /requires three repeated/);
		await assert.rejects(() => harness.tool("pi_goal_request_interrupt", request), /requires three repeated/);
		const opened = await harness.tool("pi_goal_request_interrupt", request);
		assert.match(opened.content[0].text, /BLOCKER interruption opened/);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "interrupted");
		assert.equal(persisted.phase, "blocked");
		assert.equal(persisted.interrupt.class, "BLOCKER");
		const events = readFileSync(goalArtifact(root, "events.jsonl"), "utf8");
		assert.equal((events.match(/blocker_encounter/g) ?? []).length, 2);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("pending RISK requires exact phrase and consumes matching authority before execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-risk-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const input = { name: "external" };
		assert.equal((await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "risk-1", input })).find(Boolean).block, true);
		await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "risk-read", input: { path: "README.md" } });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "risk-read", input: { path: "README.md" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_request_interrupt", { goalId: initial.goalId, generation: initial.generation, class: "RISK", message: "External creation is necessary", attempts: ["Inspected local alternative"], need: "Exact creation approval", recommendation: "Approve once" });
		await harness.emit("input", { type: "input", source: "interactive", text: "approve it" });
		assert.equal(latestState(harness).authorities.length, 0);
		assert.match(harness.notifications.at(-1).message, /Exact approval required/);
		await harness.emit("input", { type: "input", source: "interactive", text: "approve exact pending risk once" });
		assert.equal(latestState(harness).authorities.length, 1);
		assert.equal((await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "risk-2", input })).find(Boolean), undefined);
		assert.equal(latestState(harness).authorities[0].uses, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("background event completion, reload, and manual compaction queue fresh continuation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-recovery-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		assert.match(JSON.stringify(harness.messages.at(-1)), /Resume active goal after reload/);
		harness.messages.length = 0;
		harness.pi.events.emit("pi-goal:background-start", { id: "job-bus", label: "watch" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(latestState(harness).backgroundWork["job-bus"]);
		harness.pi.events.emit("pi-goal:background-end", { id: "job-bus" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(latestState(harness).backgroundWork["job-bus"], undefined);
		assert.match(JSON.stringify(harness.messages.at(-1)), /background work completed/);
		harness.messages.length = 0;
		const before = latestState(harness).continuationSequence;
		await harness.emit("session_compact", { type: "session_compact", willRetry: false });
		assert.ok(latestState(harness).continuationSequence > before);
		assert.match(JSON.stringify(harness.messages.at(-1)), /Continue after compaction/);
		harness.messages.length = 0;
		await harness.emit("session_compact", { type: "session_compact", willRetry: true });
		assert.equal(harness.messages.length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
