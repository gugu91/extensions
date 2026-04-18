export interface ModelLike {
  provider?: string;
  id?: string;
}

export interface AssistantContentBlockLike {
  type?: string;
  text?: string;
}

export interface AssistantMessageLike {
  role?: string;
  stopReason?: string;
  content?: AssistantContentBlockLike[];
}

export interface ContinuationDecision {
  shouldContinue: boolean;
  reason:
    | "not-assistant"
    | "not-stop"
    | "has-tool-results"
    | "has-tool-calls"
    | "budget-exhausted"
    | "no-text"
    | "completion-language"
    | "blocker-or-clarification"
    | "approval-handoff"
    | "continuation-intent"
    | "no-signal";
}

export interface ContinuationDecisionInput {
  message: AssistantMessageLike | undefined;
  toolResultCount: number;
  usedAutoContinueTurns: number;
  maxAutoContinueTurns: number;
}

const CONTINUATION_INTENT =
  /\b(i(?:'| wi)?ll|let me|i am going to|i'm going to|first[, ]+i(?:'| wi)?ll|next[, ]+i(?:'| wi)?ll|i can start by|i will start by)\b/i;
const APPROVAL_HANDOFF =
  /\blet me know if (?:you(?:'d)? like|you want|i should)\b|\bif you(?:'d)? like[, ]+i can\b|\bwant me to\b|\bshould i (?:continue|proceed|go ahead)\b/i;
const COMPLETION_LANGUAGE =
  /\b(done|completed|finished|implemented|updated|fixed|added|created|verified|resolved|here(?:'s| is)|i found|i changed|i ran|i verified)\b/i;
const BLOCKER_OR_CLARIFICATION =
  /\b(blocked|cannot|can't|unable|don't have|do not have|need (?:the )?(?:path|file|details|clarification|approval|access|permission|decision)|which (?:file|path|one|option)|what (?:file|path|exactly|should)|could you|can you|please provide)\b/i;

export function buildExecutionShapingPrompt(): string {
  return `## OpenAI GPT-5 Execution Shaping (Experimental Extension)

Use a real tool call or concrete action first when the task is actionable.
Commentary-only turns are incomplete when tools are available and the next step is clear.
If the work will take multiple steps, keep going until the task is complete or you hit a real blocker.
Do prerequisite lookup or discovery before dependent actions.
Do not stop after one exploratory step to ask for permission unless the next action is genuinely destructive or needs explicit approval.
Multi-part requests stay incomplete until each requested item is handled or clearly marked blocked.
Act first, then summarize or verify when that materially helps.`;
}

export function buildAutoContinueMessage(): string {
  return [
    "Continue.",
    "Take the next concrete action immediately.",
    "Use tools if the next step is clear.",
    "Commentary-only replies are incomplete.",
    "Do not restate the plan or ask for permission unless you hit a real blocker or a genuinely destructive step requires approval.",
  ].join(" ");
}

export function normalizeModelId(
  modelId: string | undefined,
  provider: string | undefined,
): string {
  if (!modelId) return "";
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const providerPrefix = provider?.trim().toLowerCase();
  if (!providerPrefix) return trimmed.toLowerCase();
  return trimmed.replace(new RegExp(`^${providerPrefix}[:/]`, "i"), "").toLowerCase();
}

export function isTargetModel(
  model: ModelLike | undefined,
  config: { providers: string[]; modelRegex: RegExp; enabled: boolean },
): boolean {
  if (!config.enabled || !model?.provider || !model.id) {
    return false;
  }

  const provider = model.provider.trim().toLowerCase();
  if (!config.providers.map((value) => value.toLowerCase()).includes(provider)) {
    return false;
  }

  return config.modelRegex.test(normalizeModelId(model.id, provider));
}

export function extractAssistantText(message: AssistantMessageLike | undefined): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

export function countAssistantToolCalls(message: AssistantMessageLike | undefined): number {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return 0;
  }

  return message.content.filter((block) => block?.type === "toolCall").length;
}

export function classifyContinuationNeed(input: ContinuationDecisionInput): ContinuationDecision {
  const { message, toolResultCount, usedAutoContinueTurns, maxAutoContinueTurns } = input;

  if (!message || message.role !== "assistant") {
    return { shouldContinue: false, reason: "not-assistant" };
  }

  if (message.stopReason !== "stop") {
    return { shouldContinue: false, reason: "not-stop" };
  }

  if (toolResultCount > 0) {
    return { shouldContinue: false, reason: "has-tool-results" };
  }

  if (countAssistantToolCalls(message) > 0) {
    return { shouldContinue: false, reason: "has-tool-calls" };
  }

  if (usedAutoContinueTurns >= maxAutoContinueTurns) {
    return { shouldContinue: false, reason: "budget-exhausted" };
  }

  const text = extractAssistantText(message);
  if (!text) {
    return { shouldContinue: false, reason: "no-text" };
  }

  if (COMPLETION_LANGUAGE.test(text)) {
    return { shouldContinue: false, reason: "completion-language" };
  }

  if (BLOCKER_OR_CLARIFICATION.test(text)) {
    return { shouldContinue: false, reason: "blocker-or-clarification" };
  }

  if (APPROVAL_HANDOFF.test(text)) {
    return { shouldContinue: true, reason: "approval-handoff" };
  }

  if (CONTINUATION_INTENT.test(text)) {
    return { shouldContinue: true, reason: "continuation-intent" };
  }

  return { shouldContinue: false, reason: "no-signal" };
}
