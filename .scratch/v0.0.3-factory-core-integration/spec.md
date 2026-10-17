# Spec — factory-burn-lab v0.0.3: Genuine `paseo-factory` Core Integration, Run-Scoped `createFactory`, Self-Repair Rework Loop, Diff-Backed `Council`, Smart Repo Indexer, and 1-Click `Winning branch landing`

Status: ready-for-agent

## Problem Statement

1. **Zero actual code reuse from `paseo-factory` core in `v0.0.1`–`v0.0.2`:** Although `factory-burn-lab` is designed as a `Companion plugin` to `paseo-factory`, its implementation previously imported zero modules from `paseo-factory` and instead re-implemented simplified versions of `Project` resolution, `Lane config` parsing, `Supervisor` CLI execution, `Gate` execution, and worktree management. As a result, `Burn run`s lacked `paseo-factory`'s process-group `runGate` (`NODE_TEST_CONTEXT` stripping, `-pid` SIGKILL, `artifact` verification), clean-room `PI_CODING_AGENT_DIR` isolation (`provisionPiAgentHome`), `MEMORY_FILES` fencing (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`), scope boundary checks (`changesOutsideScope`), and `Contract`-first verification (`createFactory`).
2. **Separate shadow project list (`burn-lab/projects.json`):** `factory-burn-lab` maintained its own `burn-lab/projects.json` file instead of reading and writing `paseo-factory`'s canonical `<factoryStateDir>/projects/<slug>/project.json` registry (`<paseoHome>/plugin-state/paseo-factory/projects/<slug>/project.json`), causing `Project` additions on `Burn Lab` to be invisible on the `Factory surface`.
3. **Single-shot `Free model` execution with no self-repair loop and no git commits:** In code playbooks (`Proto arena`, `Night shift`, `Self-evolve`, and `OSS lab` PoCs), `Free model`s ran only once (`maxAttempts = 1`) and their file edits were neither committed to the worktree branch nor verified with `checkCleanAt` / `diffBetween`. Any minor syntax error, test failure, or line-number slip in a citation immediately failed the attempt instead of letting the `$0` `Free model` self-repair using the `Gate` or `Citation gate` diagnostics.
4. **`Council` was blind to the actual `git diff`:** `runCouncilCrossCheck` previously sent only the worker model's stdout prose (`attempt.output`) to cross-family reviewers. A `Free model` that weakened a test (`test-weakened`), leaked credentials (`secret-leak`), modified files outside scope (`scope-creep`), or made zero real code changes while claiming success in stdout would be approved by `Council`.
5. **Shallow `OSS lab` indexing, blocking UI runs, and no 1-click `Winning branch landing`:** `OSS lab` only read the first 20 lines of at most 4 hardcoded filenames; clicking **Start Burn Run** on the UI blocked on the entire multi-phase run instead of streaming live phase transitions; and once a `winningBranch` was produced, the `Owner` had no 1-click button on the UI to merge (`landTaskWorktree`) the verified commit into `<project-root>` or dispatch the report and branch directly to the `Supervisor`.

## Solution

Implement **ADR 0003 (Genuine `paseo-factory` core integration and companion worktrees)**:

1. **Vendor `paseo-factory`'s pure-Node core into `factory-burn-lab` (`src/factory-core/` → `plugin/server/core/factory-core/`):** Extend the core sync script so `factory-burn-lab` vendors `paseo-factory`'s pure-Node verification core (`createFactory`, `runGate`, `loadLanes`, `runLaneCli`, `resolveProject`, `readProjectRegistration`, `writeProjectRegistration`, `discoverProjects`, `prepareTaskWorktree`, `landTaskWorktree`, `diffBetween`, `changedFiles`, `changesOutsideScope`, `MEMORY_FILES`, `WATCH_QUESTIONS`, `parseEyeAnswer`) inside the plugin boundary, compiling cleanly under Paseo's Hermes/Node bundle checker.
2. **Unify `Project` registry and `Lane config` with `paseo-factory`:** Read and write `Project` registrations directly in `paseo-factory`'s `<paseoHome>/plugin-state/paseo-factory/projects/<slug>/project.json` (with fallback discovery from `<paseoHome>/factory/projects/` and `<paseoHome>/projects/projects.json`), resolve `lanes.supervisor` via `paseo-factory`'s `loadLanes`, and execute `Supervisor` framing and synthesis passes via `paseo-factory`'s `runLaneCli` (preserving `:thinking` options and clean-room `PI_CODING_AGENT_DIR` isolation).
3. **Run every code `Burn run` through a run-scoped `createFactory` instance with a Self-Repair Rework Loop (`maxAttempts = 2`, up to `MAX_ATTEMPTS = 3`):**
   - Instantiate `createFactory({ stateDir: "<paseoHome>/burn-lab/runs/<runId>/factory", projectSlug })` per `Burn run` so `paseo-factory`'s production `ledger.jsonl` is never touched.
   - Register a real `Contract` (`gate`, `artifact`, optional `scope`) per swarm task from the `Supervisor`'s framing output, allocate an isolated worktree via `prepareTaskWorktree` (with `.worktreeinclude` and `symlinkNodeModules: true`), commit the `Free model`'s edits to its branch, and verify via `factory.claim({ task, sha, agent: model.id })` (`checkCleanAt` + `changesOutsideScope` + `MEMORY_FILES` fence + process-group `runGate` + `artifact` check + Factory `Report`).
   - When `factory.claim()` or `verifyCitations()` fails on Attempt 1, feed the exact `Gate` output (`gate.note` + `gate.output`) or invalid citation list back to the same `Free model` in its worktree for a `$0` self-repair attempt (default `maxAttempts = 2`, configurable up to `MAX_ATTEMPTS = 3`).
4. **Upgrade Cross-Family `Council` with `diffBetween`, `WATCH_QUESTIONS`, and `Fresh-eyes review` semantics:** Feed cross-family `Council` reviewers the `Contract`, the actual git patch (`diffBetween(baseCommit, claimedCommit)`), the `Gate` log, and `paseo-factory`'s five `WATCH_QUESTIONS` (`destructive-writes`, `test-weakened`, `stuck-loop`, `scope-creep`, `secret-leak`). Any attempt that weakens tests, leaks secrets, creeps scope, or produces a bogus diff is challenged (`VERDICT: CHALLENGE`) and rejected before reaching the `Supervisor`.
5. **Ship `OSS lab` Smart Repo Indexer, Non-Blocking Live UI Progress, and 1-Click `Winning branch landing` (`burn.land`):**
   - Index repositories in `OSS lab` via `git ls-files`, rank files by prompt/subtask relevance, and include numbered excerpts across up to 10 files (up to 250 lines each) so `reader-1m` models utilize their large context window while satisfying the mechanical `Citation gate`.
   - Dispatch UI-initiated `Burn run`s with `awaitCompletion: false` so the `Burn Lab` surface displays real-time phase transitions (`queued` → `framing` → `swarm-running` → `verifying` → `synthesizing` → `completed`).
   - Add a `burn.land` RPC and a 1-click **`Land Winning Branch`** button (plus **`Send to Supervisor`**) inside the Run Detail modal that calls `paseo-factory`'s `landTaskWorktree` to merge the winning `claimedCommit` into `<project-root>`.

## User Stories

1. As an `Owner`, I want `factory-burn-lab` to execute `paseo-factory`'s real verification core (`createFactory`, `runGate`, `loadLanes`, `runLaneCli`, `resolveProject`, `diffBetween`, `WATCH_QUESTIONS`, `landTaskWorktree`) rather than simplified copies, so that every `Burn run` enforces the exact same verification laws as `paseo-factory`.
2. As an `Owner`, I want `paseo-factory`'s production `Ledger` (`<paseoHome>/plugin-state/paseo-factory/projects/<slug>/ledger.jsonl` and `<paseoHome>/factory/ledger.jsonl`) to remain 100% untouched by `Burn run`s, by scoping each `Burn run`'s `createFactory` instance to `<paseoHome>/burn-lab/runs/<runId>/factory/`.
3. As an `Owner`, when I add or initialize a `Project` in `Burn Lab` (or in `paseo-factory`), I want the registration written to `paseo-factory`'s shared `<factoryStateDir>/projects/<slug>/project.json` registry, so that both `Factory` and `Burn Lab` always show the same `Project`s and share the same `Supervisor` seat.
4. As an `Owner`, when a `Burn run` invokes my `Project`'s `Supervisor` lane (`pi/<model>:<thinking>`, `copilot/<model>`, `claude/<model>`, or `opencode/<model>`), I want it executed through `paseo-factory`'s `runLaneCli` with clean-room `PI_CODING_AGENT_DIR` isolation and `:thinking` flags preserved, so that personal `~/.pi/agent` extensions never break `Supervisor` framing or synthesis.
5. As an `Owner`, when I don't manually specify a `Gate` command on the UI and the `Supervisor` doesn't override it, I want `factory-burn-lab` to infer the `Project`'s real test/check command from `package.json` (`npm test`) when available, so that code playbooks are judged against real tests rather than a no-op exit 0.
6. As an `Owner` running `Proto arena`, `Night shift`, `Self-evolve`, or `OSS lab`, I want each `coder` `Free model`'s worktree edits to be committed to its isolated branch (`burn/<runId>/<model>`) and verified via `factory.claim()`, so that uncommitted edits, dirty trees, missing `artifact`s, `scope` violations, or unauthorized edits to `MEMORY_FILES` (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`) are mechanically rejected.
7. As an `Owner`, when a `Free model`'s first attempt fails `factory.claim()` (`Gate` red, scope/memory violation) or fails the `Citation gate`, I want the engine to automatically feed the exact error output or invalid citations back to that `Free model` for a second self-repair attempt (`maxAttempts = 2` by default, up to `MAX_ATTEMPTS = 3`), so that `$0` models fix their own mistakes without waking the `Supervisor`.
8. As an `Owner`, I want the cross-family `Council` to inspect the `Contract`, the actual `git diff` (`diffBetween(baseCommit, claimedCommit)`), the `Gate` output, and `paseo-factory`'s five `WATCH_QUESTIONS` (`destructive-writes`, `test-weakened`, `stuck-loop`, `scope-creep`, `secret-leak`), so that any `Free model` that weakens tests or fakes stdout output is caught and disqualified by reviewers from other model families.
9. As an `Owner` running `OSS lab` against an open-source repository, I want the Smart Repo Indexer to map the repository file tree via `git ls-files` and feed numbered excerpts of up to 10 relevant files (up to 250 lines per file) into the `reader-1m` models, so that architectural reports cover deep implementation files with valid `[path:startLine-endLine]` citations.
10. As an `Owner` clicking **`Start Burn Run`** in Paseo Desktop, I want the run to start immediately in the background (`awaitCompletion: false`) and stream its live phase progression (`queued` → `framing` → `swarm-running` → `verifying` → `synthesizing` → `completed`) on the UI, so that the UI never freezes during multi-model runs.
11. As an `Owner` inspecting a completed `Burn run` with a verified `winningBranch` and `claimedCommit`, I want a 1-click **`Land Winning Branch`** button in the Run Detail modal that invokes `paseo-factory`'s `landTaskWorktree` to merge the branch cleanly into `<project-root>` (or report `pending-conflict` while preserving the branch if `<project-root>` is dirty or conflicts), so that I can adopt verified prototype or bug-fix branches without manual git commands.
12. As an `Owner` inspecting a completed `Burn run`, I want a 1-click **`Send to Supervisor`** button in the Run Detail modal that opens the `Project`'s `Supervisor` seat and dispatches the run's verdict, `winningBranch`, and report summary for interactive follow-up.

## Implementation Decisions

1. **Vendored `paseo-factory` core sync (`src/factory-core/` → `plugin/server/core/factory-core/`):**
   - `scripts/sync-plugin-core.mjs` syncs all `.ts` modules from `paseo-factory`'s `src/` into `src/factory-core/` (when the upstream sibling directory is present) and copies all of `src/` (including `src/factory-core/`) into `plugin/server/core/`.
   - `--check` verifies that `src/` and `plugin/server/core/` (including `factory-core/`) are 100% identical.

2. **Shared `paseo-factory` state root discovery (`resolveFactoryStateDir`):**
   - `resolveFactoryStateDir(paseoHome)` resolves `<paseoHome>/plugin-state/paseo-factory` when present (or creates/uses it as the primary `paseo-factory` state directory, while also reading legacy `<paseoHome>/factory` if present).
   - `resolveBurnProjects` and `addBurnProject` use `paseo-factory` core's `resolveProject`, `readProjectRegistration`, `writeProjectRegistration`, `listProjectRegistrations`, and `discoverProjects` against `resolveFactoryStateDir(paseoHome)` so `Project` registrations are shared across both plugins.
   - `resolveSupervisorLane` uses `paseo-factory` core's `loadLanes(factoryStateDir, projectSlug)` to read `lanes.supervisor`.
   - `defaultSupervisorRunner` uses `paseo-factory` core's `runLaneCli({ lane, stdin: prompt, timeoutMs, stateDir: factoryStateDir })` (with fallback to `runOpenCodeFreeModel` if `opencode` is invoked before `v0.0.18` lands).

3. **Run-scoped `createFactory`, worktree commit & `factory.claim()`, and Self-Repair Rework Loop:**
   - Extend `BurnFramingPlan`, `BurnAttemptRecord`, and `BurnRunRecord`:
     ```ts
     export interface BurnFramingPlan {
       goal: string;
       subtasks: string[];
       gateCommand: string;
       artifact: string;
       scope?: string[];
       citationRequired: boolean;
       rawSupervisorOutput: string;
     }

     export interface BurnAttemptRecord {
       id: string;
       model: string;
       family: string;
       role: SwarmRole;
       subtask: string;
       ok: boolean;
        attemptCount: number;
       latencyMs: number;
       output: string;
       worktreeDir?: string;
       branchName?: string;
       baseCommit?: string;
       claimedCommit?: string;
       diffPatch?: string;
       changedFiles?: string[];
       factoryVerdict?: "green" | "red";
       factoryReportPath?: string;
       gateResult?: GateRunResult;
       citationResult?: CitationGateResult;
       accepted: boolean;
       rejectionReason?: string;
     }
     ```
   - `BurnRunRecord` adds:
     ```ts
     winningCommit?: string;
     landingStatus?: "not_landed" | "landed" | "pending-conflict";
     landingNote?: string;
     ```
   - For each code-producing task in `Proto arena`, `Night shift`, `Self-evolve`, and `OSS lab` (`coder` role):
     1. Instantiate `const runFactory = createFactory({ stateDir: join(artifactDir, "factory"), projectSlug: project.slug, timeoutMs })`.
     2. Determine `defaultGate` by checking whether `<projectRoot>/package.json` defines a real `test` script (`"npm test"`), falling back to `"node -e \"process.exit(0)\""` only when no test script exists. Determine `defaultArtifact` (`"package.json"` if present, else `"README.md"`).
     3. Call `runFactory.setContract({ task: attemptId, workspace: hostRoot, gate: gateCommand, artifact, scope, description: subtask, by: "supervisor" })`.
     4. Allocate the isolated worktree on branch `burn/<runId>/<modelSlug>` at `baseCommit = headCommitSync(hostRoot)` (copying `.worktreeinclude` + excluding `node_modules` in `<gitdir>/factory-excludes` so `checkCleanAt` passes) and record `runFactory.spawn({ task: attemptId, provider: model.id, arity: 1, worktree: worktreeDir })`.
     5. Run up to `maxAttempts` (default `2`, max `MAX_ATTEMPTS = 3`) iterations:
        - Invoke `runOpenCodeFreeModel` in `worktreeDir` (on rework iteration $>1$, append the previous attempt's failure diagnostics: `gate.note`, `gate.output`, or `invalidCitations`).
        - Stage and commit any modified/new files in `worktreeDir` (`git add -A && git commit -m "burn(<playbook>): <attemptId> try <k>"`) to obtain `claimedCommit = headCommitSync(worktreeDir)`.
        - Call `const claimRes = await runFactory.claim({ task: attemptId, sha: claimedCommit, agent: model.id })`.
        - Extract `diffBetween(baseCommit, claimedCommit)` and `changedFiles(worktreeDir, baseCommit, claimedCommit)`.
        - If `claimRes.verdict === "green"` (and `citationResult.ok` when required), break out of the rework loop early; otherwise continue to the next rework attempt up to `maxAttempts`.

4. **Diff-backed Cross-Family `Council` with `WATCH_QUESTIONS`:**
   - In `runCouncilCrossCheck`, when an accepted attempt has `diffPatch` (or `gateResult`), construct the review prompt with:
     - The task `subtask` and `Gate` command
     - The actual git diff (`attempt.diffPatch`, capped to `WATCH_DIFF_MAX_CHARS`)
     - The `Gate` output (`attempt.gateResult.stdout` / `stderr`, capped to `WATCH_GATE_OUTPUT_MAX_CHARS`)
     - `paseo-factory`'s five `WATCH_QUESTIONS` criteria (`destructive-writes`, `test-weakened`, `stuck-loop`, `scope-creep`, `secret-leak`)
   - Cross-family reviewers reply with `VERDICT: APPROVE — <summary>` (`CLEAR`) or `VERDICT: CHALLENGE — <concern>` (`CONCERN`, including any triggered `WATCH_QUESTIONS` flag).

5. **`OSS lab` Smart Repo Indexer:**
   - Replace the 4-file / 20-line hardcoded excerpt loop with `buildSmartRepoExcerpts(inspectRepoRoot, prompt, subtasks)`:
     - Enumerates tracked files via `git ls-files` (falling back to top-level + `src/` walk if not a git repo), filtering out lockfiles, binaries, `dist/`, and `node_modules/`.
     - Scores each file by keyword overlap with `prompt` and `subtasks` plus architectural priority (`README.md`, `package.json`, `CONTEXT.md`, `src/index.*`, `src/*`).
     - Selects up to `10` top-ranked files and formats up to `250` numbered lines (`1: ...`) per file with explicit valid line-range headers (`File <rel> (total lines: 1-<N>; valid citation example: [<rel>:1-<min(N,5)>])`).

6. **New `burn.land` RPC & Non-Blocking UI Enhancements (`plugin/shared/rpc.ts`, `plugin/shared/view.ts`, `plugin/server/surface-rpc.ts`, `plugin/client/burn-lab/shell.tsx`):**
   - Add `burnLand` (`name: "burn.land"`):
     - Input: `z.object({ runId: z.string() })`
     - Output: `z.union([z.object({ ok: z.literal(true), runId: z.string(), landing: z.enum(["landed", "pending-conflict"]), winningBranch: z.string(), winningCommit: z.string(), summary: z.string() }), BurnFailureSchema])`
   - Server handler `handlers.land({ runId })`:
     - Loads the `BurnRunRecord`, verifies it has a `winningBranch` and `winningCommit` (`claimedCommit`), invokes `paseo-factory` core's `landTaskWorktree({ projectRoot: run.projectRoot, worktree: winningWorktreeDir, claimedCommit: run.winningCommit, base: winningBaseCommit, branch: run.winningBranch })`, persists `run.landingStatus` and `run.landingNote`, and returns the result formatted with `paseo-factory`'s acceptance summary wording.
   - In `surface-rpc.ts` (`handlers.start`):
     - Pre-allocate `runId` and save the initial `"queued"` `BurnRunRecord` synchronously before launching the async execution loop, so when `awaitCompletion: false` is passed by the UI, `handlers.start` immediately returns the newly queued run summary (never a stale previous run).
   - In `plugin/client/burn-lab/shell.tsx`:
     - `handleStartBurnRun` passes `awaitCompletion: false` so the UI immediately transitions to polling the live run phases (`queued` → `framing` → `swarm-running` → `verifying` → `synthesizing` → `completed`).
     - In the Run Detail Modal, display each attempt's `attemptCount` (rework tries), `factoryVerdict`, changed files count, and `diffPatch` preview, plus a 1-click **`Land Winning Branch`** button (calling `burn.land`) and a 1-click **`Send to Supervisor`** button (calling `burn.supervisor.open` with the run's report and branch).

## Testing Decisions

- **What makes a good test:** Behavioral tests drive public entry points (`runBurnPlaybook`, `createBurnSurfaceHandlers`, `verifyCitations`, `scoutFreePool`) against real temporary Git repositories on disk and injected runner seams — never mocking internal functions.
- **Primary testing seams (`test/burn-engine.test.ts`, `test/surface-rpc.test.ts`, and `scripts/check-bundle.mjs`):**
  1. **`paseo-factory` Core Integration & Rework Seam (`test/burn-engine.test.ts`):**
     - Verifies that `Proto arena`, `Night shift`, and `Self-evolve` instantiate a run-scoped `createFactory` under `<paseoHome>/burn-lab/runs/<runId>/factory/`, leaving `<paseoHome>/plugin-state/paseo-factory/` and `<paseoHome>/factory/ledger.jsonl` with zero writes.
     - Verifies the **Self-Repair Rework Loop**: when a `Free model`'s first try produces a failing `Gate` (or invalid citation) and its second try fixes the code/citation using the injected error feedback, the attempt succeeds on try 2 (`attemptCount === 2`, `accepted === true`, `factoryVerdict === "green"`).
     - Verifies **`MEMORY_FILES` & Scope Fencing via `factory.claim()`**: if a `Free model` modifies `AGENTS.md` or `CONTEXT.md` (or a file outside `scope`), `factory.claim()` stamps the attempt `red` and rejects it even if the shell command would exit 0.
     - Verifies **Diff-backed `Council` with `WATCH_QUESTIONS`**: `Council` reviewers receive the real `git diff` (`diffBetween`) and `WATCH_QUESTIONS`, and reject an attempt that weakens a test in its diff.
     - Verifies **`OSS lab` Smart Repo Indexer**: indexes nested repository files beyond the old 4-file / 20-line cap and validates `[path:startLine-endLine]` citations against them.
  2. **Surface RPC & `Winning branch landing` Seam (`test/surface-rpc.test.ts`):**
     - `handlers.projectAdd` registers the repository in `paseo-factory`'s shared `<paseoHome>/plugin-state/paseo-factory/projects/<slug>/project.json` registry.
     - `handlers.start({ ..., awaitCompletion: false })` immediately returns the newly created `queued` run ID while the run finishes asynchronously.
     - `handlers.land({ runId })` merges the winning commit (`winningCommit` on `winningBranch`) into `<project-root>` via `landTaskWorktree` (`landing: "landed"`), and returns `landing: "pending-conflict"` while preserving `winningBranch` when `<project-root>` has uncommitted changes.
  3. **Core Sync & Hermes Bundle Gate (`npm run sync:plugin-core:check && npm run typecheck && npm test`):**
     - Confirms `src/factory-core/` and `plugin/server/core/` are in sync and both client and server plugin bundles build cleanly.

## Out of Scope

- Writing any Burn Run events into `paseo-factory`'s production `ledger.jsonl`.
- Automatic landing into `<project-root>` without an explicit `Owner` click on `Land Winning Branch`.

## Further Notes

- Grounded in [ADR 0003](../../docs/adr/0003-factory-core-integration-and-companion-worktrees.md), [ADR 0001](../../docs/adr/0001-companion-plugin-and-opencode-free-swarm.md), [ADR 0002](../../docs/adr/0002-cross-platform-unattended-preflight-and-auto-approval.md), and [CONTEXT.md](../../CONTEXT.md).
- Can be implemented either immediately (vendoring `../research-slp/src/*.ts` as it stands today) or right after `paseo-factory` finishes `.scratch/factory-v0.0.18/spec.md`.
