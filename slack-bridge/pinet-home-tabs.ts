import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-canvas.js";
import { probeGitBranch } from "./git-metadata.js";
import {
  publishSlackHomeTab,
  renderBrokerControlPlaneHomeTabView,
  renderStandalonePinetHomeTabView,
  type PublishSlackHomeTabInput,
} from "./home-tab.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

export interface PinetHomeTabViewerRecord {
  userId: string;
  installId: string;
}

export interface PinetHomeTabsBrokerPort {
  isConnected: () => boolean;
  publishCurrentHomeTabSafely: (
    userId: string,
    ctx: ExtensionContext,
    openedAt?: string,
    installId?: string,
  ) => Promise<boolean>;
  getHomeTabViewerIds: () => string[];
  getHomeTabViewers: () => PinetHomeTabViewerRecord[];
  getLastHomeTabError: () => string | null;
  setLastHomeTabSnapshot: (snapshot: BrokerControlPlaneDashboardSnapshot | null) => void;
  setLastHomeTabRefreshAt: (value: string | null) => void;
  setLastHomeTabError: (value: string | null) => void;
}

export interface PinetHomeTabsDeps {
  slack: PublishSlackHomeTabInput["slack"];
  getBotToken: (installId?: string | null) => string | undefined;
  getDefaultInstallId: () => string | null | undefined;
  isHomeTabEnabled: (installId?: string | null) => boolean;
  formatError: (error: unknown) => string;
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getBrokerRole: () => "broker" | "follower" | null;
  getRuntimeMode: () => SlackBridgeRuntimeMode;
  isFollowerConnected: () => boolean;
  isSinglePlayerConnected: () => boolean;
  getActiveThreads: () => number;
  getPendingInboxCount: () => number;
  getDefaultChannel: (installId?: string | null) => string | null | undefined;
  getBrokerHomeTabs: () => PinetHomeTabsBrokerPort;
  getCurrentBranch?: () => Promise<string | null>;
}

export interface PinetHomeTabs {
  refreshBrokerControlPlaneHomeTabs: (
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
    viewers?: PinetHomeTabViewerRecord[],
  ) => Promise<void>;
  reportHomeTabPublishFailure: (ctx: ExtensionContext, err: unknown) => void;
  publishCurrentPinetHomeTab: (
    userId: string,
    ctx: ExtensionContext,
    openedAt?: string,
    installId?: string,
  ) => Promise<void>;
  publishCurrentPinetHomeTabSafely: (
    userId: string,
    ctx: ExtensionContext,
    openedAt?: string,
    installId?: string,
  ) => Promise<void>;
}

function buildHomeTabPublishFailureMessage(
  formatError: (error: unknown) => string,
  err: unknown,
): string {
  return `Pinet Home tab publish failed: ${formatError(err)}`;
}

function getConnectedState(deps: PinetHomeTabsDeps): boolean {
  const mode = deps.getRuntimeMode();
  const brokerHomeTabs = deps.getBrokerHomeTabs();
  if (mode === "broker") {
    return brokerHomeTabs.isConnected();
  }
  if (mode === "follower") {
    return deps.isFollowerConnected();
  }
  if (mode === "single") {
    return deps.isSinglePlayerConnected();
  }
  return false;
}

export function createPinetHomeTabs(deps: PinetHomeTabsDeps): PinetHomeTabs {
  function reportHomeTabPublishFailure(ctx: ExtensionContext, err: unknown): void {
    const brokerHomeTabs = deps.getBrokerHomeTabs();
    const homeTabMessage = buildHomeTabPublishFailureMessage(deps.formatError, err);
    if (homeTabMessage !== brokerHomeTabs.getLastHomeTabError()) {
      ctx.ui.notify(homeTabMessage, "warning");
    }
    brokerHomeTabs.setLastHomeTabError(homeTabMessage);
  }

  async function refreshBrokerControlPlaneHomeTabs(
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
    viewers: PinetHomeTabViewerRecord[] = deps.getBrokerHomeTabs().getHomeTabViewers(),
  ): Promise<void> {
    if (viewers.length === 0) {
      return;
    }

    const brokerHomeTabs = deps.getBrokerHomeTabs();
    brokerHomeTabs.setLastHomeTabSnapshot(snapshot);
    let hadError = false;

    for (const viewer of viewers) {
      if (!deps.isHomeTabEnabled(viewer.installId)) {
        continue;
      }

      const botToken = deps.getBotToken(viewer.installId);
      if (!botToken) {
        continue;
      }

      try {
        await publishSlackHomeTab({
          slack: deps.slack,
          token: botToken,
          userId: viewer.userId,
          view: renderBrokerControlPlaneHomeTabView(snapshot),
        });
      } catch (err) {
        hadError = true;
        reportHomeTabPublishFailure(ctx, err);
      }
    }

    if (!hadError) {
      brokerHomeTabs.setLastHomeTabError(null);
    }
    brokerHomeTabs.setLastHomeTabRefreshAt(refreshedAt);
  }

  async function publishCurrentPinetHomeTab(
    userId: string,
    ctx: ExtensionContext,
    openedAt: string = new Date().toISOString(),
    installId: string = deps.getDefaultInstallId() ?? "default",
  ): Promise<void> {
    if (!deps.isHomeTabEnabled(installId)) {
      return;
    }

    const brokerHomeTabs = deps.getBrokerHomeTabs();
    if (brokerHomeTabs.isConnected() && deps.getBrokerRole() === "broker") {
      if (await brokerHomeTabs.publishCurrentHomeTabSafely(userId, ctx, openedAt, installId)) {
        return;
      }
    }

    const botToken = deps.getBotToken(installId);
    if (!botToken) {
      return;
    }

    const currentBranch = deps.getCurrentBranch
      ? await deps.getCurrentBranch()
      : ((await probeGitBranch(process.cwd())) ?? null);
    await publishSlackHomeTab({
      slack: deps.slack,
      token: botToken,
      userId,
      view: renderStandalonePinetHomeTabView({
        agentName: deps.getAgentName(),
        agentEmoji: deps.getAgentEmoji(),
        connected: getConnectedState(deps),
        mode: deps.getRuntimeMode(),
        activeThreads: deps.getActiveThreads(),
        pendingInbox: deps.getPendingInboxCount(),
        currentBranch,
        defaultChannel: deps.getDefaultChannel(installId) ?? null,
      }),
    });
    brokerHomeTabs.setLastHomeTabError(null);
  }

  async function publishCurrentPinetHomeTabSafely(
    userId: string,
    ctx: ExtensionContext,
    openedAt: string = new Date().toISOString(),
    installId?: string,
  ): Promise<void> {
    try {
      await publishCurrentPinetHomeTab(userId, ctx, openedAt, installId);
    } catch (err) {
      reportHomeTabPublishFailure(ctx, err);
    }
  }

  return {
    refreshBrokerControlPlaneHomeTabs,
    reportHomeTabPublishFailure,
    publishCurrentPinetHomeTab,
    publishCurrentPinetHomeTabSafely,
  };
}
