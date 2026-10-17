/**
 * The Burn Lab surface's RPC contracts — shared between plugin/client and
 * plugin/server. Every method name matches /^[a-z][a-z0-9._-]*$/ and returns
 * a discriminated union on `ok`.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  BurnLabViewSchema,
  BurnPlaybookSchema,
  BurnProjectViewSchema,
  BurnRunDetailViewSchema,
  BurnRunSummaryViewSchema,
  FreeModelViewSchema,
  UpstreamIssueViewSchema,
} from "./view.ts";

export const Failure = z.object({
  ok: z.literal(false),
  code: z.string(),
  error: z.string(),
});

export const burnSnapshot = defineRpc({
  name: "burn.snapshot",
  input: z.object({
    projectSlug: z.string().optional(),
    projectRoot: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      view: BurnLabViewSchema,
    }),
    Failure,
  ]),
});

export const burnScout = defineRpc({
  name: "burn.scout",
  input: z.object({
    models: z.array(z.string()).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      updatedAt: z.string(),
      totalModels: z.number().int(),
      healthyModels: z.number().int(),
      models: z.array(FreeModelViewSchema),
    }),
    Failure,
  ]),
});

export const burnStart = defineRpc({
  name: "burn.start",
  input: z.object({
    playbook: BurnPlaybookSchema,
    prompt: z.string().min(1),
    projectSlug: z.string().optional(),
    targetRepo: z.string().optional(),
    gateCommand: z.string().optional(),
    awaitCompletion: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      run: BurnRunSummaryViewSchema,
    }),
    Failure,
  ]),
});

export const burnDetail = defineRpc({
  name: "burn.detail",
  input: z.object({
    runId: z.string().min(1),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      detail: BurnRunDetailViewSchema,
    }),
    Failure,
  ]),
});

export const burnUpstreamFile = defineRpc({
  name: "burn.upstream.file",
  input: z.object({
    slug: z.string().min(1),
    title: z.string().min(1),
    problem: z.string().min(1),
    proposedChange: z.string().min(1),
    whyItMatters: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      issue: UpstreamIssueViewSchema,
    }),
    Failure,
  ]),
});

export const burnProjectAdd = defineRpc({
  name: "burn.project.add",
  input: z.object({
    repoPath: z.string().min(1),
    initGit: z.boolean().optional(),
    name: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      project: BurnProjectViewSchema,
    }),
    Failure,
  ]),
});

export const burnSupervisorOpen = defineRpc({
  name: "burn.supervisor.open",
  input: z.object({
    projectSlug: z.string().optional(),
    projectRoot: z.string().optional(),
    message: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      agentId: z.string(),
      created: z.boolean(),
      projectRoot: z.string(),
      slug: z.string(),
      supervisorLane: z.string(),
    }),
    Failure,
  ]),
});
