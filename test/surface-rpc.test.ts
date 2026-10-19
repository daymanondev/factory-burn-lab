import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBurnSurfaceHandlers,
  resolvePaseoHome,
} from "../plugin/server/surface-rpc.ts";
import { resolveFactoryStateDir } from "../src/burn-engine.ts";
import {
  discoverProjects,
  listProjectRegistrations,
  readProjectRegistration,
} from "../src/factory-core/index.ts";
import { saveFreePool } from "../src/free-pool.ts";

function initTempGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Burn Surface Test"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    "export const VERSION = 1;\nexport const NAME = 'burn-surface';\n",
    "utf8",
  );
  writeFileSync(join(dir, "README.md"), "# Surface Test Repo\nOverview.\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
}

test("burn.snapshot and burn.project.add expose projects, Supervisor lane, Free pool KPIs, and register projects in paseo-factory's shared registry", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-surface-home-"));
  const petDir = join(tmpdir(), `burn-surface-pet-${Date.now()}`);
  const upstreamDir = mkdtempSync(join(tmpdir(), "burn-surface-upstream-"));

  try {
    mkdirSync(join(paseoHome, "factory"), { recursive: true });
    writeFileSync(
      join(paseoHome, "factory", "lanes.json"),
      JSON.stringify({ supervisor: "claude/claude-opus-4-6" }),
      "utf8",
    );

    saveFreePool(paseoHome, {
      updatedAt: "2026-10-17T08:00:00.000Z",
      models: [
        {
          id: "opencode/glm-5.3-flash-free",
          family: "glm",
          displayName: "GLM 5.3 Flash Free",
          contextWindow: 204_800,
          healthy: true,
          latencyMs: 210,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reader-1m", "reviewer"],
          wins: 3,
          attempts: 4,
          lastScoutedAt: "2026-10-17T08:00:00.000Z",
        },
      ],
    });

    const handlers = createBurnSurfaceHandlers({
      paseoHome,
      upstreamIssuesDir: upstreamDir,
      includeSelfRepo: false,
    });

    const added = await handlers.projectAdd({
      repoPath: petDir,
      initGit: true,
      name: "Pet App",
    });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.project.name, "Pet App");
    assert.equal(added.project.supervisorLane, "claude/claude-opus-4-6");

    const factoryStateDir = resolveFactoryStateDir(paseoHome);
    assert.equal(
      existsSync(join(factoryStateDir, "projects", added.project.slug, "project.json")),
      true,
    );
    const reg = readProjectRegistration(factoryStateDir, added.project.slug);
    assert.ok(reg);
    assert.equal(reg.slug, added.project.slug);
    assert.equal(reg.root, added.project.root);
    assert.equal(
      listProjectRegistrations(factoryStateDir).some((r) => r.slug === added.project.slug),
      true,
    );
    assert.equal(
      discoverProjects(factoryStateDir, [], paseoHome).some((d) => d.slug === added.project.slug),
      true,
    );

    const snap = await handlers.snapshot({ projectSlug: added.project.slug });
    assert.equal(snap.ok, true);
    if (!snap.ok) return;

    assert.equal(snap.view.activeProject?.slug, added.project.slug);
    assert.equal(snap.view.supervisorLane, "claude/claude-opus-4-6");
    assert.equal(snap.view.kpis.totalFreeModels, 1);
    assert.equal(snap.view.kpis.healthyFreeModels, 1);
    assert.equal(snap.view.kpis.coderModels, 1);
    assert.equal(snap.view.kpis.reader1mModels, 1);
    assert.equal(snap.view.kpis.reviewerModels, 1);
    assert.equal(existsSync(join(paseoHome, "factory", "ledger.jsonl")), false);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(petDir, { recursive: true, force: true });
    rmSync(upstreamDir, { recursive: true, force: true });
  }
});

test("burn.scout, burn.start, burn.detail, and burn.upstream.file execute playbooks, inspect run details, and file upstream issues", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-surface-ops-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-surface-ops-repo-"));
  const upstreamDir = mkdtempSync(join(tmpdir(), "burn-surface-ops-upstream-"));

  try {
    initTempGitRepo(repoDir);
    const handlers = createBurnSurfaceHandlers({
      paseoHome,
      upstreamIssuesDir: upstreamDir,
      includeSelfRepo: false,
      listOutput: [
        "opencode/glm-5.3-flash-free",
        "opencode/deepseek-v4.1-flash-free",
        "opencode/nemotron-3-ultra-free",
      ].join("\n"),
      scoutProbeRunner: async (model) => ({
        healthy: true,
        latencyMs: model.id.includes("glm") ? 180 : 240,
        codeOutput: "n > 0 ? acc + n : acc\nFIXED_SUM=6",
        citationOutput: "Cited [src/math.ts:1-3].",
      }),
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Analyze surface repo index.ts with citations",
                subtasks: ["Inspect src/index.ts"],
                gateCommand: "node -e \"process.exit(0)\"",
                citationRequired: true,
              })
            : "# Synthesized Surface Report\n\nVerified [src/index.ts:1-2] and [README.md:1-2].",
      }),
      openCodeRunner: async ({ prompt }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: APPROVE — Citations verified.",
            stderr: "",
            latencyMs: 110,
          };
        }
        return {
          ok: true,
          stdout: "Module exports VERSION and NAME in [src/index.ts:1-2] as described in [README.md:1-2].",
          stderr: "",
          latencyMs: 160,
        };
      },
    });

    const added = await handlers.projectAdd({ repoPath: repoDir, name: "Surface Repo" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    // 1. burn.scout
    const scoutRes = await handlers.scout({});
    assert.equal(scoutRes.ok, true);
    if (!scoutRes.ok) return;
    assert.equal(scoutRes.totalModels, 3);
    assert.equal(scoutRes.healthyModels, 3);

    // 2. burn.start (oss-lab, awaiting completion)
    const startRes = await handlers.start({
      playbook: "oss-lab",
      prompt: "Audit index.ts exports with verified citations.",
      projectSlug: added.project.slug,
      targetRepo: repoDir,
      awaitCompletion: true,
    });
    assert.equal(startRes.ok, true);
    if (!startRes.ok) return;
    assert.equal(startRes.run.status, "completed");
    assert.equal(startRes.run.acceptedCount >= 1, true);
    assert.equal(startRes.run.hasReport, true);

    // 3. burn.detail
    const detailRes = await handlers.detail({ runId: startRes.run.id });
    assert.equal(detailRes.ok, true);
    if (!detailRes.ok) return;
    assert.equal(detailRes.detail.run.id, startRes.run.id);
    assert.equal(detailRes.detail.framing?.goal, "Analyze surface repo index.ts with citations");
    assert.equal(detailRes.detail.attempts.some((a) => a.citationPassed === true), true);
    assert.equal(detailRes.detail.councilNotes.length >= 1, true);
    assert.match(detailRes.detail.reportMarkdown ?? "", /Synthesized Surface Report/);

    // 4. burn.upstream.file
    const upstreamRes = await handlers.upstreamFile({
      slug: "worktree-snapshot-hook",
      title: "Add worktree snapshot hook to paseo-factory",
      problem: "Burn Lab Proto Arena wants fast worktree cloning hooks.",
      proposedChange: "Expose prepareWorktree helper in paseo-factory.",
    });
    assert.equal(upstreamRes.ok, true);
    if (!upstreamRes.ok) return;
    assert.equal(upstreamRes.issue.id, "01-worktree-snapshot-hook");
    assert.equal(upstreamRes.issue.status, "needs-triage");

    // 5. Verify snapshot reflects the run and upstream issue
    const snap = await handlers.snapshot({ projectSlug: added.project.slug });
    assert.equal(snap.ok, true);
    if (!snap.ok) return;
    assert.equal(snap.view.kpis.totalRuns, 1);
    assert.equal(snap.view.kpis.upstreamIssues, 1);
    assert.equal(snap.view.runs[0]?.id, startRes.run.id);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(upstreamDir, { recursive: true, force: true });
  }
});

test("burn.supervisor.open creates or reuses the Project's Supervisor seat agent on the Paseo daemon and dispatches optional messages", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-surface-sup-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-surface-sup-repo-"));

  try {
    initTempGitRepo(repoDir);
    mkdirSync(join(paseoHome, "factory"), { recursive: true });
    writeFileSync(
      join(paseoHome, "factory", "lanes.json"),
      JSON.stringify({ supervisor: "pi/zai/glm-5.3:high" }),
      "utf8",
    );

    const createdAgents: Array<{
      id: string;
      provider: string;
      title: string | null;
      status: string;
      model: string | null;
      labels: Record<string, string>;
      archivedAt: string | null;
      cwd: string;
    }> = [];
    const sentMessages: Array<{ id: string; text: string }> = [];

    const fakeDaemon = {
      agents: {
        async list(options?: {
          filter?: { labels?: Record<string, string>; includeArchived?: boolean };
        }) {
          const wanted = options?.filter?.labels ?? {};
          const entries = createdAgents
            .filter((agent) =>
              Object.entries(wanted).every(([k, v]) => agent.labels[k] === v),
            )
            .map((agent) => ({ agent }));
          return { entries };
        },
        async create(options: {
          config: {
            provider: string;
            thinkingOptionId?: string;
            featureValues?: Record<string, boolean>;
          };
          cwd: string;
          title: string;
          labels: Record<string, string>;
          prompt?: string;
        }) {
          assert.equal(options.config.featureValues?.auto_accept, true);
          const id = `agent-sup-${createdAgents.length + 1}`;
          createdAgents.push({
            id,
            provider: options.config.provider,
            title: options.title,
            status: "running",
            model: options.config.provider,
            labels: options.labels,
            archivedAt: null,
            cwd: options.cwd,
          });
          return { id };
        },
        ref(id: string) {
          return {
            async send(text: string) {
              sentMessages.push({ id, text });
            },
          };
        },
      },
      providers: {
        async listModels(provider: string) {
          assert.equal(provider, "opencode");
          return { models: [] };
        },
      },
    };

    const handlers = createBurnSurfaceHandlers({
      paseoHome,
      includeSelfRepo: false,
      daemon: fakeDaemon,
    });

    const added = await handlers.projectAdd({ repoPath: repoDir, name: "Sup Repo" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    // First call creates the Supervisor agent for this project
    const firstOpen = await handlers.supervisorOpen({
      projectSlug: added.project.slug,
      message: "Review our latest OSS Lab findings.",
    });
    assert.equal(firstOpen.ok, true);
    if (!firstOpen.ok) return;
    assert.equal(firstOpen.created, true);
    assert.equal(firstOpen.agentId, "agent-sup-1");
    assert.equal(firstOpen.slug, added.project.slug);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.text, "Review our latest OSS Lab findings.");
    assert.equal(
      readProjectRegistration(resolveFactoryStateDir(paseoHome), added.project.slug)?.supervisor,
      "agent-sup-1",
    );

    // Second call reuses the existing Supervisor agent without creating a duplicate
    const secondOpen = await handlers.supervisorOpen({
      projectSlug: added.project.slug,
    });
    assert.equal(secondOpen.ok, true);
    if (!secondOpen.ok) return;
    assert.equal(secondOpen.created, false);
    assert.equal(secondOpen.agentId, "agent-sup-1");
    assert.equal(createdAgents.length, 1);

    // Snapshot now shows supervisorLive = true and supervisorAgentId = "agent-sup-1"
    const snap = await handlers.snapshot({ projectSlug: added.project.slug });
    assert.equal(snap.ok, true);
    if (!snap.ok) return;
    assert.equal(snap.view.supervisorLive, true);
    assert.equal(snap.view.supervisorAgentId, "agent-sup-1");
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("burn.preflight runs warmup and open-settings, and burn.start fails fast if ShipIt stale binary is detected", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-surface-pf-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-surface-pf-repo-"));

  try {
    initTempGitRepo(repoDir);
    let simulateShipIt = false;
    const handlers = createBurnSurfaceHandlers({
      paseoHome,
      includeSelfRepo: false,
      preflightRunner: ({ mode }) => ({
        platform: "darwin",
        ready: !simulateShipIt,
        responsibleBundle: "sh.paseo.desktop.helper (Paseo Helper.app)",
        fullDiskAccessGranted: true,
        shipItStaleBinary: simulateShipIt,
        projectRootAccessible: true,
        projectInProtectedFolder: false,
        worktreeJunctionReady: true,
        openCodeAutoReady: true,
        sleepAssertionActive: mode === "warmup",
        issues: simulateShipIt
          ? ["ShipIt unlinked the running daemon binary. Restart Paseo / daemon."]
          : [],
        checkedAt: new Date().toISOString(),
      }),
      settingsOpener: () => ({
        ok: true,
        opened: ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"],
      }),
    });

    const warmupRes = await handlers.preflight({ mode: "warmup" });
    assert.equal(warmupRes.ok, true);
    if (warmupRes.ok) {
      assert.equal(warmupRes.mode, "warmup");
      assert.equal(warmupRes.preflight.ready, true);
    }

    const openRes = await handlers.preflight({ mode: "open-settings" });
    assert.equal(openRes.ok, true);
    if (openRes.ok) {
      assert.equal(openRes.mode, "open-settings");
      assert.equal(openRes.opened?.length, 1);
    }

    // Now simulate a stale ShipIt binary and verify burn.start fails fast
    simulateShipIt = true;
    const added = await handlers.projectAdd({ repoPath: repoDir, name: "PF Repo" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    const failedStart = await handlers.start({
      playbook: "night-shift",
      prompt: "Audit edge cases",
      projectSlug: added.project.slug,
      awaitCompletion: true,
    });
    assert.equal(failedStart.ok, true);
    if (failedStart.ok) {
      assert.equal(failedStart.run.status, "failed");
      assert.match(failedStart.run.error ?? "", /ShipIt/);
    }
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("createBurnSurfaceHandlers renders live trial-home state cleanly under an explicit paseo home (resolvePaseoHome now defaults to ~/.paseo)", async () => {
  const trialHome = join(homedir(), ".paseo-factory");
  const configPath = join(trialHome, "config.json");
  if (!existsSync(configPath)) return;

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    plugins?: Record<string, { source?: string; path?: string; enabled?: boolean }>;
  };
  assert.ok(config.plugins?.["paseo-factory"], `expected paseo-factory in ${configPath}`);
  assert.equal(config.plugins?.["factory-burn-lab"]?.enabled, true);

  // resolvePaseoHome no longer prefers ~/.paseo-factory when PASEO_HOME is unset —
  // an explicit paseoHome (the PASEO_HOME-equivalent seam) is how the trial home is targeted.
  const handlers = createBurnSurfaceHandlers({ paseoHome: trialHome });
  const snap = await handlers.snapshot({});
  assert.equal(snap.ok, true);
  if (!snap.ok) return;

  assert.equal(snap.view.stateDir, join(trialHome, "burn-lab"));
  assert.equal(snap.view.kpis.totalFreeModels >= 10, true);
  assert.equal(snap.view.kpis.healthyFreeModels >= 1, true);
  assert.equal(snap.view.kpis.coderModels >= 1, true);
  assert.equal(snap.view.kpis.reader1mModels >= 1, true);
  assert.equal(snap.view.kpis.reviewerModels >= 1, true);
  assert.equal(snap.view.projects.length >= 1, true);
  assert.ok(snap.view.activeProject);
  assert.equal(
    snap.view.projects.some((p) => p.name === "factory-burn-lab"),
    true,
  );
  assert.equal(snap.view.kpis.totalRuns >= 1, true);
  assert.equal(snap.view.kpis.upstreamIssues >= 1, true);
  assert.ok(snap.view.preflight);
  const issue01 = snap.view.upstreamIssues.find((i) => i.number === "01");
  assert.ok(issue01);
  assert.equal(["needs-triage", "ready-for-agent", "done"].includes(issue01.status), true);
  assert.equal(existsSync(join(trialHome, "factory", "ledger.jsonl")), false);
});

test("burn.start (awaitCompletion: false), burn.detail, and burn.land pre-allocate queued runs, surface rework/diff fields, and land winning branches via landTaskWorktree", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-surface-land-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-surface-land-repo-"));
  const upstreamDir = mkdtempSync(join(tmpdir(), "burn-surface-land-upstream-"));

  try {
    initTempGitRepo(repoDir);
    saveFreePool(paseoHome, {
      updatedAt: new Date().toISOString(),
      models: [
        {
          id: "opencode/glm-5.3-flash-free",
          family: "glm",
          displayName: "GLM 5.3 Flash Free",
          contextWindow: 204_800,
          healthy: true,
          latencyMs: 150,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
          wins: 2,
          attempts: 2,
          lastScoutedAt: new Date().toISOString(),
        },
        {
          id: "opencode/deepseek-v4.1-flash-free",
          family: "deepseek",
          displayName: "DeepSeek V4.1 Flash Free",
          contextWindow: 200_000,
          healthy: true,
          latencyMs: 210,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
          wins: 1,
          attempts: 2,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    let slowRunDelayMs = 0;
    const handlers = createBurnSurfaceHandlers({
      paseoHome,
      upstreamIssuesDir: upstreamDir,
      includeSelfRepo: false,
      supervisorRunner: async ({ phase }) => {
        if (slowRunDelayMs > 0) {
          await new Promise((r) => setTimeout(r, slowRunDelayMs));
        }
        return {
          ok: true,
          stdout:
            phase === "framing"
              ? JSON.stringify({
                  goal: "Build src/feature.ts and verify under Gate",
                  subtasks: ["Create src/feature.ts exporting FEATURE_LANDED = true"],
                  gateCommand: 'node -e "process.exit(0)"',
                  artifact: "README.md",
                  scope: ["src"],
                  citationRequired: false,
                })
              : "# Proto Arena Synthesis\n\nWinning branch ready to land.",
        };
      },
      openCodeRunner: async ({ model, prompt, cwd }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: APPROVE — Clean diff inside src/feature.ts.",
            stderr: "",
            latencyMs: 80,
          };
        }
        if (model.includes("glm")) {
          mkdirSync(join(cwd, "src"), { recursive: true });
          writeFileSync(
            join(cwd, "src", "feature.ts"),
            "export const FEATURE_LANDED = true;\n",
            "utf8",
          );
        }
        return {
          ok: true,
          stdout: `Implemented src/feature.ts from ${model}`,
          stderr: "",
          latencyMs: model.includes("glm") ? 110 : 220,
        };
      },
    });

    const added = await handlers.projectAdd({ repoPath: repoDir, name: "Landing Repo" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    // Seed an earlier completed run so burn-lab/runs/ is non-empty
    const priorStart = await handlers.start({
      playbook: "proto-arena",
      prompt: "Seed prior completed run",
      projectSlug: added.project.slug,
      awaitCompletion: true,
    });
    assert.equal(priorStart.ok, true);
    if (!priorStart.ok) return;
    assert.equal(priorStart.run.status, "completed");

    // (a) Non-blocking start (awaitCompletion: false) synchronously pre-allocates a fresh queued run
    slowRunDelayMs = 60;
    const asyncStart = await handlers.start({
      playbook: "proto-arena",
      prompt: "Create src/feature.ts in isolated worktree for landing",
      projectSlug: added.project.slug,
      awaitCompletion: false,
    });
    assert.equal(asyncStart.ok, true);
    if (!asyncStart.ok) return;
    assert.notEqual(asyncStart.run.id, priorStart.run.id);
    assert.equal(asyncStart.run.status, "queued");

    // Wait for background completion
    let detailRes = await handlers.detail({ runId: asyncStart.run.id });
    for (let i = 0; i < 100; i++) {
      detailRes = await handlers.detail({ runId: asyncStart.run.id });
      if (detailRes.ok && detailRes.detail.run.status === "completed") {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    // (b) Detail exposes winningBranch, winningCommit, landingStatus, attemptCount, factoryVerdict, changedFiles, diffPatch
    assert.equal(detailRes.ok, true);
    if (!detailRes.ok) return;
    const detail = detailRes.detail;
    assert.equal(detail.run.status, "completed");
    assert.equal(detail.run.winningBranch, `burn/${asyncStart.run.id}/glm-5.3-flash-free`);
    assert.match(detail.run.winningCommit ?? "", /^[0-9a-f]{40}$/i);
    assert.equal(detail.run.landingStatus, "not_landed");
    assert.equal(detail.framing?.artifact, "README.md");
    assert.deepEqual(detail.framing?.scope, ["src"]);

    const winningAttempt = detail.attempts.find(
      (a) => a.model === "opencode/glm-5.3-flash-free",
    );
    assert.ok(winningAttempt);
    assert.equal(winningAttempt.attemptCount, 1);
    assert.equal(winningAttempt.factoryVerdict, "green");
    assert.equal(winningAttempt.changedFiles.includes("src/feature.ts"), true);
    assert.match(winningAttempt.diffPatch ?? "", /FEATURE_LANDED/);

    // (c.1) Dirty <project-root> -> handlers.land returns pending-conflict and preserves winningBranch
    writeFileSync(join(repoDir, "README.md"), "# Uncommitted dirty edit\n", "utf8");
    const conflictRes = await handlers.land({ runId: asyncStart.run.id });
    assert.equal(conflictRes.ok, true);
    if (!conflictRes.ok) return;
    assert.equal(conflictRes.landing, "pending-conflict");
    assert.equal(conflictRes.winningBranch, detail.run.winningBranch);
    assert.equal(conflictRes.winningCommit, detail.run.winningCommit);
    assert.match(conflictRes.summary, /not clean|pending-conflict/i);
    assert.equal(existsSync(join(repoDir, "src", "feature.ts")), false);

    const branchStillExists = execFileSync(
      "git",
      ["branch", "--list", detail.run.winningBranch!],
      { cwd: repoDir, encoding: "utf8" },
    );
    assert.equal(branchStillExists.includes(detail.run.winningBranch!), true);

    const afterConflictDetail = await handlers.detail({ runId: asyncStart.run.id });
    assert.equal(afterConflictDetail.ok, true);
    if (afterConflictDetail.ok) {
      assert.equal(afterConflictDetail.detail.run.landingStatus, "pending-conflict");
      assert.ok(afterConflictDetail.detail.run.landingNote);
    }

    // (c.2) Clean <project-root> -> handlers.land merges winningCommit cleanly and sets landingStatus: "landed"
    execFileSync("git", ["checkout", "--", "README.md"], { cwd: repoDir, stdio: "ignore" });
    const landedRes = await handlers.land({ runId: asyncStart.run.id });
    assert.equal(landedRes.ok, true);
    if (!landedRes.ok) return;
    assert.equal(landedRes.landing, "landed");
    assert.equal(landedRes.winningBranch, detail.run.winningBranch);
    assert.equal(landedRes.winningCommit, detail.run.winningCommit);
    assert.equal(existsSync(join(repoDir, "src", "feature.ts")), true);
    assert.match(readFileSync(join(repoDir, "src", "feature.ts"), "utf8"), /FEATURE_LANDED/);

    const afterLandDetail = await handlers.detail({ runId: asyncStart.run.id });
    assert.equal(afterLandDetail.ok, true);
    if (afterLandDetail.ok) {
      assert.equal(afterLandDetail.detail.run.landingStatus, "landed");
    }
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(upstreamDir, { recursive: true, force: true });
  }
});

test("resolvePaseoHome defaults to ~/.paseo even when ~/.paseo-factory exists, honors explicit PASEO_HOME, and expands ~", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "burn-resolve-home-"));
  try {
    // A leftover trial home must no longer capture the unset-PASEO_HOME default.
    mkdirSync(join(homeDir, ".paseo-factory"), { recursive: true });
    assert.equal(existsSync(join(homeDir, ".paseo-factory")), true);

    assert.equal(resolvePaseoHome({}, homeDir), join(homeDir, ".paseo"));
    assert.equal(resolvePaseoHome({ PASEO_HOME: "" }, homeDir), join(homeDir, ".paseo"));
    assert.equal(resolvePaseoHome({ PASEO_HOME: "   " }, homeDir), join(homeDir, ".paseo"));

    // Explicit PASEO_HOME wins (trimmed), with ~-expansion preserved.
    assert.equal(resolvePaseoHome({ PASEO_HOME: "/custom/paseo " }, homeDir), "/custom/paseo");
    assert.equal(resolvePaseoHome({ PASEO_HOME: "~" }, homeDir), homeDir);
    assert.equal(resolvePaseoHome({ PASEO_HOME: "~/paseo-trial" }, homeDir), join(homeDir, "paseo-trial"));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("discoverDaemonFreeModels speaks only providers.listModels(\"opencode\") with single-flight dedup, a 5-minute TTL cache, and scout-driven refresh", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-discover-home-"));

  try {
    let listModelsCalls = 0;
    let gate: Promise<void> | null = null;
    let openGate: (() => void) | null = null;
    let clockNow = 1_000_000;

    const daemon = {
      agents: {
        async list() {
          return { entries: [] };
        },
        async create() {
          throw new Error("discovery must never open an agent session");
        },
        ref(id: string) {
          return {
            async send() {
              throw new Error("discovery must never send to an agent");
            },
          };
        },
      },
      providers: {
        async listModels(provider: string) {
          assert.equal(provider, "opencode");
          listModelsCalls += 1;
          if (gate) await gate;
          return {
            models: [
              { id: "opencode/glm-5.3-flash-free", label: "GLM 5.3 Flash Free" },
              { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" },
            ],
          };
        },
      },
    };

    const handlers = createBurnSurfaceHandlers({
      paseoHome,
      includeSelfRepo: false,
      daemon,
      now: () => clockNow,
      listOutput: ["opencode/glm-5.3-flash-free", "opencode/deepseek-v4.1-flash-free"].join("\n"),
      scoutProbeRunner: async () => ({
        healthy: true,
        latencyMs: 120,
        codeOutput: "ok",
        citationOutput: "Cited [src/index.ts:1].",
      }),
    });

    // (1) Concurrent callers share one in-flight discovery — a single listModels call.
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const first = handlers.discoverDaemonFreeModels();
    const second = handlers.discoverDaemonFreeModels();
    assert.equal(listModelsCalls, 1);
    openGate!();
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a);
    assert.ok(b);
    assert.deepEqual(b, a);
    assert.equal(a.provider, "opencode");
    assert.equal(typeof a.discoveredAt, "string");
    assert.deepEqual(
      a.models.map((m) => m.id),
      ["opencode/glm-5.3-flash-free", "opencode/deepseek-v4.1-flash-free"],
    );
    assert.equal(listModelsCalls, 1);

    // (2) Within the 5-minute TTL, direct calls and burn.snapshot status polls hit the cache.
    const cached = await handlers.discoverDaemonFreeModels();
    assert.equal(cached?.models.length, 2);
    await handlers.snapshot({});
    await handlers.snapshot({});
    assert.equal(listModelsCalls, 1);

    // (3) Once the TTL expires, the next call re-flies.
    clockNow += 5 * 60_000 + 1;
    gate = null;
    openGate = null;
    const refreshed = await handlers.discoverDaemonFreeModels();
    assert.equal(refreshed?.models.length, 2);
    assert.equal(listModelsCalls, 2);

    // (4) An explicit scout refresh invalidates the cache — the next status poll re-flies.
    const scoutRes = await handlers.scout({});
    assert.equal(scoutRes.ok, true);
    await handlers.snapshot({});
    assert.equal(listModelsCalls, 3);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
});




