import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  generateAgentName,
  agentOwnsThread,
  describeSlackUserAccess,
  resolveAllowAllWorkspaceUsers,
  type SlackBridgeSettings,
} from "./helpers.js";
import { formatRecentActivityLogEntries, type LoggedActivityLogEntry } from "./activity-log.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

// ─── Types ───────────────────────────────────────────────

type PinetRuntimeControlContext = ExtensionContext & {
  abort?: () => void;
};

export interface PinetCommandsDeps {
  // State accessors
  pinetEnabled: () => boolean;
  pinetRegistrationBlocked: () => boolean;
  runtimeMode: () => SlackBridgeRuntimeMode;
  runtimeConnected: () => boolean;
  brokerRole: () => "broker" | "follower" | null;
  agentName: () => string;
  agentEmoji: () => string;
  agentOwnerToken: () => string;
  agentPersonality: () => string | null;
  agentAliases: () => Set<string>;
  botUserId: () => string | null;
  activeSkinTheme: () => string | null;
  lastDmChannel: () => string | null;
  threads: () => Map<string, { owner?: string }>;
  allowedUsers: () => Set<string> | null;
  inboxLength: () => number;
  recentActivityLogEntries: (limit: number) => ReadonlyArray<LoggedActivityLogEntry>;
  settings: () => SlackBridgeSettings;
  lastBrokerMaintenance: () => {
    pendingBacklogCount: number;
    assignedBacklogCount: number;
    reapedAgentIds: string[];
    repairedThreadClaims: number;
    anomalies: string[];
  } | null;
  isBrokerControlPlaneCanvasEnabled: () => boolean;
  getConfiguredBrokerControlPlaneCanvasId: () => string | null;
  getConfiguredBrokerControlPlaneCanvasChannel: () => string | null;
  lastBrokerControlPlaneCanvasRefreshAt: () => string | null;
  lastBrokerControlPlaneCanvasError: () => string | null;
  getBrokerControlPlaneHomeTabViewerIds: () => string[];
  lastBrokerControlPlaneHomeTabRefreshAt: () => string | null;
  lastBrokerControlPlaneHomeTabError: () => string | null;

  // Actions
  getPinetRegistrationBlockReason: () => string;
  connectAsBroker: (ctx: ExtensionContext) => Promise<void>;
  connectAsFollower: (ctx: ExtensionContext) => Promise<void>;
  reloadPinetRuntime: (ctx: ExtensionContext) => Promise<void>;
  disconnectFollower: (ctx: ExtensionContext) => Promise<{ unregisterError: string | null }>;
  sendPinetAgentMessage: (
    target: string,
    body: string,
  ) => Promise<{ messageId: number; target: string }>;
  signalAgentFree: (
    ctx: ExtensionContext,
    options: { requirePinet?: boolean },
  ) => Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }>;
  applyMeshSkin: (themeInput: string) => { theme: string; updatedAgents: string[] };
  applyLocalAgentIdentity: (name: string, emoji: string, personality: string | null) => void;
  setExtStatus: (ctx: ExtensionContext, state: "ok" | "reconnecting" | "error" | "off") => void;
  setExtCtx: (ctx: ExtensionContext) => void;
}

// ─── Registration ────────────────────────────────────────

function abortCurrentTurnBeforeBrokerReload(ctx: ExtensionContext): void {
  if (ctx.isIdle?.() ?? true) {
    return;
  }

  try {
    (ctx as PinetRuntimeControlContext).abort?.();
  } catch {
    /* best effort */
  }
}

export function registerPinetCommands(pi: ExtensionAPI, deps: PinetCommandsDeps): void {
  pi.registerCommand("pinet-start", {
    description:
      "Start Pinet as the broker (Slack connection + message routing, or reload the active broker)",
    handler: async (_args, ctx) => {
      if (deps.pinetRegistrationBlocked()) {
        ctx.ui.notify(deps.getPinetRegistrationBlockReason(), "warning");
        return;
      }
      deps.setExtCtx(ctx);

      if (deps.runtimeMode() === "broker") {
        try {
          abortCurrentTurnBeforeBrokerReload(ctx);
          ctx.ui.notify("Pinet broker already running — reloading current runtime", "info");
          await deps.reloadPinetRuntime(ctx);
        } catch (err) {
          ctx.ui.notify(`Pinet broker reload failed: ${errorMsg(err)}`, "error");
          deps.setExtStatus(ctx, "error");
        }
        return;
      }

      try {
        await deps.connectAsBroker(ctx);
      } catch (err) {
        ctx.ui.notify(`Pinet broker failed: ${errorMsg(err)}`, "error");
        deps.setExtStatus(ctx, "error");
      }
    },
  });

  pi.registerCommand("pinet-follow", {
    description: "Connect to an existing Pinet broker as a follower",
    handler: async (_args, ctx) => {
      if (deps.pinetRegistrationBlocked()) {
        ctx.ui.notify(deps.getPinetRegistrationBlockReason(), "warning");
        return;
      }
      if (deps.runtimeMode() === "follower") {
        ctx.ui.notify("Pinet already running (follower)", "info");
        return;
      }
      deps.setExtCtx(ctx);

      try {
        await deps.connectAsFollower(ctx);
        ctx.ui.notify(`${deps.agentEmoji()} ${deps.agentName()} — following broker`, "info");
      } catch (err) {
        ctx.ui.notify(`Pinet follow failed: ${errorMsg(err)}`, "error");
        deps.setExtStatus(ctx, "error");
      }
    },
  });

  pi.registerCommand("pinet-unfollow", {
    description: "Disconnect from the Pinet broker and keep working locally",
    handler: async (_args, ctx) => {
      if (deps.runtimeMode() !== "follower" || deps.brokerRole() == null) {
        ctx.ui.notify("Pinet is not running as a follower.", "info");
        return;
      }

      if (deps.brokerRole() !== "follower") {
        ctx.ui.notify(
          "Pinet is running as broker; /pinet-unfollow only applies to followers.",
          "warning",
        );
        return;
      }

      const { unregisterError } = await deps.disconnectFollower(ctx);
      if (unregisterError) {
        ctx.ui.notify(
          `Pinet follower disconnected locally, but broker deregistration failed: ${unregisterError}`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        `${deps.agentEmoji()} ${deps.agentName()} — disconnected from broker; local session still running`,
        "info",
      );
    },
  });

  pi.registerCommand("pinet-reload", {
    description: "Tell a connected Pinet agent to reload itself",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /pinet-reload <agent-name-or-id>", "warning");
        return;
      }

      try {
        const result = await deps.sendPinetAgentMessage(target, "/reload");
        ctx.ui.notify(`Sent /reload to ${result.target}`, "info");
      } catch (err) {
        ctx.ui.notify(`Pinet reload failed: ${errorMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("pinet-exit", {
    description: "Tell a connected Pinet agent to exit gracefully",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /pinet-exit <agent-name-or-id>", "warning");
        return;
      }

      try {
        const result = await deps.sendPinetAgentMessage(target, "/exit");
        ctx.ui.notify(`Sent /exit to ${result.target}`, "info");
      } catch (err) {
        ctx.ui.notify(`Pinet exit failed: ${errorMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("pinet-free", {
    description: "Mark this Pinet agent idle/free for new work",
    handler: async (_args, ctx) => {
      if (!deps.pinetEnabled()) {
        ctx.ui.notify(
          "Pinet mesh runtime is not active. Use /pinet-start or /pinet-follow.",
          "info",
        );
        return;
      }

      try {
        const result = await deps.signalAgentFree(ctx, { requirePinet: true });
        const suffix = result.drainedQueuedInbox
          ? ` Processing ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? "" : "s"} now.`
          : result.queuedInboxCount > 0
            ? ` ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? " remains" : "s remain"}.`
            : "";
        ctx.ui.notify(
          `Marked ${deps.agentEmoji()} ${deps.agentName()} idle/free for new work.${suffix}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Pinet free failed: ${errorMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("pinet-skin", {
    description: "Regenerate the mesh naming/personality skin from a theme",
    handler: async (args, ctx) => {
      if (!deps.pinetEnabled() || deps.brokerRole() == null) {
        ctx.ui.notify(
          "Pinet mesh runtime is not active. Use /pinet-start or /pinet-follow.",
          "info",
        );
        return;
      }
      if (deps.brokerRole() !== "broker") {
        ctx.ui.notify("/pinet-skin can only run on the active broker.", "warning");
        return;
      }

      try {
        const result = deps.applyMeshSkin(args);
        ctx.ui.notify(
          `Applied mesh skin "${result.theme}" to ${result.updatedAgents.length} agent${result.updatedAgents.length === 1 ? "" : "s"}.`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Pinet skin failed: ${errorMsg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("pinet-status", {
    description: "Show Pinet status",
    handler: async (_args, ctx) => {
      const mode = deps.runtimeMode();
      const ownedCount = [...deps.threads().values()].filter((t) =>
        agentOwnsThread(t.owner, deps.agentName(), deps.agentAliases(), deps.agentOwnerToken()),
      ).length;
      const users = deps.allowedUsers();
      const s = deps.settings();
      const allowlistInfo = describeSlackUserAccess(users, {
        allowAllWorkspaceUsers: resolveAllowAllWorkspaceUsers(
          s,
          process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
        ),
      });
      const defaultChInfo = s.defaultChannel
        ? `Default channel: ${s.defaultChannel}`
        : "Default channel: none";
      const activityLogInfo = s.logChannel
        ? `Activity log: ${s.logChannel} (${s.logLevel ?? "actions"})`
        : "Activity log: disabled";
      const lbm = deps.lastBrokerMaintenance();
      const brokerHealthInfo =
        mode === "broker" && lbm
          ? [
              `Pending backlog: ${lbm.pendingBacklogCount}`,
              `Last maintenance: assigned ${lbm.assignedBacklogCount}, reaped ${lbm.reapedAgentIds.length}, repaired ${lbm.repairedThreadClaims}`,
              ...(lbm.anomalies.length > 0 ? [`Health: ${lbm.anomalies.join("; ")}`] : []),
            ]
          : [];
      const brokerCanvasInfo =
        mode === "broker"
          ? [
              `Control plane canvas: ${
                deps.isBrokerControlPlaneCanvasEnabled()
                  ? (deps.getConfiguredBrokerControlPlaneCanvasId() ??
                    `pending (${deps.getConfiguredBrokerControlPlaneCanvasChannel() ?? "no target"})`)
                  : "disabled"
              }`,
              ...(deps.lastBrokerControlPlaneCanvasRefreshAt()
                ? [`Canvas refreshed: ${deps.lastBrokerControlPlaneCanvasRefreshAt()}`]
                : []),
              ...(deps.lastBrokerControlPlaneCanvasError()
                ? [`Canvas status: ${deps.lastBrokerControlPlaneCanvasError()}`]
                : []),
              `Home tab viewers: ${deps.getBrokerControlPlaneHomeTabViewerIds().length}`,
              ...(deps.lastBrokerControlPlaneHomeTabRefreshAt()
                ? [`Home tab refreshed: ${deps.lastBrokerControlPlaneHomeTabRefreshAt()}`]
                : []),
              ...(deps.lastBrokerControlPlaneHomeTabError()
                ? [`Home tab status: ${deps.lastBrokerControlPlaneHomeTabError()}`]
                : []),
            ]
          : [];
      ctx.ui.notify(
        [
          `Mode: ${mode}`,
          `Agent: ${deps.agentEmoji()} ${deps.agentName()}`,
          `Bot: ${deps.botUserId() ?? "unknown"}`,
          `Connection: ${deps.runtimeConnected() ? "connected" : "disconnected"}`,
          `Skin: ${deps.activeSkinTheme() ?? "(legacy/manual)"}`,
          ...(deps.agentPersonality() ? [`Persona: ${deps.agentPersonality()}`] : []),
          `Threads: ${deps.threads().size} (${ownedCount} owned by ${deps.agentName()})`,
          `DM channel: ${deps.lastDmChannel() ?? "none yet"}`,
          allowlistInfo,
          defaultChInfo,
          activityLogInfo,
          ...brokerHealthInfo,
          ...brokerCanvasInfo,
        ].join("\n"),
        "info",
      );
    },
  });

  const showActivityLogs = async (_args: string, ctx: ExtensionContext) => {
    const s = deps.settings();
    const channelInfo = s.logChannel ? `${s.logChannel} (${s.logLevel ?? "actions"})` : "disabled";
    ctx.ui.notify(
      [
        `Activity log channel: ${channelInfo}`,
        formatRecentActivityLogEntries(deps.recentActivityLogEntries(10)),
      ].join("\n\n"),
      s.logChannel ? "info" : "warning",
    );
  };

  pi.registerCommand("pinet-logs", {
    description: "Show recent broker activity log entries",
    handler: showActivityLogs,
  });

  pi.registerCommand("slack-logs", {
    description: "Show recent broker activity log entries",
    handler: showActivityLogs,
  });

  pi.registerCommand("pinet-rename", {
    description: "Rename this Pinet agent",
    handler: async (args, ctx) => {
      const newName = args.trim();
      if (!newName) {
        const fresh = generateAgentName(
          undefined,
          deps.runtimeMode() === "broker" ? "broker" : "worker",
        );
        deps.applyLocalAgentIdentity(fresh.name, fresh.emoji, deps.agentPersonality());
      } else {
        deps.applyLocalAgentIdentity(newName, deps.agentEmoji(), deps.agentPersonality());
      }
      ctx.ui.notify(`${deps.agentEmoji()} Agent renamed to: ${deps.agentName()}`, "info");
    },
  });
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
