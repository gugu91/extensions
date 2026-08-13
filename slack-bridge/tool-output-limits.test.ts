import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_LINES,
  formatOutputSize,
  measureOutputLimits,
} from "./tool-output-limits.js";

describe("tool output limits", () => {
  it("keeps output at both limits inline", () => {
    expect(measureOutputLimits("a\nb", { maxLines: 2, maxBytes: 3 })).toEqual({
      exceedsLimit: false,
      totalLines: 2,
      totalBytes: 3,
    });
  });

  it("counts a trailing newline as bytes but not as another line", () => {
    expect(measureOutputLimits("one\ntwo\n", { maxLines: 2, maxBytes: 7 })).toEqual({
      exceedsLimit: true,
      totalLines: 2,
      totalBytes: 8,
    });
  });

  it("measures the UTF-8 bytes that determine whether output spills", () => {
    expect(measureOutputLimits("🙂\n🙂", { maxLines: 10, maxBytes: 5 })).toEqual({
      exceedsLimit: true,
      totalLines: 2,
      totalBytes: 9,
    });
  });

  it("enforces the default line limit independently of bytes", () => {
    const content = Array.from({ length: DEFAULT_MAX_OUTPUT_LINES + 1 }, () => "x").join("\n");

    expect(measureOutputLimits(content).exceedsLimit).toBe(true);
  });

  it("formats byte sizes for spill notices", () => {
    expect(formatOutputSize(512)).toBe("512B");
    expect(formatOutputSize(1_536)).toBe("1.5KB");
    expect(formatOutputSize(2 * 1_024 * 1_024)).toBe("2.0MB");
  });
});
