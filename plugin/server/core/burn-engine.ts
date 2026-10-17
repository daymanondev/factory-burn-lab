import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type CitationGateResult, verifyCitations } from "./citation-gate.ts";
import {
  changedFiles,
  type ClaimOutcome,
  createFactory,
  diffBetween,
  discoverProjects,
  type Factory,
  headCommitSync,
  type LaneCliRunner,
  lanesPath,
  listProjectRegistrations,
  loadLanes,
  MAX_ATTEMPTS,
  parseEyeAnswer,
  parseLane,
  prepareTaskWorktree,
  projectLanesPath,
  projectStateDir,
  readProjectRegistration,
  resolveProject,
  runLaneCli,
  tailWithMarker,
  WATCH_DIFF_MAX_CHARS,
  WATCH_GATE_OUTPUT_MAX_CHARS,
  WATCH_QUESTIONS,
  writeProjectRegistration,
} from "./factory-core/index.ts";
import {
  buildExtendedPathEnv,
  extractModelFamily,
  type FreeModelRecord,
  loadFreePool,
  type OpenCodeRunner,
  runOpenCodeFreeModel,
  saveFreePool,
  type ScoutProbeRunner,
  scoutFreePool,
  type SwarmRole,
} from "./free-pool.ts";
import {
  acquireSleepAssertion,
  runUnattendedWarmup,
  type UnattendedPreflightState,
} from "./preflight.ts";
import {
  DEFAULT_UPSTREAM_ISSUES_DIR,
  fileUpstreamIssue,
  resolveDefaultSelfRepoRoot,
  type UpstreamIssue,
} from "./upstream.ts";

export const BURN_PLAYBOOKS = [
  "scout-pool",
  "oss-lab",
  "proto-arena",
  "night-shift",
  "self-evolve",
] as const;

export type BurnPlaybook = (typeof BURN_PLAYBOOKS)[number];

export type BurnRunStatus =
  | "queued"
  | "framing"
  | "swarm-running"
  | "verifying"
  | "synthesizing"
  | "completed"
  | "failed";

export const DEFAULT_SUPERVISOR_LANE = "pi/zai/glm-5.3";

export const DEFAULT_SELF_REPO_ROOT = resolveDefaultSelfRepoRoot();

export interface BurnProject {
  slug: string;
  name: string;
  root: string;
  gitCommonDir?: string;
  supervisorLane: string;
  source: "paseo-factory" | "paseo" | "burn-lab";
}

export type ProjectIdentityResolution =
  | { ok: true; slug: string; root: string; gitCommonDir: string }
  | { ok: false; error: string };

export interface BurnFramingPlan {
  goal: string;
  subtasks: string[];
  gateCommand: string;
  artifact: string;
  scope?: string[];
  citationRequired: boolean;
  rawSupervisorOutput: string;
}

export interface GateRunResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BurnAttemptRecord {
  id: string;
  model: string;
  family: string;
  role: SwarmRole;
  subtask: string;
  ok: boolean;
  attemptCount: number;
  latencyMs: number;
  output: string;
  worktreeDir?: string;
  branchName?: string;
  baseCommit?: string;
  claimedCommit?: string;
  diffPatch?: string;
  changedFiles?: string[];
  factoryVerdict?: "green" | "red";
  factoryReportPath?: string;
  gateResult?: GateRunResult;
  citationResult?: CitationGateResult;
  accepted: boolean;
  rejectionReason?: string;
}

export interface BurnCouncilNote {
  reviewerModel: string;
  reviewerFamily: string;
  targetAttemptId: string;
  targetModel: string;
  verdict: "approve" | "challenge";
  critique: string;
  citationsVerified: boolean;
}

export interface BurnRunRecord {
  id: string;
  playbook: BurnPlaybook;
  projectSlug: string;
  projectRoot: string;
  supervisorLane: string;
  prompt: string;
  targetRepo?: string;
  gateCommand?: string;
  status: BurnRunStatus;
  statusHistory: BurnRunStatus[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  framing?: BurnFramingPlan;
  attempts: BurnAttemptRecord[];
  councilNotes: BurnCouncilNote[];
  winningAttemptId?: string;
  winningModel?: string;
  winningBranch?: string;
  winningCommit?: string;
  landingStatus?: "not_landed" | "landed" | "pending-conflict";
  landingNote?: string;
  reportPath?: string;
  reportMarkdown?: string;
  upstreamIssue?: UpstreamIssue;
  error?: string;
}

export interface ParsedSupervisorLane {
  provider: string;
  model: string;
  providerSpec: string;
  thinking?: string;
}

export function parseSupervisorLane(lane: string): ParsedSupervisorLane {
  const trimmed = lane.trim() || DEFAULT_SUPERVISOR_LANE;
  const parsed = parseLane(trimmed);
  if (parsed) {
    return {
      provider: parsed.provider,
      model: parsed.model,
      providerSpec: `${parsed.provider}/${parsed.model}`,
      ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
    };
  }
  const slashIdx = trimmed.indexOf("/");
  const colonIdx = trimmed.lastIndexOf(":");
  const hasThinking = colonIdx > slashIdx && colonIdx !== -1;
  const providerSpec = hasThinking ? trimmed.slice(0, colonIdx) : trimmed;
  const thinking = hasThinking ? trimmed.slice(colonIdx + 1) : undefined;
  const provider = slashIdx === -1 ? "pi" : providerSpec.slice(0, slashIdx);
  const model = slashIdx === -1 ? providerSpec : providerSpec.slice(slashIdx + 1);
  return { provider, model, providerSpec, thinking };
}

export type SupervisorRunner = (input: {
  lane: string;
  phase: "framing" | "synthesizing";
  playbook: BurnPlaybook;
  project: BurnProject;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  paseoHome?: string;
  laneCliRunner?: LaneCliRunner;
}) =>
  | Promise<{ ok: boolean; stdout: string; stderr?: string; error?: string }>
  | { ok: boolean; stdout: string; stderr?: string; error?: string };

export type GateRunner = (input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<GateRunResult> | GateRunResult;

/**
 * Resolves the canonical `paseo-factory` state directory (`<paseoHome>/plugin-state/paseo-factory`).
 */
export function resolveFactoryStateDir(paseoHome: string): string {
  return join(paseoHome, "plugin-state", "paseo-factory");
}

function factoryStateDirs(paseoHome: string): string[] {
  return [resolveFactoryStateDir(paseoHome), join(paseoHome, "factory")];
}

export function resolveProjectIdentity(cwd: string): ProjectIdentityResolution {
  if (!existsSync(cwd)) {
    return { ok: false, error: `directory does not exist: ${cwd}` };
  }
  const resolved = resolveProject(cwd);
  if (!resolved.ok) {
    return { ok: false, error: resolved.reason || `not a git repository: ${cwd}` };
  }
  const root = existsSync(resolved.root)
    ? realpathSync.native(resolved.root)
    : resolve(resolved.root);
  return {
    ok: true,
    slug: resolved.slug,
    root,
    gitCommonDir: resolved.gitCommonDir,
  };
}

function readSupervisorFromLanesFile(lanesFilePath: string): string | null {
  if (!existsSync(lanesFilePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lanesFilePath, "utf8")) as Record<string, unknown>;
    if (typeof parsed.supervisor === "string" && parsed.supervisor.trim().includes("/")) {
      return parsed.supervisor.trim();
    }
    const nested = parsed.lanes as Record<string, unknown> | undefined;
    if (nested && typeof nested.supervisor === "string" && nested.supervisor.trim().includes("/")) {
      return nested.supervisor.trim();
    }
  } catch {
    // ignore malformed json
  }
  return null;
}

export function resolveSupervisorLane(paseoHome: string, projectSlug?: string): string {
  const stateDirs = factoryStateDirs(paseoHome);

  if (projectSlug) {
    for (const stateDir of stateDirs) {
      const projLanesFile = projectLanesPath(stateDir, projectSlug);
      if (existsSync(projLanesFile)) {
        const loaded = loadLanes(stateDir, projectSlug);
        if (loaded.ok && readSupervisorFromLanesFile(projLanesFile) !== null) {
          return loaded.lanes.supervisor;
        }
        const rawProj = readSupervisorFromLanesFile(projLanesFile);
        if (rawProj) return rawProj;
      }

      const perProjectJson = readSupervisorFromLanesFile(
        join(stateDir, "projects", `${projectSlug}.json`),
      );
      if (perProjectJson) return perProjectJson;

      const perProjectMeta = readSupervisorFromLanesFile(
        join(stateDir, "projects", projectSlug, "project.json"),
      );
      if (perProjectMeta) return perProjectMeta;
    }
  }

  for (const stateDir of stateDirs) {
    const machineLanesFile = lanesPath(stateDir);
    if (existsSync(machineLanesFile)) {
      const loaded = loadLanes(stateDir, projectSlug);
      if (loaded.ok) return loaded.lanes.supervisor;
      const rawMachine = readSupervisorFromLanesFile(machineLanesFile);
      if (rawMachine) return rawMachine;
    }
  }

  const fallback = loadLanes(resolveFactoryStateDir(paseoHome), projectSlug);
  return fallback.ok ? fallback.lanes.supervisor : DEFAULT_SUPERVISOR_LANE;
}

function burnLabProjectsPath(paseoHome: string): string {
  return join(paseoHome, "burn-lab", "projects.json");
}

function extractRootFromLedgerIfPresent(ledgerFile: string): string | null {
  if (!existsSync(ledgerFile)) return null;
  try {
    const lines = readFileSync(ledgerFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as Record<string, unknown>;
      const candidate = entry.projectRoot ?? entry.root ?? entry.cwd ?? entry.repoRoot;
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function parseProjectEntry(
  raw: Record<string, unknown>,
  paseoHome: string,
  source: BurnProject["source"],
  fallbackSlug?: string,
  allowTempRoot = false,
): BurnProject | null {
  if (raw.archivedAt !== undefined && raw.archivedAt !== null) {
    return null;
  }
  const rawRoot =
    (typeof raw.root === "string" && raw.root) ||
    (typeof raw.rootPath === "string" && raw.rootPath) ||
    (typeof raw.path === "string" && raw.path) ||
    (typeof raw.cwd === "string" && raw.cwd) ||
    (typeof raw.projectRoot === "string" && raw.projectRoot) ||
    "";
  if (!rawRoot || !existsSync(rawRoot)) return null;

  const isTempHome =
    allowTempRoot ||
    paseoHome.startsWith("/tmp/") ||
    paseoHome.startsWith("/private/tmp/") ||
    paseoHome.startsWith("/var/folders/");
  if (
    !isTempHome &&
    (rawRoot.startsWith("/tmp/") ||
      rawRoot.startsWith("/private/tmp/") ||
      rawRoot.includes("/.paseo-factory/plugin-state/") ||
      rawRoot.includes("/.paseo-factory-supervisor") ||
      rawRoot.includes("/factory-live"))
  ) {
    return null;
  }

  const identity = resolveProjectIdentity(rawRoot);
  const slug =
    (typeof raw.slug === "string" && raw.slug.trim()) ||
    (identity.ok ? identity.slug : fallbackSlug) ||
    `${basename(rawRoot)}-${createHash("sha1").update(rawRoot).digest("hex").slice(0, 6)}`;

  const root = identity.ok ? identity.root : resolve(rawRoot);
  const name =
    (typeof raw.name === "string" && raw.name.trim()) ||
    (typeof raw.customName === "string" && raw.customName.trim()) ||
    (typeof raw.displayName === "string" && raw.displayName.trim()) ||
    basename(root);
  const supervisorLane =
    (typeof raw.supervisorLane === "string" && raw.supervisorLane.trim()) ||
    resolveSupervisorLane(paseoHome, slug);

  return {
    slug,
    name,
    root,
    gitCommonDir: identity.ok ? identity.gitCommonDir : undefined,
    supervisorLane,
    source,
  };
}

export function resolveBurnProjects(
  paseoHome: string,
  options?: { includeSelfRepo?: boolean; selfRepoRoot?: string },
): BurnProject[] {
  const bySlug = new Map<string, BurnProject>();
  const byRoot = new Set<string>();

  const register = (proj: BurnProject | null) => {
    if (!proj) return;
    if (bySlug.has(proj.slug) || byRoot.has(proj.root)) return;
    bySlug.set(proj.slug, proj);
    byRoot.add(proj.root);
  };

  for (const stateDir of factoryStateDirs(paseoHome)) {
    for (const reg of listProjectRegistrations(stateDir)) {
      register(
        parseProjectEntry(
          { slug: reg.slug, root: reg.root, name: reg.name },
          paseoHome,
          "paseo-factory",
          reg.slug,
        ),
      );
    }

    for (const disc of discoverProjects(stateDir, [], paseoHome)) {
      if (!disc.root) continue;
      const reg = readProjectRegistration(stateDir, disc.slug);
      register(
        parseProjectEntry(
          { slug: disc.slug, root: disc.root, name: reg?.name },
          paseoHome,
          reg ? "paseo-factory" : "paseo",
          disc.slug,
        ),
      );
    }

    const projectsDir = join(stateDir, "projects");
    if (!existsSync(projectsDir)) continue;
    for (const entryName of readdirSync(projectsDir).sort()) {
      const fullPath = join(projectsDir, entryName);
      try {
        const st = statSync(fullPath);
        if (st.isFile() && entryName.endsWith(".json")) {
          const raw = JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
          register(
            parseProjectEntry(
              raw,
              paseoHome,
              "paseo-factory",
              entryName.replace(/\.json$/i, ""),
            ),
          );
        } else if (st.isDirectory()) {
          const projectJson = join(fullPath, "project.json");
          if (existsSync(projectJson)) {
            const raw = JSON.parse(readFileSync(projectJson, "utf8")) as Record<string, unknown>;
            register(parseProjectEntry(raw, paseoHome, "paseo-factory", entryName));
          } else {
            const ledgerRoot = extractRootFromLedgerIfPresent(join(fullPath, "ledger.jsonl"));
            if (ledgerRoot) {
              register(
                parseProjectEntry(
                  { slug: entryName, root: ledgerRoot },
                  paseoHome,
                  "paseo-factory",
                  entryName,
                ),
              );
            }
          }
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }

  const projectListSources: Array<{ filePath: string; source: BurnProject["source"] }> = [
    { filePath: burnLabProjectsPath(paseoHome), source: "burn-lab" },
    { filePath: join(paseoHome, "projects", "projects.json"), source: "paseo" },
  ];

  for (const { filePath, source } of projectListSources) {
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      for (const item of unwrapProjectListJson(parsed)) {
        register(parseProjectEntry(item, paseoHome, source));
      }
    } catch {
      // ignore
    }
  }

  if (options?.includeSelfRepo !== false) {
    const selfRoot = options?.selfRepoRoot ?? DEFAULT_SELF_REPO_ROOT;
    if (existsSync(selfRoot)) {
      register(
        parseProjectEntry(
          { name: "factory-burn-lab", root: selfRoot },
          paseoHome,
          "burn-lab",
          undefined,
          true,
        ),
      );
    }
  }

  return [...bySlug.values()];
}

function unwrapProjectListJson(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
    );
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { projects?: unknown }).projects)
  ) {
    return (parsed as { projects: unknown[] }).projects.filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
    );
  }
  return [];
}

export function addBurnProject(
  paseoHome: string,
  repoPath: string,
  options?: { initGit?: boolean; name?: string },
): { ok: true; project: BurnProject } | { ok: false; error: string } {
  const projectRoot = resolve(repoPath);
  try {
    if (!existsSync(projectRoot)) {
      if (!options?.initGit) {
        return { ok: false, error: `directory does not exist: ${projectRoot}` };
      }
      mkdirSync(projectRoot, { recursive: true });
    }

    let identity = resolveProjectIdentity(projectRoot);
    if (!identity.ok && options?.initGit) {
      execFileSync("git", ["init"], {
        cwd: projectRoot,
        env: buildExtendedPathEnv(),
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "burn-lab@local"], {
        cwd: projectRoot,
        env: buildExtendedPathEnv(),
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Factory Burn Lab"], {
        cwd: projectRoot,
        env: buildExtendedPathEnv(),
        stdio: "ignore",
      });
      const readmePath = join(projectRoot, "README.md");
      if (!existsSync(readmePath)) {
        writeFileSync(
          readmePath,
          `# ${options?.name ?? basename(projectRoot)}\nInitialized by factory-burn-lab.\n`,
          "utf8",
        );
      }
      execFileSync("git", ["add", "."], {
        cwd: projectRoot,
        env: buildExtendedPathEnv(),
        stdio: "ignore",
      });
      try {
        execFileSync("git", ["commit", "-m", "chore: initialize project repository"], {
          cwd: projectRoot,
          env: buildExtendedPathEnv(),
          stdio: "ignore",
        });
      } catch {
        // ignore if already committed
      }
      identity = resolveProjectIdentity(projectRoot);
    }

    if (!identity.ok) {
      return { ok: false, error: identity.error };
    }

    const factoryStateDir = resolveFactoryStateDir(paseoHome);
    const projectName = options?.name?.trim() || basename(identity.root);
    writeProjectRegistration(factoryStateDir, identity.slug, {
      root: identity.root,
      name: projectName,
    });
    const reg = readProjectRegistration(factoryStateDir, identity.slug);

    const project: BurnProject = {
      slug: identity.slug,
      name: reg?.name || projectName,
      root: identity.root,
      gitCommonDir: identity.gitCommonDir,
      supervisorLane: resolveSupervisorLane(paseoHome, identity.slug),
      source: "paseo-factory",
    };

    return { ok: true, project };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function burnRunsDir(paseoHome: string): string {
  return join(paseoHome, "burn-lab", "runs");
}

export function burnRunJsonPath(paseoHome: string, runId: string): string {
  return join(burnRunsDir(paseoHome), `${runId}.json`);
}

export function burnRunArtifactDir(paseoHome: string, runId: string): string {
  return join(burnRunsDir(paseoHome), runId);
}

export function saveBurnRun(paseoHome: string, run: BurnRunRecord): void {
  const jsonPath = burnRunJsonPath(paseoHome, run.id);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

export function loadBurnRun(paseoHome: string, runId: string): BurnRunRecord | null {
  const jsonPath = burnRunJsonPath(paseoHome, runId);
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, "utf8")) as BurnRunRecord;
  } catch {
    return null;
  }
}

export function listBurnRuns(paseoHome: string): BurnRunRecord[] {
  const dir = burnRunsDir(paseoHome);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const runs: BurnRunRecord[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as BurnRunRecord;
      if (parsed && typeof parsed.id === "string") {
        runs.push(parsed);
      }
    } catch {
      // ignore malformed
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function defaultGateRunner(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<GateRunResult> {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === "win32";
    const shellCmd = isWin ? process.env.ComSpec || "cmd.exe" : "sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", input.command] : ["-c", input.command];
    const child = spawn(shellCmd, shellArgs, {
      cwd: input.cwd,
      env: buildExtendedPathEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        command: input.command,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolvePromise({
          ok: false,
          command: input.command,
          exitCode: 124,
          stdout,
          stderr: `Gate timed out after ${input.timeoutMs}ms`,
        });
        return;
      }
      const exitCode = code ?? 1;
      resolvePromise({
        ok: exitCode === 0,
        command: input.command,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

export async function defaultSupervisorRunner(input: {
  lane: string;
  phase: "framing" | "synthesizing";
  playbook: BurnPlaybook;
  project: BurnProject;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  paseoHome?: string;
  laneCliRunner?: LaneCliRunner;
}): Promise<{ ok: boolean; stdout: string; stderr?: string; error?: string }> {
  const effectiveLane = input.lane.trim() || DEFAULT_SUPERVISOR_LANE;
  const { provider, model } = parseSupervisorLane(effectiveLane);

  if (provider === "opencode") {
    const res = await runOpenCodeFreeModel({
      model: `opencode/${model}`,
      prompt: input.prompt,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
    if (res.ok) {
      return { ok: true, stdout: res.stdout, stderr: res.stderr };
    }
    return {
      ok: false,
      stdout: res.stdout,
      stderr: res.stderr,
      error: res.error ?? (res.stderr || "opencode supervisor failed"),
    };
  }

  const factoryStateDir = input.paseoHome
    ? resolveFactoryStateDir(input.paseoHome)
    : undefined;
  const laneRes = await runLaneCli({
    lane: effectiveLane,
    stdin: input.prompt,
    timeoutMs: input.timeoutMs,
    stateDir: factoryStateDir,
    runner: input.laneCliRunner,
  });

  if (laneRes.ok) {
    const cleanStdout = laneRes.stdout.trim();
    if (cleanStdout.length > 0) {
      return { ok: true, stdout: cleanStdout };
    }
    return {
      ok: false,
      stdout: "",
      stderr: `${provider} returned empty output`,
      error: `${provider} returned empty output`,
    };
  }

  return {
    ok: false,
    stdout: "",
    stderr: laneRes.error,
    error: laneRes.error || "supervisor invocation failed",
  };
}

export function inferDefaultGate(projectRoot: string, playbook: BurnPlaybook): string {
  if (playbook === "self-evolve") {
    return "npm test && npm run check:bundle";
  }
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      const testScript = pkg?.scripts?.test;
      if (
        typeof testScript === "string" &&
        testScript.trim() !== "" &&
        !testScript.includes("no test specified")
      ) {
        return "npm test";
      }
    } catch {
      // ignore malformed package.json
    }
  }
  return 'node -e "process.exit(0)"';
}

export function inferDefaultArtifact(projectRoot: string): string {
  if (existsSync(join(projectRoot, "package.json"))) {
    return "package.json";
  }
  if (existsSync(join(projectRoot, "README.md"))) {
    return "README.md";
  }
  return ".";
}

function parseFramingOutput(
  rawOutput: string,
  playbook: BurnPlaybook,
  userPrompt: string,
  projectRoot: string,
  overrideGate?: string,
): BurnFramingPlan {
  const defaultGate = overrideGate ?? inferDefaultGate(projectRoot, playbook);
  const defaultArtifact = inferDefaultArtifact(projectRoot);

  try {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<BurnFramingPlan>;
      const parsedScope =
        Array.isArray(parsed.scope) && parsed.scope.length > 0
          ? parsed.scope.map((s) => String(s).trim()).filter(Boolean)
          : undefined;
      return {
        goal:
          typeof parsed.goal === "string" && parsed.goal.trim()
            ? parsed.goal.trim()
            : userPrompt,
        subtasks:
          Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0
            ? parsed.subtasks.map(String)
            : [userPrompt],
        gateCommand:
          overrideGate ??
          (typeof parsed.gateCommand === "string" && parsed.gateCommand.trim()
            ? parsed.gateCommand.trim()
            : defaultGate),
        artifact:
          typeof parsed.artifact === "string" && parsed.artifact.trim()
            ? parsed.artifact.trim()
            : defaultArtifact,
        ...(parsedScope && parsedScope.length > 0 ? { scope: parsedScope } : {}),
        citationRequired:
          typeof parsed.citationRequired === "boolean"
            ? parsed.citationRequired
            : playbook === "oss-lab",
        rawSupervisorOutput: rawOutput,
      };
    }
  } catch {
    // fallback below
  }

  return {
    goal: userPrompt,
    subtasks: [userPrompt],
    gateCommand: defaultGate,
    artifact: defaultArtifact,
    citationRequired: playbook === "oss-lab",
    rawSupervisorOutput: rawOutput,
  };
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
]);

const SKIP_LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
]);

const BINARY_EXT_PATTERN =
  /\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|pdf|zip|tar|gz|exe|dll|so|dylib|wasm|mp4|mp3|mov|avi|lock)$/i;

function walkTrackedOrLocalFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: buildExtendedPathEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const tracked = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (tracked.length > 0) {
      return tracked;
    }
  } catch {
    // fall back to directory walk below
  }

  const collected: string[] = [];
  const walk = (relDir: string, depth: number) => {
    if (depth > 5 || collected.length >= 250) return;
    const absDir = relDir ? join(repoRoot, relDir) : repoRoot;
    let entries: string[] = [];
    try {
      entries = readdirSync(absDir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const absPath = join(repoRoot, relPath);
      try {
        const st = statSync(absPath);
        if (st.isDirectory()) {
          walk(relPath, depth + 1);
        } else if (st.isFile()) {
          collected.push(relPath);
        }
      } catch {
        // ignore unreadable entries
      }
    }
  };
  walk("", 0);
  return collected;
}

export function buildSmartRepoExcerpts(
  inspectRepoRoot: string,
  prompt: string,
  subtasks: string[] = [],
  options?: { maxFiles?: number; maxLinesPerFile?: number },
): string[] {
  const maxFiles = options?.maxFiles ?? 10;
  const maxLinesPerFile = options?.maxLinesPerFile ?? 250;
  const queryText = [prompt, ...subtasks].join(" ");
  const queryLower = queryText.toLowerCase();
  const keywords = [
    ...new Set(
      (queryText.match(/[A-Za-z0-9_.-]{2,}/g) ?? []).map((tok) => tok.toLowerCase()),
    ),
  ];

  const allFiles = walkTrackedOrLocalFiles(inspectRepoRoot);
  const candidates: Array<{ rel: string; score: number; lines: string[] }> = [];

  for (const rel of allFiles) {
    const normalizedRel = rel.replace(/\\/g, "/");
    const segments = normalizedRel.split("/");
    if (segments.some((seg) => SKIP_DIRS.has(seg))) continue;
    const baseLower = basename(normalizedRel).toLowerCase();
    if (SKIP_LOCKFILES.has(baseLower)) continue;
    if (BINARY_EXT_PATTERN.test(baseLower)) continue;

    const abs = join(inspectRepoRoot, normalizedRel);
    if (!existsSync(abs)) continue;
    let rawContent = "";
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size === 0 || st.size > 512_000) continue;
      rawContent = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (rawContent.includes("\0")) continue;

    const trimmedContent = rawContent.replace(/\r?\n$/, "");
    const lines = trimmedContent.length === 0 ? [] : trimmedContent.split(/\r?\n/);
    if (lines.length === 0) continue;

    let score = 0;
    const relLower = normalizedRel.toLowerCase();

    // Architectural priority
    if (relLower === "readme.md") score += 45;
    else if (relLower === "package.json") score += 40;
    else if (relLower === "context.md" || relLower === "glossary.md") score += 35;
    else if (/^src\/(index|main|app)\.[a-z]+$/i.test(normalizedRel)) score += 32;
    else if (relLower.startsWith("src/")) score += 20;

    if (/\.(ts|tsx|js|mjs|py|rs|go|md|json)$/i.test(normalizedRel)) {
      score += 10;
    }

    // Direct path or filename mention in prompt/subtasks
    if (queryLower.includes(relLower)) {
      score += 120;
    } else if (baseLower.length >= 4 && queryLower.includes(baseLower)) {
      score += 60;
    }

    const contentLower = trimmedContent.toLowerCase();
    for (const kw of keywords) {
      if (kw.length < 3) continue;
      if (relLower.includes(kw)) {
        score += 18;
      }
      if (contentLower.includes(kw)) {
        score += 4;
      }
    }

    candidates.push({ rel: normalizedRel, score, lines });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
    return a.rel.localeCompare(b.rel);
  });

  const selected = candidates.slice(0, maxFiles);
  return selected.map(({ rel, lines }) => {
    const excerptCount = Math.min(lines.length, maxLinesPerFile);
    const numbered = lines
      .slice(0, excerptCount)
      .map((line, i) => `${i + 1}: ${line}`)
      .join("\n");
    const exampleEnd = Math.min(lines.length, 5);
    return `File ${rel} (total lines: 1-${lines.length}; valid citation example: [${rel}:1-${exampleEnd}]):\n${numbered}`;
  });
}

const DEFAULT_FALLBACK_FREE_MODELS: FreeModelRecord[] = [
  {
    id: "opencode/glm-5.3-flash-free",
    family: "glm",
    displayName: "GLM 5.3 Flash Free",
    contextWindow: 204_800,
    healthy: true,
    latencyMs: 250,
    gatePassed: true,
    citationPassed: true,
    roles: ["coder", "reader-1m", "reviewer"],
    wins: 0,
    attempts: 0,
    lastScoutedAt: null,
  },
  {
    id: "opencode/deepseek-v4.1-flash-free",
    family: "deepseek",
    displayName: "DeepSeek V4.1 Flash Free",
    contextWindow: 200_000,
    healthy: true,
    latencyMs: 300,
    gatePassed: true,
    citationPassed: true,
    roles: ["coder", "reader-1m", "reviewer"],
    wins: 0,
    attempts: 0,
    lastScoutedAt: null,
  },
  {
    id: "opencode/nemotron-3-ultra-free",
    family: "nemotron",
    displayName: "Nemotron 3 Ultra Free",
    contextWindow: 1_000_000,
    healthy: true,
    latencyMs: 380,
    gatePassed: true,
    citationPassed: true,
    roles: ["coder", "reader-1m", "reviewer"],
    wins: 0,
    attempts: 0,
    lastScoutedAt: null,
  },
];

function selectSwarmModels(
  paseoHome: string,
  preferredRole: SwarmRole,
  maxCount: number,
): FreeModelRecord[] {
  const pool = loadFreePool(paseoHome);
  let healthy = pool.models.filter((m) => m.healthy);

  if (healthy.length === 0) {
    healthy = DEFAULT_FALLBACK_FREE_MODELS;
  }

  const withRole = healthy.filter((m) => m.roles.includes(preferredRole));
  const candidates = [...(withRole.length > 0 ? withRole : healthy)].sort(
    (a, b) => (b.wins - a.wins) || ((a.latencyMs ?? 999_999) - (b.latencyMs ?? 999_999)),
  );

  // Prioritize distinct model families first
  const selected: FreeModelRecord[] = [];
  const usedFamilies = new Set<string>();

  for (const model of candidates) {
    if (selected.length >= maxCount) break;
    if (!usedFamilies.has(model.family)) {
      selected.push(model);
      usedFamilies.add(model.family);
    }
  }

  for (const model of candidates) {
    if (selected.length >= maxCount) break;
    if (!selected.some((s) => s.id === model.id)) {
      selected.push(model);
    }
  }

  return selected;
}

export function pickCrossFamilyReviewers(
  paseoHome: string,
  targetFamily: string,
  targetModelId: string,
  maxCount = 2,
): FreeModelRecord[] {
  const pool = loadFreePool(paseoHome);
  const healthy = pool.models.filter((m) => m.healthy);
  const candidates = healthy
    .filter((m) => m.family !== targetFamily && m.id !== targetModelId)
    .sort((a, b) => {
      const aRev = a.roles.includes("reviewer") || a.roles.includes("reader-1m") ? 1 : 0;
      const bRev = b.roles.includes("reviewer") || b.roles.includes("reader-1m") ? 1 : 0;
      if (bRev !== aRev) return bRev - aRev;
      return (b.wins - a.wins) || ((a.latencyMs ?? 999_999) - (b.latencyMs ?? 999_999));
    });

  const selected: FreeModelRecord[] = [];
  const usedFamilies = new Set<string>();

  for (const model of candidates) {
    if (selected.length >= maxCount) break;
    if (!usedFamilies.has(model.family)) {
      selected.push(model);
      usedFamilies.add(model.family);
    }
  }

  for (const model of candidates) {
    if (selected.length >= maxCount) break;
    if (!selected.some((s) => s.id === model.id)) {
      selected.push(model);
    }
  }

  if (selected.length === 0) {
    return DEFAULT_FALLBACK_FREE_MODELS.filter(
      (m) => m.family !== targetFamily && m.id !== targetModelId,
    ).slice(0, maxCount);
  }

  return selected;
}

async function runCouncilCrossCheck(input: {
  paseoHome: string;
  playbook: BurnPlaybook;
  cwd: string;
  timeoutMs: number;
  openCodeRunner?: OpenCodeRunner;
  attempts: BurnAttemptRecord[];
  councilNotes: BurnCouncilNote[];
}): Promise<void> {
  const watchChecklist = WATCH_QUESTIONS.map(
    (q, idx) =>
      `${idx + 1}. ${q.name} — ${q.instructions}\n   - CHALLENGE if: ${q.criteria.true}\n   - CLEAR if: ${q.criteria.false}`,
  ).join("\n");

  for (const attempt of input.attempts.filter((a) => a.accepted)) {
    const reviewers = pickCrossFamilyReviewers(
      input.paseoHome,
      attempt.family,
      attempt.model,
      2,
    );
    const diffSection =
      attempt.diffPatch !== undefined || attempt.role === "coder"
        ? [
            "",
            "GIT_DIFF (base..claimed):",
            tailWithMarker(attempt.diffPatch || "(no files changed in git diff)", WATCH_DIFF_MAX_CHARS),
          ]
        : [];
    const gateSection =
      attempt.gateResult !== undefined
        ? [
            "",
            `GATE_OUTPUT (command="${attempt.gateResult.command}", exit=${attempt.gateResult.exitCode}):`,
            tailWithMarker(
              [attempt.gateResult.stdout, attempt.gateResult.stderr].filter(Boolean).join("\n") ||
                "(empty gate output)",
              WATCH_GATE_OUTPUT_MAX_CHARS,
            ),
          ]
        : [];

    const notesForAttempt = await Promise.all(
      reviewers.map(async (reviewer) => {
        const councilRes = await runOpenCodeFreeModel({
          model: reviewer.id,
          prompt: [
            "COUNCIL_REVIEW",
            "Do not call any tools (do not call read, glob, grep, or bash).",
            `Cross-examine the following ${input.playbook} attempt (${attempt.id}) from ${attempt.model} (family=${attempt.family}):`,
            `Subtask: ${attempt.subtask}`,
            "",
            "WORKER_OUTPUT:",
            attempt.output,
            ...diffSection,
            ...gateSection,
            "",
            "WATCH_QUESTIONS (Fresh-Eyes & Watch Checklist):",
            watchChecklist,
            "",
            "If the attempt satisfies the subtask and is CLEAR on all 5 WATCH_QUESTIONS, reply immediately on a single line with: VERDICT: APPROVE — <1 sentence summary>. Reply VERDICT: CHALLENGE — <reason> if the output is empty, contradictory, fabricates claims, or triggers any WATCH_QUESTIONS concern (such as test-weakened, destructive-writes, stuck-loop, scope-creep, or secret-leak).",
          ].join("\n"),
          cwd: attempt.worktreeDir ?? input.cwd,
          timeoutMs: input.timeoutMs,
          runner: input.openCodeRunner,
        });
        const eyeParsed = parseEyeAnswer(councilRes.stdout);
        const isChallenge =
          /VERDICT:\s*CHALLENGE/i.test(councilRes.stdout) || eyeParsed.outcome === "concern";
        const note: BurnCouncilNote = {
          reviewerModel: reviewer.id,
          reviewerFamily: reviewer.family,
          targetAttemptId: attempt.id,
          targetModel: attempt.model,
          verdict: isChallenge ? "challenge" : "approve",
          critique: councilRes.stdout || "Approved by cross-family Council.",
          citationsVerified: attempt.citationResult ? attempt.citationResult.ok : true,
        };
        return note;
      }),
    );

    input.councilNotes.push(...notesForAttempt);
    const challenges = notesForAttempt.filter((n) => n.verdict === "challenge").length;
    if (challenges > 0 && challenges >= Math.ceil(notesForAttempt.length / 2)) {
      attempt.accepted = false;
      attempt.rejectionReason = "Challenged by cross-family Council";
    }
  }
}

function modelBranchSlug(modelId: string): string {
  const shortId = modelId.startsWith("opencode/") ? modelId.slice("opencode/".length) : modelId;
  return shortId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

function prepareIsolatedWorktree(
  projectRoot: string,
  destDir: string,
  branchName: string,
): { worktreeDir: string; branchName?: string } {
  mkdirSync(dirname(destDir), { recursive: true });
  const upstreamFactoryRoot = resolve(DEFAULT_UPSTREAM_ISSUES_DIR, "../../..");
  const isUpstreamFactoryRepo = resolve(projectRoot) === upstreamFactoryRoot;
  let createdBranch: string | undefined;
  if (!isUpstreamFactoryRepo) {
    try {
      execFileSync("git", ["worktree", "add", "-B", branchName, destDir, "HEAD"], {
        cwd: projectRoot,
        env: buildExtendedPathEnv(),
        stdio: "ignore",
        timeout: 10_000,
      });
      createdBranch = branchName;
    } catch {
      // fall back to directory copy below
    }
  }
  if (!createdBranch) {
    mkdirSync(destDir, { recursive: true });
    if (existsSync(projectRoot)) {
      cpSync(projectRoot, destDir, {
        recursive: true,
        filter: (src) => {
          const base = basename(src);
          return base !== "node_modules" && base !== ".git";
        },
      });
    }
  }

  const parentNodeModules = join(projectRoot, "node_modules");
  const destNodeModules = join(destDir, "node_modules");
  if (existsSync(parentNodeModules) && !existsSync(destNodeModules)) {
    try {
      symlinkSync(
        parentNodeModules,
        destNodeModules,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      // ignore symlink failure
    }
  }
  return { worktreeDir: destDir, branchName: createdBranch };
}

function commitWorktreeChanges(
  worktreeDir: string,
  playbook: BurnPlaybook,
  attemptId: string,
  tryNum: number,
): string | undefined {
  const initialHead = headCommitSync(worktreeDir);
  if (!initialHead) return undefined;
  try {
    execFileSync("git", ["add", "-A"], {
      cwd: worktreeDir,
      env: buildExtendedPathEnv(),
      stdio: "ignore",
      timeout: 10_000,
    });
    const statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreeDir,
      encoding: "utf8",
      env: buildExtendedPathEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (statusOut.length > 0) {
      execFileSync(
        "git",
        [
          "-c",
          "user.email=burn-lab@local",
          "-c",
          "user.name=Factory Burn Lab",
          "commit",
          "-m",
          `burn(${playbook}): ${attemptId} try ${tryNum}`,
        ],
        {
          cwd: worktreeDir,
          env: buildExtendedPathEnv(),
          stdio: "ignore",
          timeout: 10_000,
        },
      );
    }
  } catch {
    // ignore commit failure
  }
  return headCommitSync(worktreeDir) ?? initialHead;
}

function mirrorRunScopedLedger(factoryStateDir: string, projectSlug: string): void {
  try {
    const scopedLedger = join(projectStateDir(factoryStateDir, projectSlug), "ledger.jsonl");
    if (existsSync(scopedLedger)) {
      cpSync(scopedLedger, join(factoryStateDir, "ledger.jsonl"));
    }
  } catch {
    // best-effort mirror
  }
}

async function executeCoderAttemptWithFactory(input: {
  runFactory: Factory;
  factoryStateDir: string;
  projectSlug: string;
  runId: string;
  playbook: BurnPlaybook;
  hostRoot: string;
  artifactDir: string;
  attemptId: string;
  model: FreeModelRecord;
  subtask: string;
  basePromptLines: string[];
  effectiveGateCommand: string;
  artifact: string;
  scope?: string[];
  citationRequired: boolean;
  maxAttempts: number;
  timeoutMs: number;
  openCodeRunner?: OpenCodeRunner;
  customGateRunner?: GateRunner;
}): Promise<BurnAttemptRecord> {
  const baseCommit = headCommitSync(input.hostRoot);
  const desiredBranch = `burn/${input.runId}/${modelBranchSlug(input.model.id)}`;
  const desiredWorktreeDir = join(input.artifactDir, "worktrees", input.attemptId);

  const prepared = prepareTaskWorktree({
    stateDir: input.factoryStateDir,
    workspace: input.hostRoot,
    task: input.attemptId,
    base: baseCommit,
    worktreePath: desiredWorktreeDir,
    branchName: desiredBranch,
    symlinkNodeModules: true,
  });

  let worktreeDir: string;
  let branchName: string | undefined;
  if (prepared.ok) {
    worktreeDir = prepared.path;
    branchName = prepared.branch;
  } else {
    const fallback = prepareIsolatedWorktree(input.hostRoot, desiredWorktreeDir, desiredBranch);
    worktreeDir = fallback.worktreeDir;
    branchName = fallback.branchName;
  }

  const wtHead = headCommitSync(worktreeDir);
  const canUseFactory = Boolean(wtHead);
  const contractGate = input.customGateRunner
    ? 'node -e "process.exit(0)"'
    : input.effectiveGateCommand;

  if (canUseFactory) {
    input.runFactory.setContract({
      task: input.attemptId,
      workspace: worktreeDir,
      gate: contractGate,
      artifact: input.artifact || ".",
      ...(input.scope && input.scope.length > 0 ? { scope: input.scope } : {}),
      description: input.subtask,
      by: "supervisor",
    });
    input.runFactory.requestSpawn({
      task: input.attemptId,
      provider: input.model.id,
      arity: 1,
      worktree: worktreeDir,
    });
    mirrorRunScopedLedger(input.factoryStateDir, input.projectSlug);
  }

  let attemptCount = 0;
  let totalLatencyMs = 0;
  let lastOutput = "";
  let lastOk = false;
  let claimedCommit: string | undefined;
  let diffPatch: string | undefined;
  let changedFilesList: string[] | undefined;
  let factoryVerdict: "green" | "red" | undefined;
  let factoryReportPath: string | undefined;
  let gateResult: GateRunResult | undefined;
  let citationResult: CitationGateResult | undefined;
  let accepted = false;
  let rejectionReason: string | undefined;
  let lastDiagnostic = "";

  for (let tryNum = 1; tryNum <= input.maxAttempts; tryNum++) {
    attemptCount = tryNum;
    const promptLines = [...input.basePromptLines];
    if (tryNum > 1 && lastDiagnostic) {
      promptLines.push(
        "",
        `REWORK_ATTEMPT (${tryNum}/${input.maxAttempts}): Your previous attempt failed verification with the following diagnostics:`,
        lastDiagnostic,
        "Fix the issues above in the worktree so the Gate, scope/memory fence, and citations pass cleanly.",
      );
    }

    const res = await runOpenCodeFreeModel({
      model: input.model.id,
      prompt: promptLines.join("\n"),
      cwd: worktreeDir,
      timeoutMs: input.timeoutMs,
      runner: input.openCodeRunner,
    });
    totalLatencyMs += res.latencyMs;
    lastOutput = res.stdout;
    lastOk = res.ok;

    claimedCommit = commitWorktreeChanges(worktreeDir, input.playbook, input.attemptId, tryNum);

    let claimOutcome: ClaimOutcome | undefined;
    if (canUseFactory && claimedCommit) {
      claimOutcome = await input.runFactory.claim({
        task: input.attemptId,
        sha: claimedCommit,
        agent: input.model.id,
      });
      factoryVerdict = claimOutcome.verdict;
      factoryReportPath = claimOutcome.reportPath;
      mirrorRunScopedLedger(input.factoryStateDir, input.projectSlug);
    }

    if (baseCommit && claimedCommit) {
      const diffRes = await diffBetween(worktreeDir, baseCommit, claimedCommit);
      if (diffRes.ok) {
        diffPatch = diffRes.diff;
      }
      const filesRes = await changedFiles(worktreeDir, baseCommit, claimedCommit);
      if (filesRes.ok) {
        changedFilesList = filesRes.files;
      }
    }

    const rawGateLog =
      claimOutcome?.gate.outputPath && existsSync(claimOutcome.gate.outputPath)
        ? readFileSync(claimOutcome.gate.outputPath, "utf8").trim()
        : "";

    if (input.customGateRunner) {
      const customGate = await input.customGateRunner({
        command: input.effectiveGateCommand,
        cwd: worktreeDir,
        timeoutMs: input.timeoutMs,
      });
      if (claimOutcome && claimOutcome.verdict === "red") {
        factoryVerdict = "red";
        gateResult = {
          ok: false,
          command: input.effectiveGateCommand,
          exitCode: customGate.exitCode || 1,
          stdout: customGate.stdout,
          stderr: [claimOutcome.gate.note, customGate.stderr].filter(Boolean).join("\n"),
        };
      } else if (!customGate.ok) {
        factoryVerdict = "red";
        gateResult = customGate;
      } else {
        factoryVerdict = "green";
        gateResult = customGate;
      }
    } else if (claimOutcome) {
      const isGreen = claimOutcome.verdict === "green";
      gateResult = {
        ok: isGreen,
        command: input.effectiveGateCommand,
        exitCode: claimOutcome.gate.exit ?? (isGreen ? 0 : 1),
        stdout: isGreen ? (rawGateLog || claimOutcome.gate.note) : rawGateLog,
        stderr: isGreen ? "" : [claimOutcome.gate.note, rawGateLog].filter(Boolean).join("\n"),
      };
    } else {
      gateResult = await defaultGateRunner({
        command: input.effectiveGateCommand,
        cwd: worktreeDir,
        timeoutMs: input.timeoutMs,
      });
      factoryVerdict = gateResult.ok ? "green" : "red";
    }

    if (input.citationRequired) {
      citationResult = verifyCitations(input.hostRoot, lastOutput);
    }

    const citationOk = citationResult ? citationResult.ok : true;
    const gateAndFactoryOk = factoryVerdict === "green" && (gateResult ? gateResult.ok : true);
    accepted = lastOk && gateAndFactoryOk && citationOk;
    if (accepted) {
      rejectionReason = undefined;
      break;
    }

    if (!lastOk) {
      rejectionReason = "Free model invocation failed";
      lastDiagnostic = res.error ?? res.stderr ?? "Free model invocation failed";
    } else if (citationResult && !citationResult.ok) {
      const detail =
        citationResult.totalCitations === 0
          ? "0 citations found"
          : citationResult.invalidCitations.map((c) => `${c.raw} (${c.reason})`).join("; ");
      rejectionReason = `Citation gate failed: ${detail}`;
      lastDiagnostic = rejectionReason;
    } else {
      const noteDetail =
        claimOutcome?.verdict === "red"
          ? [claimOutcome.gate.note, rawGateLog].filter(Boolean).join("\n")
          : [gateResult?.stderr, gateResult?.stdout].filter(Boolean).join("\n");
      const prefix = input.playbook === "oss-lab" ? "PoC Gate failed" : "Gate failed";
      rejectionReason = `${prefix} (exit ${gateResult?.exitCode ?? 1})${noteDetail ? `: ${noteDetail}` : ""}`;
      lastDiagnostic = rejectionReason;
    }
  }

  return {
    id: input.attemptId,
    model: input.model.id,
    family: input.model.family,
    role: "coder",
    subtask: input.subtask,
    ok: lastOk,
    attemptCount,
    latencyMs: totalLatencyMs,
    output: lastOutput,
    worktreeDir,
    branchName,
    baseCommit,
    claimedCommit,
    diffPatch,
    changedFiles: changedFilesList,
    factoryVerdict,
    factoryReportPath,
    gateResult,
    citationResult,
    accepted,
    rejectionReason,
  };
}

function finalizeWorktreeBranches(
  projectRoot: string,
  attempts: BurnAttemptRecord[],
  winningBranch?: string,
): void {
  for (const attempt of attempts) {
    if (attempt.worktreeDir) {
      const symlinkedNm = join(attempt.worktreeDir, "node_modules");
      try {
        rmSync(symlinkedNm, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", attempt.worktreeDir], {
          cwd: projectRoot,
          env: buildExtendedPathEnv(),
          stdio: "ignore",
          timeout: 10_000,
        });
      } catch {
        rmSync(attempt.worktreeDir, { recursive: true, force: true });
        try {
          execFileSync("git", ["worktree", "prune"], {
            cwd: projectRoot,
            env: buildExtendedPathEnv(),
            stdio: "ignore",
            timeout: 5_000,
          });
        } catch {
          // ignore
        }
      }
    }

    if (attempt.branchName && attempt.branchName !== winningBranch) {
      try {
        execFileSync("git", ["branch", "-D", attempt.branchName], {
          cwd: projectRoot,
          env: buildExtendedPathEnv(),
          stdio: "ignore",
          timeout: 5_000,
        });
      } catch {
        // ignore if branch was not created
      }
    }
  }
}

function updateFreePoolStatsFromAttempts(paseoHome: string, attempts: BurnAttemptRecord[]): void {
  if (attempts.length === 0) return;
  const pool = loadFreePool(paseoHome);
  if (pool.models.length === 0) return;

  const byId = new Map(pool.models.map((m) => [m.id, m]));
  let mutated = false;

  for (const att of attempts) {
    const rec = byId.get(att.model);
    if (!rec) continue;
    rec.attempts += 1;
    if (att.accepted) {
      rec.wins += 1;
    }
    mutated = true;
  }

  if (mutated) {
    pool.updatedAt = new Date().toISOString();
    saveFreePool(paseoHome, pool);
  }
}

export async function runBurnPlaybook(input: {
  paseoHome: string;
  playbook: BurnPlaybook;
  prompt: string;
  projectSlug?: string;
  targetRepo?: string;
  gateCommand?: string;
  maxAttempts?: number;
  upstreamIssuesDir?: string;
  upstreamGap?: {
    slug: string;
    title: string;
    problem: string;
    proposedChange: string;
    whyItMatters?: string;
  };
  supervisorRunner?: SupervisorRunner;
  openCodeRunner?: OpenCodeRunner;
  gateRunner?: GateRunner;
  scoutProbeRunner?: ScoutProbeRunner;
  preflightRunner?: () => Promise<UnattendedPreflightState> | UnattendedPreflightState;
  listOutput?: string;
  cachePath?: string;
  timeoutMs?: number;
}): Promise<BurnRunRecord> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const effectiveMaxAttempts = Math.max(1, Math.min(MAX_ATTEMPTS, input.maxAttempts ?? 2));
  const projects = resolveBurnProjects(input.paseoHome);
  const project: BurnProject =
    (input.projectSlug ? projects.find((p) => p.slug === input.projectSlug) : undefined) ??
    projects[0] ?? {
      slug: "factory-burn-lab-default",
      name: "factory-burn-lab",
      root: DEFAULT_SELF_REPO_ROOT,
      supervisorLane: resolveSupervisorLane(input.paseoHome, input.projectSlug),
      source: "burn-lab",
    };

  const runId = `burn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const artifactDir = burnRunArtifactDir(input.paseoHome, runId);
  mkdirSync(artifactDir, { recursive: true });

  const run: BurnRunRecord = {
    id: runId,
    playbook: input.playbook,
    projectSlug: project.slug,
    projectRoot: project.root,
    supervisorLane: project.supervisorLane,
    prompt: input.prompt,
    targetRepo: input.targetRepo,
    gateCommand: input.gateCommand,
    status: "queued",
    statusHistory: ["queued"],
    createdAt: now,
    updatedAt: now,
    attempts: [],
    councilNotes: [],
  };

  const transition = (nextStatus: BurnRunStatus) => {
    run.status = nextStatus;
    if (run.statusHistory[run.statusHistory.length - 1] !== nextStatus) {
      run.statusHistory.push(nextStatus);
    }
    run.updatedAt = new Date().toISOString();
    saveBurnRun(input.paseoHome, run);
  };

  saveBurnRun(input.paseoHome, run);

  const execSupervisor = input.supervisorRunner ?? defaultSupervisorRunner;
  let worktreeHostRoot = project.root;
  const isMockedRun = Boolean(input.supervisorRunner || input.openCodeRunner || input.scoutProbeRunner);
  const sleepAssertion = acquireSleepAssertion({ spawnProcess: !isMockedRun });

  try {
    // Tier 0: Unattended Preflight & Eager Folder Access Check
    if (input.preflightRunner) {
      const preflight = await input.preflightRunner();
      if (preflight.shipItStaleBinary || !preflight.projectRootAccessible) {
        throw new Error(
          preflight.issues[0] ?? "Unattended preflight failed before starting Burn run",
        );
      }
    } else if (!isMockedRun) {
      const preflight = await runUnattendedWarmup({
        projectRoot: project.root,
        upstreamIssuesDir: input.upstreamIssuesDir ?? DEFAULT_UPSTREAM_ISSUES_DIR,
        skipNetworkProbe: true,
      });
      if (preflight.shipItStaleBinary || !preflight.projectRootAccessible) {
        throw new Error(
          preflight.issues[0] ?? "Unattended preflight failed before starting Burn run",
        );
      }
    } else if (existsSync(project.root)) {
      readdirSync(project.root);
      const nmDir = join(project.root, "node_modules");
      if (existsSync(nmDir)) {
        readdirSync(nmDir);
      }
    }

    // Tier 1: Strong Supervisor Framing
    transition("framing");
    const framingRes = await execSupervisor({
      lane: project.supervisorLane,
      phase: "framing",
      playbook: input.playbook,
      project,
      prompt: [
        `You are the strong Supervisor (${project.supervisorLane}) for Project ${project.name} (${project.root}).`,
        `Frame the ${input.playbook} Burn run for brief: ${input.prompt}`,
        `Respond with JSON: {"goal": "...", "subtasks": ["..."], "gateCommand": "...", "artifact": "...", "scope": ["..."], "citationRequired": boolean}`,
      ].join("\n"),
      cwd: project.root,
      timeoutMs,
      paseoHome: input.paseoHome,
    });
    if (!framingRes.ok) {
      throw new Error(framingRes.error ?? framingRes.stderr ?? "Supervisor framing failed");
    }

    const framingTargetRoot =
      input.playbook === "self-evolve" && existsSync(DEFAULT_SELF_REPO_ROOT) && !input.projectSlug
        ? DEFAULT_SELF_REPO_ROOT
        : project.root;

    run.framing = parseFramingOutput(
      framingRes.stdout,
      input.playbook,
      input.prompt,
      framingTargetRoot,
      input.gateCommand,
    );
    saveBurnRun(input.paseoHome, run);

    // Tier 2: Free Pool Swarm Execution & Mechanical Verification Fence
    transition("swarm-running");

    if (input.playbook === "scout-pool") {
      const poolState = await scoutFreePool({
        paseoHome: input.paseoHome,
        probeRunner: input.scoutProbeRunner,
        openCodeRunner: input.openCodeRunner,
        listOutput: input.listOutput,
        cachePath: input.cachePath,
        timeoutMs,
      });

      transition("verifying");
      run.attempts = poolState.models.map((m, idx) => ({
        id: `attempt-${idx + 1}`,
        model: m.id,
        family: m.family,
        role: m.roles[0] ?? "reader-1m",
        subtask: "Scout liveness, code-fix Gate, and Citation gate micro-battery",
        ok: m.healthy,
        attemptCount: 1,
        latencyMs: m.latencyMs ?? 0,
        output: `healthy=${m.healthy} roles=[${m.roles.join(",")}] gate=${m.gatePassed} citation=${m.citationPassed}`,
        accepted: m.healthy && (m.gatePassed || m.citationPassed || m.roles.length > 0),
        rejectionReason: m.healthy ? undefined : (m.error ?? "unhealthy"),
      }));
    } else if (input.playbook === "oss-lab") {
      let inspectRepoRoot = project.root;
      if (input.targetRepo) {
        if (existsSync(input.targetRepo)) {
          inspectRepoRoot = resolve(input.targetRepo);
        } else if (/^(?:https?:\/\/|git@)/i.test(input.targetRepo)) {
          const cloneDir = join(artifactDir, "oss-repo");
          try {
            execFileSync("git", ["clone", "--depth", "1", input.targetRepo, cloneDir], {
              env: buildExtendedPathEnv(),
              stdio: "ignore",
              timeout: 30_000,
            });
            inspectRepoRoot = cloneDir;
          } catch {
            inspectRepoRoot = project.root;
          }
        }
      }
      worktreeHostRoot = inspectRepoRoot;

      const repoExcerpts = buildSmartRepoExcerpts(
        inspectRepoRoot,
        input.prompt,
        run.framing?.subtasks ?? [],
      );

      const effectiveGateCommand =
        input.gateCommand ??
        run.framing?.gateCommand ??
        inferDefaultGate(inspectRepoRoot, input.playbook);
      const effectiveArtifact =
        run.framing?.artifact ?? inferDefaultArtifact(inspectRepoRoot);

      const factoryStateDir = join(artifactDir, "factory");
      const runFactory = createFactory({
        stateDir: factoryStateDir,
        projectSlug: project.slug,
        timeoutMs,
      });

      const coderModels = selectSwarmModels(input.paseoHome, "coder", 1);
      const allReaders = selectSwarmModels(input.paseoHome, "reader-1m", 3);
      const distinctReaders = allReaders
        .filter((m) => !coderModels.some((c) => c.id === m.id))
        .slice(0, 2);

      const swarmAssignments: Array<{ model: FreeModelRecord; role: SwarmRole }> = [
        ...distinctReaders.map((model) => ({ model, role: "reader-1m" as SwarmRole })),
        ...coderModels.map((model) => ({ model, role: "coder" as SwarmRole })),
      ];

      const completedAttempts = await Promise.all(
        swarmAssignments.map(async ({ model, role }, idx): Promise<BurnAttemptRecord> => {
          const attemptId = `attempt-${idx + 1}`;
          const subtask =
            role === "coder"
              ? `Build and verify runnable mini-PoC for: ${input.prompt}`
              : (run.framing?.subtasks[idx % (run.framing?.subtasks.length || 1)] ?? input.prompt);

          const basePromptLines = [
            `You are a ${model.family} ${role} Free model in OSS Lab.`,
            "Do not call any tools (do not call read, glob, grep, or bash). Answer directly from the file excerpts below.",
            `Subtask: ${subtask}`,
            `Inspected repository: ${inspectRepoRoot}`,
            ...(role === "coder" ? [`Mini-PoC Gate command: ${effectiveGateCommand}`] : []),
            `Every architectural claim MUST include exact [path:startLine-endLine] citations ONLY to the real files shown below within their valid line counts (e.g. [README.md:1-2]). Never write bracketed [path:line] for any other filename.`,
            "",
            ...repoExcerpts,
          ];

          if (role === "coder") {
            return executeCoderAttemptWithFactory({
              runFactory,
              factoryStateDir,
              projectSlug: project.slug,
              runId,
              playbook: input.playbook,
              hostRoot: inspectRepoRoot,
              artifactDir,
              attemptId,
              model,
              subtask,
              basePromptLines,
              effectiveGateCommand,
              artifact: effectiveArtifact,
              scope: run.framing?.scope,
              citationRequired: true,
              maxAttempts: effectiveMaxAttempts,
              timeoutMs,
              openCodeRunner: input.openCodeRunner,
              customGateRunner: input.gateRunner,
            });
          }

          // reader-1m attempt with citation self-repair rework loop
          let attemptCount = 0;
          let totalLatencyMs = 0;
          let lastOutput = "";
          let lastOk = false;
          let citationResult: CitationGateResult = {
            ok: false,
            totalCitations: 0,
            validCitations: [],
            invalidCitations: [],
          };
          let gateResult: GateRunResult | undefined;
          let accepted = false;
          let rejectionReason: string | undefined;
          let lastDiagnostic = "";

          for (let tryNum = 1; tryNum <= effectiveMaxAttempts; tryNum++) {
            attemptCount = tryNum;
            const promptLines = [...basePromptLines];
            if (tryNum > 1 && lastDiagnostic) {
              promptLines.push(
                "",
                `REWORK_ATTEMPT (${tryNum}/${effectiveMaxAttempts}): Your previous response failed the Citation gate:`,
                lastDiagnostic,
                "Re-answer using ONLY valid [path:startLine-endLine] citations from the excerpts above.",
              );
            }

            const res = await runOpenCodeFreeModel({
              model: model.id,
              prompt: promptLines.join("\n"),
              cwd: inspectRepoRoot,
              timeoutMs,
              runner: input.openCodeRunner,
            });
            totalLatencyMs += res.latencyMs;
            lastOutput = res.stdout;
            lastOk = res.ok;

            citationResult = verifyCitations(inspectRepoRoot, lastOutput);
            if (input.gateCommand) {
              const execGate = input.gateRunner ?? defaultGateRunner;
              gateResult = await execGate({
                command: effectiveGateCommand,
                cwd: inspectRepoRoot,
                timeoutMs,
              });
            }
            const gateOk = gateResult ? gateResult.ok : true;
            accepted = lastOk && citationResult.ok && gateOk;
            if (accepted) {
              rejectionReason = undefined;
              break;
            }

            if (!lastOk) {
              rejectionReason = "Free model invocation failed";
              lastDiagnostic = res.error ?? res.stderr ?? rejectionReason;
            } else if (!citationResult.ok) {
              const detail =
                citationResult.totalCitations === 0
                  ? "0 citations found"
                  : citationResult.invalidCitations.map((c) => `${c.raw} (${c.reason})`).join("; ");
              rejectionReason = `Citation gate failed: ${detail}`;
              lastDiagnostic = rejectionReason;
            } else {
              rejectionReason = `PoC Gate failed (exit ${gateResult?.exitCode ?? 1})`;
              lastDiagnostic = rejectionReason;
            }
          }

          return {
            id: attemptId,
            model: model.id,
            family: model.family,
            role,
            subtask,
            ok: lastOk,
            attemptCount,
            latencyMs: totalLatencyMs,
            output: lastOutput,
            citationResult,
            gateResult,
            accepted,
            rejectionReason,
          };
        }),
      );

      transition("verifying");
      run.attempts.push(...completedAttempts);

      await runCouncilCrossCheck({
        paseoHome: input.paseoHome,
        playbook: input.playbook,
        cwd: inspectRepoRoot,
        timeoutMs,
        openCodeRunner: input.openCodeRunner,
        attempts: run.attempts,
        councilNotes: run.councilNotes,
      });

      const winners = run.attempts
        .filter((a) => a.accepted)
        .sort((a, b) => a.latencyMs - b.latencyMs);
      if (winners[0]) {
        run.winningAttemptId = winners[0].id;
        run.winningModel = winners[0].model;
      }
      const winningCodeAttempt = winners.find((a) => a.branchName);
      if (winningCodeAttempt?.branchName) {
        run.winningBranch = winningCodeAttempt.branchName;
        if (winningCodeAttempt.claimedCommit) {
          run.winningCommit = winningCodeAttempt.claimedCommit;
        }
        run.landingStatus = "not_landed";
      }

      finalizeWorktreeBranches(
        inspectRepoRoot,
        run.attempts,
        inspectRepoRoot === project.root ? run.winningBranch : undefined,
      );
      updateFreePoolStatsFromAttempts(input.paseoHome, run.attempts);
    } else {
      // proto-arena, night-shift, self-evolve
      const arenaProjectRoot =
        input.playbook === "self-evolve" && existsSync(DEFAULT_SELF_REPO_ROOT) && !input.projectSlug
          ? DEFAULT_SELF_REPO_ROOT
          : project.root;
      worktreeHostRoot = arenaProjectRoot;
      const swarmModels = selectSwarmModels(input.paseoHome, "coder", 2);
      const gateCommand =
        input.gateCommand ??
        run.framing?.gateCommand ??
        inferDefaultGate(arenaProjectRoot, input.playbook);
      const effectiveArtifact =
        run.framing?.artifact ?? inferDefaultArtifact(arenaProjectRoot);

      const factoryStateDir = join(artifactDir, "factory");
      const runFactory = createFactory({
        stateDir: factoryStateDir,
        projectSlug: project.slug,
        timeoutMs,
      });

      const completedAttempts = await Promise.all(
        swarmModels.map(async (model, idx): Promise<BurnAttemptRecord> => {
          const attemptId = `attempt-${idx + 1}`;
          const subtask =
            run.framing?.subtasks[idx % (run.framing?.subtasks.length || 1)] ?? input.prompt;
          const basePromptLines = [
            `You are a ${model.family} coder Free model running playbook ${input.playbook}.`,
            `Subtask: ${subtask}`,
            `Gate command to satisfy: ${gateCommand}`,
            ...(run.framing?.scope && run.framing.scope.length > 0
              ? [`Allowed file scope: ${run.framing.scope.join(", ")}`]
              : []),
          ];

          return executeCoderAttemptWithFactory({
            runFactory,
            factoryStateDir,
            projectSlug: project.slug,
            runId,
            playbook: input.playbook,
            hostRoot: arenaProjectRoot,
            artifactDir,
            attemptId,
            model,
            subtask,
            basePromptLines,
            effectiveGateCommand: gateCommand,
            artifact: effectiveArtifact,
            scope: run.framing?.scope,
            citationRequired: Boolean(run.framing?.citationRequired),
            maxAttempts: effectiveMaxAttempts,
            timeoutMs,
            openCodeRunner: input.openCodeRunner,
            customGateRunner: input.gateRunner,
          });
        }),
      );

      transition("verifying");
      run.attempts.push(...completedAttempts);

      await runCouncilCrossCheck({
        paseoHome: input.paseoHome,
        playbook: input.playbook,
        cwd: arenaProjectRoot,
        timeoutMs,
        openCodeRunner: input.openCodeRunner,
        attempts: run.attempts,
        councilNotes: run.councilNotes,
      });

      const winners = run.attempts
        .filter((a) => a.accepted)
        .sort((a, b) => a.latencyMs - b.latencyMs);
      if (winners[0]) {
        run.winningAttemptId = winners[0].id;
        run.winningModel = winners[0].model;
        if (winners[0].branchName) {
          run.winningBranch = winners[0].branchName;
          if (winners[0].claimedCommit) {
            run.winningCommit = winners[0].claimedCommit;
          }
          run.landingStatus = "not_landed";
        }
      }

      finalizeWorktreeBranches(arenaProjectRoot, run.attempts, run.winningBranch);
      updateFreePoolStatsFromAttempts(input.paseoHome, run.attempts);
    }

    // If an upstream capability gap is flagged, file a needs-triage Upstream issue
    if (input.upstreamGap) {
      run.upstreamIssue = fileUpstreamIssue({
        issuesDir: input.upstreamIssuesDir ?? DEFAULT_UPSTREAM_ISSUES_DIR,
        ...input.upstreamGap,
      });
    }

    // Tier 3: Strong Supervisor Synthesis (ONLY over verified/accepted attempts!)
    transition("synthesizing");
    const verifiedAttempts = run.attempts.filter((a) => a.accepted);
    const verifiedEvidenceBlock =
      verifiedAttempts.length > 0
        ? verifiedAttempts
            .map(
              (a) =>
                `### Attempt ${a.id} (${a.model}, family=${a.family}, role=${a.role}, latency=${a.latencyMs}ms)\n${a.output}`,
            )
            .join("\n\n")
        : "No Free model attempts passed the verification fence.";

    const councilBlock =
      run.councilNotes.length > 0
        ? run.councilNotes
            .map(
              (c) =>
                `- Reviewer ${c.reviewerModel} (${c.reviewerFamily}) on ${c.targetAttemptId}: ${c.verdict.toUpperCase()} — ${c.critique}`,
            )
            .join("\n")
        : "No Council notes recorded.";

    const synthesisRes = await execSupervisor({
      lane: project.supervisorLane,
      phase: "synthesizing",
      playbook: input.playbook,
      project,
      prompt: [
        `You are the strong Supervisor (${project.supervisorLane}) synthesizing the final deliverable for ${input.playbook}.`,
        `Original Brief: ${input.prompt}`,
        ...(run.winningBranch ? [`Verified Winning Branch: ${run.winningBranch}`] : []),
        "",
        "## Verified Evidence (Cleared by Mechanical Gate / Citation Gate / Council)",
        verifiedEvidenceBlock,
        "",
        "## Cross-Family Council Notes",
        councilBlock,
      ].join("\n"),
      cwd: project.root,
      timeoutMs,
      paseoHome: input.paseoHome,
    });
    if (!synthesisRes.ok) {
      throw new Error(synthesisRes.error ?? synthesisRes.stderr ?? "Supervisor synthesis failed");
    }

    const reportPath = join(artifactDir, "report.md");
    const reportMarkdown =
      synthesisRes.stdout.trim() ||
      `# Burn Report (${input.playbook})\n\n${verifiedEvidenceBlock}\n`;
    writeFileSync(reportPath, `${reportMarkdown}\n`, "utf8");

    run.reportPath = reportPath;
    run.reportMarkdown = reportMarkdown;
    run.completedAt = new Date().toISOString();
    transition("completed");
    return run;
  } catch (err) {
    finalizeWorktreeBranches(worktreeHostRoot, run.attempts, undefined);
    run.error = err instanceof Error ? err.message : String(err);
    transition("failed");
    return run;
  } finally {
    sleepAssertion.release();
  }
}
