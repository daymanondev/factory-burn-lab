import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCitations, verifyCitations } from "../src/citation-gate.ts";

test("parseCitations extracts single-line and line-range citations while ignoring markdown links and URLs", () => {
  const markdown = [
    "The entry point is defined in [src/index.ts:1-12] and calls [src/runner.ts:42].",
    "Ignore markdown links like [docs:10-20](https://example.com) and [http://localhost:3000].",
  ].join("\n");

  const citations = parseCitations(markdown);
  assert.deepEqual(citations, [
    {
      raw: "[src/index.ts:1-12]",
      path: "src/index.ts",
      startLine: 1,
      endLine: 12,
    },
    {
      raw: "[src/runner.ts:42]",
      path: "src/runner.ts",
      startLine: 42,
      endLine: 42,
    },
  ]);
});

test("verifyCitations passes when all citations resolve to existing files and valid line ranges", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "burn-cite-ok-"));
  try {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "engine.ts"), "line 1\nline 2\nline 3\nline 4\nline 5\n");
    writeFileSync(join(repoRoot, "README.md"), "# Title\nSummary line\n");

    const report = "Engine loop lives at [src/engine.ts:2-5] and overview at [README.md:1-2].";
    const result = verifyCitations(repoRoot, report);

    assert.equal(result.ok, true);
    assert.equal(result.totalCitations, 2);
    assert.equal(result.validCitations.length, 2);
    assert.equal(result.invalidCitations.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("verifyCitations fails on uncited claims, missing files, out-of-range lines, inverted ranges, and path traversal", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "burn-cite-fail-"));
  try {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "small.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");

    const emptyResult = verifyCitations(repoRoot, "This report makes architectural claims with zero citations.");
    assert.equal(emptyResult.ok, false);
    assert.equal(emptyResult.totalCitations, 0);

    const badReport = [
      "Valid ref: [src/small.ts:1-3].",
      "Out-of-bounds line: [src/small.ts:1-99].",
      "Inverted range: [src/small.ts:3-1].",
      "Zero start line: [src/small.ts:0-2].",
      "Missing file: [src/ghost.ts:1-5].",
      "Traversal attempt: [../secret.txt:1-2].",
      "Directory ref: [src:1-1].",
    ].join("\n");

    const result = verifyCitations(repoRoot, badReport);
    assert.equal(result.ok, false);
    assert.equal(result.totalCitations, 7);
    assert.equal(result.validCitations.length, 1);
    assert.equal(result.validCitations[0]?.raw, "[src/small.ts:1-3]");
    assert.equal(result.invalidCitations.length, 6);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
