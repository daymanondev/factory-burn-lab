#!/usr/bin/env node
/**
 * Cross-platform (macOS darwin + Windows win32) Unattended Preflight &
 * Eager Permission Warm-up CLI.
 *
 * Usage:
 *   node scripts/preflight-permissions.mjs                  # Run eager warm-up + print readiness
 *   node scripts/preflight-permissions.mjs --open-settings  # Also open OS Full Disk Access / Windows Security settings
 */
import {
  openOsPermissionSettings,
  runUnattendedWarmup,
} from "../src/preflight.ts";
import { resolveDefaultSelfRepoRoot, resolveDefaultUpstreamIssuesDir } from "../src/upstream.ts";

const args = new Set(process.argv.slice(2));
const selfRepoRoot = resolveDefaultSelfRepoRoot();
const upstreamIssuesDir = resolveDefaultUpstreamIssuesDir(selfRepoRoot);

const state = await runUnattendedWarmup({
  projectRoot: selfRepoRoot,
  upstreamIssuesDir,
});

console.log("=== factory-burn-lab Unattended Preflight ===");
console.log(`Platform:                ${state.platform}`);
console.log(`Responsible bundle:      ${state.responsibleBundle}`);
console.log(`Ready for unattended:    ${state.ready}`);
console.log(`Full Disk / Folder OK:   ${state.fullDiskAccessGranted ?? "n/a"}`);
console.log(`ShipIt stale binary:     ${state.shipItStaleBinary}`);
console.log(`Project root accessible: ${state.projectRootAccessible} (${selfRepoRoot})`);
console.log(`Protected folder path:   ${state.projectInProtectedFolder}`);
console.log(`Worktree junctions OK:   ${state.worktreeJunctionReady}`);
console.log(`OpenCode --auto ready:   ${state.openCodeAutoReady}`);
console.log(`Sleep assertion active:  ${state.sleepAssertionActive}`);

if (state.issues.length > 0) {
  console.log("\nWarnings / Actionable Items:");
  for (const issue of state.issues) {
    console.log(`  - ${issue}`);
  }
}

if (args.has("--open-settings")) {
  const opened = openOsPermissionSettings();
  if (opened.ok) {
    console.log(`\nOpened OS Security Settings: ${opened.opened.join(", ")}`);
  } else {
    console.error(`\nCould not open OS Security Settings: ${opened.error}`);
  }
}

if (!state.ready) {
  process.exit(1);
}
