# ADR 0002 — Cross-platform unattended preflight, non-interactive harness auto-approval, and run-scoped sleep assertions

- **Status:** Accepted — 2026-10-17 (ratified over a two-round `/grill-with-docs` session)
- **Context:** When `factory-burn-lab` executes long-running unattended `Burn run`s on macOS (`darwin`) or Windows (`win32`), the operating system and agent harnesses evaluate permissions lazily at the moment a child process (`opencode`, `node`, `git`, test runners) touches a protected folder (`~/Documents` on macOS TCC; `%USERPROFILE%\Documents` under Windows Controlled Folder Access), binds a wildcard network socket (`0.0.0.0` triggering macOS `socketfilterfw` or Windows Defender Firewall), creates a directory symlink inside a worktree (`EPERM` on Windows without Developer Mode), prompts for Git credentials (`GCM_INTERACTIVE`), or hits OpenCode's default `"ask"` rules (`external_directory`, `doom_loop`, `*.env`). Additionally, on macOS `Paseo.app` has a split TCC `Responsible bundle` between `/Applications/Paseo.app` (`sh.paseo.desktop`) and `/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app` (`sh.paseo.desktop.helper`), and Squirrel (`ShipIt`) auto-updates can leave a running daemon's binary unlinked (`proc_pidpath == ""`).

## Decision

1. **Two-Stage Cross-Platform `Unattended preflight` (`burn.snapshot` passive status + `burn.preflight` / `burn.start` active warm-up).**
   - **`burn.snapshot` (Passive / Zero-Popup):** Evaluates readiness without triggering OS modal dialogs — on macOS (`darwin`), checks the `Responsible bundle` via `responsibility_get_pid_responsible_for_pid` / `proc_pidpath`, detects unlinked Squirrel `ShipIt` binaries, and probes `kTCCServiceSystemPolicyAllFiles` (Full Disk Access) via a silent `sqlite3 -readonly` check on `/Library/Application Support/com.apple.TCC/TCC.db`; on Windows (`win32`), checks Controlled Folder Access / OneDrive workspace paths and NTFS Junction creation; on all platforms, checks `opencode --auto` support and active `Sleep assertion` state.
   - **`burn.preflight` & `burn.start` (Active Eager Trigger & Settings Helper):**
     - Clicking **Warm Up Permissions** (`mode: "warmup"`) or starting a `Burn run` eagerly probes protected folders (`Documents`, `Desktop`, `Downloads`, `project.root`, `.git`, `node_modules`) and network sockets (UDP LAN gateway + `0.0.0.0:0` / `127.0.0.1:0` loopback bind) in the first two seconds while the operator is present, and disables macOS App Nap (`NSAppSleepDisabled = YES`) on both `sh.paseo.desktop` and `sh.paseo.desktop.helper`.
     - If a `Burn run` detects a stale unlinked `ShipIt` binary or receives `EACCES`/`EPERM` on `project.root`, it fails fast immediately rather than stalling mid-run.
     - Clicking **Open OS Security Settings** (`mode: "open-settings"`) opens macOS Full Disk Access settings alongside Finder revealing `Paseo Helper.app`, or opens Windows Security Controlled Folder Access & Firewall settings on Windows.

2. **Non-Interactive Agent Harness & Child Environment (`--auto`, `OPENCODE_CONFIG_CONTENT`, `auto_accept`, `HOST=127.0.0.1`, `GCM_INTERACTIVE=never`).**
   - Every `opencode run` invocation in `src/free-pool.ts` passes `--auto` and injects `OPENCODE_CONFIG_CONTENT` (`{"permission":{"*":"allow","external_directory":"allow","doom_loop":"allow","question":"deny","read":{"*":"allow","*.env":"allow","*.env.*":"allow"}}}`) so worktree symlinks, `/tmp`, and `.env` reads never reject or stall on interactive prompts.
   - All child processes (`opencode`, `Gate` commands, `git`, `Supervisor`) inherit `CI=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, and `HOST=127.0.0.1` (so dev/test servers bind loopback `127.0.0.1` and bypass both macOS `socketfilterfw` and Windows Defender Firewall prompts).
   - Opening or creating the `Supervisor` agent seat via `burn.supervisor.open` passes `featureValues: { auto_accept: true }` in `daemon.agents.create`.

3. **Portable Cross-Platform Paths, Shells, and Worktree Junctions (`darwin` + `win32`).**
   - Remove single-machine hardcoded paths (`/Users/andrewpham/...`): resolve `DEFAULT_SELF_REPO_ROOT` and `DEFAULT_UPSTREAM_ISSUES_DIR` dynamically from `import.meta.url`, environment overrides (`BURN_LAB_SELF_REPO_ROOT`, `BURN_LAB_UPSTREAM_ISSUES_DIR`), and sibling repo discovery.
   - Use `path.delimiter` (`;` on Windows, `:` on POSIX) and resolve `opencode.cmd` / `opencode.exe` across Windows (`%APPDATA%\npm`, `%LOCALAPPDATA%\nvm`, `%NVM_SYMLINK%`, `%USERPROFILE%\.bun\bin`, Scoop, WinGet) and macOS/Linux (`~/.nvm`, `~/.local/bin`, Homebrew).
   - Use `process.platform === "win32" ? "junction" : "dir"` when symlinking `node_modules` into isolated worktrees so Windows never requires Administrator elevation or Developer Mode (`EPERM`).
   - Execute `Gate` commands via `cmd.exe /d /s /c` on Windows and `sh -c` on POSIX with `windowsHide: true`.

4. **Run-Scoped Cross-Platform `Sleep assertion`.**
   - While one or more `Burn run`s are active, `factory-burn-lab` holds an OS `Sleep assertion` tied to the current process PID (`/usr/bin/caffeinate -dimsu -w <pid>` on macOS; hidden `powershell.exe` calling Win32 `SetThreadExecutionState(0x80000045)` + `Wait-Process -Id <pid>` on Windows) and releases it in the `finally` block as soon as all runs finish.
