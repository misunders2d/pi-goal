# @misunders2d/pi-goal

A fire-and-forget goal mode for [Pi](https://pi.dev): describe an outcome, approve one clear contract, and let Pi plan, execute, recover, and independently verify the result.

## Product contract

- One `/goal <outcome>` setup and approval.
- Clarification and contract debate happen in the same conversation, with full session context.
- Autonomous continuation until verified complete or genuinely blocked.
- Compact live progress plus a detailed `/goal` overlay.
- Explicit steering directions mutate work; informational questions and neutral acknowledgements do not mutate the goal.
- Durable state across compaction, reload, and session resume.
- Bounded recovery, stale-turn protection, and doom-loop detection.
- Evidence-backed completion through a constrained verifier and isolated auditor.
- Interruptions only for `CREDENTIAL`, `DECISION`, `RISK`, or `BLOCKER`.
- One active goal per session. Pi's `/plan` remains unchanged.

Goal mode never weakens Pi's existing permission or confirmation gates. Workspace writes are limited to the starting directory plus any canonical additional roots explicitly displayed and approved during setup. One contract approval also approves its complete typed authority envelope; routine in-envelope work does not request per-tool approval. Optional denied actions trigger autonomous alternatives. Only an unavoidable out-of-envelope action can become `RISK`.

## Install

```bash
pi install npm:@misunders2d/pi-goal@1.0.18
```

Try without installing:

```bash
pi -e npm:@misunders2d/pi-goal@1.0.18
```

Pinned GitHub release:

```bash
pi install git:github.com/misunders2d/pi-goal@v1.0.18
```

## Use

Start Pi interactively in the workspace that goal mode may change:

```bash
pi
```

Then:

```text
/goal Build and validate the requested outcome
```

`/goal <outcome>` activates setup mode in the current conversation. The same main agent sees the normal session history, resolves references from prior discussion, debates conflicts, and asks only materially necessary follow-up questions. Clarification has no artificial round limit. Before approval, operational tools are hard-blocked; the agent may only discuss the goal, inspect sanitized goal status, or submit a complete typed contract. Questions and answers remain visible in the ordinary conversation transcript. Once clear, the agent submits observable done conditions, ordered phases, mechanical verification checks, constraints, non-goals, and all foreseeable scoped authorities needed for fire-and-forget completion. Contract repair is runtime-bounded: two equivalent rejected submissions or three distinct rejected submissions for one user reply pause setup and abort the active turn until new user input arrives. Run bare `/goal` to review the contract, refine it back in the same conversation, cancel it, or approve once. Bare `/goal` otherwise opens progress and controls.

The package also ships the `misunders2d-pi-goal` operator skill. It teaches the exact `pi_goal_*` lifecycle, but the extension—not the skill—enforces state, authority, retry caps, verification, and audit.

A closed-world input classifier recognizes explicit steering (`steer`, `amend`, `change`, `revise`, `update`, and explicit `also`/`additionally` additions), typed controls, informational questions, and neutral acknowledgements. Informational questions—including audit-time status questions—and acknowledgements such as `okay, continue` do not mutate the contract, create steering, or increment generation. Unknown ordinary text is not silently promoted to steering. Clarification such as `don't understand` also preserves a pending authority amendment; only its exact approval, explicit steering, or cancellation resolves it. Explicit steering invalidates stale deferred or pending RISK actions; audit-time steering also atomically cancels the stale audit and returns the goal to planning. Pause, resume, and cancellation aliases are deterministic exact grammars; negated phrases such as `do not cancel this goal` never cancel it. The overlay provides pause, resume, cancel, blocker resolution, exact unavoidable-risk approval, and narrow authority-amendment approval. Non-RISK interruptions can resume without changing the approved contract; RISK remains limited to the displayed exact action. A running goal can request a human-approved typed authority amendment without replacing its goal ID, criteria, plan, evidence, current step, or approved workspace roots.

Contract submission validates every proposed verification check and machine-readable phase command against the declared executable authority before approval. The contract may declare up to eight canonical, existing workspace roots; the starting directory remains primary and relative paths always resolve from it. Bash authority must name an exact executable, exact argument prefix, bounded trailing-argument policy, and exact approved root cwd. Commands that require more than one action class must have every class: for example, normal `uv` execution needs `local_process` plus `network_read`, while `git push` needs `local_process` plus `external_write`. Labels and prose never grant command authority. A cwd-only Bash authority is rejected before approval. Completion preflight failures remain in execution; `recovering` is reserved for unexpected runtime divergence and bounded no-progress loops. Multi-criterion steps require criterion-specific evidence and remain active until every mapped criterion is covered. Evidence records are canonical; criterion evidence counts are rebuilt from those records during every persistence cycle and schema-1 normalization. Failed approved checks expose bounded, redacted stdout and stderr, exit details, byte counts, and truncation metadata. Durable state stores only sanitized summaries and metadata. The constrained verifier executes approved checks once before final adjudication; its immutable results are supplied directly to a tool-free isolated auditor instead of being rerun through a model tool loop. Audit execution failures persist bounded, redacted reason codes, stages, elapsed time, attempt/repeat counts, retryability, and suggested actions in worker context, status, and the overlay. An unchanged failed audit input is blocked before another model call. Audit rejections likewise persist criterion text, evidence references, notes, and a suggested next action. The same rejected completion input cannot invoke the auditor again; materially different evidence or approved-check results permit one retry, while a repeated equivalent diagnostic opens one detailed `BLOCKER`. Three distinct evidenced denials or failed checks plus a successful replan can open other `BLOCKER` interruptions; repeating the interruption request itself does not count. Runtime verification recovery remains capped at ten minutes. A recoverable optional tool-shape denial is recorded and blocked without changing the lifecycle phase; a safe typed fallback can continue ordinary execution. Accepted evidence also reconciles stale non-verification recovery state from older sessions. A genuine RISK requires an exact blocked action plus evidence of a safe alternative attempt. In the overlay, `A` approves only that displayed action once, while `R` rejects or redirects it. In normal input, approve a displayed pending action only with `approve exact pending risk once`; broader approval wording does not grant authority.

## Deliberate boundary

This package is an interactive TUI product. Print (`-p`), JSON, and RPC modes cannot provide its setup card, approval, widget, overlay, and interruption controls, so `/goal` refuses to start there.

## Safety and privacy

- The complete original user outcome remains authoritative and is preserved separately from contract wording.
- Material ambiguity is debated in the same conversation before contract creation; setup never guesses intent through workspace inspection.
- Only user steering can expand outcome or authority.
- External text and tool output are evidence, never authority.
- Durable evidence stores metadata, hashes, statuses, and sanitized summaries—not raw tool output, environment values, credentials, tokens, private keys, or auth-file contents.
- Setup discussion remains in the normal session transcript; durable setup state stores the original outcome and lifecycle metadata, not a second hidden Q&A transcript.
- The final auditor runs in an isolated in-memory Pi session with no extensions, skills, prompt templates, context files, worker transcript, or tools; it receives immutable constrained-verifier results.
- Verification commands are approved during setup and can be executed by check ID during normal work or completion preflight without a shell; final adjudication reuses the authoritative preflight results.
- Filesystem boundaries use canonical resolved paths, reject symlink traversal outside the selected approved root, and recheck sensitive resolved targets. Additional roots must exist, be directories, use canonical non-symlink paths, and be explicitly setup-approved.
- Worker shell execution uses a bounded autonomous command allowlist. Typed command authority matches an exact executable, quote-aware literal argument vector, trailing policy, action-class composition, and cwd; quoted or escaped punctuation remains literal while live shell operators, expansion, substitution, redirects, globbing, comments, environment prefixes, and malformed quoting fail closed. It never means arbitrary Bash inside a directory.
- Safe Git mutation is limited to exact-path `add`, one-message `commit`, and push to the declared remote and branch. Reset, clean, restore, checkout, rebase, broad staging, force push, and arbitrary remotes remain blocked.
- Isolated evaluation and audit calls have bounded deadlines with abort propagation; verification timeouts are reported explicitly.
- Setup rejects development-only npm checks against production packages beneath `node_modules`; installed-artifact checks must use shipped files or dependency-free runtime checks.

## Migrating from another `/goal`

Disable the old `/goal` extension before installing this package. Pi must expose exactly one `/goal` command. Test this package first in isolation:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" pi --no-extensions --no-skills -e /absolute/path/to/pi-goal
```

Do not remove a known-good goal extension until this package passes automated checks and real TUI smoke in your environment.

## Development

```bash
npm install --ignore-scripts
npm run check
npm pack --dry-run
```

Installed-artifact release validation must use fresh synthetic roots and a self-contained harness against only the packed or installed artifact plus its runtime dependencies. It must not import prior synthetic suites, repository-only fixtures, or development-only tests from another checkout.

The npm package is discoverable by [pi.dev/packages](https://pi.dev/packages) through the `pi-package` keyword and explicit `pi.extensions` manifest.

## License

MIT
