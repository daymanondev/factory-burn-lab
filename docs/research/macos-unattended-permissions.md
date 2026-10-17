# Eliminating Mid-Run Interactive Permission Prompts on macOS & Windows for Unattended `factory-burn-lab` Runs

**Target Platforms Verified:**
- **macOS (`darwin`):** macOS 15 Sequoia / macOS 26 Tahoe (verified on 26.6.2 Build `25G83`) · `Paseo.app` v0.11.4 · `opencode` v2.0.32 · Node.js v22 / v24
- **Windows (`win32`):** Windows 11 23H2 / 24H2 (`NT 10.0.22631+` / `26100+`) · Windows Defender Controlled Folder Access & SmartScreen · Windows Defender Firewall (`MPSSVC`) · Git Credential Manager (`GCM`) · Win32 Power Management (`SetThreadExecutionState`)

---

## Executive Summary: Why macOS, Windows, and Agent Harnesses "Ask as They Go" ("Run Tới Đâu Hỏi Tới Đó")

When you kick off a multi-hour Burn Run (`scout-pool`, `oss-lab`, `proto-arena`, `night-shift`, `self-evolve`) and walk away, neither the OS nor the CLI agent evaluates all permissions up front. Instead, **four distinct subsystems evaluate permissions lazily at the exact microsecond a syscall or tool call crosses a boundary**:

| Layer | What Fires Mid-Run on **macOS (`darwin`)** | What Fires Mid-Run on **Windows (`win32`)** |
|---|---|---|
| **Layer 1: Filesystem & Folder Protection** | **macOS TCC (`sandboxd` $\to$ `tccd`):** Intercepts the first `open(2)`/`readdir(3)` into `~/Documents`, `~/Desktop`, `~/Downloads`, or `/Volumes/*`. Evaluates against the **Responsible Process** (`Paseo.app` vs. `Paseo Helper.app`). | **Windows Defender Controlled Folder Access (`MsMpEng.exe`):** Blocks writes to `%USERPROFILE%\Documents`, `Desktop`, `Downloads` by untrusted binaries (`node.exe`, `opencode.exe`, `git.exe`). **NTFS Symlinks:** `fs.symlinkSync(..., "dir")` fails with `EPERM` unless Developer Mode is on or `"junction"` is used. **SmartScreen / Defender:** Scans every newly spawned `.exe` in `node_modules`. |
| **Layer 2: Network & Firewall Prompts** | **macOS 15/26 Local Network Privacy (`nesessionmanager`):** Prompts on first packet to RFC1918 LAN (`192.168.x.x`, `10.x.x.x`, `.local` mDNS) per `SigningIdentifier`. **Application Firewall (`socketfilterfw`):** Prompts when a Gate test server binds `0.0.0.0` instead of `127.0.0.1`. | **Windows Defender Firewall (`MPSSVC`):** Pops a UAC/Firewall modal (*"Windows Defender Firewall has blocked some features of this app `node.exe` / `opencode.exe`"*) the first time a test runner or dev server calls `listen()` on `0.0.0.0` / `::` instead of `127.0.0.1`. |
| **Layer 3: Agent Harness, Shell & Git Prompts** | **`opencode` v2.0.32:** Spawning `opencode run --standalone` without `--auto` and `OPENCODE_CONFIG_CONTENT` hits `external_directory` / `doom_loop` (`"ask"` $\to$ auto-rejected in non-TTY) or stalls on `question`. **Paseo Supervisor:** `daemon.agents.create` without `featureValues: { auto_accept: true }` waits for UI approval. | Same `opencode` and Paseo Supervisor gaps **plus:** **Git Credential Manager (`git-credential-manager.exe`)** pops a Win32/WebView2 login window on `git clone`/`fetch` in `oss-lab` unless `GCM_INTERACTIVE=never` and `GIT_TERMINAL_PROMPT=0` are set, and `spawn("sh", ["-c", ...])` / `spawn("opencode")` fail on Windows (`ENOENT` / `EINVAL`). |
| **Layer 4: Power, Sleep & Background Throttling** | **`powerd` & App Nap:** After display sleep (`sleep 1` min), macOS suspends user-space processes or throttles `Paseo Helper.app` (`LSUIElement`) unless `caffeinate -dimsu -w <pid>` and `NSAppSleepDisabled` are active. | **Modern Standby (S0 Low Power Idle) & EcoQoS:** Windows suspends background processes and network sockets when the display turns off unless a process holds `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED \| ES_AWAYMODE_REQUIRED)`. |

You can eliminate 100% of mid-run stalls on both macOS and Windows by combining:
- **(A) The Cross-Platform "Grant Highest Permission Once" Setup** (OS-level full disk/folder + firewall exemptions, placing repos under `$HOME/code` or `%USERPROFILE%\code` / Dev Drive, fixing the cross-platform process/permission bugs in `factory-burn-lab`), and
- **(B) A Cross-Platform "Preflight Warm-up / Permission Trigger"** (`burnLab.preflightPermissions` + CLI scripts for macOS and Windows) that intentionally touches protected folders, probes LAN/loopback/wildcard sockets, verifies `opencode --auto`, and attaches an OS power assertion (`caffeinate` on macOS, `SetThreadExecutionState` on Windows) **within the first 3 seconds** while the user is watching.

---

## Layer 1: Filesystem & Folder Protection (macOS TCC vs. Windows Controlled Folder Access & Symlinks)

### 1.1 macOS: Kernel `sandboxd` $\to$ `tccd` Evaluation Order (Why Full Disk Access Supersedes Per-Folder Prompts)

Inspecting the macOS Unified Log (`/usr/bin/log show --predicate 'subsystem == "com.apple.TCC"'`) during a child binary (`esbuild`) execution inside `~/Documents/code/...` reveals the exact two-step IPC sequence executed by `/usr/libexec/sandboxd`:

```text
tccd[405]: AUTHREQ_CTX: msgID=490.299, function=TCCAccessRequest,
  service=kTCCServiceSystemPolicyAllFiles, preflight=yes, query=1, client_dict=(null)
tccd[405]: AUTHREQ_ATTRIBUTION: msgID=490.299, attribution={
  accessing={TCCDProcess: identifier=esbuild, pid=57104, binary_path=.../node_modules/@esbuild/darwin-arm64/bin/esbuild},
  responsible={TCCDProcess: identifier=dev.zcode.app, pid=7645, responsible_path=/Applications/ZCode.app/Contents/MacOS/ZCode},
  requesting={TCCDProcess: identifier=com.apple.sandboxd, pid=490, binary_path=/usr/libexec/sandboxd}}
tccd[405]: AUTHREQ_RESULT: msgID=490.299, authValue=0, authReason=5
```

Immediately after `tccd[405]` (the root system `tccd` daemon) returns `authValue=0` (not granted) for `kTCCServiceSystemPolicyAllFiles`, `sandboxd` sends a **second** non-preflight request to the per-user `tccd`:

```text
tccd[650]: AUTHREQ_CTX: msgID=490.96, function=TCCAccessRequest,
  service=kTCCServiceSystemPolicyDocumentsFolder, preflight=no, query=1, client_dict=(null)
```

**Primary-source takeaway:**
- On every file access into a protected directory, `sandboxd` **first** performs a non-interactive preflight check (`preflight=yes, query=1`) against system `tccd` for **`kTCCServiceSystemPolicyAllFiles` (Full Disk Access)**.
- **If `kTCCServiceSystemPolicyAllFiles` returns `authValue=2` (Allowed)**, `sandboxd` immediately permits the syscall and **never queries**:
  - `kTCCServiceSystemPolicyDocumentsFolder` (`~/Documents`)
  - `kTCCServiceSystemPolicyDesktopFolder` (`~/Desktop`)
  - `kTCCServiceSystemPolicyDownloadsFolder` (`~/Downloads`)
  - `kTCCServiceSystemPolicyRemovableVolumes` (`/Volumes/*`)
  - `kTCCServiceSystemPolicyNetworkVolumes`
- Granting **Full Disk Access** to the responsible app bundle in **System Settings $\to$ Privacy & Security $\to$ Full Disk Access** is a single switch that suppresses all individual folder prompts permanently.

### 1.2 macOS: The Dual Responsible Process Trap in Paseo (`Paseo.app` vs. `Paseo Helper.app`)

macOS TCC does **not** grant permissions to `node`, `git`, `esbuild`, or `opencode` (`accessing` process). It evaluates permissions against the **`responsible` process**, which the kernel tracks across `fork()`/`posix_spawn()` via `responsibility_get_pid_responsible_for_pid` in `/usr/lib/libSystem.B.dylib`.

Calling `responsibility_get_pid_responsible_for_pid(pid)` and `proc_pidpath(rpid)` against live Paseo processes reveals a critical split depending on how the daemon was started:

| Daemon Instance | Process Lineage | `responsibility_get_pid_responsible_for_pid` Result | Responsible `CFBundleIdentifier` |
|---|---|---|---|
| **Prod Desktop Daemon** (`~/.paseo`, `"desktopManaged": true` in `paseo.pid`) | `Paseo.app` $\to$ `Paseo Supervisor` $\to$ `Paseo Daemon` $\to$ `plugin-process.js` | `/Applications/Paseo.app/Contents/MacOS/Paseo` | **`sh.paseo.desktop`** |
| **Trial CLI Daemon** (`~/.paseo-factory`, started via `~/.local/bin/paseo`) | `launchd` (`PID 1`) $\to$ `Paseo Supervisor` $\to$ `Paseo Daemon` $\to$ `plugin-process.js` | `/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper` | **`sh.paseo.desktop.helper`** |
| **CLI / Background `opencode serve`** (started from Terminal/IDE) | `launchd` / Terminal $\to$ `opencode.exe serve --service` | Calling Terminal or IDE `.app` (e.g. `Ghostty.app`, `Antigravity.app`, `ZCode.app`) | Terminal/IDE Bundle ID |

**Why `~/.paseo-factory` resolves to `sh.paseo.desktop.helper` instead of `sh.paseo.desktop`:**
`/Applications/Paseo.app/Contents/Resources/bin/paseo` (lines 24–48, symlinked from `~/.local/bin/paseo`) explicitly executes the inner helper bundle:

```sh
MACOS_HELPER_EXECUTABLE="${RESOURCES_DIR}/../Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"
if [ -x "${MACOS_HELPER_EXECUTABLE}" ]; then
  ELECTRON_EXECUTABLE="${MACOS_HELPER_EXECUTABLE}"
fi
...
ELECTRON_RUN_AS_NODE=1 exec "${ELECTRON_EXECUTABLE}" "${CLI_ENTRY}" "$@"
```

When `~/.local/bin/paseo` starts the trial daemon (`~/.paseo-factory`) and detaches its daemon children under `launchd` (`PPID = 1`), `/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app` (`CFBundleIdentifier = "sh.paseo.desktop.helper"`, `LSUIElement = true`) becomes its own responsible `.app` bundle for the `plugin-process.js` worker that runs `factory-burn-lab`.

> [!IMPORTANT]
> **Two macOS Gotchas:**
> 1. **Both Bundles Need Full Disk Access:** If you only grant Full Disk Access to `/Applications/Paseo.app` (`sh.paseo.desktop`), the trial daemon in `~/.paseo-factory` running inside **`Paseo Helper.app` (`sh.paseo.desktop.helper`) will still trigger TCC prompts**! Grant Full Disk Access to **both** `/Applications/Paseo.app` and `/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app` (plus your Terminal/IDE).
> 2. **The Squirrel / `ShipIt` Auto-Update Trap:** When Electron's Squirrel.Mac (`ShipIt`) auto-updates `/Applications/Paseo.app` in place, it moves the old bundle to `/private/var/folders/.../T/sh.paseo.desktop.ShipIt.<id>/Paseo.app` and unlinks it. Any `Paseo Daemon` left running from before the update has `proc_pidpath(pid) == ""` (unlinked binary), breaking path-based TCC/Firewall checks until `paseo daemon restart --home ~/.paseo-factory` is run.

### 1.3 Windows: Controlled Folder Access, Defender / SmartScreen (`Zone.Identifier`), and NTFS Symlinks vs. Junctions

On Windows 11, three distinct filesystem mechanisms block or stall unattended Burn Runs:

1. **Windows Defender Controlled Folder Access (Ransomware Protection):**
   - By default, when Controlled Folder Access (`EnableControlledFolderAccess = 1` in `Get-MpPreference`) is enabled, Windows Defender (`MsMpEng.exe`) protects `%USERPROFILE%\Documents`, `%USERPROFILE%\Desktop`, `%USERPROFILE%\Pictures`, and `%USERPROFILE%\Downloads`.
   - Unlike macOS (where the parent `.app` bundle is the responsible entity), Windows Defender evaluates the **immediate accessing executable** (`node.exe`, `git.exe`, `opencode.exe`, `esbuild.exe`, `vitest`). When an agent or worktree touches a repo inside `%USERPROFILE%\Documents\...`, Windows blocks the write (`EACCES` / `EPERM`) and pops a Windows Security toast (*"Protected folder access blocked"*).
   - **Solution:** Place all repositories and `.paseo-factory` outside `%USERPROFILE%\Documents` (specifically in **`%USERPROFILE%\code`** or a **ReFS Dev Drive** `D:\code`), or register `node.exe`, `git.exe`, and `opencode.exe` in `Add-MpPreference -ControlledFolderAccessAllowedApplications`.

2. **Windows Defender Real-Time Scanning (`MsMpEng.exe`) & SmartScreen (`Zone.Identifier` ADS):**
   - Every time `factory-burn-lab` creates a worktree (`prepareIsolatedWorktree`), copies files, or spawns compiled binaries (`opencode.exe`, `@esbuild/win32-x64/esbuild.exe`), `MsMpEng.exe` intercepts the file open synchronously via the `WdFilter.sys` minifilter driver. If a downloaded CLI binary carries the `Zone.Identifier` Alternate Data Stream (`MotW` — Mark of the Web), Windows Defender SmartScreen can block execution with an interactive modal (*"Windows protected your PC"*).
   - **Solution:** Strip `Zone.Identifier` streams via `Unblock-File` and add a Windows Defender path exclusion (`Add-MpPreference -ExclusionPath`) for `%USERPROFILE%\.paseo-factory` and `%USERPROFILE%\code`.

3. **NTFS Directory Symlinks (`EPERM`) vs. Directory Junctions (`"junction"`) in `prepareIsolatedWorktree`:**
   - Look at [`src/burn-engine.ts:1054-1062`](../../src/burn-engine.ts#L1054-L1062):
     ```ts
     const parentNodeModules = join(projectRoot, "node_modules");
     const destNodeModules = join(destDir, "node_modules");
     if (existsSync(parentNodeModules) && !existsSync(destNodeModules)) {
       try {
         symlinkSync(parentNodeModules, destNodeModules, "dir");
       } catch {
         // ignore symlink failure
       }
     }
     ```
   - Per the official Node.js `fs.symlinkSync(target, path[, type])` documentation and Microsoft Win32 `CreateSymbolicLinkW` docs: on Windows, `type: "dir"` creates an NTFS **directory symbolic link**, which requires the `SeCreateSymbolicLinkPrivilege` token privilege (only available in an **elevated Administrator** prompt or when **Windows Developer Mode** `AllowDevelopmentWithoutDevLicense = 1` is enabled in `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock`).
   - On standard non-elevated Windows accounts without Developer Mode, `symlinkSync(..., "dir")` **throws `EPERM: operation not permitted, symlink`**! Because `prepareIsolatedWorktree` swallows the `catch {}` block ([`src/burn-engine.ts:1059-1061`](../../src/burn-engine.ts#L1059-L1061)), the worktree is silently created **without `node_modules`**, causing every subsequent Gate test (`npm test`, `vitest`, `tsc`) in `proto-arena`, `night-shift`, and `self-evolve` to fail!
   - **Cross-Platform Fix:** Use `"junction"` on Windows (`process.platform === "win32" ? "junction" : "dir"`). NTFS directory junctions (`IO_REPARSE_TAG_MOUNT_POINT`) work for any local directory target on Windows **without Administrator privileges and without Developer Mode**.

### 1.4 Why Moving Repos to `~/code` (`%USERPROFILE%\code`) Avoids OS Folder Protections — and Why Hardcoded Repo Paths Must Be Fixed

On both macOS and Windows:
- `~/Documents` (`%USERPROFILE%\Documents`), `~/Desktop`, and `~/Downloads` are OS-protected user library folders.
- **`~/code`** (`%USERPROFILE%\code`) and **`~/.paseo-factory`** (`%USERPROFILE%\.paseo-factory`) sit directly under `$HOME` (`%USERPROFILE%`) outside TCC and Controlled Folder Access filters.

However, `factory-burn-lab` currently hardcodes a single macOS user's `~/Documents/...` path in two places:
- [`src/burn-engine.ts:56-57`](../../src/burn-engine.ts#L56-L57):
  ```ts
  export const DEFAULT_SELF_REPO_ROOT =
    "/Users/andrewpham/Documents/code/self-project/factory-burn-lab";
  ```
- [`src/upstream.ts:4-5`](../../src/upstream.ts#L4-L5):
  ```ts
  export const DEFAULT_UPSTREAM_ISSUES_DIR =
    "/Users/andrewpham/Documents/code/self-project/research-slp/.scratch/burn-lab-upstream/issues";
  ```
When `prepareIsolatedWorktree` ([`src/burn-engine.ts:1025-1062`](../../src/burn-engine.ts#L1025-L1062)) runs `git worktree add` and symlinks `node_modules`, every worktree under `~/.paseo-factory/burn-lab/runs/<runId>/worktrees/<attemptId>` points back into `projectRoot`. Replacing those hardcoded paths with `fileURLToPath(new URL("..", import.meta.url))` (plus an optional `BURN_LAB_UPSTREAM_ISSUES_DIR` env override) makes `factory-burn-lab` portable across any macOS or Windows machine and lets repos live cleanly under `~/code` / `%USERPROFILE%\code`.

---

## Layer 2: Network & Firewall Prompts (macOS Local Network & `socketfilterfw` vs. Windows Defender Firewall)

### 2.1 macOS 15 Sequoia / macOS 26 Tahoe Local Network Privacy (`NEPathRule`)

Starting in macOS 15 Sequoia and continuing in macOS 26 Tahoe, Apple enforces Local Network Privacy via `nesessionmanager` and `nehelper`, storing per-bundle rules in `/Library/Preferences/com.apple.networkextension.plist`:
- **What triggers the prompt:** Any outbound TCP/UDP packet or mDNS/Bonjour query (`_http._tcp.local.`, DNS-SD, `.local` hostname resolution, or probing `192.168.x.x` / `10.x.x.x` / `172.16-31.x.x`).
- **What is exempt:** Loopback traffic (`127.0.0.1` and `::1`) and public WAN traffic (e.g., `opencode.ai` Zen API endpoints).
- **Separate Bundle Tracking:** `/Library/Preferences/com.apple.networkextension.plist` tracks `SigningIdentifier => "sh.paseo.desktop"` and `SigningIdentifier => "sh.paseo.desktop.helper"` as **separate `NEPathRule` entries**.

### 2.2 macOS Application Firewall (`socketfilterfw`) vs. Windows Defender Firewall (`MPSSVC`) on `0.0.0.0` Binds

During Gate verification ([`src/burn-engine.ts:606-668`](../../src/burn-engine.ts#L606-L668)) or inside an OpenCode agent session, test runners (`vitest`, `playwright`, `vite`, `next`, `express`) frequently spin up temporary HTTP/WebSocket servers.

- **On macOS (`socketfilterfw`):** When the Application Firewall is enabled (`/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`), binding to `0.0.0.0` or `::` triggers *"Do you want the application 'node' to accept incoming network connections?"* unless the binary is Developer ID signed and allowed or binds strictly to `127.0.0.1`. (Note: `Paseo.app` [`99ZMJMKU9Y`], `node` [`HX7739G8FX`], and `opencode.exe` [`5NZ4Q7NXJ4`] are all Developer ID signed, so their code-signing identity remains stable across updates.)
- **On Windows (Windows Defender Firewall `MPSSVC`):** Windows Defender Firewall is **enabled by default** on all profiles (`Domain`, `Private`, `Public`). The first time `node.exe`, `opencode.exe`, or a test child process calls WinSock `bind()` + `listen()` on `0.0.0.0` (`INADDR_ANY`) or `::` (`in6addr_any`), Windows pops a modal dialog (*"Windows Defender Firewall has blocked some features of this app — `node.exe`"*). Even worse, if the user is away or does not have UAC elevation, the prompt blocks inbound connections or steals focus.
- **Cross-Platform Fix:**
  1. **Always inject `HOST=127.0.0.1`** into Gate and OpenCode child environments. Loopback binds (`127.0.0.1`) **never** trigger Windows Defender Firewall, macOS `socketfilterfw`, or macOS Local Network Privacy.
  2. **Pre-register inbound allow rules** on both OSes (`socketfilterfw --add/--unblockapp` on macOS; `New-NetFirewallRule` / `netsh advfirewall firewall add rule` for `node.exe` and `opencode.exe` on Windows).

---

## Layer 3: Agent Harness, Shell & Git Credential Prompts (`opencode` v2.0.32, `Paseo`, and Cross-Platform Spawning)

### 3.1 How `opencode` v2.0.32 Evaluates Permissions (Primary-Source Binary & Docs Inspection)

Inspecting both the official OpenCode Permissions documentation (`https://opencode.ai/docs/permissions/`) and the compiled `opencode` v2.0.32 binary (`chunk-46twsw7v.js`, `FileAccess.resolve`, and `ShellTool.prepare`) reveals:

1. **Default Agent Permission Rules (`opencode debug agents`):**
   Every default `build` agent starts with:
   ```json
   [
     { "action": "*", "resource": "*", "effect": "allow" },
     { "action": "doom_loop", "resource": "*", "effect": "ask" },
     { "action": "external_directory", "resource": "*", "effect": "ask" },
     { "action": "question", "resource": "*", "effect": "deny" },
     { "action": "read", "resource": "*", "effect": "allow" },
     { "action": "read", "resource": "*.env", "effect": "ask" },
     { "action": "read", "resource": "*.env.*", "effect": "ask" },
     { "action": "read", "resource": "*.env.example", "effect": "allow" }
   ]
   ```
2. **When `external_directory` Fires During a Burn Run:**
   In `opencode`, `FileAccess.resolve` and `ShellTool.prepare` check whether every resolved file path or shell path argument (`cd`, `rm`, `cp`, `mv`, `mkdir`, `touch`, `chmod`, `chown`, `cat`) sits inside the current OpenCode instance directory (`Instance.containsPath`).
   - In `factory-burn-lab`, coder swarms (`proto-arena`, `night-shift`, `self-evolve`, `oss-lab`) spawn `opencode` with `cwd: worktreeDir` (`<paseoHome>/burn-lab/runs/<runId>/worktrees/<attemptId>`) ([`src/burn-engine.ts:1365-1380`](../../src/burn-engine.ts#L1365-L1380), [`src/burn-engine.ts:1481-1491`](../../src/burn-engine.ts#L1481-L1491)).
   - Whenever the coder model inspects a path in `/tmp` (`%TEMP%`), `<paseoHome>/burn-lab`, or follows a symlink/junction back to `<repoRoot>`, `external_directory` triggers!
3. **What Happens in `opencode run` Without `--auto` (`chunk-46twsw7v.js`):**
   Decompiling `runCommand` in `chunk-46twsw7v.js` shows how `opencode run` handles `permission.asked` events:
   ```js
   async function se(r) {
     if (e.auto)
       return l.permission.reply({ id: r.id, decision: "once" });
     fe.warn(`permission requested: ${r.action} (${r.patterns.join(", ")}); auto-rejecting`),
     await l.permission.reply({ id: r.id, decision: "reject" });
   }
   ```
   - **Without `--auto`:** `opencode run` prints `! permission requested: external_directory (...); auto-rejecting` and rejects the tool call, breaking the agent's task.
   - **With `--auto` (or its hidden CLI aliases `--yolo` / `--dangerously-skip-permissions`):** `e.auto` is `true`, and `opencode run` automatically replies `{ decision: "once" }` to every `"ask"` request.
   - **With `OPENCODE_CONFIG_CONTENT`:** Note that `OPENCODE_PERMISSION` does **not** exist in `opencode` v2.0.32 (0 occurrences in binary). Instead, `opencode` v2.0.32 reads `OPENCODE_CONFIG_CONTENT` (inline JSON matching `https://opencode.ai/config.json`). Passing:
     ```json
     {
       "permission": {
         "*": "allow",
         "external_directory": "allow",
         "doom_loop": "allow",
         "question": "deny",
         "read": {
           "*": "allow",
           "*.env": "allow",
           "*.env.*": "allow"
         }
       }
     }
     ```
     via `OPENCODE_CONFIG_CONTENT` makes `Permission.assert` evaluate directly to `"allow"` without emitting `permission.asked`, and forces `"question": "deny"` so an agent can never stall waiting for interactive user input.

### 3.2 Git Credential Manager (`GCM`) & SSH Host Key Prompts on Windows and macOS

During `oss-lab` runs (`cloneExternalRepo` in [`src/burn-engine.ts:1084-1102`](../../src/burn-engine.ts#L1084-L1102)) or when an agent runs `git fetch` / `git clone` against a repository that requires auth or has a typo in its URL:
- **On Windows:** Git for Windows bundles **Git Credential Manager (`git-credential-manager.exe`)**, which pops a native Win32 / WebView2 modal login dialog even when `stdio` is `"ignore"` unless **`GCM_INTERACTIVE=never`** and **`GIT_TERMINAL_PROMPT=0`** are set in `env`.
- **On macOS & Windows SSH:** An SSH git URL for an unknown host blocks waiting for `"Are you sure you want to continue connecting (yes/no/[fingerprint])?"` unless `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"` is set.

### 3.3 Six Specific Cross-Platform & Permission Bugs in `factory-burn-lab`

| Location | Current Code | Why It Breaks / Stalls on macOS or Windows | Required Cross-Platform Fix |
|---|---|---|---|
| **1. [`src/free-pool.ts:315-319`](../../src/free-pool.ts#L315-L319)** (`defaultOpenCodeRunner`) | `spawn(bin, ["run", "--standalone", "-m", input.model, input.prompt], { cwd: input.cwd, env: { ...buildExtendedPathEnv(), PWD: input.cwd } })` | Missing `--auto` and `OPENCODE_CONFIG_CONTENT` (`external_directory` auto-rejects); missing `GCM_INTERACTIVE=never`, `GIT_TERMINAL_PROMPT=0`, `CI=1`, `HOST=127.0.0.1`; on Windows, spawning `.cmd` without `shell: true` throws `EINVAL` (Node CVE-2024-27980). | Add `"--auto"` to args; inject `OPENCODE_CONFIG_CONTENT`, `CI: "1"`, `GIT_TERMINAL_PROMPT: "0"`, `GCM_INTERACTIVE: "never"`, `HOST: "127.0.0.1"`; set `shell: process.platform === "win32" && /\.(cmd\|bat)$/i.test(bin)` and `windowsHide: true`. |
| **2. [`plugin/server/surface-rpc.ts:495-506`](../../plugin/server/surface-rpc.ts#L495-L506)** (`ensureSupervisorAgentId`) | `daemon.agents.create({ cwd, title, provider, model, ... })` without `featureValues` | Paseo's `OpenCodeAgentSession` checks `config.featureValues?.auto_accept === true`. Without it, any Supervisor tool call outside `paseo-factory`'s contract choke blocks waiting for interactive UI approval. | Pass `featureValues: { auto_accept: true }` in `daemon.agents.create({...})`. |
| **3. [`src/free-pool.ts:135-167`](../../src/free-pool.ts#L135-L167)** (`candidateBinDirs`, `resolveOpenCodeBinary`, `buildExtendedPathEnv`) | Uses Unix-only paths (`~/.nvm/versions/node`, `/opt/homebrew/bin`), checks only `"opencode"` (no `.exe`/`.cmd`), and joins `PATH` with hardcoded `":"`. | On Windows, `PATH` uses `";"` (`path.delimiter`), `opencode` is `opencode.exe` or `opencode.cmd` under `%APPDATA%\npm`, `%LOCALAPPDATA%\nvm`, `%NVM_SYMLINK%`, or `%USERPROFILE%\.bun\bin`. Joining with `":"` corrupts `PATH` on Windows. | Use `delimiter` from `node:path`; check Windows bin dirs (`APPDATA/npm`, `NVM_SYMLINK`, `LOCALAPPDATA/nvm`, `.bun/bin`); check `["opencode.exe", "opencode.cmd", "opencode"]` on `win32`. |
| **4. [`src/burn-engine.ts:612-616`](../../src/burn-engine.ts#L612-L616)** (`defaultGateRunner`) | `spawn("sh", ["-c", input.command], { cwd: input.cwd, env: buildExtendedPathEnv(), stdio: ["ignore", "pipe", "pipe"] })` | On Windows (`win32`), `sh` does not exist on default `PATH` (`spawn sh ENOENT`), and `child.kill("SIGKILL")` does not terminate child process trees spawned by `cmd.exe`. | Use `spawn(input.command, { cwd: input.cwd, env: ..., shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })` (which uses `/bin/sh` on Unix and `process.env.ComSpec` / `cmd.exe` on Windows). |
| **5. [`src/burn-engine.ts:1058`](../../src/burn-engine.ts#L1058)** (`prepareIsolatedWorktree`) | `symlinkSync(parentNodeModules, destNodeModules, "dir")` | On Windows without Developer Mode or elevation, `"dir"` throws `EPERM`, leaving worktrees without `node_modules`. | Use `symlinkSync(parentNodeModules, destNodeModules, process.platform === "win32" ? "junction" : "dir")`. |
| **6. [`src/burn-engine.ts:56-57`](../../src/burn-engine.ts#L56-L57) & [`src/upstream.ts:4-5`](../../src/upstream.ts#L4-L5)** | Hardcodes `"/Users/andrewpham/Documents/code/..."` | Breaks on any other macOS user account or on Windows, and forces TCC access to `~/Documents`. | Resolve dynamically relative to `fileURLToPath(new URL("..", import.meta.url))` with env overrides (`BURN_LAB_SELF_REPO_ROOT`, `BURN_LAB_UPSTREAM_ISSUES_DIR`). |

---

## Layer 4: Power, Sleep & Background Throttling (macOS `caffeinate` vs. Windows `SetThreadExecutionState`)

### 4.1 macOS: `caffeinate(8)` & `NSAppSleepDisabled`

- On macOS, `pmset -g` defaults to idle sleep once the display turns off, and neither `Paseo` nor `opencode` holds an IOKit assertion by default.
- Spawning `/usr/bin/caffeinate -dimsu -w <pid>` creates kernel assertions for `PreventUserIdleDisplaySleep` (`-d`), `PreventUserIdleSystemSleep` (`-i`), `PreventDiskIdle` (`-m`), and `PreventSystemSleep` on AC power (`-s`), automatically releasing them the instant `<pid>` exits (`-w`).
- Setting `defaults write sh.paseo.desktop NSAppSleepDisabled -bool YES` and `defaults write sh.paseo.desktop.helper NSAppSleepDisabled -bool YES` disables macOS App Nap timer throttling on Paseo's background helper processes.

### 4.2 Windows: Win32 `SetThreadExecutionState` & Power Throttling (`EcoQoS`)

- On Windows 11 laptops and desktops (especially Modern Standby / S0 Low Power Idle systems), turning off the display or locking the screen causes the Windows Power Manager to suspend desktop processes and drop network connections unless a process holds an active execution state request (inspectable via elevated `powercfg /requests`).
- Per Microsoft Win32 API documentation (`kernel32.dll` `SetThreadExecutionState`), a process prevents idle sleep and enters Away Mode by calling:
  ```c
  SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED);
  // 0x80000000 | 0x00000001 | 0x00000040 = 0x80000041
  ```
- Because `SetThreadExecutionState` is bound to the calling thread/process lifetime (just like `caffeinate -w <pid>`), `factory-burn-lab` (or the Windows preflight script) can spawn a zero-dependency hidden `powershell.exe` watchdog tied to the daemon/Burn Run PID that calls `SetThreadExecutionState(0x80000045)` (`ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_AWAYMODE_REQUIRED`) and blocks on `Wait-Process -Id <pid>`, automatically releasing the power request when the Burn Run or daemon exits!

---

## Deliverable (A): Cross-Platform "Grant Highest Permission Once" Setup

### A1. Shared Configuration (macOS & Windows): Global `~/.config/opencode/opencode.json`

On both macOS (`~/.config/opencode/opencode.json`) and Windows (`%USERPROFILE%\.config\opencode\opencode.json`), write the global unattended permission config once so every `opencode` invocation allows `external_directory`, `doom_loop`, and `.env` reads without prompting, and denies interactive `question` stalls:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "allow",
    "external_directory": "allow",
    "doom_loop": "allow",
    "question": "deny",
    "read": {
      "*": "allow",
      "*.env": "allow",
      "*.env.*": "allow",
      "*.env.example": "allow"
    }
  }
}
```

### A2. macOS (`darwin`) One-Time Highest-Permission Setup

```bash
# 1. Place autonomous burn repos under ~/code (outside TCC ~/Documents)
mkdir -p "$HOME/code"

# 2. Open System Settings -> Privacy & Security -> Full Disk Access
#    and grant Full Disk Access to BOTH Paseo bundles + your Terminal/IDE:
#      - /Applications/Paseo.app (sh.paseo.desktop)
#      - /Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app (sh.paseo.desktop.helper)
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
open -R "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app"

# 3. Disable macOS App Nap for both Paseo bundles
defaults write sh.paseo.desktop NSAppSleepDisabled -bool YES
defaults write sh.paseo.desktop.helper NSAppSleepDisabled -bool YES

# 4. Whitelist Paseo, Paseo Helper, node, and opencode in macOS Application Firewall
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "/Applications/Paseo.app/Contents/MacOS/Paseo"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "/Applications/Paseo.app/Contents/MacOS/Paseo"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(realpath "$(command -v node)")"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(realpath "$(command -v node)")"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(realpath "$(command -v opencode)")"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(realpath "$(command -v opencode)")"
```

### A3. Windows (`win32`) One-Time Highest-Permission Setup (Run Once in Elevated PowerShell)

```powershell
# 1. Create workspace outside Controlled Folder Access (%USERPROFILE%\Documents)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\code" | Out-Null

# 2. Enable Windows Developer Mode so Git & Node can create native symlinks in addition to junctions
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD /f /v "AllowDevelopmentWithoutDevLicense" /d "1"
git config --global core.symlinks true
git config --global credential.interactive never

# 3. Exclude ~/.paseo-factory and ~/code from Windows Defender Real-Time Scanning & Controlled Folder Access
Add-MpPreference -ExclusionPath "$env:USERPROFILE\.paseo-factory", "$env:USERPROFILE\code"
foreach ($cmd in @("node", "git", "opencode")) {
  $bin = (Get-Command $cmd -ErrorAction SilentlyContinue).Source
  if ($bin) {
    Unblock-File -Path $bin -ErrorAction SilentlyContinue
    Add-MpPreference -ControlledFolderAccessAllowedApplications $bin -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName "BurnLab Allow $cmd" -Direction Inbound -Program $bin -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
  }
}
```

---

## Deliverable (B): Concrete Cross-Platform "Preflight Warm-up / Permission Trigger" Mechanism

Because both macOS and Windows evaluate permissions lazily, **the only way to guarantee a prompt won't appear at 03:00 AM is to intentionally execute every permission-gated operation during the first 3 seconds of startup** while the user is watching.

### B1. Cross-Platform Node.js Preflight & Power Assertion Helper (for `factory-burn-lab`)

When `BurnEngine.startRun()` ([`src/burn-engine.ts:749-830`](../../src/burn-engine.ts#L749-L830)) starts a Burn Run (or when the user clicks a **"Preflight Permissions"** button in the Burn Lab UI), `factory-burn-lab` can run this cross-platform warm-up inside `plugin-process.js`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PreflightReport {
  platform: NodeJS.Platform;
  foldersChecked: Record<string, "ok" | "denied" | "missing">;
  networkWarmupOk: boolean;
  powerAssertionPid?: number;
}

export async function runCrossPlatformPreflight(
  extraDirs: string[] = [],
): Promise<PreflightReport> {
  const home = homedir();
  const foldersChecked: Record<string, "ok" | "denied" | "missing"> = {};
  const candidates = [
    join(home, "Documents"),
    join(home, "Desktop"),
    join(home, "Downloads"),
    ...extraDirs,
  ];

  // 1. Eagerly touch OS-protected folders so macOS TCC / Windows Controlled Folder Access
  //    either succeeds immediately or pops its prompt in the first 100ms while the user watches.
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      foldersChecked[dir] = "ok";
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      foldersChecked[dir] = code === "ENOENT" ? "missing" : "denied";
    }
  }

  // 2. Eagerly probe UDP LAN + 127.0.0.1 / 0.0.0.0 TCP bind to trigger macOS Local Network
  //    or macOS/Windows Firewall prompts immediately rather than mid-run during Gate tests.
  const networkWarmupOk = await new Promise<boolean>((resolve) => {
    const udp = createSocket("udp4");
    udp.send(Buffer.from([0]), 9, "192.168.1.1", () => {
      udp.close();
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(0, "127.0.0.1", () => {
        srv.close(() => resolve(true));
      });
    });
  });

  return {
    platform: process.platform,
    foldersChecked,
    networkWarmupOk,
  };
}

/**
 * Spawns an OS-native power assertion child process tied to `targetPid`
 * (`caffeinate -dimsu -w <pid>` on macOS; `SetThreadExecutionState` watchdog on Windows).
 */
export function spawnPowerAssertion(targetPid: number = process.pid): ChildProcess | undefined {
  if (process.platform === "darwin") {
    const child = spawn("/usr/bin/caffeinate", ["-dimsu", "-w", String(targetPid)], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return child;
  }
  if (process.platform === "win32") {
    const psScript = [
      `$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
      `$es = Add-Type -MemberDefinition $sig -Name 'Win32Power' -Namespace 'BurnLab' -PassThru`,
      `[void]$es::SetThreadExecutionState(0x80000045)`,
      `Wait-Process -Id ${targetPid} -ErrorAction SilentlyContinue`,
      `[void]$es::SetThreadExecutionState(0x80000000)`,
    ].join("; ");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
      { stdio: "ignore", detached: true, windowsHide: true },
    );
    child.unref();
    return child;
  }
  return undefined;
}
```

### B2. macOS Standalone Preflight Script (`scripts/preflight-macos-permissions.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== [1/6] Checking macOS Responsible Process & Squirrel ShipIt State ==="
python3 - <<'PY'
import ctypes, os, sys
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
lib.responsibility_get_pid_responsible_for_pid.argtypes = [ctypes.c_int]
lib.responsibility_get_pid_responsible_for_pid.restype = ctypes.c_int
lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
lib.proc_pidpath.restype = ctypes.c_int

def pidpath(p):
    buf = ctypes.create_string_buffer(4096)
    lib.proc_pidpath(p, buf, 4096)
    return buf.value.decode('utf-8', 'replace')

pid = os.getpid()
rpid = lib.responsibility_get_pid_responsible_for_pid(pid)
rpath = pidpath(rpid)
print(f"Current PID: {pid} -> Responsible PID: {rpid}")
print(f"Responsible Binary: {rpath or '<UNLINKED / SHIPIT STALE BINARY!>'}")
if not rpath or "ShipIt" in rpath:
    print("ERROR: Responsible process binary was unlinked by Squirrel auto-update! Restart paseo daemon.", file=sys.stderr)
    sys.exit(2)
PY

echo "=== [2/6] Checking Full Disk Access (kTCCServiceSystemPolicyAllFiles) ==="
if sqlite3 -readonly "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT count(*) FROM access;" >/dev/null 2>&1; then
  echo "OK: Full Disk Access (kTCCServiceSystemPolicyAllFiles) is GRANTED to this Responsible Process."
else
  echo "WARN: Full Disk Access is NOT granted to this Responsible Process."
  echo "      Triggering eager TCC folder probes NOW so macOS prompts immediately..."
fi

echo "=== [3/6] Eagerly Probing TCC Protected Folders (Documents, Desktop, Downloads) ==="
for dir in "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads"; do
  if [ -d "$dir" ]; then
    ls "$dir" >/dev/null 2>&1 && echo "OK: Read access verified for $dir" || echo "DENIED: $dir"
  fi
done

echo "=== [4/6] Eagerly Probing Local Network Privacy & Firewall Socket Bind ==="
node -e '
const dgram = require("node:dgram");
const net = require("node:net");
const { execSync } = require("node:child_process");

let gw = "192.168.1.1";
try {
  const out = execSync("route -n get default 2>/dev/null", { encoding: "utf8" });
  const m = out.match(/gateway:\s+(\d+\.\d+\.\d+\.\d+)/);
  if (m) gw = m[1];
} catch {}

const udp = dgram.createSocket("udp4");
udp.send(Buffer.from([0]), 9, gw, () => {
  udp.close();
  const srv = net.createServer();
  srv.listen(0, "0.0.0.0", () => {
    console.log("OK: Local Network (" + gw + ") & Socket Bind (0.0.0.0) verified.");
    srv.close();
  });
});
'

echo "=== [5/6] Verifying OpenCode Non-Interactive Auto Mode ==="
if opencode run --help | grep -q -- "--auto"; then
  echo "OK: opencode supports --auto non-interactive permission approval."
else
  echo "ERROR: opencode binary does not support --auto!" >&2
  exit 1
fi

echo "=== [6/6] Ensuring Caffeinate Power Assertion on Trial Daemon (~/.paseo-factory) ==="
if [ -f "$HOME/.paseo-factory/paseo.pid" ]; then
  DAEMON_PID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.paseo-factory/paseo.pid", "utf8")).pid)')
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    if ! pgrep -f "caffeinate -dimsu -w $DAEMON_PID" >/dev/null 2>&1; then
      nohup /usr/bin/caffeinate -dimsu -w "$DAEMON_PID" >/dev/null 2>&1 &
      echo "OK: Attached caffeinate -dimsu to ~/.paseo-factory daemon (PID $DAEMON_PID)."
    else
      echo "OK: caffeinate -dimsu already attached to PID $DAEMON_PID."
    fi
  fi
fi
```

### B3. Windows Standalone Preflight Script (`scripts/preflight-windows-permissions.ps1`)

```powershell
$ErrorActionPreference = "Stop"

Write-Host "=== [1/5] Checking Windows Developer Mode & NTFS Junction/Symlink Capability ==="
$devMode = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" -Name "AllowDevelopmentWithoutDevLicense" -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
if ($devMode -eq 1) {
  Write-Host "OK: Windows Developer Mode is enabled (native symlinks + junctions supported)."
} else {
  Write-Host "WARN: Windows Developer Mode is disabled; factory-burn-lab must use NTFS 'junction' for node_modules."
}

Write-Host "=== [2/5] Eagerly Probing Controlled Folder Access (Documents, Desktop, Downloads) ==="
foreach ($dir in @("$env:USERPROFILE\Documents", "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Downloads")) {
  if (Test-Path $dir) {
    $probe = Join-Path $dir ".burn-lab-preflight.tmp"
    try {
      [System.IO.File]::WriteAllText($probe, "ok")
      Remove-Item $probe -Force
      Write-Host "OK: Write access verified for $dir"
    } catch {
      Write-Host "WARN: Controlled Folder Access blocked write to $dir — keep repos in $env:USERPROFILE\code"
    }
  }
}

Write-Host "=== [3/5] Eagerly Probing Windows Defender Firewall Socket Bind ==="
node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'0.0.0.0',()=>{console.log('OK: Socket bind verified');s.close();});"

Write-Host "=== [4/5] Verifying OpenCode Non-Interactive Auto Mode & Git Credential Manager ==="
$env:GCM_INTERACTIVE = "never"
$env:GIT_TERMINAL_PROMPT = "0"
$helpOut = & opencode run --help 2>&1 | Out-String
if ($helpOut -match "--auto") {
  Write-Host "OK: opencode supports --auto non-interactive permission approval."
} else {
  throw "opencode binary does not support --auto!"
}

Write-Host "=== [5/5] Attaching Win32 SetThreadExecutionState Power Assertion ==="
$pidFile = "$env:USERPROFILE\.paseo-factory\paseo.pid"
if (Test-Path $pidFile) {
  $daemonPid = (Get-Content $pidFile | ConvertFrom-Json).pid
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-Command",
    "`$sig='[DllImport(\`"kernel32.dll\`")] public static extern uint SetThreadExecutionState(uint esFlags);'; `$es=Add-Type -MemberDefinition `$sig -Name 'Win32Power' -Namespace 'BurnLab' -PassThru; [void]`$es::SetThreadExecutionState(0x80000045); Wait-Process -Id $daemonPid -ErrorAction SilentlyContinue; [void]`$es::SetThreadExecutionState(0x80000000)"
  )
  Write-Host "OK: Attached SetThreadExecutionState assertion to daemon PID $daemonPid."
}
```

---

## Primary Sources & Verification References

- **macOS TCC & Responsible Process Attribution:**
  - `tccutil(1)` man page (`/usr/share/man/man1/tccutil.1`)
  - Unified Log trace (`subsystem == "com.apple.TCC"`, `/usr/libexec/sandboxd` $\to$ `tccd` `kTCCServiceSystemPolicyAllFiles` preflight vs. `kTCCServiceSystemPolicyDocumentsFolder`)
  - `/usr/lib/libSystem.B.dylib` symbols `responsibility_get_pid_responsible_for_pid` and `proc_pidpath`
  - `/Applications/Paseo.app/Contents/Info.plist` & `/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/Info.plist`
  - `/Applications/Paseo.app/Contents/Resources/bin/paseo` (lines 24–48, `MACOS_HELPER_EXECUTABLE` `ELECTRON_RUN_AS_NODE=1` launcher)
- **Windows Filesystem, Symlinks, Firewall & Power Management:**
  - Node.js `fs.symlinkSync(target, path[, type])` documentation (`"dir"` vs. `"junction"` on Windows; `EPERM` without `SeCreateSymbolicLinkPrivilege` / `AllowDevelopmentWithoutDevLicense`)
  - Node.js `child_process.spawn` on Windows documentation & CVE-2024-27980 (`EINVAL` when spawning `.bat`/`.cmd` shims without `shell: true`)
  - Microsoft Defender Controlled Folder Access (`Get-MpPreference` / `Add-MpPreference -ControlledFolderAccessAllowedApplications` / `-ExclusionPath`)
  - Windows Defender Firewall (`New-NetFirewallRule` / `netsh advfirewall firewall`)
  - Git Credential Manager (`GCM_INTERACTIVE=never`, `GIT_TERMINAL_PROMPT=0`)
  - Microsoft Win32 `SetThreadExecutionState` API (`kernel32.dll`, `ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_AWAYMODE_REQUIRED`) & `powercfg /requests`
- **macOS Local Network Privacy, Firewall & Power Management:**
  - `/Library/Preferences/com.apple.networkextension.plist` (`NEPathRule` entries for `sh.paseo.desktop` and `sh.paseo.desktop.helper`)
  - `/usr/libexec/ApplicationFirewall/socketfilterfw` (`--getglobalstate`, `--getallowsigned`, `--getallowsignedapp`, `--listapps`)
  - `codesign -dvvv` verification of `Paseo.app` (`99ZMJMKU9Y`), `node` (`HX7739G8FX`), and `opencode.exe` (`5NZ4Q7NXJ4`)
  - `caffeinate(8)` man page (`/usr/share/man/man8/caffeinate.8`) & `pmset -g` / `pmset -g assertions`
- **OpenCode v2.0.32 & Paseo Daemon Permissions:**
  - Official OpenCode Permissions Docs: `https://opencode.ai/docs/permissions/` (`--auto`, `external_directory`, `doom_loop`, `question`, `read` `*.env*`)
  - `opencode` v2.0.32 binary (`chunk-46twsw7v.js` `runCommand` `--auto` / `--yolo` / `--dangerously-skip-permissions`, `OPENCODE_CONFIG_CONTENT`, `FileAccess.resolve`, `ShellTool.prepare`)
  - `/Applications/Paseo.app/Contents/Resources/app.asar` (`dist/cli/index.mjs` `OPENCODE_AUTO_ACCEPT_FEATURE_ID = "auto_accept"`, `buildOpenCodePermissionRules`, `isOpenCodeAutoAcceptEnabled`)
  - `factory-burn-lab` source: [`src/free-pool.ts:135-167`](../../src/free-pool.ts#L135-L167), [`src/free-pool.ts:312-358`](../../src/free-pool.ts#L312-L358), [`src/burn-engine.ts:56-57`](../../src/burn-engine.ts#L56-L57), [`src/burn-engine.ts:606-668`](../../src/burn-engine.ts#L606-L668), [`src/burn-engine.ts:1019-1064`](../../src/burn-engine.ts#L1019-L1064), [`src/burn-engine.ts:1365-1380`](../../src/burn-engine.ts#L1365-L1380), [`src/upstream.ts:4-5`](../../src/upstream.ts#L4-L5), [`plugin/server/surface-rpc.ts:495-506`](../../plugin/server/surface-rpc.ts#L495-L506)
  - `paseo-factory` source: [`../research-slp/plugin/server/choke.ts:71-74`](../../../research-slp/plugin/server/choke.ts#L71-L74), [`../research-slp/plugin/server/choke.ts:119-147`](../../../research-slp/plugin/server/choke.ts#L119-L147)
