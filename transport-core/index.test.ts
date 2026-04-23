import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompatibilityInstanceScope,
  buildCompatibilityWorkspaceScope,
  buildRuntimeScopeCarrier,
  type InboundMessage,
} from "./index.ts";

test("buildCompatibilityWorkspaceScope keeps unknown workspace ids unknown while preserving compatibility mode", () => {
  assert.deepEqual(
    buildCompatibilityWorkspaceScope({
      provider: "slack",
      workspaceId: "",
      channelId: " C123 ",
    }),
    {
      provider: "slack",
      source: "compatibility",
      compatibilityKey: "default",
      channelId: "C123",
    },
  );
});

test("buildRuntimeScopeCarrier combines workspace and instance compatibility carriers", () => {
  const scope = buildRuntimeScopeCarrier({
    workspace: buildCompatibilityWorkspaceScope({
      provider: "slack",
      workspaceId: "T123",
      channelId: "C123",
    }),
    instance: buildCompatibilityInstanceScope(),
  });

  assert.deepEqual(scope, {
    workspace: {
      provider: "slack",
      source: "compatibility",
      compatibilityKey: "default",
      workspaceId: "T123",
      channelId: "C123",
    },
    instance: {
      source: "compatibility",
      compatibilityKey: "default",
    },
  });
});

test("InboundMessage can carry first-class runtime scope metadata", () => {
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
      instance: buildCompatibilityInstanceScope(),
    }),
  };

  assert.equal(message.scope?.workspace?.workspaceId, "T123");
  assert.equal(message.scope?.instance?.compatibilityKey, "default");
});
