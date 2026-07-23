import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IsolatedAuditError, IsolatedModelRunner, normalizeAuditDecision, normalizeDraft, parseJsonObject, withDeadline } from "../src/evaluator.ts";
import piGoalExtension, { isExplicitGoalSteeringInput, isInformationalGoalInput, isLegacyAutomaticDoomLoopInterrupt, parseGoalInputIntent, validateAuditCompletion, verificationRecoveryWindow } from "../src/index.ts";
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

function commandAuthority(id: string, cwd: string, actionClass: "local_process" | "network_read" | "external_write", executable: string, argsPrefix: string[], trailingArgs: "none" | "any" | "workspace_paths" | "single_value" = "any") {
	return { id, label: `${actionClass} ${executable} ${argsPrefix.join(" ")}`, actionClass, toolName: "bash", targets: [{ path: "cwd", equals: cwd }], command: { executable, argsPrefix, trailingArgs }, maxUses: 20 };
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

test("goal setup immediately enters durable same-conversation mode", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "Check system health using what we discussed");
		const state = latestState(harness);
		assert.equal(state.status, "setting_up");
		assert.equal(state.outcome.original, "Check system health using what we discussed");
		assert.match(JSON.stringify(harness.statuses), /setting_up/);
		assert.equal(harness.messages.length, 1);
		assert.equal(harness.messages[0].message.customType, "pi-goal-setup-continuation-v1");
		assert.equal(harness.messages[0].options.triggerTurn, true);
		const context = (await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "x" })).find(Boolean);
		assert.match(JSON.stringify(context), /GOAL SETUP ACTIVE IN THIS SAME CONVERSATION/);
		assert.match(JSON.stringify(context), /Resolve references from prior discussion/);
		assert.match(JSON.stringify(context), /no operational tools may run yet|pi_goal_submit_contract/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("same-conversation clarification stays visible and blocks pre-approval work", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "testing the goal mode");
		const before = latestState(harness);
		const inputResults = await harness.emit("input", { type: "input", source: "user", text: "Use the full end-to-end lifecycle we discussed" });
		assert.equal(inputResults.find(Boolean), undefined);
		assert.equal(latestState(harness).status, "setting_up");
		assert.equal(latestState(harness).revision, before.revision + 1);
		const blocked = (await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "r1", input: { path: "package.json" } })).find(Boolean);
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /conversational and not approved/);
		assert.match(blocked.reason, /Local files, attachments\/uploads, and screenshots cannot be inspected/);
		const allowed = (await harness.emit("tool_call", { type: "tool_call", toolName: "pi_goal_submit_contract", toolCallId: "s1", input: {} })).find(Boolean);
		assert.equal(allowed, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("deterministic cancellation aliases work in setup without matching negation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-setup-cancel-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "Clarify this goal");
		await harness.emit("input", { type: "input", source: "interactive", text: "do not cancel this goal" });
		assert.equal(latestState(harness).status, "setting_up");
		await harness.emit("input", { type: "input", source: "interactive", text: "cancel this stuck goal" });
		assert.equal(latestState(harness).status, "cancelled");
		assert.equal(harness.aborts, 1);
		assert.match(harness.notifications.at(-1).message, /cancelled/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("/goal cancel is a control for every active phase and never becomes a new outcome", async () => {
	const emptyRoot = mkdtempSync(join(tmpdir(), "pi-goal-command-cancel-empty-"));
	try {
		const empty = makeHarness(emptyRoot);
		await empty.command("goal", "cancel");
		assert.equal(empty.branch.length, 0);
		assert.match(empty.notifications.at(-1).message, /no active goal/i);
	} finally { rmSync(emptyRoot, { recursive: true, force: true }); }

	for (const status of ["setting_up", "awaiting_approval", "running", "paused", "interrupted", "auditing"] as const) {
		const root = mkdtempSync(join(tmpdir(), `pi-goal-command-cancel-${status}-`));
		try {
			const harness = makeHarness(root);
			if (status === "setting_up") await harness.command("goal", "Original outcome");
			else {
				const state = injectRunning(harness);
				state.status = status;
				state.phase = status === "awaiting_approval" ? "setup" : status === "auditing" ? "auditing" : status === "interrupted" ? "blocked" : "executing";
			}
			await harness.command("goal", "cancel");
			assert.equal(latestState(harness).status, "cancelled", status);
			assert.equal(latestState(harness).outcome.original, status === "setting_up" ? "Original outcome" : draft.outcome);
			assert.equal(harness.aborts, 1, status);
			assert.match(harness.notifications.at(-1).message, /cancelled/i, status);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("bare /goal panels cancel setup and running goals with immediate feedback", async () => {
	for (const mode of ["setup", "running"] as const) {
		const root = mkdtempSync(join(tmpdir(), `pi-goal-panel-cancel-${mode}-`));
		try {
			const harness = makeHarness(root);
			if (mode === "setup") {
				await harness.command("goal", "Review then cancel");
				const setup = latestState(harness);
				await harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, ...draft });
			} else injectRunning(harness);
			harness.ctx.ui.custom = async () => "cancel";
			await harness.command("goal", "");
			assert.equal(latestState(harness).status, "cancelled");
			assert.equal(harness.aborts, 1);
			assert.match(harness.notifications.at(-1).message, /cancelled/i);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("validated contract gets one approval then runs with declared authority", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "testing the goal mode");
		const setup = latestState(harness);
		const contract = {
			...draft,
			authorities: [{ id: "A1", label: "Create required external records", actionClass: "external_write", toolName: "functions.records_create", targets: [], maxUses: 5 }],
			constraints: ["Stay inside the approved workspace"],
			nonGoals: ["Do not redesign unrelated packages"],
		};
		await harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, ...contract });
		assert.equal(latestState(harness).status, "awaiting_approval");
		assert.deepEqual(latestState(harness).constraints, ["Stay inside the approved workspace"]);
		assert.deepEqual(latestState(harness).nonGoals, ["Do not redesign unrelated packages"]);
		const blocked = (await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "pre", input: { name: "x" } })).find(Boolean);
		assert.equal(blocked.block, true);
		harness.ctx.ui.custom = async () => "approve";
		await harness.command("goal", "");
		const running = latestState(harness);
		assert.equal(running.status, "running");
		assert.equal(running.authorities[0].maxUses, 5);
		assert.equal(running.authorities[0].toolName, "records_create");
		const allowed = (await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "post", input: { name: "x" } })).find(Boolean);
		assert.equal(allowed, undefined);
		assert.equal(latestState(harness).authorities[0].uses, 1);
		assert.match(JSON.stringify(harness.messages), /do not seek routine per-tool approval/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("contract can approve a planned canonical secondary workspace root before creation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-contract-multiroot-"));
	try {
		const harness = makeHarness(root);
		const secondary = join(root, "secondary");
		await harness.command("goal", "work in the declared secondary root");
		const setup = latestState(harness);
		await harness.tool("pi_goal_submit_contract", {
			goalId: setup.goalId, generation: setup.generation, ...draft,
			workspaceRoots: [secondary],
			verificationChecks: [
				{ id: "V1", kind: "file_exists", label: "secondary artifact", path: join(secondary, "artifact.txt") },
				{ id: "V2", kind: "git_status", label: "secondary Git clean", cwd: secondary, clean: true },
			],
		});
		let persisted = latestState(harness);
		assert.deepEqual(persisted.workspaceRoots, [harness.ctx.cwd, secondary]);
		assert.equal(persisted.verificationChecks[1].cwd, secondary);
		assert.equal(persisted.cwd, harness.ctx.cwd);
		harness.ctx.ui.custom = async () => "approve";
		await harness.command("goal", "");
		persisted = latestState(harness);
		assert.equal(persisted.status, "running");
		const allowed = (await harness.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "secondary-write", input: { path: join(secondary, "artifact.txt"), content: "ok" } })).find(Boolean);
		assert.equal(allowed, undefined);
		const status = JSON.parse((await harness.tool("pi_goal_status", {})).content[0].text);
		assert.deepEqual(status.workspaceRoots, [harness.ctx.cwd, secondary]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("contract refinement returns to the same conversation without an isolated planner", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "testing the goal mode");
		const setup = latestState(harness);
		await harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, ...draft });
		harness.ctx.ui.custom = async () => "refine";
		await harness.command("goal", "");
		const refining = latestState(harness);
		assert.equal(refining.status, "setting_up");
		assert.equal(refining.criteria[0].text, "State is durable");
		assert.equal(harness.messages.at(-1).message.customType, "pi-goal-setup-continuation-v1");
		assert.match(JSON.stringify(harness.messages.at(-1)), /Ask what should change/);
		const context = (await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "x" })).find(Boolean);
		assert.match(JSON.stringify(context), /Current proposed contract being refined/);
		assert.match(JSON.stringify(context), /do not impose an arbitrary question limit/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("pending setup survives settlement and reload without duplicate prompting", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "retest that same scenario");
		assert.equal(harness.messages.length, 1);
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.equal(latestState(harness).setupAwaitingUser, true);
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		assert.equal(harness.messages.length, 1, "reload must not repeat a question while waiting for user");
		for (let index = 0; index < 5; index += 1) {
			await harness.emit("input", { type: "input", source: "user", text: `clarification ${index + 1}` });
			assert.equal(latestState(harness).status, "setting_up");
		}
		assert.equal(latestState(harness).setupAwaitingUser, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid contract fails closed while normal transcript remains the setup record", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "Diagnose setup without losing the final sentinel FINAL-SETUP-SENTINEL");
		const setup = latestState(harness);
		await assert.rejects(
			() => harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, outcome: "bad", criteria: ["done"], phases: [{ id: "P1", title: "work" }], verificationChecks: [], authorities: [], constraints: [], nonGoals: [] }),
			/no mechanical verification checks/,
		);
		assert.equal(latestState(harness).status, "setting_up");
		await assert.rejects(
			() => harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, ...draft, authorities: [{ id: "A1", label: "Unavailable", actionClass: "external_write", toolName: "functions.not_registered", targets: [], maxUses: 1 }] }),
			/unavailable operational tool/,
		);
		assert.equal(latestState(harness).status, "setting_up");
		assert.match(latestState(harness).outcome.original, /FINAL-SETUP-SENTINEL/);
		assert.equal(harness.branch.some((entry) => entry.customType === SETUP_TRANSCRIPT_CUSTOM_TYPE), false);
		const handled = (await harness.emit("input", { type: "input", source: "user", text: "cancel goal setup" })).find(Boolean);
		assert.equal(handled.action, "handled");
		assert.equal(latestState(harness).status, "cancelled");
		assert.equal(harness.aborts, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup contract submission stops on a repeated equivalent failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-setup-repeat-cap-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "Bound contract repair attempts");
		const setup = latestState(harness);
		const fakeSecret = "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
		const invalid = {
			goalId: setup.goalId,
			generation: setup.generation,
			outcome: "bad",
			criteria: [`Complete after auditor confirms pass ${fakeSecret}`],
			phases: [{ id: "P1", title: "work" }],
			verificationChecks: [{ id: "V1", kind: "file_exists", label: "manifest", path: "package.json" }],
			authorities: [], constraints: [], nonGoals: [],
		};
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", invalid), /process-only audit criteria/);
		let state = latestState(harness);
		assert.equal(state.setupSubmissionFailureCount, 1);
		assert.equal(state.setupSubmissionFailureRepeatCount, 1);
		assert.equal(state.setupSubmissionDiagnostic.stage, "draft");
		assert.doesNotMatch(state.setupSubmissionDiagnostic.message, new RegExp(fakeSecret));
		assert.match(state.setupSubmissionDiagnostic.message, /\[REDACTED\]/);
		assert.equal(state.setupAwaitingUser, false);
		assert.equal(harness.aborts, 0);
		const context = (await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "x" })).find(Boolean);
		assert.match(JSON.stringify(context), /Last contract rejection/);
		assert.doesNotMatch(JSON.stringify(context), new RegExp(fakeSecret));

		await assert.rejects(() => harness.tool("pi_goal_submit_contract", invalid), /setup contract repair limit reached/i);
		state = latestState(harness);
		assert.equal(state.setupSubmissionFailureCount, 2);
		assert.equal(state.setupSubmissionFailureRepeatCount, 2);
		assert.equal(state.setupAwaitingUser, true);
		assert.equal(harness.aborts, 1);
		const cappedCount = state.setupSubmissionFailureCount;
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", invalid), /waiting for new user input/i);
		assert.equal(latestState(harness).setupSubmissionFailureCount, cappedCount);
		assert.equal(harness.aborts, 1);
		const statePath = goalArtifact(root, "state.json");
		const crashWindowState = JSON.parse(readFileSync(statePath, "utf8"));
		crashWindowState.setupAwaitingUser = false;
		writeFileSync(statePath, `${JSON.stringify(crashWindowState, null, 2)}\n`);
		const reloaded = makeHarness(root);
		await reloaded.emit("session_start", { type: "session_start", reason: "reload" });
		const restoredStatus = JSON.parse((await reloaded.tool("pi_goal_status", {})).content[0].text);
		assert.equal(restoredStatus.setupSubmission.failureCount, 2);
		assert.equal(restoredStatus.setupSubmission.blocked, true);
		await assert.rejects(() => reloaded.tool("pi_goal_submit_contract", invalid), /waiting for new user input/i);
		assert.equal(reloaded.aborts, 0);
		assert.doesNotMatch(readFileSync(goalArtifact(root, "events.jsonl"), "utf8"), new RegExp(fakeSecret));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup contract submission stops after three distinct validation failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-setup-distinct-cap-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "Bound distinct contract failures");
		const setup = latestState(harness);
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", {
			goalId: setup.goalId, generation: setup.generation, outcome: "bad", criteria: ["done"], phases: [{ id: "P1", title: "work" }], verificationChecks: [{ id: "V1", kind: "file_exists", label: "outside", path: join(tmpdir(), "outside-approved-goal-root") }], authorities: [], constraints: [], nonGoals: [],
		}), /verification path leaves the approved workspace/);
		assert.equal(latestState(harness).setupSubmissionDiagnostic.stage, "draft");
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", {
			goalId: setup.goalId, generation: setup.generation, ...draft,
			authorities: [{ id: "A1", label: "Unavailable", actionClass: "external_write", toolName: "functions.not_registered", targets: [], maxUses: 1 }],
		}), /unavailable operational tool/);
		assert.equal(latestState(harness).setupSubmissionDiagnostic.stage, "authority_tools");
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", {
			goalId: setup.goalId, generation: setup.generation, ...draft,
			phases: [{ id: "P1", title: "work", commands: [{ executable: "node", args: ["--version"], cwd: harness.ctx.cwd, actionClasses: ["local_process"] }], criterionIds: ["AC1"] }],
		}), /setup contract repair limit reached/i);
		const state = latestState(harness);
		assert.equal(state.setupSubmissionFailureCount, 3);
		assert.equal(state.setupSubmissionFailureRepeatCount, 1);
		assert.equal(state.setupSubmissionDiagnostic.stage, "command_authority");
		assert.equal(state.setupAwaitingUser, true);
		assert.equal(harness.aborts, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("only material setup correction resets the submission budget while reload and chatter do not", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-setup-reset-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "Reset only after user input");
		const setup = latestState(harness);
		const invalid = { goalId: setup.goalId, generation: setup.generation, outcome: "bad", criteria: ["done"], phases: [{ id: "P1", title: "work" }], verificationChecks: [], authorities: [], constraints: [], nonGoals: [] };
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", invalid));
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", invalid));
		const capped = latestState(harness);
		assert.equal(capped.setupAwaitingUser, true);
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		assert.equal(latestState(harness).setupSubmissionFailureCount, 2);
		assert.equal(latestState(harness).setupAwaitingUser, true);
		harness.messages.length = 0;
		await harness.emit("session_compact", { type: "session_compact", willRetry: false });
		assert.equal(latestState(harness).setupSubmissionFailureCount, 2);
		assert.equal(latestState(harness).setupAwaitingUser, true);
		assert.equal(harness.messages.length, 0);
		for (const text of ["okay", "this is frustrating", "/tmp/screenshot.png", "what failed?"]) {
			await harness.emit("input", { type: "input", source: "interactive", text });
			assert.equal(latestState(harness).setupSubmissionFailureCount, 2, text);
			assert.equal(latestState(harness).setupAwaitingUser, true, text);
			assert.match(harness.notifications.at(-1).message, /Correction:/, text);
		}
		await harness.emit("input", { type: "input", source: "interactive", text: "Correction: use one simple file check" });
		let state = latestState(harness);
		assert.equal(state.setupSubmissionFailureCount, 0);
		assert.equal(state.setupSubmissionFailureRepeatCount, 0);
		assert.equal(state.setupSubmissionDiagnostic, undefined);
		assert.equal(state.setupAwaitingUser, false);
		assert.equal(state.currentAction, "Clarifying goal in this conversation");
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", invalid));
		state = latestState(harness);
		assert.equal(state.setupSubmissionFailureCount, 1);
		assert.equal(state.setupAwaitingUser, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("contract preflight aggregates independently detectable root and verification errors", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-contract-aggregate-"));
	try {
		const harness = makeHarness(root);
		const outside = join(root, "outside"); mkdirSync(outside);
		const aliased = join(root, "aliased");
		symlinkSync(outside, aliased);
		await harness.command("goal", "Report all contract defects together");
		const setup = latestState(harness);
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", {
			goalId: setup.goalId,
			generation: setup.generation,
			...draft,
			workspaceRoots: [aliased],
			phases: [{ id: "P1", title: "work", criterionIds: ["BAD"] }],
			verificationChecks: [
				{ id: "V1", kind: "file_exists", label: "outside", path: join(root, "unapproved", "artifact.txt") },
				{ id: "V2", kind: "command_exit", label: "git global cwd", executable: "git", args: ["-C", aliased, "diff", "--quiet"] },
			],
		}), (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, /workspaceRoots/);
			assert.match(message, /phases\[0\]\.criterionIds/);
			assert.match(message, /V1/);
			assert.match(message, /V2/);
			return true;
		});
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("valid setup replacement clears prior submission diagnostics and status exposes bounded failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-setup-success-clear-"));
	try {
		const harness = makeHarness(root);
		await harness.command("goal", "Recover to a valid contract");
		const setup = latestState(harness);
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, outcome: "bad", criteria: ["done"], phases: [{ id: "P1", title: "work" }], verificationChecks: [], authorities: [], constraints: [], nonGoals: [] }));
		const status = JSON.parse((await harness.tool("pi_goal_status", {})).content[0].text);
		assert.equal(status.setupSubmission.failureCount, 1);
		assert.equal(status.setupSubmission.blocked, false);
		await harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, ...draft });
		const state = latestState(harness);
		assert.equal(state.status, "awaiting_approval");
		assert.equal(state.setupSubmissionFailureCount, 0);
		assert.equal(state.setupSubmissionFailureRepeatCount, 0);
		assert.equal(state.setupSubmissionDiagnostic, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
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

test("typed input intent keeps questions and acknowledgements non-mutating", async () => {
	assert.equal(isInformationalGoalInput('why is it "recovering" again?'), true);
	assert.equal(isInformationalGoalInput("what is the goal status?"), true);
	assert.equal(isInformationalGoalInput("so? is anything happening?"), true);
	assert.equal(isInformationalGoalInput("are you done?"), true);
	assert.equal(isInformationalGoalInput("Also verify documentation"), false);
	assert.equal(isExplicitGoalSteeringInput("steer goal: also add documentation"), true);
	assert.equal(isExplicitGoalSteeringInput("Also verify documentation"), true);
	assert.equal(parseGoalInputIntent("okay, continue"), "neutral_continue");
	assert.equal(parseGoalInputIntent("cancel this stuck goal"), "cancel");
	assert.equal(parseGoalInputIntent("do not cancel this goal"), "informational");
	assert.equal(parseGoalInputIntent("don't cancel this goal"), "informational");
	assert.equal(parseGoalInputIntent("please keep the current plan"), "unknown");
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		for (const text of ['why is it "recovering" again?', "so? is anything happening?", "are you done?", "okay, continue", "do not cancel this goal", "don't cancel this goal", "please keep the current plan"]) {
			const results = await harness.emit("input", { type: "input", source: "interactive", text });
			assert.equal(results.find(Boolean), undefined);
		}
		const persisted = latestState(harness);
		assert.equal(persisted.generation, initial.generation);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.outcome.amendments.length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit-time questions are non-mutating while explicit steering exits auditing atomically", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-audit-input-"));
	try {
		const harness = makeHarness(root);
		const state = createGoalState(draft, harness.ctx);
		state.status = "auditing"; state.phase = "auditing"; state.completionCandidate = true;
		state.auditFailureCount = 2; state.auditRejectionRepeatCount = 1; state.lastRejectedAuditInputFingerprint = "old-input"; state.lastAuditRejectionFingerprint = "old-diagnostic";
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
		assert.equal(persisted.auditFailureCount, 0);
		assert.equal(persisted.auditRejectionRepeatCount, 0);
		assert.equal(persisted.lastRejectedAuditInputFingerprint, undefined);
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
		assert.deepEqual(persisted.criteria[0].evidenceIds, [persisted.evidence[0].id]);
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
		assert.deepEqual(latestState(harness).criteria[0].evidenceIds, [latestState(harness).evidence[0].id]);
		assert.deepEqual(latestState(harness).criteria[1].evidenceIds, []);
		assert.equal(latestState(harness).plan[0].status, "in_progress");
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "r2", input: { path: "two.md" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: multi.goalId, generation: multi.generation, summary: "second", criterionIds: ["AC2"] });
		assert.deepEqual(latestState(harness).criteria[1].evidenceIds, [latestState(harness).evidence[1].id]);
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

test("contract validation rejects circular audit-process criteria before approval", () => {
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

test("contract validation rejects development-only checks against installed packages", () => {
	const base = {
		outcome: "Validate installed goal package",
		criteria: ["Installed package is healthy"],
		phases: [{ id: "P1", title: "Validate", criterionIds: ["AC1"] }],
		authorities: [], constraints: [], nonGoals: [],
	};
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

test("audit parsing rejects empty, malformed, incomplete, and ambiguous output", () => {
	assert.throws(() => parseJsonObject(""), /malformed JSON/);
	assert.throws(() => parseJsonObject("```json\n{bad}\n```"), /malformed JSON/);
	assert.throws(() => normalizeAuditDecision({ verdict: "pass", reason: "missing arrays" }), /incomplete decision/);
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
		initial.auditExecution = { code: "AUDIT_TIMEOUT", stage: "prompt", message: "stale failure", elapsedMs: 90_000, attemptCount: 1, retryable: false, suggestedAction: "retry after change", fingerprint: "stale", createdAt: new Date().toISOString() };
		initial.auditExecutionRepeatCount = 1; initial.lastAuditExecutionInputFingerprint = "stale-input";
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
		assert.equal(persisted.auditExecution, undefined);
		assert.equal(persisted.auditExecutionRepeatCount, 0);
		assert.equal(persisted.lastAuditExecutionInputFingerprint, undefined);
		assert.equal(persisted.verificationFailureCount, 0);
		assert.match(JSON.stringify(harness.messages), /Goal complete and independently verified/);
		assert.doesNotMatch(readFileSync(goalArtifact(root, "events.jsonl"), "utf8"), /verification_failed|completion_preflight_failed/);
	} finally {
		IsolatedModelRunner.prototype.audit = originalAudit;
		rmSync(root, { recursive: true, force: true });
	}
});

test("audit execution timeout is single-attempt, actionable, and blocks unchanged retry", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-audit-execution-"));
	const originalAudit = IsolatedModelRunner.prototype.audit;
	let auditCalls = 0;
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		writeFileSync(join(harness.ctx.cwd, "package.json"), "{}\n");
		const initial = injectRunning(harness);
		initial.evidence.push({ id: "e1", kind: "tool_result", summary: "manifest exists", criterionIds: ["AC1"], nodeId: "P1", paths: ["package.json"], createdAt: new Date().toISOString() });
		initial.plan[0].evidenceIds.push("e1"); initial.plan[0].status = "done";
		IsolatedModelRunner.prototype.audit = async () => { auditCalls += 1; throw new IsolatedAuditError("AUDIT_TIMEOUT", "prompt", "provider detail npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", false); };
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "ready" });
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.equal(auditCalls, 1);
		let persisted = latestState(harness);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.auditExecution.code, "AUDIT_TIMEOUT");
		assert.equal(persisted.auditExecution.attemptCount, 1);
		assert.match(persisted.auditExecution.message, /\[REDACTED\]/);
		const status = JSON.parse((await harness.tool("pi_goal_status", {})).content[0].text);
		assert.equal(status.auditExecution.code, "AUDIT_TIMEOUT");
		const retry = await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "unchanged" });
		assert.match(retry.content[0].text, /blocked/i);
		assert.equal(auditCalls, 1);
		persisted = latestState(harness);
		assert.equal(persisted.status, "interrupted");
		assert.equal(persisted.interrupt.class, "BLOCKER");
	} finally { IsolatedModelRunner.prototype.audit = originalAudit; rmSync(root, { recursive: true, force: true }); }
});

test("material evidence permits one audit execution retry and stable failure class then blocks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-audit-execution-progress-"));
	const originalAudit = IsolatedModelRunner.prototype.audit;
	let auditCalls = 0;
	try {
		const harness = makeHarness(root); mkdirSync(harness.ctx.cwd, { recursive: true }); writeFileSync(join(harness.ctx.cwd, "package.json"), "{}\n");
		const initial = injectRunning(harness);
		initial.evidence.push({ id: "e1", kind: "tool_result", summary: "manifest exists", criterionIds: ["AC1"], nodeId: "P1", paths: ["package.json"], createdAt: new Date().toISOString() });
		initial.plan[0].evidenceIds.push("e1"); initial.plan[0].status = "done";
		IsolatedModelRunner.prototype.audit = async () => { auditCalls += 1; throw new IsolatedAuditError("AUDIT_TIMEOUT", "prompt", `volatile provider request ${auditCalls}`, false); };
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "ready" });
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "material-read", input: { path: "package.json" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: initial.goalId, generation: initial.generation, summary: "material package observation", criterionIds: ["AC1"] });
		await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "changed input" });
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.equal(auditCalls, 2);
		const persisted = latestState(harness);
		assert.equal(persisted.auditExecutionRepeatCount, 2);
		assert.equal(persisted.status, "interrupted"); assert.equal(persisted.interrupt.class, "BLOCKER");
	} finally { IsolatedModelRunner.prototype.audit = originalAudit; rmSync(root, { recursive: true, force: true }); }
});

test("pending authority amendment ignores clarification and changes only on exact approval or steering", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-amend-clarify-"));
	try {
		const harness = makeHarness(root); mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.tool("pi_goal_request_authority_amendment", { goalId: state.goalId, generation: state.generation, rationale: "focused test", authorities: [commandAuthority("A-new", harness.ctx.cwd, "local_process", "node", ["--test"], "any")] });
		const before = structuredClone(latestState(harness));
		await harness.emit("input", { type: "input", source: "interactive", text: "don't understand" });
		let persisted = latestState(harness);
		assert.equal(persisted.generation, before.generation);
		assert.equal(persisted.continuationSequence, before.continuationSequence);
		assert.deepEqual(persisted.interrupt.pendingAuthorityAmendment, before.interrupt.pendingAuthorityAmendment);
		assert.equal(persisted.outcome.amendments.length, before.outcome.amendments.length);
		await harness.emit("input", { type: "input", source: "interactive", text: "steer goal: use another test method" });
		persisted = latestState(harness);
		assert.equal(persisted.status, "running"); assert.equal(persisted.phase, "planning");
		assert.equal(persisted.interrupt, undefined); assert.equal(persisted.generation, before.generation + 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit rejection exposes actionable diagnostics and blocks an unchanged retry before another audit", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-audit-rejection-"));
	const originalAudit = IsolatedModelRunner.prototype.audit;
	let auditCalls = 0;
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		writeFileSync(join(harness.ctx.cwd, "package.json"), "{}\n");
		const initial = injectRunning(harness);
		initial.evidence.push({ id: "e1", kind: "tool_result", summary: "manifest exists", criterionIds: ["AC1"], nodeId: "P1", paths: ["package.json"], createdAt: new Date().toISOString() });
		initial.plan[0].evidenceIds.push("e1");
		initial.plan[0].status = "done";
		IsolatedModelRunner.prototype.audit = async () => {
			auditCalls += 1;
			return normalizeAuditDecision({ verdict: "fail", reason: "Package loading was not demonstrated", criterionResults: [{ criterionId: "AC1", status: "failed", evidenceIds: ["e1"], note: "The file exists, but no package-load result is linked" }], missingCriteria: ["AC1"] });
		};
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "ready" });
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.equal(auditCalls, 1);
		let persisted = latestState(harness);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.auditRejectionRepeatCount, 1);
		assert.match(persisted.nextAction, /AC1: State is durable/);
		const status = JSON.parse((await harness.tool("pi_goal_status", {})).content[0].text);
		assert.equal(status.lastAuditRejection.code, "AUDIT_REJECTED");
		assert.equal(status.lastAuditRejection.gaps[0].criterionId, "AC1");
		assert.equal(status.lastAuditRejection.gaps[0].criterionText, "State is durable");
		assert.match(status.lastAuditRejection.gaps[0].note, /no package-load result/);
		assert.equal(status.lastAuditRejection.retryable, true);
		const retry = await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "unchanged retry" });
		assert.match(retry.content[0].text, /no material evidence or approved-check result changed/);
		assert.equal(auditCalls, 1);
		persisted = latestState(harness);
		assert.equal(persisted.status, "interrupted");
		assert.equal(persisted.interrupt.class, "BLOCKER");
		assert.equal(persisted.auditRejectionRepeatCount, 2);
	} finally {
		IsolatedModelRunner.prototype.audit = originalAudit;
		rmSync(root, { recursive: true, force: true });
	}
});

test("material new evidence permits one retry and repeated identical diagnosis becomes a blocker", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-audit-progress-"));
	const originalAudit = IsolatedModelRunner.prototype.audit;
	let auditCalls = 0;
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		writeFileSync(join(harness.ctx.cwd, "package.json"), "{}\n");
		const initial = injectRunning(harness);
		initial.evidence.push({ id: "e1", kind: "tool_result", summary: "manifest exists", criterionIds: ["AC1"], nodeId: "P1", paths: ["package.json"], createdAt: new Date().toISOString() });
		initial.plan[0].evidenceIds.push("e1");
		initial.plan[0].status = "done";
		IsolatedModelRunner.prototype.audit = async () => {
			auditCalls += 1;
			const repeated = auditCalls > 1;
			return normalizeAuditDecision({ verdict: "fail", reason: repeated ? "Still missing direct package loading proof" : "Package loading was not demonstrated", criterionResults: [{ criterionId: "AC1", status: "failed", evidenceIds: ["e1"], note: repeated ? "The new observation still does not prove package loading" : "The file exists, but no package-load result is linked" }], missingCriteria: ["AC1"] });
		};
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "ready" });
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "new-proof", input: { path: "package.json" }, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: initial.goalId, generation: initial.generation, summary: "new package-load observation", criterionIds: ["AC1"] });
		await harness.tool("pi_goal_submit_completion_candidate", { goalId: initial.goalId, generation: initial.generation, summary: "new evidence retry" });
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.equal(auditCalls, 2);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "interrupted");
		assert.equal(persisted.interrupt.class, "BLOCKER");
		assert.equal(persisted.auditRejectionRepeatCount, 2);
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

test("third identical unresolved call triggers autonomous recovery without user interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-integration-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const event = { type: "tool_call", toolName: "read", toolCallId: "r", input: { path: "README.md" } };
		assert.equal((await harness.emit("tool_call", event)).find(Boolean), undefined);
		assert.equal((await harness.emit("tool_call", { ...event, toolCallId: "r2" })).find(Boolean), undefined);
		for (let attempt = 3; attempt <= 8; attempt += 1) {
			const blocked = (await harness.emit("tool_call", { ...event, toolCallId: `r${attempt}` })).find(Boolean);
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /does not require user attention/);
		}
		assert.equal(latestState(harness).status, "running");
		assert.equal(latestState(harness).interrupt, undefined);
		assert.equal(Object.values(latestState(harness).repeatedToolCalls)[0], 3);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("successful identical async result reads reset duplicate-call tracking", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-async-repeat-"));
	try {
		const harness = makeHarness(root);
		const state = injectRunning(harness);
		state.authorities.push({ id: "A-result", label: "inspect helper results", actionClass: "workspace_read", toolName: "subagent_result", targets: [], maxUses: 20, uses: 0 });
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		for (let attempt = 1; attempt <= 8; attempt += 1) {
			const input = { job_id: "job-1" };
			const toolCallId = `result-${attempt}`;
			assert.equal((await harness.emit("tool_call", { type: "tool_call", toolName: "subagent_result", toolCallId, input })).find(Boolean), undefined);
			await harness.emit("tool_result", { type: "tool_result", toolName: "subagent_result", toolCallId, input, isError: false, content: [], details: { state: "running" } });
		}
		assert.deepEqual(latestState(harness).repeatedToolCalls, {});
		assert.equal(latestState(harness).interrupt, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed identical calls still accumulate until autonomous recovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-failed-repeat-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const input = { path: "README.md" };
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const toolCallId = `failed-${attempt}`;
			assert.equal((await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId, input })).find(Boolean), undefined);
			await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId, input, isError: true, content: [], details: {} });
		}
		const blocked = (await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "failed-3", input })).find(Boolean);
		assert.equal(blocked.block, true);
		assert.equal(latestState(harness).interrupt, undefined);
		const editInput = { path: "src/fix.ts", oldText: "a", newText: "b" };
		await harness.emit("tool_call", { type: "tool_call", toolName: "edit", toolCallId: "repair", input: editInput });
		await harness.emit("tool_result", { type: "tool_result", toolName: "edit", toolCallId: "repair", input: editInput, isError: false, content: [], details: {} });
		assert.equal((await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "after-repair", input })).find(Boolean), undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker can run immutable setup-approved checks without ad-hoc shell authority", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-approved-check-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		state.verificationChecks = [
			{ id: "V1", kind: "command_exit", label: "node exits cleanly", executable: "node", args: ["-e", "process.exit(0)"], cwd: harness.ctx.cwd, expectedExitCode: 0 },
			{ id: "V2", kind: "command_exit", label: "node failure remains failure", executable: "node", args: ["-e", "process.exit(2)"], cwd: harness.ctx.cwd, expectedExitCode: 0 },
			{ id: "V3", kind: "command_exit", label: "detect concurrent goal change", executable: "node", args: ["-e", "setTimeout(() => process.exit(0), 100)"], cwd: harness.ctx.cwd, expectedExitCode: 0 },
		];
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const adHoc = (await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "shell-check", input: { command: "node -e process.exit(0)" } })).find(Boolean);
		assert.equal(adHoc.block, true);
		const result = await harness.tool("pi_goal_run_check", { goalId: state.goalId, generation: state.generation, checkId: "V1" });
		assert.equal(JSON.parse(result.content[0].text).passed, true);
		await assert.rejects(() => harness.tool("pi_goal_run_check", { goalId: state.goalId, generation: state.generation, checkId: "V2" }), /Approved check V2 failed/);
		await assert.rejects(() => harness.tool("pi_goal_run_check", { goalId: state.goalId, generation: state.generation, checkId: "missing" }), /Unknown approved verification check/);
		const changing = harness.tool("pi_goal_run_check", { goalId: state.goalId, generation: state.generation, checkId: "V3" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await harness.emit("input", { type: "input", source: "interactive", text: "Also include concurrent-state validation" });
		await assert.rejects(() => changing, /Stale goal ID or generation|Goal changed while approved check was running/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-RISK interruption reply resolves and resumes without becoming goal steering", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-interrupt-resolution-"));
	try {
		const harness = makeHarness(root);
		const state = injectRunning(harness);
		state.status = "interrupted";
		state.phase = "blocked";
		state.interrupt = { class: "BLOCKER", message: "Need direction", attempts: ["Tried recovery"], need: "Direction", recommendation: "Reply with direction", signature: "blocker", createdAt: new Date().toISOString() };
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const beforeGeneration = state.generation;
		await harness.emit("input", { type: "input", source: "interactive", text: "okay, approved" });
		const resumed = latestState(harness);
		assert.equal(resumed.status, "running");
		assert.equal(resumed.interrupt, undefined);
		assert.equal(resumed.generation, beforeGeneration + 1);
		assert.ok(resumed.outcome.amendments.at(-1).consumedAt);
		assert.match(JSON.stringify(harness.messages.at(-1)), /interruption resolution/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("bare /goal can resume a non-RISK interruption without changing authority or contract", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-interrupt-resume-"));
	try {
		const harness = makeHarness(root);
		const state = injectRunning(harness);
		state.status = "interrupted";
		state.phase = "blocked";
		state.interrupt = { class: "BLOCKER", message: "Retry with existing evidence", attempts: ["Recovered once"], need: "Retry", recommendation: "Resume", signature: "blocker", createdAt: new Date().toISOString() };
		const generation = state.generation;
		const authorityCount = state.authorities.length;
		harness.ctx.ui.custom = async () => "resume";
		await harness.command("goal", "");
		const resumed = latestState(harness);
		assert.equal(resumed.status, "running");
		assert.equal(resumed.interrupt, undefined);
		assert.equal(resumed.generation, generation);
		assert.equal(resumed.authorities.length, authorityCount);
		assert.match(JSON.stringify(harness.messages.at(-1)), /Resume from durable state/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("session reload repairs only exact legacy automatic doom-loop interruptions", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-legacy-doom-"));
	try {
		const harness = makeHarness(root);
		const state = injectRunning(harness);
		const interruptedAt = new Date(Date.now() - 1_000).toISOString();
		state.status = "interrupted";
		state.phase = "blocked";
		state.interrupt = { class: "BLOCKER", message: "The same tool call repeated without new evidence.", attempts: ["subagent_result repeated 6 times"], need: "A materially different approach.", recommendation: "Inspect evidence and replan rather than repeating the call.", signature: sha256("BLOCKER\nThe same tool call repeated without new evidence.\nA materially different approach."), createdAt: interruptedAt };
		state.outcome.amendments.push({ id: "reply", text: "okay, approved", createdAt: new Date().toISOString() });
		await harness.emit("session_start", { type: "session_start", reason: "reload" });
		const recovered = latestState(harness);
		assert.equal(recovered.status, "running");
		assert.equal(recovered.interrupt, undefined);
		assert.deepEqual(recovered.repeatedToolCalls, {});
		assert.ok(recovered.outcome.amendments.at(-1).consumedAt);
		assert.match(JSON.stringify(harness.messages.at(-1)), /obsolete duplicate-call interruption/);

		const nearMiss = structuredClone(recovered);
		nearMiss.status = "interrupted";
		nearMiss.phase = "blocked";
		nearMiss.interrupt = { class: "BLOCKER", message: "Human blocker", attempts: ["subagent_result repeated 6 times"], need: "A materially different approach.", recommendation: "Inspect evidence and replan rather than repeating the call.", signature: "human", createdAt: new Date().toISOString() };
		assert.equal(isLegacyAutomaticDoomLoopInterrupt(nearMiss), false);
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

test("three distinct evidenced denials plus replan permit BLOCKER interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-blocker-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		for (const [index, command] of ["uv run pytest -q tests/unit", ".venv/bin/python -m pytest -q tests/unit", ".venv/bin/pytest -q tests/unit"].entries()) {
			const denied = (await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: `deny-${index}`, input: { command } })).find(Boolean);
			assert.equal(denied.block, true);
		}
		const request = { goalId: state.goalId, generation: state.generation, class: "BLOCKER", message: "Typed runner authority is missing", attempts: ["Three exact runners denied"], need: "Narrow authority amendment", recommendation: "Amend exact executable policies" };
		await assert.rejects(() => harness.tool("pi_goal_request_interrupt", request), /need one successful replan/);
		await harness.tool("pi_goal_update_plan", { goalId: state.goalId, generation: state.generation, reason: "Separate authority recovery from implementation", nodes: [{ id: "P1", title: "Implement", status: "in_progress", criterionIds: ["AC1"] }] });
		const opened = await harness.tool("pi_goal_request_interrupt", request);
		assert.match(opened.content[0].text, /BLOCKER interruption opened/);
		const persisted = latestState(harness);
		assert.equal(persisted.status, "interrupted");
		assert.equal(new Set(persisted.recoveryEvidence.filter((item: any) => item.kind === "authority_denial").map((item: any) => item.fingerprint)).size, 3);
		assert.equal(persisted.recoveryEvidence.some((item: any) => item.kind === "replan"), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit steering invalidates deferred and pending RISK actions", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-risk-steering-"));
	try {
		const harness = makeHarness(root);
		const initial = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const firstInput = { record: "first" };
		await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "risk-old-1", input: firstInput });
		assert.ok(latestState(harness).deferredRisk);
		await harness.emit("input", { type: "input", source: "interactive", text: "Change the goal to exclude the external record" });
		let state = latestState(harness);
		assert.equal(state.deferredRisk, undefined);
		await assert.rejects(() => harness.tool("pi_goal_request_interrupt", { goalId: state.goalId, generation: state.generation, class: "RISK", message: "Old action", attempts: [], need: "Old action", recommendation: "Approve" }), /previously blocked/);
		const amendment = state.outcome.amendments.at(-1);
		await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "risk-before-apply", input: { record: "apply" } });
		assert.ok(latestState(harness).deferredRisk);
		await harness.tool("pi_goal_apply_steering", { goalId: state.goalId, generation: state.generation, amendmentId: amendment.id, outcome: state.outcome.current, criteria: state.criteria.map((criterion: any) => criterion.text), reason: "Apply explicit steering" });
		state = latestState(harness);
		assert.equal(state.deferredRisk, undefined);

		const secondInput = { record: "second" };
		await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "risk-old-2", input: secondInput });
		await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "risk-safe", input: { path: "README.md" } });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "risk-safe", input: { path: "README.md" }, isError: false, content: [], details: {} });
		state = latestState(harness);
		await harness.tool("pi_goal_request_interrupt", { goalId: state.goalId, generation: state.generation, class: "RISK", message: "Second action", attempts: ["Read local alternative"], need: "Second action", recommendation: "Approve" });
		assert.ok(latestState(harness).interrupt?.pendingAction);
		await harness.emit("input", { type: "input", source: "interactive", text: "Change the goal to remove the second external action" });
		state = latestState(harness);
		assert.equal(state.status, "running");
		assert.equal(state.interrupt, undefined);
		assert.equal(state.deferredRisk, undefined);
		await harness.emit("input", { type: "input", source: "interactive", text: "approve exact pending risk once" });
		assert.equal(latestState(harness).authorities.length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("detail-overlay explicit steering invalidates stale deferred RISK", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-risk-detail-steering-"));
	try {
		const harness = makeHarness(root);
		const state = createGoalState(draft, harness.ctx);
		state.status = "interrupted";
		state.phase = "blocked";
		state.interrupt = { class: "DECISION", message: "Choose direction", attempts: [], need: "Direction", recommendation: "Resolve", signature: "decision", createdAt: new Date().toISOString() };
		state.deferredRisk = { toolName: "records_create", inputHash: "stale", label: "stale external action", actionClass: "external_write", denials: 1, alternativeToolCallIds: [], createdAt: new Date().toISOString() };
		harness.branch.push({ type: "custom", customType: STATE_CUSTOM_TYPE, data: state });
		harness.ctx.ui.custom = async () => "resolve";
		harness.ctx.ui.editor = async () => "Change the goal to remove all external writes";
		await harness.command("goal", "");
		const resolved = latestState(harness);
		assert.equal(resolved.status, "running");
		assert.equal(resolved.phase, "planning");
		assert.equal(resolved.interrupt, undefined);
		assert.equal(resolved.deferredRisk, undefined);
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
		await harness.emit("input", { type: "input", source: "interactive", text: "resume goal" });
		assert.equal(latestState(harness).status, "interrupted");
		assert.match(harness.notifications.at(-1).message, /Exact pending RISK/);
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

test("background event subscriptions recover after session shutdown and restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-background-restart-"));
	try {
		const harness = makeHarness(root);
		injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("session_shutdown", { type: "session_shutdown" });
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		harness.messages.length = 0;
		harness.pi.events.emit("pi-goal:background-start", { id: "job-restarted", label: "Restarted job", toolName: "job_start" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(latestState(harness).backgroundWork["job-restarted"].label, "Restarted job");
		harness.pi.events.emit("pi-goal:background-end", { id: "job-restarted" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(latestState(harness).backgroundWork["job-restarted"], undefined);
		assert.match(JSON.stringify(harness.messages.at(-1)), /background work completed/);
		await harness.emit("session_shutdown", { type: "session_shutdown" });
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		harness.pi.events.emit("pi-goal:background-start", { id: "job-second-cycle", label: "Second cycle", toolName: "job_start" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const starts = readFileSync(goalArtifact(root, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "background_started" && event.summary.includes("job-second-cycle"));
		assert.equal(starts.length, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("contract rejects cwd-only bash and accepts composed uv authority", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-command-contract-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		await harness.command("goal", "Run focused tests");
		const setup = latestState(harness);
		const contract = {
			...draft,
			phases: [{ id: "P1", title: "Test", criterionIds: ["AC1"], commands: [{ executable: "uv", args: ["run", "pytest", "-q", "tests/unit"], cwd: harness.ctx.cwd }] }],
			verificationChecks: [{ id: "V1", kind: "command_exit", label: "focused", executable: "uv", args: ["run", "pytest", "-q", "tests/unit"], cwd: harness.ctx.cwd }],
			authorities: [{ id: "A1", label: "cwd only", actionClass: "local_process", toolName: "bash", targets: [{ path: "cwd", equals: harness.ctx.cwd }], maxUses: 10 }],
		};
		await assert.rejects(() => harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, ...contract }), /bash authority requires a typed command policy|missing typed/);
		contract.authorities = [
			commandAuthority("A-local", harness.ctx.cwd, "local_process", "uv", ["run", "pytest"]),
			commandAuthority("A-network", harness.ctx.cwd, "network_read", "uv", ["run", "pytest"]),
		] as any;
		await harness.tool("pi_goal_submit_contract", { goalId: setup.goalId, generation: setup.generation, ...contract });
		assert.equal(latestState(harness).status, "awaiting_approval");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("human-approved authority amendment preserves active goal state and resumes same step", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-authority-amend-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		state.currentAction = "Keep this step";
		state.nextAction = "Run focused pytest";
		state.evidence.push({ id: "e1", kind: "tool_result", summary: "valuable evidence", criterionIds: ["AC1"], paths: [], createdAt: new Date().toISOString() });
		const originalPlan = structuredClone(state.plan);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const amendment = await harness.tool("pi_goal_request_authority_amendment", { goalId: state.goalId, generation: state.generation, rationale: "Add omitted venv pytest runner", authorities: [commandAuthority("A-pytest", harness.ctx.cwd, "local_process", ".venv/bin/pytest", [])] });
		assert.match(amendment.content[0].text, /class=local_process/);
		assert.match(amendment.content[0].text, /command=\.venv\/bin\/pytest/);
		assert.match(amendment.content[0].text, /targets=cwd=/);
		assert.match(amendment.content[0].text, /maxUses=20/);
		assert.equal(latestState(harness).status, "interrupted");
		assert.ok(latestState(harness).interrupt.pendingAuthorityAmendment);
		const status = JSON.parse((await harness.tool("pi_goal_status", {})).content[0].text);
		assert.match(status.pendingAuthorityAmendment[0], /class=local_process/);
		assert.match(status.pendingAuthorityAmendment[0], /targets=cwd=/);
		await harness.emit("input", { type: "input", source: "interactive", text: "approve exact authority amendment" });
		const resumed = latestState(harness);
		assert.equal(resumed.goalId, state.goalId);
		assert.equal(resumed.status, "running");
		assert.equal(resumed.currentAction, "Keep this step");
		assert.deepEqual(resumed.plan, originalPlan);
		assert.equal(resumed.evidence.some((item: any) => item.id === "e1"), true);
		assert.equal(resumed.authorities.some((item: any) => item.id === "A-pytest"), true);
		const allowed = (await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "pytest", input: { command: ".venv/bin/pytest -q tests/unit" } })).find(Boolean);
		assert.equal(allowed, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed approved checks return bounded redacted stdout and stderr diagnostics", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-check-diagnostics-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		const secret = "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
		state.verificationChecks = [{ id: "V1", kind: "command_exit", label: "diagnostic", executable: "node", args: ["-e", `process.stdout.write('${secret}'+ 'x'.repeat(9000)); process.stderr.write('stderr detail'); process.exit(4)`], cwd: harness.ctx.cwd }];
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await assert.rejects(() => harness.tool("pi_goal_run_check", { goalId: state.goalId, generation: state.generation, checkId: "V1" }), (error: any) => {
			assert.match(error.message, /check V1 failed/i);
			assert.match(error.message, /exitCode=4/);
			assert.match(error.message, /stderr detail/);
			assert.match(error.message, /stdoutTruncated=true/);
			assert.match(error.message, /\[REDACTED\]/);
			assert.doesNotMatch(error.message, new RegExp(secret));
			return true;
		});
		assert.equal(latestState(harness).recoveryEvidence.some((item: any) => item.kind === "check_failure" && item.checkId === "V1"), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed approved check counts as a safe RISK alternative", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-risk-check-alternative-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		state.verificationChecks = [{ id: "V1", kind: "command_exit", label: "fails safely", executable: "node", args: ["-e", "process.exit(2)"], cwd: harness.ctx.cwd }];
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		const denied = (await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "risk", input: { name: "external" } })).find(Boolean);
		assert.equal(denied.block, true);
		await assert.rejects(() => harness.tool("pi_goal_run_check", { goalId: state.goalId, generation: state.generation, checkId: "V1" }), /check V1 failed/i);
		const opened = await harness.tool("pi_goal_request_interrupt", { goalId: state.goalId, generation: state.generation, class: "RISK", message: "External action required", attempts: ["Approved check failed safely"], need: "Exact action", recommendation: "Approve once" });
		assert.match(opened.content[0].text, /RISK interruption opened/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("successful find inspection counts as a safe RISK alternative", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-risk-find-alternative-"));
	try {
		const harness = makeHarness(root);
		const state = injectRunning(harness);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		assert.equal((await harness.emit("tool_call", { type: "tool_call", toolName: "records_create", toolCallId: "risk", input: { name: "external" } })).find(Boolean).block, true);
		const input = { path: "src" };
		await harness.emit("tool_call", { type: "tool_call", toolName: "find", toolCallId: "find-safe", input });
		await harness.emit("tool_result", { type: "tool_result", toolName: "find", toolCallId: "find-safe", input, isError: false, content: [], details: {} });
		assert.equal(latestState(harness).recoveryEvidence.some((item: any) => item.kind === "safe_alternative" && item.toolName === "find"), true);
		const opened = await harness.tool("pi_goal_request_interrupt", { goalId: state.goalId, generation: state.generation, class: "RISK", message: "External action required", attempts: ["Inspected with find"], need: "Exact action", recommendation: "Approve once" });
		assert.match(opened.content[0].text, /RISK interruption opened/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("authority amendment rejects duplicate IDs without mutating the running goal", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-amend-duplicate-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		state.authorities.push({ ...commandAuthority("A-existing", harness.ctx.cwd, "local_process", ".venv/bin/pytest", []), uses: 0 });
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await assert.rejects(() => harness.tool("pi_goal_request_authority_amendment", { goalId: state.goalId, generation: state.generation, rationale: "duplicate", authorities: [commandAuthority("A-existing", harness.ctx.cwd, "local_process", ".venv/bin/python", ["-m", "pytest"])] }), /already exists/);
		assert.equal(latestState(harness).status, "running");
		assert.equal(latestState(harness).authorities.length, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("completion candidacy fails closed with missing evidence, background work, or no checks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-completion-guards-"));
	try {
		const harness = makeHarness(root);
		mkdirSync(harness.ctx.cwd, { recursive: true });
		const state = injectRunning(harness);
		state.verificationChecks = [];
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await assert.rejects(() => harness.tool("pi_goal_submit_completion_candidate", { goalId: state.goalId, generation: state.generation, summary: "premature" }), /Every criterion needs linked evidence/);
		const readInput = { path: "README.md" };
		await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "evidence-read", input: readInput });
		await harness.emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "evidence-read", input: readInput, isError: false, content: [], details: {} });
		await harness.tool("pi_goal_record_evidence", { goalId: state.goalId, generation: state.generation, summary: "criterion evidence", criterionIds: ["AC1"] });
		harness.pi.events.emit("pi-goal:background-start", { id: "job", label: "work" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		await assert.rejects(() => harness.tool("pi_goal_submit_completion_candidate", { goalId: state.goalId, generation: state.generation, summary: "background" }), /Background work is still active/);
		harness.pi.events.emit("pi-goal:background-end", { id: "job" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const rejected = await harness.tool("pi_goal_submit_completion_candidate", { goalId: state.goalId, generation: state.generation, summary: "no checks" });
		assert.match(rejected.content[0].text, /rejected by approved checks/);
		assert.equal(latestState(harness).completionCandidate, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
