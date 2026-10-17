# 01 — Repo scaffold, OpenCode runner, `Scout pool`, and `Citation gate`

Status: done

## Scope

1. Initialize `package.json` (`"name": "factory-burn-lab"`), `tsconfig.json`, and `scripts/check-bundle.mjs` (Hermes CJS bundle verification for the Paseo client entry).
2. Implement `src/free-pool.ts`:
   - Discover `-free` / `$0` models from `opencode models` (and OpenCode's cached catalog metadata for context window / modalities).
   - Run headless OpenCode calls (`opencode run --standalone -m <model>`) with timeout and output capture.
   - Implement the `Scout pool` micro-battery (liveness + latency probe, coding `Gate` micro-task, and `Citation gate` check) and persist `<paseoHome>/burn-lab/free-pool.json` with assigned `Swarm role`s (`coder`, `reader-1m`, `reviewer`).
3. Implement `src/citation-gate.ts`:
   - Parse `[path:startLine-endLine]` citations from model outputs and verify against a target repository root on disk that every cited file exists and the cited line numbers fall within the file's actual line count.
4. Unit tests in `test/free-pool.test.ts` and `test/citation-gate.test.ts`.

## Comments

- Resolved on `feat/v0.0.1-burn-lab` (`ca13160` + `c39ee3d`): implemented `src/citation-gate.ts`, `src/free-pool.ts`, `scripts/check-bundle.mjs`, `scripts/sync-plugin-core.mjs`, `test/citation-gate.test.ts`, and `test/free-pool.test.ts`.
