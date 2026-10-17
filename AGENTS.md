# factory-burn-lab

Companion Paseo plugin and autonomous free-model burner (`factory-burn-lab`) paired with [`paseo-factory`](../research-slp). Turns rotating `$0` / `-free` models on OpenCode Zen into gated multi-agent swarms (`scout-pool`, `oss-lab`, `proto-arena`, `night-shift`, `self-evolve`) supervised by each Project's strong `Supervisor` model, controlled 100% from the Paseo Desktop UI.

## Relationship to `paseo-factory`

- **Consumes `paseo-factory` core & state:** `factory-burn-lab` reuses `paseo-factory`'s verification primitives (`Contract`, `Gate`, `Task worktree`, `Choke policy`, `Lane config`) and reads `<paseoHome>/factory/projects/` + `lanes.json` so every Burn Run starts from a selected Project repository and uses that Project's strong `Supervisor` seat as its anti-hallucination anchor.
- **Zero contamination of `paseo-factory`:** All burn runs, free-pool health/capability rankings (`free-pool.json`), scratch clones, and lab reports live under `<paseoHome>/burn-lab/`. `factory-burn-lab` never writes to `<paseoHome>/factory/ledger.jsonl` or mutates `paseo-factory` source code.
- **Upstream Issue Protocol:** Whenever `factory-burn-lab` needs a new primitive, hook, or lane capability from `paseo-factory`, it files a markdown issue with `Status: needs-triage` under `/Users/andrewpham/Documents/code/self-project/research-slp/.scratch/burn-lab-upstream/issues/NN-<slug>.md` for human/Supervisor evaluation before any change is made to `paseo-factory`.

## Trial daemon

All paseo/factory/burn-lab runtime work targets the trial home `~/.paseo-factory` (never the default `~/.paseo` — that is prod, where only verified builds are installed). `paseo` sits at `~/.local/bin/paseo`; node comes from nvm (`~/.nvm/versions/node/`, default v24); `opencode` sits on PATH via nvm.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/` (not GitHub Issues). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as `Status:` lines in issue files. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` (symlinked as `GLOSSARY.md`) and `docs/adr/` at the repo root, created and maintained by `/domain-modeling`. See `docs/agents/domain.md`.
