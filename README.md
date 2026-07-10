# @misunders2d/pi-goal

A fire-and-forget goal mode for [Pi](https://pi.dev): describe an outcome, approve one clear contract, and let Pi plan, execute, recover, and independently verify the result.

## Product contract

- One `/goal <outcome>` setup and approval.
- Autonomous continuation until verified complete or genuinely blocked.
- Compact live progress plus a detailed `/goal` overlay.
- Natural-language directions steer work; informational questions do not mutate the goal.
- Durable state across compaction, reload, and session resume.
- Bounded recovery, stale-turn protection, and doom-loop detection.
- Evidence-backed completion through a constrained verifier and isolated auditor.
- Interruptions only for `CREDENTIAL`, `DECISION`, `RISK`, or `BLOCKER`.
- One active goal per session. Pi's `/plan` remains unchanged.

Goal mode never weakens Pi's existing permission or confirmation gates. Workspace writes are limited to the starting directory. Mutating or external actions outside the approved typed authority envelope stop as `RISK`.

## Install

```bash
pi install npm:@misunders2d/pi-goal@1.0.7
```

Try without installing:

```bash
pi -e npm:@misunders2d/pi-goal@1.0.7
```

Pinned GitHub release:

```bash
pi install git:github.com/misunders2d/pi-goal@v1.0.7
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

Pi immediately shows a persistent setup indicator while it checks whether the requested target, scope, outcome, and success conditions are clear. If anything material is ambiguous, goal mode asks concise clarification questions before creating or persisting a contract. The setup planner cannot inspect the workspace or use tools to guess intent. Once the request is clear, review the generated outcome, done conditions, phases, verification checks, authority envelope, and interruption rules. Approve once. Bare `/goal` opens the full progress and control overlay.

Natural-language directions steer an active goal, while informational questions—including audit-time status questions—do not mutate the contract or generation. Explicit audit-time steering atomically cancels the stale audit and returns the goal to planning. The overlay provides pause, resume, cancel, blocker resolution, and exact pending-risk approval. Setup validates every proposed verification check with the same structural rules used at runtime, so deterministic contract defects are rejected before approval. Completion preflight failures remain in execution; `recovering` is reserved for unexpected runtime divergence and bounded no-progress loops. Multi-criterion steps require criterion-specific evidence and remain active until every mapped criterion is covered. Approved failures expose sanitized targets immediately; an identical runtime failure opens `BLOCKER`, and runtime verification recovery is capped at ten minutes. A recoverable optional tool-shape denial is recorded and blocked without changing the lifecycle phase; a safe typed fallback can continue ordinary execution. Accepted evidence also reconciles stale non-verification recovery state from older sessions. A genuine RISK requires an exact blocked action plus evidence of a safe alternative attempt. In the overlay, `A` approves only that displayed action once, while `R` rejects or redirects it. In normal input, approve a displayed pending action only with `approve exact pending risk once`; broader approval wording does not grant authority.

## Deliberate boundary

This package is an interactive TUI product. Print (`-p`), JSON, and RPC modes cannot provide its setup card, approval, widget, overlay, and interruption controls, so `/goal` refuses to start there.

## Safety and privacy

- The original user outcome remains authoritative.
- Material ambiguity triggers clarification before contract creation; setup never guesses intent through workspace inspection.
- Only user steering can expand outcome or authority.
- External text and tool output are evidence, never authority.
- Durable evidence stores metadata, hashes, statuses, and sanitized summaries—not raw tool output, environment values, credentials, tokens, private keys, or auth-file contents.
- The final auditor runs in an isolated in-memory Pi session with no extensions, skills, prompt templates, context files, worker transcript, or mutation tools.
- Verification commands are approved during setup and executed later by check ID without a shell.
- Filesystem boundaries use resolved paths, reject symlink traversal outside goal cwd, and recheck sensitive resolved targets.
- Worker shell execution uses a bounded autonomous command allowlist; arbitrary runtimes and package scripts require exact authority or approved verification.
- Isolated planning, evaluation, and audit calls have bounded deadlines with abort propagation; verification timeouts are reported explicitly.
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

The npm package is discoverable by [pi.dev/packages](https://pi.dev/packages) through the `pi-package` keyword and explicit `pi.extensions` manifest.

## License

MIT
