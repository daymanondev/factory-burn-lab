import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as dgram from "node:dgram";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  buildExtendedPathEnv,
  resolveOpenCodeBinary,
  UNATTENDED_OPENCODE_CONFIG,
} from "./free-pool.ts";

export type PreflightPlatform = "darwin" | "win32" | "linux" | "other";

export interface UnattendedPreflightState {
  platform: PreflightPlatform;
  ready: boolean;
  responsibleBundle: string;
  fullDiskAccessGranted: boolean | null;
  shipItStaleBinary: boolean;
  projectRootAccessible: boolean;
  projectInProtectedFolder: boolean;
  worktreeJunctionReady: boolean;
  openCodeAutoReady: boolean;
  sleepAssertionActive: boolean;
  issues: string[];
  checkedAt: string;
}

export interface SleepAssertionHandle {
  active: boolean;
  strategy: "caffeinate" | "windows-execution-state" | "none";
  release: () => void;
}

let activeSleepRefCount = 0;
let activeSleepChild: ChildProcess | null = null;
let activeSleepStrategy: "caffeinate" | "windows-execution-state" | "none" = "none";
let lastWarmupAtMs = 0;

export function normalizePlatform(platform: string = process.platform): PreflightPlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  return "other";
}

export function isPathInsideProtectedFolder(
  targetPath: string | undefined,
  home: string = homedir(),
  platform: string = process.platform,
): boolean {
  if (!targetPath) return false;
  const resolved = resolve(targetPath);
  const protectedRoots = [
    join(home, "Documents"),
    join(home, "Desktop"),
    join(home, "Downloads"),
  ];
  if (platform === "win32") {
    protectedRoots.push(join(home, "OneDrive"));
  }
  return protectedRoots.some(
    (root) =>
      resolved === root ||
      resolved.startsWith(`${root}/`) ||
      resolved.startsWith(`${root}\\`),
  );
}

export interface MacResponsibleProcessInfo {
  responsiblePid: number;
  responsiblePath: string;
  bundleId: string;
  shipItStaleBinary: boolean;
}

export function detectMacResponsibleProcess(options?: {
  runner?: () => string;
}): MacResponsibleProcessInfo {
  try {
    const raw = options?.runner
      ? options.runner()
      : execFileSync(
          "python3",
          [
            "-c",
            [
              "import ctypes, json, os",
              "lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
              "lib.responsibility_get_pid_responsible_for_pid.argtypes = [ctypes.c_int]",
              "lib.responsibility_get_pid_responsible_for_pid.restype = ctypes.c_int",
              "lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]",
              "lib.proc_pidpath.restype = ctypes.c_int",
              "def ppath(p):",
              "  b = ctypes.create_string_buffer(4096)",
              "  lib.proc_pidpath(p, b, 4096)",
              "  return b.value.decode('utf-8', 'replace')",
              "pid = os.getpid()",
              "rpid = lib.responsibility_get_pid_responsible_for_pid(pid)",
              "if rpid <= 0: rpid = pid",
              "rpath = ppath(rpid)",
              "cpath = ppath(pid)",
              "print(json.dumps({'rpid': rpid, 'rpath': rpath, 'cpath': cpath}))",
            ].join("\n"),
          ],
          {
            encoding: "utf8",
            timeout: 3_000,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
    const parsed = JSON.parse(raw.trim()) as {
      rpid?: number;
      rpath?: string;
      cpath?: string;
    };
    const rpid = typeof parsed.rpid === "number" ? parsed.rpid : process.pid;
    const rpath = typeof parsed.rpath === "string" ? parsed.rpath : "";
    const cpath = typeof parsed.cpath === "string" ? parsed.cpath : "";
    const shipItStaleBinary =
      !rpath ||
      rpath.includes(".ShipIt.") ||
      rpath.includes("/ShipIt/") ||
      Boolean(cpath && (cpath.includes(".ShipIt.") || cpath.includes("/ShipIt/")));

    let bundleId = "unknown";
    if (rpath.includes("Paseo Helper.app")) {
      bundleId = "sh.paseo.desktop.helper (Paseo Helper.app)";
    } else if (rpath.includes("Paseo.app")) {
      bundleId = "sh.paseo.desktop (Paseo.app)";
    } else if (rpath.includes("Ghostty.app")) {
      bundleId = "com.mitchellh.ghostty (Ghostty.app)";
    } else if (rpath) {
      const appMatch = rpath.match(/\/([^/]+\.app)\//);
      bundleId = appMatch ? appMatch[1]! : basename(rpath);
    }

    return {
      responsiblePid: rpid,
      responsiblePath: rpath,
      bundleId,
      shipItStaleBinary,
    };
  } catch {
    const execPath = process.execPath || "node";
    return {
      responsiblePid: process.pid,
      responsiblePath: execPath,
      bundleId: execPath.includes("Paseo Helper.app")
        ? "sh.paseo.desktop.helper (Paseo Helper.app)"
        : execPath.includes("Paseo.app")
          ? "sh.paseo.desktop (Paseo.app)"
          : basename(execPath),
      shipItStaleBinary: execPath.includes(".ShipIt."),
    };
  }
}

/**
 * Silent check for Full Disk Access (`kTCCServiceSystemPolicyAllFiles`) on macOS.
 * Reading `/Library/Application Support/com.apple.TCC/TCC.db` in readonly mode
 * never triggers a macOS modal dialog: it succeeds iff Full Disk Access is granted
 * to the current Responsible bundle.
 */
export function checkMacFullDiskAccessSilent(options?: {
  tccDbPath?: string;
}): boolean {
  const tccDbPath =
    options?.tccDbPath ?? "/Library/Application Support/com.apple.TCC/TCC.db";
  if (!existsSync(tccDbPath)) return false;
  try {
    const buf = Buffer.alloc(16);
    const fd = openSync(tccDbPath, "r");
    try {
      readSync(fd, buf, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8", 0, 15).startsWith("SQLite format 3");
  } catch {
    return false;
  }
}

export function checkWorktreeJunctionSupport(
  platform: string = process.platform,
): boolean {
  const tempRoot = mkdtempSync(join(tmpdir(), "burn-junction-check-"));
  try {
    const targetDir = join(tempRoot, "target");
    const linkDir = join(tempRoot, "link");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "ok.txt"), "ok\n", "utf8");
    symlinkSync(targetDir, linkDir, platform === "win32" ? "junction" : "dir");
    return existsSync(join(linkDir, "ok.txt"));
  } catch {
    return false;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function checkOpenCodeAutoSupport(options?: {
  binary?: string;
  runner?: () => string;
}): boolean {
  try {
    if (options?.runner) {
      return options.runner().includes("--auto");
    }
    const bin = options?.binary ?? resolveOpenCodeBinary();
    const isWinCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const out = isWinCmd
      ? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${bin}" run --help`], {
          env: buildExtendedPathEnv(),
          encoding: "utf8",
          timeout: 8_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : execFileSync(bin, ["run", "--help"], {
          env: buildExtendedPathEnv(),
          encoding: "utf8",
          timeout: 8_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
    return out.includes("--auto");
  } catch {
    return false;
  }
}

export function ensureGlobalOpenCodeUnattendedConfig(
  home: string = homedir(),
): { ok: boolean; configPath: string; error?: string } {
  const configDir = join(home, ".config", "opencode");
  const configPath = join(configDir, "opencode.json");
  try {
    mkdirSync(configDir, { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    const unattendedPerm = (
      JSON.parse(UNATTENDED_OPENCODE_CONFIG) as { permission: Record<string, unknown> }
    ).permission;
    const prevPerm =
      existing.permission && typeof existing.permission === "object"
        ? (existing.permission as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = {
      $schema: existing.$schema ?? "https://opencode.ai/config.json",
      ...existing,
      permission: {
        ...prevPerm,
        ...unattendedPerm,
      },
    };
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return { ok: true, configPath };
  } catch (err) {
    return {
      ok: false,
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isSleepAssertionActive(): boolean {
  if (activeSleepRefCount > 0 && activeSleepChild && !activeSleepChild.killed) {
    return true;
  }
  return false;
}

export function acquireSleepAssertion(options?: {
  platform?: string;
  pid?: number;
  spawnProcess?: boolean;
}): SleepAssertionHandle {
  const platform = normalizePlatform(options?.platform ?? process.platform);
  const targetPid = options?.pid ?? process.pid;
  const shouldSpawn = options?.spawnProcess !== false;

  activeSleepRefCount += 1;

  if (shouldSpawn && !activeSleepChild) {
    try {
      if (platform === "darwin" && existsSync("/usr/bin/caffeinate")) {
        const child = spawn("/usr/bin/caffeinate", ["-dimsu", "-w", String(targetPid)], {
          stdio: "ignore",
          detached: false,
        });
        child.unref();
        activeSleepChild = child;
        activeSleepStrategy = "caffeinate";
      } else if (platform === "win32") {
        const psScript = [
          "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
          "$es = Add-Type -MemberDefinition $sig -Name 'Win32ExecState' -Namespace 'BurnLab' -PassThru",
          "[void]$es::SetThreadExecutionState(0x80000045)",
          `Wait-Process -Id ${targetPid} -ErrorAction SilentlyContinue`,
          "[void]$es::SetThreadExecutionState(0x80000000)",
        ].join("; ");
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
          {
            stdio: "ignore",
            windowsHide: true,
            detached: false,
          },
        );
        child.unref();
        activeSleepChild = child;
        activeSleepStrategy = "windows-execution-state";
      }
    } catch {
      activeSleepChild = null;
      activeSleepStrategy = "none";
    }
  }

  let released = false;
  return {
    active: activeSleepRefCount > 0,
    strategy: activeSleepStrategy,
    release: () => {
      if (released) return;
      released = true;
      activeSleepRefCount = Math.max(0, activeSleepRefCount - 1);
      if (activeSleepRefCount === 0 && activeSleepChild) {
        try {
          activeSleepChild.kill("SIGTERM");
        } catch {
          // ignore
        }
        activeSleepChild = null;
        activeSleepStrategy = "none";
      }
    },
  };
}

let cachedOpenCodeAutoReady: { value: boolean; at: number } | null = null;

export function checkUnattendedPreflight(options?: {
  projectRoot?: string;
  upstreamIssuesDir?: string;
  platform?: string;
  home?: string;
  tccDbPath?: string;
  macProcessDetector?: () => MacResponsibleProcessInfo;
  openCodeChecker?: () => boolean;
}): UnattendedPreflightState {
  const platform = normalizePlatform(options?.platform ?? process.platform);
  const home = options?.home ?? homedir();
  const projectRoot = options?.projectRoot;
  const projectInProtectedFolder = isPathInsideProtectedFolder(projectRoot, home, platform);
  const issues: string[] = [];

  let responsibleBundle = basename(process.execPath || "node");
  let fullDiskAccessGranted: boolean | null = null;
  let shipItStaleBinary = false;

  if (platform === "darwin") {
    const macInfo = options?.macProcessDetector
      ? options.macProcessDetector()
      : detectMacResponsibleProcess();
    responsibleBundle = macInfo.bundleId;
    shipItStaleBinary = macInfo.shipItStaleBinary;
    fullDiskAccessGranted = checkMacFullDiskAccessSilent({ tccDbPath: options?.tccDbPath });

    if (shipItStaleBinary) {
      issues.push(
        "Paseo.app was auto-updated in the background (ShipIt unlinked the running daemon binary). Restart Paseo / daemon before starting an unattended Burn run.",
      );
    }
    if (!fullDiskAccessGranted && projectInProtectedFolder) {
      issues.push(
        `Responsible bundle (${responsibleBundle}) does not have Full Disk Access while Project lives inside a macOS TCC-protected folder (${projectRoot}). Grant Full Disk Access to both Paseo.app and Paseo Helper.app or click "Warm Up Permissions" before leaving.`,
      );
    }
  } else if (platform === "win32") {
    responsibleBundle = process.execPath || "node.exe";
    fullDiskAccessGranted = !projectInProtectedFolder;
    if (projectInProtectedFolder) {
      issues.push(
        `Project resides inside a Windows Protected / OneDrive folder (${projectRoot}). Move the repository to %USERPROFILE%\\code or allow node.exe/opencode.exe in Windows Controlled Folder Access.`,
      );
    }
  }

  let projectRootAccessible = true;
  if (projectRoot) {
    // Only probe synchronously in passive check if NOT inside an ungranted macOS TCC folder
    // (or if warmup already ran recently), so passive UI snapshots never trigger TCC modals.
    const safeToProbePassively =
      platform !== "darwin" ||
      fullDiskAccessGranted === true ||
      !projectInProtectedFolder ||
      Date.now() - lastWarmupAtMs < 3_600_000;
    if (safeToProbePassively) {
      try {
        if (existsSync(projectRoot)) {
          readdirSync(projectRoot);
        }
      } catch {
        projectRootAccessible = false;
        issues.push(`Cannot read project root directory (${projectRoot}): permission denied.`);
      }
    }
  }

  const worktreeJunctionReady = checkWorktreeJunctionSupport(platform);
  if (!worktreeJunctionReady) {
    issues.push(
      platform === "win32"
        ? "Cannot create NTFS directory junctions for isolated worktrees."
        : "Cannot create directory symlinks in temporary worktree directory.",
    );
  }

  const nowMs = Date.now();
  let openCodeAutoReady: boolean;
  if (options?.openCodeChecker) {
    openCodeAutoReady = options.openCodeChecker();
  } else if (cachedOpenCodeAutoReady && nowMs - cachedOpenCodeAutoReady.at < 60_000) {
    openCodeAutoReady = cachedOpenCodeAutoReady.value;
  } else {
    openCodeAutoReady = checkOpenCodeAutoSupport();
    cachedOpenCodeAutoReady = { value: openCodeAutoReady, at: nowMs };
  }

  if (!openCodeAutoReady) {
    issues.push("OpenCode CLI binary was not found or does not support non-interactive --auto mode.");
  }

  const sleepAssertionActive = isSleepAssertionActive();
  const ready = !shipItStaleBinary && projectRootAccessible && worktreeJunctionReady;

  return {
    platform,
    ready,
    responsibleBundle,
    fullDiskAccessGranted,
    shipItStaleBinary,
    projectRootAccessible,
    projectInProtectedFolder,
    worktreeJunctionReady,
    openCodeAutoReady,
    sleepAssertionActive,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

async function probeLocalNetworkAndSocketBind(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(), 1_200);
    try {
      const udp = dgram.createSocket("udp4");
      udp.on("error", () => {
        try {
          udp.close();
        } catch {}
      });
      udp.send(Buffer.from([0]), 9, "192.168.1.1", () => {
        try {
          udp.close();
        } catch {}
        const srv = net.createServer();
        srv.on("error", () => {
          clearTimeout(timer);
          resolvePromise();
        });
        srv.listen(0, "127.0.0.1", () => {
          srv.close(() => {
            clearTimeout(timer);
            resolvePromise();
          });
        });
      });
    } catch {
      clearTimeout(timer);
      resolvePromise();
    }
  });
}

/**
 * Eagerly touches TCC/Controlled folders (`Documents`, `Desktop`, `Downloads`,
 * `projectRoot`, `.git`, `node_modules`), probes local network + loopback socket
 * bind, configures macOS `NSAppSleepDisabled`, and updates `~/.config/opencode/opencode.json`
 * so any OS permission modal appears immediately within the first 2 seconds while
 * the user is looking at the screen.
 */
export async function runUnattendedWarmup(options?: {
  projectRoot?: string;
  upstreamIssuesDir?: string;
  platform?: string;
  home?: string;
  skipNetworkProbe?: boolean;
  macProcessDetector?: () => MacResponsibleProcessInfo;
  openCodeChecker?: () => boolean;
}): Promise<UnattendedPreflightState> {
  const platform = normalizePlatform(options?.platform ?? process.platform);
  const home = options?.home ?? homedir();

  // 1. Ensure ~/.config/opencode/opencode.json has unattended permissions
  ensureGlobalOpenCodeUnattendedConfig(home);

  // 2. Disable macOS App Nap on both Paseo bundles
  if (platform === "darwin") {
    for (const domain of ["sh.paseo.desktop", "sh.paseo.desktop.helper"]) {
      try {
        execFileSync("defaults", ["write", domain, "NSAppSleepDisabled", "-bool", "YES"], {
          stdio: "ignore",
          timeout: 2_000,
        });
      } catch {
        // ignore
      }
    }
  }

  // 3. Eagerly touch protected folders & project paths so any TCC / Controlled Folder popup fires now
  const probeDirs = [
    join(home, "Documents"),
    join(home, "Desktop"),
    join(home, "Downloads"),
    options?.projectRoot,
    options?.projectRoot ? join(options.projectRoot, ".git") : undefined,
    options?.projectRoot ? join(options.projectRoot, "node_modules") : undefined,
    options?.upstreamIssuesDir,
  ].filter((d): d is string => Boolean(d));

  for (const dir of probeDirs) {
    try {
      if (existsSync(dir)) {
        readdirSync(dir);
      }
    } catch {
      // captured by checkUnattendedPreflight below
    }
  }

  // 4. Eagerly probe UDP LAN + TCP bind
  if (!options?.skipNetworkProbe) {
    await probeLocalNetworkAndSocketBind();
  }

  lastWarmupAtMs = Date.now();
  return checkUnattendedPreflight({
    projectRoot: options?.projectRoot,
    upstreamIssuesDir: options?.upstreamIssuesDir,
    platform,
    home,
    macProcessDetector: options?.macProcessDetector,
    openCodeChecker: options?.openCodeChecker,
  });
}

export function openOsPermissionSettings(options?: {
  platform?: string;
  runner?: (cmd: string, args: string[]) => void;
}): { ok: boolean; opened: string[]; error?: string } {
  const platform = normalizePlatform(options?.platform ?? process.platform);
  const opened: string[] = [];
  const execCmd =
    options?.runner ??
    ((cmd: string, args: string[]) => {
      execFileSync(cmd, args, { stdio: "ignore", timeout: 5_000, windowsHide: true });
    });

  try {
    if (platform === "darwin") {
      const fdaUrl =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
      execCmd("/usr/bin/open", [fdaUrl]);
      opened.push(fdaUrl);

      const helperApp =
        "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app";
      const mainApp = "/Applications/Paseo.app";
      if (existsSync(helperApp)) {
        execCmd("/usr/bin/open", ["-R", helperApp]);
        opened.push(helperApp);
      } else if (existsSync(mainApp)) {
        execCmd("/usr/bin/open", ["-R", mainApp]);
        opened.push(mainApp);
      }
      return { ok: true, opened };
    }

    if (platform === "win32") {
      const comSpec = process.env.ComSpec || "cmd.exe";
      execCmd(comSpec, ["/d", "/s", "/c", "start", "", "windowsdefender://ransomwareprotection"]);
      opened.push("windowsdefender://ransomwareprotection");
      execCmd(comSpec, ["/d", "/s", "/c", "control.exe", "/name", "Microsoft.WindowsFirewall"]);
      opened.push("Microsoft.WindowsFirewall");
      return { ok: true, opened };
    }

    return {
      ok: false,
      opened,
      error: `OS security settings shortcut is only supported on macOS and Windows (current: ${platform})`,
    };
  } catch (err) {
    return {
      ok: false,
      opened,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
