# ADR 0001 — Standalone `factory-burn-lab` companion plugin, 3-tier anti-hallucination swarm, and upstream issue protocol

- **Status:** Accepted — 2026-10-17 (ratified by Andrew over a five-round `/grill-with-docs` session)
- **Context:** OpenCode Zen provides a rotating catalog of `$0` / `-free` models across diverse families (`glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`, `beam-free`, `longcat-2.5-preview-free`, `space-bunny-free`, `big-pickle`, etc.). Calling `https://opencode.ai/zen/v1/chat/completions` outside OpenCode throws `FreeTierError`, whereas invoking through OpenCode's CLI/SDK (`opencode run --standalone -m opencode/<model>` or Paseo's `opencode` provider) succeeds at `$0`. Meanwhile, `paseo-factory` is being built as a serious, minimal open-source verification core and must not be bloated or polluted by experimental free-model burning workflows.

## Decision

1. **Separate Repository & Companion Paseo Plugin (`factory-burn-lab` paired with `paseo-factory`).**
   - `paseo-factory` (formerly `paseo-slp-factory`) remains 100% pure as the open-source verification core.
   - `factory-burn-lab` lives in its own repository (`/Users/andrewpham/Documents/code/self-project/factory-burn-lab`) and installs into Paseo (`~/.paseo-factory` and `~/.paseo`) as a companion plugin alongside `paseo-factory`, registering its own `Burn Lab` surface (`Flame` icon) in Paseo Desktop.
   - All interaction is **100% UI-driven inside Paseo Desktop** (zero CLI requirement for the human operator).
   - State is strictly isolated under `<paseoHome>/burn-lab/` (`free-pool.json`, `runs/`, scratch worktrees, and reports) — never writing into `<paseoHome>/factory/ledger.jsonl`.

2. **Project-Rooted Execution & Shared `Supervisor` Seat (No Duplicate `Anchor` Seat).**
   - Every `Burn run` starts from a selected `Project` repository (reading `paseo-factory`'s `<paseoHome>/factory/projects/` registry, plus allowing 1-click repo creation/selection on the UI).
   - Instead of inventing a second strong-model chat seat, `factory-burn-lab` uses the selected Project's existing **`Supervisor`** (`lanes.supervisor`, rooted at `<project-root>`) as its strong anti-hallucination anchor. When the Owner wants to converse before or after a `Burn run`, they use the Project's `Open Supervisor` bridge.

3. **Three-Tier Anti-Hallucination Architecture (~5% Strong Model / ~95% Free Pool).**
   - **Tier 1 — Strong `Supervisor` Framing & Final Synthesis:** The Project's strong model (`lanes.supervisor`) runs only at the start of a `Burn run` (to decompose the brief and define the deterministic `Gate` / `Citation gate`) and at the end (to judge filtered evidence and synthesize the final report or deliverable).
   - **Tier 2 — Mechanical & Cross-Family Verification Fence (`Gate` + `Citation gate` + `Council`):**
     - Code & prototypes execute in isolated git worktrees and must pass a deterministic `Gate` command; red attempts are discarded or reworked by `Free model`s without waking the `Supervisor`.
     - Open-source research (`OSS lab`) enforces a mechanical **`Citation gate`** (verifying every `[path:startLine-endLine]` citation against the cloned repository on disk) plus a multi-family **`Council`** (2–3 `Free model`s from different families cross-checking claims).
   - **Tier 3 — Dynamic OpenCode `Free pool` (`<paseoHome>/burn-lab/free-pool.json`):**
     - Automatically discovers all `-free` / `$0` models via `opencode models`, probes health and tool-calling, and classifies each model into `Swarm role`s (`coder`, `reader-1m`, `reviewer`) based on empirical `Scout pool` results.

4. **Five 1-Click UI Playbooks (`Burn playbook`).**
   - **`Scout pool`:** Benchmarks all current OpenCode free models (speed, tool use, bug-fix `Gate`, and `Citation gate`) and updates `free-pool.json`.
   - **`OSS lab`:** Clones an open-source GitHub repo (or researches a topic), runs `reader-1m` + `Council` + `Citation gate`, builds a `Gate`-verified mini-PoC, and delivers the report + PoC into the active `Project`.
   - **`Proto arena`:** Races multiple `coder` `Free model`s in parallel worktrees (Best-of-N tournament) under a `Supervisor`-authored `Gate` to ship a complete pet project or prototype.
   - **`Night shift`:** Runs unattended in isolated worktrees of an existing `Project` to hunt bugs, add edge-case tests, or evolve performance metrics.
   - **`Self-evolve`:** Targets `factory-burn-lab` itself as the `Project`, using `paseo-factory` and the `Free pool` to develop new `factory-burn-lab` capabilities under `npm test && npm run check:bundle`.

5. **Upstream Issue Protocol (`factory-burn-lab` → `paseo-factory`).**
   - Whenever `factory-burn-lab` needs a new primitive, hook, or provider support from `paseo-factory`, it never modifies `paseo-factory` directly. It writes a markdown issue with `Status: needs-triage` into `paseo-factory`'s `.scratch/burn-lab-upstream/issues/NN-<slug>.md` and surfaces it in the `Burn Lab` UI's **Factory Upstream Issues** panel for human review.
