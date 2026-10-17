# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** (also symlinked as **`GLOSSARY.md`**) at the repo root
- **`docs/adr/`**: read ADRs that touch the area you're about to work in

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is **single-context**:

```
/
├── CONTEXT.md
├── GLOSSARY.md -> CONTEXT.md
├── docs/adr/
│   ├── 0001-<decision-slug>.md
│   └── ...
├── plugin/
│   ├── client/  # Burn Lab Paseo UI
│   ├── server/  # Burn Lab daemon-side runner & RPC
│   └── shared/  # Wire schemas & RPC contracts
└── src/         # Pure Burn Lab core (free-pool scout, playbooks, citation gate)
```

There is no `CONTEXT-MAP.md`; don't look for one.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (…), but worth reopening because…_
