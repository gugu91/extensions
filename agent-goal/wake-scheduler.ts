import type { GoalWakeScheduler } from "./domain.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class TimerGoalWakeScheduler implements GoalWakeScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  schedule(scopeId: string, wakeAt: string, wake: () => void): void {
    if (this.closed) return;
    this.cancel(scopeId);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Date.parse(wakeAt) - this.now()));
    const timer = setTimeout(() => {
      this.timers.delete(scopeId);
      wake();
    }, delay);
    timer.unref?.();
    this.timers.set(scopeId, timer);
  }

  cancel(scopeId: string): void {
    const timer = this.timers.get(scopeId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(scopeId);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
