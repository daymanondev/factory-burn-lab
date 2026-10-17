# 03 — Paseo plugin server RPCs and 100% UI-driven `Burn Lab` surface

Status: ready-for-agent
Blocked by: 02

## Scope

1. Create `plugin/paseo-plugin.json`, `plugin/shared/view.ts`, and `plugin/shared/rpc.ts` defining:
   - `burn.snapshot` (active `Project`, `Supervisor` lane, `Free pool` matrix, `Burn run` cards, and `Upstream issue` list)
   - `burn.scout` (trigger 1-click `Scout pool` refresh & benchmark)
   - `burn.start` (launch any of the 5 `Burn playbook`s from the UI)
   - `burn.detail` (full `Burn run` report, `Citation gate` / `Gate` logs, and `Council` breakdown)
   - `burn.upstream.file` (file a new `Upstream issue` to `paseo-factory` from the UI)
   - `burn.project.add` (select or `git init` a new Pet Project repo directly from the UI)
2. Create `plugin/index.server.ts` and `plugin/index.client.tsx` (`BurnLabShell`):
   - Sidebar screen + Workspace panel (`Burn Lab`, icon `Flame`).
   - Top bar with `Project` selector (synced with `paseo-factory`), `Open Supervisor` 1-click bridge, and `Free Pool` status + `Scout Free Models` button.
   - Playbook launcher card (`OSS Lab`, `Proto Arena`, `Night Shift`, `Self-Evolve`, `Scout Pool`) with `Start Burn Run` button.
   - Live `Burn Runs & Deliverables` list + Detail modal + `Factory Upstream Issues` drawer.
3. Verify `npm test` and `npm run check:bundle`.
