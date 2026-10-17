# 01: Vendored `paseo-factory` core sync, unified `Project` registry, and `runLaneCli` `Supervisor` runner

**What to build:** Vendor `paseo-factory`'s pure-Node verification core (`src/factory-core/` → `plugin/server/core/factory-core/`) and unify `factory-burn-lab`'s `Project` registry, `Lane config` lookup, and `Supervisor` CLI execution with `paseo-factory` so both plugins share `<paseoHome>/plugin-state/paseo-factory/projects/<slug>/project.json`, `lanes.json`, and clean-room `PI_CODING_AGENT_DIR` `Supervisor` invocations.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `scripts/sync-plugin-core.mjs` vendors `paseo-factory`'s pure-Node modules into `src/factory-core/` (exporting `createFactory`, `runGate`, `loadLanes`, `runLaneCli`, `parseLane`, `projectLanesPath`, `provisionPiAgentHome`, `resolveProject`, `projectStateDir`, `readProjectRegistration`, `writeProjectRegistration`, `listProjectRegistrations`, `discoverProjects`, `resolveClaimedCommit`, `checkCleanAt`, `headCommitSync`, `diffBetween`, `changedFiles`, `changesOutsideScope`, `scopeCoversFile`, `prepareTaskWorktree`, `landTaskWorktree`, `MEMORY_FILES`, `WATCH_QUESTIONS`, `parseEyeAnswer`, `MAX_ATTEMPTS`) and mirrors `src/` (including `src/factory-core/`) into `plugin/server/core/`.
- [x] `npm run sync:plugin-core:check` verifies 100% identity between `src/` and `plugin/server/core/` (including `factory-core/`).
- [x] `resolveFactoryStateDir(paseoHome)` resolves `<paseoHome>/plugin-state/paseo-factory` (and reads legacy `<paseoHome>/factory` when present).
- [x] `resolveBurnProjects` and `addBurnProject` read and write `paseo-factory`'s `<factoryStateDir>/projects/<slug>/project.json` registry via `readProjectRegistration`, `writeProjectRegistration`, `listProjectRegistrations`, and `discoverProjects`, so adding a `Project` in `Burn Lab` makes it immediately visible in `paseo-factory` (and vice versa).
- [x] `resolveSupervisorLane` uses `paseo-factory` core's `loadLanes(factoryStateDir, projectSlug)` to resolve `lanes.supervisor`.
- [x] `defaultSupervisorRunner` invokes `paseo-factory` core's `runLaneCli` with `stateDir: factoryStateDir` so `pi/<model>:<thinking>`, `copilot/<model>`, and `claude/<model>` preserve `:thinking` flags and clean-room `PI_CODING_AGENT_DIR` isolation.
