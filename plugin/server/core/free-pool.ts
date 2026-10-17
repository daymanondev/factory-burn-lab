import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyCitations } from "./citation-gate.ts";

export type SwarmRole = "coder" | "reader-1m" | "reviewer";

export interface FreeModelRecord {
  id: string;
  family: string;
  displayName: string;
  contextWindow: number;
  healthy: boolean;
  latencyMs: number | null;
  gatePassed: boolean;
  citationPassed: boolean;
  roles: SwarmRole[];
  wins: number;
  attempts: number;
  lastScoutedAt: string | null;
  error?: string | null;
}

export interface FreePoolState {
  updatedAt: string;
  models: FreeModelRecord[];
}

export interface OpenCodeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  latencyMs: number;
  error?: string;
}

export type OpenCodeRunner = (input: {
  model: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<OpenCodeRunResult> | OpenCodeRunResult;

export interface ScoutProbeResult {
  healthy: boolean;
  latencyMs: number;
  gatePassed?: boolean;
  citationPassed?: boolean;
  codeOutput?: string;
  citationOutput?: string;
  error?: string;
}

export type ScoutProbeRunner = (
  model: FreeModelRecord,
  context: { fixtureRepoDir: string },
) => Promise<ScoutProbeResult> | ScoutProbeResult;

const DEFAULT_CONTEXT_WINDOW = 200_000;
const KNOWN_FREE_SHORT_IDS = new Set(["big-pickle"]);
const STOP_FAMILY_TOKENS = new Set([
  "flash",
  "ultra",
  "lightning",
  "super",
  "preview",
  "large",
  "mini",
  "pro",
  "codex",
  "free",
  "vl",
  "coder",
  "thinking",
]);

export function extractModelFamily(modelId: string): string {
  const shortId = (modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId)
    .trim()
    .toLowerCase()
    .replace(/-free$/, "");

  const parts = shortId.split("-").filter(Boolean);
  const familyParts: string[] = [];

  for (const part of parts) {
    if (/^[kmv]?\d+(\.\d+)*$/i.test(part) || STOP_FAMILY_TOKENS.has(part)) {
      break;
    }
    familyParts.push(part);
  }

  if (familyParts.length === 0) {
    return parts[0] ?? shortId;
  }
  return familyParts.join("-");
}

export function freePoolPath(paseoHome: string): string {
  return join(paseoHome, "burn-lab", "free-pool.json");
}

export function loadFreePool(paseoHome: string): FreePoolState {
  const path = freePoolPath(paseoHome);
  if (!existsSync(path)) {
    return { updatedAt: new Date(0).toISOString(), models: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FreePoolState>;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      models: Array.isArray(parsed.models) ? parsed.models : [],
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), models: [] };
  }
}

export function saveFreePool(paseoHome: string, state: FreePoolState): void {
  const path = freePoolPath(paseoHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function resolveOpenCodeBinary(): string {
  const candidates: string[] = [];
  const home = homedir();
  const nvmDir = join(home, ".nvm", "versions", "node");
  if (existsSync(nvmDir)) {
    try {
      for (const ver of readdirSync(nvmDir).sort().reverse()) {
        candidates.push(join(nvmDir, ver, "bin", "opencode"));
      }
    } catch {
      // ignore
    }
  }
  candidates.push(
    join(home, ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "opencode";
}

export function buildExtendedPathEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extraPaths: string[] = [];
  const nvmDir = join(home, ".nvm", "versions", "node");
  if (existsSync(nvmDir)) {
    try {
      for (const ver of readdirSync(nvmDir).sort().reverse()) {
        extraPaths.push(join(nvmDir, ver, "bin"));
      }
    } catch {
      // ignore
    }
  }
  extraPaths.push(join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  const currentPath = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(":"),
  };
}

interface CacheModelEntry {
  id?: string;
  name?: string;
  family?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
  contextWindow?: number;
}

function readCacheMetadata(cachePath: string): Map<string, CacheModelEntry> {
  const map = new Map<string, CacheModelEntry>();
  if (!existsSync(cachePath)) return map;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    const opencodeProvider = raw.opencode as { models?: Record<string, CacheModelEntry> } | undefined;
    if (opencodeProvider?.models && typeof opencodeProvider.models === "object") {
      for (const [k, v] of Object.entries(opencodeProvider.models)) {
        if (v && typeof v === "object") {
          map.set(k, v);
          map.set(`opencode/${k}`, v);
        }
      }
    }
    const topModels = raw.models as Record<string, CacheModelEntry> | undefined;
    if (topModels && typeof topModels === "object") {
      for (const [k, v] of Object.entries(topModels)) {
        if (v && typeof v === "object") {
          map.set(k, v);
          if (!k.startsWith("opencode/")) map.set(`opencode/${k}`, v);
        }
      }
    }
    for (const [k, v] of Object.entries(raw)) {
      if (
        k !== "opencode" &&
        k !== "models" &&
        v &&
        typeof v === "object" &&
        ("limit" in v || "cost" in v || "contextWindow" in v)
      ) {
        map.set(k, v as CacheModelEntry);
      }
    }
  } catch {
    // ignore malformed cache
  }
  return map;
}

function isFreeOpenCodeModel(fullId: string, meta?: CacheModelEntry): boolean {
  if (!fullId.startsWith("opencode/")) return false;
  const shortId = fullId.slice("opencode/".length);
  if (shortId.endsWith("-free") || shortId.includes("-free-") || KNOWN_FREE_SHORT_IDS.has(shortId)) {
    return true;
  }
  if (meta?.cost && meta.cost.input === 0 && meta.cost.output === 0) {
    return true;
  }
  return false;
}

export function discoverFreePool(options?: {
  listOutput?: string;
  cachePath?: string;
  runner?: () => string;
}): FreeModelRecord[] {
  const cachePath = options?.cachePath ?? join(homedir(), ".cache", "opencode", "models.json");
  const cacheMap = readCacheMetadata(cachePath);

  let rawList = options?.listOutput;
  if (rawList === undefined) {
    if (options?.runner) {
      rawList = options.runner();
    } else {
      try {
        const bin = resolveOpenCodeBinary();
        rawList = execFileSync(bin, ["models"], {
          env: buildExtendedPathEnv(),
          encoding: "utf8",
          timeout: 15_000,
        });
      } catch {
        rawList = "";
      }
    }
  }

  const seen = new Set<string>();
  const records: FreeModelRecord[] = [];
  const lines = rawList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const token = line.split(/\s+/)[0] ?? "";
    if (!token.startsWith("opencode/") || seen.has(token)) continue;
    const shortId = token.slice("opencode/".length);
    const meta = cacheMap.get(token) ?? cacheMap.get(shortId);
    if (!isFreeOpenCodeModel(token, meta)) continue;

    seen.add(token);
    const contextWindow =
      typeof meta?.limit?.context === "number" && meta.limit.context > 0
        ? meta.limit.context
        : typeof meta?.contextWindow === "number" && meta.contextWindow > 0
          ? meta.contextWindow
          : shortId.includes("nemotron-3") || shortId.includes("1m")
            ? 1_000_000
            : DEFAULT_CONTEXT_WINDOW;

    records.push({
      id: token,
      family: extractModelFamily(token),
      displayName: meta?.name ?? shortId,
      contextWindow,
      healthy: false,
      latencyMs: null,
      gatePassed: false,
      citationPassed: false,
      roles: [],
      wins: 0,
      attempts: 0,
      lastScoutedAt: null,
      error: null,
    });
  }

  return records;
}

function defaultOpenCodeRunner(input: {
  model: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}): Promise<OpenCodeRunResult> {
  const startedAt = Date.now();
  const bin = resolveOpenCodeBinary();

  return new Promise((resolvePromise) => {
    const child = spawn(bin, ["run", "--standalone", "-m", input.model, input.prompt], {
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
        stdout,
        stderr,
        latencyMs: Date.now() - startedAt,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - startedAt;
      if (timedOut) {
        resolvePromise({
          ok: false,
          stdout,
          stderr,
          latencyMs,
          error: `timeout after ${input.timeoutMs}ms`,
        });
        return;
      }
      const combined = `${stdout}\n${stderr}`;
      if (code !== 0 || combined.includes("FreeTierError") || stdout.trim().length === 0) {
        resolvePromise({
          ok: false,
          stdout,
          stderr,
          latencyMs,
          error: stderr.trim() || `opencode exited with status ${code ?? 1}`,
        });
        return;
      }
      resolvePromise({
        ok: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        latencyMs,
      });
    });
  });
}

export async function runOpenCodeFreeModel(input: {
  model: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  runner?: OpenCodeRunner;
}): Promise<OpenCodeRunResult> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const ownsTempDir = input.cwd === undefined;
  const targetCwd = input.cwd ?? mkdtempSync(join(tmpdir(), "burn-opencode-run-"));

  try {
    const execRunner = input.runner ?? defaultOpenCodeRunner;
    return await execRunner({
      model: input.model,
      prompt: input.prompt,
      cwd: targetCwd,
      timeoutMs,
    });
  } finally {
    if (ownsTempDir) {
      rmSync(targetCwd, { recursive: true, force: true });
    }
  }
}

function evaluateCodeGateProbe(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (trimmed.includes("FIXED_SUM=6") || /\bsumPositive\b/.test(trimmed)) {
    return true;
  }
  return false;
}

export function assignSwarmRoles(input: {
  healthy: boolean;
  gatePassed: boolean;
  citationPassed: boolean;
  contextWindow: number;
}): SwarmRole[] {
  if (!input.healthy) return [];
  const roles: SwarmRole[] = [];
  if (input.gatePassed) roles.push("coder");
  if (input.contextWindow >= 200_000 || input.citationPassed) roles.push("reader-1m");
  if (input.citationPassed) roles.push("reviewer");
  return roles;
}

export async function scoutFreePool(input: {
  paseoHome: string;
  models?: string[];
  probeRunner?: ScoutProbeRunner;
  openCodeRunner?: OpenCodeRunner;
  listOutput?: string;
  cachePath?: string;
  timeoutMs?: number;
}): Promise<FreePoolState> {
  const existingState = loadFreePool(input.paseoHome);
  const existingById = new Map(existingState.models.map((m) => [m.id, m]));

  let discovered = discoverFreePool({
    listOutput: input.listOutput,
    cachePath: input.cachePath,
  });

  if (input.models && input.models.length > 0) {
    const requestedSet = new Set(input.models);
    const filtered = discovered.filter((m) => requestedSet.has(m.id));
    for (const modelId of input.models) {
      if (!filtered.some((m) => m.id === modelId)) {
        const shortId = modelId.startsWith("opencode/") ? modelId.slice("opencode/".length) : modelId;
        filtered.push({
          id: modelId,
          family: extractModelFamily(modelId),
          displayName: shortId,
          contextWindow: shortId.includes("nemotron-3") ? 1_000_000 : DEFAULT_CONTEXT_WINDOW,
          healthy: false,
          latencyMs: null,
          gatePassed: false,
          citationPassed: false,
          roles: [],
          wins: 0,
          attempts: 0,
          lastScoutedAt: null,
          error: null,
        });
      }
    }
    discovered = filtered;
  }

  const fixtureRepoDir = mkdtempSync(join(tmpdir(), "burn-scout-fixture-"));
  try {
    mkdirSync(join(fixtureRepoDir, "src"), { recursive: true });
    writeFileSync(
      join(fixtureRepoDir, "src", "math.ts"),
      [
        "export function sumPositive(values: number[]): number {",
        "  return values.filter((n) => n > 0).reduce((a, b) => a + b, 0);",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      join(fixtureRepoDir, "README.md"),
      "# Scout Fixture\nMicro-repository for Citation gate verification.\n",
      "utf8",
    );

    const now = new Date().toISOString();
    const updatedModels: FreeModelRecord[] = [];

    for (const candidate of discovered) {
      const prev = existingById.get(candidate.id);
      const baseWins = prev?.wins ?? 0;
      const baseAttempts = prev?.attempts ?? 0;

      let healthy = false;
      let latencyMs: number | null = null;
      let gatePassed = false;
      let citationPassed = false;
      let errorMsg: string | null = null;

      if (input.probeRunner) {
        const probe = await input.probeRunner(candidate, { fixtureRepoDir });
        healthy = Boolean(probe.healthy);
        latencyMs = probe.latencyMs;
        gatePassed =
          probe.gatePassed !== undefined
            ? probe.gatePassed
            : healthy && evaluateCodeGateProbe(probe.codeOutput ?? "");
        citationPassed =
          probe.citationPassed !== undefined
            ? probe.citationPassed
            : healthy && verifyCitations(fixtureRepoDir, probe.citationOutput ?? "").ok;
        errorMsg = probe.error ?? null;
      } else {
        const prompt = [
          "You are being benchmarked by factory-burn-lab Scout pool.",
          "Do not call any tools. Reply with a single line containing:",
          "FIXED_SUM=6 and the exact citation [src/math.ts:1-3]",
        ].join(" ");
        const runRes = await runOpenCodeFreeModel({
          model: candidate.id,
          prompt,
          cwd: fixtureRepoDir,
          timeoutMs: input.timeoutMs ?? 30_000,
          runner: input.openCodeRunner,
        });
        healthy = runRes.ok;
        latencyMs = runRes.latencyMs;
        gatePassed = runRes.ok && evaluateCodeGateProbe(runRes.stdout);
        citationPassed = runRes.ok && verifyCitations(fixtureRepoDir, runRes.stdout).ok;
        errorMsg = runRes.error ?? null;
      }

      const roles = assignSwarmRoles({
        healthy,
        gatePassed,
        citationPassed,
        contextWindow: candidate.contextWindow,
      });

      const won = healthy && (gatePassed || citationPassed);
      updatedModels.push({
        ...candidate,
        healthy,
        latencyMs,
        gatePassed,
        citationPassed,
        roles,
        wins: baseWins + (won ? 1 : 0),
        attempts: baseAttempts + 1,
        lastScoutedAt: now,
        error: errorMsg,
      });
    }

    const nextState: FreePoolState = {
      updatedAt: now,
      models: updatedModels,
    };
    saveFreePool(input.paseoHome, nextState);
    return nextState;
  } finally {
    rmSync(fixtureRepoDir, { recursive: true, force: true });
  }
}
