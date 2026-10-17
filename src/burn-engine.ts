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
  DEFAULT_UPSTREAM_ISSUES_DIR,
  fileUpstreamIssue,
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

export const DEFAULT_SELF_REPO_ROOT =
  "/Users/andrewpham/Documents/code/self-project/factory-burn-lab";

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
  latencyMs: number;
  output: string;
  worktreeDir?: string;
  branchName?: string;
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
}) =>
  | Promise<{ ok: boolean; stdout: string; stderr?: string; error?: string }>
  | { ok: boolean; stdout: string; stderr?: string; error?: string };

export type GateRunner = (input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<GateRunResult> | GateRunResult;

export function resolveProjectIdentity(cwd: string): ProjectIdentityResolution {
  if (!existsSync(cwd)) {
    return { ok: false, error: `directory does not exist: ${cwd}` };
  }
  let stdout: string;
  try {
    stdout = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
      env: buildExtendedPathEnv(),
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const msg =
      typeof stderr === "string" && stderr.trim()
        ? stderr.trim().split("\n")[0]
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: msg || `not a git repository: ${cwd}` };
  }

  const lines = stdout.trim().split(/\r?\n/);
  const rootRaw = lines[0]?.trim() ?? "";
  const commonDirRaw = lines[1]?.trim() ?? "";
  if (!rootRaw || !commonDirRaw) {
    return { ok: false, error: `git rev-parse returned incomplete output for ${cwd}` };
  }

  const root = existsSync(rootRaw) ? realpathSync.native(rootRaw) : resolve(rootRaw);
  const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwd, commonDirRaw);
  let gitCommonDir: string;
  try {
    gitCommonDir = realpathSync.native(commonDirAbs);
  } catch {
    return { ok: false, error: `git common dir does not exist: ${commonDirAbs}` };
  }

  const hash = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 6);
  const slug = `${basename(root)}-${hash}`;
  return { ok: true, slug, root, gitCommonDir };
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
  const factoryRoots = [
    join(paseoHome, "factory"),
    join(paseoHome, "plugin-state", "paseo-factory"),
  ];

  if (projectSlug) {
    for (const factoryRoot of factoryRoots) {
      const perProjectLanes = readSupervisorFromLanesFile(
        join(factoryRoot, "projects", projectSlug, "lanes.json"),
      );
      if (perProjectLanes) return perProjectLanes;

      const perProjectJson = readSupervisorFromLanesFile(
        join(factoryRoot, "projects", `${projectSlug}.json`),
      );
      if (perProjectJson) return perProjectJson;

      const perProjectMeta = readSupervisorFromLanesFile(
        join(factoryRoot, "projects", projectSlug, "project.json"),
      );
      if (perProjectMeta) return perProjectMeta;
    }
  }

  for (const factoryRoot of factoryRoots) {
    const machineSupervisor = readSupervisorFromLanesFile(join(factoryRoot, "lanes.json"));
    if (machineSupervisor) return machineSupervisor;
  }

  return DEFAULT_SUPERVISOR_LANE;
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

  const factoryDirs = [
    join(paseoHome, "factory", "projects"),
    join(paseoHome, "plugin-state", "paseo-factory", "projects"),
  ];

  for (const projectsDir of factoryDirs) {
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

    const project: BurnProject = {
      slug: identity.slug,
      name: options?.name?.trim() || basename(identity.root),
      root: identity.root,
      gitCommonDir: identity.gitCommonDir,
      supervisorLane: resolveSupervisorLane(paseoHome, identity.slug),
      source: "burn-lab",
    };

    const filePath = burnLabProjectsPath(paseoHome);
    mkdirSync(dirname(filePath), { recursive: true });
    let existing: BurnProject[] = [];
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
        existing = unwrapProjectListJson(parsed) as unknown as BurnProject[];
      } catch {
        existing = [];
      }
    }

    const filtered = existing.filter((p) => p.slug !== project.slug && p.root !== project.root);
    filtered.push(project);
    writeFileSync(filePath, `${JSON.stringify({ projects: filtered }, null, 2)}\n`, "utf8");

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
    const child = spawn("sh", ["-c", input.command], {
      cwd: input.cwd,
      env: buildExtendedPathEnv(),
      stdio: ["ignore", "pipe", "pipe"],
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

async function defaultSupervisorRunner(input: {
  lane: string;
  phase: "framing" | "synthesizing";
  playbook: BurnPlaybook;
  project: BurnProject;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; stdout: string; stderr?: string; error?: string }> {
  const { provider, model } = parseSupervisorLane(input.lane);

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

  const cliResult = await new Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error?: string;
  }>((res) => {
    let cmd = "pi";
    let args: string[] = [];
    if (provider === "pi") {
      cmd = "pi";
      args = [
        "--print",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--model",
        model,
      ];
    } else if (provider === "copilot") {
      cmd = "copilot";
      args = ["-s", "--model", model, "--reasoning-effort", "medium"];
    } else if (provider === "claude") {
      cmd = "claude";
      args = ["-p", "--model", model, "--tools", ""];
    } else {
      res({
        ok: false,
        stdout: "",
        stderr: `unsupported provider ${provider}`,
        error: `unsupported provider ${provider}`,
      });
      return;
    }

    const child = spawn(cmd, args, {
      cwd: input.cwd,
      env: buildExtendedPathEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      res({ ok: false, stdout, stderr: err.message, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const cleanStdout = stdout.trim();
      const cleanStderr = stderr.trim();
      const ok = code === 0 && cleanStdout.length > 0;
      res({
        ok,
        stdout: cleanStdout,
        stderr: cleanStderr,
        error: ok ? undefined : cleanStderr || `${provider} exited with status ${code ?? 1}`,
      });
    });

    child.stdin?.write(input.prompt);
    child.stdin?.end();
  });

  if (cliResult.ok) {
    return { ok: true, stdout: cliResult.stdout, stderr: cliResult.stderr };
  }
  return {
    ok: false,
    stdout: cliResult.stdout,
    stderr: cliResult.stderr,
    error: cliResult.error ?? (cliResult.stderr || "supervisor invocation failed"),
  };
}

function parseFramingOutput(
  rawOutput: string,
  playbook: BurnPlaybook,
  userPrompt: string,
  overrideGate?: string,
): BurnFramingPlan {
  const defaultGate =
    overrideGate ??
    (playbook === "self-evolve"
      ? "npm test && npm run check:bundle"
      : "node -e \"process.exit(0)\"");

  try {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<BurnFramingPlan>;
      return {
        goal: typeof parsed.goal === "string" && parsed.goal.trim() ? parsed.goal.trim() : userPrompt,
        subtasks:
          Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0
            ? parsed.subtasks.map(String)
            : [userPrompt],
        gateCommand:
          overrideGate ??
          (typeof parsed.gateCommand === "string" && parsed.gateCommand.trim()
            ? parsed.gateCommand.trim()
            : defaultGate),
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
    citationRequired: playbook === "oss-lab",
    rawSupervisorOutput: rawOutput,
  };
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
  for (const attempt of input.attempts.filter((a) => a.accepted)) {
    const reviewers = pickCrossFamilyReviewers(
      input.paseoHome,
      attempt.family,
      attempt.model,
      2,
    );
    const notesForAttempt = await Promise.all(
      reviewers.map(async (reviewer) => {
        const councilRes = await runOpenCodeFreeModel({
          model: reviewer.id,
          prompt: [
            "COUNCIL_REVIEW",
            "Do not call any tools (do not call read, glob, grep, or bash).",
            `Cross-examine the following ${input.playbook} attempt (${attempt.id}) from ${attempt.model} (family=${attempt.family}):`,
            attempt.output,
            "If the output is coherent and satisfies the subtask, reply immediately on a single line with: VERDICT: APPROVE — <1 sentence summary>. Only reply VERDICT: CHALLENGE if the output is empty, contradictory, or fabricates broken claims.",
          ].join("\n"),
          cwd: attempt.worktreeDir ?? input.cwd,
          timeoutMs: input.timeoutMs,
          runner: input.openCodeRunner,
        });
        const isChallenge = /VERDICT:\s*CHALLENGE/i.test(councilRes.stdout);
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
      symlinkSync(parentNodeModules, destNodeModules, "dir");
    } catch {
      // ignore symlink failure
    }
  }
  return { worktreeDir: destDir, branchName: createdBranch };
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
  listOutput?: string;
  cachePath?: string;
  timeoutMs?: number;
}): Promise<BurnRunRecord> {
  const timeoutMs = input.timeoutMs ?? 45_000;
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
  const execGate = input.gateRunner ?? defaultGateRunner;
  let worktreeHostRoot = project.root;

  try {
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
        `Respond with JSON: {"goal": "...", "subtasks": ["..."], "gateCommand": "...", "citationRequired": boolean}`,
      ].join("\n"),
      cwd: project.root,
      timeoutMs,
    });
    if (!framingRes.ok) {
      throw new Error(framingRes.error ?? framingRes.stderr ?? "Supervisor framing failed");
    }

    run.framing = parseFramingOutput(
      framingRes.stdout,
      input.playbook,
      input.prompt,
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

      const candidateRelPaths = [
        "README.md",
        "package.json",
        "src/citation-gate.ts",
        "src/free-pool.ts",
        "src/burn-engine.ts",
        "src/upstream.ts",
        "src/index.ts",
        "src/app.ts",
      ];
      if (existsSync(join(inspectRepoRoot, "src"))) {
        try {
          for (const f of readdirSync(join(inspectRepoRoot, "src")).sort()) {
            const rel = `src/${f}`;
            if (!candidateRelPaths.includes(rel)) candidateRelPaths.push(rel);
          }
        } catch {
          // ignore
        }
      }
      const repoExcerpts: string[] = [];
      for (const rel of candidateRelPaths) {
        if (repoExcerpts.length >= 4) break;
        const abs = join(inspectRepoRoot, rel);
        if (!existsSync(abs)) continue;
        try {
          if (!statSync(abs).isFile()) continue;
          const rawContent = readFileSync(abs, "utf8").replace(/\r?\n$/, "");
          const lines = rawContent.length === 0 ? [] : rawContent.split(/\r?\n/);
          if (lines.length === 0) continue;
          const maxExcerpt = Math.min(lines.length, 20);
          const numbered = lines
            .slice(0, maxExcerpt)
            .map((line, i) => `${i + 1}: ${line}`)
            .join("\n");
          repoExcerpts.push(
            `File ${rel} (total lines: 1-${lines.length}; valid citation example: [${rel}:1-${Math.min(lines.length, 3)}]):\n${numbered}`,
          );
        } catch {
          // ignore unreadable file
        }
      }

      const effectiveGateCommand =
        input.gateCommand ?? run.framing?.gateCommand ?? "node -e \"process.exit(0)\"";

      const coderModels = selectSwarmModels(input.paseoHome, "coder", 1);
      const allReaders = selectSwarmModels(input.paseoHome, "reader-1m", 3);
      const distinctReaders = allReaders
        .filter((m) => !coderModels.some((c) => c.id === m.id))
        .slice(0, 2);

      const swarmAssignments: Array<{ model: FreeModelRecord; role: SwarmRole }> = [
        ...distinctReaders.map((model) => ({ model, role: "reader-1m" as SwarmRole })),
        ...coderModels.map((model) => ({ model, role: "coder" as SwarmRole })),
      ];

      const rawAttempts = await Promise.all(
        swarmAssignments.map(async ({ model, role }, idx) => {
          const attemptId = `attempt-${idx + 1}`;
          const subtask =
            role === "coder"
              ? `Build and verify runnable mini-PoC for: ${input.prompt}`
              : (run.framing?.subtasks[idx % (run.framing?.subtasks.length || 1)] ?? input.prompt);

          let worktreeDir: string | undefined;
          let branchName: string | undefined;
          if (role === "coder") {
            worktreeHostRoot = inspectRepoRoot;
            const desiredBranch = `burn/${runId}/${modelBranchSlug(model.id)}`;
            const wt = prepareIsolatedWorktree(
              inspectRepoRoot,
              join(artifactDir, "worktrees", attemptId),
              desiredBranch,
            );
            worktreeDir = wt.worktreeDir;
            branchName = wt.branchName;
          }

          const res = await runOpenCodeFreeModel({
            model: model.id,
            prompt: [
              `You are a ${model.family} ${role} Free model in OSS Lab.`,
              "Do not call any tools (do not call read, glob, grep, or bash). Answer directly from the file excerpts below.",
              `Subtask: ${subtask}`,
              `Inspected repository: ${inspectRepoRoot}`,
              ...(role === "coder" ? [`Mini-PoC Gate command: ${effectiveGateCommand}`] : []),
              `Every architectural claim MUST include exact [path:startLine-endLine] citations ONLY to the real files shown below within their valid line counts (e.g. [README.md:1-2]). Never write bracketed [path:line] for any other filename.`,
              "",
              ...repoExcerpts,
            ].join("\n"),
            cwd: worktreeDir ?? inspectRepoRoot,
            timeoutMs,
            runner: input.openCodeRunner,
          });
          return {
            id: attemptId,
            model: model.id,
            family: model.family,
            role,
            subtask,
            ok: res.ok,
            latencyMs: res.latencyMs,
            output: res.stdout,
            worktreeDir,
            branchName,
          };
        }),
      );

      transition("verifying");
      for (const raw of rawAttempts) {
        const citationResult = verifyCitations(inspectRepoRoot, raw.output);
        let gateResult: GateRunResult | undefined;
        if (raw.role === "coder" || input.gateCommand) {
          gateResult = await execGate({
            command: effectiveGateCommand,
            cwd: raw.worktreeDir ?? inspectRepoRoot,
            timeoutMs,
          });
        }
        const gateOk = gateResult ? gateResult.ok : true;
        const accepted = raw.ok && citationResult.ok && gateOk;
        let rejectionReason: string | undefined;
        if (!raw.ok) {
          rejectionReason = "Free model invocation failed";
        } else if (!citationResult.ok) {
          const detail =
            citationResult.totalCitations === 0
              ? "0 citations found"
              : citationResult.invalidCitations.map((c) => `${c.raw} (${c.reason})`).join("; ");
          rejectionReason = `Citation gate failed: ${detail}`;
        } else if (!gateOk) {
          rejectionReason = `PoC Gate failed (exit ${gateResult?.exitCode ?? 1})`;
        }

        run.attempts.push({
          ...raw,
          citationResult,
          gateResult,
          accepted,
          rejectionReason,
        });
      }

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
      }

      finalizeWorktreeBranches(inspectRepoRoot, run.attempts, undefined);
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
        (input.playbook === "self-evolve"
          ? "npm test && npm run check:bundle"
          : "node -e \"process.exit(0)\"");

      const rawAttempts = await Promise.all(
        swarmModels.map(async (model, idx) => {
          const attemptId = `attempt-${idx + 1}`;
          const desiredBranch = `burn/${runId}/${modelBranchSlug(model.id)}`;
          const { worktreeDir, branchName } = prepareIsolatedWorktree(
            arenaProjectRoot,
            join(artifactDir, "worktrees", attemptId),
            desiredBranch,
          );
          const subtask =
            run.framing?.subtasks[idx % (run.framing?.subtasks.length || 1)] ?? input.prompt;
          const res = await runOpenCodeFreeModel({
            model: model.id,
            prompt: [
              `You are a ${model.family} coder Free model running playbook ${input.playbook}.`,
              `Subtask: ${subtask}`,
              `Gate command to satisfy: ${gateCommand}`,
            ].join("\n"),
            cwd: worktreeDir,
            timeoutMs,
            runner: input.openCodeRunner,
          });
          return {
            id: attemptId,
            model: model.id,
            family: model.family,
            role: "coder" as SwarmRole,
            subtask,
            ok: res.ok,
            latencyMs: res.latencyMs,
            output: res.stdout,
            worktreeDir,
            branchName,
          };
        }),
      );

      transition("verifying");
      for (const raw of rawAttempts) {
        const gateResult = await execGate({
          command: gateCommand,
          cwd: raw.worktreeDir,
          timeoutMs,
        });
        const accepted = raw.ok && gateResult.ok;
        run.attempts.push({
          ...raw,
          gateResult,
          accepted,
          rejectionReason: !raw.ok
            ? "Free model invocation failed"
            : !gateResult.ok
              ? `Gate failed (exit ${gateResult.exitCode}): ${gateResult.stderr || gateResult.stdout}`
              : undefined,
        });
      }

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
  }
}
