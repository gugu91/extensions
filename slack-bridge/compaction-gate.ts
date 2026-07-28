/**
 * Compaction delivery gate.
 *
 * Pi's manual/extension compaction path (`AgentSession.compact()`, used by
 * `/compact` and every extension `ctx.compact()` call) disconnects session
 * persistence for the whole summarization call, while `ctx.isIdle()` keeps
 * returning true. Any message injected through `pi.sendUserMessage()` in that
 * window starts a real agent run whose entries are silently never written to
 * the session file, leaving an orphaned toolResult behind and eventually
 * bricking the session with provider errors such as
 * "No tool call found for function call output" (gugu91/pinet#941).
 *
 * This gate tracks the compaction window via the `session_before_compact` /
 * `session_compact` extension events and lets the slack-bridge delivery paths
 * hold inbound work until the window closes. Release is always deferred to a
 * fresh macrotask because `session_compact` fires *before* Pi reconnects
 * session persistence; delivering synchronously from that handler would
 * reproduce the exact corruption this gate exists to prevent.
 *
 * `session_compact` only fires on successful compaction, so the gate also
 * releases when the compaction abort signal fires, and after a failsafe
 * timeout for non-abort summarization failures (which emit no extension
 * event at all).
 */

export type CompactionGateReleaseReason = "compacted" | "aborted" | "timeout";

/** Timer handle for the failsafe: Node timeout in production, number in tests. */
export type CompactionGateTimerHandle = ReturnType<typeof setTimeout> | number;

export interface CompactionGateDeps {
  /**
   * Called (deferred, never re-entrant) when the hold ends. Receives any
   * messages held during the window; implementations should re-deliver them
   * and then drain the regular inbox.
   */
  onRelease: (heldMessages: string[], reason: CompactionGateReleaseReason) => void;
  /** Failsafe hold duration. Defaults to 10 minutes. */
  maxHoldMs?: number;
  /** Defer hook, injectable for tests. Defaults to `setTimeout(fn, 0)`. */
  scheduleRelease?: (fn: () => void) => void;
  /** Timer hooks, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => CompactionGateTimerHandle;
  clearTimer?: (handle: CompactionGateTimerHandle) => void;
}

export interface CompactionGate {
  /** Whether a compaction hold window is currently open. */
  isCompacting: () => boolean;
  /** Number of messages currently held. */
  heldCount: () => number;
  /** Open the hold window (from `session_before_compact`). */
  beginHold: (options?: { signal?: AbortSignal }) => void;
  /**
   * Hold a message while compacting. Returns true when the message was held
   * (caller must not deliver it), false when no hold is active.
   */
  holdMessage: (text: string) => boolean;
  /**
   * Schedule the end of the hold window. The gate keeps reporting
   * `isCompacting() === true` until the deferred release executes, so that
   * synchronous callers inside Pi's compact() stack (e.g. the
   * `session_compact` handler) can never deliver before persistence is
   * reconnected. Held messages are then released via `onRelease`.
   */
  endHold: (reason: CompactionGateReleaseReason) => void;
  /**
   * Close the hold window without releasing (session shutdown/restart).
   * Returns the dropped messages so callers can log them.
   */
  discard: () => string[];
}

const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000;

export function createCompactionGate(deps: CompactionGateDeps): CompactionGate {
  const maxHoldMs = deps.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const scheduleRelease =
    deps.scheduleRelease ??
    ((fn: () => void) => {
      setTimeout(fn, 0);
    });
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: CompactionGateTimerHandle) => clearTimeout(handle));

  let compacting = false;
  let held: string[] = [];
  let timerHandle: CompactionGateTimerHandle | null = null;
  // Invalidates stale failsafe timers and abort listeners from earlier holds.
  let generation = 0;

  function clearFailsafe(): void {
    if (timerHandle != null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
  }

  function endHold(reason: CompactionGateReleaseReason): void {
    if (!compacting) return;
    const gen = generation;
    clearFailsafe();
    scheduleRelease(() => {
      // Superseded by a newer hold or discard: keep messages for that owner.
      if (gen !== generation) return;
      generation += 1;
      compacting = false;
      const toRelease = held;
      held = [];
      deps.onRelease(toRelease, reason);
    });
  }

  function beginHold(options?: { signal?: AbortSignal }): void {
    generation += 1;
    const gen = generation;
    compacting = true;
    clearFailsafe();
    timerHandle = setTimer(() => {
      if (gen === generation) endHold("timeout");
    }, maxHoldMs);

    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) {
        endHold("aborted");
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (gen === generation) endHold("aborted");
        },
        { once: true },
      );
    }
  }

  function holdMessage(text: string): boolean {
    if (!compacting) return false;
    held.push(text);
    return true;
  }

  function discard(): string[] {
    compacting = false;
    generation += 1;
    clearFailsafe();
    const dropped = held;
    held = [];
    return dropped;
  }

  return {
    isCompacting: () => compacting,
    heldCount: () => held.length,
    beginHold,
    holdMessage,
    endHold,
    discard,
  };
}
