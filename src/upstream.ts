import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_UPSTREAM_ISSUES_DIR =
  "/Users/andrewpham/Documents/code/self-project/research-slp/.scratch/burn-lab-upstream/issues";

export interface UpstreamIssue {
  id: string;
  number: string;
  slug: string;
  title: string;
  status: string;
  filedBy: string;
  path: string;
  summary: string;
  body: string;
}

function normalizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "upstream-issue";
}

function parseIssueFile(filePath: string, fileName: string): UpstreamIssue {
  const body = readFileSync(filePath, "utf8");
  const baseName = fileName.replace(/\.md$/i, "");
  const match = baseName.match(/^(\d+)-(.+)$/);
  const number = match ? match[1] : "00";
  const slug = match ? match[2] : baseName;
  const id = `${number}-${slug}`;

  const headingMatch = body.match(/^#\s+(?:\d+\s+[—–-]\s+)?(.+)$/m);
  const title = headingMatch ? headingMatch[1].trim() : slug;

  const statusMatch = body.match(/^Status:\s*(.+)$/im);
  const status = statusMatch ? statusMatch[1].trim() : "needs-triage";

  const filedByMatch = body.match(/^Filed-by:\s*(.+)$/im);
  const filedBy = filedByMatch ? filedByMatch[1].trim() : "factory-burn-lab";

  let summary = "";
  const problemMatch = body.match(/^##\s+Problem\s*\r?\n+([^\r\n#]+)/im);
  if (problemMatch) {
    summary = problemMatch[1].trim();
  } else {
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith("#") &&
          !/^Status:/i.test(l) &&
          !/^Filed-by:/i.test(l),
      );
    summary = lines[0] ?? title;
  }

  return {
    id,
    number,
    slug,
    title,
    status,
    filedBy,
    path: filePath,
    summary,
    body,
  };
}

export function listUpstreamIssues(issuesDir: string = DEFAULT_UPSTREAM_ISSUES_DIR): UpstreamIssue[] {
  if (!existsSync(issuesDir)) {
    return [];
  }
  const entries = readdirSync(issuesDir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  return entries.map((name) => parseIssueFile(join(issuesDir, name), name));
}

export function fileUpstreamIssue(input: {
  issuesDir?: string;
  slug: string;
  title: string;
  problem: string;
  proposedChange: string;
  whyItMatters?: string;
}): UpstreamIssue {
  const issuesDir = input.issuesDir ?? DEFAULT_UPSTREAM_ISSUES_DIR;
  mkdirSync(issuesDir, { recursive: true });

  const existing = listUpstreamIssues(issuesDir);
  const maxNum = existing.reduce((acc, item) => {
    const parsed = Number.parseInt(item.number, 10);
    return Number.isFinite(parsed) && parsed > acc ? parsed : acc;
  }, 0);

  const nextNum = String(maxNum + 1).padStart(2, "0");
  const slug = normalizeSlug(input.slug || input.title);
  const fileName = `${nextNum}-${slug}.md`;
  const filePath = join(issuesDir, fileName);

  const title = input.title.trim() || slug;
  const problem = input.problem.trim();
  const proposedChange = input.proposedChange.trim();
  const whyItMatters =
    input.whyItMatters?.trim() ||
    "Requested by factory-burn-lab so core paseo-factory verification primitives remain clean and explicitly reviewed.";

  const markdown = [
    `# ${nextNum} — ${title}`,
    "",
    "Status: needs-triage",
    "Filed-by: factory-burn-lab",
    "",
    "## Problem",
    "",
    problem,
    "",
    "## Proposed Change",
    "",
    proposedChange,
    "",
    "## Why It Matters",
    "",
    whyItMatters,
    "",
  ].join("\n");

  writeFileSync(filePath, markdown, "utf8");
  return parseIssueFile(filePath, fileName);
}
