# Spec — `factory-burn-lab` v0.0.1: Companion UI Plugin, Dynamic OpenCode Free Pool & 5 Burn Playbooks

- **Grounded in:** [`CONTEXT.md`](../../CONTEXT.md) · [`ADR 0001`](../../docs/adr/0001-companion-plugin-and-opencode-free-swarm.md) · [`paseo-factory` (`../research-slp`)](../../../research-slp/CONTEXT.md)

## Goal

Ship `factory-burn-lab` v0.0.1 as a standalone Paseo plugin (`plugin/index.server.ts` + `plugin/index.client.tsx`) with a pure Node core (`src/`) that:
1. Discovers, probes, and benchmarks all `$0` / `-free` models in OpenCode (`Scout pool` → `<paseoHome>/burn-lab/free-pool.json`).
2. Shares `paseo-factory`'s registered `Project` list and strong `Supervisor` lane (`lanes.supervisor`) while isolating all burn state in `<paseoHome>/burn-lab/`.
3. Provides a 100% UI-driven `Burn Lab` screen and workspace panel in Paseo Desktop with 1-click execution of all 5 `Burn playbook`s (`scout-pool`, `oss-lab`, `proto-arena`, `night-shift`, `self-evolve`), live progress polling, a Deliverable/Report modal, and an **Upstream Factory Issues** panel that files `needs-triage` tickets into `paseo-factory/.scratch/burn-lab-upstream/issues/`.

## Implementation Issues

1. [01-scaffold-and-free-pool-scout.md](./issues/01-scaffold-and-free-pool-scout.md) — Repo package scaffold, Hermes bundle gate (`scripts/check-bundle.mjs`), OpenCode CLI runner (`opencode run --standalone -m opencode/<model>`), and `Scout pool` engine (`src/free-pool.ts` + `src/citation-gate.ts`).
2. [02-burn-engine-and-playbooks.md](./issues/02-burn-engine-and-playbooks.md) — 3-Tier `Burn run` engine (`Supervisor` framing → parallel `Free pool` worktree/scratch execution → `Gate` + `Citation gate` + `Council` → `Supervisor` synthesis) for `oss-lab`, `proto-arena`, `night-shift`, and `self-evolve`, plus the `Upstream issue` writer (`src/upstream.ts`).
3. [03-paseo-plugin-surface-and-ui.md](./issues/03-paseo-plugin-surface-and-ui.md) — Paseo server RPCs (`burn.snapshot`, `burn.scout`, `burn.start`, `burn.detail`, `burn.upstream.file`, `burn.project.init`) and React Native / Hermes UI (`BurnLabShell` with Project selector, `Free Pool` matrix, 5-Playbook launcher, live `Burn Runs` cards, Report modal, and Upstream Issues panel).
4. [04-live-trial-scout-and-first-burn.md](./issues/04-live-trial-scout-and-first-burn.md) — Install `factory-burn-lab` into `~/.paseo-factory` and `~/.paseo`, execute a live `Scout pool` run across the 10 OpenCode free models, and verify end-to-end UI rendering.
