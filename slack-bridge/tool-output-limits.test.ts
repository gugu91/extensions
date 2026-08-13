import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_LINES,
  formatOutputSize,
  measureHeadTruncation,
} from "./tool-output-limits.js";

describe("tool output limits", () => {
  it("keeps output at both limits inline", () => {
    expect(measureHeadTruncation("a\nb", { maxLines: 2, maxBytes: 3 })).toEqual({
      truncated: false,
      totalLines: 2,
      totalBytes: 3,
      outputLines: 2,
      outputBytes: 3,
    });
  });

  it("counts trailing newlines without creating a phantom line", () => {
    expect(measureHeadTruncation("one\ntwo\n", { maxLines: 2, maxBytes: 7 })).toEqual({
      truncated: true,
      totalLines: 2,
      totalBytes: 8,
      outputLines: 2,
      outputBytes: 7,
    });
  });

  it("truncates on complete UTF-8 lines and reports original byte totals", () => {
    expect(measureHeadTruncation("🙂\n🙂", { maxLines: 10, maxBytes: 5 })).toEqual({
      truncated: true,
      totalLines: 2,
      totalBytes: 9,
      outputLines: 1,
      outputBytes: 4,
    });
  });

  it("enforces the default line limit independently of bytes", () => {
    const content = Array.from({ length: DEFAULT_MAX_OUTPUT_LINES + 1 }, () => "x").join("\n");
    const result = measureHeadTruncation(content);

    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(DEFAULT_MAX_OUTPUT_LINES + 1);
    expect(result.outputLines).toBe(DEFAULT_MAX_OUTPUT_LINES);
  });

  it("formats byte sizes for spill notices", () => {
    expect(formatOutputSize(512)).toBe("512B");
    expect(formatOutputSize(1_536)).toBe("1.5KB");
    expect(formatOutputSize(2 * 1_024 * 1_024)).toBe("2.0MB");
  });
});
