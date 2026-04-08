import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { loadStoredStorageState, resolveStorageStateFile } from "./storage-state.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("resolveStorageStateFile keeps saved state under the workspace-local browser-playwright state directory", async () => {
  const workspace = await makeTempDir("browser-storage-root-");
  await mkdir(path.join(workspace, ".pi", "state", "browser-playwright"), { recursive: true });

  const resolved = await resolveStorageStateFile(" GitHub Login ", { workspaceRoot: workspace });

  assert.equal(resolved.name, "github-login");
  assert.match(resolved.relativePath, /^\.pi[\\/]state[\\/]browser-playwright[\\/]github-login\.json$/);
  assert.match(
    resolved.absolutePath,
    new RegExp(`\\${path.sep}\\.pi\\${path.sep}state\\${path.sep}browser-playwright\\${path.sep}github-login\\.json$`),
  );
});

test("loadStoredStorageState reuses a trusted saved storageState file", async () => {
  const workspace = await makeTempDir("browser-storage-roundtrip-");
  const targetDir = path.join(workspace, ".pi", "state", "browser-playwright");
  const storageState = {
    cookies: [{ name: "sid", value: "secret" }],
    origins: [{ origin: "https://example.com", localStorage: [{ name: "theme", value: "dark" }] }],
  };
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "example-session.json"), `${JSON.stringify(storageState, null, 2)}\n`, "utf8");

  const loaded = await loadStoredStorageState("Example Session", { workspaceRoot: workspace });
  assert.deepEqual(loaded.summary, {
    name: "example-session",
    path: ".pi/state/browser-playwright/example-session.json",
    cookie_count: 1,
    origin_count: 1,
  });
  assert.deepEqual(loaded.storageState, storageState);
});

test("loadStoredStorageState rejects invalid JSON", async () => {
  const workspace = await makeTempDir("browser-storage-invalid-json-");
  const targetDir = path.join(workspace, ".pi", "state", "browser-playwright");
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "broken.json"), "not-json", "utf8");

  await assert.rejects(
    () => loadStoredStorageState("broken", { workspaceRoot: workspace }),
    /is not valid JSON/i,
  );
});

test("loadStoredStorageState rejects JSON that is not Playwright storageState-shaped", async () => {
  const workspace = await makeTempDir("browser-storage-invalid-shape-");
  const targetDir = path.join(workspace, ".pi", "state", "browser-playwright");
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "broken.json"), JSON.stringify({ cookies: [] }), "utf8");

  await assert.rejects(
    () => loadStoredStorageState("broken", { workspaceRoot: workspace }),
    /not a valid Playwright storageState JSON file/i,
  );
});

test("loadStoredStorageState rejects symlinked saved state files", async () => {
  const workspace = await makeTempDir("browser-storage-symlink-file-");
  const targetDir = path.join(workspace, ".pi", "state", "browser-playwright");
  const outside = await makeTempDir("browser-storage-outside-file-");
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(outside, "secret.json"), JSON.stringify({ cookies: [], origins: [] }), "utf8");
  await symlink(path.join(outside, "secret.json"), path.join(targetDir, "linked.json"));

  await assert.rejects(
    () => loadStoredStorageState("linked", { workspaceRoot: workspace }),
    /must not use symlinks/i,
  );
});

test("loadStoredStorageState rejects a symlink swap just before open", async () => {
  const workspace = await makeTempDir("browser-storage-swap-");
  const targetDir = path.join(workspace, ".pi", "state", "browser-playwright");
  const outside = await makeTempDir("browser-storage-swap-outside-");
  const targetFile = path.join(targetDir, "swap.json");
  const outsideFile = path.join(outside, "secret.json");
  await mkdir(targetDir, { recursive: true });
  await writeFile(targetFile, JSON.stringify({ cookies: [], origins: [] }), "utf8");
  await writeFile(outsideFile, JSON.stringify({ cookies: [], origins: [] }), "utf8");

  await assert.rejects(
    () =>
      loadStoredStorageState("swap", { workspaceRoot: workspace }, {
        openImpl: async (filePath, flags) => {
          await rm(filePath, { force: true });
          await symlink(outsideFile, filePath);
          return open(filePath, flags);
        },
      }),
    /must not use symlinks/i,
  );
});

test("loadStoredStorageState rejects storage roots that escape the workspace via symlink", async () => {
  const workspace = await makeTempDir("browser-storage-root-symlink-");
  const outside = await makeTempDir("browser-storage-root-outside-");
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await mkdir(path.join(outside, "browser-playwright"), { recursive: true });
  await symlink(outside, path.join(workspace, ".pi", "state"));

  await assert.rejects(
    () => loadStoredStorageState("Example Session", { workspaceRoot: workspace }),
    /must stay inside the workspace/i,
  );
});
