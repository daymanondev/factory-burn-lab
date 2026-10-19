/**
 * The Burn Lab surface's server RPC handlers — resolves active Projects
 * (shared with `paseo-factory` + `burn-lab/projects.json`), Supervisor lane,
 * OpenCode Free Pool (`burn-lab/free-pool.json`), Burn Runs (`burn-lab/runs/`),
 * and Factory Upstream Issues, while maintaining zero contamination of
 * `paseo-factory`'s ledger.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addBurnProject,
  allocateBurnRunRecord,
  type BurnPlaybook,
  type BurnProject,
  type BurnRunRecord,
  type GateRunner,
  landBurnRunWinningBranch,
  listBurnRuns,
  loadBurnRun,
  parseSupervisorLane,
  resolveBurnProjects,
  resolveFactoryStateDir,
  resolveSupervisorLane,
  runBurnPlaybook,
  type SupervisorRunner,
} from "./core/burn-engine.ts";
import {
  resolveProject,
  writeProjectRegistration,
} from "./core/factory-core/index.ts";
import {
  loadFreePool,
  type OpenCodeRunner,
  type ScoutProbeRunner,
  scoutFreePool,
} from "./core/free-pool.ts";
import {
  checkUnattendedPreflight,
  openOsPermissionSettings,
  runUnattendedWarmup,
  type UnattendedPreflightState,
} from "./core/preflight.ts";
import {
  DEFAULT_UPSTREAM_ISSUES_DIR,
  fileUpstreamIssue,
  listUpstreamIssues,
} from "./core/upstream.ts";
import {
  burnDetail,
  burnLand,
  burnPreflight,
  burnProjectAdd,
  burnScout,
  burnSnapshot,
  burnStart,
  burnSupervisorOpen,
  burnUpstreamFile,
} from "../shared/rpc.ts";
import {
  BURN_VIEW_VERSION,
  type BurnAttemptView,
  type BurnLabView,
  type BurnRunDetailView,
  type BurnRunSummaryView,
} from "../shared/view.ts";

export interface BurnDaemonAgentSnapshot {
  id: string;
  provider: string;
  title: string | null;
  status: string;
  model: string | null;
  labels: Record<string, string>;
  archivedAt: string | null;
  cwd: string;
}

export interface BurnDaemonApi {
  agents: {
    list(options?: {
      filter?: { labels?: Record<string, string>; includeArchived?: boolean };
    }): Promise<{ entries: { agent: BurnDaemonAgentSnapshot }[] }>;
    create(options: {
      config: {
        provider: string;
        thinkingOptionId?: string;
        featureValues?: Record<string, boolean>;
      };
      cwd: string;
      title: string;
      labels: Record<string, string>;
      prompt?: string;
    }): Promise<{ id: string }>;
    ref(id: string): {
      send(text: string): Promise<void>;
    };
  };
}

export interface BurnCallContext {
  paseo?: unknown;
}

export interface BurnSurfaceDeps {
  paseoHome?: string;
  upstreamIssuesDir?: string;
  includeSelfRepo?: boolean;
  selfRepoRoot?: string;
  daemon?: BurnDaemonApi | (() => BurnDaemonApi | undefined);
  supervisorRunner?: SupervisorRunner;
  openCodeRunner?: OpenCodeRunner;
  gateRunner?: GateRunner;
  scoutProbeRunner?: ScoutProbeRunner;
  preflightRunner?: (input: {
    mode: "passive" | "warmup";
    projectRoot?: string;
    upstreamIssuesDir?: string;
  }) => Promise<UnattendedPreflightState> | UnattendedPreflightState;
  settingsOpener?: () => { ok: boolean; opened: string[]; error?: string };
  listOutput?: string;
  cachePath?: string;
  onLog?: (message: string) => void;
}

export function resolvePaseoHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const trialHome = join(homeDir, ".paseo-factory");
  const defaultHome = existsSync(trialHome) ? trialHome : join(homeDir, ".paseo");
  const raw =
    env.PASEO_HOME && env.PASEO_HOME.trim() !== "" ? env.PASEO_HOME.trim() : defaultHome;
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return join(homeDir, raw.slice(2));
  return raw;
}

async function findLiveSupervisorAgent(
  daemon: BurnDaemonApi,
  projectSlug: string,
): Promise<BurnDaemonAgentSnapshot | undefined> {
  const page = await daemon.agents.list({
    filter: {
      labels: { seat: "supervisor", project: projectSlug },
      includeArchived: false,
    },
  });
  return page.entries.find((e) => e.agent.archivedAt === null)?.agent;
}

function summarizeRun(run: BurnRunRecord): BurnRunSummaryView {
  return {
    id: run.id,
    playbook: run.playbook,
    projectSlug: run.projectSlug,
    projectRoot: run.projectRoot,
    supervisorLane: run.supervisorLane,
    prompt: run.prompt,
    targetRepo: run.targetRepo ?? null,
    gateCommand: run.gateCommand ?? run.framing?.gateCommand ?? null,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt ?? null,
    attemptCount: run.attempts.length,
    acceptedCount: run.attempts.filter((a) => a.accepted).length,
    councilCount: run.councilNotes.length,
    winningModel: run.winningModel ?? null,
    winningBranch: run.winningBranch ?? null,
    winningCommit: run.winningCommit ?? null,
    landingStatus: run.landingStatus ?? null,
    landingNote: run.landingNote ?? null,
    waveCount:
      run.wavesCompleted ??
      Math.max(1, run.framing?.subtasks?.length ?? 1),
    acceptedWaveCount:
      run.wavesCompleted ?? run.attempts.filter((a) => a.leadAccepted).length,
    retroOutcome: run.retroOutcome ?? null,
    retroProposalsPath: run.retroProposalsPath ?? null,
    retroProposalCount: run.retroProposalCount ?? null,
    hasReport: Boolean(run.reportMarkdown || run.reportPath),
    error: run.error ?? null,
  };
}

function toDetailView(run: BurnRunRecord): BurnRunDetailView {
  const attempts: BurnAttemptView[] = run.attempts.map((a) => ({
    id: a.id,
    model: a.model,
    family: a.family,
    role: a.role,
    subtask: a.subtask,
    waveIndex: a.wave ?? null,
    ok: a.ok,
    attemptCount: a.attemptCount ?? 1,
    latencyMs: a.latencyMs,
    output: a.output,
    accepted: a.accepted,
    leadAccepted: a.leadAccepted ?? null,
    rejectionReason: a.rejectionReason ?? null,
    factoryVerdict: a.factoryVerdict ?? null,
    freshEyesOutcome: a.freshEyesOutcome ?? null,
    freshEyesNotes: a.freshEyesFinding ?? null,
    watchOutcome: a.watchOutcome ?? null,
    changedFiles: a.changedFiles ?? [],
    diffPatch: a.diffPatch ?? null,
    gatePassed: a.gateResult ? a.gateResult.ok : null,
    gateExitCode: a.gateResult ? a.gateResult.exitCode : null,
    gateCommand: a.gateResult ? a.gateResult.command : null,
    citationPassed: a.citationResult ? a.citationResult.ok : null,
    totalCitations: a.citationResult ? a.citationResult.totalCitations : null,
    validCitations: a.citationResult ? a.citationResult.validCitations.length : null,
    invalidCitations: a.citationResult ? a.citationResult.invalidCitations.length : null,
  }));

  return {
    version: BURN_VIEW_VERSION,
    run: summarizeRun(run),
    statusHistory: run.statusHistory,
    framing: run.framing
      ? {
          goal: run.framing.goal,
          subtasks: run.framing.subtasks,
          gateCommand: run.framing.gateCommand,
          ...(run.framing.artifact ? { artifact: run.framing.artifact } : {}),
          ...(run.framing.scope ? { scope: run.framing.scope } : {}),
          ...(run.framing.skills ? { skills: run.framing.skills } : {}),
          citationRequired: run.framing.citationRequired,
        }
      : null,
    attempts,
    councilNotes: run.councilNotes,
    reportMarkdown: run.reportMarkdown ?? null,
    reportPath: run.reportPath ?? null,
    upstreamIssue: run.upstreamIssue ?? null,
  };
}

function pickActiveProject(
  projects: BurnProject[],
  input?: { projectSlug?: string; projectRoot?: string },
): BurnProject | null {
  if (input?.projectSlug) {
    const bySlug = projects.find((p) => p.slug === input.projectSlug);
    if (bySlug) return bySlug;
  }
  if (input?.projectRoot) {
    const byRoot = projects.find(
      (p) => p.root === input.projectRoot || input.projectRoot!.startsWith(`${p.root}/`),
    );
    if (byRoot) return byRoot;
    const identity = resolveProject(input.projectRoot);
    if (identity.ok) {
      const byResolved = projects.find(
        (p) => p.slug === identity.slug || p.root === identity.root,
      );
      if (byResolved) return byResolved;
    }
  }
  return projects[0] ?? null;
}

export function createBurnSurfaceHandlers(deps: BurnSurfaceDeps = {}) {
  const paseoHome = deps.paseoHome ?? resolvePaseoHome();
  const stateDir = join(paseoHome, "burn-lab");
  const upstreamIssuesDir = deps.upstreamIssuesDir ?? DEFAULT_UPSTREAM_ISSUES_DIR;

  const resolveDaemon = (context?: BurnCallContext): BurnDaemonApi | undefined => {
    if (context?.paseo !== undefined) return context.paseo as BurnDaemonApi;
    return typeof deps.daemon === "function" ? deps.daemon() : deps.daemon;
  };

  const failure = <C extends string>(code: C, error: string) => ({
    ok: false as const,
    code,
    error,
  });

  return {
    async snapshot(
      input: { projectSlug?: string; projectRoot?: string } = {},
      context?: BurnCallContext,
    ) {
      const projects = resolveBurnProjects(paseoHome, {
        includeSelfRepo: deps.includeSelfRepo,
        selfRepoRoot: deps.selfRepoRoot,
      });
      const activeProject = pickActiveProject(projects, input);
      const supervisorLane =
        activeProject?.supervisorLane ??
        resolveSupervisorLane(paseoHome, activeProject?.slug);

      const pool = loadFreePool(paseoHome);
      const allRuns = listBurnRuns(paseoHome);
      const scopedRuns = activeProject
        ? allRuns.filter((r) => r.projectSlug === activeProject.slug)
        : allRuns;
      const runsToShow = scopedRuns.length > 0 ? scopedRuns : allRuns;
      const upstreamIssues = listUpstreamIssues(upstreamIssuesDir);

      let supervisorLive = false;
      let supervisorAgentId: string | null = null;
      let daemonError: string | null = null;
      const daemon = resolveDaemon(context);
      if (daemon && activeProject) {
        try {
          const live = await findLiveSupervisorAgent(daemon, activeProject.slug);
          if (live) {
            supervisorLive = true;
            supervisorAgentId = live.id;
          }
        } catch (err) {
          daemonError = err instanceof Error ? err.message : String(err);
        }
      }

      const healthyModels = pool.models.filter((m) => m.healthy);
      const activeStatuses = new Set(["queued", "framing", "swarm-running", "verifying", "synthesizing"]);
      const preflight = deps.preflightRunner
        ? await deps.preflightRunner({
            mode: "passive",
            projectRoot: activeProject?.root,
            upstreamIssuesDir,
          })
        : checkUnattendedPreflight({
            projectRoot: activeProject?.root,
            upstreamIssuesDir,
            ...(deps.openCodeRunner || deps.scoutProbeRunner
              ? { openCodeChecker: () => true }
              : {}),
          });

      const view: BurnLabView = {
        version: BURN_VIEW_VERSION,
        stateDir,
        generatedAt: new Date().toISOString(),
        activeProject,
        projects,
        supervisorLane,
        supervisorLive,
        supervisorAgentId,
        kpis: {
          totalFreeModels: pool.models.length,
          healthyFreeModels: healthyModels.length,
          coderModels: healthyModels.filter((m) => m.roles.includes("coder")).length,
          reader1mModels: healthyModels.filter((m) => m.roles.includes("reader-1m")).length,
          reviewerModels: healthyModels.filter((m) => m.roles.includes("reviewer")).length,
          totalRuns: runsToShow.length,
          activeRuns: runsToShow.filter((r) => activeStatuses.has(r.status)).length,
          verifiedWins: runsToShow.reduce(
            (sum, r) => sum + r.attempts.filter((a) => a.accepted).length,
            0,
          ),
          upstreamIssues: upstreamIssues.length,
        },
        freePoolUpdatedAt:
          pool.models.length > 0 ? pool.updatedAt : null,
        freeModels: pool.models,
        runs: runsToShow.map(summarizeRun),
        upstreamIssues,
        daemonError,
        preflight,
      };

      return { ok: true as const, view };
    },

    async preflight(
      input: {
        mode?: "warmup" | "open-settings";
        projectSlug?: string;
        projectRoot?: string;
      } = {},
      _context?: BurnCallContext,
    ) {
      const mode = input.mode ?? "warmup";
      const projects = resolveBurnProjects(paseoHome, {
        includeSelfRepo: deps.includeSelfRepo,
        selfRepoRoot: deps.selfRepoRoot,
      });
      const activeProject = pickActiveProject(projects, input);
      const targetRoot = input.projectRoot ?? activeProject?.root;

      try {
        if (mode === "open-settings") {
          const openRes = deps.settingsOpener
            ? deps.settingsOpener()
            : openOsPermissionSettings();
          if (!openRes.ok) {
            return failure("open-settings-failed", openRes.error ?? "failed to open OS settings");
          }
          const preflight = deps.preflightRunner
            ? await deps.preflightRunner({
                mode: "passive",
                projectRoot: targetRoot,
                upstreamIssuesDir,
              })
            : checkUnattendedPreflight({
                projectRoot: targetRoot,
                upstreamIssuesDir,
              });
          return {
            ok: true as const,
            mode,
            preflight,
            opened: openRes.opened,
          };
        }

        const preflight = deps.preflightRunner
          ? await deps.preflightRunner({
              mode: "warmup",
              projectRoot: targetRoot,
              upstreamIssuesDir,
            })
          : await runUnattendedWarmup({
              projectRoot: targetRoot,
              upstreamIssuesDir,
              skipNetworkProbe: Boolean(deps.openCodeRunner || deps.supervisorRunner),
            });

        return {
          ok: true as const,
          mode,
          preflight,
        };
      } catch (err) {
        return failure(
          "preflight-failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async projectAdd(
      input: { repoPath: string; initGit?: boolean; name?: string },
      _context?: BurnCallContext,
    ) {
      const res = addBurnProject(paseoHome, input.repoPath, {
        initGit: input.initGit,
        name: input.name,
      });
      if (!res.ok) {
        return failure("project-add-failed", res.error);
      }
      return {
        ok: true as const,
        project: {
          slug: res.project.slug,
          name: res.project.name,
          root: res.project.root,
          supervisorLane: res.project.supervisorLane,
          source: res.project.source,
        },
      };
    },

    async scout(
      input: { models?: string[] } = {},
      _context?: BurnCallContext,
    ) {
      try {
        const pool = await scoutFreePool({
          paseoHome,
          models: input.models,
          probeRunner: deps.scoutProbeRunner,
          openCodeRunner: deps.openCodeRunner,
          listOutput: deps.listOutput,
          cachePath: deps.cachePath,
        });
        const healthyModels = pool.models.filter((m) => m.healthy).length;
        return {
          ok: true as const,
          updatedAt: pool.updatedAt,
          totalModels: pool.models.length,
          healthyModels,
          models: pool.models,
        };
      } catch (err) {
        return failure(
          "scout-failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async start(
      input: {
        playbook: BurnPlaybook;
        prompt: string;
        projectSlug?: string;
        targetRepo?: string;
        gateCommand?: string;
        awaitCompletion?: boolean;
      },
      _context?: BurnCallContext,
    ) {
      const trimmedPrompt = input.prompt.trim();
      if (!trimmedPrompt) {
        return failure("invalid-prompt", "prompt is required to start a Burn run");
      }

      try {
        const initialRun = allocateBurnRunRecord({
          paseoHome,
          playbook: input.playbook,
          prompt: trimmedPrompt,
          projectSlug: input.projectSlug,
          targetRepo: input.targetRepo,
          gateCommand: input.gateCommand,
        });

        const burnRunPromise = runBurnPlaybook({
          paseoHome,
          runId: initialRun.id,
          playbook: input.playbook,
          prompt: trimmedPrompt,
          projectSlug: input.projectSlug,
          targetRepo: input.targetRepo,
          gateCommand: input.gateCommand,
          upstreamIssuesDir,
          supervisorRunner: deps.supervisorRunner,
          openCodeRunner: deps.openCodeRunner,
          gateRunner: deps.gateRunner,
          scoutProbeRunner: deps.scoutProbeRunner,
          preflightRunner: deps.preflightRunner
            ? () =>
                deps.preflightRunner!({
                  mode: "warmup",
                  upstreamIssuesDir,
                })
            : undefined,
          listOutput: deps.listOutput,
          cachePath: deps.cachePath,
        });

        if (input.awaitCompletion === false) {
          void burnRunPromise.catch(() => {});
          return { ok: true as const, run: summarizeRun(initialRun) };
        }

        const completedRun = await burnRunPromise;
        return {
          ok: true as const,
          run: summarizeRun(completedRun),
        };
      } catch (err) {
        return failure(
          "burn-start-failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async detail(
      input: { runId: string },
      _context?: BurnCallContext,
    ) {
      const run = loadBurnRun(paseoHome, input.runId);
      if (!run) {
        return failure("unknown-run", `no Burn run found with id ${input.runId}`);
      }
      return {
        ok: true as const,
        detail: toDetailView(run),
      };
    },

    async land(
      input: { runId: string },
      _context?: BurnCallContext,
    ) {
      try {
        const res = await landBurnRunWinningBranch(paseoHome, input.runId);
        if (!res.ok) {
          return failure(res.code, res.error);
        }
        return res;
      } catch (err) {
        return failure(
          "burn-land-failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async upstreamFile(
      input: {
        slug: string;
        title: string;
        problem: string;
        proposedChange: string;
        whyItMatters?: string;
      },
      _context?: BurnCallContext,
    ) {
      try {
        const issue = fileUpstreamIssue({
          issuesDir: upstreamIssuesDir,
          slug: input.slug,
          title: input.title,
          problem: input.problem,
          proposedChange: input.proposedChange,
          whyItMatters: input.whyItMatters,
        });
        return {
          ok: true as const,
          issue,
        };
      } catch (err) {
        return failure(
          "upstream-file-failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async supervisorOpen(
      input: { projectSlug?: string; projectRoot?: string; message?: string },
      context?: BurnCallContext,
    ) {
      const projects = resolveBurnProjects(paseoHome, {
        includeSelfRepo: deps.includeSelfRepo,
        selfRepoRoot: deps.selfRepoRoot,
      });
      const project = pickActiveProject(projects, input);
      if (!project) {
        return failure("no-project", "no active Project found for Supervisor seat");
      }

      const daemon = resolveDaemon(context);
      if (!daemon) {
        return failure("daemon-unavailable", "Paseo daemon API is not available");
      }

      const supervisorLane =
        project.supervisorLane || resolveSupervisorLane(paseoHome, project.slug);
      const parsedLane = parseSupervisorLane(supervisorLane);

      let existingAgent: BurnDaemonAgentSnapshot | undefined;
      try {
        existingAgent = await findLiveSupervisorAgent(daemon, project.slug);
      } catch (err) {
        return failure(
          "daemon-list-failed",
          err instanceof Error ? err.message : String(err),
        );
      }

      let agentId = existingAgent?.id ?? "";
      let created = false;

      if (!existingAgent) {
        try {
          const handle = await daemon.agents.create({
            config: parsedLane.thinking
              ? {
                  provider: parsedLane.providerSpec,
                  thinkingOptionId: parsedLane.thinking,
                  featureValues: { auto_accept: true },
                }
              : {
                  provider: parsedLane.providerSpec,
                  featureValues: { auto_accept: true },
                },
            cwd: project.root,
            title: "Factory Supervisor",
            labels: { seat: "supervisor", project: project.slug },
            prompt: [
              `You are the strong Supervisor (${supervisorLane}) for Project ${project.name} (${project.root}).`,
              `You anchor both paseo-factory and factory-burn-lab (autonomous OpenCode Free Pool swarm under ${stateDir}).`,
            ].join("\n"),
          });
          agentId = handle.id;
          created = true;
          deps.onLog?.(
            `supervisor: created seat agent ${agentId} for project ${project.slug} (${supervisorLane})`,
          );
        } catch (err) {
          return failure(
            "supervisor-create-failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      writeProjectRegistration(resolveFactoryStateDir(paseoHome), project.slug, {
        root: project.root,
        supervisor: agentId,
      });

      const trimmedMessage = input.message?.trim();
      if (trimmedMessage) {
        try {
          await daemon.agents.ref(agentId).send(trimmedMessage);
        } catch (err) {
          return failure(
            "supervisor-send-failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return {
        ok: true as const,
        agentId,
        created,
        projectRoot: project.root,
        slug: project.slug,
        supervisorLane,
      };
    },
  };
}

export type BurnSurfaceHandlers = ReturnType<typeof createBurnSurfaceHandlers>;

export function registerBurnSurfaceRpc(
  server: PluginServerContext,
  handlers: BurnSurfaceHandlers,
): void {
  server.handle(burnSnapshot, (input, context) =>
    handlers.snapshot(input, { paseo: context.paseo }),
  );
  server.handle(burnPreflight, (input, context) =>
    handlers.preflight(input, { paseo: context.paseo }),
  );
  server.handle(burnScout, (input, context) =>
    handlers.scout(input, { paseo: context.paseo }),
  );
  server.handle(burnStart, (input, context) =>
    handlers.start(input, { paseo: context.paseo }),
  );
  server.handle(burnDetail, (input, context) =>
    handlers.detail(input, { paseo: context.paseo }),
  );
  server.handle(burnLand, (input, context) =>
    handlers.land(input, { paseo: context.paseo }),
  );
  server.handle(burnUpstreamFile, (input, context) =>
    handlers.upstreamFile(input, { paseo: context.paseo }),
  );
  server.handle(burnProjectAdd, (input, context) =>
    handlers.projectAdd(input, { paseo: context.paseo }),
  );
  server.handle(burnSupervisorOpen, (input, context) =>
    handlers.supervisorOpen(input, { paseo: context.paseo }),
  );
}
