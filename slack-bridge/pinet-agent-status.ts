import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

export type PinetAgentStatusValue = "working" | "idle";

export interface PinetAgentDeliveryEvidence {
  trackedThreadCount: number;
  outboundCount: number;
}

export interface PinetAgentStatusBrokerDbPort {
  updateAgentStatus: (agentId: string, status: PinetAgentStatusValue) => void;
  getActiveTaskAssignmentDeliveryEvidenceForAgent?: (agentId: string) => PinetAgentDeliveryEvidence;
}

export interface PinetAgentStatusDeps {
  getPinetEnabled: () => boolean;
  getBrokerRole: () => "broker" | "follower" | null;
  getDesiredAgentStatus: () => PinetAgentStatusValue;
  setDesiredAgentStatus: (status: PinetAgentStatusValue) => void;
  getActiveBrokerDb: () => PinetAgentStatusBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  hasFollowerClient: () => boolean;
  syncFollowerDesiredStatus: (
    status: PinetAgentStatusValue,
    options: { force?: boolean; note?: string },
  ) => Promise<void>;
  runBrokerMaintenance: (ctx: ExtensionContext) => void;
  getInboxLength: () => number;
  getCurrentRuntimeMode: () => SlackBridgeRuntimeMode;
  maybeDrainInboxIfIdle: (ctx: ExtensionContext) => boolean;
  getExtensionContext: () => ExtensionContext | undefined;
  noteClaimsDelivery: (note: string) => boolean;
  logSuspiciousDeliveryClaim: (details: {
    agentId: string;
    note: string;
    trackedThreadCount: number;
    outboundCount: number;
  }) => void;
}

export interface PinetAgentStatus {
  syncDesiredAgentStatus: (options?: { force?: boolean; note?: string }) => Promise<void>;
  reportStatus: (status: PinetAgentStatusValue) => Promise<void>;
  signalAgentFree: (
    ctx?: ExtensionContext,
    options?: { requirePinet?: boolean; note?: string },
  ) => Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }>;
}

export function createPinetAgentStatus(deps: PinetAgentStatusDeps): PinetAgentStatus {
  async function syncDesiredAgentStatus(
    options: { force?: boolean; note?: string } = {},
  ): Promise<void> {
    if (!deps.getPinetEnabled()) {
      return;
    }

    const desiredAgentStatus = deps.getDesiredAgentStatus();
    if (deps.getBrokerRole() === "broker") {
      const db = deps.getActiveBrokerDb();
      const selfId = deps.getActiveBrokerSelfId();
      if (!db || !selfId) {
        return;
      }
      db.updateAgentStatus(selfId, desiredAgentStatus);
      return;
    }

    if (deps.getBrokerRole() === "follower" && deps.hasFollowerClient()) {
      await deps.syncFollowerDesiredStatus(desiredAgentStatus, options);
    }
  }

  async function reportStatus(status: PinetAgentStatusValue): Promise<void> {
    deps.setDesiredAgentStatus(status);
    await syncDesiredAgentStatus();
  }

  function maybeLogSuspiciousDeliveryClaim(note: string): void {
    if (!note || !deps.noteClaimsDelivery(note)) {
      return;
    }
    const db = deps.getActiveBrokerDb();
    const selfId = deps.getActiveBrokerSelfId();
    if (!db || !selfId) {
      return;
    }
    const evidence = db.getActiveTaskAssignmentDeliveryEvidenceForAgent?.(selfId);
    if (!evidence || evidence.outboundCount > 0) {
      return;
    }

    deps.logSuspiciousDeliveryClaim({
      agentId: selfId,
      note,
      trackedThreadCount: evidence.trackedThreadCount,
      outboundCount: evidence.outboundCount,
    });
  }

  async function signalAgentFree(
    ctx?: ExtensionContext,
    options: { requirePinet?: boolean; note?: string } = {},
  ): Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }> {
    const pinetEnabled = deps.getPinetEnabled();
    if (!pinetEnabled && options.requirePinet) {
      throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
    }

    const note = typeof options.note === "string" ? options.note.trim() : "";
    const maintenanceCtx = ctx ?? deps.getExtensionContext() ?? undefined;
    if (pinetEnabled) {
      deps.setDesiredAgentStatus("idle");
      await syncDesiredAgentStatus({ force: note.length > 0, ...(note ? { note } : {}) });
      maybeLogSuspiciousDeliveryClaim(note);
      if (deps.getBrokerRole() === "broker" && maintenanceCtx) {
        deps.runBrokerMaintenance(maintenanceCtx);
      }
    }

    const queuedInboxCount = deps.getInboxLength();
    const shouldDrainQueuedInbox = pinetEnabled || deps.getCurrentRuntimeMode() === "single";
    const drainedQueuedInbox =
      shouldDrainQueuedInbox && queuedInboxCount > 0 && maintenanceCtx
        ? deps.maybeDrainInboxIfIdle(maintenanceCtx)
        : false;

    return { queuedInboxCount, drainedQueuedInbox };
  }

  return {
    syncDesiredAgentStatus,
    reportStatus,
    signalAgentFree,
  };
}
