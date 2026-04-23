import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type InboxMessage,
  type PinetControlCommand,
  type PinetRemoteControlRequestResult,
  type PinetSkinUpdate,
  type SlackBridgeSettings,
  buildPinetOwnerToken,
  buildPinetSkinAssignment,
  DEFAULT_PINET_SKIN_THEME,
  resolvePinetMeshAuth,
  resolveSlackDefaultScope,
  syncBrokerInboxEntries,
} from "./helpers.js";
import { startBroker, type Broker } from "./broker/index.js";
import type { BrokerDB } from "./broker/schema.js";
import { SlackAdapter } from "./broker/adapters/slack.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { MessageRouter } from "./broker/router.js";
import {
  DEFAULT_BROKER_MAINTENANCE_INTERVAL_MS,
  DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
  runBrokerMaintenancePass,
  type BrokerMaintenanceResult,
} from "./broker/maintenance.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import {
  type BrokerDeliveryState,
  isBrokerInboxIdTracked,
  markBrokerInboxIdsHandled,
  queueBrokerInboxIds,
  resetBrokerDeliveryState,
} from "./broker-delivery.js";
import type { InboundMessage } from "./broker/types.js";
import {
  type ActivityLogEntry,
  type ActivityLogTone,
  type LoggedActivityLogEntry,
  type SlackActivityLogger,
} from "./activity-log.js";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-canvas.js";
import {
  type RalphLoopDeps,
  createRalphLoopState,
  startRalphLoop,
  stopRalphLoop,
} from "./ralph-loop.js";
import { TtlCache } from "./ttl-cache.js";

export interface BrokerRuntimeConnectResult {
  botUserId: string | null;
  recoveredBrokerMessages: number;
  recoveredTargetedBacklogCount: number;
  releasedBrokerClaims: number;
}

export interface BrokerRuntimeDeps {
  getSettings: () => SlackBridgeSettings;
  getBotToken: () => string;
  getAppToken: () => string;
  getAllowedUsers: () => Set<string> | null;
  shouldAllowAllWorkspaceUsers: () => boolean;
  getBrokerStableId: () => string;
  setBrokerStableId: (stableId: string) => void;
  getActiveSkinTheme: () => string | null;
  setActiveSkinTheme: (theme: string) => void;
  setAgentOwnerToken: (ownerToken: string) => void;
  getAgentMetadata: (role: "broker" | "worker") => Promise<Record<string, unknown>>;
  applyLocalAgentIdentity: (name: string, emoji: string, personality: string | null) => void;
  buildSkinMetadata: (
    metadata: Record<string, unknown> | undefined,
    personality: string,
  ) => Record<string, unknown>;
  getMeshRoleFromMetadata: (
    metadata: Record<string, unknown> | undefined,
    fallback?: "broker" | "worker",
  ) => "broker" | "worker";
  handleInboundMessage: (input: {
    message: InboundMessage;
    broker: Broker;
    router: MessageRouter;
    selfId: string;
    ctx: ExtensionContext;
  }) => Promise<void> | void;
  onAppHomeOpened: (userId: string, ctx: ExtensionContext) => Promise<void> | void;
  pushInboxMessages: (messages: InboxMessage[]) => void;
  updateBadge: () => void;
  maybeDrainInboxIfIdle: (ctx: ExtensionContext) => boolean;
  requestRemoteControl: (
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ) => PinetRemoteControlRequestResult;
  deferControlAck: (command: PinetControlCommand, inboxId: number) => void;
  runRemoteControl: (command: PinetControlCommand, ctx: ExtensionContext) => void;
  applySkinUpdate: (update: PinetSkinUpdate) => void;
  formatError: (error: unknown) => string;
  deliveryState: BrokerDeliveryState;
  onMaintenanceResult: (
    ctx: ExtensionContext,
    input: {
      result: BrokerMaintenanceResult;
      previousSignature: string;
      signature: string;
    },
  ) => void;
  onMaintenanceError: (ctx: ExtensionContext, error: unknown) => void;
  onScheduledWakeupError: (ctx: ExtensionContext, error: unknown) => void;
  onAgentStatusChange: (
    ctx: ExtensionContext,
    changedAgentId: string,
    status: "working" | "idle",
  ) => void;
  createActivityLogger: (onError: (error: unknown) => void) => SlackActivityLogger;
  formatTrackedAgent: (agentId: string) => string;
  summarizeTrackedAssignmentStatus: (
    status: "assigned" | "branch_pushed" | "pr_open" | "pr_merged" | "pr_closed",
    prNumber: number | null,
    branch: string | null,
  ) => { summary: string; tone: ActivityLogTone };
  sendMaintenanceMessage: (targetAgentId: string, body: string) => void;
  trySendFollowUp: (body: string, onDelivered: () => void) => void;
  refreshCanvasDashboard: (ctx: ExtensionContext, input: Record<string, unknown>) => Promise<void>;
  refreshHomeTabs: (
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
    userIds?: string[],
  ) => Promise<void>;
  buildControlPlaneDashboardSnapshot: (
    input: Record<string, unknown>,
  ) => BrokerControlPlaneDashboardSnapshot;
  buildCurrentDashboardSnapshot: (
    openedAt?: string,
  ) => Promise<BrokerControlPlaneDashboardSnapshot | null>;
}

export interface BrokerRuntime {
  connect: (ctx: ExtensionContext) => Promise<BrokerRuntimeConnectResult>;
  disconnect: (options?: { releaseIdentity?: boolean }) => Promise<void>;
  claimThread: (threadTs: string, channelId: string, source?: string) => void;
  runMaintenance: (ctx: ExtensionContext) => void;
  markDelivered: (inboxIds: number[]) => void;
  startObservability: (ctx: ExtensionContext) => void;
  clearFollowUpPending: () => void;
  logActivity: (entry: ActivityLogEntry) => void;
  getRecentActivityEntries: (limit?: number) => ReadonlyArray<LoggedActivityLogEntry>;
  getBroker: () => Broker | null;
  getSelfId: () => string | null;
  getLastMaintenance: () => BrokerMaintenanceResult | null;
  heartbeatTimerActive: () => boolean;
  maintenanceTimerActive: () => boolean;
  isConnected: () => boolean;
  isBrokerControlPlaneCanvasEnabled: () => boolean;
  getConfiguredBrokerControlPlaneCanvasId: () => string | null;
  getConfiguredBrokerControlPlaneCanvasChannel: () => string | null;
  getControlPlaneCanvasRuntimeId: () => string | null;
  getControlPlaneCanvasRuntimeChannelId: () => string | null;
  restoreControlPlaneCanvasRuntimeState: (input: {
    canvasId: string | null;
    channelId: string | null;
  }) => void;
  getLastControlPlaneCanvasRefreshAt: () => string | null;
  setLastControlPlaneCanvasRefreshAt: (value: string | null) => void;
  getLastControlPlaneCanvasError: () => string | null;
  setLastControlPlaneCanvasError: (value: string | null) => void;
  getHomeTabViewerIds: () => string[];
  getLastHomeTabSnapshot: () => BrokerControlPlaneDashboardSnapshot | null;
  setLastHomeTabSnapshot: (snapshot: BrokerControlPlaneDashboardSnapshot | null) => void;
  getLastHomeTabRefreshAt: () => string | null;
  setLastHomeTabRefreshAt: (value: string | null) => void;
  getLastHomeTabError: () => string | null;
  setLastHomeTabError: (value: string | null) => void;
  publishCurrentHomeTabSafely: (
    userId: string,
    ctx: ExtensionContext,
    openedAt?: string,
  ) => Promise<boolean>;
}

function normalizeOptionalSetting(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function createBrokerRuntime(deps: BrokerRuntimeDeps): BrokerRuntime {
  let activeBroker: Broker | null = null;
  let activeRouter: MessageRouter | null = null;
  let activeSelfId: string | null = null;
  let brokerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let brokerMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let brokerScheduledWakeupTimer: ReturnType<typeof setInterval> | null = null;
  let brokerMaintenanceRunning = false;
  let brokerScheduledWakeupRunning = false;
  let lastBrokerMaintenance: BrokerMaintenanceResult | null = null;
  let lastBrokerMaintenanceSignature = "";
  let activityLogger: SlackActivityLogger | null = null;
  let activityLogContext: ExtensionContext | null = null;
  let lastActivityLogFailureAt = 0;
  let brokerControlPlaneCanvasRuntimeId: string | null = null;
  let brokerControlPlaneCanvasRuntimeChannelId: string | null = null;
  let lastBrokerControlPlaneCanvasRefreshAt: string | null = null;
  let lastBrokerControlPlaneCanvasError: string | null = null;
  const brokerControlPlaneHomeTabViewers = new TtlCache<string, { openedAt: string }>({
    maxSize: 100,
    ttlMs: 12 * 60 * 60 * 1000,
  });
  let lastBrokerControlPlaneHomeTabSnapshot: BrokerControlPlaneDashboardSnapshot | null = null;
  let lastBrokerControlPlaneHomeTabRefreshAt: string | null = null;
  let lastBrokerControlPlaneHomeTabError: string | null = null;
  const ralphLoopState = createRalphLoopState();

  function isBrokerControlPlaneCanvasEnabled(): boolean {
    return deps.getSettings().controlPlaneCanvasEnabled ?? true;
  }

  function getExplicitBrokerControlPlaneCanvasId(): string | null {
    return normalizeOptionalSetting(deps.getSettings().controlPlaneCanvasId);
  }

  function getConfiguredBrokerControlPlaneCanvasId(): string | null {
    return getExplicitBrokerControlPlaneCanvasId() ?? brokerControlPlaneCanvasRuntimeId;
  }

  function getConfiguredBrokerControlPlaneCanvasChannel(): string | null {
    return (
      normalizeOptionalSetting(deps.getSettings().controlPlaneCanvasChannel) ??
      normalizeOptionalSetting(deps.getSettings().defaultChannel)
    );
  }

  function ensureActivityLogger(): SlackActivityLogger {
    if (activityLogger) {
      return activityLogger;
    }

    activityLogger = deps.createActivityLogger((error) => {
      const formatted = deps.formatError(error);
      console.error(`[slack-bridge] activity log failed: ${formatted}`);
      const now = Date.now();
      if (!activityLogContext?.hasUI || now - lastActivityLogFailureAt < 60_000) {
        return;
      }
      lastActivityLogFailureAt = now;
      activityLogContext.ui.notify(`Pinet activity log failed: ${formatted}`, "warning");
    });
    return activityLogger;
  }

  function stopBrokerHeartbeat(): void {
    if (!brokerHeartbeatTimer) return;
    clearInterval(brokerHeartbeatTimer);
    brokerHeartbeatTimer = null;
  }

  function startBrokerHeartbeat(): void {
    stopBrokerHeartbeat();
    if (!activeBroker || !activeSelfId) return;
    const broker = activeBroker;
    const selfId = activeSelfId;
    brokerHeartbeatTimer = setInterval(() => {
      try {
        broker.db.heartbeatAgent(selfId);
      } catch {
        /* best effort */
      }
    }, HEARTBEAT_INTERVAL_MS);
    brokerHeartbeatTimer.unref?.();
  }

  function stopBrokerMaintenance(): void {
    if (!brokerMaintenanceTimer) return;
    clearInterval(brokerMaintenanceTimer);
    brokerMaintenanceTimer = null;
  }

  function syncBrokerDbInbox(agentId: string, db: BrokerDB, ctx: ExtensionContext): void {
    db.recoverPendingTargetedBacklog(agentId);

    const pending = db
      .getInbox(agentId)
      .filter((item) => !isBrokerInboxIdTracked(deps.deliveryState, item.entry.id));
    if (pending.length === 0) {
      return;
    }

    const synced = syncBrokerInboxEntries(
      pending.map((item) => ({
        inboxId: item.entry.id,
        message: {
          threadId: item.message.threadId,
          sender:
            typeof item.message.metadata?.senderAgent === "string"
              ? item.message.metadata.senderAgent
              : item.message.sender,
          body: item.message.body,
          createdAt: item.message.createdAt,
          metadata: item.message.metadata,
        },
      })),
    );

    const handledInboxIds = new Set<number>();
    const commandsToStart: PinetControlCommand[] = [];
    for (const entry of synced.controlEntries) {
      try {
        const queued = deps.requestRemoteControl(entry.command, ctx);
        if (queued.ackDisposition === "immediate") {
          handledInboxIds.add(entry.inboxId);
        } else {
          deps.deferControlAck(queued.scheduledCommand, entry.inboxId);
        }
        if (queued.shouldStartNow) {
          commandsToStart.push(entry.command);
        }
      } catch (error) {
        ctx.ui.notify(`Pinet remote control failed: ${deps.formatError(error)}`, "error");
      }
    }

    for (const entry of synced.skinEntries) {
      deps.applySkinUpdate(entry.update);
      handledInboxIds.add(entry.inboxId);
    }

    if (handledInboxIds.size > 0) {
      db.markDelivered([...handledInboxIds], agentId);
    }

    for (const command of commandsToStart) {
      deps.runRemoteControl(command, ctx);
    }

    if (synced.inboxMessages.length === 0) {
      return;
    }

    queueBrokerInboxIds(
      deps.deliveryState,
      synced.inboxMessages.flatMap((message) =>
        message.brokerInboxId != null ? [message.brokerInboxId] : [],
      ),
    );

    deps.pushInboxMessages(synced.inboxMessages);
    deps.updateBadge();
    deps.maybeDrainInboxIfIdle(ctx);
  }

  function runMaintenance(ctx: ExtensionContext): void {
    if (!activeBroker || !activeSelfId || brokerMaintenanceRunning) return;

    brokerMaintenanceRunning = true;
    try {
      const result = runBrokerMaintenancePass(activeBroker.db, {
        brokerAgentId: activeSelfId,
        staleAfterMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
        busyAssignmentAgeMs: DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
      });
      syncBrokerDbInbox(activeSelfId, activeBroker.db as BrokerDB, ctx);
      lastBrokerMaintenance = result;

      const previousSignature = lastBrokerMaintenanceSignature;
      const signature = result.anomalies.join("|");
      deps.onMaintenanceResult(ctx, { result, previousSignature, signature });
      lastBrokerMaintenanceSignature = signature;
    } catch (error) {
      deps.onMaintenanceError(ctx, error);
    } finally {
      brokerMaintenanceRunning = false;
    }
  }

  function startBrokerMaintenance(ctx: ExtensionContext): void {
    stopBrokerMaintenance();
    brokerMaintenanceTimer = setInterval(() => {
      runMaintenance(ctx);
    }, DEFAULT_BROKER_MAINTENANCE_INTERVAL_MS);
    brokerMaintenanceTimer.unref?.();
    runMaintenance(ctx);
  }

  function runBrokerScheduledWakeups(ctx: ExtensionContext): void {
    if (!activeBroker || brokerScheduledWakeupRunning) return;

    brokerScheduledWakeupRunning = true;
    try {
      const deliveries = (activeBroker.db as BrokerDB).deliverDueScheduledWakeups();
      if (deliveries.length > 0 && activeSelfId) {
        syncBrokerDbInbox(activeSelfId, activeBroker.db as BrokerDB, ctx);
      }
    } catch (error) {
      deps.onScheduledWakeupError(ctx, error);
    } finally {
      brokerScheduledWakeupRunning = false;
    }
  }

  function stopBrokerScheduledWakeups(): void {
    brokerScheduledWakeupRunning = false;
    if (!brokerScheduledWakeupTimer) return;
    clearInterval(brokerScheduledWakeupTimer);
    brokerScheduledWakeupTimer = null;
  }

  function startBrokerScheduledWakeups(ctx: ExtensionContext): void {
    stopBrokerScheduledWakeups();
    brokerScheduledWakeupTimer = setInterval(() => {
      runBrokerScheduledWakeups(ctx);
    }, 1000);
    brokerScheduledWakeupTimer.unref?.();
    runBrokerScheduledWakeups(ctx);
  }

  function getRalphLoopDeps(): RalphLoopDeps {
    return {
      getBrokerDb: () => (activeBroker?.db as BrokerDB | undefined) ?? null,
      getBrokerAgentId: () => activeSelfId,
      heartbeatTimerActive: () => brokerHeartbeatTimer != null,
      maintenanceTimerActive: () => brokerMaintenanceTimer != null,
      runMaintenance: (ctx) => runMaintenance(ctx),
      sendMaintenanceMessage: (targetAgentId, body) =>
        deps.sendMaintenanceMessage(targetAgentId, body),
      trySendFollowUp: (body, onDelivered) => deps.trySendFollowUp(body, onDelivered),
      logActivity: (entry) => {
        if (!activeBroker) {
          return;
        }
        ensureActivityLogger().log(entry);
      },
      formatTrackedAgent: (agentId) => deps.formatTrackedAgent(agentId),
      summarizeTrackedAssignmentStatus: (status, prNumber, branch) =>
        deps.summarizeTrackedAssignmentStatus(
          status as Parameters<typeof deps.summarizeTrackedAssignmentStatus>[0],
          prNumber,
          branch,
        ),
      refreshCanvasDashboard: (ctx, input) => deps.refreshCanvasDashboard(ctx, input),
      refreshHomeTabs: (ctx, snapshot, refreshedAt) =>
        deps.refreshHomeTabs(ctx, snapshot, refreshedAt),
      getLastMaintenance: () => lastBrokerMaintenance,
      buildControlPlaneDashboardSnapshot: (input) => deps.buildControlPlaneDashboardSnapshot(input),
      setLastHomeTabSnapshot: (snapshot) => {
        lastBrokerControlPlaneHomeTabSnapshot = snapshot;
      },
      getLastCanvasError: () => lastBrokerControlPlaneCanvasError,
      setLastCanvasError: (error) => {
        lastBrokerControlPlaneCanvasError = error;
      },
      getLastHomeTabError: () => lastBrokerControlPlaneHomeTabError,
      setLastHomeTabError: (error) => {
        lastBrokerControlPlaneHomeTabError = error;
      },
    };
  }

  function startObservability(ctx: ExtensionContext): void {
    if (!activeBroker) {
      return;
    }
    activityLogContext = ctx;
    startRalphLoop(ctx, ralphLoopState, getRalphLoopDeps());
  }

  function stopObservability(): void {
    stopRalphLoop(ralphLoopState);
    lastBrokerControlPlaneCanvasRefreshAt = null;
    lastBrokerControlPlaneCanvasError = null;
    brokerControlPlaneHomeTabViewers.clear();
    lastBrokerControlPlaneHomeTabSnapshot = null;
    lastBrokerControlPlaneHomeTabRefreshAt = null;
    lastBrokerControlPlaneHomeTabError = null;
    activityLogger?.clearPending();
    activityLogContext = null;
  }

  async function publishCurrentHomeTabSafely(
    userId: string,
    ctx: ExtensionContext,
    openedAt: string = new Date().toISOString(),
  ): Promise<boolean> {
    if (!activeBroker) {
      return false;
    }

    activityLogContext = ctx;
    brokerControlPlaneHomeTabViewers.set(userId, { openedAt });

    try {
      const snapshot =
        (await deps.buildCurrentDashboardSnapshot(openedAt)) ??
        lastBrokerControlPlaneHomeTabSnapshot;
      if (!snapshot) {
        return false;
      }
      await deps.refreshHomeTabs(ctx, snapshot, openedAt, [userId]);
      return true;
    } catch (error) {
      const homeTabMessage = `Pinet Home tab publish failed: ${deps.formatError(error)}`;
      if (homeTabMessage !== lastBrokerControlPlaneHomeTabError) {
        ctx.ui.notify(homeTabMessage, "warning");
      }
      lastBrokerControlPlaneHomeTabError = homeTabMessage;
      return false;
    }
  }

  async function disconnect(options: { releaseIdentity?: boolean } = {}): Promise<void> {
    stopObservability();
    stopBrokerHeartbeat();
    stopBrokerMaintenance();
    stopBrokerScheduledWakeups();
    brokerMaintenanceRunning = false;
    brokerScheduledWakeupRunning = false;

    if (activeBroker) {
      try {
        if (options.releaseIdentity && activeSelfId) {
          activeBroker.db.unregisterAgent(activeSelfId);
        }
        await activeBroker.stop();
      } catch {
        /* best effort */
      }
    }

    activeBroker = null;
    activeRouter = null;
    activeSelfId = null;
    lastBrokerMaintenance = null;
    lastBrokerMaintenanceSignature = "";
    resetBrokerDeliveryState(deps.deliveryState);
  }

  return {
    async connect(ctx: ExtensionContext): Promise<BrokerRuntimeConnectResult> {
      const settings = deps.getSettings();
      const meshAuth = resolvePinetMeshAuth(settings);
      const allowedUsers = deps.getAllowedUsers();
      const broker = await startBroker({
        ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
        ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
      });
      const adapter = new SlackAdapter({
        botToken: deps.getBotToken(),
        appToken: deps.getAppToken(),
        allowedUsers: allowedUsers ? [...allowedUsers] : undefined,
        allowAllWorkspaceUsers: deps.shouldAllowAllWorkspaceUsers(),
        suggestedPrompts: settings.suggestedPrompts,
        reactionCommands: settings.reactionCommands,
        getDefaultScope: () => resolveSlackDefaultScope(deps.getSettings(), process.env),
        isKnownThread: (threadTs: string) => broker.db.getThread(threadTs) != null,
        rememberKnownThread: (threadTs: string, channelId: string) => {
          broker.db.updateThread(threadTs, { source: "slack", channel: channelId });
        },
        onAppHomeOpened: async ({ userId }) => {
          await deps.onAppHomeOpened(userId, ctx);
        },
      });
      let selfId: string | null = null;
      activityLogContext = ctx;

      try {
        broker.db.setAllowedUsers(allowedUsers);
        const router = new MessageRouter(broker.db);
        const persistedBrokerStableId =
          normalizeOptionalSetting(broker.db.getSetting<string>("pinet.brokerStableId")) ??
          broker.db
            .getAllAgents()
            .flatMap((agent) => {
              const stableId = normalizeOptionalSetting(agent.stableId);
              if (!stableId) {
                return [];
              }
              if (
                deps.getMeshRoleFromMetadata(agent.metadata ?? undefined, "worker") !== "broker"
              ) {
                return [];
              }
              const lastSeenMs = Date.parse(agent.lastSeen);
              const connectedAtMs = Date.parse(agent.connectedAt);
              const recencyMs = Number.isNaN(lastSeenMs)
                ? Number.isNaN(connectedAtMs)
                  ? 0
                  : connectedAtMs
                : lastSeenMs;
              return [{ stableId, recencyMs }];
            })
            .sort((left, right) => right.recencyMs - left.recencyMs)[0]?.stableId ??
          null;
        const brokerStableId = persistedBrokerStableId ?? deps.getBrokerStableId();
        deps.setBrokerStableId(brokerStableId);
        broker.db.setSetting("pinet.brokerStableId", brokerStableId);
        deps.setAgentOwnerToken(buildPinetOwnerToken(brokerStableId));

        const activeSkinTheme =
          normalizeOptionalSetting(broker.db.getSetting<string>("pinet.skinTheme")) ??
          deps.getActiveSkinTheme() ??
          DEFAULT_PINET_SKIN_THEME;
        deps.setActiveSkinTheme(activeSkinTheme);
        broker.db.setSetting("pinet.skinTheme", activeSkinTheme);
        broker.server.setAgentRegistrationResolver((registration) => {
          const theme = deps.getActiveSkinTheme() ?? DEFAULT_PINET_SKIN_THEME;
          const assignment = buildPinetSkinAssignment({
            theme,
            role: deps.getMeshRoleFromMetadata(registration.metadata, "worker"),
            seed: registration.stableId ?? registration.agentId,
          });
          return {
            name: assignment.name,
            emoji: assignment.emoji,
            metadata: deps.buildSkinMetadata(registration.metadata, assignment.personality),
          };
        });

        const selfAssignment = buildPinetSkinAssignment({
          theme: activeSkinTheme,
          role: "broker",
          seed: brokerStableId,
        });
        const selfAgent = broker.db.registerAgent(
          ctx.sessionManager.getLeafId() ?? `broker-${process.pid}`,
          selfAssignment.name,
          selfAssignment.emoji,
          process.pid,
          deps.buildSkinMetadata(await deps.getAgentMetadata("broker"), selfAssignment.personality),
          brokerStableId,
        );
        selfId = selfAgent.id;
        deps.applyLocalAgentIdentity(selfAgent.name, selfAgent.emoji, selfAssignment.personality);

        const brokerSelfId = selfId;
        adapter.onInbound((message) => {
          void deps.handleInboundMessage({ message, broker, router, selfId: brokerSelfId, ctx });
        });

        broker.addAdapter(adapter);
        await adapter.connect();

        activeBroker = broker;
        activeRouter = router;
        activeSelfId = brokerSelfId;
        resetBrokerDeliveryState(deps.deliveryState);

        const releasedBrokerClaims = broker.db.releaseThreadClaims(brokerSelfId);
        const recoveredTargetedBacklogCount = broker.db.recoverPendingTargetedBacklog(brokerSelfId);
        const recoveredBrokerMessages = broker.db.getPendingInboxCount(brokerSelfId);
        syncBrokerDbInbox(brokerSelfId, broker.db as BrokerDB, ctx);

        broker.server.onAgentMessage((targetAgentId) => {
          if (targetAgentId !== brokerSelfId) return;
          syncBrokerDbInbox(brokerSelfId, broker.db as BrokerDB, ctx);
        });
        broker.server.onAgentStatusChange((changedAgentId, status) => {
          if (status === "idle") {
            runMaintenance(ctx);
          }
          deps.onAgentStatusChange(ctx, changedAgentId, status);
        });

        startBrokerHeartbeat();
        startBrokerMaintenance(ctx);
        startBrokerScheduledWakeups(ctx);

        return {
          botUserId: adapter.getBotUserId(),
          recoveredBrokerMessages,
          recoveredTargetedBacklogCount,
          releasedBrokerClaims,
        };
      } catch (error) {
        try {
          await adapter.disconnect();
        } catch {
          /* best effort */
        }
        try {
          if (selfId) {
            broker.db.unregisterAgent(selfId);
          }
        } catch {
          /* best effort */
        }
        try {
          await broker.stop();
        } catch {
          /* best effort */
        }
        activeBroker = null;
        activeRouter = null;
        activeSelfId = null;
        lastBrokerMaintenance = null;
        lastBrokerMaintenanceSignature = "";
        resetBrokerDeliveryState(deps.deliveryState);
        stopObservability();
        throw error;
      }
    },

    async disconnect(options = {}): Promise<void> {
      await disconnect(options);
    },

    claimThread(threadTs: string, channelId: string, source = "slack"): void {
      if (!activeRouter || !activeSelfId) {
        return;
      }
      activeRouter.claimThread(threadTs, activeSelfId, channelId, source);
    },

    runMaintenance(ctx: ExtensionContext): void {
      runMaintenance(ctx);
    },

    markDelivered(inboxIds: number[]): void {
      if (!activeBroker || !activeSelfId || inboxIds.length === 0) {
        return;
      }
      activeBroker.db.markDelivered(inboxIds, activeSelfId);
      markBrokerInboxIdsHandled(deps.deliveryState, inboxIds);
    },

    startObservability(ctx: ExtensionContext): void {
      startObservability(ctx);
    },

    clearFollowUpPending(): void {
      ralphLoopState.followUpPending = false;
    },

    logActivity(entry: ActivityLogEntry): void {
      if (!activeBroker) {
        return;
      }
      ensureActivityLogger().log(entry);
    },

    getRecentActivityEntries(limit = 20): ReadonlyArray<LoggedActivityLogEntry> {
      return activityLogger?.getRecentEntries(limit) ?? [];
    },

    getBroker(): Broker | null {
      return activeBroker;
    },

    getSelfId(): string | null {
      return activeSelfId;
    },

    getLastMaintenance(): BrokerMaintenanceResult | null {
      return lastBrokerMaintenance;
    },

    heartbeatTimerActive(): boolean {
      return brokerHeartbeatTimer != null;
    },

    maintenanceTimerActive(): boolean {
      return brokerMaintenanceTimer != null;
    },

    isConnected(): boolean {
      return activeBroker != null;
    },

    isBrokerControlPlaneCanvasEnabled(): boolean {
      return isBrokerControlPlaneCanvasEnabled();
    },

    getConfiguredBrokerControlPlaneCanvasId(): string | null {
      return getConfiguredBrokerControlPlaneCanvasId();
    },

    getConfiguredBrokerControlPlaneCanvasChannel(): string | null {
      return getConfiguredBrokerControlPlaneCanvasChannel();
    },

    getControlPlaneCanvasRuntimeId(): string | null {
      return brokerControlPlaneCanvasRuntimeId;
    },

    getControlPlaneCanvasRuntimeChannelId(): string | null {
      return brokerControlPlaneCanvasRuntimeChannelId;
    },

    restoreControlPlaneCanvasRuntimeState(input: {
      canvasId: string | null;
      channelId: string | null;
    }): void {
      brokerControlPlaneCanvasRuntimeId = normalizeOptionalSetting(input.canvasId);
      brokerControlPlaneCanvasRuntimeChannelId = normalizeOptionalSetting(input.channelId);
    },

    getLastControlPlaneCanvasRefreshAt(): string | null {
      return lastBrokerControlPlaneCanvasRefreshAt;
    },

    setLastControlPlaneCanvasRefreshAt(value: string | null): void {
      lastBrokerControlPlaneCanvasRefreshAt = value;
    },

    getLastControlPlaneCanvasError(): string | null {
      return lastBrokerControlPlaneCanvasError;
    },

    setLastControlPlaneCanvasError(value: string | null): void {
      lastBrokerControlPlaneCanvasError = value;
    },

    getHomeTabViewerIds(): string[] {
      return [...brokerControlPlaneHomeTabViewers.entries()].map(([userId]) => userId);
    },

    getLastHomeTabSnapshot(): BrokerControlPlaneDashboardSnapshot | null {
      return lastBrokerControlPlaneHomeTabSnapshot;
    },

    setLastHomeTabSnapshot(snapshot: BrokerControlPlaneDashboardSnapshot | null): void {
      lastBrokerControlPlaneHomeTabSnapshot = snapshot;
    },

    getLastHomeTabRefreshAt(): string | null {
      return lastBrokerControlPlaneHomeTabRefreshAt;
    },

    setLastHomeTabRefreshAt(value: string | null): void {
      lastBrokerControlPlaneHomeTabRefreshAt = value;
    },

    getLastHomeTabError(): string | null {
      return lastBrokerControlPlaneHomeTabError;
    },

    setLastHomeTabError(value: string | null): void {
      lastBrokerControlPlaneHomeTabError = value;
    },

    async publishCurrentHomeTabSafely(
      userId: string,
      ctx: ExtensionContext,
      openedAt = new Date().toISOString(),
    ): Promise<boolean> {
      return publishCurrentHomeTabSafely(userId, ctx, openedAt);
    },
  };
}
