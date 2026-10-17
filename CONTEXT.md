# factory-burn-lab

An autonomous multi-agent burner delivered as a companion Paseo plugin to `paseo-factory`: it harvests rotating free Flash models from OpenCode into verified research reports, prototypes, and codebase improvements under the supervision of each Project's strong `Supervisor` seat, without polluting `paseo-factory`'s production verification line.

## Language

### Core and boundaries

**Burn lab**:
The companion Paseo plugin (`factory-burn-lab`) and its isolated state directory (`<paseoHome>/burn-lab/`) where free-model experiments, benchmarks, open-source harvests, and prototype arenas run. It reads `paseo-factory`'s registered `Project`s and `Lane config` and reuses its verification core, but never writes to `paseo-factory`'s `Ledger`.
_Avoid_: burner mode, playground, sandbox

**Project**:
One Git repository registered in `paseo-factory` (`<project-slug> = <basename>-<sha1(gitRoot).slice(0,6)>`), which serves as the starting context and destination root for a `Burn run` and hosts the project's strong `Supervisor`.
_Avoid_: workspace, folder, target dir

**Supervisor**:
The Project's existing strong-model seat from `paseo-factory` (`lanes.supervisor`, rooted at `<project-root>`), acting as the anti-hallucination anchor for every `Burn run`: it frames the brief and verification criteria at the start of a run, judges the filtered evidence at the end, and is reached conversationally via `Open Supervisor`.
_Avoid_: anchor seat, orchestrator, manager, chair

**Upstream issue**:
A local markdown ticket (`Status: needs-triage`) filed by `factory-burn-lab` into `paseo-factory`'s `.scratch/burn-lab-upstream/issues/` whenever `Burn lab` needs a new primitive, hook, or provider capability from `paseo-factory`. `Burn lab` never edits `paseo-factory` directly.
_Avoid_: PR, monkey-patch, cross-repo edit

### Models and routing

**Free pool**:
The dynamically discovered catalog of `$0` / `-free` models available through OpenCode (`<paseoHome>/burn-lab/free-pool.json`), continuously probed for liveness, tool-calling reliability, context window, and empirical gate pass rates.
_Avoid_: model list, free tier, provider catalog

**Free model**:
One `$0` model entry inside the `Free pool` (invoked through OpenCode's harness to satisfy OpenCode's free-tier boundary), assigned one or more `Swarm role`s based on measured performance.
_Avoid_: cheap model, worker model, flash model (some free models are preview reasoning or 1M-context models)

**Swarm role**:
The capability badge assigned to a `Free model` by `Scout pool`: `coder` (writes and fixes code under a `Gate`), `reader-1m` (ingests large repositories or long logs in ≥200K–1M context), or `reviewer` (participates in a `Council` or `Citation gate` cross-check).
_Avoid_: persona, agent type, lane

### Verification fences

**Gate**:
The deterministic shell command or check inherited from `paseo-factory` whose zero exit status and output metrics judge whether a `Free model`'s code or prototype actually works.
_Avoid_: test step, check

**Citation gate**:
The mechanical verification pass over research outputs from `Free model`s: every architectural or code claim must carry `[path:startLine-endLine]` references that resolve to real files and line ranges in the inspected repository before the claim may reach the `Supervisor`.
_Avoid_: fact check, hallucination filter

**Council**:
A multi-family cross-examination pass in which two or three `Free model`s from distinct model families independently answer the same brief or critique a diff/report, surfacing agreements and contradictions before the `Supervisor`'s final synthesis.
_Avoid_: debate, committee, voting

### Playbooks and runs

**Burn run**:
One end-to-end autonomous execution launched from the `Burn Lab` UI against a selected `Project` using one `Burn playbook`: `Supervisor` framing → parallel `Free pool` execution in isolated worktrees/scratch dirs → `Gate` / `Citation gate` / `Council` filtering → `Supervisor` synthesis into a final deliverable.
_Avoid_: job, session, task (Task is `paseo-factory`'s unit)

**Burn playbook**:
One of the five autonomous workflows selectable on the `Burn Lab` UI: `Scout pool`, `OSS lab`, `Proto arena`, `Night shift`, and `Self-evolve`.
_Avoid_: template, workflow, recipe

**Scout pool**:
The `Burn playbook` that discovers all current `Free model`s in OpenCode, runs a standardized liveness, tool-call, code-fix `Gate`, and `Citation gate` micro-battery against each, and updates `free-pool.json` with their `Swarm role`s and win rates.
_Avoid_: model benchmark, health check

**OSS lab**:
The `Burn playbook` that clones an external open-source repository (or researches a technical topic), dispatches `reader-1m` and `coder` `Free model`s under a `Citation gate` and `Council`, builds a runnable mini-PoC verified by a `Gate`, and delivers a cited architectural report plus working PoC to the active `Project`.
_Avoid_: web research, repo reader

**Proto arena**:
The `Burn playbook` that takes a pet-project or feature idea, has the `Supervisor` define the `Gate` and module contracts, races multiple `coder` `Free model`s in isolated worktrees (Best-of-N tournament), and assembles the winning green branches into a working prototype.
_Avoid_: app generator, hackathon mode

**Night shift**:
The `Burn playbook` that runs unattended against the selected `Project` in isolated worktrees to hunt edge-case bugs, strengthen tests, or optimize measurable metrics (`Gate` score), presenting only `Gate`-green and `Council`-cleared commits to the `Supervisor`.
_Avoid_: cron job, background grinder

**Self-evolve**:
The `Burn playbook` that targets `factory-burn-lab` itself as the active `Project`, using the `Free pool` under `paseo-factory`'s `Gate` (`npm test && npm run check:bundle`) to build new `Burn lab` features and filing an `Upstream issue` whenever a core `paseo-factory` change is required.
_Avoid_: self-modifying code, auto-update
