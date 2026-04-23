import {
  formatRuntimeScopeCarrier,
  getRuntimeScopeConflicts,
  parseRuntimeScopeCarrier,
  type AgentInfo,
  type BrokerMessage,
  type RuntimeScopeCarrier,
} from "./types.js";

interface AgentCapabilities {
  repo?: string;
  role?: string;
  tools?: string[];
  tags?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractAgentCapabilities(
  metadata: Record<string, unknown> | null | undefined,
): AgentCapabilities {
  const record = asRecord(metadata);
  const capabilitiesRecord = asRecord(record?.capabilities);

  return {
    repo: asString(capabilitiesRecord?.repo) ?? asString(record?.repo),
    role: asString(capabilitiesRecord?.role) ?? asString(record?.role),
    tools: asStringArray(capabilitiesRecord?.tools),
    tags: asStringArray(capabilitiesRecord?.tags),
  };
}

function extractAgentScope(agent: Pick<AgentInfo, "metadata">): RuntimeScopeCarrier | null {
  const record = asRecord(agent.metadata);
  const capabilitiesRecord = asRecord(record?.capabilities);
  return parseRuntimeScopeCarrier(capabilitiesRecord?.scope ?? record?.scope);
}

function parsePinetControlAction(
  body: string,
  metadata?: Record<string, unknown>,
): "reload" | "exit" | null {
  const metadataAction = asString(metadata?.action);
  if (
    metadata?.type === "pinet:control" &&
    (metadataAction === "reload" || metadataAction === "exit")
  ) {
    return metadataAction;
  }

  const trimmedBody = body.trim();
  if (trimmedBody === "/reload") return "reload";
  if (trimmedBody === "/exit") return "exit";

  try {
    const parsed = JSON.parse(trimmedBody) as Record<string, unknown>;
    const parsedAction = asString(parsed.action);
    if (parsed.type === "pinet:control" && (parsedAction === "reload" || parsedAction === "exit")) {
      return parsedAction;
    }
  } catch {
    /* not json */
  }

  return null;
}

function hasExplicitCrossScopeAdminAuthorization(metadata?: Record<string, unknown>): boolean {
  if (metadata?.allowCrossScopeAdmin === true) {
    return true;
  }

  const authorization = asRecord(metadata?.pinetAdminAuthorization);
  return authorization?.allowCrossScope === true;
}

function formatScopeConflictDimensions(
  senderScope: RuntimeScopeCarrier | null,
  targetScope: RuntimeScopeCarrier | null,
): string {
  return getRuntimeScopeConflicts(senderScope, targetScope)
    .map((conflict) => `${conflict.dimension}.${conflict.field}`)
    .join(", ");
}

function assertAdminDispatchScopeAuthorized(input: {
  sender: AgentInfo | undefined;
  target: AgentInfo;
  body: string;
  metadata?: Record<string, unknown>;
}): void {
  const action = parsePinetControlAction(input.body, input.metadata);
  if (!action || hasExplicitCrossScopeAdminAuthorization(input.metadata)) {
    return;
  }

  const senderScope = input.sender ? extractAgentScope(input.sender) : null;
  const targetScope = extractAgentScope(input.target);
  const conflicts = getRuntimeScopeConflicts(senderScope, targetScope);
  if (conflicts.length === 0) {
    return;
  }

  const senderName = input.sender?.name ?? input.sender?.id ?? "unknown sender";
  throw new Error(
    [
      `Pinet admin action /${action} from ${senderName} to ${input.target.name} crosses an unauthorized workspace/install or instance boundary.`,
      `Conflicts: ${formatScopeConflictDimensions(senderScope, targetScope)}.`,
      `Sender scope: ${formatRuntimeScopeCarrier(senderScope)}.`,
      `Target scope: ${formatRuntimeScopeCarrier(targetScope)}.`,
      "Add metadata.pinetAdminAuthorization.allowCrossScope=true to allow this cross-scope admin action explicitly.",
    ].join(" "),
  );
}

function buildAgentCapabilityTags(capabilities: AgentCapabilities): string[] {
  const tags = new Set<string>();

  if (capabilities.role) tags.add(`role:${capabilities.role}`);
  if (capabilities.repo) tags.add(`repo:${capabilities.repo}`);
  for (const tool of capabilities.tools ?? []) {
    tags.add(`tool:${tool}`);
  }
  for (const tag of capabilities.tags ?? []) {
    tags.add(tag);
  }

  return [...tags];
}

export interface AgentMessageStorage {
  getAgents(): AgentInfo[];
  getThread(threadId: string): { threadId: string } | null;
  createThread(threadId: string, source: string, channel: string, ownerAgent: string | null): void;
  insertMessage(
    threadId: string,
    source: string,
    direction: "inbound" | "outbound",
    sender: string,
    body: string,
    targetAgentIds: string[],
    metadata?: Record<string, unknown>,
  ): BrokerMessage;
}

export interface AgentDispatchTarget {
  id: string;
  name: string;
}

export interface DirectAgentDispatchInput {
  senderAgentId: string;
  senderAgentName: string;
  target: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface BroadcastAgentDispatchInput {
  senderAgentId: string;
  senderAgentName: string;
  channel: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface DirectAgentDispatchResult {
  target: AgentDispatchTarget;
  messageId: number;
  threadId: string;
}

export interface BroadcastAgentDispatchResult {
  channel: string;
  targets: AgentDispatchTarget[];
  messageIds: number[];
  threadIds: string[];
}

export type AgentDispatchCallback = (
  target: AgentDispatchTarget,
  message: BrokerMessage,
  metadata: Record<string, unknown>,
) => void;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChannelName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const normalized = withoutHash.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function addChannel(set: Set<string>, rawValue: string): void {
  const normalized = normalizeChannelName(rawValue);
  if (!normalized) return;
  set.add(normalized);

  if (normalized.startsWith("channel:") || normalized.startsWith("topic:")) {
    const derived = normalized.slice(normalized.indexOf(":") + 1).trim();
    if (derived) {
      set.add(derived);
    }
  }
}

function ensurePairThread(
  storage: AgentMessageStorage,
  senderAgentId: string,
  targetAgentId: string,
): string {
  const threadId = `a2a:${senderAgentId}:${targetAgentId}`;
  if (!storage.getThread(threadId)) {
    storage.createThread(threadId, "agent", "", senderAgentId);
  }
  return threadId;
}

function buildAgentMessageMetadata(
  senderAgentName: string,
  metadata?: Record<string, unknown>,
  broadcastChannel?: string,
): Record<string, unknown> {
  return {
    ...metadata,
    senderAgent: senderAgentName,
    a2a: true,
    ...(broadcastChannel ? { broadcast: true, broadcastChannel } : {}),
  };
}

function deliverAgentMessage(
  storage: AgentMessageStorage,
  senderAgentId: string,
  target: AgentDispatchTarget,
  body: string,
  metadata: Record<string, unknown>,
  onDispatch?: AgentDispatchCallback,
): { threadId: string; messageId: number } {
  const threadId = ensurePairThread(storage, senderAgentId, target.id);
  const msg = storage.insertMessage(
    threadId,
    "agent",
    "inbound",
    senderAgentId,
    body,
    [target.id],
    metadata,
  );
  onDispatch?.(target, msg, metadata);
  return { threadId, messageId: msg.id };
}

export function isBroadcastChannelTarget(target: string): boolean {
  return target.trim().startsWith("#");
}

export function normalizeBroadcastChannel(channel: string): string | null {
  return normalizeChannelName(channel);
}

export function getAgentBroadcastChannels(agent: Pick<AgentInfo, "metadata">): string[] {
  const subscriptions = new Set<string>(["all"]);
  const metadata = asRecord(agent.metadata);
  const capabilities = extractAgentCapabilities(metadata);

  if (capabilities.repo) {
    addChannel(subscriptions, capabilities.repo);
  }

  const role = capabilities.role?.trim().toLowerCase();
  if (role) {
    addChannel(subscriptions, `role:${role}`);
  }

  if (role !== "broker") {
    addChannel(subscriptions, "standup");
  }

  for (const tag of buildAgentCapabilityTags(capabilities)) {
    addChannel(subscriptions, tag);
  }

  for (const channel of asStringArray(metadata?.broadcastChannels)) {
    addChannel(subscriptions, channel);
  }

  for (const channel of asStringArray(metadata?.channels)) {
    addChannel(subscriptions, channel);
  }

  for (const topic of asStringArray(metadata?.topics)) {
    addChannel(subscriptions, `topic:${topic}`);
  }

  return [...subscriptions].sort();
}

export function agentSubscribesToBroadcastChannel(
  agent: Pick<AgentInfo, "metadata">,
  channel: string,
): boolean {
  const normalized = normalizeBroadcastChannel(channel);
  if (!normalized) return false;
  return getAgentBroadcastChannels(agent).includes(normalized);
}

export function resolveDirectAgentTarget(agents: AgentInfo[], target: string): AgentInfo | null {
  return (
    agents.find((agent) => agent.id === target) ??
    agents.find((agent) => agent.name === target) ??
    null
  );
}

export function resolveBroadcastTargets(
  agents: AgentInfo[],
  senderAgentId: string,
  channel: string,
): AgentInfo[] {
  return agents
    .filter((agent) => agent.id !== senderAgentId)
    .filter((agent) => agentSubscribesToBroadcastChannel(agent, channel))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function dispatchDirectAgentMessage(
  storage: AgentMessageStorage,
  input: DirectAgentDispatchInput,
  onDispatch?: AgentDispatchCallback,
): DirectAgentDispatchResult {
  const agents = storage.getAgents();
  const target = resolveDirectAgentTarget(agents, input.target);
  if (!target) {
    throw new Error(`Agent not found: ${input.target}`);
  }

  const sender = agents.find((agent) => agent.id === input.senderAgentId);
  assertAdminDispatchScopeAuthorized({
    sender,
    target,
    body: input.body,
    metadata: input.metadata,
  });

  const resolvedTarget: AgentDispatchTarget = { id: target.id, name: target.name };
  const metadata = buildAgentMessageMetadata(input.senderAgentName, input.metadata);
  const { threadId, messageId } = deliverAgentMessage(
    storage,
    input.senderAgentId,
    resolvedTarget,
    input.body,
    metadata,
    onDispatch,
  );

  return {
    target: resolvedTarget,
    messageId,
    threadId,
  };
}

export function dispatchBroadcastAgentMessage(
  storage: AgentMessageStorage,
  input: BroadcastAgentDispatchInput,
  onDispatch?: AgentDispatchCallback,
): BroadcastAgentDispatchResult {
  const normalizedChannel = normalizeBroadcastChannel(input.channel);
  if (!normalizedChannel) {
    throw new Error("Broadcast channel is required");
  }

  const agents = storage.getAgents();
  const sender = agents.find((agent) => agent.id === input.senderAgentId);
  const targetAgents = resolveBroadcastTargets(agents, input.senderAgentId, normalizedChannel);
  for (const target of targetAgents) {
    assertAdminDispatchScopeAuthorized({
      sender,
      target,
      body: input.body,
      metadata: input.metadata,
    });
  }
  const targets = targetAgents.map((agent) => ({ id: agent.id, name: agent.name }));

  if (targets.length === 0) {
    throw new Error(`No agents subscribed to #${normalizedChannel} other than the sender.`);
  }

  const broadcastChannel = `#${normalizedChannel}`;
  const metadata = buildAgentMessageMetadata(
    input.senderAgentName,
    input.metadata,
    broadcastChannel,
  );

  const messageIds: number[] = [];
  const threadIds: string[] = [];

  for (const target of targets) {
    const delivery = deliverAgentMessage(
      storage,
      input.senderAgentId,
      target,
      input.body,
      metadata,
      onDispatch,
    );
    messageIds.push(delivery.messageId);
    threadIds.push(delivery.threadId);
  }

  return {
    channel: broadcastChannel,
    targets,
    messageIds,
    threadIds,
  };
}
