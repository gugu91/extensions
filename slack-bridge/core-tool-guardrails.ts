import { isToolBlocked, toolNeedsConfirmation, type SecurityGuardrails } from "./guardrails.js";

export interface SlackToolPolicyTurn {
  threadTs: string | undefined;
  threadCount: number;
}

export const GUARDED_CORE_TOOLS = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

export function isGuardedCoreTool(toolName: string): boolean {
  return GUARDED_CORE_TOOLS.has(toolName);
}

export function getGuardrailToolName(toolName: string): string {
  return toolName === "grep" ? "rg" : toolName;
}

export function summarizeCoreToolAction(event: {
  toolName: string;
  input: Record<string, unknown>;
}): string {
  const input = event.input;
  switch (event.toolName) {
    case "bash":
      return `command=${String(input.command ?? "")}`;
    case "read":
      return `path=${String(input.path ?? "")} | offset=${String(input.offset ?? "")} | limit=${String(input.limit ?? "")}`;
    case "edit":
      return `path=${String(input.path ?? "")} | edits=${Array.isArray(input.edits) ? input.edits.length : 0}`;
    case "write": {
      const content = typeof input.content === "string" ? input.content : "";
      return `path=${String(input.path ?? "")} | content_length=${content.length}`;
    }
    case "grep":
      return `pattern=${String(input.pattern ?? "")} | path=${String(input.path ?? "")} | glob=${String(input.glob ?? "")}`;
    case "find":
      return `pattern=${String(input.pattern ?? "")} | path=${String(input.path ?? "")} | limit=${String(input.limit ?? "")}`;
    case "ls":
      return `path=${String(input.path ?? "")} | limit=${String(input.limit ?? "")}`;
    default:
      return JSON.stringify(input);
  }
}

export function evaluateSlackOriginCoreToolPolicy(options: {
  turn: SlackToolPolicyTurn | null;
  toolName: string;
  input: Record<string, unknown>;
  guardrails: SecurityGuardrails;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  formatAction: (action: string) => string;
  formatError: (error: unknown) => string;
}): { block: true; reason: string } | undefined {
  const { turn, toolName, input, guardrails, requireToolPolicy, formatAction, formatError } =
    options;
  if (!turn || !isGuardedCoreTool(toolName)) {
    return undefined;
  }

  const guardrailToolName = getGuardrailToolName(toolName);
  if (isToolBlocked(guardrailToolName, guardrails)) {
    return {
      block: true,
      reason: `Tool "${guardrailToolName}" is blocked by Slack security guardrails.`,
    };
  }

  if (!toolNeedsConfirmation(guardrailToolName, guardrails)) {
    return undefined;
  }

  const action = summarizeCoreToolAction({ toolName, input });
  if (!turn.threadTs) {
    return {
      block: true,
      reason:
        turn.threadCount > 1
          ? `Tool "${guardrailToolName}" requires Slack confirmation for action ${formatAction(action)}, but this Slack-triggered turn currently batches ${turn.threadCount} threads. Process one Slack thread at a time before using that tool.`
          : `Tool "${guardrailToolName}" requires Slack confirmation for action ${formatAction(action)}, but there is no tracked Slack thread available for this turn. Retry from a specific Slack thread and call slack with action "confirm_action" there first.`,
    };
  }

  try {
    requireToolPolicy(guardrailToolName, turn.threadTs, action);
    return undefined;
  } catch (error) {
    return {
      block: true,
      reason: formatError(error),
    };
  }
}
