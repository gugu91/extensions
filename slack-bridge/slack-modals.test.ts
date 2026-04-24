import { describe, expect, it } from "vitest";
import {
  decodeSlackModalPrivateMetadata,
  encodeSlackModalPrivateMetadata,
  normalizeSlackModalViewInput,
} from "./slack-modals.js";

describe("normalizeSlackModalViewInput", () => {
  it("requires a modal view object", () => {
    expect(() => normalizeSlackModalViewInput({ type: "home" })).toThrow(
      'Slack modal view.type must be "modal".',
    );
  });
});

describe("modal private metadata helpers", () => {
  it("embeds and restores thread context alongside custom metadata", () => {
    const encoded = encodeSlackModalPrivateMetadata(JSON.stringify({ workflow: "deploy" }), {
      threadTs: "123.456",
      channel: "C123",
    });
    const decoded = decodeSlackModalPrivateMetadata(encoded);

    expect(decoded.threadContext).toEqual({ threadTs: "123.456", channel: "C123" });
    expect(decoded.value).toEqual({ workflow: "deploy" });
  });

  it("preserves plain-string metadata when encoding thread context", () => {
    const encoded = encodeSlackModalPrivateMetadata("deploy", {
      threadTs: "123.456",
      channel: "C123",
    });
    const decoded = decodeSlackModalPrivateMetadata(encoded);

    expect(decoded.threadContext).toEqual({ threadTs: "123.456", channel: "C123" });
    expect(decoded.value).toBe("deploy");
  });
});
