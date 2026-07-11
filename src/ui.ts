import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { progress } from "./state.ts";
import type { GoalSetupTranscript, GoalState } from "./types.ts";

export type SetupAction = "approve" | "refine" | "cancel";
export type DetailAction = "close" | "pause" | "resume" | "cancel" | "approve_risk" | "resolve";

function plainWrap(text: string, width: number): string[] {
	const limit = Math.max(8, width);
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (!words.length) return [""];
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (!line) { line = word; continue; }
		if (visibleWidth(`${line} ${word}`) <= limit) line += ` ${word}`;
		else { lines.push(line); line = word; }
	}
	if (line) lines.push(line);
	return lines;
}

function pad(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…", true);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function box(theme: Theme, title: string, content: string[], width: number): string[] {
	const inner = Math.max(10, width - 2);
	const titleText = truncateToWidth(` ${title} `, inner);
	const topFill = Math.max(0, inner - visibleWidth(titleText));
	const result = [theme.fg("border", "╭") + theme.fg("accent", titleText) + theme.fg("border", `${"─".repeat(topFill)}╮`)];
	for (const line of content) result.push(theme.fg("border", "│") + pad(line, inner) + theme.fg("border", "│"));
	result.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
	return result;
}

function section(lines: string[], title: string, values: string[], width: number): void {
	lines.push("", title);
	for (const value of values) {
		const wrapped = plainWrap(value, Math.max(10, width - 4));
		wrapped.forEach((line, index) => lines.push(index === 0 ? `  ${line}` : `    ${line}`));
	}
}

export function setupContent(state: GoalState, width: number): string[] {
	const lines: string[] = [];
	section(lines, "Outcome", [state.outcome.current], width);
	section(lines, "Done when", state.criteria.map((criterion) => `${criterion.id}  ${criterion.text}`), width);
	section(lines, "Plan", state.plan.map((node, index) => `${index + 1}. ${node.title}${node.description ? ` — ${node.description}` : ""}`), width);
	section(lines, "Verification", state.verificationChecks.map((check) => `${check.id}  ${check.label} (${check.kind})`), width);
	section(lines, "Authority", [
		`Safe work beneath ${state.cwd}: read, write, and local build/test processes.`,
		...(state.authorities.length ? state.authorities.map((authority) => `${authority.label} — ${authority.toolName}, ${authority.maxUses} use${authority.maxUses === 1 ? "" : "s"}`) : ["No external or high-risk actions pre-approved."]),
	], width);
	if (state.constraints.length) section(lines, "Constraints", state.constraints, width);
	if (state.nonGoals.length) section(lines, "Non-goals", state.nonGoals, width);
	section(lines, "Stop conditions", [
		"CREDENTIAL — login or access is genuinely required.",
		"DECISION — a material outcome choice cannot be inferred safely.",
		"RISK — an unapproved destructive, irreversible, costly, or external action is required.",
		"BLOCKER — bounded autonomous recovery has been exhausted.",
	], width);
	lines.push("");
	lines.push(...plainWrap("After approval, Pi continues autonomously until independently verified complete or genuinely blocked.", Math.max(10, width - 2)));
	lines.push("", "Enter approve   R refine   Esc cancel");
	return lines;
}

export function detailContent(state: GoalState, width: number): string[] {
	const lines: string[] = [];
	const summary = progress(state);
	section(lines, "Goal", [state.outcome.current, `State: ${state.status} / ${state.phase}`, `Progress: ${summary.done}/${summary.total} phases; ${summary.met}/${summary.criteria} criteria`], width);
	section(lines, "Now / next", [`Now: ${state.currentAction}`, `Next: ${state.nextAction}`, ...(state.lastEvaluatorReason ? [`Evaluator: ${state.lastEvaluatorReason}`] : [])], width);
	section(lines, "Criteria", state.criteria.map((criterion) => `${criterion.status === "met" ? "✓" : criterion.status === "failed" ? "✗" : criterion.status === "waived" ? "–" : "○"} ${criterion.text}`), width);
	section(lines, "Plan", state.plan.map((node) => `${node.status === "done" ? "✓" : node.status === "in_progress" ? "▶" : node.status === "blocked" ? "!" : "○"} ${node.title}`), width);
	section(lines, "Recent evidence", state.evidence.length ? state.evidence.slice(-8).map((evidence) => `${evidence.kind}: ${evidence.summary}`) : ["No evidence recorded yet."] , width);
	if (Object.keys(state.backgroundWork).length) section(lines, "Background work", Object.values(state.backgroundWork).map((item) => `${item.label} (${item.id})`), width);
	if (state.interrupt) section(lines, `${state.interrupt.class} interruption`, [state.interrupt.message, `Tried: ${state.interrupt.attempts.join("; ") || "none"}`, `Need: ${state.interrupt.need}`, `Recommendation: ${state.interrupt.recommendation}`], width);
	section(lines, "Controls", [
		state.status === "paused" ? "P resume" : "P pause",
		...(state.interrupt?.pendingAction ? [
			"A approve only the displayed pending action once (not a general resume)",
			"R reject or redirect the displayed action with a resolution",
		] : state.status === "interrupted" ? ["R provide blocker resolution"] : []),
		"C cancel goal",
		"Esc close",
	], width);
	return lines;
}

export function panelLayout(contentLength: number, terminalRows: number): { viewport: number; showIndicator: boolean; maxBoxRows: number } {
	const rows = Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 30;
	const maxBoxRows = Math.min(34, Math.max(4, rows - 2));
	if (contentLength <= maxBoxRows - 2) return { viewport: contentLength, showIndicator: false, maxBoxRows };
	return { viewport: Math.max(1, maxBoxRows - 3), showIndicator: true, maxBoxRows };
}

abstract class ScrollPanel implements Component {
	protected scroll = 0;
	protected viewport = 26;
	protected readonly tui: TUI;
	protected readonly theme: Theme;
	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
	}
	abstract content(width: number): string[];
	abstract title(): string;
	abstract handleAction(data: string): boolean;

	handleInput(data: string): void {
		if (matchesKey(data, "up")) { this.scroll = Math.max(0, this.scroll - 1); this.tui.requestRender(); return; }
		if (matchesKey(data, "down")) { this.scroll += 1; this.tui.requestRender(); return; }
		if (matchesKey(data, "pageUp")) { this.scroll = Math.max(0, this.scroll - this.viewport); this.tui.requestRender(); return; }
		if (matchesKey(data, "pageDown")) { this.scroll += this.viewport; this.tui.requestRender(); return; }
		this.handleAction(data);
	}

	render(width: number): string[] {
		const content = this.content(Math.max(12, width - 2));
		const layout = panelLayout(content.length, this.tui.terminal.rows);
		this.viewport = layout.viewport;
		this.scroll = Math.min(this.scroll, Math.max(0, content.length - this.viewport));
		const visible = content.slice(this.scroll, this.scroll + this.viewport);
		if (layout.showIndicator) visible.push(this.theme.fg("dim", `  ↑↓ scroll  ${this.scroll + 1}-${Math.min(content.length, this.scroll + this.viewport)}/${content.length}`));
		return box(this.theme, this.title(), visible, width);
	}

	invalidate(): void {}
	dispose(): void {}
}

class SetupPanel extends ScrollPanel {
	private readonly state: GoalState;
	private readonly done: (result: SetupAction) => void;
	constructor(tui: TUI, theme: Theme, state: GoalState, done: (result: SetupAction) => void) {
		super(tui, theme);
		this.state = state;
		this.done = done;
	}
	content(width: number): string[] { return setupContent(this.state, width); }
	title(): string { return "Goal contract"; }
	handleAction(data: string): boolean {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done("cancel"); return true; }
		if (matchesKey(data, "return")) { this.done("approve"); return true; }
		if (matchesKey(data, "r")) { this.done("refine"); return true; }
		return false;
	}
}

class DetailPanel extends ScrollPanel {
	private readonly state: GoalState;
	private readonly done: (result: DetailAction) => void;
	constructor(tui: TUI, theme: Theme, state: GoalState, done: (result: DetailAction) => void) {
		super(tui, theme);
		this.state = state;
		this.done = done;
	}
	content(width: number): string[] { return detailContent(this.state, width); }
	title(): string { return "Goal control"; }
	handleAction(data: string): boolean {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done("close"); return true; }
		if (matchesKey(data, "p")) { this.done(this.state.status === "paused" ? "resume" : "pause"); return true; }
		if (matchesKey(data, "c")) { this.done("cancel"); return true; }
		if (matchesKey(data, "a") && this.state.interrupt?.pendingAction) { this.done("approve_risk"); return true; }
		if (matchesKey(data, "r") && this.state.status === "interrupted") { this.done("resolve"); return true; }
		return false;
	}
}

export async function showSetupCard(ctx: ExtensionCommandContext, state: GoalState): Promise<SetupAction> {
	return ctx.ui.custom<SetupAction>((tui, theme, _keys, done) => new SetupPanel(tui, theme, state, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "92%", minWidth: 44, maxHeight: 34, margin: 1 },
	});
}

export async function showDetailOverlay(ctx: ExtensionCommandContext, state: GoalState): Promise<DetailAction> {
	return ctx.ui.custom<DetailAction>((tui, theme, _keys, done) => new DetailPanel(tui, theme, state, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "92%", minWidth: 44, maxHeight: 34, margin: 1 },
	});
}

export function widgetLines(ctx: ExtensionContext, state: GoalState): string[] {
	const summary = progress(state);
	const stateColor = state.status === "interrupted" ? "warning" : state.status === "paused" ? "muted" : state.status === "auditing" ? "accent" : "success";
	return [
		`${ctx.ui.theme.fg(stateColor, "🎯")} ${truncateToWidth(state.outcome.current, 100)}`,
		`${ctx.ui.theme.fg("accent", state.phase)} ${summary.done}/${summary.total}  ${ctx.ui.theme.fg("dim", `Now: ${truncateToWidth(state.currentAction, 80)}`)}`,
		ctx.ui.theme.fg("dim", `Next: ${truncateToWidth(state.nextAction, 90)}${state.interrupt ? `  • ${state.interrupt.class}` : ""}`),
	];
}

export function setupTranscriptText(transcript: GoalSetupTranscript): string {
	const lines = [
		"pi-goal setup transcript",
		`Status: ${transcript.status}`,
		`Reason: ${transcript.reason ?? "none"}`,
		`Created: ${transcript.createdAt}`,
		`Updated: ${transcript.updatedAt}`,
		`Redacted: ${transcript.redacted ? "yes" : "no"}`,
		"",
		"/goal outcome:",
		transcript.outcome,
	];
	for (const exchange of transcript.exchanges) {
		lines.push("", `Clarification round ${exchange.round}`);
		exchange.questions.forEach((question, index) => lines.push(`Q${index + 1}: ${question}`));
		lines.push("Answer:", exchange.answer ?? (exchange.cancelled ? "[cancelled before answer]" : "[no answer recorded]"));
	}
	if (transcript.refinements.length) {
		lines.push("", "Refinements:", ...transcript.refinements.map((value, index) => `${index + 1}. ${value}`));
	}
	return `${lines.join("\n")}\n`;
}

export async function showSetupTranscriptEditor(ctx: ExtensionCommandContext, transcript: GoalSetupTranscript): Promise<void> {
	await ctx.ui.editor("Goal setup transcript — copy if needed, then close", setupTranscriptText(transcript));
}

export function updateGoalUi(ctx: ExtensionContext, state?: GoalState): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	if (!state || state.status === "completed" || state.status === "cancelled") {
		ctx.ui.setStatus("pi-goal", undefined);
		ctx.ui.setWidget("pi-goal", undefined);
		return;
	}
	const summary = progress(state);
	ctx.ui.setStatus("pi-goal", ctx.ui.theme.fg(state.status === "interrupted" ? "warning" : "accent", `🎯 ${state.status} • ${state.phase} • ${summary.done}/${summary.total}`));
	ctx.ui.setWidget("pi-goal", widgetLines(ctx, state), { placement: "aboveEditor" });
}
