import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addBurnProject,
  DEFAULT_SUPERVISOR_LANE,
  listBurnRuns,
  loadBurnRun,
  resolveBurnProjects,
  resolveProjectIdentity,
  resolveSupervisorLane,
  runBurnPlaybook,
} from "../src/burn-engine.ts";
import { loadFreePool, saveFreePool } from "../src/free-pool.ts";
import { listUpstreamIssues } from "../src/upstream.ts";

function initTempGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Burn Test"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "app.ts"),
    [
      "export function computeScore(items: number[]): number {",
      "  return items.reduce((sum, n) => sum + n, 0);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(dir, "README.md"), "# Sample Repo\nArchitecture overview.\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
}

test("resolveBurnProjects, resolveSupervisorLane, and addBurnProject read paseo-factory projects and lanes without touching factory ledger", () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-engine-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-sample-repo-"));
  const petDir = join(tmpdir(), `burn-pet-repo-${Date.now()}`);

  try {
    initTempGitRepo(repoDir);
    const identity = resolveProjectIdentity(repoDir);
    assert.equal(identity.ok, true);
    if (!identity.ok) return;

    mkdirSync(join(paseoHome, "factory", "projects", identity.slug), { recursive: true });
    writeFileSync(
      join(paseoHome, "factory", "lanes.json"),
      JSON.stringify({ supervisor: "claude/claude-opus-4-6", worker: DEFAULT_SUPERVISOR_LANE }),
      "utf8",
    );
    writeFileSync(
      join(paseoHome, "factory", "projects", `${identity.slug}.json`),
      JSON.stringify({ slug: identity.slug, name: "sample-repo", root: identity.root }),
      "utf8",
    );

    assert.equal(resolveSupervisorLane(paseoHome), "claude/claude-opus-4-6");
    assert.equal(resolveSupervisorLane(paseoHome, identity.slug), "claude/claude-opus-4-6");

    writeFileSync(
      join(paseoHome, "factory", "projects", identity.slug, "lanes.json"),
      JSON.stringify({ supervisor: "copilot/gpt-5.4" }),
      "utf8",
    );
    assert.equal(resolveSupervisorLane(paseoHome, identity.slug), "copilot/gpt-5.4");

    const projects = resolveBurnProjects(paseoHome, { includeSelfRepo: false });
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.slug, identity.slug);
    assert.equal(projects[0]?.supervisorLane, "copilot/gpt-5.4");

    const added = addBurnProject(paseoHome, petDir, { initGit: true, name: "Pet Prototype" });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.project.name, "Pet Prototype");
    assert.equal(existsSync(join(petDir, ".git")), true);

    const updatedProjects = resolveBurnProjects(paseoHome, { includeSelfRepo: false });
    assert.equal(updatedProjects.length, 2);
    assert.equal(existsSync(join(paseoHome, "factory", "ledger.jsonl")), false);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(petDir, { recursive: true, force: true });
  }
});

test("runBurnPlaybook oss-lab enforces Citation gate and cross-family Council before Supervisor synthesis", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-oss-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-oss-repo-"));

  try {
    initTempGitRepo(repoDir);
    const added = addBurnProject(paseoHome, repoDir, { name: "OSS Target" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    saveFreePool(paseoHome, {
      updatedAt: new Date().toISOString(),
      models: [
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
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
        {
          id: "opencode/deepseek-v4.1-flash-free",
          family: "deepseek",
          displayName: "DeepSeek V4.1 Flash Free",
          contextWindow: 200_000,
          healthy: true,
          latencyMs: 310,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reader-1m", "reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
        {
          id: "opencode/nemotron-3-ultra-free",
          family: "nemotron",
          displayName: "Nemotron 3 Ultra Free",
          contextWindow: 1_000_000,
          healthy: true,
          latencyMs: 420,
          gatePassed: false,
          citationPassed: true,
          roles: ["reader-1m", "reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    const supervisorCalls: Array<{ phase: string; prompt: string }> = [];

    const run = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "oss-lab",
      prompt: "Analyze score calculation architecture and verify entry points.",
      targetRepo: repoDir,
      supervisorRunner: async ({ phase, prompt }) => {
        supervisorCalls.push({ phase, prompt });
        if (phase === "framing") {
          return {
            ok: true,
            stdout: JSON.stringify({
              goal: "Audit computeScore implementation with verified citations",
              subtasks: [
                "Inspect src/app.ts and cite exact line ranges",
                "Verify README documentation and module exports",
              ],
              gateCommand: "node -e \"process.exit(0)\"",
              citationRequired: true,
            }),
          };
        }
        return {
          ok: true,
          stdout:
            "# Synthesized OSS Lab Report\n\nVerified score engine at [src/app.ts:1-3] and overview at [README.md:1-2].",
        };
      },
      openCodeRunner: async ({ model, prompt }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: APPROVE — Verified citations [src/app.ts:1-3] match repository.",
            stderr: "",
            latencyMs: 120,
          };
        }
        if (model === "opencode/glm-5.3-flash-free") {
          return {
            ok: true,
            stdout:
              "Score summation uses Array.reduce in [src/app.ts:1-3] and is documented in [README.md:1-2].",
            stderr: "",
            latencyMs: 180,
          };
        }
        // Second model hallucinates a nonexistent file -> must be rejected by Citation gate!
        return {
          ok: true,
          stdout: "SECRET_HALLUCINATION: core logic lives in [src/ghost-hallucinated.ts:1-99].",
          stderr: "",
          latencyMs: 200,
        };
      },
    });

    assert.equal(run.status, "completed");
    assert.deepEqual(run.statusHistory, [
      "queued",
      "framing",
      "swarm-running",
      "verifying",
      "synthesizing",
      "completed",
    ]);

    // Verify Citation gate accepted glm and rejected the hallucinating model
    const accepted = run.attempts.filter((a) => a.accepted);
    const rejected = run.attempts.filter((a) => !a.accepted);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.model, "opencode/glm-5.3-flash-free");
    assert.equal(rejected.length >= 1, true);
    assert.match(rejected[0]?.rejectionReason ?? "", /Citation gate/i);

    // Cross-family Council must use a different family than the target attempt
    assert.equal(run.councilNotes.length >= 1, true);
    assert.notEqual(run.councilNotes[0]?.reviewerFamily, "glm");

    // Supervisor synthesis prompt must include verified evidence and exclude rejected hallucination
    const synthCall = supervisorCalls.find((c) => c.phase === "synthesizing");
    assert.ok(synthCall);
    assert.equal(synthCall.prompt.includes("[src/app.ts:1-3]"), true);
    assert.equal(synthCall.prompt.includes("SECRET_HALLUCINATION"), false);

    // Report written to disk and run persisted
    assert.ok(run.reportPath);
    assert.equal(existsSync(run.reportPath), true);
    assert.match(readFileSync(run.reportPath, "utf8"), /Synthesized OSS Lab Report/);

    const loadedRun = loadBurnRun(paseoHome, run.id);
    assert.ok(loadedRun);
    assert.equal(loadedRun.id, run.id);
    assert.equal(listBurnRuns(paseoHome).length, 1);

    // Free pool stats updated
    const updatedPool = loadFreePool(paseoHome);
    const glmRecord = updatedPool.models.find((m) => m.id === "opencode/glm-5.3-flash-free");
    assert.equal(glmRecord?.wins, 2);
    assert.equal(glmRecord?.attempts, 2);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runBurnPlaybook proto-arena, night-shift, self-evolve, and scout-pool execute 3-tier verification and file upstream issues when needed", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-playbooks-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-arena-repo-"));
  const upstreamDir = mkdtempSync(join(tmpdir(), "burn-upstream-dir-"));

  try {
    initTempGitRepo(repoDir);
    const added = addBurnProject(paseoHome, repoDir, { name: "Arena Project" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    saveFreePool(paseoHome, {
      updatedAt: new Date().toISOString(),
      models: [
        {
          id: "opencode/glm-5.3-flash-free",
          family: "glm",
          displayName: "GLM 5.3 Flash Free",
          contextWindow: 204_800,
          healthy: true,
          latencyMs: 220,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reader-1m", "reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
        {
          id: "opencode/deepseek-v4.1-flash-free",
          family: "deepseek",
          displayName: "DeepSeek V4.1 Flash Free",
          contextWindow: 200_000,
          healthy: true,
          latencyMs: 280,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reader-1m", "reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    // 1. Proto Arena: Best-of-N tournament where glm passes Gate and deepseek fails Gate
    const arenaRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "proto-arena",
      prompt: "Build a fast score aggregator prototype.",
      gateCommand: "node -e \"process.exit(0)\"",
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Race coder models on prototype implementation",
                subtasks: ["Candidate A implementation", "Candidate B implementation"],
                gateCommand: "node -e \"process.exit(0)\"",
                citationRequired: false,
              })
            : "# Proto Arena Winner\n\nWinning prototype verified under Gate.",
      }),
      openCodeRunner: async ({ model }) => ({
        ok: true,
        stdout: `Prototype output from ${model}`,
        stderr: "",
        latencyMs: model.includes("glm") ? 150 : 260,
      }),
      gateRunner: async ({ cwd }) => {
        const isFirstCandidate = cwd.includes("attempt-1");
        return {
          ok: isFirstCandidate,
          command: "npm test",
          exitCode: isFirstCandidate ? 0 : 1,
          stdout: isFirstCandidate ? "PASS" : "",
          stderr: isFirstCandidate ? "" : "FAIL",
        };
      },
    });

    assert.equal(arenaRun.status, "completed");
    assert.equal(arenaRun.winningModel, "opencode/glm-5.3-flash-free");
    assert.equal(arenaRun.attempts.filter((a) => a.accepted).length, 1);

    // 2. Night Shift: isolated worktrees + Gate + Council
    const nightRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "night-shift",
      prompt: "Hunt edge-case bugs in computeScore.",
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Strengthen edge-case tests",
                subtasks: ["Add negative number test coverage"],
                gateCommand: "node -e \"process.exit(0)\"",
                citationRequired: false,
              })
            : "# Night Shift Summary\n\nEdge-case test suite green.",
      }),
      openCodeRunner: async () => ({
        ok: true,
        stdout: "VERDICT: APPROVE — Added edge-case test coverage.",
        stderr: "",
        latencyMs: 140,
      }),
      gateRunner: async ({ command }) => ({
        ok: true,
        command,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
      }),
    });
    assert.equal(nightRun.status, "completed");
    assert.equal(nightRun.attempts.some((a) => a.accepted), true);

    // 3. Self-Evolve: targets factory-burn-lab and files an Upstream issue when a core factory gap is flagged
    const evolveRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "self-evolve",
      prompt: "Add multi-family Council telemetry and file upstream hook request.",
      upstreamIssuesDir: upstreamDir,
      upstreamGap: {
        slug: "council-telemetry-hook",
        title: "Add Council verification metadata hook in paseo-factory",
        problem: "factory-burn-lab wants to attach Council verdicts to Supervisor handoff notes.",
        proposedChange: "Allow optional councilSummary field in Supervisor seat context.",
      },
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Self-evolve Burn Lab under bundle check",
                subtasks: ["Implement feature under npm test && npm run check:bundle"],
                gateCommand: "npm test && npm run check:bundle",
                citationRequired: false,
              })
            : "# Self-Evolve Report\n\nFeature verified and upstream issue filed.",
      }),
      openCodeRunner: async () => ({
        ok: true,
        stdout: "VERDICT: APPROVE — Bundle boundary clean.",
        stderr: "",
        latencyMs: 130,
      }),
      gateRunner: async ({ command }) => ({
        ok: true,
        command,
        exitCode: 0,
        stdout: "bundle ok",
        stderr: "",
      }),
    });

    assert.equal(evolveRun.status, "completed");
    assert.ok(evolveRun.upstreamIssue);
    assert.equal(evolveRun.upstreamIssue.id, "01-council-telemetry-hook");
    assert.equal(listUpstreamIssues(upstreamDir).length, 1);

    // 4. Scout Pool playbook via runBurnPlaybook
    const scoutRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "scout-pool",
      prompt: "Benchmark all OpenCode free models",
      listOutput: "opencode/glm-5.3-flash-free\nopencode/nemotron-3-ultra-free\n",
      scoutProbeRunner: async (model) => ({
        healthy: true,
        latencyMs: 190,
        codeOutput: model.id.includes("glm") ? "FIXED_SUM=6" : "NOPE",
        citationOutput: "Cited [src/math.ts:1-3].",
      }),
      supervisorRunner: async () => ({
        ok: true,
        stdout: "# Scout Pool Report\n\nBenchmarked 2 free models.",
      }),
    });

    assert.equal(scoutRun.status, "completed");
    assert.equal(scoutRun.attempts.length, 2);
    assert.equal(existsSync(join(paseoHome, "factory", "ledger.jsonl")), false);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(upstreamDir, { recursive: true, force: true });
  }
});
