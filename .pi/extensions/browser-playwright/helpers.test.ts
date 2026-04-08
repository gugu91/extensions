import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessUrl,
  buildDefaultStorageStatePath,
  buildInstallInstructions,
  resolveStorageStateExportPath,
  resolveStorageStateImportPath,
  safeRequestPageId,
  sanitizeLabel,
  STORAGE_STATE_RELATIVE_DIR,
  truncateText,
  type SecurityOptions,
} from "./helpers.ts";

const lockedDown: SecurityOptions = {
  allowLocalhost: false,
  allowPrivateNetwork: false,
};

async function withTempWorkspace<T>(run: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "browser-playwright-helpers-"));
  try {
    return await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("assessUrl allows public https URLs", () => {
  assert.deepEqual(assessUrl("https://example.com", lockedDown), { allowed: true });
});

test("assessUrl blocks localhost by default", () => {
  const result = assessUrl("http://localhost:3000", lockedDown);
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.match(result.reason, /Blocked localhost URL/);
    assert.match(result.hint ?? "", /BROWSER_ALLOW_LOCALHOST=true/);
  }
});

test("assessUrl allows localhost with explicit opt-in", () => {
  assert.deepEqual(assessUrl("http://localhost:3000", { ...lockedDown, allowLocalhost: true }), {
    allowed: true,
  });
});

test("assessUrl blocks private-network IPs by default", () => {
  const result = assessUrl("http://192.168.1.10/dashboard", lockedDown);
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.match(result.reason, /Blocked private-network URL/);
    assert.match(result.hint ?? "", /BROWSER_ALLOW_PRIVATE_NETWORK=true/);
  }
});

test("assessUrl allows private-network IPs with explicit opt-in", () => {
  assert.deepEqual(
    assessUrl("http://192.168.1.10/dashboard", {
      ...lockedDown,
      allowPrivateNetwork: true,
    }),
    { allowed: true },
  );
});

test("assessUrl blocks obvious internal hostnames by default", () => {
  const result = assessUrl("http://host.docker.internal:3000", lockedDown);
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.match(result.reason, /Blocked internal hostname/);
  }
});

test("buildInstallInstructions includes npm install only when requested", () => {
  const full = buildInstallInstructions("missing", true);
  assert.match(full, /npm install/);
  assert.match(full, /npx playwright install chromium/);

  const browserOnly = buildInstallInstructions("missing", false);
  assert.doesNotMatch(browserOnly, /npm install/);
  assert.match(browserOnly, /npx playwright install chromium/);
});

test("buildInstallInstructions is browser-engine aware", () => {
  const firefox = buildInstallInstructions("missing firefox", false, "firefox");
  assert.match(firefox, /firefox browser binaries/);
  assert.match(firefox, /npx playwright install firefox/);
});

test("safeRequestPageId resolves page IDs for frame-backed requests", () => {
  const page = { id: "page-object" };
  const result = safeRequestPageId(
    {
      frame() {
        return {
          page() {
            return page;
          },
        };
      },
    },
    (currentPage) => (currentPage === page ? "page-1" : null),
  );

  assert.equal(result, "page-1");
});

test("safeRequestPageId returns null for service-worker-style requests without a page", () => {
  const result = safeRequestPageId(
    {
      frame() {
        throw new Error("Service Worker requests do not have an associated frame");
      },
    },
    () => "page-1",
  );

  assert.equal(result, null);
});

test("sanitizeLabel keeps filenames safe and stable", () => {
  assert.equal(sanitizeLabel("Search Results / Docs"), "search-results-docs");
  assert.equal(sanitizeLabel("   "), "screenshot");
});

test("truncateText trims oversized content and marks truncation", () => {
  const input = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");
  const result = truncateText(input, 20, 3);
  assert.match(result, /truncated/);
  assert.doesNotMatch(result, /line-9/);
});

test("resolveStorageStateImportPath accepts a workspace-local JSON file", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const relativePath = ".pi/state/auth.json";
    const absolutePath = path.join(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, JSON.stringify({ cookies: [], origins: [] }), "utf8");

    const resolved = await resolveStorageStateImportPath(workspaceRoot, relativePath);
    assert.equal(resolved.relativePath, relativePath);
    assert.equal(resolved.absolutePath, absolutePath);
  });
});

test("resolveStorageStateImportPath rejects absolute paths and traversal", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(
      resolveStorageStateImportPath(workspaceRoot, path.join(workspaceRoot, "auth.json")),
      /workspace-relative/,
    );
    await assert.rejects(
      resolveStorageStateImportPath(workspaceRoot, "../auth.json"),
      /traversal segments/,
    );
  });
});

test("resolveStorageStateImportPath rejects invalid JSON content", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const relativePath = ".pi/state/auth.json";
    const absolutePath = path.join(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "[]", "utf8");

    await assert.rejects(
      resolveStorageStateImportPath(workspaceRoot, relativePath),
      /valid JSON object data/,
    );
  });
});

test("resolveStorageStateImportPath rejects symlink escapes", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink test is not reliable on Windows runners");
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "browser-playwright-outside-"));
    try {
      const outsideFile = path.join(outsideRoot, "auth.json");
      await fs.writeFile(outsideFile, JSON.stringify({ cookies: [], origins: [] }), "utf8");
      const symlinkDir = path.join(workspaceRoot, ".pi", "linked-state");
      await fs.mkdir(path.dirname(symlinkDir), { recursive: true });
      await fs.symlink(outsideRoot, symlinkDir);

      await assert.rejects(
        resolveStorageStateImportPath(workspaceRoot, ".pi/linked-state/auth.json"),
        /symlinks/,
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("buildDefaultStorageStatePath keeps exports under the storage-state artifact directory", () => {
  const built = buildDefaultStorageStatePath("browser_test", new Date("2026-04-08T12:34:56.789Z"));
  assert.match(built, new RegExp(`^${STORAGE_STATE_RELATIVE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
  assert.match(built, /browser_test-storage-state\.json$/);
});

test("resolveStorageStateExportPath defaults to a workspace-local artifact path", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const resolved = await resolveStorageStateExportPath(
      workspaceRoot,
      undefined,
      "browser_test",
      new Date("2026-04-08T12:34:56.789Z"),
    );

    assert.equal(
      resolved.relativePath,
      `${STORAGE_STATE_RELATIVE_DIR}/2026-04-08T12-34-56-789Z-browser_test-storage-state.json`,
    );
    assert.equal(
      resolved.absolutePath,
      path.join(
        workspaceRoot,
        STORAGE_STATE_RELATIVE_DIR,
        "2026-04-08T12-34-56-789Z-browser_test-storage-state.json",
      ),
    );
  });
});

test("resolveStorageStateExportPath rejects symlink parents and traversal", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink test is not reliable on Windows runners");
    return;
  }

  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(
      resolveStorageStateExportPath(workspaceRoot, "../auth.json", "browser_test"),
      /traversal segments/,
    );

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "browser-playwright-export-outside-"));
    try {
      const symlinkDir = path.join(workspaceRoot, ".pi", "export-link");
      await fs.mkdir(path.dirname(symlinkDir), { recursive: true });
      await fs.symlink(outsideRoot, symlinkDir);

      await assert.rejects(
        resolveStorageStateExportPath(workspaceRoot, ".pi/export-link/auth.json", "browser_test"),
        /symlinks/,
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
