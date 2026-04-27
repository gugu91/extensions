export const PINET_MAIL_CLASSES = ["steering", "fwup", "maintenance_context"] as const;

export type PinetMailClass = (typeof PINET_MAIL_CLASSES)[number];

export interface PinetMailClassificationInput {
  source?: string | null;
  threadId?: string | null;
  sender?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PinetMailClassification {
  class: PinetMailClass;
  reason: string;
  explicit: boolean;
}

const EXPLICIT_CLASS_KEYS = [
  "pinetMailClass",
  "pinet_mail_class",
  "mailClass",
  "mail_class",
  "mailKind",
  "mail_kind",
  "classification",
] as const;

const STEERING_PATTERNS = [
  /\back(?:\/|\s*)work(?:\/|\s*)ask(?:\/|\s*)report\b/i,
  /\back briefly\b/i,
  /\bplease (?:take|continue|implement|fix|review|inspect|reassign|handle|work on)\b/i,
  /\b(?:new|fresh) (?:implementation )?(?:lane|task|worktree)\b/i,
  /\b(?:scope|workflow|acceptance criteria|constraints?|blockers?)\s*:/i,
  /\b(?:take|continue|implement|fix|review|inspect|handle|work on)\s+(?:issue|pr)\s*#\d+\b/i,
  /\b(?:issue|pr)\s*#\d+\b.*\b(?:ack|work|review|fix|implement|take|handle)\b/i,
  /\bready for human review\b/i,
  /\breport blockers? immediately\b/i,
  /\bno merge\b/i,
];

const MAINTENANCE_CONTEXT_PATTERNS = [
  /\bralph\b.*\b(?:maintenance|ghost|reap|nudge|drain)\b/i,
  /\bbroker[- ]only maintenance\b/i,
  /\bmaintenance (?:anomaly|recovery|timer|pass)\b/i,
  /\bno further repl(?:y|ies) (?:are|is) needed\b/i,
  /\bno further acknowledg(?:ement|ements) (?:are|is) needed\b/i,
  /\bno reply is needed\b/i,
  /\bhard stop on this [^.\n]*thread\b/i,
  /\bstay free(?:\/| and )quiet\b/i,
  /\bstay quiet(?:\/| and )free\b/i,
];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizePinetMailClass(value: unknown): PinetMailClass | null {
  const raw = asString(value)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!raw) return null;

  if (raw === "steering" || raw === "steer" || raw === "directive") return "steering";
  if (raw === "fwup" || raw === "follow_up" || raw === "followup") return "fwup";
  if (
    raw === "maintenance_context" ||
    raw === "maintenance" ||
    raw === "context_only" ||
    raw === "context"
  ) {
    return "maintenance_context";
  }

  return null;
}

function getExplicitMailClass(
  metadata: Record<string, unknown> | null | undefined,
): PinetMailClass | null {
  if (!metadata) return null;

  for (const key of EXPLICIT_CLASS_KEYS) {
    const normalized = normalizePinetMailClass(metadata[key]);
    if (normalized) return normalized;
  }

  return null;
}

function hasPattern(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function metadataLooksLikeMaintenance(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const kind = asString(metadata?.kind)?.toLowerCase() ?? "";
  const type = asString(metadata?.type)?.toLowerCase() ?? "";
  const eventType = asString(metadata?.event_type)?.toLowerCase() ?? "";
  return [kind, type, eventType].some(
    (value) =>
      value.includes("maintenance") ||
      value.includes("ralph") ||
      value === "pinet:control" ||
      value === "pinet_control" ||
      value === "pinet:skin" ||
      value === "pinet_skin",
  );
}

export function classifyPinetMail(input: PinetMailClassificationInput): PinetMailClassification {
  const metadata = input.metadata ?? null;
  const explicitClass = getExplicitMailClass(metadata);
  if (explicitClass) {
    return { class: explicitClass, reason: "explicit metadata", explicit: true };
  }

  const body = input.body ?? "";
  if (metadataLooksLikeMaintenance(metadata) || hasPattern(MAINTENANCE_CONTEXT_PATTERNS, body)) {
    return {
      class: "maintenance_context",
      reason: "maintenance/context-only cues",
      explicit: false,
    };
  }

  if (hasPattern(STEERING_PATTERNS, body)) {
    return { class: "steering", reason: "actionable steering cues", explicit: false };
  }

  return { class: "fwup", reason: "default follow-up mail", explicit: false };
}

export function formatPinetMailClassLabel(mailClass: PinetMailClass): string {
  return mailClass === "maintenance_context" ? "maintenance/context" : mailClass;
}
