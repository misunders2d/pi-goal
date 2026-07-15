import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { isSensitivePath, redactText, resolvedPathWithinWorkspaces, safeEvidencePath, workspaceRootForCwd } from "./state.ts";
import type { GoalState, VerificationCheck, VerificationResult } from "./types.ts";

const DENIED_EXECUTABLES = new Set([
	"bash", "sh", "zsh", "fish", "sudo", "su", "doas", "ssh", "scp", "rsync",
	"curl", "wget", "systemctl", "service", "docker", "podman", "kubectl", "helm",
]);

function safeEnvironment(): NodeJS.ProcessEnv {
	const allowed = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TERM|COLORTERM|CI|NO_COLOR|FORCE_COLOR|NODE_[A-Z_]+|npm_config_[A-Za-z_]+)$/;
	return Object.fromEntries(
		Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "NODE_OPTIONS" && allowed.test(key) && !/(?:token|secret|password|credential|auth|cookie|key)/i.test(key)),
	);
}

function runProcess(
	executable: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ exitCode: number; durationMs: number; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean; timedOut: boolean; aborted: boolean; signal?: string }> {
	return new Promise((resolvePromise, reject) => {
		const started = Date.now();
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let forceKill: NodeJS.Timeout | undefined;
		const child = spawn(executable, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: safeEnvironment(),
		});
		const captureLimit = 8_192;
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;
		const terminate = () => {
			child.kill("SIGTERM");
			forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
		};
		const consume = (chunk: Buffer, stream: "stdout" | "stderr") => {
			const text = chunk.toString("utf8");
			if (stream === "stdout") {
				stdoutBytes += chunk.length;
				if (stdout.length < captureLimit) stdout += text.slice(0, captureLimit - stdout.length);
				if (stdoutBytes > captureLimit) stdoutTruncated = true;
			} else {
				stderrBytes += chunk.length;
				if (stderr.length < captureLimit) stderr += text.slice(0, captureLimit - stderr.length);
				if (stderrBytes > captureLimit) stderrTruncated = true;
			}
			// Stay below typical pipe capacity so a flooding child cannot block before
			// the parent observes enough bytes to terminate it.
			if (stdoutBytes + stderrBytes > 131_072) terminate();
		};
		child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
		const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
		const abort = () => { aborted = true; terminate(); };
		signal?.addEventListener("abort", abort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			if (forceKill) clearTimeout(forceKill);
			signal?.removeEventListener("abort", abort);
		};
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.on("close", (code, closeSignal) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise({ exitCode: typeof code === "number" ? code : 128, durationMs: Date.now() - started, stdout, stderr, stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated, timedOut, aborted, signal: closeSignal ?? undefined });
		});
	});
}

function jsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	if (!pointer.startsWith("/")) return undefined;
	let current = value;
	for (const raw of pointer.slice(1).split("/")) {
		const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (!current || typeof current !== "object" || !(key in current)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function checkedPath(cwd: string, path: string, workspaceRoots: string[] = [cwd]): string {
	if (isSensitivePath(path)) throw new Error("verification path is secret-like and cannot be inspected");
	const resolved = resolvedPathWithinWorkspaces(cwd, workspaceRoots, path);
	if (!resolved) throw new Error("verification path leaves the approved workspace");
	if (isSensitivePath(resolved)) throw new Error("verification path resolves to a secret-like target");
	return resolved;
}

export function validateVerificationCheckDefinition(check: VerificationCheck, workspace: string, workspaceRoots: string[] = [workspace]): void {
	switch (check.kind) {
		case "file_exists":
		case "file_contains":
		case "json_equals":
			checkedPath(workspace, check.path, workspaceRoots);
			if (check.kind === "file_contains" && check.regex) {
				try { new RegExp(check.pattern, "m"); }
				catch { throw new Error("verification regex is invalid"); }
			}
			if (check.kind === "json_equals" && check.pointer !== "" && !check.pointer.startsWith("/")) throw new Error("verification JSON pointer is invalid");
			return;
		case "command_exit": {
			if (!check.executable || /[\s;&|<>`$\n\r]/.test(check.executable)) throw new Error("verification executable is invalid");
			const basename = check.executable.split(/[\\/]/).at(-1) ?? check.executable;
			if (DENIED_EXECUTABLES.has(basename)) throw new Error(`verification executable is denied: ${basename}`);
			if (check.args.some((arg) => typeof arg !== "string" || /[\u0000\n\r]/.test(arg))) throw new Error("verification argv contains an invalid value");
			if (["npm", "pnpm", "yarn"].includes(basename)) {
				const operation = check.args[0] ?? "";
				if (/^(?:install|i|add|publish|unpublish|deprecate|login|logout|pack|exec|explore|x|init)$/.test(operation)) throw new Error(`verification package operation is denied: ${operation}`);
				if (operation === "run" && !/^(?:test|check|lint|build|typecheck|verify)(?::[A-Za-z0-9._-]+)?$/.test(check.args[1] ?? "")) throw new Error("verification npm script is outside the test/check/lint/build allowlist");
			}
			if (basename === "git" && !["status", "diff", "show", "log", "rev-parse", "ls-files", "grep"].includes(check.args[0] ?? "")) throw new Error("verification git operation is not read-only");
			if (check.cwd && !resolvedPathWithinWorkspaces(workspace, workspaceRoots, check.cwd)) throw new Error("verification command cwd must remain within an approved workspace root");
			if (isAbsolute(check.executable)) checkedPath(workspace, check.executable, workspaceRoots);
			return;
		}
		case "git_status":
			return;
		case "git_diff":
			for (const path of check.paths ?? []) checkedPath(workspace, path, workspaceRoots);
	}
}

function validateExecutable(check: Extract<VerificationCheck, { kind: "command_exit" }>, workspace: string, workspaceRoots: string[]): { executable: string; cwd: string } {
	validateVerificationCheckDefinition(check, workspace, workspaceRoots);
	const cwd = check.cwd ? checkedPath(workspace, check.cwd, workspaceRoots) : workspaceRootForCwd(workspace, workspaceRoots, workspace)!;
	const executable = isAbsolute(check.executable) ? checkedPath(cwd, check.executable, workspaceRoots) : check.executable;
	return { executable, cwd };
}

export async function runVerificationCheck(check: VerificationCheck, workspace: string, signal?: AbortSignal, workspaceRoots: string[] = [workspace]): Promise<VerificationResult> {
	const started = Date.now();
	try {
		switch (check.kind) {
			case "file_exists": {
				const passed = existsSync(checkedPath(workspace, check.path, workspaceRoots));
				return { checkId: check.id, passed, summary: passed ? "required file exists" : "required file is missing", durationMs: Date.now() - started };
			}
			case "file_contains": {
				const text = readFileSync(checkedPath(workspace, check.path, workspaceRoots), "utf8");
				const passed = check.regex ? new RegExp(check.pattern, "m").test(text) : text.includes(check.pattern);
				return { checkId: check.id, passed, summary: passed ? "required content found" : "required content not found", durationMs: Date.now() - started };
			}
			case "json_equals": {
				const document = JSON.parse(readFileSync(checkedPath(workspace, check.path, workspaceRoots), "utf8"));
				const passed = JSON.stringify(jsonPointer(document, check.pointer)) === JSON.stringify(check.value);
				return { checkId: check.id, passed, summary: passed ? "JSON value matches" : "JSON value differs", durationMs: Date.now() - started };
			}
			case "command_exit": {
				const { executable, cwd } = validateExecutable(check, workspace, workspaceRoots);
				const result = await runProcess(executable, check.args, cwd, Math.max(1_000, Math.min(check.timeoutMs ?? 120_000, 900_000)), signal);
				const expected = check.expectedExitCode ?? 0;
				const passed = !result.timedOut && !result.aborted && result.exitCode === expected;
				const summary = result.timedOut
					? `command timed out after ${result.durationMs}ms`
					: result.aborted
						? "command aborted"
						: result.signal
							? `command terminated by ${result.signal}`
							: passed ? `command exited ${expected}` : `command exited ${result.exitCode}; expected ${expected}`;
				const safeStdout = redactText(result.stdout, 8_192);
				const safeStderr = redactText(result.stderr, 8_192);
				return {
					checkId: check.id, passed, summary, exitCode: result.exitCode,
					timedOut: result.timedOut || undefined, aborted: result.aborted || undefined,
					signal: result.signal, durationMs: result.durationMs,
					...(!passed ? {
						stdout: safeStdout.text, stderr: safeStderr.text,
						stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
						stdoutTruncated: result.stdoutTruncated || safeStdout.redacted || undefined,
						stderrTruncated: result.stderrTruncated || safeStderr.redacted || undefined,
						outputRedacted: safeStdout.redacted || safeStderr.redacted || undefined,
					} : {}),
				};
			}
			case "git_status": {
				const result = await runProcess("git", ["status", "--porcelain"], workspace, 30_000, signal);
				if (result.exitCode !== 0) return { checkId: check.id, passed: false, summary: `git status exited ${result.exitCode}`, exitCode: result.exitCode, durationMs: result.durationMs };
				const isClean = result.stdout.trim().length === 0;
				const expectedClean = check.clean !== false;
				const passed = expectedClean ? isClean : !isClean;
				return { checkId: check.id, passed, summary: passed ? (expectedClean ? "git worktree is clean" : "git worktree contains changes") : (expectedClean ? "git worktree contains changes" : "git worktree is clean"), exitCode: passed ? 0 : 1, durationMs: result.durationMs };
			}
			case "git_diff": {
				const args = ["diff", "--quiet", ...(check.paths?.length ? ["--", ...check.paths.map((path) => checkedPath(workspace, path, workspaceRoots))] : [])];
				const result = await runProcess("git", args, workspace, 30_000, signal);
				const expectedEmpty = check.empty !== false;
				const passed = expectedEmpty ? result.exitCode === 0 : result.exitCode === 1;
				return { checkId: check.id, passed, summary: passed ? (expectedEmpty ? "git diff is empty" : "git diff contains changes") : (expectedEmpty ? "git diff contains changes" : "git diff is empty"), exitCode: result.exitCode, durationMs: result.durationMs };
			}
		}
	} catch (error) {
		return { checkId: check.id, passed: false, summary: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started };
	}
}

export function describeVerificationCheck(check: VerificationCheck, workspace: string): string {
	switch (check.kind) {
		case "file_exists":
		case "file_contains":
		case "json_equals":
			return `path=${JSON.stringify(safeEvidencePath(workspace, check.path))}`;
		case "command_exit": {
			const cwd = check.cwd ? safeEvidencePath(workspace, check.cwd) : ".";
			const executable = redactText(check.executable, 80).text;
			const argv = redactText(JSON.stringify(check.args.map((arg) => redactText(arg, 240).text)), 900).text;
			return `executable=${JSON.stringify(executable)} cwd=${JSON.stringify(cwd)} argv=${argv}`;
		}
		case "git_status":
			return `workspace=${JSON.stringify(safeEvidencePath(workspace, "."))}`;
		case "git_diff":
			return `paths=${redactText(JSON.stringify((check.paths ?? []).map((path) => safeEvidencePath(workspace, path))), 500).text}`;
	}
}

function labelApprovedCheckResult(check: VerificationCheck, result: VerificationResult, workspace: string): VerificationResult {
	const label = JSON.stringify(redactText(check.label, 120).text);
	return { ...result, summary: `setup-approved check ${check.id} ${label} (${describeVerificationCheck(check, workspace)}): ${result.summary}` };
}

export async function runAllChecks(state: GoalState, signal?: AbortSignal): Promise<VerificationResult[]> {
	const results: VerificationResult[] = [];
	for (const check of state.verificationChecks) results.push(labelApprovedCheckResult(check, await runVerificationCheck(check, state.cwd, signal, state.workspaceRoots), state.cwd));
	return results;
}
