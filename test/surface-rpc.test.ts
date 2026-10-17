import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBurnSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
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

test("burn.snapshot and burn.project.add expose projects, Supervisor lane, Free pool KPIs, and isolate state under burn-lab/", async () => {
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
        codeOutput: "FIXED_SUM=6",
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
          config: { provider: string; thinkingOptionId?: string };
          cwd: string;
          title: string;
          labels: Record<string, string>;
          prompt?: string;
        }) {
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

test("trial and desktop Paseo homes register factory-burn-lab and render live Free pool, active Projects, and Upstream issue #01 cleanly", async () => {
  const home = homedir();
  const homes = [join(home, ".paseo-factory"), join(home, ".paseo")];

  for (const paseoHome of homes) {
    const configPath = join(paseoHome, "config.json");
    if (!existsSync(configPath)) continue;

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins?: Record<string, { source?: string; path?: string; enabled?: boolean }>;
    };
    assert.ok(config.plugins?.["paseo-factory"], `expected paseo-factory in ${configPath}`);
    assert.deepEqual(config.plugins?.["factory-burn-lab"], {
      source: "directory",
      path: "/Users/andrewpham/Documents/code/self-project/factory-burn-lab/plugin",
      enabled: true,
    });

    const handlers = createBurnSurfaceHandlers({ paseoHome });
    const snap = await handlers.snapshot({});
    assert.equal(snap.ok, true);
    if (!snap.ok) continue;

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
    const issue01 = snap.view.upstreamIssues.find((i) => i.number === "01");
    assert.ok(issue01);
    assert.equal(issue01.status, "needs-triage");
    assert.equal(existsSync(join(paseoHome, "factory", "ledger.jsonl")), false);
  }
});


