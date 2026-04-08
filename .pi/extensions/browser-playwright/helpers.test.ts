import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assessUrl,
  buildInstallInstructions,
  normalizeStorageStatePath,
  resolveStorageStatePath,
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

test("normalizeStorageStatePath keeps storage state files under the guarded directory", () => {
  assert.equal(
    normalizeStorageStatePath("github-login.json"),
    `${STORAGE_STATE_RELATIVE_DIR}/github-login.json`,
  );
  assert.equal(
    normalizeStorageStatePath(`${STORAGE_STATE_RELATIVE_DIR}/nested/auth.json`),
    `${STORAGE_STATE_RELATIVE_DIR}/nested/auth.json`,
  );
});

test("normalizeStorageStatePath rejects absolute paths, traversal, and non-json files", () => {
  assert.throws(() => normalizeStorageStatePath("/tmp/auth.json"), /workspace-local/);
  assert.throws(() => normalizeStorageStatePath("../auth.json"), /traversal/i);
  assert.throws(() => normalizeStorageStatePath("auth.txt"), /\.json/);
});

test("resolveStorageStatePath prepares safe write targets under the guarded workspace directory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "browser-playwright-state-write-"));
  const resolved = await resolveStorageStatePath(workspaceRoot, "team/login.json", "write");

  assert.equal(resolved.relativePath, `${STORAGE_STATE_RELATIVE_DIR}/team/login.json`);
  assert.equal(
    resolved.absolutePath,
    resolve(await realpath(workspaceRoot), `${STORAGE_STATE_RELATIVE_DIR}/team/login.json`),
  );
});

test("resolveStorageStatePath reads workspace-local storage state files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "browser-playwright-state-read-"));
  const target = resolve(workspaceRoot, `${STORAGE_STATE_RELATIVE_DIR}/saved/login.json`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ cookies: [], origins: [] }), { encoding: "utf8" });

  const resolved = await resolveStorageStatePath(
    workspaceRoot,
    `${STORAGE_STATE_RELATIVE_DIR}/saved/login.json`,
    "read",
  );

  assert.equal(resolved.relativePath, `${STORAGE_STATE_RELATIVE_DIR}/saved/login.json`);
  assert.equal(resolved.absolutePath, await realpath(target));
});

test("resolveStorageStatePath rejects symlink escapes for reads and writes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "browser-playwright-state-symlink-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "browser-playwright-state-outside-"));
  const storageRoot = resolve(workspaceRoot, STORAGE_STATE_RELATIVE_DIR);
  const linkPath = resolve(storageRoot, "linked.json");
  const outsideFile = resolve(outsideRoot, "outside.json");

  await mkdir(dirname(linkPath), { recursive: true });
  await writeFile(outsideFile, JSON.stringify({ cookies: [], origins: [] }), { encoding: "utf8" });
  await symlink(outsideFile, linkPath);

  await assert.rejects(
    () => resolveStorageStatePath(workspaceRoot, "linked.json", "read"),
    /symlink|outside the guarded workspace directory/,
  );
  await assert.rejects(
    () => resolveStorageStatePath(workspaceRoot, "linked.json", "write"),
    /symlink|outside the guarded workspace directory/,
  );
});
