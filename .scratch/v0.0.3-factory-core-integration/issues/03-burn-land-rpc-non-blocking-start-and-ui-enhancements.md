# 03: 1-click `Winning branch landing` (`burn.land`), non-blocking live UI runs, and Run Detail rework/diff view

**What to build:** Add the `burn.land` RPC and 1-click **`Land Winning Branch`** + **`Send to Supervisor`** actions in the Run Detail modal, make UI-initiated `Burn run`s start non-blockingly (`awaitCompletion: false`) with synchronous `"queued"` record pre-allocation so live phase progression streams on the UI, and surface rework attempt counts, `factoryVerdict`, changed file counts, and `diffPatch` previews in the Run Detail modal.

**Blocked by:** 02: Run-scoped `createFactory`, self-repair rework loop, diff-backed `Council`, and `OSS lab` Smart Repo Indexer

**Status:** done

- [x] `plugin/shared/rpc.ts` and `plugin/shared/view.ts` define `burnLand` (`name: "burn.land"`) and expose `winningBranch`, `winningCommit`, `landingStatus`, `landingNote`, `reworkAttempts` (`attemptCount`), `factoryVerdict`, `changedFiles`, and `diffPatch` across run summary and detail schemas.
- [x] `handlers.start` pre-allocates `runId` and writes the initial `"queued"` `BurnRunRecord` synchronously before launching the async execution loop, so `handlers.start({ ..., awaitCompletion: false })` immediately returns the newly queued run summary (never a stale previous run).
- [x] `handlers.land({ runId })` invokes `paseo-factory` core's `landTaskWorktree` to merge `winningCommit` (`winningBranch`) into `<project-root>`, records `landingStatus: "landed"` or `"pending-conflict"` (preserving `winningBranch` when `<project-root>` is dirty or conflicts), and returns `paseo-factory`'s acceptance summary wording.
- [x] `BurnLabShell` (`plugin/client/burn-lab/shell.tsx`) dispatches `startCall` with `awaitCompletion: false` for live UI phase polling and renders rework tries, `factoryVerdict`, changed files, `diffPatch` preview, **`Land Winning Branch`**, and **`Send to Supervisor`** inside the Run Detail modal.
- [x] Behavioral tests in `test/burn-engine.test.ts` and `test/surface-rpc.test.ts` cover all new seams (`createFactory` isolation, self-repair rework loop, `MEMORY_FILES` & scope fencing, diff-backed `Council` with `WATCH_QUESTIONS`, `OSS lab` Smart Repo Indexer, shared `project.json` registry, non-blocking `start`, and `burn.land` landed vs `pending-conflict`), and `npm run sync:plugin-core:check && npm run typecheck && npm test` passes 100%.
