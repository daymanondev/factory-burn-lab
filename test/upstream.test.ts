import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_UPSTREAM_ISSUES_DIR,
  fileUpstreamIssue,
  listUpstreamIssues,
} from "../src/upstream.ts";

test("DEFAULT_UPSTREAM_ISSUES_DIR points to research-slp/.scratch/burn-lab-upstream/issues", () => {
  assert.equal(
    DEFAULT_UPSTREAM_ISSUES_DIR,
    "/Users/andrewpham/Documents/code/self-project/research-slp/.scratch/burn-lab-upstream/issues",
  );
});

test("fileUpstreamIssue writes sequential needs-triage markdown issues and listUpstreamIssues reads them back", () => {
  const tempIssuesDir = mkdtempSync(join(tmpdir(), "burn-upstream-test-"));
  try {
    assert.deepEqual(listUpstreamIssues(tempIssuesDir), []);

    const first = fileUpstreamIssue({
      issuesDir: tempIssuesDir,
      slug: "Expose Supervisor Hook",
      title: "Expose Supervisor framing hook in paseo-factory",
      problem: "Burn lab needs a structured framing callback when launching multi-family swarms.",
      proposedChange: "Add an optional framing metadata field to project lanes.",
      whyItMatters: "Keeps Supervisor configuration unified across both plugins.",
    });

    assert.equal(first.number, "01");
    assert.equal(first.slug, "expose-supervisor-hook");
    assert.equal(first.id, "01-expose-supervisor-hook");
    assert.equal(first.status, "needs-triage");
    assert.equal(first.filedBy, "factory-burn-lab");
    assert.equal(first.title, "Expose Supervisor framing hook in paseo-factory");
    assert.equal(existsSync(first.path), true);

    const raw = readFileSync(first.path, "utf8");
    assert.match(raw, /^# 01 — Expose Supervisor framing hook in paseo-factory/m);
    assert.match(raw, /^Status: needs-triage$/m);
    assert.match(raw, /^Filed-by: factory-burn-lab$/m);
    assert.match(raw, /Burn lab needs a structured framing callback/);

    const second = fileUpstreamIssue({
      issuesDir: tempIssuesDir,
      slug: "worktree-gc-hook",
      title: "Add worktree GC notification hook",
      problem: "Proto Arena creates temporary worktrees that could share GC telemetry.",
      proposedChange: "Export worktree pruning helper in paseo-factory.",
    });

    assert.equal(second.number, "02");
    assert.equal(second.id, "02-worktree-gc-hook");

    const listed = listUpstreamIssues(tempIssuesDir);
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, "01-expose-supervisor-hook");
    assert.equal(listed[0]?.status, "needs-triage");
    assert.equal(
      listed[0]?.summary,
      "Burn lab needs a structured framing callback when launching multi-family swarms.",
    );
    assert.equal(listed[1]?.id, "02-worktree-gc-hook");
    assert.equal(listed[1]?.title, "Add worktree GC notification hook");
  } finally {
    rmSync(tempIssuesDir, { recursive: true, force: true });
  }
});
