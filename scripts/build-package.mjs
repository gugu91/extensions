#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

const packageDir = process.cwd();
const packageName = path.basename(packageDir);
const distDir = path.join(packageDir, "dist");

const packageConfigs = {
  "slack-bridge": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(["vitest.config.ts"]),
    excludePrefixes: [],
  },
  "nvim-bridge": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo", "nvim"]),
    excludeFiles: new Set(["vitest.config.ts"]),
    excludePrefixes: [],
  },
  "neon-psql": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo", "python"]),
    excludeFiles: new Set(["vitest.config.ts"]),
    excludePrefixes: [],
  },
  "slack-api": {
    excludeDirs: new Set(["dist", "node_modules", ".turbo"]),
    excludeFiles: new Set(),
    excludePrefixes: ["scripts/"],
  },
};

const config = packageConfigs[packageName];
if (!config) {
  throw new Error(`Unsupported package for build-package.mjs: ${packageName}`);
}

function shouldInclude(relativePath) {
  if (!relativePath.endsWith(".ts")) return false;
  if (relativePath.endsWith(".test.ts")) return false;
  if (config.excludeFiles.has(relativePath)) return false;
  if (config.excludePrefixes.some((prefix) => relativePath.startsWith(prefix))) return false;

  const parts = relativePath.split(path.sep);
  return !parts.some((part) => config.excludeDirs.has(part));
}

function rewriteRelativeTsSpecifiers(source) {
  return source.replace(/(["'])(\.\.?\/[^"']+)\.ts\1/g, "$1$2.js$1");
}

async function collectSourceFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(packageDir, absolutePath);

    if (entry.isDirectory()) {
      if (config.excludeDirs.has(entry.name)) {
        continue;
      }
      files.push(...(await collectSourceFiles(absolutePath)));
      continue;
    }

    if (shouldInclude(relativePath)) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

async function build() {
  await fs.rm(distDir, { recursive: true, force: true });

  const sourceFiles = await collectSourceFiles(packageDir);
  for (const relativePath of sourceFiles) {
    const inputPath = path.join(packageDir, relativePath);
    const outputPath = path.join(distDir, relativePath.replace(/\.ts$/, ".js"));
    const sourceText = await fs.readFile(inputPath, "utf8");
    const rewritten = rewriteRelativeTsSpecifiers(sourceText);
    const transpiled = ts.transpileModule(rewritten, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        verbatimModuleSyntax: true,
      },
      fileName: inputPath,
      reportDiagnostics: true,
    });

    const diagnostics = transpiled.diagnostics ?? [];
    const blocking = diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (blocking.length > 0) {
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(blocking, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => packageDir,
          getNewLine: () => "\n",
        }),
      );
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, transpiled.outputText, "utf8");
  }
}

await build();
