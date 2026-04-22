import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  buildStorageStateFileName,
  isPlaywrightStorageState,
  STORAGE_STATE_RELATIVE_DIR,
  type PlaywrightStorageStateLike,
} from "./helpers.ts";

export interface ResolvedStorageStateFile {
  name: string;
  absolutePath: string;
  relativePath: string;
}

export interface StorageStateSummary {
  name: string;
  path: string;
  cookie_count: number;
  origin_count: number;
}

export interface StorageStatePaths {
  workspaceRoot: string;
}

interface StorageStateFs {
  openImpl?: typeof open;
  realpathImpl?: typeof realpath;
}

function isPathInsideDirectory(pathToCheck: string, directoryPath: string): boolean {
  const rel = relative(directoryPath, pathToCheck);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function storageStateRootPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, STORAGE_STATE_RELATIVE_DIR);
}

async function resolveWorkspaceRoots(
  workspaceRoot: string,
  fsDeps: StorageStateFs = {},
): Promise<{ workspaceRootReal: string; storageStateRootReal: string }> {
  const { realpathImpl = realpath } = fsDeps;
  const storageStateRoot = storageStateRootPath(workspaceRoot);

  const [workspaceRootReal, storageStateRootReal] = await Promise.all([
    realpathImpl(workspaceRoot),
    realpathImpl(storageStateRoot),
  ]);

  if (!isPathInsideDirectory(storageStateRootReal, workspaceRootReal)) {
    throw new Error(
      `Stored browser state directory must stay inside the workspace: \`${STORAGE_STATE_RELATIVE_DIR}\`.`,
    );
  }

  return { workspaceRootReal, storageStateRootReal };
}

function summarizeStorageState(storageState: PlaywrightStorageStateLike): {
  cookie_count: number;
  origin_count: number;
} {
  return {
    cookie_count: storageState.cookies.length,
    origin_count: storageState.origins.length,
  };
}

export async function resolveStorageStateFile(
  name: string,
  paths: StorageStatePaths,
  fsDeps: StorageStateFs = {},
): Promise<ResolvedStorageStateFile> {
  const { workspaceRootReal, storageStateRootReal } = await resolveWorkspaceRoots(
    paths.workspaceRoot,
    fsDeps,
  );
  const fileName = buildStorageStateFileName(name);
  const absolutePath = resolve(storageStateRootReal, fileName);

  return {
    name: fileName.replace(/\.json$/i, ""),
    absolutePath,
    relativePath: relative(workspaceRootReal, absolutePath),
  };
}

export async function loadStoredStorageState(
  name: string,
  paths: StorageStatePaths,
  fsDeps: StorageStateFs = {},
): Promise<{ storageState: PlaywrightStorageStateLike; summary: StorageStateSummary }> {
  let resolvedState: ResolvedStorageStateFile;
  try {
    resolvedState = await resolveStorageStateFile(name, paths, fsDeps);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const fileName = buildStorageStateFileName(name).replace(/\.json$/i, "");
    if (code === "ENOENT") {
      throw new Error(
        `Stored browser state \`${fileName}\` was not found in \`${STORAGE_STATE_RELATIVE_DIR}\`. Place a trusted Playwright storageState JSON file there first.`,
      );
    }
    throw error;
  }

  const { openImpl = open } = fsDeps;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await openImpl(resolvedState.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(
        `Stored browser state must be a regular file: \`${resolvedState.relativePath}\`.`,
      );
    }

    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (!isPlaywrightStorageState(parsed)) {
      throw new Error(
        `Stored browser state \`${resolvedState.name}\` is not a valid Playwright storageState JSON file.`,
      );
    }

    return {
      storageState: parsed,
      summary: {
        name: resolvedState.name,
        path: resolvedState.relativePath,
        ...summarizeStorageState(parsed),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `Stored browser state \`${resolvedState.name}\` was not found at \`${resolvedState.relativePath}\`. Place a trusted Playwright storageState JSON file there first.`,
      );
    }
    if (code === "ELOOP") {
      throw new Error(
        `Stored browser state paths must not use symlinks: \`${resolvedState.relativePath}\`.`,
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Stored browser state \`${resolvedState.name}\` is not valid JSON.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
