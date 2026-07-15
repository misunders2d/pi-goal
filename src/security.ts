import { isAbsolute, relative, resolve } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { hardCommandDenyReason, matchingCommandAuthorities, parseSimpleCommand } from "./authority.ts";
import { canonicalJson, canonicalContextPath, inputHash, isSensitivePath, resolvedPathWithinWorkspace, resolvedPathWithinWorkspaces, workspaceRootForCwd } from "./state.ts";
import type { ActionAuthority, ActionClass, GoalState } from "./types.ts";

export interface SafetyDecision {
	allow: boolean;
	reason?: string;
	actionClass?: ActionClass;
	authorityId?: string;
	authorityIds?: string[];
	recoverable?: boolean;
}

const READ_NAME = /(^|_)(read|get|list|search|query|find|inspect|status|check|describe|metadata|schema|snapshot|preview|show|fetch)(_|$)/i;
const MUTATION_NAME = /(^|_)(write|edit|update|upload|create|delete|remove|send|archive|cancel|execute|deploy|install|push|publish|mutate|submit|approve|confirm)(_|$)/i;
const MUTATION_DESCRIPTION = /\b(create|update|write|delete|remove|send|upload|publish|deploy|execute|mutate|archive|cancel|submit|change)\b/i;
const BACKGROUND_DESCRIPTION = /\b(background|detached|asynchronous|async job|reports? back|completion message)\b/i;
const PATH_KEY = /(?:^|_)(?:path|file|filename|directory|dir|cwd|root|output|destination|local_path)$/i;
const SECRET_KEY = /(?:secret|token|password|credential|private.?key|api.?key|authorization|cookie)/i;
const SAFE_LOCAL_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "stat", "file", "sha256sum", "md5sum", "grep", "rg", "fd", "find", "sort", "uniq", "cut", "tr", "diff", "cmp", "test", "printf", "echo", "date", "uname", "which", "realpath", "readlink", "pi"]);
const WORKSPACE_MUTATORS = new Set(["mkdir", "touch", "cp", "mv", "chmod", "truncate", "ln"]);
const ARBITRARY_RUNTIMES = new Set(["node", "nodejs", "python", "python3", "perl", "ruby", "php", "deno", "bun", "npx", "tsx", "ts-node"]);

export function toolDeclaresBackground(info: ToolInfo | undefined): boolean {
	return !!info && BACKGROUND_DESCRIPTION.test(`${info.name} ${info.description ?? ""}`);
}

export function getJsonPath(value: unknown, path: string): unknown {
	if (!path) return value;
	let current = value;
	for (const part of path.split(".")) {
		if (!current || typeof current !== "object" || !(part in current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export function authorityMatches(authority: ActionAuthority, toolName: string, input: unknown, at = new Date()): boolean {
	if (authority.toolName !== toolName || authority.uses >= authority.maxUses) return false;
	if (authority.expiresAt && new Date(authority.expiresAt) <= at) return false;
	if (authority.inputHash && authority.inputHash !== inputHash(toolName, input)) return false;
	return authority.targets.every((target) => Object.is(getJsonPath(input, target.path), target.equals));
}

export function matchingAuthority(state: GoalState, toolName: string, input: unknown): ActionAuthority | undefined {
	return state.authorities.find((authority) => authorityMatches(authority, toolName, input));
}

export function extractPaths(value: unknown): string[] {
	const paths: string[] = [];
	const seen = new Set<object>();
	function walk(current: unknown, key = "", depth = 0): void {
		if (depth > 6 || current == null) return;
		if (typeof current === "string") {
			if (PATH_KEY.test(key)) paths.push(current);
			return;
		}
		if (typeof current !== "object" || seen.has(current as object)) return;
		seen.add(current as object);
		if (Array.isArray(current)) {
			for (const item of current) walk(item, key, depth + 1);
			return;
		}
		for (const [childKey, item] of Object.entries(current as Record<string, unknown>)) walk(item, childKey, depth + 1);
	}
	walk(value);
	return [...new Set(paths)];
}

export function inputContainsSecretField(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const seen = new Set<object>();
	function walk(current: unknown, depth = 0): boolean {
		if (!current || typeof current !== "object" || depth > 6 || seen.has(current as object)) return false;
		seen.add(current as object);
		if (Array.isArray(current)) return current.some((item) => walk(item, depth + 1));
		for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
			if (SECRET_KEY.test(key) && typeof item === "string" && item.length > 0) return true;
			if (walk(item, depth + 1)) return true;
		}
		return false;
	}
	return walk(value);
}

function shellTokens(segment: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of segment.trim()) {
		if (escaped) { current += character; escaped = false; continue; }
		if (character === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; continue; }
		if (/\s/.test(character)) {
			if (current) { tokens.push(current); current = ""; }
			continue;
		}
		current += character;
	}
	if (quote || escaped) return undefined;
	if (current) tokens.push(current);
	return tokens;
}

const ALWAYS_RISKY = new Set([
	"sudo", "su", "doas", "chmod", "chown", "mount", "umount", "mkfs", "dd",
	"systemctl", "service", "shutdown", "reboot", "ssh", "scp", "rsync",
	"docker", "podman", "kubectl", "helm", "terraform", "ansible", "cntb",
]);

const READ_ONLY_PIPE_COMMANDS = new Set(["cat", "cut", "fd", "file", "find", "grep", "head", "ls", "pwd", "rg", "sed", "sort", "stat", "tail", "tr", "uniq", "wc"]);

function isExactReadOnlySystemctl(tokens: string[]): boolean {
	return tokens.length === 2 && tokens[0] === "systemctl" && tokens[1] === "--failed";
}

export function isGoalPrivatePath(cwd: string, agentDir: string | undefined, candidate: string): boolean {
	if (!agentDir) return false;
	const root = resolve(agentDir, "pi-goal");
	const target = resolve(cwd, candidate);
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeReadOnlyPipeline(segment: string, cwd: string, agentDir?: string): boolean {
	const stages = segment.split(/\s*\|\s*/).filter(Boolean);
	if (stages.length < 2) return false;
	for (const stage of stages) {
		const tokens = shellTokens(stage);
		if (!tokens?.length || !READ_ONLY_PIPE_COMMANDS.has(tokens[0]!)) return false;
		if (tokens.some((token) => isGoalPrivatePath(cwd, agentDir, token))) return false;
		if (tokens[0] === "find" && tokens.some((token) => /^(?:-delete|-exec|-execdir|-ok|-okdir)$/.test(token))) return false;
		if (tokens[0] === "sed" && tokens.some((token) => token === "-i" || token.startsWith("--in-place"))) return false;
		if (tokens.some((token) => /[<>`$\n\r;]/.test(token))) return false;
	}
	return true;
}

function obviousHardCommandRisk(command: string, cwd: string): string | undefined {
	for (const clause of command.split(/(?:&&|\|\||[;|])/).map((item) => item.trim()).filter(Boolean)) {
		const tokens = shellTokens(clause);
		if (!tokens?.length) continue;
		const executable = tokens[0]!;
		if (isExactReadOnlySystemctl(tokens)) continue;
		if (ALWAYS_RISKY.has(executable)) return `${executable} changes privileged, service, infrastructure, or remote state`;
		if (["bash", "sh", "zsh", "fish"].includes(executable)) return "nested shell execution requires typed authority";
		if (executable === "rm") return "file deletion requires typed authority";
		if (executable === "find" && tokens.some((token) => /^(?:-delete|-exec|-execdir|-ok|-okdir)$/.test(token))) return "find mutation or command execution requires typed authority";
		if (executable === "sed" && tokens.some((token) => token === "-i" || token.startsWith("--in-place"))) return "in-place file mutation requires typed authority";
		if (["curl", "wget"].includes(executable)) return "network process requires typed authority";
		if (ARBITRARY_RUNTIMES.has(executable) && !tokens.slice(1).every((token) => /^(?:--version|-v)$/.test(token))) return `${executable} can execute arbitrary code and requires typed authority`;
		if (["npm", "pnpm", "yarn"].includes(executable) && !tokens.slice(1).every((token) => /^(?:--version|-v)$/.test(token))) return `${executable} scripts can execute arbitrary code and require approved verification or typed authority`;
		if (WORKSPACE_MUTATORS.has(executable)) {
			const operands = tokens.slice(1).filter((token) => !token.startsWith("-"));
			if (!operands.length || operands.some((token) => !resolvedPathWithinWorkspace(cwd, token))) return `${executable} target leaves the approved workspace`;
		}
		if (SAFE_LOCAL_COMMANDS.has(executable)) {
			const operands = tokens.slice(1).filter((token) => !token.startsWith("-"));
			if (operands.some((token) => !resolvedPathWithinWorkspace(cwd, token))) return `${executable} path leaves the approved workspace`;
		}
		if (!SAFE_LOCAL_COMMANDS.has(executable) && !WORKSPACE_MUTATORS.has(executable) && !ARBITRARY_RUNTIMES.has(executable) && !["npm", "pnpm", "yarn", "cd", "git", "systemctl"].includes(executable)) return `${executable} is outside the autonomous local-process allowlist`;
		if (executable === "pip" && tokens[1] === "install") return "package installation requires typed authority";
		if (executable === "git") {
			const operationIndex = tokens[1] === "-C" ? 3 : 1;
			if (tokens[1] === "-C") {
				const target = tokens[2];
				if (!target || !resolvedPathWithinWorkspace(cwd, target)) return "git -C target leaves the approved workspace";
			}
			const operation = tokens[operationIndex];
			if (operation && !["status", "diff", "show", "log", "rev-parse", "ls-files", "grep"].includes(operation)) return `git ${operation} mutates or contacts repository state`;
		}
	}
	return undefined;
}

function commandRisk(command: string, cwd: string, agentDir?: string, workspaceRoots: string[] = [cwd]): { risky: boolean; reason?: string; recoverable?: boolean } {
	if (!command.trim()) return { risky: true, reason: "empty command", recoverable: true };
	const hardRisk = obviousHardCommandRisk(command, cwd);
	if (hardRisk) return { risky: true, reason: hardRisk };
	if (/[\n\r;<>`]/.test(command) || command.includes("||") || /\$\(|\$\{|\b(?:eval|exec)\b/.test(command)) {
		return { risky: true, reason: "complex shell syntax, redirects, interpolation, or command construction are outside the local-process envelope; use typed tools or approved verification checks", recoverable: true };
	}
	const segments = command.split(/\s+&&\s+/).filter(Boolean);
	if (!segments.length) return { risky: true, reason: "command could not be parsed", recoverable: true };
	for (const segment of segments) {
		if (segment.includes("|") && safeReadOnlyPipeline(segment, cwd, agentDir)) continue;
		if (segment.includes("|")) return { risky: true, reason: "pipeline contains a non-read-only command or protected goal-state path", recoverable: true };
		const tokens = shellTokens(segment);
		if (!tokens?.length) return { risky: true, reason: "command quoting could not be parsed safely", recoverable: true };
		if (tokens.some(isSensitivePath)) return { risky: true, reason: "secret/auth/key paths are outside goal evidence authority", recoverable: true };
		if (tokens.some((token) => isGoalPrivatePath(cwd, agentDir, token))) return { risky: true, reason: "goal-private state is not worker-readable", recoverable: true };
		const executable = tokens[0]!;
		if (isExactReadOnlySystemctl(tokens)) continue;
		if (executable === "cd") {
			const target = tokens[1];
			if (tokens.length !== 2 || !target) return { risky: true, reason: "cd target leaves the approved workspace", recoverable: true };
			if (!resolvedPathWithinWorkspace(cwd, target)) {
				const approvedSecondary = workspaceRootForCwd(cwd, workspaceRoots, target);
				return { risky: true, reason: approvedSecondary ? "secondary-root commands require exact typed executable authority" : "cd target leaves the approved workspace", recoverable: true };
			}
			continue;
		}
		if (ALWAYS_RISKY.has(executable)) return { risky: true, reason: `${executable} changes privileged, service, infrastructure, or remote state` };
		if (executable === "rm" && tokens.slice(1).some((token) => token.startsWith("-") && /[rf]/.test(token))) return { risky: true, reason: "recursive/forced deletion is not autonomously allowed" };
		if (["curl", "wget"].includes(executable)) return { risky: true, reason: "network process requires typed authority" };
		if (["npm", "pnpm", "yarn"].includes(executable) && tokens.slice(1).some((token) => /^(?:install|i|add|publish|unpublish|deprecate|login|logout)$/.test(token))) {
			return { risky: true, reason: "package registry/install/publication action requires typed authority" };
		}
		if (executable === "pip" && tokens[1] === "install") return { risky: true, reason: "package installation requires typed authority" };
		if (executable === "git") {
			const operationIndex = tokens[1] === "-C" ? 3 : 1;
			if (tokens[1] === "-C") {
				const target = tokens[2];
				if (!target || !resolvedPathWithinWorkspace(cwd, target)) return { risky: true, reason: "git -C target leaves the approved workspace" };
			}
			const operation = tokens[operationIndex];
			if (operation && !["status", "diff", "show", "log", "rev-parse", "ls-files", "grep"].includes(operation)) {
				return { risky: true, reason: `git ${operation} mutates or contacts repository state` };
			}
		}
	}
	return { risky: false };
}

export function classifyToolCall(
	state: GoalState,
	toolName: string,
	input: Record<string, unknown>,
	info?: ToolInfo,
	agentDir?: string,
): SafetyDecision {
	if (toolName.startsWith("pi_goal_")) return { allow: true };
	if (inputContainsSecretField(input)) return { allow: false, reason: "tool input contains a credential-like field; goal mode blocked it without storing or forwarding the value", actionClass: "external_write", recoverable: true };
	const paths = extractPaths(input);
	if (paths.some(isSensitivePath)) return { allow: false, reason: "secret/auth/key paths are outside goal evidence authority", actionClass: "workspace_read", recoverable: true };
	if (paths.some((path) => isGoalPrivatePath(state.cwd, agentDir, path))) return { allow: false, reason: "goal-private state is not worker-readable", actionClass: "workspace_read", recoverable: true };
	const resolvedPaths = paths.map((path) => resolvedPathWithinWorkspaces(state.cwd, state.workspaceRoots, path));
	if (paths.length && resolvedPaths.some((path) => !path)) {
		const writeLike = toolName === "write" || toolName === "edit";
		return { allow: false, reason: "tool path leaves the approved workspace or traverses a symlink boundary", actionClass: writeLike ? "workspace_write" : "workspace_read", recoverable: writeLike ? undefined : true };
	}
	if (resolvedPaths.some((path) => path && isSensitivePath(path))) return { allow: false, reason: "tool path resolves to a secret/auth/key target", actionClass: "workspace_read", recoverable: true };

	if (toolName === "write" || toolName === "edit") return { allow: true, actionClass: "workspace_write" };
	if (["read", "grep", "find", "ls"].includes(toolName)) return { allow: true, actionClass: "workspace_read" };
	if (toolName === "bash") {
		const commandText = typeof input.command === "string" ? input.command : "";
		const parsed = parseSimpleCommand(commandText, state.cwd, state.workspaceRoots);
		if (parsed.command) {
			const hardDeny = hardCommandDenyReason(parsed.command);
			if (hardDeny) return { allow: false, reason: hardDeny, actionClass: "destructive" };
			const commandMatch = matchingCommandAuthorities(state, parsed.command);
			if (commandMatch.authorities) return { allow: true, actionClass: commandMatch.authorities.at(-1)?.actionClass ?? "local_process", authorityIds: commandMatch.authorities.map((authority) => authority.id) };
			if (canonicalContextPath(parsed.command.cwd) !== canonicalContextPath(state.cwd)) return { allow: false, reason: `missing typed ${commandMatch.missing.join(" + ") || "local_process"} authority for command cwd ${JSON.stringify(parsed.command.cwd)}`, actionClass: "local_process" };
			const risk = commandRisk(commandText, state.cwd, agentDir, state.workspaceRoots);
			if (!risk.risky) return { allow: true, actionClass: "local_process" };
			if (risk.recoverable) return { allow: false, reason: risk.reason, actionClass: "local_process", recoverable: true };
			const exactAuthority = matchingAuthority(state, toolName, input);
			if (exactAuthority?.inputHash && !exactAuthority.command) return { allow: true, actionClass: exactAuthority.actionClass, authorityId: exactAuthority.id };
			return { allow: false, reason: `missing typed ${commandMatch.missing.join(" + ")} authority for executable ${JSON.stringify(parsed.command.executable)} in ${JSON.stringify(state.cwd)}`, actionClass: commandMatch.missing.includes("external_write") ? "external_write" : "local_process" };
		}
		const risk = commandRisk(commandText, state.cwd, agentDir, state.workspaceRoots);
		if (!risk.risky) return { allow: true, actionClass: "local_process" };
		return { allow: false, reason: parsed.error ?? risk.reason, actionClass: "local_process", recoverable: risk.recoverable };
	}

	const combined = `${toolName} ${info?.description ?? ""}`;
	const appearsMutating = MUTATION_NAME.test(toolName) || MUTATION_DESCRIPTION.test(info?.description ?? "");
	const appearsReadOnly = (READ_NAME.test(toolName) || /\bread[- ]only\b/i.test(info?.description ?? "")) && !appearsMutating;
	if (appearsReadOnly) return { allow: true, actionClass: /web|http|network/i.test(combined) ? "network_read" : "workspace_read" };
	const authority = matchingAuthority(state, toolName, input);
	if (authority) return { allow: true, actionClass: authority.actionClass, authorityId: authority.id };
	return {
		allow: false,
		reason: appearsMutating
			? "mutating or external custom tool is outside the typed setup authority"
			: "unknown custom tool has no provable read-only contract or typed setup authority",
		actionClass: appearsMutating ? "external_write" : "destructive",
	};
}

export function canonicalTargetSummary(input: unknown): string {
	const serialized = canonicalJson(input);
	return serialized.length <= 180 ? serialized : `${serialized.slice(0, 180)}…`;
}

export function pathLeavesWorkspace(cwd: string, path: string, workspaceRoots: string[] = [cwd]): boolean {
	return !resolvedPathWithinWorkspaces(cwd, workspaceRoots, path);
}
