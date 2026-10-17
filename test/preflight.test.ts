import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildExtendedPathEnv,
  candidateBinDirs,
  resolveOpenCodeBinary,
  UNATTENDED_OPENCODE_CONFIG,
} from "../src/free-pool.ts";
import {
  acquireSleepAssertion,
  checkMacFullDiskAccessSilent,
  checkUnattendedPreflight,
  ensureGlobalOpenCodeUnattendedConfig,
  isPathInsideProtectedFolder,
  isSleepAssertionActive,
  openOsPermissionSettings,
  runUnattendedWarmup,
} from "../src/preflight.ts";
import {
  resolveDefaultSelfRepoRoot,
  resolveDefaultUpstreamIssuesDir,
} from "../src/upstream.ts";

test("cross-platform PATH and OpenCode binary resolution work on both macOS (darwin) and Windows (win32)", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "burn-xplat-home-"));
  try {
    // Windows layout: %APPDATA%/npm/opencode.cmd
    const winNpmDir = join(fakeHome, "AppData", "Roaming", "npm");
    mkdirSync(winNpmDir, { recursive: true });
    const winCmdPath = join(winNpmDir, "opencode.cmd");
    writeFileSync(winCmdPath, "@echo off\r\n", "utf8");

    const winDirs = candidateBinDirs(fakeHome, "win32", {
      APPDATA: join(fakeHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(fakeHome, "AppData", "Local"),
    });
    assert.ok(winDirs.includes(winNpmDir));

    const resolvedWinBin = resolveOpenCodeBinary("win32", fakeHome, {
      APPDATA: join(fakeHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(fakeHome, "AppData", "Local"),
    });
    assert.equal(resolvedWinBin, winCmdPath);

    const winEnv = buildExtendedPathEnv({ Path: "C:\\Windows\\System32" }, "win32", fakeHome);
    assert.ok(winEnv.PATH?.includes(";"));
    assert.equal(winEnv.CI, "1");
    assert.equal(winEnv.GIT_TERMINAL_PROMPT, "0");
    assert.equal(winEnv.GCM_INTERACTIVE, "never");
    assert.equal(winEnv.HOST, "127.0.0.1");
    assert.equal(winEnv.OPENCODE_CONFIG_CONTENT, UNATTENDED_OPENCODE_CONFIG);

    // macOS layout: ~/.local/bin/opencode
    const macBinDir = join(fakeHome, ".local", "bin");
    mkdirSync(macBinDir, { recursive: true });
    const macBinPath = join(macBinDir, "opencode");
    writeFileSync(macBinPath, "#!/bin/sh\n", "utf8");

    const resolvedMacBin = resolveOpenCodeBinary("darwin", fakeHome, {});
    assert.equal(resolvedMacBin, macBinPath);

    const macEnv = buildExtendedPathEnv({ PATH: "/usr/bin:/bin" }, "darwin", fakeHome);
    assert.ok(macEnv.PATH?.includes(":"));
    assert.equal(macEnv.GCM_INTERACTIVE, "never");
    assert.equal(macEnv.HOST, "127.0.0.1");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("checkUnattendedPreflight detects protected folders, ShipIt stale binaries on darwin, and OneDrive/Documents on win32", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "burn-preflight-home-"));
  const fakeTccDb = join(fakeHome, "TCC.db");
  try {
    const docsRepo = join(fakeHome, "Documents", "code", "my-repo");
    const codeRepo = join(fakeHome, "code", "my-repo");
    const oneDriveRepo = join(fakeHome, "OneDrive", "my-repo");
    mkdirSync(docsRepo, { recursive: true });
    mkdirSync(codeRepo, { recursive: true });
    mkdirSync(oneDriveRepo, { recursive: true });

    assert.equal(isPathInsideProtectedFolder(docsRepo, fakeHome, "darwin"), true);
    assert.equal(isPathInsideProtectedFolder(codeRepo, fakeHome, "darwin"), false);
    assert.equal(isPathInsideProtectedFolder(oneDriveRepo, fakeHome, "win32"), true);

    // 1. macOS without Full Disk Access & with ShipIt stale binary
    const staleDarwin = checkUnattendedPreflight({
      platform: "darwin",
      home: fakeHome,
      projectRoot: docsRepo,
      tccDbPath: join(fakeHome, "missing-TCC.db"),
      macProcessDetector: () => ({
        responsiblePid: 999,
        responsiblePath:
          "/private/var/folders/xx/T/sh.paseo.desktop.ShipIt.1234/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
        bundleId: "sh.paseo.desktop.helper (Paseo Helper.app)",
        shipItStaleBinary: true,
      }),
      openCodeChecker: () => true,
    });
    assert.equal(staleDarwin.ready, false);
    assert.equal(staleDarwin.shipItStaleBinary, true);
    assert.equal(staleDarwin.fullDiskAccessGranted, false);
    assert.equal(staleDarwin.projectInProtectedFolder, true);
    assert.ok(staleDarwin.issues.some((i) => i.includes("ShipIt")));
    assert.ok(staleDarwin.issues.some((i) => i.includes("Full Disk Access")));

    // 2. macOS with Full Disk Access granted (simulated valid SQLite header) and clean binary
    writeFileSync(fakeTccDb, "SQLite format 3\0mockdata", "utf8");
    assert.equal(checkMacFullDiskAccessSilent({ tccDbPath: fakeTccDb }), true);

    const healthyDarwin = checkUnattendedPreflight({
      platform: "darwin",
      home: fakeHome,
      projectRoot: docsRepo,
      tccDbPath: fakeTccDb,
      macProcessDetector: () => ({
        responsiblePid: 1000,
        responsiblePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        bundleId: "sh.paseo.desktop (Paseo.app)",
        shipItStaleBinary: false,
      }),
      openCodeChecker: () => true,
    });
    assert.equal(healthyDarwin.ready, true);
    assert.equal(healthyDarwin.fullDiskAccessGranted, true);
    assert.equal(healthyDarwin.issues.length, 0);

    // 3. Windows inside OneDrive vs outside protected folders
    const winProtected = checkUnattendedPreflight({
      platform: "win32",
      home: fakeHome,
      projectRoot: oneDriveRepo,
      openCodeChecker: () => true,
    });
    assert.equal(winProtected.projectInProtectedFolder, true);
    assert.equal(winProtected.fullDiskAccessGranted, false);
    assert.ok(winProtected.issues.some((i) => i.includes("Windows Protected / OneDrive")));

    const winClean = checkUnattendedPreflight({
      platform: "win32",
      home: fakeHome,
      projectRoot: codeRepo,
      openCodeChecker: () => true,
    });
    assert.equal(winClean.ready, true);
    assert.equal(winClean.fullDiskAccessGranted, true);
    assert.equal(winClean.issues.length, 0);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("runUnattendedWarmup writes ~/.config/opencode/opencode.json and openOsPermissionSettings dispatches OS commands", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "burn-warmup-home-"));
  try {
    const cfgRes = ensureGlobalOpenCodeUnattendedConfig(fakeHome);
    assert.equal(cfgRes.ok, true);
    const parsedCfg = JSON.parse(readFileSync(cfgRes.configPath, "utf8")) as {
      permission?: Record<string, unknown>;
    };
    assert.equal(parsedCfg.permission?.["*"], "allow");
    assert.equal(parsedCfg.permission?.external_directory, "allow");
    assert.equal(parsedCfg.permission?.doom_loop, "allow");
    assert.equal(parsedCfg.permission?.question, "deny");

    const warmupState = await runUnattendedWarmup({
      platform: "win32",
      home: fakeHome,
      projectRoot: join(fakeHome, "code", "demo"),
      skipNetworkProbe: true,
      openCodeChecker: () => true,
    });
    assert.equal(warmupState.ready, true);

    const darwinCmds: Array<{ cmd: string; args: string[] }> = [];
    const darwinOpen = openOsPermissionSettings({
      platform: "darwin",
      runner: (cmd, args) => darwinCmds.push({ cmd, args }),
    });
    assert.equal(darwinOpen.ok, true);
    assert.ok(
      darwinCmds.some((c) =>
        c.args.includes("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
      ),
    );

    const winCmds: Array<{ cmd: string; args: string[] }> = [];
    const winOpen = openOsPermissionSettings({
      platform: "win32",
      runner: (cmd, args) => winCmds.push({ cmd, args }),
    });
    assert.equal(winOpen.ok, true);
    assert.ok(
      winCmds.some((c) => c.args.includes("windowsdefender://ransomwareprotection")),
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("acquireSleepAssertion ref-counts active Burn runs and releases cleanly", () => {
  assert.equal(isSleepAssertionActive(), false);
  const h1 = acquireSleepAssertion({ spawnProcess: false });
  const h2 = acquireSleepAssertion({ spawnProcess: false });
  assert.equal(h1.active, true);
  assert.equal(h2.active, true);
  h1.release();
  h2.release();
  assert.equal(isSleepAssertionActive(), false);
});

test("resolveDefaultSelfRepoRoot and resolveDefaultUpstreamIssuesDir support env overrides and dynamic discovery", () => {
  const customSelf = resolveDefaultSelfRepoRoot("/tmp", "/tmp", {
    BURN_LAB_SELF_REPO_ROOT: "/custom/factory-burn-lab",
  });
  assert.equal(customSelf, "/custom/factory-burn-lab");

  const customUpstream = resolveDefaultUpstreamIssuesDir(customSelf, {
    BURN_LAB_UPSTREAM_ISSUES_DIR: "/custom/upstream/issues",
  });
  assert.equal(customUpstream, "/custom/upstream/issues");
});
