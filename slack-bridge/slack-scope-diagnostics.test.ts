import { describe, expect, it, vi } from "vitest";
import {
  buildSlackScopeDriftWarning,
  createPendingSlackScopeDiagnostics,
  createUncheckedSlackScopeDiagnostics,
  detectSlackScopeDiagnostics,
  formatSlackScopeDiagnosticsStatus,
} from "./slack-scope-diagnostics.js";

function slackJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("slack scope diagnostics", () => {
  it("starts unchecked or pending before a live probe runs", () => {
    expect(createUncheckedSlackScopeDiagnostics()).toMatchObject({
      status: "not_checked",
      summary: "not checked",
    });
    expect(createPendingSlackScopeDiagnostics()).toMatchObject({
      status: "pending",
      summary: "pending",
    });
  });

  it("reports drift when Slack returns missing_scope for file/bookmark/pin probes", async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/files.info")) {
        return slackJson({ ok: false, error: "missing_scope", needed: "files:read" });
      }
      if (url.endsWith("/files.completeUploadExternal")) {
        return slackJson({ ok: false, error: "missing_scope", needed: "files:write" });
      }
      if (url.endsWith("/bookmarks.list")) {
        return slackJson({ ok: false, error: "missing_scope", needed: "bookmarks:read" });
      }
      if (url.endsWith("/bookmarks.remove")) {
        return slackJson({ ok: false, error: "missing_scope", needed: "bookmarks:write" });
      }
      if (url.endsWith("/pins.list")) {
        return slackJson({ ok: false, error: "missing_scope", needed: "pins:read" });
      }
      if (url.endsWith("/pins.add")) {
        return slackJson({ ok: false, error: "missing_scope", needed: "pins:write" });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const diagnostics = await detectSlackScopeDiagnostics({
      token: "xoxb-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => "2026-04-14T00:00:00.000Z",
    });

    expect(diagnostics).toMatchObject({
      status: "drift",
      checkedAt: "2026-04-14T00:00:00.000Z",
      missingScopes: [
        "bookmarks:read",
        "bookmarks:write",
        "files:read",
        "files:write",
        "pins:read",
        "pins:write",
      ],
      surfaces: ["bookmarks", "files", "pins"],
    });
    expect(formatSlackScopeDiagnosticsStatus(diagnostics)).toBe(
      "scope drift — missing bookmarks:read, bookmarks:write, files:read, files:write, pins:read, pins:write",
    );
    expect(buildSlackScopeDriftWarning(diagnostics)).toContain(
      "Affected Slack surfaces: bookmarks, files, pins.",
    );
  });

  it("treats benign not-found style probe errors as healthy", async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/files.info")) {
        return slackJson({ ok: false, error: "file_not_found" });
      }
      if (url.endsWith("/files.completeUploadExternal")) {
        return slackJson({ ok: false, error: "file_not_found" });
      }
      if (url.endsWith("/bookmarks.list")) {
        return slackJson({ ok: false, error: "channel_not_found" });
      }
      if (url.endsWith("/bookmarks.remove")) {
        return slackJson({ ok: false, error: "not_found" });
      }
      if (url.endsWith("/pins.list")) {
        return slackJson({ ok: false, error: "channel_not_found" });
      }
      if (url.endsWith("/pins.add")) {
        return slackJson({ ok: false, error: "channel_not_found" });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const diagnostics = await detectSlackScopeDiagnostics({
      token: "xoxb-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(diagnostics.status).toBe("healthy");
    expect(diagnostics.summary).toBe("healthy");
    expect(buildSlackScopeDriftWarning(diagnostics)).toBeNull();
  });

  it("surfaces unavailable diagnostics when probes fail for non-scope reasons", async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/files.info")) {
        return slackJson({ ok: false, error: "invalid_auth" });
      }
      return slackJson({ ok: true });
    });

    const diagnostics = await detectSlackScopeDiagnostics({
      token: "xoxb-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(diagnostics.status).toBe("unavailable");
    expect(diagnostics.summary).toContain("files.info: invalid_auth");
  });
});
