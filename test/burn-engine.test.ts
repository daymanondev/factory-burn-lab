import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addBurnProject,
  DEFAULT_SUPERVISOR_LANE,
  defaultSupervisorRunner,
  listBurnRuns,
  loadBurnRun,
  resolveBurnProjects,
  resolveFactoryStateDir,
  resolveProjectIdentity,
  resolveSupervisorLane,
  runBurnPlaybook,
} from "../src/burn-engine.ts";
import * as factoryCore from "../src/factory-core/index.ts";
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

test("src/factory-core/index.ts exports complete paseo-factory core surface and prepareTaskWorktree supports symlinkNodeModules cleanly", async () => {
  const requiredExports = [
    "createFactory",
    "runGate",
    "loadLanes",
    "runLaneCli",
    "parseLane",
    "projectLanesPath",
    "provisionPiAgentHome",
    "resolveProject",
    "projectStateDir",
    "readProjectRegistration",
    "writeProjectRegistration",
    "listProjectRegistrations",
    "discoverProjects",
    "resolveClaimedCommit",
    "checkCleanAt",
    "headCommitSync",
    "diffBetween",
    "changedFiles",
    "changesOutsideScope",
    "scopeCoversFile",
    "prepareTaskWorktree",
    "landTaskWorktree",
    "MEMORY_FILES",
    "WATCH_QUESTIONS",
    "parseEyeAnswer",
    "MAX_ATTEMPTS",
  ] as const;

  for (const symbol of requiredExports) {
    assert.notEqual(
      (factoryCore as Record<string, unknown>)[symbol],
      undefined,
      `Expected src/factory-core/index.ts to export ${symbol}`,
    );
  }

  const stateDir = mkdtempSync(join(tmpdir(), "burn-core-state-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-core-repo-"));
  const customWtDir = join(stateDir, "custom-wt", "attempt-1");
  try {
    initTempGitRepo(repoDir);
    mkdirSync(join(repoDir, "node_modules", "dummy-pkg"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "dummy-pkg", "index.js"), "module.exports = 1;\n", "utf8");
    writeFileSync(join(repoDir, ".env.local"), "SECRET_KEY=test\n", "utf8");
    writeFileSync(join(repoDir, ".worktreeinclude"), ".env*\n", "utf8");
    execFileSync("git", ["add", ".worktreeinclude"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add worktreeinclude"], { cwd: repoDir, stdio: "ignore" });

    const baseSha = factoryCore.headCommitSync(repoDir);
    assert.ok(baseSha);

    const prepared = factoryCore.prepareTaskWorktree({
      stateDir,
      workspace: repoDir,
      task: "attempt-1",
      base: baseSha,
      worktreePath: customWtDir,
      branchName: "burn/test-run/glm-5.3-flash-free",
      symlinkNodeModules: true,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.path, customWtDir);
    assert.equal(prepared.branch, "burn/test-run/glm-5.3-flash-free");
    assert.equal(existsSync(join(customWtDir, ".env.local")), true);
    assert.equal(existsSync(join(customWtDir, "node_modules", "dummy-pkg", "index.js")), true);

    const clean = await factoryCore.checkCleanAt(customWtDir, baseSha);
    assert.deepEqual(clean, { ok: true });
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", customWtDir], { cwd: repoDir, stdio: "ignore" });
    } catch {
      // ignore
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("resolveBurnProjects, resolveSupervisorLane, addBurnProject, and defaultSupervisorRunner unify with paseo-factory registry and runLaneCli", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-engine-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-sample-repo-"));
  const petDir = join(tmpdir(), `burn-pet-repo-${Date.now()}`);

  try {
    initTempGitRepo(repoDir);
    const identity = resolveProjectIdentity(repoDir);
    assert.equal(identity.ok, true);
    if (!identity.ok) return;

    const factoryStateDir = resolveFactoryStateDir(paseoHome);
    assert.equal(factoryStateDir, join(paseoHome, "plugin-state", "paseo-factory"));

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

    // Also verify plugin-state/paseo-factory lanes override via loadLanes
    mkdirSync(join(factoryStateDir, "projects", identity.slug), { recursive: true });
    writeFileSync(
      join(factoryStateDir, "projects", identity.slug, "lanes.json"),
      JSON.stringify({ supervisor: "pi/zai/glm-5.3:high" }),
      "utf8",
    );
    assert.equal(resolveSupervisorLane(paseoHome, identity.slug), "pi/zai/glm-5.3:high");

    const projects = resolveBurnProjects(paseoHome, { includeSelfRepo: false });
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.slug, identity.slug);
    assert.equal(projects[0]?.supervisorLane, "pi/zai/glm-5.3:high");

    const added = addBurnProject(paseoHome, petDir, { initGit: true, name: "Pet Prototype" });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.project.name, "Pet Prototype");
    assert.equal(existsSync(join(petDir, ".git")), true);

    // Verify addBurnProject wrote directly to <paseoHome>/plugin-state/paseo-factory/projects/<slug>/project.json
    const sharedProjectJson = join(factoryStateDir, "projects", added.project.slug, "project.json");
    assert.equal(existsSync(sharedProjectJson), true);
    const reg = factoryCore.readProjectRegistration(factoryStateDir, added.project.slug);
    assert.ok(reg);
    assert.equal(reg.root, added.project.root);
    assert.equal(reg.name, "Pet Prototype");
    assert.equal(
      factoryCore.listProjectRegistrations(factoryStateDir).some((r) => r.slug === added.project.slug),
      true,
    );
    assert.equal(
      factoryCore.discoverProjects(factoryStateDir, [], paseoHome).some((d) => d.slug === added.project.slug),
      true,
    );

    const updatedProjects = resolveBurnProjects(paseoHome, { includeSelfRepo: false });
    assert.equal(updatedProjects.length, 2);
    assert.equal(
      updatedProjects.find((p) => p.slug === added.project.slug)?.name,
      "Pet Prototype",
    );

    // Verify defaultSupervisorRunner invokes runLaneCli with stateDir: factoryStateDir (clean-room PI_CODING_AGENT_DIR + :thinking flags)
    const laneCalls: Array<{
      command: string;
      args: string[];
      env?: Record<string, string>;
    }> = [];
    const supRes = await defaultSupervisorRunner({
      lane: "pi/zai/glm-5.3:high",
      phase: "framing",
      playbook: "proto-arena",
      project: added.project,
      prompt: "Frame prototype task",
      cwd: added.project.root,
      timeoutMs: 5_000,
      paseoHome,
      laneCliRunner: async (call) => {
        laneCalls.push({ command: call.command, args: call.args, env: call.env });
        return { code: 0, stdout: '{"goal":"test"}', stderr: "", timedOut: false };
      },
    });
    assert.equal(supRes.ok, true);
    assert.equal(laneCalls.length, 1);
    assert.equal(laneCalls[0]?.command, "pi");
    assert.equal(laneCalls[0]?.args.includes("--thinking"), true);
    assert.equal(laneCalls[0]?.args.includes("high"), true);
    assert.equal(
      laneCalls[0]?.env?.PI_CODING_AGENT_DIR,
      join(factoryStateDir, "pi-agent", "headless"),
    );
    assert.equal(existsSync(join(factoryStateDir, "pi-agent", "headless", "settings.json")), true);

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

    // Cross-family Council must use 2 distinct families different from the target attempt
    assert.equal(run.councilNotes.length, 2);
    for (const note of run.councilNotes) {
      assert.notEqual(note.reviewerFamily, "glm");
    }

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

    // Verify Council CHALLENGE verdict demotes an attempt to accepted = false
    const challengedRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "oss-lab",
      prompt: "Test Council challenge filtering",
      targetRepo: repoDir,
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Test Council challenge",
                subtasks: ["Cite src/app.ts"],
                gateCommand: "node -e \"process.exit(0)\"",
                citationRequired: true,
              })
            : "# Challenged Report",
      }),
      openCodeRunner: async ({ prompt }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: CHALLENGE — Subtle logic flaw in interpretation of [src/app.ts:1-3].",
            stderr: "",
            latencyMs: 100,
          };
        }
        return {
          ok: true,
          stdout: "Claiming [src/app.ts:1-3] multiplies numbers.",
          stderr: "",
          latencyMs: 100,
        };
      },
    });
    assert.equal(challengedRun.attempts.every((a) => !a.accepted), true);
    assert.match(
      challengedRun.attempts[0]?.rejectionReason ?? "",
      /Challenged by cross-family Council/i,
    );
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
        stdout: `VERDICT: APPROVE — Prototype output from ${model}`,
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
    assert.equal(arenaRun.winningBranch, `burn/${arenaRun.id}/glm-5.3-flash-free`);
    assert.equal(arenaRun.attempts.filter((a) => a.accepted).length, 1);
    const branchesOut = execFileSync("git", ["branch", "--list", arenaRun.winningBranch!], {
      cwd: repoDir,
      encoding: "utf8",
    });
    assert.equal(branchesOut.includes(arenaRun.winningBranch!), true);

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
        codeOutput: model.id.includes("glm") ? "n > 0 ? acc + n : acc\nFIXED_SUM=6" : "NOPE",
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
