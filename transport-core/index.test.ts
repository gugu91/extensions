import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompatibilityInstanceScope,
  buildCompatibilityWorkspaceScope,
  buildRuntimeScopeCarrier,
  formatRuntimeScopeCarrier,
  getRuntimeScopeConflicts,
  isRuntimeScopeAuthorized,
  parseRuntimeScopeCarrier,
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

test("parseRuntimeScopeCarrier reconstructs runtime scope carriers from plain metadata", () => {
  const scope = parseRuntimeScopeCarrier({
    workspace: {
      provider: "slack",
      source: "explicit",
      workspaceId: "T123",
      installId: "primary",
      channelId: "C123",
    },
    instance: {
      source: "compatibility",
      compatibilityKey: "default",
    },
  });

  assert.deepEqual(scope, {
    workspace: {
      provider: "slack",
      source: "explicit",
      workspaceId: "T123",
      installId: "primary",
      channelId: "C123",
    },
    instance: {
      source: "compatibility",
      compatibilityKey: "default",
    },
  });
});

test("runtime scope authorization rejects conflicting workspace and instance boundaries", () => {
  const expected = buildRuntimeScopeCarrier({
    workspace: {
      provider: "slack",
      source: "explicit",
      workspaceId: "T_PRIMARY",
      installId: "primary",
    },
    instance: {
      source: "explicit",
      instanceId: "broker-a",
      instanceName: "Broker A",
    },
  });
  const actual = buildRuntimeScopeCarrier({
    workspace: {
      provider: "slack",
      source: "explicit",
      workspaceId: "T_SECONDARY",
      installId: "secondary",
    },
    instance: {
      source: "explicit",
      instanceId: "broker-b",
      instanceName: "Broker B",
    },
  });

  assert.equal(isRuntimeScopeAuthorized(actual, expected), false);
  assert.deepEqual(getRuntimeScopeConflicts(actual, expected), [
    {
      dimension: "workspace",
      field: "workspaceId",
      expected: "T_PRIMARY",
      actual: "T_SECONDARY",
    },
    {
      dimension: "workspace",
      field: "installId",
      expected: "primary",
      actual: "secondary",
    },
    {
      dimension: "instance",
      field: "instanceId",
      expected: "broker-a",
      actual: "broker-b",
    },
    {
      dimension: "instance",
      field: "instanceName",
      expected: "Broker A",
      actual: "Broker B",
    },
  ]);
  assert.match(formatRuntimeScopeCarrier(actual), /workspace\.installId=secondary/);
});

test("runtime scope authorization rejects missing actual workspace or instance scopes", () => {
  const expected = buildRuntimeScopeCarrier({
    workspace: {
      provider: "slack",
      source: "explicit",
      workspaceId: "T_PRIMARY",
      installId: "primary",
    },
    instance: {
      source: "explicit",
      instanceId: "broker-a",
      instanceName: "Broker A",
    },
  });

  assert.equal(isRuntimeScopeAuthorized(undefined, expected), false);
  assert.equal(isRuntimeScopeAuthorized({}, expected), false);

  const conflicts = getRuntimeScopeConflicts(undefined, expected);
  assert.ok(conflicts.length > 0);
  assert.deepEqual(conflicts.slice(0, 2), [
    {
      dimension: "workspace",
      field: "provider",
      expected: "slack",
      actual: "unscoped",
    },
    {
      dimension: "workspace",
      field: "source",
      expected: "explicit",
      actual: "unscoped",
    },
  ]);
});
