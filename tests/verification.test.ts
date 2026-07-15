import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAllChecks, runVerificationCheck } from "../src/verification.ts";

test("typed file, JSON, and command checks execute without a shell", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-verify-"));
	try {
		writeFileSync(join(root, "a.txt"), "hello world\n");
		writeFileSync(join(root, "a.json"), JSON.stringify({ package: { ok: true } }));
		assert.equal((await runVerificationCheck({ id: "V1", kind: "file_exists", label: "exists", path: "a.txt" }, root)).passed, true);
		assert.equal((await runVerificationCheck({ id: "V2", kind: "file_contains", label: "contains", path: "a.txt", pattern: "hello" }, root)).passed, true);
		assert.equal((await runVerificationCheck({ id: "V3", kind: "json_equals", label: "json", path: "a.json", pointer: "/package/ok", value: true }, root)).passed, true);
		const command = await runVerificationCheck({ id: "V4", kind: "command_exit", label: "node", executable: "node", args: ["-e", "process.exit(0)"], expectedExitCode: 0 }, root);
		assert.equal(command.passed, true);
		assert.equal(command.exitCode, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("runAllChecks labels mechanical failures with approved check semantics", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-labeled-fail-"));
	try {
		writeFileSync(join(root, "READY.md"), "READY\n");
		const [result] = await runAllChecks({ cwd: root, verificationChecks: [{ id: "V2", kind: "command_exit", label: "READY.md content is exactly READY", executable: "node", args: ["-e", "const fs=require('fs');process.exit(fs.readFileSync('READY.md','utf8')==='READY'?0:1)"], expectedExitCode: 0 }] } as any);
		assert.equal(result.passed, false);
		assert.match(result.summary, /setup-approved check V2 "READY\.md content is exactly READY" \(executable="node" cwd="\." argv=/);
		assert.match(result.summary, /command exited 1; expected 0/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("labeled file failures expose the sanitized approved target", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-target-fail-"));
	try {
		const [result] = await runAllChecks({ cwd: root, verificationChecks: [{ id: "V1", kind: "file_exists", label: "report exists", path: "Downloads/goal-command-test-report.md" }] } as any);
		assert.equal(result.passed, false);
		assert.match(result.summary, /path="Downloads\/goal-command-test-report\.md"/);
		assert.match(result.summary, /required file is missing/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact byte repair passes the approved command check", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-exact-repair-"));
	try {
		const check = { id: "V2", kind: "command_exit" as const, label: "READY.md content is exactly READY", executable: "node", args: ["-e", "const fs=require('fs');process.exit(fs.readFileSync('READY.md','utf8')==='READY'?0:1)"], expectedExitCode: 0 };
		writeFileSync(join(root, "READY.md"), "READY\n");
		assert.equal((await runVerificationCheck(check, root)).passed, false);
		writeFileSync(join(root, "READY.md"), "READY");
		assert.equal((await runVerificationCheck(check, root)).passed, true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification runner denies shells, sensitive paths, and workspace escape", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-verify-deny-"));
	try {
		assert.equal((await runVerificationCheck({ id: "V1", kind: "command_exit", label: "shell", executable: "bash", args: ["-c", "true"] }, root)).passed, false);
		assert.equal((await runVerificationCheck({ id: "V2", kind: "file_exists", label: "secret", path: ".env" }, root)).passed, false);
		assert.equal((await runVerificationCheck({ id: "V3", kind: "file_exists", label: "outside", path: "../outside" }, root)).passed, false);
		assert.equal((await runVerificationCheck({ id: "V4", kind: "command_exit", label: "publish", executable: "npm", args: ["publish"] }, root)).passed, false);
		for (const operation of ["exec", "explore", "x", "init"]) {
			assert.equal((await runVerificationCheck({ id: `npm-${operation}`, kind: "command_exit", label: operation, executable: "npm", args: [operation, "noop"] }, root)).passed, false);
		}
		assert.equal((await runVerificationCheck({ id: "V5", kind: "command_exit", label: "git mutate", executable: "git", args: ["commit", "-m", "bad"] }, root)).passed, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification command executes in an explicitly approved secondary root", async () => {
	const base = mkdtempSync(join(tmpdir(), "pi-goal-verify-multiroot-"));
	try {
		const primary = join(base, "primary"); const secondary = join(base, "secondary"); const outside = join(base, "outside");
		mkdirSync(primary); mkdirSync(secondary); mkdirSync(outside);
		writeFileSync(join(secondary, "marker.txt"), "secondary\n");
		const approved = await runVerificationCheck({ id: "MULTI", kind: "command_exit", label: "secondary cwd", executable: "node", args: ["-e", "const fs=require('fs');process.exit(fs.readFileSync('marker.txt','utf8')==='secondary\\n'?0:1)"], cwd: secondary }, primary, undefined, [primary, secondary]);
		assert.equal(approved.passed, true);
		const denied = await runVerificationCheck({ id: "OUT", kind: "command_exit", label: "outside cwd", executable: "node", args: ["--version"], cwd: outside }, primary, undefined, [primary, secondary]);
		assert.equal(denied.passed, false);
		assert.match(denied.summary, /approved workspace/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("verification rejects symlinks that resolve outside goal cwd", async () => {
	const base = mkdtempSync(join(tmpdir(), "pi-goal-symlink-"));
	try {
		const inside = join(base, "inside");
		const outside = join(base, "outside");
		mkdirSync(inside); mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "OUTSIDE\n");
		symlinkSync(join(outside, "secret.txt"), join(inside, "link.txt"));
		symlinkSync(join(outside, "missing.txt"), join(inside, "broken-link.txt"));
		const result = await runVerificationCheck({ id: "LINK", kind: "file_contains", label: "link", path: "link.txt", pattern: "OUTSIDE" }, inside);
		const broken = await runVerificationCheck({ id: "BROKEN", kind: "file_exists", label: "broken", path: "broken-link.txt" }, inside);
		assert.equal(result.passed, false);
		assert.equal(broken.passed, false);
		assert.match(result.summary, /leaves the approved workspace/);
		assert.match(broken.summary, /leaves the approved workspace/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("verification child strips NODE_OPTIONS injection", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-node-options-"));
	const previous = process.env.NODE_OPTIONS;
	try {
		process.env.NODE_OPTIONS = "--require=/definitely/missing/pi-goal-injection.js";
		const result = await runVerificationCheck({ id: "ENV", kind: "command_exit", label: "safe node env", executable: "node", args: ["-e", "process.exit(process.env.NODE_OPTIONS ? 1 : 0)"] }, root);
		assert.equal(result.passed, true);
	} finally {
		if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("command timeout is explicit and distinct from ordinary exit", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-timeout-"));
	try {
		const result = await runVerificationCheck({ id: "TIME", kind: "command_exit", label: "timeout", executable: "node", args: ["-e", "setTimeout(()=>{},5000)"], timeoutMs: 1000 }, root);
		assert.equal(result.passed, false);
		assert.equal(result.timedOut, true);
		assert.match(result.summary, /timed out after/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("output flooding is terminated below pipe capacity with bounded diagnostics", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-output-flood-"));
	try {
		const result = await runVerificationCheck({ id: "FLOOD", kind: "command_exit", label: "flood", executable: "node", args: ["-e", "for(;;) process.stdout.write('x'.repeat(65536))"], timeoutMs: 5_000 }, root);
		assert.equal(result.passed, false);
		assert.notEqual(result.timedOut, true);
		assert.equal(result.stdoutTruncated, true);
		assert.ok((result.stdout?.length ?? 0) <= 8_193);
		assert.ok((result.stdoutBytes ?? 0) > 131_072);
		assert.ok(result.durationMs < 5_000);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("git diff failure summary is explicit without synthetic stdout or stderr", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-git-diff-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
		writeFileSync(join(root, "tracked.txt"), "before\n");
		execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
		writeFileSync(join(root, "tracked.txt"), "after\n");
		const result = await runVerificationCheck({ id: "DIFF", kind: "git_diff", label: "clean diff", empty: true }, root);
		assert.equal(result.passed, false);
		assert.match(result.summary, /git diff contains changes/);
		assert.equal(result.stdout, undefined);
		assert.equal(result.stderr, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("git status check includes untracked files", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-git-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		assert.equal((await runVerificationCheck({ id: "V1", kind: "git_status", label: "clean", clean: true }, root)).passed, true);
		writeFileSync(join(root, "untracked.txt"), "x");
		assert.equal((await runVerificationCheck({ id: "V2", kind: "git_status", label: "dirty", clean: true }, root)).passed, false);
		assert.equal((await runVerificationCheck({ id: "V3", kind: "git_status", label: "has changes", clean: false }, root)).passed, true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
