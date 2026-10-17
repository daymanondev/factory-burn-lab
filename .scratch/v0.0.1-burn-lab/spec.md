# Spec — `factory-burn-lab` v0.0.1: Companion UI Plugin, Dynamic OpenCode Free Pool & 5 Burn Playbooks

Status: done

- **Grounded in:** [`CONTEXT.md`](../../CONTEXT.md) · [`ADR 0001`](../../docs/adr/0001-companion-plugin-and-opencode-free-swarm.md) · [`paseo-factory` (`../research-slp`)](../../../research-slp/CONTEXT.md)

## Problem Statement

OpenCode Zen provides a rotating catalog of `$0` / `-free` models across distinct model families (`opencode/glm-5.3-flash-free`, `opencode/deepseek-v4.1-flash-free`, `opencode/mimo-v2.6-flash-free`, `opencode/nemotron-3-ultra-free`, `opencode/nemotron-3.5-lightning-free`, `opencode/nemotron-3.5-super-vl-free`, `opencode/beam-free`, `opencode/longcat-2.5-preview-free`, `opencode/space-bunny-free`, `opencode/big-pickle`, and future rotating models). Calling `https://opencode.ai/zen/v1/chat/completions` directly outside OpenCode fails with `FreeTierError`, whereas invoking through OpenCode (`opencode run --standalone -m opencode/<model>`) succeeds at `$0`.

Individually, Flash/Free models are fast and free with 200K–1M context windows, but prone to hallucinations and premature "done" claims when unsupervised. Meanwhile, `paseo-factory` is a disciplined open-source verification core and must not be polluted or bloated by experimental token-burning workflows. The Owner interacts exclusively through the Paseo Desktop UI (never CLI commands) and wants a companion Paseo plugin (`factory-burn-lab`) that starts from any selected `Project` repository, uses that Project's strong `Supervisor` model as an anti-hallucination anchor (~5% tokens), and burns the OpenCode `Free pool` (~95% tokens) across autonomous research, prototyping, codebase improvement, and self-evolution playbooks.

## Solution

1. **Standalone Companion Paseo Plugin (`factory-burn-lab`) with Isolated State (`<paseoHome>/burn-lab/`):**
   - Registers a `Burn Lab` screen, sidebar header item, and workspace panel (`Flame` icon) inside Paseo Desktop alongside `paseo-factory`.
   - Reads `paseo-factory`'s registered `Project` list (`<paseoHome>/factory/projects/*.json`) and `Lane config` (`lanes.json`) so every `Burn run` is rooted at a real `Project` and uses that Project's configured `Supervisor` lane (`lanes.supervisor`) as its strong model anchor, while storing all `Burn lab` state strictly inside `<paseoHome>/burn-lab/`.
2. **Dynamic OpenCode `Free pool` Discovery & `Scout pool` Benchmarking (`src/free-pool.ts`):**
   - Automatically discovers all `-free` / `$0` models from `opencode models` and OpenCode's model metadata cache (`~/.cache/opencode/models.json`).
   - Runs a 1-click `Scout pool` micro-battery against each `Free model` via `opencode run --standalone -m <model>`: probing liveness/latency, a deterministic code-fix `Gate`, and a `Citation gate` extraction check, persisting `<paseoHome>/burn-lab/free-pool.json` with assigned `Swarm role`s (`coder`, `reader-1m`, `reviewer`) and win rates.
3. **Three-Tier Anti-Hallucination `Burn run` Engine (`src/burn-engine.ts` & `src/citation-gate.ts`):**
   - **Tier 1 (`Supervisor` Framing):** Invokes the active Project's `Supervisor` model lane at the start of a `Burn run` to decompose the user's UI brief into parallel sub-tasks and define the `Gate` / `Citation gate` criteria.
   - **Tier 2 (`Free pool` Swarm + Mechanical Fence):** Dispatches multiple `Free model`s from distinct model families in parallel isolated scratch directories / git worktrees, filtering outputs through a shell `Gate` (for code/prototypes), a mechanical `Citation gate` (`[path:startLine-endLine]` verified against real files and line counts on disk for research), and a cross-family `Council` (2–3 `Free model`s critiquing and cross-checking).
   - **Tier 3 (`Supervisor` Synthesis):** Invokes the `Supervisor` model lane once at the end over the verified evidence to produce the final report (`report.md`) and/or verified prototype branch.
4. **Five 1-Click UI `Burn playbook`s (`scout-pool`, `oss-lab`, `proto-arena`, `night-shift`, `self-evolve`) & `Upstream issue` Protocol (`src/upstream.ts`):**
   - Controlled 100% from the `Burn Lab` UI in Paseo Desktop, including a `Factory Upstream Issues` panel that reads and files `Status: needs-triage` markdown tickets into `/Users/andrewpham/Documents/code/self-project/research-slp/.scratch/burn-lab-upstream/issues/NN-<slug>.md` whenever `factory-burn-lab` needs a capability from `paseo-factory`.

## User Stories

1. As an `Owner`, I want to open `Burn Lab` directly from the Paseo Desktop sidebar or workspace panel without ever typing a CLI command, so that I can control all free-model burning workflows from the UI.
2. As an `Owner`, I want `Burn Lab` to share `paseo-factory`'s `Project` selector (and let me add or `git init` a new Pet Project folder from the UI) plus the `Open Supervisor` 1-click chat button, so that every `Burn run` starts from a concrete repository and uses that Project's `Supervisor` seat.
3. As an `Owner`, I want to click `Scout Free Models` on the `Burn Lab` UI to automatically discover all current `opencode/*-free` models, test their health, speed, coding `Gate` pass rate, and citation accuracy, and assign `coder`, `reader-1m`, and `reviewer` badges in `free-pool.json`, so that future OpenCode free models are utilized automatically without manual config edits.
4. As an `Owner`, I want to select the `OSS Lab` playbook on the UI, paste a GitHub repository URL or research topic, and click `Start Burn Run`, so that `reader-1m` and `coder` `Free model`s clone the repo, analyze its architecture under a strict `Citation gate` (`[path:startLine-endLine]`) and multi-family `Council`, build a `Gate`-verified mini-PoC, and have the `Supervisor` model synthesize a cited report in my active `Project`.
5. As an `Owner`, I want to select the `Proto Arena` playbook on the UI, describe a pet project or tool idea, and click `Start Burn Run`, so that the `Supervisor` model defines a deterministic `Gate` and races multiple `coder` `Free model`s in isolated worktrees (Best-of-N tournament) until a working, tested prototype is ready.
6. As an `Owner`, I want to select the `Night Shift` playbook on the UI for an existing `Project`, so that the `Free pool` hunts edge-case bugs, writes tests, or optimizes a measurable metric in isolated worktrees, surfacing only `Gate`-green and `Council`-cleared branches.
7. As an `Owner`, I want to select the `Self-Evolve` playbook on the UI targeting `factory-burn-lab` itself, so that the `Free pool` builds and tests new `Burn lab` features under `npm test && npm run check:bundle`.
8. As an `Owner`, I want `Burn Lab` to display a `Factory Upstream Issues` section on the UI and file `Status: needs-triage` tickets into `paseo-factory/.scratch/burn-lab-upstream/issues/` whenever `factory-burn-lab` needs a core `paseo-factory` feature, so that `paseo-factory` remains clean and every upstream change is carefully reviewed first.

## Implementation Decisions

1. **Placement & Bundle Boundary Law (Shared with `paseo-factory`):**
   - Pure Node domain modules live in `src/` (`src/free-pool.ts`, `src/citation-gate.ts`, `src/upstream.ts`, `src/burn-engine.ts`, `src/index.ts`) and are synced into `plugin/server/core/` via `npm run sync:plugin-core`.
   - `scripts/check-bundle.mjs` enforces that both `plugin/index.client.tsx` (Hermes CJS, no `class` syntax, no `node:*` imports) and `plugin/index.server.ts` compile cleanly from git-tracked files.
2. **OpenCode Free-Tier Runner (`src/free-pool.ts`):**
   - Because direct HTTP calls to `https://opencode.ai/zen/v1/chat/completions` fail with `FreeTierError`, `Free model` invocations run via `opencode run --standalone -m <model>` (resolving `opencode` on PATH across nvm node versions) inside an isolated temporary directory with a hard SIGKILL timeout.
   - Strong `Supervisor` framing and synthesis passes read `lanes.supervisor` from `<paseoHome>/factory/lanes.json` (or per-project override) and run via the configured provider CLI (`pi`, `copilot`, `claude`, or `opencode`).
3. **Mechanical `Citation gate` (`src/citation-gate.ts`):**
   - Extracts all `[path:startLine-endLine]` (and `[path:line]`) citations from a model's markdown output, checks that `<repoRoot>/<path>` exists as a regular file inside `<repoRoot>` (rejecting path traversal), and verifies `1 <= startLine <= endLine <= actualLineCount`. Returns `{ ok, totalCitations, validCitations, invalidCitations }` and fails when `totalCitations === 0` or `invalidCitations.length > 0`.
4. **Isolated `Burn lab` State (`<paseoHome>/burn-lab/`):**
   - `<paseoHome>/burn-lab/free-pool.json`: discovered models, `Swarm role` badges, latency, and empirical pass counts.
   - `<paseoHome>/burn-lab/runs/<runId>.json` and `<paseoHome>/burn-lab/runs/<runId>/`: per-run state machine (`queued` → `framing` → `swarm-running` → `verifying` → `synthesizing` → `completed` | `failed`), per-model attempt logs, `Citation gate` / `Gate` results, `Council` notes, and final `report.md`.

## Testing Decisions

- **High-seam behavioral tests only:** Tests drive public module entry points (`discoverFreePool`, `scoutFreePool`, `verifyCitations`, `runBurnPlaybook`, `listUpstreamIssues`, `fileUpstreamIssue`, `createBurnSurfaceHandlers`) against real temporary directories on disk and injected runner seams — never mocking internal helpers.
- **`npm run sync:plugin-core && npm run typecheck && npm test`** is the mandatory gate for every ticket.

## Out of Scope

- Modifying `paseo-factory` (`../research-slp`) source files directly during `factory-burn-lab` implementation (any required `paseo-factory` enhancements are tracked via `Upstream issue`s in `../research-slp/.scratch/burn-lab-upstream/issues/`).
- Requiring the human operator to run any CLI commands to use `Burn Lab`.
