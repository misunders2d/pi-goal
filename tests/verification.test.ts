import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		assert.match(result.summary, /setup-approved check V2 "READY\.md content is exactly READY": command exited 1; expected 0/);
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
