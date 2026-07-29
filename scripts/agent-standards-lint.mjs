#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const IMPLEMENTATION_TS_PATTERN = /\.ts$/;
const DECLARATION_TS_PATTERN = /\.d\.ts$/;
const TEST_TS_PATTERN = /(?:^|[./])[^/]*\.test\.ts$/;
const GENERATED_PATH_SEGMENTS = new Set(["node_modules", "dist"]);

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return runGit(args, { allowFailure: true });
  } catch {
    return null;
  }
}

function splitLines(value) {
  return value.length === 0 ? [] : value.split("\n").filter(Boolean);
}

function isRelevantTypeScriptFile(filePath) {
  if (!IMPLEMENTATION_TS_PATTERN.test(filePath)) return false;
  if (DECLARATION_TS_PATTERN.test(filePath)) return false;
  return !filePath.split("/").some((segment) => GENERATED_PATH_SEGMENTS.has(segment));
}

function isRelevantSourceFile(filePath) {
  return isRelevantTypeScriptFile(filePath) && !TEST_TS_PATTERN.test(filePath);
}

function resolveBaseRef() {
  const explicit = process.env.AGENT_STANDARDS_BASE_REF;
  const candidates = explicit ? [explicit] : ["origin/main", "main", "HEAD~1"];

  for (const candidate of candidates) {
    const mergeBase = tryGit(["merge-base", "HEAD", candidate]);
    if (mergeBase) return mergeBase;
  }

  return null;
}

export function parseNameStatusEntries(nameStatusText) {
  const entries = [];

  for (const line of splitLines(nameStatusText)) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R")) {
      const [, oldPath, newPath] = parts;
      if (oldPath && newPath && isRelevantTypeScriptFile(newPath)) {
        entries.push({ path: newPath, basePath: oldPath });
      }
      continue;
    }

    if (status.startsWith("C")) {
      const [, , newPath] = parts;
      if (newPath && isRelevantTypeScriptFile(newPath)) {
        entries.push({ path: newPath, basePath: null });
      }
      continue;
    }

    const [, filePath] = parts;
    if (filePath && isRelevantTypeScriptFile(filePath)) {
      entries.push({ path: filePath, basePath: status === "A" ? null : filePath });
    }
  }

  return entries;
}

function listChangedFileEntries(baseRef) {
  const files = new Map();
  const diffSpecs = [
    ["diff", "--name-status", "-M", "--diff-filter=ACMR", `${baseRef}...HEAD`, "--", "*.ts"],
    ["diff", "--name-status", "-M", "--diff-filter=ACMR", baseRef, "--", "*.ts"],
    ["diff", "--cached", "--name-status", "-M", "--diff-filter=ACMR", "--", "*.ts"],
  ];

  for (const spec of diffSpecs) {
    for (const entry of parseNameStatusEntries(tryGit(spec) ?? "")) {
      files.set(entry.path, entry);
    }
  }

  for (const filePath of splitLines(
    tryGit(["ls-files", "--others", "--exclude-standard", "--", "*.ts"]) ?? "",
  )) {
    if (isRelevantTypeScriptFile(filePath)) files.set(filePath, { path: filePath, basePath: null });
  }

  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function readCurrentFile(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function readBaseFile(baseRef, filePath) {
  if (!filePath) return "";
  return tryGit(["show", `${baseRef}:${filePath}`]) ?? "";
}

export function countTypeEscapeHatches(sourceText, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const counts = { unknown: 0, any: 0 };

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.UnknownKeyword) counts.unknown += 1;
    if (node.kind === ts.SyntaxKind.AnyKeyword) counts.any += 1;
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return counts;
}

export function buildDiffArgsForEntry(baseRef, entry) {
  const paths =
    entry.basePath && entry.basePath !== entry.path ? [entry.basePath, entry.path] : [entry.path];
  return ["diff", "--unified=0", "-M", baseRef, "--", ...paths];
}

function parseAddedLineRanges(diffText, filePath, currentSourceText) {
  if (diffText.trim().length === 0) {
    const isUntracked = splitLines(
      tryGit(["ls-files", "--others", "--exclude-standard", "--", filePath]) ?? "",
    ).includes(filePath);
    if (!isUntracked) return [];
    const lineCount = currentSourceText.length === 0 ? 0 : currentSourceText.split("\n").length;
    return lineCount > 0 ? [{ start: 1, end: lineCount }] : [];
  }

  const ranges = [];
  for (const line of diffText.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const length = match[2] == null ? 1 : Number(match[2]);
    if (length > 0) ranges.push({ start, end: start + length - 1 });
  }
  return ranges;
}

function lineIsAdded(lineNumber, addedLineRanges) {
  return addedLineRanges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
}

function isExportedNode(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function isExportedVariableDeclaration(node) {
  return ts.isVariableDeclarationList(node.parent) && isExportedNode(node.parent.parent);
}

function hasSingleUseHelperIgnore(sourceText, position) {
  const precedingText = sourceText.slice(Math.max(0, position - 300), position);
  return /agent-standards-ignore\s+prefer-inline-single-use-helper/.test(precedingText);
}

function collectExportedSymbols(sourceFile, checker) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return new Set();
  return new Set(
    checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) =>
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
      ),
  );
}

function isLocalHelperDeclaration(node, exportedSymbols, checker) {
  if (ts.isFunctionDeclaration(node)) {
    const symbol = node.name ? checker.getSymbolAtLocation(node.name) : undefined;
    return Boolean(node.name && !isExportedNode(node) && symbol && !exportedSymbols.has(symbol));
  }
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    isExportedVariableDeclaration(node)
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(node.name);
  if (!symbol || exportedSymbols.has(symbol)) {
    return false;
  }
  return Boolean(
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)),
  );
}

function helperKey(node) {
  const names = [node.name.text];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name) {
      names.push(parent.name.text);
    } else if (
      (ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) &&
      ts.isVariableDeclaration(parent.parent) &&
      ts.isIdentifier(parent.parent.name)
    ) {
      names.push(parent.parent.name.text);
    } else if (ts.isMethodDeclaration(parent) && ts.isIdentifier(parent.name)) {
      names.push(parent.name.text);
    } else if (ts.isClassDeclaration(parent) && parent.name) {
      names.push(parent.name.text);
    }
  }
  return names.reverse().join(".");
}

function collectHelperKeys(sourceFile, checker) {
  const helperKeys = new Set();
  const exportedSymbols = collectExportedSymbols(sourceFile, checker);
  const visit = (node) => {
    if (isLocalHelperDeclaration(node, exportedSymbols, checker)) {
      helperKeys.add(helperKey(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return helperKeys;
}

function collectHelperDeclarations(
  sourceFile,
  sourceText,
  addedLineRanges,
  existingHelperKeys,
  checker,
) {
  const helpers = [];
  const exportedSymbols = collectExportedSymbols(sourceFile, checker);
  const visit = (node) => {
    if (isLocalHelperDeclaration(node, exportedSymbols, checker)) {
      const start = node.name.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const lineNumber = line + 1;
      if (
        lineIsAdded(lineNumber, addedLineRanges) &&
        !existingHelperKeys.has(helperKey(node)) &&
        !hasSingleUseHelperIgnore(sourceText, start)
      ) {
        helpers.push({
          name: node.name.text,
          line: lineNumber,
          column: character + 1,
          declarationPosition: start,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return helpers;
}

function createSingleFileProgram(sourceText, fileName) {
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const absoluteFileName = path.resolve(fileName);
  const host = ts.createCompilerHost(options);
  host.fileExists = (requestedFileName) => path.resolve(requestedFileName) === absoluteFileName;
  host.readFile = (requestedFileName) =>
    path.resolve(requestedFileName) === absoluteFileName ? sourceText : undefined;
  host.getSourceFile = (requestedFileName, languageVersion) =>
    path.resolve(requestedFileName) === absoluteFileName
      ? ts.createSourceFile(absoluteFileName, sourceText, languageVersion, true)
      : undefined;

  const program = ts.createProgram([absoluteFileName], options, host);
  const sourceFile = program.getSourceFile(absoluteFileName);
  if (!sourceFile) throw new Error(`could not parse ${fileName}`);
  return { sourceFile, checker: program.getTypeChecker() };
}

function countSymbolReferences(sourceFile, checker, declarationPosition) {
  let declarationIdentifier;
  const findDeclaration = (node) => {
    if (declarationIdentifier) return;
    if (ts.isIdentifier(node) && node.getStart(sourceFile) === declarationPosition) {
      declarationIdentifier = node;
      return;
    }
    ts.forEachChild(node, findDeclaration);
  };
  findDeclaration(sourceFile);
  if (!declarationIdentifier) return 0;

  const symbol = checker.getSymbolAtLocation(declarationIdentifier);
  if (!symbol) return 0;
  let count = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

export function findSingleUseAddedHelpers(
  sourceText,
  fileName,
  addedLineRanges,
  baseSourceText = "",
) {
  const { sourceFile, checker } = createSingleFileProgram(sourceText, fileName);
  const { sourceFile: baseSourceFile, checker: baseChecker } = createSingleFileProgram(
    baseSourceText,
    `${fileName}.base.ts`,
  );
  const helpers = collectHelperDeclarations(
    sourceFile,
    sourceText,
    addedLineRanges,
    collectHelperKeys(baseSourceFile, baseChecker),
    checker,
  );

  return helpers
    .filter(
      (helper) => countSymbolReferences(sourceFile, checker, helper.declarationPosition) === 2,
    )
    .map(({ declarationPosition: _declarationPosition, ...helper }) => helper);
}

function formatCountDelta(ruleName, current, base) {
  const delta = current - base;
  return `${ruleName} increased from ${base} to ${current} (+${delta})`;
}

function main() {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.log("agent-standards-lint: skipped because no git base ref was available.");
    return;
  }

  const changedFiles = listChangedFileEntries(baseRef);
  if (changedFiles.length === 0) return;

  const errors = [];
  let currentUnknown = 0;
  let baseUnknown = 0;
  let currentAny = 0;
  let baseAny = 0;

  for (const entry of changedFiles) {
    const currentSource = readCurrentFile(entry.path);
    const baseSource = readBaseFile(baseRef, entry.basePath);
    const currentCounts = countTypeEscapeHatches(currentSource, entry.path);
    const baseCounts = countTypeEscapeHatches(baseSource, entry.basePath ?? entry.path);
    currentUnknown += currentCounts.unknown;
    baseUnknown += baseCounts.unknown;
    currentAny += currentCounts.any;
    baseAny += baseCounts.any;

    if (!isRelevantSourceFile(entry.path)) continue;
    const diffText = tryGit(buildDiffArgsForEntry(baseRef, entry)) ?? "";
    const addedLineRanges = parseAddedLineRanges(diffText, entry.path, currentSource);
    for (const helper of findSingleUseAddedHelpers(
      currentSource,
      entry.path,
      addedLineRanges,
      baseSource,
    )) {
      errors.push(
        `${entry.path}:${helper.line}:${helper.column} prefer-inline-single-use-helper: "${helper.name}" is a newly added helper with one call site. Inline it. If it is a real semantic seam, keep it and add "agent-standards-ignore prefer-inline-single-use-helper: <reason>" immediately above it.`,
      );
    }
  }

  if (currentUnknown > baseUnknown) {
    errors.push(
      `no-new-unknown: ${formatCountDelta("explicit unknown type count", currentUnknown, baseUnknown)} across changed TypeScript implementation files. Do not introduce unknown in internal code; parse external/serialized inputs at the boundary into named DTO/domain types first. If you were about to add a generic isRecord guard, stop and fix the boundary model before continuing.`,
    );
  }

  if (currentAny > baseAny) {
    errors.push(
      `no-new-any: ${formatCountDelta("explicit any type count", currentAny, baseAny)} across changed TypeScript implementation files. Avoid any; use precise types or a tiny documented escape hatch with tests when TypeScript cannot express a generic constraint.`,
    );
  }

  if (errors.length > 0) {
    console.error("agent-standards-lint failed:\n");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModulePath) {
  main();
}
