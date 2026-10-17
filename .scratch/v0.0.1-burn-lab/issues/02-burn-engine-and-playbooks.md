# 02 — 3-Tier `Burn run` engine, 5 `Burn playbook`s, and `Upstream issue` writer

Status: done
Blocked by: 01

## Scope

1. Implement `src/burn-engine.ts`:
   - Read `paseo-factory`'s `<paseoHome>/factory/projects/` and `lanes.json` to resolve the active `Project` and its `Supervisor` model lane (`lanes.supervisor`).
   - Execute the 3-tier pipeline in `<paseoHome>/burn-lab/runs/<runId>/`:
     - **Tier 1 (Framing):** Prompt the `Supervisor` model lane to produce the structured execution plan and `Gate` / research brief.
     - **Tier 2 (Swarm & Verification Fence):** Dispatch healthy `Free model`s from `free-pool.json` in parallel (`oss-lab` with `reader-1m` + `Citation gate` + `Council`; `proto-arena` with Best-of-N `coder` worktrees + `Gate`; `night-shift` with isolated `Project` worktrees + `Gate` + `Council`; `self-evolve` targeting `factory-burn-lab` under `npm test && npm run check:bundle`).
     - **Tier 3 (Synthesis):** Prompt the `Supervisor` model lane over the `Gate`-green / `Citation gate`-verified outputs to write the final deliverable (`report.md` and/or verified prototype branch).
2. Implement `src/upstream.ts`:
   - Read and file `Upstream issue` markdown files (`Status: needs-triage`) under `/Users/andrewpham/Documents/code/self-project/research-slp/.scratch/burn-lab-upstream/issues/NN-<slug>.md`.
3. Unit tests in `test/burn-engine.test.ts` and `test/upstream.test.ts`.

## Comments

- Resolved on `feat/v0.0.1-burn-lab` (`e76e88e` + `c39ee3d`): implemented `src/burn-engine.ts`, `src/upstream.ts`, `test/burn-engine.test.ts`, and `test/upstream.test.ts`.
