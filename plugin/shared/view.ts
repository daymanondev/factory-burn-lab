/**
 * The Burn Lab surface's view vocabulary — shared wire schema between the
 * Paseo client bundle (Hermes) and the plugin server. Plain JSON + Zod only:
 * no Node built-ins, no class syntax.
 */
import { z } from "zod";

export const BURN_VIEW_VERSION = 1 as const;

export const BurnPlaybookSchema = z.enum([
  "scout-pool",
  "oss-lab",
  "proto-arena",
  "night-shift",
  "self-evolve",
]);
export type BurnPlaybookView = z.infer<typeof BurnPlaybookSchema>;

export const SwarmRoleSchema = z.enum(["coder", "reader-1m", "reviewer"]);
export type SwarmRoleView = z.infer<typeof SwarmRoleSchema>;

export const BurnRunStatusSchema = z.enum([
  "queued",
  "framing",
  "swarm-running",
  "verifying",
  "synthesizing",
  "completed",
  "failed",
]);
export type BurnRunStatusView = z.infer<typeof BurnRunStatusSchema>;

export const BurnProjectViewSchema = z.object({
  slug: z.string(),
  name: z.string(),
  root: z.string(),
  supervisorLane: z.string(),
  source: z.enum(["paseo-factory", "paseo", "burn-lab"]),
});
export type BurnProjectView = z.infer<typeof BurnProjectViewSchema>;

export const FreeModelViewSchema = z.object({
  id: z.string(),
  family: z.string(),
  displayName: z.string(),
  contextWindow: z.number(),
  healthy: z.boolean(),
  latencyMs: z.number().nullable(),
  gatePassed: z.boolean(),
  citationPassed: z.boolean(),
  roles: z.array(SwarmRoleSchema),
  wins: z.number(),
  attempts: z.number(),
  lastScoutedAt: z.string().nullable(),
  error: z.string().nullable().optional(),
});
export type FreeModelView = z.infer<typeof FreeModelViewSchema>;

export const BurnRunSummaryViewSchema = z.object({
  id: z.string(),
  playbook: BurnPlaybookSchema,
  projectSlug: z.string(),
  projectRoot: z.string(),
  supervisorLane: z.string(),
  prompt: z.string(),
  targetRepo: z.string().nullable(),
  gateCommand: z.string().nullable(),
  status: BurnRunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  attemptCount: z.number().int(),
  acceptedCount: z.number().int(),
  councilCount: z.number().int(),
  winningModel: z.string().nullable(),
  winningBranch: z.string().nullable(),
  winningCommit: z.string().nullable(),
  landingStatus: z.enum(["not_landed", "landed", "pending-conflict"]).nullable(),
  landingNote: z.string().nullable(),
  hasReport: z.boolean(),
  error: z.string().nullable(),
});
export type BurnRunSummaryView = z.infer<typeof BurnRunSummaryViewSchema>;

export const BurnAttemptViewSchema = z.object({
  id: z.string(),
  model: z.string(),
  family: z.string(),
  role: SwarmRoleSchema,
  subtask: z.string(),
  ok: z.boolean(),
  attemptCount: z.number().int(),
  latencyMs: z.number(),
  output: z.string(),
  accepted: z.boolean(),
  rejectionReason: z.string().nullable(),
  factoryVerdict: z.enum(["green", "red"]).nullable(),
  changedFiles: z.array(z.string()),
  diffPatch: z.string().nullable(),
  gatePassed: z.boolean().nullable(),
  gateExitCode: z.number().nullable(),
  gateCommand: z.string().nullable(),
  citationPassed: z.boolean().nullable(),
  totalCitations: z.number().nullable(),
  validCitations: z.number().nullable(),
  invalidCitations: z.number().nullable(),
});
export type BurnAttemptView = z.infer<typeof BurnAttemptViewSchema>;

export const BurnCouncilNoteViewSchema = z.object({
  reviewerModel: z.string(),
  reviewerFamily: z.string(),
  targetAttemptId: z.string(),
  targetModel: z.string(),
  verdict: z.enum(["approve", "challenge"]),
  critique: z.string(),
  citationsVerified: z.boolean(),
});
export type BurnCouncilNoteView = z.infer<typeof BurnCouncilNoteViewSchema>;

export const UpstreamIssueViewSchema = z.object({
  id: z.string(),
  number: z.string(),
  slug: z.string(),
  title: z.string(),
  status: z.string(),
  filedBy: z.string(),
  path: z.string(),
  summary: z.string(),
  body: z.string(),
});
export type UpstreamIssueView = z.infer<typeof UpstreamIssueViewSchema>;

export const BurnRunDetailViewSchema = z.object({
  version: z.literal(BURN_VIEW_VERSION),
  run: BurnRunSummaryViewSchema,
  statusHistory: z.array(BurnRunStatusSchema),
  framing: z
    .object({
      goal: z.string(),
      subtasks: z.array(z.string()),
      gateCommand: z.string(),
      artifact: z.string().optional(),
      scope: z.array(z.string()).optional(),
      citationRequired: z.boolean(),
    })
    .nullable(),
  attempts: z.array(BurnAttemptViewSchema),
  councilNotes: z.array(BurnCouncilNoteViewSchema),
  reportMarkdown: z.string().nullable(),
  reportPath: z.string().nullable(),
  upstreamIssue: UpstreamIssueViewSchema.nullable(),
});
export type BurnRunDetailView = z.infer<typeof BurnRunDetailViewSchema>;

export const BurnKpisSchema = z.object({
  totalFreeModels: z.number().int(),
  healthyFreeModels: z.number().int(),
  coderModels: z.number().int(),
  reader1mModels: z.number().int(),
  reviewerModels: z.number().int(),
  totalRuns: z.number().int(),
  activeRuns: z.number().int(),
  verifiedWins: z.number().int(),
  upstreamIssues: z.number().int(),
});
export type BurnKpis = z.infer<typeof BurnKpisSchema>;

export const UnattendedPreflightViewSchema = z.object({
  platform: z.enum(["darwin", "win32", "linux", "other"]),
  ready: z.boolean(),
  responsibleBundle: z.string(),
  fullDiskAccessGranted: z.boolean().nullable(),
  shipItStaleBinary: z.boolean(),
  projectRootAccessible: z.boolean(),
  projectInProtectedFolder: z.boolean(),
  worktreeJunctionReady: z.boolean(),
  openCodeAutoReady: z.boolean(),
  sleepAssertionActive: z.boolean(),
  issues: z.array(z.string()),
  checkedAt: z.string(),
});
export type UnattendedPreflightView = z.infer<typeof UnattendedPreflightViewSchema>;

export const BurnLabViewSchema = z.object({
  version: z.literal(BURN_VIEW_VERSION),
  stateDir: z.string(),
  generatedAt: z.string(),
  activeProject: BurnProjectViewSchema.nullable(),
  projects: z.array(BurnProjectViewSchema),
  supervisorLane: z.string(),
  supervisorLive: z.boolean(),
  supervisorAgentId: z.string().nullable(),
  kpis: BurnKpisSchema,
  freePoolUpdatedAt: z.string().nullable(),
  freeModels: z.array(FreeModelViewSchema),
  runs: z.array(BurnRunSummaryViewSchema),
  upstreamIssues: z.array(UpstreamIssueViewSchema),
  daemonError: z.string().nullable(),
  preflight: UnattendedPreflightViewSchema.optional(),
});
export type BurnLabView = z.infer<typeof BurnLabViewSchema>;
