import * as fs from "node:fs";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapDefault(value: unknown): unknown {
  if (isRecord(value) && "default" in value) return value.default;
  return value;
}

async function importEcosystem(configPath: string): Promise<unknown> {
  const absolutePath = resolve(configPath);
  const extension = extname(absolutePath).toLowerCase();
  if (extension === ".json") {
    return JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  }

  const require = createRequire(import.meta.url);
  try {
    const resolved = require.resolve(absolutePath);
    delete require.cache[resolved];
    return require(resolved) as unknown;
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code !== "ERR_REQUIRE_ESM") throw error;
    const stats = await stat(absolutePath);
    return import(`${pathToFileURL(absolutePath).href}?mtime=${stats.mtimeMs}`) as Promise<unknown>;
  }
}

function extractAppArray(raw: unknown): unknown[] {
  const value = unwrapDefault(raw);
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const ecosystem = value as LoadedEcosystem;
    if (Array.isArray(ecosystem.apps)) return ecosystem.apps;
  }
  throw new Error("PM2 ecosystem config must export an apps array or { apps: [...] }");
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

export async function loadDeclaredApps(
  configPath: string,
  metadataPath?: string,
): Promise<DeclaredPm2App[]> {
  const raw = await importEcosystem(configPath);
  const appArray = extractAppArray(raw);
  const metadata = parseMetadata(metadataPath);
  const seen = new Set<string>();
  const apps: DeclaredPm2App[] = [];

  appArray.forEach((rawApp, index) => {
    if (!isRecord(rawApp)) {
      throw new Error(`PM2 app at index ${index} must be an object`);
    }
    const name = validateAppName(rawApp.name, index);
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
