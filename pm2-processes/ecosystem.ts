import * as fs from "node:fs";
import { extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

export interface AppMetadata {
  url?: string;
  readinessUrl?: string;
  description?: string;
}

export interface DeclaredPm2App {
  name: string;
  metadata?: AppMetadata;
}

interface LoadedEcosystem {
  apps?: unknown;
}

type Quote = "'" | '"' | "`";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapDefault(value: unknown): unknown {
  if (isRecord(value) && "default" in value) return value.default;
  return value;
}

async function readJsonEcosystem(configPath: string): Promise<unknown> {
  return JSON.parse(await readFile(configPath, "utf8")) as unknown;
}

function extractJsonAppArray(raw: unknown): unknown[] {
  const value = unwrapDefault(raw);
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const ecosystem = value as LoadedEcosystem;
    if (Array.isArray(ecosystem.apps)) return ecosystem.apps;
  }
  throw new Error("PM2 ecosystem config must declare an apps array or { apps: [...] }");
}

function validateAppName(name: unknown, index: number): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`PM2 app at index ${index} must declare a non-empty string name`);
  }
  const trimmed = name.trim();
  if (trimmed === "all" || trimmed.includes("*")) {
    throw new Error(`PM2 app name '${trimmed}' is not allowed; use exact non-wildcard names`);
  }
  return trimmed;
}

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$-]/.test(char);
}

function isBoundary(source: string, index: number): boolean {
  return !isIdentifierPart(source[index]);
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function skipLineComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, index: number): number {
  const end = source.indexOf("*/", index + 2);
  return end === -1 ? source.length : end + 2;
}

function readQuotedString(source: string, start: number): { value: string; end: number } {
  const quote = source[start] as Quote;
  let cursor = start + 1;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === quote) return { value, end: cursor + 1 };
    if (char === "\\") {
      const next = source[cursor + 1];
      if (next === undefined) break;
      if (next === "n") value += "\n";
      else if (next === "r") value += "\r";
      else if (next === "t") value += "\t";
      else if (next === "b") value += "\b";
      else if (next === "f") value += "\f";
      else if (next === "v") value += "\v";
      else if (next === "0") value += "\0";
      else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(source.slice(cursor + 2, cursor + 4))) {
        value += String.fromCharCode(Number.parseInt(source.slice(cursor + 2, cursor + 4), 16));
        cursor += 2;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(cursor + 2, cursor + 6))) {
        value += String.fromCharCode(Number.parseInt(source.slice(cursor + 2, cursor + 6), 16));
        cursor += 4;
      } else {
        value += next;
      }
      cursor += 2;
      continue;
    }
    if (quote === "`" && char === "$" && source[cursor + 1] === "{") {
      throw new Error("dynamic template expressions are not supported for PM2 app names");
    }
    value += char;
    cursor += 1;
  }
  throw new Error("unterminated string literal while reading PM2 ecosystem config");
}

function skipQuotedString(source: string, start: number): number {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }
  throw new Error("unterminated string literal while reading PM2 ecosystem config");
}

function findAppsArraySource(source: string): string {
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === "/" && next === "/") {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuotedString(source, cursor);
      continue;
    }
    if (
      source.startsWith("apps", cursor) &&
      isBoundary(source, cursor - 1) &&
      isBoundary(source, cursor + "apps".length)
    ) {
      let afterName = skipWhitespace(source, cursor + "apps".length);
      if (source[afterName] === ":" || source[afterName] === "=") {
        afterName = skipWhitespace(source, afterName + 1);
        if (source[afterName] === "[") return scanArraySource(source, afterName);
      }
    }
    cursor += 1;
  }
  throw new Error(
    "PM2 ecosystem config apps array could not be discovered without executing JavaScript; use a static apps: [...] declaration or JSON config",
  );
}

function scanArraySource(source: string, start: number): string {
  let cursor = start;
  let depth = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === "/" && next === "/") {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuotedString(source, cursor);
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, cursor);
    }
    cursor += 1;
  }
  throw new Error("unterminated apps array in PM2 ecosystem config");
}

function splitTopLevelObjectSources(arraySource: string): string[] {
  const objects: string[] = [];
  let cursor = 0;
  let objectStart: number | undefined;
  let depth = 0;

  while (cursor < arraySource.length) {
    const char = arraySource[cursor];
    const next = arraySource[cursor + 1];
    if (char === "/" && next === "/") {
      cursor = skipLineComment(arraySource, cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(arraySource, cursor);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuotedString(arraySource, cursor);
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = cursor;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== undefined) {
        objects.push(arraySource.slice(objectStart, cursor + 1));
        objectStart = undefined;
      }
      if (depth < 0) throw new Error("unbalanced object literal in PM2 apps array");
    }
    cursor += 1;
  }

  if (depth !== 0) throw new Error("unterminated object literal in PM2 apps array");
  if (objects.length === 0) throw new Error("PM2 apps array must contain object literals");
  return objects;
}

function readIdentifier(source: string, start: number): { value: string; end: number } | null {
  if (!isIdentifierStart(source[start])) return null;
  let cursor = start + 1;
  while (isIdentifierPart(source[cursor])) cursor += 1;
  return { value: source.slice(start, cursor), end: cursor };
}

function skipValue(source: string, start: number): number {
  let cursor = start;
  let depth = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === "/" && next === "/") {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (char === "/" && next === "*") {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      cursor = skipQuotedString(source, cursor);
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      if (depth === 0) return cursor;
      depth -= 1;
    } else if (char === "," && depth === 0) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function extractTopLevelName(objectSource: string, index: number): string {
  let cursor = 1;
  const end = objectSource.length - 1;
  while (cursor < end) {
    cursor = skipWhitespace(objectSource, cursor);
    if (objectSource[cursor] === ",") {
      cursor += 1;
      continue;
    }

    let key: { value: string; end: number } | null = null;
    const char = objectSource[cursor];
    if (char === "'" || char === '"' || char === "`") {
      key = readQuotedString(objectSource, cursor);
    } else {
      key = readIdentifier(objectSource, cursor);
    }
    if (!key) {
      cursor += 1;
      continue;
    }

    const colon = skipWhitespace(objectSource, key.end);
    if (objectSource[colon] !== ":") {
      cursor = skipValue(objectSource, key.end);
      continue;
    }
    const valueStart = skipWhitespace(objectSource, colon + 1);
    if (key.value === "name") {
      const quote = objectSource[valueStart];
      if (quote !== "'" && quote !== '"' && quote !== "`") {
        throw new Error(`PM2 app at index ${index} must declare a static string name`);
      }
      return validateAppName(readQuotedString(objectSource, valueStart).value, index);
    }
    cursor = skipValue(objectSource, valueStart);
  }
  throw new Error(`PM2 app at index ${index} must declare a non-empty string name`);
}

function extractStaticJsAppNames(source: string): string[] {
  const arraySource = findAppsArraySource(source);
  return splitTopLevelObjectSources(arraySource).map((objectSource, index) =>
    extractTopLevelName(objectSource, index),
  );
}

function parseMetadata(metadataPath: string | undefined): Record<string, AppMetadata> {
  if (!metadataPath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    const apps = isRecord(parsed.apps) ? parsed.apps : parsed;
    const result: Record<string, AppMetadata> = {};
    for (const [name, raw] of Object.entries(apps)) {
      if (!isRecord(raw)) continue;
      const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : undefined;
      const readinessUrl =
        typeof raw.readinessUrl === "string" && raw.readinessUrl.trim()
          ? raw.readinessUrl.trim()
          : typeof raw.healthUrl === "string" && raw.healthUrl.trim()
            ? raw.healthUrl.trim()
            : undefined;
      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : undefined;
      result[name] = { url, readinessUrl, description };
    }
    return result;
  } catch {
    return {};
  }
}

async function loadAppNames(configPath: string): Promise<string[]> {
  const absolutePath = resolve(configPath);
  const extension = extname(absolutePath).toLowerCase();
  if (extension === ".json") {
    return extractJsonAppArray(await readJsonEcosystem(absolutePath)).map((rawApp, index) => {
      if (!isRecord(rawApp)) {
        throw new Error(`PM2 app at index ${index} must be an object`);
      }
      return validateAppName(rawApp.name, index);
    });
  }

  if (![".js", ".cjs", ".mjs"].includes(extension)) {
    throw new Error(`Unsupported PM2 ecosystem config extension '${extension || "none"}'`);
  }
  return extractStaticJsAppNames(await readFile(absolutePath, "utf8"));
}

export async function loadDeclaredApps(
  configPath: string,
  metadataPath?: string,
): Promise<DeclaredPm2App[]> {
  const appNames = await loadAppNames(configPath);
  const metadata = parseMetadata(metadataPath);
  const seen = new Set<string>();
  const apps: DeclaredPm2App[] = [];

  appNames.forEach((name) => {
    if (seen.has(name)) throw new Error(`Duplicate PM2 app name in ecosystem config: ${name}`);
    seen.add(name);
    apps.push({ name, metadata: metadata[name] });
  });

  if (apps.length === 0) throw new Error("PM2 ecosystem config declares no apps");
  return apps;
}

export function getAllowedAppNames(apps: DeclaredPm2App[]): string[] {
  return apps.map((app) => app.name);
}
