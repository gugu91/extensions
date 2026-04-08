import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STORAGE_STATE_RELATIVE_DIR } from "./helpers.ts";
import { __testables } from "./index.ts";

const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));
const WORKSPACE_ROOT = resolve(EXTENSION_DIR, "../../..");
const STORAGE_STATE_ROOT = resolve(WORKSPACE_ROOT, STORAGE_STATE_RELATIVE_DIR);

async function removeStateFile(fileName: string): Promise<void> {
  await rm(resolve(STORAGE_STATE_ROOT, fileName), { force: true });
}

test("saveStoredStorageState writes workspace-local storageState JSON and returns metadata", async () => {
  const fileName = "github-login.json";
  await mkdir(STORAGE_STATE_ROOT, { recursive: true });
  await removeStateFile(fileName);

  try {
    const session = {
      context: {
        storageState: async () => ({
          cookies: [
            {
              name: "sid",
              value: "secret-cookie",
              domain: "example.com",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [
            {
              origin: "https://example.com",
              localStorage: [{ name: "token", value: "secret-token" }],
            },
          ],
        }),
      },
    } as unknown as Parameters<(typeof __testables)["saveStoredStorageState"]>[0];

    const saved = await __testables.saveStoredStorageState(session, "GitHub Login");
    assert.equal(saved.name, "github-login");
    assert.equal(saved.path, `${STORAGE_STATE_RELATIVE_DIR}/github-login.json`);
    assert.equal(saved.cookie_count, 1);
    assert.equal(saved.origin_count, 1);

    const stored = JSON.parse(await readFile(resolve(STORAGE_STATE_ROOT, fileName), "utf8")) as {
      cookies: Array<{ name: string }>;
      origins: Array<{ origin: string }>;
    };
    assert.equal(stored.cookies[0]?.name, "sid");
    assert.equal(stored.origins[0]?.origin, "https://example.com");
  } finally {
    await removeStateFile(fileName);
  }
});

test("loadStoredStorageState reads a previously saved state by name", async () => {
  const fileName = "roundtrip-state.json";
  await mkdir(STORAGE_STATE_ROOT, { recursive: true });
  await removeStateFile(fileName);

  try {
    await writeFile(
      resolve(STORAGE_STATE_ROOT, fileName),
      `${JSON.stringify(
        {
          cookies: [
            {
              name: "sid",
              value: "secret-cookie",
              domain: "example.com",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [
            {
              origin: "https://example.com",
              localStorage: [{ name: "token", value: "secret-token" }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const loaded = await __testables.loadStoredStorageState("roundtrip state");
    assert.equal(loaded.mountedStorageState.name, "roundtrip-state");
    assert.equal(
      loaded.mountedStorageState.path,
      `${STORAGE_STATE_RELATIVE_DIR}/roundtrip-state.json`,
    );
    assert.equal(loaded.mountedStorageState.cookie_count, 1);
    assert.equal(loaded.mountedStorageState.origin_count, 1);
    assert.equal(loaded.storageState.cookies.length, 1);
    assert.equal(loaded.storageState.origins.length, 1);
  } finally {
    await removeStateFile(fileName);
  }
});

test("loadStoredStorageState rejects symlinked state files", async () => {
  const sourceFileName = "symlink-source.json";
  const symlinkFileName = "symlinked.json";
  await mkdir(STORAGE_STATE_ROOT, { recursive: true });
  await removeStateFile(sourceFileName);
  await removeStateFile(symlinkFileName);

  try {
    await writeFile(
      resolve(STORAGE_STATE_ROOT, sourceFileName),
      `${JSON.stringify({ cookies: [], origins: [] }, null, 2)}\n`,
      "utf8",
    );
    await symlink(sourceFileName, resolve(STORAGE_STATE_ROOT, symlinkFileName));

    await assert.rejects(__testables.loadStoredStorageState("symlinked"), /must not use symlinks/);
  } finally {
    await removeStateFile(symlinkFileName);
    await removeStateFile(sourceFileName);
  }
});
