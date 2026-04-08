import assert from "node:assert/strict";
import test from "node:test";
import {
  assessUrl,
  buildInstallInstructions,
  buildStorageStateFileName,
  isPlaywrightStorageState,
  safeRequestPageId,
  sanitizeLabel,
  sanitizeStorageStateName,
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

test("sanitizeStorageStateName keeps saved state names workspace-safe", () => {
  assert.equal(sanitizeStorageStateName(" GitHub Login .json "), "github-login");
  assert.equal(sanitizeStorageStateName("../../Prod Session"), "prod-session");
});

test("buildStorageStateFileName appends a normalized json filename", () => {
  assert.equal(buildStorageStateFileName("QA Session"), "qa-session.json");
});

test("sanitizeStorageStateName rejects empty names", () => {
  assert.throws(() => sanitizeStorageStateName("   "), /letter or number/);
});

test("isPlaywrightStorageState validates the expected top-level shape", () => {
  assert.equal(isPlaywrightStorageState({ cookies: [], origins: [] }), true);
  assert.equal(isPlaywrightStorageState({ cookies: [] }), false);
  assert.equal(isPlaywrightStorageState(null), false);
});

test("truncateText trims oversized content and marks truncation", () => {
  const input = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");
  const result = truncateText(input, 20, 3);
  assert.match(result, /truncated/);
  assert.doesNotMatch(result, /line-9/);
});
