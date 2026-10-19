import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addBurnProject,
  buildSmartRepoExcerpts,
  DEFAULT_SUPERVISOR_LANE,
  defaultSupervisorRunner,
  inferDefaultArtifact,
  inferDefaultGate,
  landBurnRunWinningBranch,
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
    assert.equal(reg.slug, added.project.slug);
    assert.equal(reg.root, added.project.root);
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

test("run-scoped createFactory writes ledger and reports under burn-lab/runs/<runId>/factory/ and infers default Gate from package.json", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-factory-scope-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-factory-scope-repo-"));

  try {
    initTempGitRepo(repoDir);
    // Without package.json, default gate falls back to exit 0 and artifact is README.md
    assert.equal(inferDefaultGate(repoDir, "proto-arena"), 'node -e "process.exit(0)"');
    assert.equal(inferDefaultGate(repoDir, "self-evolve"), "npm test && npm run check:bundle");
    assert.equal(inferDefaultArtifact(repoDir), "README.md");

    // Add package.json with a real test script
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "scoped-test-repo",
          version: "1.0.0",
          scripts: {
            test: 'node -e "const fs = require(\'node:fs\'); if (!fs.readFileSync(\'src/app.ts\', \'utf8\').includes(\'computeScore\')) process.exit(1); console.log(\'REAL_NPM_TEST_OK\');"',
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    execFileSync("git", ["add", "package.json"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add package.json with real test script"], {
      cwd: repoDir,
      stdio: "ignore",
    });

    assert.equal(inferDefaultGate(repoDir, "proto-arena"), "npm test");
    assert.equal(inferDefaultArtifact(repoDir), "package.json");

    const added = addBurnProject(paseoHome, repoDir, { name: "Scoped Factory Repo" });
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
          latencyMs: 180,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
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
          latencyMs: 220,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    const run = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "proto-arena",
      prompt: "Add helper comment in src/app.ts and run inferred npm test gate",
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Verify inferred npm test gate under run-scoped createFactory",
                subtasks: ["Update src/app.ts"],
              })
            : "# Scoped Factory Report\n\nVerified.",
      }),
      openCodeRunner: async ({ prompt, cwd }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: APPROVE — Clean diff and green gate.",
            stderr: "",
            latencyMs: 90,
          };
        }
        writeFileSync(
          join(cwd, "src", "app.ts"),
          [
            "// Verified by burn-lab",
            "export function computeScore(items: number[]): number {",
            "  return items.reduce((sum, n) => sum + n, 0);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        return {
          ok: true,
          stdout: "Updated src/app.ts.",
          stderr: "",
          latencyMs: 120,
        };
      },
    });

    assert.equal(run.status, "completed");
    assert.equal(run.framing?.gateCommand, "npm test");
    assert.equal(run.framing?.artifact, "package.json");

    // Verify run-scoped factory wrote ledger.jsonl and report-*.md inside burn-lab/runs/<runId>/factory/
    const runFactoryDir = join(paseoHome, "burn-lab", "runs", run.id, "factory");
    const scopedProjectFactoryDir = join(runFactoryDir, "projects", added.project.slug);
    assert.equal(
      existsSync(join(runFactoryDir, "ledger.jsonl")) ||
        existsSync(join(scopedProjectFactoryDir, "ledger.jsonl")),
      true,
    );
    const ledgerPath = existsSync(join(scopedProjectFactoryDir, "ledger.jsonl"))
      ? join(scopedProjectFactoryDir, "ledger.jsonl")
      : join(runFactoryDir, "ledger.jsonl");
    const ledgerText = readFileSync(ledgerPath, "utf8");
    assert.match(ledgerText, /"event":"contract_set"/);
    assert.match(ledgerText, /"event":"spawn_dispatched"/);
    assert.match(ledgerText, /"event":"claim_reported"/);
    assert.match(ledgerText, /"event":"gate_finished"/);
    assert.match(ledgerText, /"event":"report_written"/);

    const winner = run.attempts.find((a) => a.accepted);
    assert.ok(winner);
    assert.equal(winner.factoryVerdict, "green");
    assert.ok(winner.factoryReportPath);
    assert.equal(existsSync(winner.factoryReportPath), true);
    assert.ok(winner.claimedCommit);
    assert.match(winner.claimedCommit, /^[0-9a-f]{40}$/i);
    assert.equal(run.winningCommit, winner.claimedCommit);
    assert.equal(run.landingStatus, "not_landed");

    // Zero writes to paseo-factory's production ledger
    assert.equal(
      existsSync(
        join(paseoHome, "plugin-state", "paseo-factory", "projects", added.project.slug, "ledger.jsonl"),
      ),
      false,
    );
    assert.equal(existsSync(join(paseoHome, "factory", "ledger.jsonl")), false);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("self-repair rework loop retries failed Gate and failed Citation gate on try 2 with exact diagnostic feedback", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-rework-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-rework-repo-"));

  try {
    initTempGitRepo(repoDir);
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "rework-repo",
          version: "1.0.0",
          scripts: {
            test: 'node -e "const s = require(\'node:fs\').readFileSync(\'src/app.ts\', \'utf8\'); if (!s.includes(\'REPAIRED_ON_TRY_2\')) { console.error(\'EXPECTED_REPAIRED_ON_TRY_2_MARKER\'); process.exit(1); } console.log(\'GATE_GREEN_TRY_2\');"',
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    execFileSync("git", ["add", "package.json"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add package.json"], { cwd: repoDir, stdio: "ignore" });

    const added = addBurnProject(paseoHome, repoDir, { name: "Rework Repo" });
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
          latencyMs: 160,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reader-1m", "reviewer"],
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
          latencyMs: 240,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reader-1m", "reviewer"],
          wins: 1,
          attempts: 2,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    const glmPrompts: string[] = [];
    const nightRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "night-shift",
      prompt: "Repair computeScore marker under npm test",
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Self-repair failing gate on try 2",
                subtasks: ["Fix computeScore in src/app.ts"],
              })
            : "# Night Shift Rework Report",
      }),
      openCodeRunner: async ({ model, prompt, cwd }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: APPROVE — Verified self-repaired commit.",
            stderr: "",
            latencyMs: 80,
          };
        }
        if (model === "opencode/glm-5.3-flash-free") {
          glmPrompts.push(prompt);
          if (glmPrompts.length === 1) {
            // Try 1: broken edit that fails npm test
            writeFileSync(
              join(cwd, "src", "app.ts"),
              "export function computeScore() { return 0; }\n",
              "utf8",
            );
            return { ok: true, stdout: "Try 1 edit", stderr: "", latencyMs: 100 };
          }
          // Try 2: receives EXPECTED_REPAIRED_ON_TRY_2_MARKER in rework prompt and fixes it
          writeFileSync(
            join(cwd, "src", "app.ts"),
            "// REPAIRED_ON_TRY_2\nexport function computeScore(items: number[]): number {\n  return items.reduce((sum, n) => sum + n, 0);\n}\n",
            "utf8",
          );
          return { ok: true, stdout: "Try 2 fixed edit", stderr: "", latencyMs: 110 };
        }
        return { ok: true, stdout: "Unchanged", stderr: "", latencyMs: 200 };
      },
    });

    assert.equal(nightRun.status, "completed");
    assert.equal(glmPrompts.length, 2);
    assert.match(glmPrompts[1]!, /EXPECTED_REPAIRED_ON_TRY_2_MARKER/);

    const glmAttempt = nightRun.attempts.find((a) => a.model === "opencode/glm-5.3-flash-free");
    assert.ok(glmAttempt);
    assert.equal(glmAttempt.attemptCount, 2);
    assert.equal(glmAttempt.accepted, true);
    assert.equal(glmAttempt.factoryVerdict, "green");
    assert.ok(glmAttempt.claimedCommit);
    assert.match(glmAttempt.claimedCommit, /^[0-9a-f]{40}$/i);
    assert.deepEqual(glmAttempt.changedFiles, ["src/app.ts"]);
    assert.match(glmAttempt.diffPatch ?? "", /REPAIRED_ON_TRY_2/);
    assert.equal(nightRun.winningCommit, glmAttempt.claimedCommit);
    assert.equal(nightRun.landingStatus, "not_landed");

    // Also verify Citation gate rework on try 2 in oss-lab
    const citationPrompts: string[] = [];
    const ossReworkRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "oss-lab",
      prompt: "Cite computeScore with self-repair on try 2",
      targetRepo: repoDir,
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Self-repair invalid citation on try 2",
                subtasks: ["Cite src/app.ts"],
                gateCommand: 'node -e "process.exit(0)"',
                citationRequired: true,
              })
            : "# OSS Rework Report",
      }),
      openCodeRunner: async ({ model, prompt }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return { ok: true, stdout: "VERDICT: APPROVE — Validated.", stderr: "", latencyMs: 60 };
        }
        if (model === "opencode/deepseek-v4.1-flash-free") {
          citationPrompts.push(prompt);
          if (citationPrompts.length === 1) {
            return {
              ok: true,
              stdout: "Try 1 bad citation [src/nonexistent-file.ts:1-10].",
              stderr: "",
              latencyMs: 90,
            };
          }
          return {
            ok: true,
            stdout: "Try 2 fixed citation [src/app.ts:1-3].",
            stderr: "",
            latencyMs: 95,
          };
        }
        return { ok: true, stdout: "No citations", stderr: "", latencyMs: 100 };
      },
    });

    assert.equal(ossReworkRun.status, "completed");
    assert.equal(citationPrompts.length, 2);
    assert.match(citationPrompts[1]!, /src\/nonexistent-file\.ts:1-10/);
    const deepseekAttempt = ossReworkRun.attempts.find(
      (a) => a.model === "opencode/deepseek-v4.1-flash-free",
    );
    assert.ok(deepseekAttempt);
    assert.equal(deepseekAttempt.attemptCount, 2);
    assert.equal(deepseekAttempt.accepted, true);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("factory.claim() mechanically rejects attempts that touch MEMORY_FILES (AGENTS.md, CONTEXT.md) or violate declared scope", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-fence-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-fence-repo-"));

  try {
    initTempGitRepo(repoDir);
    writeFileSync(join(repoDir, "AGENTS.md"), "# Agent Rules\nNever mutate memory.\n", "utf8");
    writeFileSync(join(repoDir, "CONTEXT.md"), "# Domain Context\nCanonical glossary.\n", "utf8");
    execFileSync("git", ["add", "AGENTS.md", "CONTEXT.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add memory files"], { cwd: repoDir, stdio: "ignore" });

    const added = addBurnProject(paseoHome, repoDir, { name: "Fenced Repo" });
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
          latencyMs: 160,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
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
          latencyMs: 200,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    const fenceRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "proto-arena",
      prompt: "Attempt memory and scope violations",
      maxAttempts: 1,
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Enforce scope and MEMORY_FILES fence",
                subtasks: ["Candidate 1", "Candidate 2"],
                gateCommand: 'node -e "process.exit(0)"',
                scope: ["src/"],
              })
            : "# Fence Report",
      }),
      openCodeRunner: async ({ model, prompt, cwd }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return { ok: true, stdout: "VERDICT: APPROVE", stderr: "", latencyMs: 50 };
        }
        if (model === "opencode/glm-5.3-flash-free") {
          // Candidate 1 modifies AGENTS.md -> violates MEMORY_FILES & scope
          writeFileSync(join(cwd, "AGENTS.md"), "#Tampered rules\n", "utf8");
          return { ok: true, stdout: "Edited AGENTS.md", stderr: "", latencyMs: 100 };
        }
        // Candidate 2 modifies README.md -> outside declared scope ["src/"]
        writeFileSync(join(cwd, "README.md"), "# Outside scope edit\n", "utf8");
        return { ok: true, stdout: "Edited README.md", stderr: "", latencyMs: 100 };
      },
    });

    assert.equal(fenceRun.status, "completed");
    assert.equal(fenceRun.attempts.length, 2);
    for (const attempt of fenceRun.attempts) {
      assert.equal(attempt.factoryVerdict, "red");
      assert.equal(attempt.accepted, false);
      assert.match(
        attempt.rejectionReason ?? "",
        /outside declared scope|fenced memory files/i,
      );
    }
    assert.equal(fenceRun.winningBranch, undefined);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runCouncilCrossCheck feeds actual git diff, Gate output, and all 5 WATCH_QUESTIONS and rejects weakened tests", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-council-diff-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-council-diff-repo-"));

  try {
    initTempGitRepo(repoDir);
    const added = addBurnProject(paseoHome, repoDir, { name: "Council Diff Repo" });
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
          latencyMs: 160,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
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
          latencyMs: 190,
          gatePassed: true,
          citationPassed: true,
          roles: ["reviewer"],
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
          latencyMs: 210,
          gatePassed: true,
          citationPassed: true,
          roles: ["reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    const councilPrompts: string[] = [];

    const run = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "night-shift",
      prompt: "Fix score calculation without weakening tests",
      maxAttempts: 1,
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Verify diff-backed Council catches test-weakened",
                subtasks: ["Fix computeScore"],
                gateCommand: 'node -e "console.log(\'GATE_STDOUT_MARKER_123\')"',
                artifact: "README.md",
                scope: ["src/"],
              })
            : "# Council Rejected Report",
      }),
      openCodeRunner: async ({ prompt, cwd }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          councilPrompts.push(prompt);
          if (prompt.includes("WEAKENED_ASSERTION_DELETED")) {
            return {
              ok: true,
              stdout: "VERDICT: CHALLENGE — Flagged test-weakened: Free model deleted test assertion in diff.",
              stderr: "",
              latencyMs: 90,
            };
          }
          return { ok: true, stdout: "VERDICT: APPROVE — Looks good.", stderr: "", latencyMs: 90 };
        }
        // Free model claims everything is great in stdout, but weakens test in git diff!
        writeFileSync(
          join(cwd, "src", "app.ts"),
          "// WEAKENED_ASSERTION_DELETED\nexport function computeScore(): number { return 0; }\n",
          "utf8",
        );
        return {
          ok: true,
          stdout: "All tests strengthened and passing 100%!",
          stderr: "",
          latencyMs: 110,
        };
      },
    });

    assert.equal(run.status, "completed");
    assert.equal(councilPrompts.length >= 2, true);
    for (const cp of councilPrompts) {
      // Must include Contract (artifact + scope), ATTEMPT_OUTPUT, actual git diff, and gate output
      assert.match(cp, /CONTRACT: artifact=README\.md, scope=src\//);
      assert.match(cp, /ATTEMPT_OUTPUT:/);
      assert.equal(cp.includes("WORKER_OUTPUT:"), false);
      assert.match(cp, /WEAKENED_ASSERTION_DELETED/);
      assert.match(cp, /GATE_STDOUT_MARKER_123/);
      // Must include all 5 WATCH_QUESTIONS names
      for (const q of factoryCore.WATCH_QUESTIONS) {
        assert.equal(
          cp.includes(q.name),
          true,
          `Expected Council prompt to include WATCH_QUESTION ${q.name}`,
        );
      }
    }

    assert.equal(run.attempts.every((a) => !a.accepted), true);
    assert.match(run.attempts[0]?.rejectionReason ?? "", /Challenged by cross-family Council/i);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("buildSmartRepoExcerpts and oss-lab index nested files beyond 20 lines via git ls-files and validate deep citations", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-smart-oss-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-smart-oss-repo-"));
  const externalRepoDir = mkdtempSync(join(tmpdir(), "burn-external-oss-repo-"));

  try {
    initTempGitRepo(repoDir);
    initTempGitRepo(externalRepoDir);
    // Create 6 nested modules, including a deep 60-line file in src/deep/engine/calculator.ts
    const nestedDirs = [
      "src/mod1",
      "src/mod2",
      "src/mod3",
      "src/mod4",
      "src/mod5",
      "src/deep/engine",
    ];
    for (const d of nestedDirs) {
      mkdirSync(join(repoDir, d), { recursive: true });
    }
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(repoDir, `src/mod${i}/helper${i}.ts`),
        `export const helper${i} = ${i};\n`,
        "utf8",
      );
    }
    const deepLines = Array.from({ length: 60 }, (_, idx) =>
      idx + 1 === 40
        ? "export function hyperQuantumScorer(x: number): number { return x * 42; }"
        : `// line ${idx + 1} of calculator`,
    );
    writeFileSync(
      join(repoDir, "src/deep/engine/calculator.ts"),
      `${deepLines.join("\n")}\n`,
      "utf8",
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add nested modules and 60-line calculator"], {
      cwd: repoDir,
      stdio: "ignore",
    });

    const excerpts = buildSmartRepoExcerpts(
      repoDir,
      "Inspect hyperQuantumScorer in src/deep/engine/calculator.ts",
      ["Audit line 40 of src/deep/engine/calculator.ts"],
    );

    // Must index more than 4 files (up to 10) and include line 40 of src/deep/engine/calculator.ts (beyond old 20-line cap)
    assert.equal(excerpts.length > 4, true);
    assert.equal(excerpts.length <= 10, true);
    const calcExcerpt = excerpts.find((e) => e.includes("src/deep/engine/calculator.ts"));
    assert.ok(calcExcerpt, "Expected src/deep/engine/calculator.ts in smart repo excerpts");
    assert.match(calcExcerpt, /40: export function hyperQuantumScorer/);

    const added = addBurnProject(paseoHome, repoDir, { name: "Deep OSS Repo" });
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
          latencyMs: 180,
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
          latencyMs: 220,
          gatePassed: true,
          citationPassed: true,
          roles: ["reader-1m", "reviewer"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    const seenAttemptPrompts: string[] = [];
    const ossRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "oss-lab",
      prompt: "Explain hyperQuantumScorer in src/deep/engine/calculator.ts",
      targetRepo: repoDir,
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Audit hyperQuantumScorer",
                subtasks: ["Inspect src/deep/engine/calculator.ts lines 38-42"],
                citationRequired: true,
              })
            : "# Deep OSS Lab Report\n\nVerified [src/deep/engine/calculator.ts:38-42].",
      }),
      openCodeRunner: async ({ prompt }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: APPROVE — Deep citation verified.",
            stderr: "",
            latencyMs: 80,
          };
        }
        seenAttemptPrompts.push(prompt);
        return {
          ok: true,
          stdout: "hyperQuantumScorer multiplies by 42 at [src/deep/engine/calculator.ts:38-42].",
          stderr: "",
          latencyMs: 120,
        };
      },
    });

    assert.equal(ossRun.status, "completed");
    assert.equal(seenAttemptPrompts.some((p) => p.includes("40: export function hyperQuantumScorer")), true);
    assert.equal(ossRun.attempts.some((a) => a.accepted), true);
    assert.ok(ossRun.winningBranch);

    // When targetRepo is an external repo different from project.root, winningBranch must not be set on the project
    const externalOssRun = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "oss-lab",
      prompt: "Inspect external repo src/app.ts",
      targetRepo: externalRepoDir,
      supervisorRunner: async ({ phase }) => ({
        ok: true,
        stdout:
          phase === "framing"
            ? JSON.stringify({
                goal: "Audit external repo",
                subtasks: ["Cite src/app.ts"],
                citationRequired: true,
              })
            : "# External OSS Report",
      }),
      openCodeRunner: async ({ prompt }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return { ok: true, stdout: "VERDICT: APPROVE — Valid.", stderr: "", latencyMs: 60 };
        }
        return {
          ok: true,
          stdout: "External repo score logic at [src/app.ts:1-3].",
          stderr: "",
          latencyMs: 100,
        };
      },
    });
    assert.equal(externalOssRun.status, "completed");
    assert.equal(externalOssRun.winningBranch, undefined);
    assert.equal(externalOssRun.landingStatus, undefined);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(externalRepoDir, { recursive: true, force: true });
  }
});

test("multi-task SLP wave pipeline executes sequential tasks with skills, freshEyes, watch, meter, lead accept, retro, and cumulative landing", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-slp-waves-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "burn-slp-waves-repo-"));

  try {
    initTempGitRepo(repoDir);
    const added = addBurnProject(paseoHome, repoDir, { name: "SLP Multi-Wave Repo" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    saveFreePool(paseoHome, {
      updatedAt: new Date().toISOString(),
      models: [
        {
          id: "opencode/beam-free",
          family: "beam",
          displayName: "Beam Free",
          contextWindow: 256_000,
          healthy: true,
          latencyMs: 140,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reviewer"],
          wins: 2,
          attempts: 2,
          lastScoutedAt: new Date().toISOString(),
        },
        {
          id: "opencode/space-bunny-free",
          family: "space-bunny",
          displayName: "Space Bunny Free",
          contextWindow: 256_000,
          healthy: true,
          latencyMs: 180,
          gatePassed: true,
          citationPassed: true,
          roles: ["coder", "reader-1m", "reviewer"],
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
          latencyMs: 190,
          gatePassed: true,
          citationPassed: true,
          roles: ["reviewer", "reader-1m"],
          wins: 1,
          attempts: 1,
          lastScoutedAt: new Date().toISOString(),
        },
      ],
    });

    let framingPromptSeen = "";
    const run = await runBurnPlaybook({
      paseoHome,
      projectSlug: added.project.slug,
      playbook: "proto-arena",
      prompt: "Build an interactive web game with engine, UI, and regression tests",
      maxWaves: 3,
      maxAttempts: 1,
      supervisorRunner: async ({ phase, prompt }) => {
        if (phase === "framing") {
          framingPromptSeen = prompt;
          return {
            ok: true,
            stdout: JSON.stringify({
              goal: "Build multi-wave web game following SLP core",
              subtasks: [
                "Task 1: Create src/engine.ts core game engine",
                "Task 2: Create src/ui.ts interactive UI layer importing engine",
                "Task 3: Create test/game.test.ts verifying engine and UI together",
              ],
              gateCommand: 'node -e "process.exit(0)"',
              artifact: "README.md",
              skills: ["tdd", "codebase-design", "frontend-design"],
              citationRequired: false,
            }),
          };
        }
        return {
          ok: true,
          stdout: "# Multi-Wave SLP Synthesis Report\n\nAll 3 sequential task waves verified and landed.",
        };
      },
      openCodeRunner: async ({ model, prompt, cwd }) => {
        if (prompt.includes("COUNCIL_REVIEW")) {
          return {
            ok: true,
            stdout: "VERDICT: APPROVE — Wave diff and gate verified.",
            stderr: "",
            latencyMs: 60,
          };
        }
        if (prompt.includes("SLP Task Wave 1/3")) {
          writeFileSync(
            join(cwd, "src", "engine.ts"),
            "export const ENGINE_READY = true;\n",
            "utf8",
          );
          return {
            ok: true,
            stdout: `Wave 1 engine implemented by ${model}`,
            stderr: "",
            latencyMs: model.includes("beam") ? 100 : 160,
          };
        }
        if (prompt.includes("SLP Task Wave 2/3")) {
          // Wave 2 must see src/engine.ts committed in Wave 1!
          assert.equal(
            existsSync(join(cwd, "src", "engine.ts")),
            true,
            "Wave 2 worktree must inherit Wave 1 winning commit (src/engine.ts)",
          );
          writeFileSync(
            join(cwd, "src", "ui.ts"),
            "import { ENGINE_READY } from './engine.ts';\nexport const UI_READY = ENGINE_READY;\n",
            "utf8",
          );
          return {
            ok: true,
            stdout: `Wave 2 UI implemented by ${model}`,
            stderr: "",
            latencyMs: model.includes("space-bunny") ? 95 : 170,
          };
        }
        if (prompt.includes("SLP Task Wave 3/3")) {
          // Wave 3 must see both src/engine.ts (Wave 1) and src/ui.ts (Wave 2)!
          assert.equal(existsSync(join(cwd, "src", "engine.ts")), true);
          assert.equal(existsSync(join(cwd, "src", "ui.ts")), true);
          mkdirSync(join(cwd, "test"), { recursive: true });
          writeFileSync(
            join(cwd, "test", "game.test.ts"),
            "// Full regression test suite\nexport const TESTS_GREEN = true;\n",
            "utf8",
          );
          return {
            ok: true,
            stdout: `Wave 3 regression tests implemented by ${model}`,
            stderr: "",
            latencyMs: model.includes("beam") ? 105 : 175,
          };
        }
        return { ok: true, stdout: "ok", stderr: "", latencyMs: 100 };
      },
    });

    assert.equal(run.status, "completed");
    assert.equal(run.wavesCompleted, 3);
    assert.equal(run.attempts.length, 6);
    assert.match(framingPromptSeen, /REPOSITORY_CONTEXT_EXCERPTS:/);
    assert.deepEqual(run.framing?.skills, ["tdd", "codebase-design", "frontend-design"]);

    // Verify each wave had a Lead-accepted winner with Fresh-Eyes CLEAR and Watch WRITTEN
    for (const waveNum of [1, 2, 3]) {
      const waveLeadWinner = run.attempts.find((a) => a.wave === waveNum && a.leadAccepted);
      assert.ok(waveLeadWinner, `Expected a Lead-accepted winner for wave ${waveNum}`);
      assert.equal(waveLeadWinner.freshEyesOutcome, "clear");
      assert.equal(waveLeadWinner.watchOutcome, "written");
      assert.ok(waveLeadWinner.watchAnswers);
      assert.equal(typeof waveLeadWinner.watchAnswers["test-weakened"], "number");
    }

    // Verify Retro ran and wrote proposals file + ledger events
    assert.equal(run.retroOutcome, "written");
    assert.ok(run.retroProposalsPath);
    assert.equal(existsSync(run.retroProposalsPath!), true);

    const ledgerPath = join(
      paseoHome,
      "burn-lab",
      "runs",
      run.id,
      "factory",
      "projects",
      added.project.slug,
      "ledger.jsonl",
    );
    const ledgerText = readFileSync(ledgerPath, "utf8");
    assert.match(ledgerText, /"event":"contract_set"/);
    assert.match(ledgerText, /"skills":\["tdd","codebase-design","frontend-design"\]/);
    assert.match(ledgerText, /"freshEyes":true/);
    assert.match(ledgerText, /"watch":true/);
    assert.match(ledgerText, /"event":"fresh_eyes_written"/);
    assert.match(ledgerText, /"event":"watch_written"/);
    assert.match(ledgerText, /"event":"meter_written"/);
    assert.match(ledgerText, /"event":"attempt_accepted".*"accepted_by":"lead"/);
    assert.match(ledgerText, /"event":"retro_written"/);

    // Land the final winning branch into repoDir and verify all 3 waves' files are present!
    const landed = await landBurnRunWinningBranch(paseoHome, run.id);
    assert.equal(landed.ok, true);
    if (landed.ok) {
      assert.equal(landed.landing, "landed");
    }
    assert.equal(existsSync(join(repoDir, "src", "engine.ts")), true);
    assert.equal(existsSync(join(repoDir, "src", "ui.ts")), true);
    assert.equal(existsSync(join(repoDir, "test", "game.test.ts")), true);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});


