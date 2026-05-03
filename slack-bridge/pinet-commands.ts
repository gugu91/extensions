import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  generateAgentName,
  agentOwnsThread,
  describeSlackUserAccess,
  formatFollowerRuntimeDiagnosticHealth,
  formatFollowerRuntimeDiagnosticNextStep,
  resolveAllowAllWorkspaceUsers,
  type FollowerRuntimeDiagnostic,
  type SlackBridgeSettings,
} from "./helpers.js";
import { formatRecentActivityLogEntries, type LoggedActivityLogEntry } from "./activity-log.js";
import { formatRuntimeGuardrailsPosture } from "./guardrails.js";
import type { PinetRuntimeControlContext } from "./pinet-remote-control.js";
import {
  formatSlackScopeDiagnosticsStatus,
  type SlackScopeDiagnostics,
} from "./slack-scope-diagnostics.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

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
  followerRuntimeDiagnostic: () => FollowerRuntimeDiagnostic | null;
  threads: () => Map<string, { owner?: string }>;
  allowedUsers: () => Set<string> | null;
  inboxLength: () => number;
  recentActivityLogEntries: (limit: number) => ReadonlyArray<LoggedActivityLogEntry>;
  slackScopeDiagnostics: () => SlackScopeDiagnostics;
  settings: () => SlackBridgeSettings;
  lastBrokerMaintenance: () => {
    pendingBacklogCount: number;
    assignedBacklogCount: number;
    reapedAgentIds: string[];
    repairedThreadClaims: number;
    anomalies: string[];
  } | null;
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
  applyLocalAgentIdentity: (name: string, emoji: string, personality: string | null) => void;
  setExtStatus: (ctx: ExtensionContext, state: "ok" | "reconnecting" | "error" | "off") => void;
  setExtCtx: (ctx: ExtensionContext) => void;
}

export type PinetCommandAction =
  | "start"
  | "follow"
  | "unfollow"
  | "reload"
  | "exit"
  | "free"
  | "status"
  | "logs"
  | "rename";

interface ParsedPinetCommandAction {
  action: PinetCommandAction;
  args: string;
}

const PINET_PRIMARY_COMMANDS: Array<{
  action: PinetCommandAction;
  args: string;
  description: string;
}> = [
  { action: "start", args: "", description: "Start as the mesh broker" },
  { action: "follow", args: "", description: "Connect as a follower worker" },
  { action: "unfollow", args: "", description: "Disconnect from the broker" },
  { action: "reload", args: "<agent>", description: "Ask another agent to reload" },
  { action: "exit", args: "<agent>", description: "Ask another agent to exit" },
  { action: "free", args: "", description: "Mark this agent as idle" },
];

const PINET_SECONDARY_COMMANDS: Array<{
  action: PinetCommandAction;
  args: string;
  description: string;
}> = [
  { action: "status", args: "", description: "Show Pinet status" },
  { action: "logs", args: "", description: "Show recent broker activity logs" },
  { action: "rename", args: "[name]", description: "Rename this Pinet agent" },
];

const PINET_LEGACY_COMMANDS: Array<{
  name: string;
  action: PinetCommandAction;
  description: string;
}> = [
  {
    name: "pinet-start",
    action: "start",
    description:
      "Start Pinet as the broker (Slack connection + message routing, or reload the active broker)",
  },
  {
    name: "pinet-follow",
    action: "follow",
    description: "Connect to an existing Pinet broker as a follower",
  },
  {
    name: "pinet-unfollow",
    action: "unfollow",
    description: "Disconnect from the Pinet broker and keep working locally",
  },
  {
    name: "pinet-reload",
    action: "reload",
    description: "Tell a connected Pinet agent to reload itself",
  },
  {
    name: "pinet-exit",
    action: "exit",
    description: "Tell a connected Pinet agent to exit gracefully",
  },
  {
    name: "pinet-free",
    action: "free",
    description: "Mark this Pinet agent idle/free for new work",
  },
  { name: "pinet-status", action: "status", description: "Show Pinet status" },
  { name: "pinet-logs", action: "logs", description: "Show recent broker activity log entries" },
  { name: "slack-logs", action: "logs", description: "Show recent broker activity log entries" },
  { name: "pinet-rename", action: "rename", description: "Rename this Pinet agent" },
];

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

export function formatPinetCommandHelp(): string {
  const lines = [
    "Usage: /pinet <action> [args]",
    "",
    "Primary actions:",
    ...PINET_PRIMARY_COMMANDS.map((command) =>
      formatPinetCommandHelpLine(command.action, command.args, command.description),
    ),
    "",
    "Other actions:",
    ...PINET_SECONDARY_COMMANDS.map((command) =>
      formatPinetCommandHelpLine(command.action, command.args, command.description),
    ),
    "",
    "Legacy aliases such as /pinet-start, /pinet-follow, and /pinet-free remain supported.",
  ];

  return lines.join("\n");
}

function formatPinetCommandHelpLine(
  action: PinetCommandAction,
  args: string,
  description: string,
): string {
  const command = args ? `/pinet ${action} ${args}` : `/pinet ${action}`;
  return `• ${command} — ${description}`;
}

function parsePinetCommandAction(args: string): ParsedPinetCommandAction | null {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "?" || trimmed === "-h" || trimmed === "--help") {
    return null;
  }

  const [rawAction = "", ...rest] = trimmed.split(/\s+/);
  const action = normalizePinetCommandAction(rawAction);
  if (!action) {
    return null;
  }

  return {
    action,
    args: rest.join(" ").trim(),
  };
}

function normalizePinetCommandAction(rawAction: string): PinetCommandAction | null {
  const normalized = rawAction
    .trim()
    .replace(/^\//, "")
    .replace(/^pinet[:-]/, "")
    .toLowerCase();

  switch (normalized) {
    case "start":
    case "broker":
      return "start";
    case "follow":
    case "worker":
      return "follow";
    case "unfollow":
    case "disconnect":
      return "unfollow";
    case "reload":
      return "reload";
    case "exit":
      return "exit";
    case "free":
    case "idle":
      return "free";
    case "status":
      return "status";
    case "logs":
    case "log":
      return "logs";
    case "rename":
      return "rename";
    case "help":
      return null;
    default:
      return null;
  }
}

export async function runPinetCommandAction(
  deps: PinetCommandsDeps,
  action: PinetCommandAction,
  args: string,
  ctx: ExtensionContext,
  usageCommand = `/pinet ${action}`,
): Promise<void> {
  switch (action) {
    case "start":
      await runPinetStart(deps, ctx);
      return;
    case "follow":
      await runPinetFollow(deps, ctx);
      return;
    case "unfollow":
      await runPinetUnfollow(deps, ctx);
      return;
    case "reload":
      await runPinetReload(deps, args, ctx, usageCommand);
      return;
    case "exit":
      await runPinetExit(deps, args, ctx, usageCommand);
      return;
    case "free":
      await runPinetFree(deps, ctx);
      return;
    case "status":
      runPinetStatus(deps, ctx);
      return;
    case "logs":
      runPinetLogs(deps, ctx);
      return;
    case "rename":
      runPinetRename(deps, args, ctx);
      return;
  }
}

export function registerPinetCommands(pi: ExtensionAPI, deps: PinetCommandsDeps): void {
  pi.registerCommand("pinet", {
    description:
      "Unified Pinet command surface: start, follow, unfollow, reload, exit, free, status, logs, rename",
    handler: async (args, ctx) => {
      const parsed = parsePinetCommandAction(args);
      if (!parsed) {
        const trimmed = args.trim();
        const tone =
          trimmed && !["help", "?", "-h", "--help"].includes(trimmed.toLowerCase())
            ? "warning"
            : "info";
        const prefix = tone === "warning" ? `Unknown Pinet action: ${trimmed}\n\n` : "";
        ctx.ui.notify(`${prefix}${formatPinetCommandHelp()}`, tone);
        return;
      }

      await runPinetCommandAction(deps, parsed.action, parsed.args, ctx);
    },
  });

  for (const command of PINET_LEGACY_COMMANDS) {
    pi.registerCommand(command.name, {
      description: `${command.description} (alias for /pinet ${command.action})`,
      handler: async (args, ctx) => {
        await runPinetCommandAction(deps, command.action, args, ctx, `/${command.name}`);
      },
    });
  }
}

async function runPinetStart(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
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
}

async function runPinetFollow(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
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
}

async function runPinetUnfollow(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
  if (deps.runtimeMode() !== "follower" || deps.brokerRole() == null) {
    ctx.ui.notify("Pinet is not running as a follower.", "info");
    return;
  }

  if (deps.brokerRole() !== "follower") {
    ctx.ui.notify(
      "Pinet is running as broker; /pinet unfollow only applies to followers.",
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
}

async function runPinetReload(
  deps: PinetCommandsDeps,
  args: string,
  ctx: ExtensionContext,
  usageCommand: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify(`Usage: ${usageCommand} <agent-name-or-id>`, "warning");
    return;
  }

  try {
    const result = await deps.sendPinetAgentMessage(target, "/reload");
    ctx.ui.notify(`Sent /reload to ${result.target}`, "info");
  } catch (err) {
    ctx.ui.notify(`Pinet reload failed: ${errorMsg(err)}`, "error");
  }
}

async function runPinetExit(
  deps: PinetCommandsDeps,
  args: string,
  ctx: ExtensionContext,
  usageCommand: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify(`Usage: ${usageCommand} <agent-name-or-id>`, "warning");
    return;
  }

  try {
    const result = await deps.sendPinetAgentMessage(target, "/exit");
    ctx.ui.notify(`Sent /exit to ${result.target}`, "info");
  } catch (err) {
    ctx.ui.notify(`Pinet exit failed: ${errorMsg(err)}`, "error");
  }
}

async function runPinetFree(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
  if (!deps.pinetEnabled()) {
    ctx.ui.notify("Pinet mesh runtime is not active. Use /pinet start or /pinet follow.", "info");
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
}

function runPinetStatus(deps: PinetCommandsDeps, ctx: ExtensionContext): void {
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
  const guardrailsInfo = `Guardrails: ${formatRuntimeGuardrailsPosture(s.security ?? {})}`;
  const runtimeDiagnostic = deps.followerRuntimeDiagnostic();
  const runtimeHealthInfo = `Runtime health: ${formatFollowerRuntimeDiagnosticHealth(runtimeDiagnostic)}`;
  const runtimeNextStepInfo = `Next step: ${formatFollowerRuntimeDiagnosticNextStep(runtimeDiagnostic)}`;
  const slackToolHealthInfo = `Slack tool health: ${formatSlackScopeDiagnosticsStatus(deps.slackScopeDiagnostics())}`;
  const lbm = deps.lastBrokerMaintenance();
  const brokerHealthInfo =
    mode === "broker" && lbm
      ? [
          `Pending backlog: ${lbm.pendingBacklogCount}`,
          `Last maintenance: assigned ${lbm.assignedBacklogCount}, reaped ${lbm.reapedAgentIds.length}, repaired ${lbm.repairedThreadClaims}`,
          ...(lbm.anomalies.length > 0 ? [`Health: ${lbm.anomalies.join("; ")}`] : []),
        ]
      : [];
  const brokerHomeTabInfo =
    mode === "broker"
      ? [
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
      runtimeHealthInfo,
      runtimeNextStepInfo,
      `Skin: ${deps.activeSkinTheme() ?? "(legacy/manual)"}`,
      ...(deps.agentPersonality() ? [`Persona: ${deps.agentPersonality()}`] : []),
      `Threads: ${deps.threads().size} (${ownedCount} owned by ${deps.agentName()})`,
      `DM channel: ${deps.lastDmChannel() ?? "none yet"}`,
      allowlistInfo,
      guardrailsInfo,
      defaultChInfo,
      activityLogInfo,
      slackToolHealthInfo,
      ...brokerHealthInfo,
      ...brokerHomeTabInfo,
    ].join("\n"),
    "info",
  );
}

function runPinetLogs(deps: PinetCommandsDeps, ctx: ExtensionContext): void {
  const s = deps.settings();
  const channelInfo = s.logChannel ? `${s.logChannel} (${s.logLevel ?? "actions"})` : "disabled";
  ctx.ui.notify(
    [
      `Activity log channel: ${channelInfo}`,
      formatRecentActivityLogEntries(deps.recentActivityLogEntries(10)),
    ].join("\n\n"),
    s.logChannel ? "info" : "warning",
  );
}

function runPinetRename(deps: PinetCommandsDeps, args: string, ctx: ExtensionContext): void {
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
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
