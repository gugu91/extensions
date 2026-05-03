import { describe, expect, it } from "vitest";

import { normalizeLines, normalizeTarget, redactSensitiveText, truncateTail } from "./helpers.js";

const apps = [{ name: "api" }, { name: "web" }];

describe("pm2 helpers", () => {
  it("expands all to exact declared app names", () => {
    expect(normalizeTarget("all", apps, { defaultAll: true, allowAll: true })).toEqual({
      targetLabel: "all",
      names: ["api", "web"],
    });
  });

  it("rejects undeclared app names", () => {
    expect(() => normalizeTarget("db", apps, { defaultAll: false, allowAll: false })).toThrow(
      "Unknown PM2 app 'db'",
    );
  });

  it("requires explicit target when defaultAll is false", () => {
    expect(() => normalizeTarget(undefined, apps, { defaultAll: false, allowAll: false })).toThrow(
      "target app name is required",
    );
  });

  it("clamps requested log lines", () => {
    expect(normalizeLines(undefined, 80, 300)).toBe(80);
    expect(normalizeLines(0, 80, 300)).toBe(1);
    expect(normalizeLines(999, 80, 300)).toBe(300);
  });

  it("truncates tail by lines", () => {
    const result = truncateTail("one\ntwo\nthree", 1_000, 2);
    expect(result).toEqual({ text: "two\nthree", truncated: true });
  });

  it("redacts secret-looking output", () => {
    expect(
      redactSensitiveText(
        "TOKEN=abc123 password: hunter2 Authorization: Bearer secret https://x.test?a=1&token=leak",
      ),
    ).toBe(
      "TOKEN=[REDACTED] password: [REDACTED] Authorization: Bearer [REDACTED] https://x.test?a=1&token=[REDACTED]",
    );
  });
});
