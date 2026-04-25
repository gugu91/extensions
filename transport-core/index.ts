export type RuntimeScopeSource = "explicit" | "compatibility";

export const DEFAULT_COMPATIBILITY_SCOPE_KEY = "default";

export interface WorkspaceInstallScopeCarrier {
  provider: string;
  source: RuntimeScopeSource;
  compatibilityKey?: string;
  workspaceId?: string;
  installId?: string;
  channelId?: string;
}

export interface InstanceScopeCarrier {
  source: RuntimeScopeSource;
  compatibilityKey?: string;
  instanceId?: string;
  instanceName?: string;
}

export interface RuntimeScopeCarrier {
  workspace?: WorkspaceInstallScopeCarrier;
  instance?: InstanceScopeCarrier;
}

function normalizeScopeValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asScopeSource(value: unknown): RuntimeScopeSource {
  return value === "explicit" ? "explicit" : "compatibility";
}

function pushScopeConflict(
  conflicts: RuntimeScopeConflict[],
  dimension: RuntimeScopeDimension,
  field: string,
  expected: string | undefined,
  actual: string | undefined,
): void {
  if (!expected) {
    return;
  }

  const resolvedExpected = expected;
  if (!actual) {
    conflicts.push({
      dimension,
      field,
      expected: resolvedExpected,
      actual: "unscoped",
    });
    return;
  }

  if (expected === actual) {
    return;
  }

  conflicts.push({ dimension, field, expected: resolvedExpected, actual });
}

export function buildCompatibilityWorkspaceScope(options: {
  provider: string;
  workspaceId?: string | null;
  installId?: string | null;
  channelId?: string | null;
  compatibilityKey?: string | null;
}): WorkspaceInstallScopeCarrier {
  return {
    provider: options.provider,
    source: "compatibility",
    compatibilityKey:
      normalizeScopeValue(options.compatibilityKey) ?? DEFAULT_COMPATIBILITY_SCOPE_KEY,
    ...(normalizeScopeValue(options.workspaceId)
      ? { workspaceId: normalizeScopeValue(options.workspaceId) }
      : {}),
    ...(normalizeScopeValue(options.installId)
      ? { installId: normalizeScopeValue(options.installId) }
      : {}),
    ...(normalizeScopeValue(options.channelId)
      ? { channelId: normalizeScopeValue(options.channelId) }
      : {}),
  };
}

export function buildCompatibilityInstanceScope(
  options: {
    instanceId?: string | null;
    instanceName?: string | null;
    compatibilityKey?: string | null;
  } = {},
): InstanceScopeCarrier {
  return {
    source: "compatibility",
    compatibilityKey:
      normalizeScopeValue(options.compatibilityKey) ?? DEFAULT_COMPATIBILITY_SCOPE_KEY,
    ...(normalizeScopeValue(options.instanceId)
      ? { instanceId: normalizeScopeValue(options.instanceId) }
      : {}),
    ...(normalizeScopeValue(options.instanceName)
      ? { instanceName: normalizeScopeValue(options.instanceName) }
      : {}),
  };
}

export function buildRuntimeScopeCarrier(options: {
  workspace?: WorkspaceInstallScopeCarrier | null;
  instance?: InstanceScopeCarrier | null;
}): RuntimeScopeCarrier | undefined {
  const scope: RuntimeScopeCarrier = {};
  if (options.workspace) {
    scope.workspace = options.workspace;
  }
  if (options.instance) {
    scope.instance = options.instance;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

export type RuntimeScopeDimension = "workspace" | "instance";

export interface RuntimeScopeConflict {
  dimension: RuntimeScopeDimension;
  field: string;
  expected: string;
  actual: string;
}

export function parseRuntimeScopeCarrier(value: unknown): RuntimeScopeCarrier | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const workspaceRecord = asRecord(record.workspace);
  const instanceRecord = asRecord(record.instance);
  const scope = buildRuntimeScopeCarrier({
    workspace: workspaceRecord
      ? {
          provider: normalizeScopeValue(String(workspaceRecord.provider ?? "slack")) ?? "slack",
          source: asScopeSource(workspaceRecord.source),
          ...(normalizeScopeValue(
            typeof workspaceRecord.compatibilityKey === "string"
              ? workspaceRecord.compatibilityKey
              : undefined,
          )
            ? {
                compatibilityKey: normalizeScopeValue(
                  typeof workspaceRecord.compatibilityKey === "string"
                    ? workspaceRecord.compatibilityKey
                    : undefined,
                ),
              }
            : {}),
          ...(normalizeScopeValue(
            typeof workspaceRecord.workspaceId === "string"
              ? workspaceRecord.workspaceId
              : undefined,
          )
            ? {
                workspaceId: normalizeScopeValue(
                  typeof workspaceRecord.workspaceId === "string"
                    ? workspaceRecord.workspaceId
                    : undefined,
                ),
              }
            : {}),
          ...(normalizeScopeValue(
            typeof workspaceRecord.installId === "string" ? workspaceRecord.installId : undefined,
          )
            ? {
                installId: normalizeScopeValue(
                  typeof workspaceRecord.installId === "string"
                    ? workspaceRecord.installId
                    : undefined,
                ),
              }
            : {}),
          ...(normalizeScopeValue(
            typeof workspaceRecord.channelId === "string" ? workspaceRecord.channelId : undefined,
          )
            ? {
                channelId: normalizeScopeValue(
                  typeof workspaceRecord.channelId === "string"
                    ? workspaceRecord.channelId
                    : undefined,
                ),
              }
            : {}),
        }
      : null,
    instance: instanceRecord
      ? {
          source: asScopeSource(instanceRecord.source),
          ...(normalizeScopeValue(
            typeof instanceRecord.compatibilityKey === "string"
              ? instanceRecord.compatibilityKey
              : undefined,
          )
            ? {
                compatibilityKey: normalizeScopeValue(
                  typeof instanceRecord.compatibilityKey === "string"
                    ? instanceRecord.compatibilityKey
                    : undefined,
                ),
              }
            : {}),
          ...(normalizeScopeValue(
            typeof instanceRecord.instanceId === "string" ? instanceRecord.instanceId : undefined,
          )
            ? {
                instanceId: normalizeScopeValue(
                  typeof instanceRecord.instanceId === "string"
                    ? instanceRecord.instanceId
                    : undefined,
                ),
              }
            : {}),
          ...(normalizeScopeValue(
            typeof instanceRecord.instanceName === "string"
              ? instanceRecord.instanceName
              : undefined,
          )
            ? {
                instanceName: normalizeScopeValue(
                  typeof instanceRecord.instanceName === "string"
                    ? instanceRecord.instanceName
                    : undefined,
                ),
              }
            : {}),
        }
      : null,
  });

  return scope ?? null;
}

export function getRuntimeScopeConflicts(
  actual: RuntimeScopeCarrier | null | undefined,
  expected: RuntimeScopeCarrier | null | undefined,
  dimensions: RuntimeScopeDimension[] = ["workspace", "instance"],
): RuntimeScopeConflict[] {
  const conflicts: RuntimeScopeConflict[] = [];

  if (dimensions.includes("workspace")) {
    pushScopeConflict(
      conflicts,
      "workspace",
      "provider",
      expected?.workspace?.provider,
      actual?.workspace?.provider,
    );
    pushScopeConflict(
      conflicts,
      "workspace",
      "source",
      expected?.workspace?.source,
      actual?.workspace?.source,
    );
    pushScopeConflict(
      conflicts,
      "workspace",
      "compatibilityKey",
      expected?.workspace?.compatibilityKey,
      actual?.workspace?.compatibilityKey,
    );
    pushScopeConflict(
      conflicts,
      "workspace",
      "workspaceId",
      expected?.workspace?.workspaceId,
      actual?.workspace?.workspaceId,
    );
    pushScopeConflict(
      conflicts,
      "workspace",
      "installId",
      expected?.workspace?.installId,
      actual?.workspace?.installId,
    );
  }

  if (dimensions.includes("instance")) {
    pushScopeConflict(
      conflicts,
      "instance",
      "source",
      expected?.instance?.source,
      actual?.instance?.source,
    );
    pushScopeConflict(
      conflicts,
      "instance",
      "compatibilityKey",
      expected?.instance?.compatibilityKey,
      actual?.instance?.compatibilityKey,
    );
    pushScopeConflict(
      conflicts,
      "instance",
      "instanceId",
      expected?.instance?.instanceId,
      actual?.instance?.instanceId,
    );
    pushScopeConflict(
      conflicts,
      "instance",
      "instanceName",
      expected?.instance?.instanceName,
      actual?.instance?.instanceName,
    );
  }

  return conflicts;
}

export function isRuntimeScopeAuthorized(
  actual: RuntimeScopeCarrier | null | undefined,
  expected: RuntimeScopeCarrier | null | undefined,
  dimensions: RuntimeScopeDimension[] = ["workspace", "instance"],
): boolean {
  return getRuntimeScopeConflicts(actual, expected, dimensions).length === 0;
}

export function formatRuntimeScopeCarrier(scope: RuntimeScopeCarrier | null | undefined): string {
  if (!scope?.workspace && !scope?.instance) {
    return "unscoped";
  }

  const parts: string[] = [];
  if (scope.workspace) {
    parts.push(`workspace.provider=${scope.workspace.provider}`);
    parts.push(`workspace.source=${scope.workspace.source}`);
    if (scope.workspace.compatibilityKey) {
      parts.push(`workspace.compatibilityKey=${scope.workspace.compatibilityKey}`);
    }
    if (scope.workspace.workspaceId) {
      parts.push(`workspace.workspaceId=${scope.workspace.workspaceId}`);
    }
    if (scope.workspace.installId) {
      parts.push(`workspace.installId=${scope.workspace.installId}`);
    }
    if (scope.workspace.channelId) {
      parts.push(`workspace.channelId=${scope.workspace.channelId}`);
    }
  }
  if (scope.instance) {
    parts.push(`instance.source=${scope.instance.source}`);
    if (scope.instance.compatibilityKey) {
      parts.push(`instance.compatibilityKey=${scope.instance.compatibilityKey}`);
    }
    if (scope.instance.instanceId) {
      parts.push(`instance.instanceId=${scope.instance.instanceId}`);
    }
    if (scope.instance.instanceName) {
      parts.push(`instance.instanceName=${scope.instance.instanceName}`);
    }
  }

  return parts.join(", ");
}

export interface InboundMessage {
  source: string;
  threadId: string;
  channel: string;
  userId: string;
  userName?: string;
  text: string;
  timestamp: string;
  isChannelMention?: boolean;
  metadata?: Record<string, unknown>;
  scope?: RuntimeScopeCarrier;
}

export interface OutboundMessage {
  threadId: string;
  channel: string;
  text: string;
  agentName?: string;
  agentEmoji?: string;
  agentOwnerToken?: string;
  metadata?: Record<string, unknown>;
  scope?: RuntimeScopeCarrier;
}

export interface MessageAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInbound(handler: (msg: InboundMessage) => void): void;
  send(msg: OutboundMessage): Promise<void>;
}
