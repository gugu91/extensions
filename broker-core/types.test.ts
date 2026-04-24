import { describe, expect, it } from "vitest";
import {
  buildCompatibilityInstanceScope,
  buildCompatibilityWorkspaceScope,
  buildRuntimeScopeCarrier,
  type InboundMessage,
} from "./types.ts";

describe("broker-core scope carriers", () => {
  it("re-exports compatibility scope builders from transport-core", () => {
    const scope = buildRuntimeScopeCarrier({
      workspace: buildCompatibilityWorkspaceScope({
        provider: "slack",
        workspaceId: "T123",
      }),
      instance: buildCompatibilityInstanceScope({ compatibilityKey: "default" }),
    });

    expect(scope).toEqual({
      workspace: {
        provider: "slack",
        source: "compatibility",
        compatibilityKey: "default",
        workspaceId: "T123",
      },
      instance: {
        source: "compatibility",
        compatibilityKey: "default",
      },
    });
  });

  it("preserves optional runtime scope carriers on inbound messages", () => {
    const message: InboundMessage = {
      source: "slack",
      threadId: "123.456",
      channel: "C123",
      userId: "U123",
      text: "hello",
      timestamp: "123.456",
      scope: buildRuntimeScopeCarrier({
        workspace: buildCompatibilityWorkspaceScope({
          provider: "slack",
          workspaceId: "T123",
        }),
      }),
    };

    expect(message.scope?.workspace?.workspaceId).toBe("T123");
    expect(message.scope?.workspace?.source).toBe("compatibility");
  });
});
