import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildAgentDisplayInfo,
  filterAgentsForMeshVisibility,
  formatAgentList,
  rankAgentsForRouting,
  type AgentDisplayInfo,
} from "./helpers.js";
import { isBroadcastChannelTarget } from "./broker/agent-messaging.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import { resolveScheduledWakeupFireAt } from "./scheduled-wakeups.js";

export interface PinetToolsAgentRecord {
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

export interface RegisterPinetToolsDeps {
  pinetEnabled: () => boolean;
  brokerRole: () => "broker" | "follower" | null;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  sendPinetAgentMessage: (
    target: string,
    body: string,
  ) => Promise<{ messageId: number; target: string }>;
  sendPinetBroadcastMessage: (
    channel: string,
    body: string,
  ) => {
    channel: string;
    messageIds: number[];
    recipients: string[];
  };
  signalAgentFree: (
    ctx: ExtensionContext | undefined,
    options: { requirePinet?: boolean },
  ) => Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }>;
  scheduleBrokerWakeup: (
    fireAt: string,
    message: string,
  ) => Promise<{ id: number; fireAt: string }>;
  scheduleFollowerWakeup: (
    fireAt: string,
    message: string,
  ) => Promise<{ id: number; fireAt: string }>;
  listBrokerAgents: () => PinetToolsAgentRecord[];
  listFollowerAgents: (includeGhosts: boolean) => Promise<PinetToolsAgentRecord[]>;
}

interface PinetAgentsRoutingHint {
  repo?: string;
  branch?: string;
  role?: string;
  requiredTools?: string[];
  task?: string;
}

function buildPinetAgentsHintText(hint: PinetAgentsRoutingHint): string {
  return `Agent routing hints: ${[
    hint.repo ? `repo=${hint.repo}` : null,
    hint.branch ? `branch=${hint.branch}` : null,
    hint.role ? `role=${hint.role}` : null,
    hint.requiredTools && hint.requiredTools.length > 0
      ? `tools=${hint.requiredTools.join(",")}`
      : null,
    hint.task ? `task=${hint.task}` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" · ")}`;
}

export function registerPinetTools(pi: ExtensionAPI, deps: RegisterPinetToolsDeps): void {
  pi.registerTool({
    name: "pinet_message",
    label: "Pinet Message",
    description:
      "Send a message to another connected Pinet agent, or from the broker to a broadcast channel.",
    promptSnippet:
      "Send a message to another connected Pinet agent. When you send a task, sepcify the desired workflow, ideally something like `ack/work/ask/report`: ACK briefly, do the work, report blockers or questions immediately, report the outcome when done. Always reply where the task came from. To trigger remote agent control, send the exact message `/reload` or `/exit`. Broadcast channels like `#all` or `#extensions` are broker-only.",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Target agent name/ID, or a broker-only broadcast channel like #all or #extensions",
      }),
      message: Type.String({ description: "Message body" }),
    }),
    async execute(_id, params) {
      deps.requireToolPolicy(
        "pinet_message",
        undefined,
        `to=${params.to} | message=${params.message}`,
      );

      if (deps.brokerRole() === "broker" && isBroadcastChannelTarget(params.to)) {
        const result = deps.sendPinetBroadcastMessage(params.to, params.message);
        const preview = result.recipients.slice(0, 5).join(", ");
        const suffix = result.recipients.length > 5 ? ", …" : "";

        return {
          content: [
            {
              type: "text",
              text: `Broadcast sent to ${result.channel} (${result.recipients.length} agents: ${preview}${suffix}).`,
            },
          ],
          details: {
            channel: result.channel,
            messageIds: result.messageIds,
            recipients: result.recipients,
          },
        };
      }

      const result = await deps.sendPinetAgentMessage(params.to, params.message);
      return {
        content: [
          { type: "text", text: `Message sent to ${result.target} (id: ${result.messageId}).` },
        ],
        details: { messageId: result.messageId, target: result.target },
      };
    },
  });

  pi.registerTool({
    name: "pinet_free",
    label: "Pinet Free",
    description: "Signal that this Pinet agent is idle/free and available for new work.",
    promptSnippet:
      "When you have finished all assigned work and already reported the outcome, call this to mark yourself idle/free for new assignments.",
    parameters: Type.Object({
      note: Type.Optional(
        Type.String({ description: "Optional short note about what you just finished" }),
      ),
    }),
    async execute(_id, params) {
      deps.requireToolPolicy("pinet_free", undefined, `note=${params.note ?? ""}`);

      const note = typeof params.note === "string" ? params.note.trim() : "";
      const result = await deps.signalAgentFree(undefined, { requirePinet: true });
      const inboxSuffix =
        result.queuedInboxCount > 0
          ? ` ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? " remains" : "s remain"}.`
          : "";
      const noteSuffix = note ? ` Note: ${note}.` : "";

      return {
        content: [
          {
            type: "text",
            text: `Marked this Pinet agent idle/free for new work.${noteSuffix}${inboxSuffix}`,
          },
        ],
        details: {
          status: "idle",
          note: note || null,
          queuedInboxCount: result.queuedInboxCount,
        },
      };
    },
  });

  pi.registerTool({
    name: "pinet_schedule",
    label: "Pinet Schedule",
    description: "Schedule a future wake-up message for the current Pinet agent.",
    promptSnippet:
      "Schedule a future wake-up for yourself via the Pinet broker. Use this instead of busy-waiting when you need to check back later.",
    parameters: Type.Object({
      delay: Type.Optional(
        Type.String({ description: "Relative delay like 5m, 30s, 1h30m, or 1d" }),
      ),
      at: Type.Optional(
        Type.String({ description: "Absolute ISO-8601 UTC time, e.g. 2026-04-02T14:30:00Z" }),
      ),
      message: Type.String({ description: "Reminder or wake-up message to deliver later" }),
    }),
    async execute(_id, params) {
      deps.requireToolPolicy(
        "pinet_schedule",
        undefined,
        `delay=${params.delay ?? ""} | at=${params.at ?? ""} | message=${params.message}`,
      );

      if (!deps.pinetEnabled()) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      const message = params.message.trim();
      if (!message) {
        throw new Error("message is required");
      }

      const fireAt = resolveScheduledWakeupFireAt({ delay: params.delay, at: params.at });

      if (deps.brokerRole() === "broker") {
        const wakeup = await deps.scheduleBrokerWakeup(fireAt, message);
        return {
          content: [
            {
              type: "text",
              text: `Wake-up scheduled for ${wakeup.fireAt} (id: ${wakeup.id}).`,
            },
          ],
          details: wakeup,
        };
      }

      if (deps.brokerRole() === "follower") {
        const wakeup = await deps.scheduleFollowerWakeup(fireAt, message);
        return {
          content: [
            {
              type: "text",
              text: `Wake-up scheduled for ${wakeup.fireAt} (id: ${wakeup.id}).`,
            },
          ],
          details: wakeup,
        };
      }

      throw new Error("Pinet is in an unexpected state.");
    },
  });

  pi.registerTool({
    name: "pinet_agents",
    label: "Pinet Agents",
    description: "List Pinet agents, including liveness and capability visibility.",
    promptSnippet:
      "List connected Pinet agents with liveness and capability info. Use before delegating work to find available agents, or to check health and status of agents you have assigned work to.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Preferred repo name for routing" })),
      branch: Type.Optional(Type.String({ description: "Preferred branch for routing" })),
      role: Type.Optional(
        Type.String({ description: "Preferred agent role, e.g. broker or worker" }),
      ),
      required_tools: Type.Optional(
        Type.String({ description: "Comma-separated required capability/tool tags" }),
      ),
      task: Type.Optional(Type.String({ description: "Optional natural-language task hint" })),
    }),
    async execute(_toolCallId, params) {
      deps.requireToolPolicy(
        "pinet_agents",
        undefined,
        `repo=${params.repo ?? ""} | branch=${params.branch ?? ""} | role=${params.role ?? ""} | required_tools=${params.required_tools ?? ""} | task=${params.task ?? ""}`,
      );

      if (!deps.pinetEnabled()) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      const includeGhosts = true;
      const recentGhostWindowMs = DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;
      const nowMs = Date.now();
      const hint: PinetAgentsRoutingHint = {
        repo: params.repo,
        branch: params.branch,
        role: params.role,
        requiredTools: params.required_tools
          ?.split(",")
          .map((tool: string) => tool.trim())
          .filter(Boolean),
        task: params.task,
      };
      const hasHint = Boolean(
        hint.repo || hint.branch || hint.role || (hint.requiredTools?.length ?? 0) > 0 || hint.task,
      );

      const toDisplay = (agent: PinetToolsAgentRecord): AgentDisplayInfo =>
        buildAgentDisplayInfo(agent, {
          now: nowMs,
          heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        });

      let rawAgents: PinetToolsAgentRecord[];
      if (deps.brokerRole() === "broker") {
        rawAgents = deps.listBrokerAgents();
      } else if (deps.brokerRole() === "follower") {
        rawAgents = await deps.listFollowerAgents(includeGhosts);
      } else {
        throw new Error("Pinet is in an unexpected state.");
      }

      const visibleAgents = filterAgentsForMeshVisibility(rawAgents, {
        now: nowMs,
        includeGhosts,
        recentDisconnectWindowMs: recentGhostWindowMs,
      }).map(toDisplay);
      const agents = rankAgentsForRouting(visibleAgents, hint);
      const header = hasHint ? `${buildPinetAgentsHintText(hint)}\n\n` : "";
      const text = `${header}${formatAgentList(agents, os.homedir())}`;

      return {
        content: [{ type: "text", text }],
        details: { agents, hint },
      };
    },
  });
}
