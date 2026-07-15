export const GOAL_SCHEMA_VERSION = 1 as const;

export type GoalStatus =
	| "setting_up"
	| "awaiting_approval"
	| "running"
	| "paused"
	| "interrupted"
	| "auditing"
	| "completed"
	| "cancelled";

export type GoalPhase =
	| "setup"
	| "planning"
	| "executing"
	| "verifying"
	| "recovering"
	| "auditing"
	| "blocked"
	| "done";

export type InterruptClass = "CREDENTIAL" | "DECISION" | "RISK" | "BLOCKER";
export type CriterionStatus = "pending" | "met" | "failed" | "waived";
export type NodeStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";

export interface GoalCriterion {
	id: string;
	text: string;
	status: CriterionStatus;
	evidenceIds: string[];
	waiverReason?: string;
}

export interface CommandInvocation {
	executable: string;
	args: string[];
	cwd?: string;
	actionClasses?: ActionClass[];
}

export interface GoalNode {
	id: string;
	title: string;
	description?: string;
	commands?: CommandInvocation[];
	status: NodeStatus;
	dependsOn: string[];
	criterionIds: string[];
	evidenceIds: string[];
	createdAt: string;
	updatedAt: string;
}

export type VerificationCheck =
	| { id: string; kind: "file_exists"; label: string; path: string }
	| { id: string; kind: "file_contains"; label: string; path: string; pattern: string; regex?: boolean }
	| { id: string; kind: "json_equals"; label: string; path: string; pointer: string; value: unknown }
	| {
			id: string;
			kind: "command_exit";
			label: string;
			executable: string;
			args: string[];
			cwd?: string;
			expectedExitCode?: number;
			timeoutMs?: number;
	  }
	| { id: string; kind: "git_status"; label: string; clean?: boolean }
	| { id: string; kind: "git_diff"; label: string; empty?: boolean; paths?: string[] };

export type ActionClass =
	| "workspace_read"
	| "workspace_write"
	| "local_process"
	| "network_read"
	| "external_write"
	| "publication"
	| "destructive";

export interface AuthorityTarget {
	path: string;
	equals: string | number | boolean | null;
}

export type CommandTrailingPolicy = "none" | "any" | "workspace_paths" | "single_value";

export interface CommandAuthorityPolicy {
	executable: string;
	argsPrefix: string[];
	trailingArgs: CommandTrailingPolicy;
}

export interface ActionAuthority {
	id: string;
	label: string;
	actionClass: ActionClass;
	toolName: string;
	targets: AuthorityTarget[];
	command?: CommandAuthorityPolicy;
	inputHash?: string;
	maxUses: number;
	uses: number;
	expiresAt?: string;
}

export type EvidenceKind =
	| "tool_result"
	| "file_metadata"
	| "diff_metadata"
	| "test_result"
	| "verification_check"
	| "audit_report"
	| "user_statement"
	| "recovery_note";

export interface EvidenceRecord {
	id: string;
	kind: EvidenceKind;
	summary: string;
	criterionIds: string[];
	nodeId?: string;
	toolCallId?: string;
	toolName?: string;
	paths: string[];
	inputHash?: string;
	exitCode?: number;
	isError?: boolean;
	redacted?: boolean;
	createdAt: string;
}

export interface ToolObservation {
	toolCallId: string;
	toolName: string;
	inputHash: string;
	isError: boolean;
	exitCode?: number;
	paths: string[];
	createdAt: string;
}

export interface BackgroundWork {
	id: string;
	label: string;
	toolName?: string;
	startedAt: string;
	updatedAt: string;
}

export interface PendingRiskAction {
	toolName: string;
	inputHash: string;
	label: string;
	actionClass?: ActionClass;
}

export interface DeferredRiskAction extends PendingRiskAction {
	denials: number;
	alternativeToolCallIds: string[];
	createdAt: string;
}

export interface PendingAuthorityAmendment {
	authorities: Omit<ActionAuthority, "uses">[];
	rationale: string;
	requestedAt: string;
	resumePhase: GoalPhase;
	resumeCurrentAction: string;
	resumeNextAction: string;
}

export interface RecoveryEvidence {
	id: string;
	kind: "authority_denial" | "check_failure" | "safe_alternative" | "replan";
	fingerprint: string;
	summary: string;
	createdAt: string;
	toolCallId?: string;
	toolName?: string;
	checkId?: string;
	nodeId?: string;
}

export interface GoalInterrupt {
	class: InterruptClass;
	message: string;
	attempts: string[];
	need: string;
	recommendation: string;
	signature: string;
	createdAt: string;
	pendingAction?: PendingRiskAction;
	pendingAuthorityAmendment?: PendingAuthorityAmendment;
}

export interface GoalAmendment {
	id: string;
	text: string;
	createdAt: string;
	consumedAt?: string;
}

export interface EvaluatorReport {
	id: string;
	action: "continue" | "recover" | "verify" | "interrupt" | "complete_candidate";
	reason: string;
	currentAction: string;
	nextAction: string;
	interrupt?: Omit<GoalInterrupt, "createdAt" | "signature">;
	createdAt: string;
}

export interface AuditReport {
	id: string;
	verdict: "pass" | "fail";
	reason: string;
	criterionResults: Array<{
		criterionId: string;
		status: CriterionStatus;
		evidenceIds: string[];
		note: string;
	}>;
	missingCriteria: string[];
	createdAt: string;
}

export interface GoalState {
	schemaVersion: typeof GOAL_SCHEMA_VERSION;
	goalId: string;
	sessionId: string;
	cwd: string;
	status: GoalStatus;
	phase: GoalPhase;
	generation: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
	approvedAt?: string;
	completedAt?: string;
	outcome: {
		original: string;
		current: string;
		amendments: GoalAmendment[];
	};
	criteria: GoalCriterion[];
	plan: GoalNode[];
	verificationChecks: VerificationCheck[];
	authorities: ActionAuthority[];
	constraints: string[];
	nonGoals: string[];
	evidence: EvidenceRecord[];
	observations: ToolObservation[];
	evaluatorReports: EvaluatorReport[];
	auditReports: AuditReport[];
	interrupt?: GoalInterrupt;
	deferredRisk?: DeferredRiskAction;
	currentAction: string;
	nextAction: string;
	lastEvaluatorReason?: string;
	completionCandidate: boolean;
	continuationSequence: number;
	lastContinuationKey?: string;
	turnCount: number;
	recoveryCount: number;
	auditFailureCount: number;
	verificationFailureSignature?: string;
	verificationFailureCount: number;
	verificationRecoveryStartedAt?: string;
	noProgressCount: number;
	lastProgressMarker?: string;
	repeatedToolCalls: Record<string, number>;
	repeatedBlockers: Record<string, number>;
	recoveryEvidence: RecoveryEvidence[];
	activeToolCalls: Record<string, { toolName: string; startedAt: string }>;
	backgroundWork: Record<string, BackgroundWork>;
	setupAwaitingUser?: boolean;
}

export interface GoalDraft {
	outcome: string;
	criteria: string[];
	phases: Array<{
		id?: string;
		title: string;
		description?: string;
		commands?: CommandInvocation[];
		dependsOn?: string[];
		criterionIds?: string[];
	}>;
	verificationChecks: VerificationCheck[];
	authorities: Omit<ActionAuthority, "uses">[];
	constraints: string[];
	nonGoals: string[];
}

export interface GoalSetupTranscriptExchange {
	round: number;
	questions: string[];
	answer?: string;
	cancelled?: boolean;
	at: string;
}

export interface GoalSetupTranscript {
	schemaVersion: typeof GOAL_SCHEMA_VERSION;
	transcriptId: string;
	sessionId: string;
	cwd: string;
	status: "planning" | "ready" | "failed" | "cancelled";
	outcome: string;
	refinements: string[];
	exchanges: GoalSetupTranscriptExchange[];
	reason?: string;
	redacted: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface GoalEventRecord {
	schemaVersion: typeof GOAL_SCHEMA_VERSION;
	goalId: string;
	sessionId: string;
	revision: number;
	type: string;
	summary: string;
	at: string;
}

export interface EvaluatorDecision {
	action: EvaluatorReport["action"];
	reason: string;
	currentAction: string;
	nextAction: string;
	interrupt?: {
		class: InterruptClass;
		message: string;
		attempts: string[];
		need: string;
		recommendation: string;
		pendingAction?: GoalInterrupt["pendingAction"];
	};
}

export interface AuditDecision {
	verdict: "pass" | "fail";
	reason: string;
	criterionResults: AuditReport["criterionResults"];
	missingCriteria: string[];
}

export interface VerificationResult {
	checkId: string;
	passed: boolean;
	summary: string;
	exitCode?: number;
	timedOut?: boolean;
	aborted?: boolean;
	signal?: string;
	durationMs: number;
	stdout?: string;
	stderr?: string;
	stdoutBytes?: number;
	stderrBytes?: number;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
	outputRedacted?: boolean;
}
