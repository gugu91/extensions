import { normalizeOutgoingPinetControlMessage } from "./helpers.js";
import {
  dispatchBroadcastAgentMessage,
  dispatchDirectAgentMessage,
  isBroadcastChannelTarget,
  type AgentMessageStorage,
} from "./broker/agent-messaging.js";
import type { AgentInfo, TaskAssignmentInfo } from "./broker/types.js";
import type { ActivityLogEntry } from "./activity-log.js";
import { extractTaskAssignmentsFromMessage } from "./task-assignments.js";

export interface PinetMeshOpsAgentRecord {
  emoji: string;
  name: string;
  id: string;
  pid?: number;
  status: "working" | "idle";
  metadata: Record<string, unknown> | null;
  lastHeartbeat: string;
  lastSeen?: string;
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
}

export interface PinetMeshOpsRecordedAssignment {
  issueNumber: number;
  branch: string | null;
}

export interface PinetMeshOpsBrokerDbPort extends AgentMessageStorage {
  getAllAgents: () => AgentInfo[];
  recordTaskAssignment: (
    agentId: string,
    issueNumber: number,
    branch: string | null,
    threadId: string,
    sourceMessageId: number,
  ) => TaskAssignmentInfo;
  scheduleWakeup: (
    agentId: string,
    message: string,
    fireAt: string,
  ) => { id: number; fireAt: string } | Promise<{ id: number; fireAt: string }>;
}

export interface PinetMeshOpsFollowerAgentRecord extends Omit<PinetMeshOpsAgentRecord, "status"> {
  status?: PinetMeshOpsAgentRecord["status"] | null;
}

export interface PinetMeshOpsFollowerClientPort {
  sendAgentMessage: (
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ) => Promise<number>;
  scheduleWakeup: (fireAt: string, message: string) => Promise<{ id: number; fireAt: string }>;
  listAgents: (includeGhosts: boolean) => Promise<PinetMeshOpsFollowerAgentRecord[]>;
}

export interface PinetMeshOpsDeps {
  getPinetEnabled: () => boolean;
  getBrokerRole: () => "broker" | "follower" | null;
  getActiveBrokerDb: () => PinetMeshOpsBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  getAgentName: () => string;
  getFollowerClient: () => PinetMeshOpsFollowerClientPort | null;
  formatTrackedAgent: (agentId: string) => string;
  logActivity: (entry: ActivityLogEntry) => void;
}

export interface PinetMeshOps {
  sendPinetAgentMessage: (
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ) => Promise<{ messageId: number; target: string }>;
  sendPinetBroadcastMessage: (
    channel: string,
    body: string,
  ) => { channel: string; messageIds: number[]; recipients: string[] };
  scheduleBrokerWakeup: (
    fireAt: string,
    message: string,
  ) => Promise<{ id: number; fireAt: string }>;
  scheduleFollowerWakeup: (
    fireAt: string,
    message: string,
  ) => Promise<{ id: number; fireAt: string }>;
  listBrokerAgents: () => PinetMeshOpsAgentRecord[];
  listFollowerAgents: (includeGhosts: boolean) => Promise<PinetMeshOpsAgentRecord[]>;
}

function prepareOutgoingPinetAgentMessage(
  body: string,
  metadata?: Record<string, unknown>,
): { body: string; metadata?: Record<string, unknown> } {
  const control = normalizeOutgoingPinetControlMessage(body, metadata);
  if (control) {
    return {
      body: control.body,
      metadata: control.metadata,
    };
  }

  return { body, metadata };
}

export function createPinetMeshOps(deps: PinetMeshOpsDeps): PinetMeshOps {
  async function sendPinetAgentMessage(
    targetRef: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ messageId: number; target: string }> {
    if (!deps.getPinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
    }

    if (isBroadcastChannelTarget(targetRef)) {
      throw new Error(
        "Broadcast channels are broker-only. Send the request to the broker instead.",
      );
    }

    const outgoing = prepareOutgoingPinetAgentMessage(body, metadata);
    const finalBody = outgoing.body;
    const finalMetadata = outgoing.metadata;

    if (deps.getBrokerRole() === "broker") {
      const db = deps.getActiveBrokerDb();
      const selfId = deps.getActiveBrokerSelfId();
      if (!db || !selfId) {
        throw new Error("Broker agent identity is unavailable.");
      }

      const result = dispatchDirectAgentMessage(db, {
        senderAgentId: selfId,
        senderAgentName: deps.getAgentName(),
        target: targetRef,
        body: finalBody,
        metadata: finalMetadata,
      });

      const recordedAssignments: PinetMeshOpsRecordedAssignment[] = [];
      for (const assignment of extractTaskAssignmentsFromMessage(body)) {
        const tracked = db.recordTaskAssignment(
          result.target.id,
          assignment.issueNumber,
          assignment.branch,
          result.threadId,
          result.messageId,
        );
        recordedAssignments.push({ issueNumber: tracked.issueNumber, branch: tracked.branch });
      }

      if (recordedAssignments.length > 0) {
        deps.logActivity({
          kind: "task_assignment",
          level: "actions",
          title: recordedAssignments.length === 1 ? "Task assigned" : "Tasks assigned",
          summary: `Assigned ${recordedAssignments.map((assignment) => `#${assignment.issueNumber}`).join(", ")} to ${deps.formatTrackedAgent(result.target.id)}.`,
          details: recordedAssignments.map((assignment) =>
            assignment.branch
              ? `#${assignment.issueNumber} on \`${assignment.branch}\``
              : `#${assignment.issueNumber}`,
          ),
          fields: [
            { label: "Worker", value: deps.formatTrackedAgent(result.target.id) },
            { label: "Thread", value: result.threadId },
            { label: "Message", value: result.messageId },
          ],
          tone: "info",
        });
      }

      return { messageId: result.messageId, target: result.target.name };
    }

    if (deps.getBrokerRole() === "follower") {
      const client = deps.getFollowerClient();
      if (!client) {
        throw new Error("Pinet is in an unexpected state.");
      }

      const messageId = await client.sendAgentMessage(targetRef, finalBody, finalMetadata);
      return { messageId, target: targetRef };
    }

    throw new Error("Pinet is in an unexpected state.");
  }

  function sendPinetBroadcastMessage(
    channel: string,
    body: string,
  ): { channel: string; messageIds: number[]; recipients: string[] } {
    const db = deps.getActiveBrokerDb();
    const selfId = deps.getActiveBrokerSelfId();
    if (!db || !selfId) {
      throw new Error("Broker agent identity is unavailable.");
    }

    const outgoing = prepareOutgoingPinetAgentMessage(body);
    const result = dispatchBroadcastAgentMessage(db, {
      senderAgentId: selfId,
      senderAgentName: deps.getAgentName(),
      channel,
      body: outgoing.body,
      ...(outgoing.metadata ? { metadata: outgoing.metadata } : {}),
    });

    return {
      channel: result.channel,
      messageIds: result.messageIds,
      recipients: result.targets.map((target) => target.name),
    };
  }

  async function scheduleBrokerWakeup(
    fireAt: string,
    message: string,
  ): Promise<{ id: number; fireAt: string }> {
    const db = deps.getActiveBrokerDb();
    const selfId = deps.getActiveBrokerSelfId();
    if (!db || !selfId) {
      throw new Error("Broker agent identity is unavailable.");
    }

    return await db.scheduleWakeup(selfId, message, fireAt);
  }

  async function scheduleFollowerWakeup(
    fireAt: string,
    message: string,
  ): Promise<{ id: number; fireAt: string }> {
    const client = deps.getFollowerClient();
    if (!client) {
      throw new Error("Pinet is in an unexpected state.");
    }

    return await client.scheduleWakeup(fireAt, message);
  }

  function listBrokerAgents(): PinetMeshOpsAgentRecord[] {
    const db = deps.getActiveBrokerDb();
    if (!db) {
      throw new Error("Broker agent identity is unavailable.");
    }

    return db.getAllAgents().map((agent) => ({
      emoji: agent.emoji,
      name: agent.name,
      id: agent.id,
      pid: agent.pid,
      status: agent.status,
      metadata: agent.metadata,
      lastHeartbeat: agent.lastHeartbeat,
      lastSeen: agent.lastSeen,
      disconnectedAt: agent.disconnectedAt,
      resumableUntil: agent.resumableUntil,
    }));
  }

  async function listFollowerAgents(includeGhosts: boolean): Promise<PinetMeshOpsAgentRecord[]> {
    const client = deps.getFollowerClient();
    if (!client) {
      throw new Error("Pinet is in an unexpected state.");
    }

    return (await client.listAgents(includeGhosts)).map((agent) => ({
      emoji: agent.emoji,
      name: agent.name,
      id: agent.id,
      pid: agent.pid,
      status: agent.status ?? "idle",
      metadata: agent.metadata,
      lastHeartbeat: agent.lastHeartbeat,
      lastSeen: agent.lastSeen,
      disconnectedAt: agent.disconnectedAt,
      resumableUntil: agent.resumableUntil,
    }));
  }

  return {
    sendPinetAgentMessage,
    sendPinetBroadcastMessage,
    scheduleBrokerWakeup,
    scheduleFollowerWakeup,
    listBrokerAgents,
    listFollowerAgents,
  };
}
