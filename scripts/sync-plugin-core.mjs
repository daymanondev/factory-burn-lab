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

function buildVendoredFactoryCoreIndex(upstreamIndexContent) {
  let content = `${upstreamIndexContent.trimEnd()}\n`;
  if (!/\bprovisionPiAgentHome\b/.test(content)) {
    content += `export { provisionPiAgentHome } from "./pi-home.ts";\n`;
  }
  if (!/\bPiAgentRole\b/.test(content)) {
    content += `export type { PiAgentRole, PiAgentHomeInput } from "./pi-home.ts";\n`;
  }
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
    for (const existing of readdirSync(factoryCoreDir)) {
      if (existing.endsWith(".ts") && !upstreamFiles.includes(existing)) {
        rmSync(join(factoryCoreDir, existing), { force: true });
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
