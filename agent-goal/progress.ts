export interface GoalProgressMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  toolName?: string;
  isError?: boolean;
}

const MAX_PROGRESS_MESSAGES = 40;
const MAX_PROGRESS_CHARACTERS = 40_000;

export function formatGoalProgress(messages: GoalProgressMessage[]): string {
  const text = messages
    .slice(-MAX_PROGRESS_MESSAGES)
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter(
                (part): part is { type: "text"; text: string } =>
                  part.type === "text" && typeof part.text === "string",
              )
              .map((part) => part.text)
              .join("\n");
      const label = message.toolName
        ? `${message.role}:${message.toolName}${message.isError ? ":error" : ""}`
        : message.role;
      return content ? `[${label}]\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return text.length > MAX_PROGRESS_CHARACTERS ? text.slice(-MAX_PROGRESS_CHARACTERS) : text;
}
