export interface ScheduledWakeupInput {
  delay?: string;
  at?: string;
}

const DELAY_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export function parseScheduledWakeupDelay(delay: string): number | null {
  const normalized = delay.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }

  const tokenRegex = /(\d+)(ms|s|m|h|d)/g;
  let totalMs = 0;
  let matchedLength = 0;

  for (const match of normalized.matchAll(tokenRegex)) {
    const [token, amountText, unit] = match;
    if (!token || !amountText || !unit || match.index !== matchedLength) {
      return null;
    }

    const amount = Number.parseInt(amountText, 10);
    if (!Number.isFinite(amount) || amount < 0) {
      return null;
    }

    totalMs += amount * DELAY_UNITS_MS[unit];
    matchedLength += token.length;
  }

  if (matchedLength !== normalized.length || totalMs <= 0) {
    return null;
  }

  return totalMs;
}

export function resolveScheduledWakeupFireAt(
  input: ScheduledWakeupInput,
  now = Date.now(),
): string {
  const hasDelay = typeof input.delay === "string" && input.delay.trim().length > 0;
  const hasAt = typeof input.at === "string" && input.at.trim().length > 0;

  if (hasDelay === hasAt) {
    throw new Error("Provide exactly one of delay or at.");
  }

  if (hasDelay) {
    const delayMs = parseScheduledWakeupDelay(input.delay!);
    if (delayMs == null) {
      throw new Error("Invalid delay. Use values like 5m, 30s, 1h30m, or 1d.");
    }
    return new Date(now + delayMs).toISOString();
  }

  const fireAtMs = Date.parse(input.at!);
  if (Number.isNaN(fireAtMs)) {
    throw new Error("Invalid timestamp. Use an ISO-8601 time like 2026-04-02T14:30:00Z.");
  }
  if (fireAtMs <= now) {
    throw new Error("Scheduled wake-up time must be in the future.");
  }

  return new Date(fireAtMs).toISOString();
}

export function buildScheduledWakeupThreadId(agentId: string): string {
  return `wakeup:${agentId}`;
}

export function buildScheduledWakeupMetadata(
  wakeupId: number,
  fireAt: string,
): Record<string, unknown> {
  return {
    senderAgent: "Pinet Scheduler",
    scheduledWakeup: true,
    wakeupId,
    fireAt,
  };
}
