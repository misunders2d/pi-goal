import { basename } from "node:path";
import { isSensitivePath, resolvedPathWithinWorkspace, resolvedPathWithinWorkspaces, workspaceRootForCwd } from "./state.ts";
import type { ActionAuthority, ActionClass, CommandAuthorityPolicy, CommandInvocation, GoalDraft, GoalState, VerificationCheck } from "./types.ts";

export interface ParsedCommand {
	executable: string;
	args: string[];
	cwd: string;
}

function tokenize(command: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of command.trim()) {
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

export function parseSimpleCommand(command: string, cwd: string, workspaceRoots: string[] = [cwd]): { command?: ParsedCommand; error?: string } {
	if (!command.trim()) return { error: "empty command" };
	const separators = command.match(/&&/g)?.length ?? 0;
	if (separators === 1) {
		const [left, right] = command.split(/&&/, 2);
		const cd = tokenize(left ?? "");
		if (cd?.length === 2 && cd[0] === "cd" && isAbsolutePath(cd[1]!)) {
			const target = workspaceRootForCwd(cwd, workspaceRoots, cd[1]!);
			if (!target) return { error: "cd target must exactly equal an approved workspace root" };
			return parseSimpleCommand(right ?? "", target, workspaceRoots);
		}
		return { error: "only exact cd <approved-root> && <simple-command> is allowed" };
	}
	if (/(?:&&|\|\||[;|<>`\n\r]|\$\(|\$\{|[*?{}~])/.test(command)) return { error: "shell construction, expansion, pipes, redirects, or multiple commands are not allowed by typed executable authority" };
	const tokens = tokenize(command);
	if (!tokens?.length) return { error: "command quoting could not be parsed safely" };
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return { error: "environment assignment prefixes are not executable authority" };
	const executable = tokens[0]!;
	if (executable.includes("/")) {
		const resolved = resolvedPathWithinWorkspaces(cwd, workspaceRoots, executable);
		if (!resolved) return { error: "executable path leaves the approved workspace" };
	}
	return { command: { executable, args: tokens.slice(1), cwd } };
}

function isAbsolutePath(path: string): boolean { return path.startsWith("/"); }

function gitHardDeny(args: string[], cwd: string): string | undefined {
	const operation = args[0];
	if (!operation || ["status", "diff", "show", "log", "rev-parse", "ls-files", "grep"].includes(operation)) return undefined;
	if (["reset", "clean", "restore", "checkout", "switch", "rebase", "merge", "cherry-pick", "tag", "branch", "remote", "fetch", "pull"].includes(operation)) return `git ${operation} is outside typed safe Git authority`;
	if (operation === "add") {
		if (args[1] !== "--" || args.length < 3) return "git add requires -- followed by one or more exact workspace paths";
		for (const path of args.slice(2)) {
			if (path.startsWith("-") || path === "." || path === ":/" || !resolvedPathWithinWorkspace(cwd, path)) return "git add broad, option, or outside-workspace pathspec is denied";
		}
		return undefined;
	}
	if (operation === "commit") {
		if (args.length !== 3 || !["-m", "--message"].includes(args[1]!) || !args[2] || args[2]!.length > 500) return "git commit authority permits only one bounded -m/--message value";
		if (/(?:--amend|--all|-a|--no-verify|--no-edit)/.test(args.join(" "))) return "git commit amend, broad staging, and hook bypass are denied";
		return undefined;
	}
	if (operation === "push") {
		if (args.length !== 3 || !args[1] || !args[2] || args.slice(1).some((arg) => arg.startsWith("-") || arg.startsWith("+"))) return "git push authority permits only an exact remote and branch without options or force refspecs";
		return undefined;
	}
	return `git ${operation} is outside typed safe Git authority`;
}

export function hardCommandDenyReason(command: ParsedCommand): string | undefined {
	const executable = basename(command.executable);
	// Preserve the existing read-only health probe; every other systemctl shape remains hard-denied.
	if (executable === "systemctl" && command.args.length === 1 && command.args[0] === "--failed") return undefined;
	if (["bash", "sh", "zsh", "fish", "rm", "sudo", "su", "doas", "chmod", "chown", "mount", "umount", "mkfs", "dd", "systemctl", "service", "shutdown", "reboot", "ssh", "scp", "rsync", "docker", "podman", "kubectl", "helm", "terraform", "ansible", "cntb"].includes(executable)) return `${executable} changes destructive, privileged, service, infrastructure, or remote state`;
	if (["curl", "wget"].includes(executable)) return `${executable} arbitrary network access is denied`;
	if (["npm", "pnpm", "yarn"].includes(executable) && /^(?:install|i|add|publish|unpublish|deprecate|login|logout|exec|x|dlx)$/.test(command.args[0] ?? "")) return `${executable} registry, publication, login, install, or arbitrary execution is denied`;
	if (executable === "pip" && command.args[0] === "install") return "pip install is denied";
	if (/^(?:a2a_|pi_goal_)/i.test(executable)) return `${executable} is not a repository executable`;
	if (executable === "git") return gitHardDeny(command.args, command.cwd);
	return undefined;
}

export function requiredCommandClasses(command: ParsedCommand): ActionClass[] {
	const classes: ActionClass[] = ["local_process"];
	const executable = basename(command.executable);
	if (executable === "uv" && !command.args.includes("--offline") && !command.args.includes("--no-network")) classes.push("network_read");
	if (executable === "git" && command.args[0] === "push") classes.push("external_write");
	return classes;
}

function exactCwdTarget(authority: Pick<ActionAuthority, "targets">, cwd: string): boolean {
	return authority.targets.some((target) => target.path === "cwd" && target.equals === cwd);
}

export function commandPolicyMatches(policy: CommandAuthorityPolicy, command: ParsedCommand): boolean {
	if (policy.executable !== command.executable) return false;
	if (policy.argsPrefix.some((arg, index) => command.args[index] !== arg)) return false;
	const trailing = command.args.slice(policy.argsPrefix.length);
	switch (policy.trailingArgs) {
		case "none": return trailing.length === 0;
		case "any": return true;
		case "single_value": return trailing.length === 1 && trailing[0]!.length > 0 && trailing[0]!.length <= 500 && !/(?:password|secret|token|credential)\s*=/i.test(trailing[0]!);
		case "workspace_paths":
			return trailing.length > 0 && trailing.every((path) => !path.startsWith("-") && path !== "." && path !== ":/" && !isSensitivePath(path) && !!resolvedPathWithinWorkspace(command.cwd, path));
	}
}

function specificity(authority: ActionAuthority): number {
	const trailing = authority.command?.trailingArgs;
	return (authority.command?.argsPrefix.length ?? 0) * 10 + (trailing === "none" ? 4 : trailing === "single_value" ? 3 : trailing === "workspace_paths" ? 2 : 1);
}

export function matchingCommandAuthorities(state: GoalState, command: ParsedCommand): { authorities?: ActionAuthority[]; missing: ActionClass[] } {
	const selected: ActionAuthority[] = [];
	const missing: ActionClass[] = [];
	for (const actionClass of requiredCommandClasses(command)) {
		const matches = state.authorities
			.filter((authority) => authority.toolName === "bash" && authority.actionClass === actionClass && authority.command && authority.uses < authority.maxUses && (!authority.expiresAt || new Date(authority.expiresAt) > new Date()) && exactCwdTarget(authority, command.cwd) && commandPolicyMatches(authority.command, command))
			.sort((left, right) => specificity(right) - specificity(left));
		if (matches[0]) selected.push(matches[0]); else missing.push(actionClass);
	}
	return { authorities: missing.length ? undefined : selected, missing };
}

export function validateCommandAuthorityDefinition(authority: Omit<ActionAuthority, "uses">, workspace: string, workspaceRoots: string[] = [workspace]): string[] {
	const errors: string[] = [];
	if (authority.command && authority.toolName !== "bash") errors.push("command policy is only valid for bash authorities");
	if (authority.toolName !== "bash") return errors;
	if (!authority.command) errors.push("bash authority requires a typed command policy");
	const cwdTargets = authority.targets.filter((target) => target.path === "cwd" && typeof target.equals === "string");
	const commandCwd = cwdTargets.length === 1 ? workspaceRootForCwd(workspace, workspaceRoots, String(cwdTargets[0]!.equals)) : undefined;
	if (!commandCwd) errors.push("bash authority requires exactly one cwd target equal to an approved workspace root");
	const policy = authority.command;
	if (!policy) return errors;
	if (!policy.executable || /[\s;&|<>`$\n\r]/.test(policy.executable)) errors.push("command executable is invalid");
	if (policy.executable.includes("/") && commandCwd && !resolvedPathWithinWorkspaces(commandCwd, workspaceRoots, policy.executable)) errors.push("command executable path leaves the approved workspace");
	if (!Array.isArray(policy.argsPrefix) || policy.argsPrefix.some((arg) => typeof arg !== "string" || /[\u0000\n\r]/.test(arg))) errors.push("command argsPrefix is invalid");
	if (!["none", "any", "workspace_paths", "single_value"].includes(policy.trailingArgs)) errors.push("command trailingArgs policy is invalid");
	const probe: ParsedCommand = { executable: policy.executable, args: [...policy.argsPrefix, ...(policy.trailingArgs === "single_value" ? ["probe"] : policy.trailingArgs === "workspace_paths" ? ["probe-path"] : [])], cwd: commandCwd ?? workspace };
	const hard = hardCommandDenyReason(probe);
	if (hard) errors.push(hard);
	return errors;
}

function invocationFromCheck(check: VerificationCheck, workspace: string): CommandInvocation | undefined {
	return check.kind === "command_exit" ? { executable: check.executable, args: check.args, cwd: check.cwd ?? workspace } : undefined;
}

function coverageErrorsForInvocation(label: string, invocation: CommandInvocation, authorities: Omit<ActionAuthority, "uses">[], workspace: string, workspaceRoots: string[]): string[] {
	const cwd = workspaceRootForCwd(workspace, workspaceRoots, invocation.cwd ?? workspace);
	if (!cwd) return [`${label}: command cwd must equal an approved workspace root`];
	const command: ParsedCommand = { executable: invocation.executable, args: invocation.args, cwd };
	const hard = hardCommandDenyReason(command);
	if (hard) return [`${label}: ${hard}`];
	const inferred = requiredCommandClasses(command);
	const required = [...new Set([...(invocation.actionClasses ?? []), ...inferred])];
	return required.flatMap((actionClass) => {
		const matched = authorities.some((authority) => authority.toolName === "bash" && authority.actionClass === actionClass && authority.command && authority.targets.some((target) => target.path === "cwd" && target.equals === cwd) && commandPolicyMatches(authority.command, command));
		return matched ? [] : [`${label}: missing typed ${actionClass} bash authority for executable=${JSON.stringify(command.executable)} args=${JSON.stringify(command.args)} cwd=${JSON.stringify(cwd)}`];
	});
}

export function validateDraftCommandAuthorities(draft: GoalDraft, workspace: string, workspaceRoots: string[] = [workspace]): string[] {
	const errors = draft.authorities.flatMap((authority) => validateCommandAuthorityDefinition(authority, workspace, workspaceRoots).map((error) => `${authority.id} ${JSON.stringify(authority.label)}: ${error}`));
	for (const check of draft.verificationChecks) {
		const invocation = invocationFromCheck(check, workspace);
		if (invocation) errors.push(...coverageErrorsForInvocation(`verification check ${check.id} ${JSON.stringify(check.label)}`, invocation, draft.authorities, workspace, workspaceRoots));
	}
	for (const phase of draft.phases) {
		for (const [index, invocation] of (phase.commands ?? []).entries()) errors.push(...coverageErrorsForInvocation(`phase ${phase.id ?? phase.title} command ${index + 1}`, invocation, draft.authorities, workspace, workspaceRoots));
	}
	return [...new Set(errors)];
}
