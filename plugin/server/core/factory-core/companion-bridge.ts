/**
 * Companion bridge for `paseo-factory` pure-Node core (`ADR 0003` & `v0.0.18`):
 * exposes the shared `Project` registry (`project.json` under `<stateDir>/projects/<slug>/`)
 * and `Task worktree` allocation (`prepareTaskWorktree` with `.worktreeinclude` copy,
 * per-worktree `core.excludesFile`, custom `worktreePath` / `branchName`, and
 * `symlinkNodeModules` support) inside the pure-Node `factory-core` barrel.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectStateDir, resolveProject } from "./project.ts";
import { headCommitSync } from "./workspace.ts";

const GIT_TIMEOUT_MS = 15_000;

/** One project's registry entry — the root binding, optional display name, and seat agent ids. */
export interface ProjectRegistration {
  slug: string;
  root: string;
  name?: string;
  supervisor?: string;
  lead?: string;
}

function registrationPath(stateDir: string, slug: string): string {
  return join(projectStateDir(stateDir, slug), "project.json");
}

/** Reads `<stateDir>/projects/<slug>/project.json` — undefined when the project has no registry yet. */
export function readProjectRegistration(
  stateDir: string,
  slug: string,
): ProjectRegistration | undefined {
  const path = registrationPath(stateDir, slug);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectRegistration>;
    if (typeof parsed.root !== "string" || parsed.root === "") return undefined;
    return {
      slug,
      root: parsed.root,
      ...(typeof parsed.name === "string" && parsed.name.trim() !== ""
        ? { name: parsed.name.trim() }
        : {}),
      ...(typeof parsed.supervisor === "string" && parsed.supervisor !== ""
        ? { supervisor: parsed.supervisor }
        : {}),
      ...(typeof parsed.lead === "string" && parsed.lead !== "" ? { lead: parsed.lead } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Writes/updates one project's registration — merge by field: a string sets
 * the seat id or name, `null` clears it, `undefined` leaves it alone. The root
 * binding is always rewritten.
 */
export function writeProjectRegistration(
  stateDir: string,
  slug: string,
  patch: {
    root: string;
    name?: string | null;
    supervisor?: string | null;
    lead?: string | null;
  },
): void {
  const prior = readProjectRegistration(stateDir, slug);
  const name = patch.name === null ? undefined : (patch.name ?? prior?.name);
  const supervisor =
    patch.supervisor === null ? undefined : (patch.supervisor ?? prior?.supervisor);
  const lead = patch.lead === null ? undefined : (patch.lead ?? prior?.lead);
  const record: Record<string, string> = { root: patch.root };
  if (name !== undefined && name.trim() !== "") record.name = name.trim();
  if (supervisor !== undefined) record.supervisor = supervisor;
  if (lead !== undefined) record.lead = lead;
  mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
  writeFileSync(registrationPath(stateDir, slug), `${JSON.stringify(record, null, 2)}\n`);
}

/** Every registration on disk, slug order — the discovery source of record. */
export function listProjectRegistrations(stateDir: string): ProjectRegistration[] {
  const projectsDir = join(stateDir, "projects");
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out: ProjectRegistration[] = [];
  for (const slug of slugs) {
    const registration = readProjectRegistration(stateDir, slug);
    if (registration !== undefined) out.push(registration);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Every discovered project for the surface's Project Selector: the registry
 * files (durable, root always known) plus live seat agents the daemon lists
 * and Paseo's `<home>/projects/projects.json`.
 */
export function discoverProjects(
  stateDir: string,
  liveSeatAgents: readonly { labels: Record<string, string>; cwd: string }[] = [],
  home?: string,
): { slug: string; root: string | null }[] {
  const roots = new Map<string, string | null>();
  for (const registration of listProjectRegistrations(stateDir)) {
    roots.set(registration.slug, registration.root);
  }
  for (const agent of liveSeatAgents) {
    const slug = agent.labels.project;
    if (slug === undefined || agent.labels.seat === undefined) continue;
    if (!roots.has(slug)) roots.set(slug, agent.cwd);
  }
  if (home !== undefined) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(home, "projects", "projects.json"), "utf8"),
      ) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry === null || typeof entry !== "object") continue;
          const record = entry as { archivedAt?: unknown; rootPath?: unknown };
          if (
            record.archivedAt !== null ||
            typeof record.rootPath !== "string" ||
            record.rootPath === ""
          ) {
            continue;
          }
          const resolved = resolveProject(record.rootPath);
          if (resolved.ok && !roots.has(resolved.slug)) {
            roots.set(resolved.slug, resolved.root);
          }
        }
      }
    } catch {
      // missing or unreadable Paseo projects.json is ignored
    }
  }
  return [...roots.entries()]
    .map(([slug, root]) => ({ slug, root }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Where one task's worktree lives — the Project's isolated state tree. */
export function taskWorktreePath(stateDir: string, projectSlug: string, task: string): string {
  return `${stateDir}/projects/${projectSlug}/worktrees/${task}`;
}

/**
 * Recognizes a managed Task worktree cwd — or a directory inside one — and
 * names its project and task from the shape alone.
 */
export function parseTaskWorktreePath(
  stateDir: string,
  cwd: string,
): { slug: string; task: string } | null {
  const prefix = `${stateDir}/projects/`;
  if (typeof cwd !== "string" || !cwd.startsWith(prefix)) return null;
  const segments = cwd.slice(prefix.length).split("/");
  if (segments.length < 3) return null;
  const [slug, worktrees, task] = segments;
  if (slug === undefined || worktrees !== "worktrees" || task === undefined) return null;
  if (slug === "" || task === "") return null;
  return { slug, task };
}

/** The branch every task worktree runs on by default — `factory/<task>`. */
export function taskWorktreeBranch(task: string): string {
  return `factory/${task}`;
}

export interface PrepareTaskWorktreeOptions {
  stateDir: string;
  workspace: string;
  task: string;
  base?: string | null;
  /** Optional explicit worktree directory override (used by companion Best-of-N arenas). Defaults to taskWorktreePath(stateDir, project.slug, task). */
  worktreePath?: string;
  /** Optional explicit branch name override. Defaults to taskWorktreeBranch(task) (`factory/<task>`). */
  branchName?: string;
  /** When true and `<projectRoot>/node_modules` exists, creates a directory symlink (`junction` on win32, `dir` on POSIX) in the worktree and excludes `node_modules` in the per-worktree `factory-excludes` file so `checkCleanAt` stays clean. */
  symlinkNodeModules?: boolean;
}

export type PrepareTaskWorktreeResult =
  | { ok: true; path: string; branch: string; reset: boolean }
  | { ok: false; reason: string };

function gitIn(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
}

function firstLine(text: string): string {
  return text.trim() !== "" ? (text.trim().split("\n")[0] ?? "unknown git failure") : "unknown git failure";
}

function patternMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(file);
}

function collectCopiedWorktreeIncludes(root: string, worktreePath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(root, ".worktreeinclude"), "utf8");
  } catch {
    return [];
  }
  const patterns = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (patterns.length === 0) return [];
  const untracked = new Set<string>();
  for (const extra of [[], ["--ignored"]]) {
    const listed = gitIn(root, ["ls-files", "--others", "--exclude-standard", ...extra]);
    if (listed.error !== undefined || listed.status !== 0) continue;
    for (const line of listed.stdout.split("\n")) {
      const file = line.trim();
      if (file !== "") untracked.add(file);
    }
  }
  const copied: string[] = [];
  for (const file of untracked) {
    if (!patterns.some((pattern) => patternMatches(pattern, file))) continue;
    const from = join(root, file);
    const to = join(worktreePath, file);
    try {
      if (!statSync(from).isFile()) continue;
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      copied.push(file);
    } catch {
      // ignore uncopiable file
    }
  }
  return copied;
}

function writePerWorktreeExcludes(root: string, worktreePath: string, excluded: string[]): void {
  if (excluded.length === 0) return;
  try {
    const gitDirOut = gitIn(worktreePath, ["rev-parse", "--git-dir"]);
    if (gitDirOut.error !== undefined || gitDirOut.status !== 0) return;
    const gitDir = resolve(worktreePath, gitDirOut.stdout.trim());
    const excludesFile = join(gitDir, "factory-excludes");
    writeFileSync(excludesFile, `${excluded.join("\n")}\n`);
    gitIn(root, ["config", "extensions.worktreeConfig", "true"]);
    gitIn(worktreePath, ["config", "--worktree", "core.excludesFile", excludesFile]);
  } catch {
    // best-effort
  }
}

/**
 * Allocates or resets one task's linked worktree (ADR 0010 §4 & ADR 0003 §3):
 * tears down any previous registration at the path, then `git worktree add -B
 * <branch> <path> <base>`, copies `.worktreeinclude` files, optionally symlinks
 * `node_modules`, and records per-worktree `factory-excludes` so `checkCleanAt`
 * stays clean.
 */
export function prepareTaskWorktree(
  options: PrepareTaskWorktreeOptions,
): PrepareTaskWorktreeResult {
  const project = resolveProject(options.workspace);
  if (!project.ok) {
    return {
      ok: false,
      reason: `workspace "${options.workspace}" does not resolve to a git Project — ${project.reason}`,
    };
  }
  const root = project.root;
  const commit =
    options.base !== undefined && options.base !== null && /^[0-9a-f]{40}$/i.test(options.base)
      ? options.base
      : headCommitSync(root);
  if (commit === undefined) {
    return {
      ok: false,
      reason: `cannot resolve a base commit for the worktree of ${options.task} — ${options.workspace} has no HEAD`,
    };
  }
  const path =
    options.worktreePath !== undefined && options.worktreePath.trim() !== ""
      ? resolve(options.worktreePath)
      : taskWorktreePath(options.stateDir, project.slug, options.task);
  const reset = existsSync(path);
  if (reset) {
    const removed = gitIn(root, ["worktree", "remove", "--force", path]);
    if (removed.error !== undefined || removed.status !== 0) {
      rmSync(path, { recursive: true, force: true });
      gitIn(root, ["worktree", "prune"]);
    }
  } else {
    gitIn(root, ["worktree", "prune"]);
  }
  mkdirSync(dirname(path), { recursive: true });
  const branch =
    options.branchName !== undefined && options.branchName.trim() !== ""
      ? options.branchName.trim()
      : taskWorktreeBranch(options.task);
  const added = gitIn(root, ["worktree", "add", "-B", branch, path, commit]);
  if (added.error !== undefined || added.status !== 0) {
    return {
      ok: false,
      reason: `could not create the task worktree at ${path} on ${branch}: ${firstLine(added.stderr ?? added.error?.message ?? "")}`,
    };
  }

  const excluded = collectCopiedWorktreeIncludes(root, path);

  if (options.symlinkNodeModules) {
    const parentNodeModules = join(root, "node_modules");
    const destNodeModules = join(path, "node_modules");
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
    if (existsSync(destNodeModules) && !excluded.includes("node_modules")) {
      excluded.push("node_modules");
    }
  }

  writePerWorktreeExcludes(root, path, excluded);
  return { ok: true, path, branch, reset };
}
