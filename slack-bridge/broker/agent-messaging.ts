import { buildAgentCapabilityTags, extractAgentCapabilities } from "../helpers.js";
import type { AgentInfo, BrokerMessage } from "./types.js";

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

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
  senderAgentName: string,
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
  const target = resolveDirectAgentTarget(storage.getAgents(), input.target);
  if (!target) {
    throw new Error(`Agent not found: ${input.target}`);
  }

  const resolvedTarget: AgentDispatchTarget = { id: target.id, name: target.name };
  const metadata = buildAgentMessageMetadata(input.senderAgentName, input.metadata);
  const { threadId, messageId } = deliverAgentMessage(
    storage,
    input.senderAgentId,
    input.senderAgentName,
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
  const targets = resolveBroadcastTargets(agents, input.senderAgentId, normalizedChannel).map(
    (agent) => ({ id: agent.id, name: agent.name }),
  );

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
      input.senderAgentName,
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
