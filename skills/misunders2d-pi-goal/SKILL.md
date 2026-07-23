---
name: misunders2d-pi-goal
description: Operate @misunders2d/pi-goal's same-conversation /goal lifecycle. Use to start or draft a multi-step goal, review/approve its contract, inspect status, steer, pause/resume/cancel, recover after reload, resolve an interruption, or approve an exact authority amendment or pending risk. Covers one typed-authority contract, durable evidence, bounded recovery, mechanical verification, and independent audit. Do not use for tiny one-shot tasks, standalone reminders, generic project-tracker advice, A2A coordination, or scheduler design.
---

# Pi Goal Operator

Use this skill for the `/goal` command and `pi_goal_*` tools supplied by `@misunders2d/pi-goal`. The extension owns state, authority enforcement, continuation, verification, and audit. This skill teaches the agent how to operate that runtime; it does not grant authority or replace runtime checks.

## Start and scope

Use `/goal` when work is multi-step, must survive turns/reloads, or needs evidence-gated autonomous completion. Work directly for a small one-shot task. Use the appropriate scheduling mechanism—not goal mode—for a standalone reminder.

When the user asks for copyable goal text, return raw text beginning with literal `/goal`; do not add a heading, fence, or preface.

`/goal <outcome>` starts setup in the current conversation. The original wording remains authoritative. Resolve prior references from conversation context and ask only questions whose answers materially change scope, done conditions, verification, or authority. Do not inspect the workspace, local files, attachments/uploads, or screenshot paths or call operational tools before approval. During setup, only `pi_goal_submit_contract` and `pi_goal_status` are allowed. Ask the user to paste relevant text; if inspection is essential, explain that setup must be cancelled before normal inspection and then restarted.

## Submit one complete contract

Call `pi_goal_submit_contract` only after the target is clear. Submit the whole contract, not incremental fragments:

1. Observable, outcome-based criteria.
2. Ordered phases and criterion mapping.
3. Approved mechanical checks.
4. Canonical workspace roots.
5. Every foreseeable typed authority needed for routine completion.
6. Explicit constraints and non-goals.

Every phase command must have matching executable authority: exact tool, cwd/root, argv policy, required action classes, bounded use count, and hash where applicable. Prose and labels never grant authority. Do not include secrets.

Criteria receive IDs `AC1`, `AC2`, ... in array order. Phase `criterionIds` may use `AC<n>` or `C<n>`; unknown references fail validation instead of disappearing. Diagnostics aggregate independently detectable root, criterion, check, authority, and plan defects when possible. Fix every listed field before resubmitting.

A workspace root may be an existing canonical directory or an exact planned absolute child path whose nearest existing ancestor resolves without symlink aliases. Do not approve a broad parent merely to create a child. For built-in `git_status`/`git_diff` or `command_exit` Git checks in another approved root, set the check's `cwd`; do not put `-C` in verifier argv. Use `git diff --quiet HEAD --` when staged and unstaged tracked changes must both be absent.

If submission fails, read the complete diagnostic and make one material correction to the full contract. Do not repeat an equivalent payload. The runtime stops setup after two equivalent failures or three distinct failures for one user reply. When capped, stop immediately. A complaint, acknowledgement, question, attachment/upload, screenshot path, or unrelated message does not reset the budget. Ask the user for `Correction: <changed root, criterion, check, command, authority, or constraint>`, then resubmit only after that material correction. Do not restart or create a new `/goal` as repair-loop recovery.

After a contract validates, tell the user to run bare `/goal` to review, refine, cancel, or approve it. One approval covers only the displayed contract and declared authority envelope. Do not begin work before approval.

## Human controls

Bare `/goal` is the interactive control surface for approval, progress, pause/resume, interruption resolution, and cancellation. `/goal cancel` and exact cancellation aliases cancel any active setup or goal immediately; negated cancellation remains non-mutating. Never treat generic wording such as `I approve it` as approval for a pending risk or authority amendment, and never reply that it was approved. Require bare `/goal`, `approve exact authority amendment`, or `approve exact pending risk once`; each exact phrase approves only its displayed scope. Informational/status questions and neutral acknowledgements such as `okay, continue` do not mutate the goal. Only explicit steering changes the outcome or plan.

## Common contract patterns

- **File-only:** observable content criteria, file checks, exact write/edit paths, and only the required workspace authority.
- **Git:** make repository root an approved root; put that root in each Git check's `cwd`; keep mutation commands and read-only verification separate.
- **Planned root:** declare the exact future directory, not its broad parent; include collision-safe creation and checks rooted at that exact path.
- **Reload:** keep checks outcome-based; after reload, call `pi_goal_status` and resume from persisted IDs rather than rebuilding the contract.

Start with the smallest realistic smoke path. Test cancellation and successful completion as separate terminal scenarios; one goal cannot finish through both.

## Execute from durable state

After approval:

- Read `pi_goal_status` before acting after reload, compaction, interruption, or stale-ID errors.
- Follow the current DAG; use `pi_goal_update_plan` for material replanning without changing user-owned criteria or authority.
- Prefer typed tools and setup-approved checks. Run immutable checks with `pi_goal_run_check`.
- Record successful evidence with `pi_goal_record_evidence`; narrative progress is not proof.
- If a necessary executable authority was omitted, request only the narrow missing scope with `pi_goal_request_authority_amendment`. Do not recreate or silently broaden the goal.
- Apply user steering only through `pi_goal_apply_steering` with the extension-provided amendment ID.
- Request an interruption only for an actionable `CREDENTIAL`, `DECISION`, `RISK`, or repeatedly proven `BLOCKER` after bounded safe recovery.

A denied optional action is not automatically a blocker. Choose a safe in-envelope alternative and replan. Never retry identical denied calls in a loop.

## Complete and stop

Submit `pi_goal_submit_completion_candidate` only when every criterion has linked evidence and approved checks should pass. Final completion belongs to the constrained verifier and isolated auditor, not the worker agent.

Treat audit or verification diagnostics as bounded repair instructions. Add materially new evidence or repair the cited approved check semantics before retrying. If the runtime pauses, interrupts, caps setup, or reports an equivalent repeated failure, stop and wait for the user or follow the exact recovery action shown by `pi_goal_status`.
