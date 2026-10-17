# 02: Run-scoped `createFactory`, self-repair rework loop, diff-backed `Council`, and `OSS lab` Smart Repo Indexer

**What to build:** Execute every code-producing `Burn run` (`Proto arena`, `Night shift`, `Self-evolve`, and `OSS lab` PoCs) through a run-scoped `createFactory` instance under `<paseoHome>/burn-lab/runs/<runId>/factory/` with worktree commits, `factory.claim()` verification (`checkCleanAt`, `changesOutsideScope`, `MEMORY_FILES` fence, `artifact`, process-group `runGate`), a multi-attempt `$0` self-repair rework loop (`maxAttempts = 2`, up to `MAX_ATTEMPTS = 3`), diff-backed cross-family `Council` review with `WATCH_QUESTIONS`, and a Smart Repo Indexer for `OSS lab`.

**Blocked by:** 01: Vendored `paseo-factory` core sync, unified `Project` registry, and `runLaneCli` `Supervisor` runner

Status: done

- [x] Code `Burn run`s instantiate `createFactory({ stateDir: "<paseoHome>/burn-lab/runs/<runId>/factory", projectSlug })`, leaving `<paseoHome>/plugin-state/paseo-factory/` and `<paseoHome>/factory/ledger.jsonl` with zero writes.
- [x] When no `Gate` override is provided, `factory-burn-lab` infers `"npm test"` when `<projectRoot>/package.json` defines a real `test` script (`"npm test && npm run check:bundle"` for `self-evolve`), falling back to `"node -e \"process.exit(0)\""` only when no test script exists.
- [x] Each `coder` attempt registers a `Contract` (`gate`, `artifact`, optional `scope`), allocates an isolated worktree via `prepareTaskWorktree` on `burn/<runId>/<modelSlug>` (with `.worktreeinclude` copy, `symlinkNodeModules: true`, and `factory-excludes`), commits worktree edits to its branch, and verifies the commit via `factory.claim({ task, sha, agent })`.
- [x] Uncommitted/dirty worktrees, missing `artifact`s, `scope` violations, or unauthorized edits to `MEMORY_FILES` (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`) are mechanically stamped `red` and rejected.
- [x] When Attempt 1 fails `factory.claim()` or `verifyCitations()`, the engine automatically feeds the exact `Gate` failure diagnostics (`gate.note`, `gate.output`) or invalid citations back to the `Free model` in the same worktree for a self-repair attempt (`maxAttempts = 2` default, up to `MAX_ATTEMPTS = 3`).
- [x] `runCouncilCrossCheck` feeds cross-family `Council` reviewers the `Contract`, the actual `git diff` (`diffBetween(baseCommit, claimedCommit)`), the `Gate` output, and `paseo-factory`'s five `WATCH_QUESTIONS` (`destructive-writes`, `test-weakened`, `stuck-loop`, `scope-creep`, `secret-leak`), rejecting attempts challenged by the `Council`.
- [x] `OSS lab` indexes tracked files via `git ls-files` (`buildSmartRepoExcerpts`), ranks files by prompt/subtask relevance + architectural priority, and feeds numbered excerpts across up to 10 files (up to 250 lines each) with explicit valid citation range headers.
