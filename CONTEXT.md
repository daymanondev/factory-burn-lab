# factory-burn-lab

An autonomous multi-agent burner delivered as a companion Paseo plugin to `paseo-factory`: it harvests rotating free Flash models from OpenCode into verified research reports, prototypes, and codebase improvements under the supervision of each Project's strong `Supervisor` seat, without polluting `paseo-factory`'s production verification line.

## Language

### Core and boundaries

**Burn lab**:
The companion Paseo plugin (`factory-burn-lab`, installed alongside `paseo-factory`) and its isolated state directory (`<paseoHome>/burn-lab/`) where free-model experiments, benchmarks, open-source harvests, and prototype arenas run. It shares `paseo-factory`'s `Project` registry and `Lane config` (`<paseoHome>/plugin-state/paseo-factory/`) and instantiates `paseo-factory`'s verification core (`createFactory`) inside each `Burn run`'s own directory so `paseo-factory`'s production `Ledger` is never touched.
_Avoid_: burner mode, playground, sandbox

**Project**:
One Git repository registered in `paseo-factory` (`<project-slug> = <basename>-<sha1(gitCommonDir).slice(0,6)>`), shared across the `Factory surface` and `Burn Lab` via `<factoryStateDir>/projects/<slug>/project.json`, which serves as the starting context and destination root for a `Burn run` and hosts the project's strong `Supervisor`.
_Avoid_: workspace, folder, target dir

**Supervisor**:
The Project's existing strong-model seat from `paseo-factory` (`lanes.supervisor`, rooted at `<project-root>`), acting as the anti-hallucination anchor for every `Burn run`: it frames the brief and `Contract` criteria (`gate`, `artifact`, `scope`) at the start of a run, judges the filtered evidence at the end, and is reached conversationally via `Open Supervisor`.
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
The capability badge assigned to a `Free model` by `Scout pool`: `coder` (writes and fixes code under a `Contract` and `Gate`), `reader-1m` (ingests large repositories or long logs in ≥200K–1M context), or `reviewer` (participates in a `Council` or `Citation gate` cross-check).
_Avoid_: persona, agent type, lane

### Verification fences

**Gate**:
The deterministic check inherited from `paseo-factory`'s core (`runGate` inside `factory.claim`): it verifies clean-tree commit integrity, `scope` and `MEMORY_FILES` boundaries (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`), required `artifact` presence, and a zero exit status before any `Free model`'s code attempt can turn green.
_Avoid_: test step, check

**Citation gate**:
The mechanical verification pass over research outputs from `Free model`s: every architectural or code claim must carry `[path:startLine-endLine]` references that resolve to real files and line ranges in the inspected repository before the claim may reach the `Supervisor`.
_Avoid_: fact check, hallucination filter

**Council**:
A multi-family cross-examination pass in which two or three `Free model`s from distinct model families inspect the `Contract`, the actual `git diff` (`diffBetween`), `Gate` output, and `paseo-factory`'s five `Watch` questions (`destructive-writes`, `test-weakened`, `stuck-loop`, `scope-creep`, `secret-leak`) to challenge or approve an attempt before the `Supervisor`'s final synthesis.
_Avoid_: debate, committee, voting

### Playbooks and runs

**Burn run**:
One end-to-end autonomous execution launched from the `Burn Lab` UI against a selected `Project` using one `Burn playbook`: `Supervisor` framing into a `Contract` → parallel `Free pool` execution in isolated worktrees with self-repair rework under a run-scoped `createFactory` instance → `Gate` / `Citation gate` / `Council` filtering → `Supervisor` synthesis into a final report and optional `Winning branch landing`.
_Avoid_: job, session, task (Task is `paseo-factory`'s unit)

**Winning branch landing**:
The explicit 1-click Owner act on the `Burn Lab` UI (`burn.land`) that merges a `Burn run`'s verified winning commit (`claimedCommit` on `winningBranch`) back into `<project-root>` using `paseo-factory`'s `landTaskWorktree` (`--ff-only` or `--no-ff`, aborting cleanly on conflict while preserving the branch).
_Avoid_: auto-merge, force push, checkout overwrite

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

### Unattended execution

**Unattended preflight**:
The upfront readiness check and eager permission probe executed before or at the start of a `Burn run` to ensure neither the operating system nor the agent harness will pause mid-run for interactive approval.
_Avoid_: warm-up script, permission check, health check

**Responsible bundle**:
The host application bundle or executable to which the operating system attributes file, folder, and network access performed by `Burn lab` and its spawned child processes.
_Avoid_: parent process, wrapper app, daemon binary

**Sleep assertion**:
The run-scoped power lock held while at least one `Burn run` is active so the host machine does not idle-sleep mid-run and automatically resumes normal sleep policy once all runs finish.
_Avoid_: wake lock, keep-alive, anti-sleep

