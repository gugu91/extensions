import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  finishPinetRemoteControl,
  queuePinetRemoteControl,
  type PinetControlCommand,
  type PinetRemoteControlRequestResult,
  type PinetRemoteControlState,
} from "./helpers.js";

export type PinetRuntimeControlContext = ExtensionContext & {
  abort?: () => void;
  shutdown?: () => void;
};

export interface PinetRemoteControlDeps {
  flushDeferredRemoteControlAcks: (command: PinetControlCommand) => void;
  reloadPinetRuntime: (ctx: ExtensionContext) => Promise<void>;
  formatError: (error: unknown) => string;
  onCommandSettled?: (event: {
    command: PinetControlCommand;
    success: boolean;
    error: unknown;
    nextCommand: PinetControlCommand | null;
    getLatestNextCommand: () => PinetControlCommand | null;
    ctx: ExtensionContext;
  }) => void | Promise<void>;
}

export interface PinetRemoteControl {
  requestRemoteControl: (
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ) => PinetRemoteControlRequestResult;
  runRemoteControl: (command: PinetControlCommand, ctx: ExtensionContext) => void;
  resetRemoteControlState: () => void;
}

function createInitialRemoteControlState(): PinetRemoteControlState {
  return {
    currentCommand: null,
    queuedCommand: null,
  };
}

export function createPinetRemoteControl(deps: PinetRemoteControlDeps): PinetRemoteControl {
  let remoteControlState = createInitialRemoteControlState();

  function resetRemoteControlState(): void {
    remoteControlState = createInitialRemoteControlState();
  }

  function runRemoteControl(command: PinetControlCommand, ctx: ExtensionContext): void {
    deps.flushDeferredRemoteControlAcks(command);

    const controlCtx = ctx as PinetRuntimeControlContext;
    if (!(ctx.isIdle?.() ?? true)) {
      try {
        controlCtx.abort?.();
      } catch {
        /* best effort */
      }
    }

    ctx.ui.notify(`Pinet remote control requested: /${command}`, "warning");
    void (async () => {
      let success = false;
      let commandError: unknown = null;
      try {
        if (command === "reload") {
          await deps.reloadPinetRuntime(ctx);
          success = true;
        } else {
          if (typeof controlCtx.shutdown !== "function") {
            throw new Error("Shutdown is not available in this extension context.");
          }
          controlCtx.shutdown();
          success = true;
        }
      } catch (err) {
        commandError = err;
        ctx.ui.notify(`Pinet remote control failed: ${deps.formatError(err)}`, "error");
      } finally {
        const nextBeforeSettle = finishPinetRemoteControl(remoteControlState);
        try {
          await deps.onCommandSettled?.({
            command,
            success,
            error: commandError,
            nextCommand: nextBeforeSettle.nextCommand,
            getLatestNextCommand: () => finishPinetRemoteControl(remoteControlState).nextCommand,
            ctx,
          });
        } catch {
          /* best effort */
        }

        const next = finishPinetRemoteControl(remoteControlState);
        remoteControlState = {
          currentCommand: next.currentCommand,
          queuedCommand: next.queuedCommand,
        };
        if (next.nextCommand) {
          ctx.ui.notify(
            `Pinet remote control continuing with queued /${next.nextCommand}`,
            "warning",
          );
          runRemoteControl(next.nextCommand, ctx);
        }
      }
    })();
  }

  function requestRemoteControl(
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ): PinetRemoteControlRequestResult {
    const queued = queuePinetRemoteControl(remoteControlState, command);
    remoteControlState = {
      currentCommand: queued.currentCommand,
      queuedCommand: queued.queuedCommand,
    };

    if (queued.status === "queued") {
      ctx.ui.notify(`Pinet remote control queued: /${queued.queuedCommand ?? command}`, "warning");
    } else if (!queued.shouldStartNow) {
      ctx.ui.notify(
        `Pinet remote control already scheduled — keeping /${queued.scheduledCommand}`,
        "warning",
      );
    }

    return queued;
  }

  return {
    requestRemoteControl,
    runRemoteControl,
    resetRemoteControlState,
  };
}
