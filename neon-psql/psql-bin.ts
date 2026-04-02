import * as fs from "node:fs";
import { delimiter, join } from "node:path";

export const DEFAULT_PSQL_FALLBACK_PATHS = [
  "/opt/homebrew/opt/libpq/bin/psql",
  "/usr/local/opt/libpq/bin/psql",
  "/usr/bin/psql",
] as const;

export interface ResolvePsqlBinOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (candidatePath: string) => boolean;
  fallbackPaths?: readonly string[];
}

function isExecutableFile(candidatePath: string): boolean {
  try {
    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeConfiguredPath(configuredPath?: string): string | undefined {
  const trimmed = configuredPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function findExecutableOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (candidatePath: string) => boolean = isExecutableFile,
): string | null {
  const pathValue = env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;

    const candidatePath = join(dir, binaryName);
    if (isExecutable(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

export function resolvePsqlBin(options: ResolvePsqlBinOptions = {}): string {
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const configuredPath = normalizeConfiguredPath(options.configuredPath);

  if (configuredPath) {
    if (isExecutable(configuredPath)) {
      return configuredPath;
    }

    throw new Error(`Configured psql binary is not executable: ${configuredPath}`);
  }

  const pathMatch = findExecutableOnPath("psql", options.env, isExecutable);
  if (pathMatch) {
    return pathMatch;
  }

  const fallbackPaths = options.fallbackPaths ?? DEFAULT_PSQL_FALLBACK_PATHS;
  for (const candidatePath of fallbackPaths) {
    if (isExecutable(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(
    `Unable to find a psql binary. Checked PATH and fallback paths: ${fallbackPaths.join(", ")}. Configure neon-psql.psqlBin if psql is installed elsewhere.`,
  );
}
