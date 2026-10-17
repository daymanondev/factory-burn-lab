import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface CitationRef {
  raw: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface InvalidCitation extends CitationRef {
  reason: string;
}

export interface CitationGateResult {
  ok: boolean;
  totalCitations: number;
  validCitations: CitationRef[];
  invalidCitations: InvalidCitation[];
}

const CITATION_PATTERN = /\[([A-Za-z0-9_./-]+):(\d+)(?:-(\d+))?\](?!\()/g;

export function parseCitations(markdown: string): CitationRef[] {
  const results: CitationRef[] = [];
  for (const match of markdown.matchAll(CITATION_PATTERN)) {
    const raw = match[0];
    const filePath = match[1];
    if (filePath.includes("://") || /^(?:https?|ftp|file|ws|wss)$/i.test(filePath)) {
      continue;
    }
    const startLine = Number.parseInt(match[2], 10);
    const endLine = match[3] !== undefined ? Number.parseInt(match[3], 10) : startLine;
    results.push({
      raw,
      path: filePath,
      startLine,
      endLine,
    });
  }
  return results;
}

function countFileLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

export function verifyCitations(repoRoot: string, markdown: string): CitationGateResult {
  const citations = parseCitations(markdown);
  const validCitations: CitationRef[] = [];
  const invalidCitations: InvalidCitation[] = [];

  const canonicalRoot = existsSync(repoRoot) ? realpathSync.native(repoRoot) : resolve(repoRoot);

  for (const ref of citations) {
    if (ref.startLine < 1) {
      invalidCitations.push({ ...ref, reason: `startLine (${ref.startLine}) must be >= 1` });
      continue;
    }
    if (ref.endLine < ref.startLine) {
      invalidCitations.push({
        ...ref,
        reason: `endLine (${ref.endLine}) must be >= startLine (${ref.startLine})`,
      });
      continue;
    }
    if (isAbsolute(ref.path)) {
      invalidCitations.push({ ...ref, reason: `citation path must be relative to repository root` });
      continue;
    }

    const candidatePath = resolve(canonicalRoot, ref.path);
    const rel = relative(canonicalRoot, candidatePath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      invalidCitations.push({ ...ref, reason: `path escapes repository root: ${ref.path}` });
      continue;
    }

    if (!existsSync(candidatePath)) {
      invalidCitations.push({ ...ref, reason: `file does not exist: ${ref.path}` });
      continue;
    }

    let isRegularFile = false;
    try {
      const realCandidate = realpathSync.native(candidatePath);
      const realRel = relative(canonicalRoot, realCandidate);
      if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
        invalidCitations.push({ ...ref, reason: `symlink escapes repository root: ${ref.path}` });
        continue;
      }
      isRegularFile = statSync(realCandidate).isFile();
    } catch {
      isRegularFile = false;
    }

    if (!isRegularFile) {
      invalidCitations.push({ ...ref, reason: `path is not a regular file: ${ref.path}` });
      continue;
    }

    const content = readFileSync(candidatePath, "utf8");
    const lineCount = countFileLines(content);
    if (ref.endLine > lineCount) {
      invalidCitations.push({
        ...ref,
        reason: `cited line ${ref.endLine} exceeds file length (${lineCount} lines) in ${ref.path}`,
      });
      continue;
    }

    validCitations.push(ref);
  }

  return {
    ok: citations.length > 0 && invalidCitations.length === 0,
    totalCitations: citations.length,
    validCitations,
    invalidCitations,
  };
}
