#!/usr/bin/env node
/**
 * Sync `paseo-factory` pure-Node verification core into `src/factory-core/`
 * (when the upstream sibling directory is present) and mirror `src/` (including
 * `src/factory-core/`) into `plugin/server/core/` — a verbatim copy the daemon
 * compiles inside the plugin boundary.
 *
 * Usage:
 *   node scripts/sync-plugin-core.mjs          copy (add/overwrite)
 *   node scripts/sync-plugin-core.mjs --check  exit 1 if out of sync, copy nothing
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(repoRoot, "src");
const factoryCoreDir = join(srcDir, "factory-core");
const coreDir = join(repoRoot, "plugin", "server", "core");
const check = process.argv.includes("--check");

function findUpstreamFactorySrcDir() {
  const candidates = [
    process.env.PASEO_FACTORY_SRC_DIR?.trim(),
    join(repoRoot, "..", "research-slp", "src"),
    join(repoRoot, "..", "paseo-factory", "src"),
    "/Users/andrewpham/Documents/code/self-project/research-slp/src",
    join(homedir(), "Documents", "code", "self-project", "research-slp", "src"),
    join(homedir(), "code", "self-project", "research-slp", "src"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate) && existsSync(join(candidate, "factory.ts"))) {
      return candidate;
    }
  }
  return null;
}

const BRIDGE_SYMBOLS = new Set([
  "ProjectRegistration",
  "readProjectRegistration",
  "writeProjectRegistration",
  "listProjectRegistrations",
  "discoverProjects",
  "taskWorktreePath",
  "parseTaskWorktreePath",
  "taskWorktreeBranch",
  "prepareTaskWorktree",
  "PrepareTaskWorktreeOptions",
  "PrepareTaskWorktreeResult",
]);

function stripBridgeSymbolsFromIndex(rawIndex) {
  return rawIndex.replace(
    /export\s+(type\s+)?\{([^}]+)\}\s+from\s+"(\.\/(?:project|workspace)\.ts)";/g,
    (fullMatch, typeKeyword, specifiers, fromPath) => {
      const kept = specifiers
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !BRIDGE_SYMBOLS.has(s.replace(/^type\s+/, "").trim()));
      if (kept.length === 0) return "";
      return `export ${typeKeyword ?? ""}{ ${kept.join(", ")} } from "${fromPath}";`;
    },
  );
}

function buildVendoredFactoryCoreIndex(upstreamIndexContent) {
  let content = stripBridgeSymbolsFromIndex(upstreamIndexContent).trimEnd() + "\n";

  const extraWorkspaceValues = ["headCommitSync", "changesOutsideScope", "landTaskWorktree"].filter(
    (sym) => !new RegExp(`\\b${sym}\\b`).test(content),
  );
  if (extraWorkspaceValues.length > 0) {
    content += `export { ${extraWorkspaceValues.join(", ")} } from "./workspace.ts";\n`;
  }
  if (!/\bLandingResult\b/.test(content)) {
    content += `export type { LandingResult } from "./workspace.ts";\n`;
  }

  const extraLanesValues = ["parseLane", "projectLanesPath"].filter(
    (sym) => !new RegExp(`\\b${sym}\\b`).test(content),
  );
  if (extraLanesValues.length > 0) {
    content += `export { ${extraLanesValues.join(", ")} } from "./lanes.ts";\n`;
  }
  if (!/\bParsedLane\b/.test(content)) {
    content += `export type { ParsedLane } from "./lanes.ts";\n`;
  }

  if (!/\bprovisionPiAgentHome\b/.test(content)) {
    content += `export { provisionPiAgentHome } from "./pi-home.ts";\n`;
  }
  if (!/\bPiAgentRole\b/.test(content)) {
    content += `export type { PiAgentRole, PiAgentHomeInput } from "./pi-home.ts";\n`;
  }

  content += [
    `export {`,
    `  readProjectRegistration,`,
    `  writeProjectRegistration,`,
    `  listProjectRegistrations,`,
    `  discoverProjects,`,
    `  taskWorktreePath,`,
    `  parseTaskWorktreePath,`,
    `  taskWorktreeBranch,`,
    `  prepareTaskWorktree,`,
    `} from "./companion-bridge.ts";`,
    `export type {`,
    `  ProjectRegistration,`,
    `  PrepareTaskWorktreeOptions,`,
    `  PrepareTaskWorktreeResult,`,
    `} from "./companion-bridge.ts";`,
    "",
  ].join("\n");

  return content;
}

if (!check) {
  const upstreamSrcDir = findUpstreamFactorySrcDir();
  if (upstreamSrcDir) {
    mkdirSync(factoryCoreDir, { recursive: true });
    const upstreamFiles = readdirSync(upstreamSrcDir).filter((name) => name.endsWith(".ts"));
    for (const name of upstreamFiles) {
      if (name === "index.ts") continue;
      const source = readFileSync(join(upstreamSrcDir, name), "utf8");
      const target = join(factoryCoreDir, name);
      if (!existsSync(target) || readFileSync(target, "utf8") !== source) {
        writeFileSync(target, source, "utf8");
      }
    }
    const upstreamIndexPath = join(upstreamSrcDir, "index.ts");
    if (existsSync(upstreamIndexPath)) {
      const generatedIndex = buildVendoredFactoryCoreIndex(
        readFileSync(upstreamIndexPath, "utf8"),
      );
      const targetIndex = join(factoryCoreDir, "index.ts");
      if (!existsSync(targetIndex) || readFileSync(targetIndex, "utf8") !== generatedIndex) {
        writeFileSync(targetIndex, generatedIndex, "utf8");
      }
    }
  }
}

function collectTsFiles(rootDir, currentDir = rootDir) {
  if (!existsSync(currentDir)) return [];
  const results = [];
  for (const entry of readdirSync(currentDir).sort()) {
    const abs = join(currentDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      results.push(...collectTsFiles(rootDir, abs));
    } else if (st.isFile() && entry.endsWith(".ts")) {
      results.push(relative(rootDir, abs).replace(/\\/g, "/"));
    }
  }
  return results;
}

if (!check) mkdirSync(coreDir, { recursive: true });

const sources = collectTsFiles(srcDir);
const copies = collectTsFiles(coreDir);
const problems = [];

for (const relPath of sources) {
  const source = readFileSync(join(srcDir, relPath), "utf8");
  const target = join(coreDir, relPath);
  if (!existsSync(target) || readFileSync(target, "utf8") !== source) {
    problems.push(relPath);
    if (!check) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source, "utf8");
    }
  }
}

for (const relPath of copies) {
  if (!sources.includes(relPath)) {
    problems.push(`plugin/server/core/${relPath} has no counterpart in src/`);
    if (!check) {
      rmSync(join(coreDir, relPath), { force: true });
    }
  }
}

if (problems.length > 0) {
  console.error(`plugin core out of sync with src/: ${problems.join(", ")}`);
  console.error(check ? "run: npm run sync:plugin-core" : "synced now — commit the updated copy");
  process.exit(check ? 1 : 0);
}

console.log(`plugin core in sync (${sources.length} files)`);
