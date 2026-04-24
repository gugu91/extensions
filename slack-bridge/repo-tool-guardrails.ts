import { isToolBlocked, toolNeedsConfirmation, type SecurityGuardrails } from "./guardrails.js";
import type { SlackToolPolicyTurn } from "./core-tool-guardrails.js";

export const GUARDED_REPO_TOOLS = new Set([
  "open_in_editor",
  "comment_add",
  "comment_list",
  "comment_wipe_all",
  "psql",
]);

export function isGuardedRepoTool(toolName: string): boolean {
  return GUARDED_REPO_TOOLS.has(toolName);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipValue(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function summarizeRepoToolAction(event: {
  toolName: string;
  input: Record<string, unknown>;
}): string {
  const input = event.input;

  switch (event.toolName) {
    case "open_in_editor":
      return `file=${String(input.file ?? "")} | line=${String(input.line ?? "")}`;
    case "comment_add": {
      const comment = typeof input.comment === "string" ? input.comment : "";
      return [
        `thread_id=${String(input.thread_id ?? "")}`,
        `file=${String(input.file ?? "")}`,
        `start_line=${String(input.start_line ?? "")}`,
        `end_line=${String(input.end_line ?? "")}`,
        `comment_length=${comment.length}`,
      ].join(" | ");
    }
    case "comment_list":
      return `thread_id=${String(input.thread_id ?? "")} | limit=${String(input.limit ?? "")}`;
    case "comment_wipe_all":
      return "scope=current_repo";
    case "psql": {
      const query = typeof input.query === "string" ? normalizeWhitespace(input.query) : "";
      return `format=${String(input.format ?? "table")} | query=${clipValue(query)}`;
    }
    default:
      return JSON.stringify(input);
  }
}

export function evaluateSlackOriginRepoToolPolicy(options: {
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
  if (!turn || !isGuardedRepoTool(toolName)) {
    return undefined;
  }

  if (isToolBlocked(toolName, guardrails)) {
    return {
      block: true,
      reason: `Tool "${toolName}" is blocked by Slack security guardrails.`,
    };
  }

  if (!toolNeedsConfirmation(toolName, guardrails)) {
    return undefined;
  }

  const action = summarizeRepoToolAction({ toolName, input });
  if (!turn.threadTs) {
    return {
      block: true,
      reason:
        turn.threadCount > 1
          ? `Tool "${toolName}" requires Slack confirmation for action ${formatAction(action)}, but this Slack-triggered turn currently batches ${turn.threadCount} threads. Process one Slack thread at a time before using that tool.`
          : `Tool "${toolName}" requires Slack confirmation for action ${formatAction(action)}, but there is no tracked Slack thread available for this turn. Retry from a specific Slack thread and call slack with action "confirm_action" there first.`,
    };
  }

  try {
    requireToolPolicy(toolName, turn.threadTs, action);
    return undefined;
  } catch (error) {
    return {
      block: true,
      reason: formatError(error),
    };
  }
}
