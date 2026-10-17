import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverFreePool,
  extractModelFamily,
  freePoolPath,
  loadFreePool,
  runOpenCodeFreeModel,
  scoutFreePool,
} from "../src/free-pool.ts";

test("extractModelFamily normalizes OpenCode free model IDs into distinct model families", () => {
  assert.equal(extractModelFamily("opencode/glm-5.3-flash-free"), "glm");
  assert.equal(extractModelFamily("opencode/deepseek-v4.1-flash-free"), "deepseek");
  assert.equal(extractModelFamily("opencode/mimo-v2.6-flash-free"), "mimo");
  assert.equal(extractModelFamily("opencode/nemotron-3-ultra-free"), "nemotron");
  assert.equal(extractModelFamily("opencode/nemotron-3.5-lightning-free"), "nemotron");
  assert.equal(extractModelFamily("opencode/beam-free"), "beam");
  assert.equal(extractModelFamily("opencode/longcat-2.5-preview-free"), "longcat");
  assert.equal(extractModelFamily("opencode/space-bunny-free"), "space-bunny");
  assert.equal(extractModelFamily("opencode/big-pickle"), "big-pickle");
});

test("discoverFreePool parses opencode models output and enriches context window from cache metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "burn-discover-"));
  try {
    const cachePath = join(tempDir, "models.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        opencode: {
          models: {
            "glm-5.3-flash-free": {
              id: "glm-5.3-flash-free",
              name: "GLM 5.3 Flash Free",
              family: "glm",
              cost: { input: 0, output: 0 },
              limit: { context: 204800, output: 65536 },
            },
            "nemotron-3-ultra-free": {
              id: "nemotron-3-ultra-free",
              name: "Nemotron 3 Ultra Free",
              family: "nemotron",
              cost: { input: 0, output: 0 },
              limit: { context: 1000000, output: 65536 },
            },
            "big-pickle": {
              id: "big-pickle",
              name: "Big Pickle",
              cost: { input: 0, output: 0 },
              limit: { context: 256000, output: 32768 },
            },
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              cost: { input: 15, output: 75 },
              limit: { context: 200000, output: 32768 },
            },
          },
        },
      }),
    );

    const listOutput = [
      "opencode/glm-5.3-flash-free",
      "opencode/nemotron-3-ultra-free",
      "opencode/big-pickle",
      "opencode/claude-opus-4-6",
      "anthropic/claude-3-5-sonnet",
    ].join("\n");

    const pool = discoverFreePool({ listOutput, cachePath });
    assert.deepEqual(
      pool.map((m) => m.id),
      [
        "opencode/glm-5.3-flash-free",
        "opencode/nemotron-3-ultra-free",
        "opencode/big-pickle",
      ],
    );

    const nemotron = pool.find((m) => m.id === "opencode/nemotron-3-ultra-free");
    assert.ok(nemotron);
    assert.equal(nemotron.family, "nemotron");
    assert.equal(nemotron.displayName, "Nemotron 3 Ultra Free");
    assert.equal(nemotron.contextWindow, 1000000);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runOpenCodeFreeModel executes in an isolated directory and captures output or timeout", async () => {
  const res = await runOpenCodeFreeModel({
    model: "opencode/glm-5.3-flash-free",
    prompt: "Say READY",
    runner: async ({ model, prompt, cwd }) => {
      assert.equal(model, "opencode/glm-5.3-flash-free");
      assert.equal(prompt, "Say READY");
      assert.equal(existsSync(cwd), true);
      return {
        ok: true,
        stdout: "READY",
        stderr: "",
        latencyMs: 42,
      };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.stdout, "READY");
  assert.equal(res.latencyMs, 42);
});

test("scoutFreePool runs liveness, code-fix Gate, and Citation gate micro-battery and persists SwarmRoles to free-pool.json", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "burn-scout-home-"));
  try {
    const listOutput = [
      "opencode/glm-5.3-flash-free",
      "opencode/nemotron-3-ultra-free",
      "opencode/beam-free",
    ].join("\n");

    const state = await scoutFreePool({
      paseoHome,
      listOutput,
      probeRunner: async (model, { fixtureRepoDir }) => {
        assert.equal(existsSync(join(fixtureRepoDir, "src", "math.ts")), true);
        if (model.id === "opencode/glm-5.3-flash-free") {
          return {
            healthy: true,
            latencyMs: 320,
            codeOutput:
              "export function sumPositive(nums: number[]): number { return nums.reduce((acc, n) => (n > 0 ? acc + n : acc), 0); }\nFIXED_SUM=6",
            citationOutput: "Positive summation is implemented in [src/math.ts:1-3].",
          };
        }
        if (model.id === "opencode/nemotron-3-ultra-free") {
          return {
            healthy: true,
            latencyMs: 480,
            codeOutput: "FIXED_SUM=6",
            citationOutput: "Hallucinated file [src/nonexistent.ts:1-90].",
          };
        }
        return {
          healthy: false,
          latencyMs: 5000,
          error: "timeout after 5000ms",
        };
      },
    });

    assert.equal(existsSync(freePoolPath(paseoHome)), true);
    assert.equal(existsSync(join(paseoHome, "factory", "ledger.jsonl")), false);

    const loaded = loadFreePool(paseoHome);
    assert.equal(loaded.models.length, 3);
    assert.deepEqual(loaded, state);

    const glm = loaded.models.find((m) => m.id === "opencode/glm-5.3-flash-free");
    assert.ok(glm);
    assert.equal(glm.healthy, true);
    assert.equal(glm.gatePassed, true);
    assert.equal(glm.citationPassed, true);
    assert.deepEqual(glm.roles.sort(), ["coder", "reader-1m", "reviewer"]);
    assert.equal(glm.wins, 1);
    assert.equal(glm.attempts, 1);

    const nemotron = loaded.models.find((m) => m.id === "opencode/nemotron-3-ultra-free");
    assert.ok(nemotron);
    assert.equal(nemotron.healthy, true);
    assert.equal(nemotron.gatePassed, false);
    assert.equal(nemotron.citationPassed, false);
    assert.deepEqual(nemotron.roles, []);
    assert.equal(nemotron.wins, 0);
    assert.equal(nemotron.attempts, 1);

    const beam = loaded.models.find((m) => m.id === "opencode/beam-free");
    assert.ok(beam);
    assert.equal(beam.healthy, false);
    assert.deepEqual(beam.roles, []);
    assert.equal(beam.error, "timeout after 5000ms");

    // Second scout pass via openCodeRunner accumulates wins and attempts
    const secondState = await scoutFreePool({
      paseoHome,
      models: ["opencode/glm-5.3-flash-free"],
      listOutput,
      openCodeRunner: async () => ({
        ok: true,
        stdout: "n > 0 ? acc + n : acc\nFIXED_SUM=6 verified in [src/math.ts:1-3]",
        stderr: "",
        latencyMs: 210,
      }),
    });

    const glmAfter = secondState.models.find((m) => m.id === "opencode/glm-5.3-flash-free");
    assert.ok(glmAfter);
    assert.equal(glmAfter.wins, 2);
    assert.equal(glmAfter.attempts, 2);
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
});
