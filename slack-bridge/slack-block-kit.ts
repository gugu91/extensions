export type SlackBlock = Record<string, unknown>;

export interface SlackBlockFieldInput {
  label: string;
  value: string;
}

export interface SlackBlockButtonInput {
  text: string;
  action_id: string;
  value?: string;
  style?: "primary" | "danger" | undefined;
  url?: string;
}

export interface SlackBlocksTemplateInput {
  template: string;
  title?: string;
  text?: string;
  footer?: string;
  language?: string;
  code?: string;
  before?: string;
  after?: string;
  fields?: SlackBlockFieldInput[];
  buttons?: SlackBlockButtonInput[];
}

export interface SlackBlocksTemplateResult {
  blocks: SlackBlock[];
  fallbackText: string;
}

export interface SlackNormalizedBlockAction {
  actionId: string;
  blockId?: string;
  text?: string;
  type?: string;
  style?: string;
  url?: string;
  value?: string;
  parsedValue?: unknown;
  actionTs?: string;
}

export interface SlackBlockActionInboxEvent {
  channel: string;
  threadTs: string;
  userId: string;
  text: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error("Slack blocks must be a JSON array of objects.");
  }
  return value as Record<string, unknown>[];
}

function tryParseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function joinNonEmpty(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
}

function buildHeaderBlock(title: string | undefined): SlackBlock[] {
  if (!title?.trim()) return [];
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: title.trim().slice(0, 150),
      },
    },
  ];
}

function buildSectionBlock(text: string | undefined): SlackBlock[] {
  if (!text?.trim()) return [];
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: text.trim(),
      },
    },
  ];
}

function buildFooterBlocks(footer: string | undefined): SlackBlock[] {
  if (!footer?.trim()) return [];
  return [
    { type: "divider" },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: footer.trim() }],
    },
  ];
}

function prefixDiffLines(text: string, prefix: "+" | "-"): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function getActionText(action: Record<string, unknown>): string | undefined {
  const text = asRecord(action.text);
  return asString(text?.text);
}

function normalizeAction(action: Record<string, unknown>): SlackNormalizedBlockAction | null {
  const actionId = asString(action.action_id);
  if (!actionId) return null;

  const value = asString(action.value);
  return {
    actionId,
    blockId: asString(action.block_id),
    text: getActionText(action),
    type: asString(action.type),
    style: asString(action.style),
    value,
    parsedValue: tryParseJson(value),
    actionTs: asString(action.action_ts),
  };
}

function sanitizeNormalizedActions(
  actions: SlackNormalizedBlockAction[],
): Array<Record<string, unknown>> {
  return actions.map((action) => ({
    actionId: action.actionId,
    blockId: action.blockId ?? null,
    text: action.text ?? null,
    type: action.type ?? null,
    style: action.style ?? null,
    value: action.value ?? null,
    parsedValue: action.parsedValue ?? null,
    actionTs: action.actionTs ?? null,
  }));
}

export function normalizeSlackBlocksInput(blocks: unknown): SlackBlock[] {
  return asRecordArray(blocks).map((block) => ({ ...block }));
}

export function summarizeSlackBlocksForPolicy(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "0";
  return String(blocks.length);
}

export function encodeSlackBlockActionValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function buildSlackBlockKitPromptGuidelines(): string[] {
  return [
    "Slack supports an optional blocks parameter for rich Block Kit messages. text stays required as fallback / notification text.",
    "Use slack_blocks_build when you want a template-generated blocks array instead of hand-writing JSON.",
    "A block kit payload is a JSON array of block objects, for example:",
    '[{"type":"section","text":{"type":"mrkdwn","text":"*Deploy complete*\\nBranch: `main`"}},{"type":"actions","elements":[{"type":"button","text":{"type":"plain_text","text":"Rollback"},"action_id":"deploy.rollback","style":"danger","value":"rollback:prod"}]}]',
    "Button actions should set stable action_id values. Put machine-readable context in the button value string (plain text or JSON string).",
  ];
}

export function buildSlackBlocksTemplate(
  input: SlackBlocksTemplateInput,
): SlackBlocksTemplateResult {
  switch (input.template) {
    case "code_snippet": {
      if (!input.code?.trim()) {
        throw new Error('Template "code_snippet" requires a non-empty code value.');
      }
      const language = input.language?.trim() || "text";
      const codeFence = `\`\`\`${language}\n${input.code.trim()}\n\`\`\``;
      const blocks = [
        ...buildHeaderBlock(input.title ?? "Code snippet"),
        ...buildSectionBlock(joinNonEmpty([input.text, codeFence])),
        ...buildFooterBlocks(input.footer),
      ];
      return {
        blocks,
        fallbackText: joinNonEmpty([input.title ?? "Code snippet", input.text, input.code]),
      };
    }
    case "status_report": {
      if (!input.title?.trim()) {
        throw new Error('Template "status_report" requires a title.');
      }
      const fields = (input.fields ?? []).slice(0, 10).map((field) => ({
        type: "mrkdwn",
        text: `*${field.label.trim()}*\n${field.value.trim()}`,
      }));
      const blocks: SlackBlock[] = [
        ...buildHeaderBlock(input.title),
        ...buildSectionBlock(input.text),
      ];
      if (fields.length > 0) {
        blocks.push({ type: "section", fields });
      }
      blocks.push(...buildFooterBlocks(input.footer));
      const fieldLines = (input.fields ?? []).map((field) => `${field.label}: ${field.value}`);
      return {
        blocks,
        fallbackText: joinNonEmpty([input.title, input.text, fieldLines.join("\n"), input.footer]),
      };
    }
    case "action_buttons": {
      if (!input.text?.trim()) {
        throw new Error('Template "action_buttons" requires text.');
      }
      const buttons = (input.buttons ?? []).map((button) => {
        const element: Record<string, unknown> = {
          type: "button",
          text: { type: "plain_text", text: button.text.trim().slice(0, 75) },
          action_id: button.action_id.trim(),
        };
        if (button.value) element.value = button.value;
        if (button.style) element.style = button.style;
        if (button.url) element.url = button.url;
        return element;
      });
      if (buttons.length === 0) {
        throw new Error('Template "action_buttons" requires at least one button.');
      }
      const blocks: SlackBlock[] = [
        ...buildHeaderBlock(input.title),
        ...buildSectionBlock(input.text),
        { type: "actions", elements: buttons },
        ...buildFooterBlocks(input.footer),
      ];
      return {
        blocks,
        fallbackText: joinNonEmpty([
          input.title,
          input.text,
          `Actions: ${buttons
            .map((button) => String((button.text as { text?: string }).text ?? "action"))
            .join(", ")}`,
        ]),
      };
    }
    case "diff_view": {
      if (!input.before?.trim() && !input.after?.trim()) {
        throw new Error('Template "diff_view" requires before and/or after text.');
      }
      const removed = input.before?.trim()
        ? `*Removed*\n\`\`\`diff\n${prefixDiffLines(input.before.trim(), "-")}\n\`\`\``
        : undefined;
      const added = input.after?.trim()
        ? `*Added*\n\`\`\`diff\n${prefixDiffLines(input.after.trim(), "+")}\n\`\`\``
        : undefined;
      const blocks = [
        ...buildHeaderBlock(input.title ?? "Diff view"),
        ...buildSectionBlock(joinNonEmpty([input.text, removed, added])),
        ...buildFooterBlocks(input.footer),
      ];
      return {
        blocks,
        fallbackText: joinNonEmpty([
          input.title ?? "Diff view",
          input.text,
          input.before,
          input.after,
        ]),
      };
    }
    default:
      throw new Error(
        `Unknown block template ${JSON.stringify(input.template)}. Use one of: code_snippet, status_report, action_buttons, diff_view.`,
      );
  }
}

export function extractSlackBlockActionsPayloadFromEnvelope(
  envelope: Record<string, unknown>,
): Record<string, unknown> | null {
  if (envelope.type !== "interactive") return null;

  const payloadValue = envelope.payload;
  let payload: unknown = payloadValue;
  if (typeof payloadValue === "string") {
    try {
      payload = JSON.parse(payloadValue) as unknown;
    } catch {
      return null;
    }
  }

  if (!isRecord(payload)) return null;
  return payload.type === "block_actions" ? payload : null;
}

export function normalizeSlackBlockActionPayload(
  payload: Record<string, unknown>,
): SlackBlockActionInboxEvent | null {
  const user = asRecord(payload.user);
  const container = asRecord(payload.container);
  const channel = asRecord(payload.channel);
  const message = asRecord(payload.message);
  const actions = Array.isArray(payload.actions)
    ? payload.actions
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

  const normalizedActions = actions
    .map(normalizeAction)
    .filter((action): action is SlackNormalizedBlockAction => Boolean(action));
  if (normalizedActions.length === 0) return null;

  const channelId =
    asString(container?.channel_id) ??
    asString(channel?.id) ??
    asString((message?.channel as Record<string, unknown> | undefined)?.id);
  const messageTs = asString(container?.message_ts) ?? asString(message?.ts);
  const threadTs = asString(container?.thread_ts) ?? asString(message?.thread_ts) ?? messageTs;
  const userId = asString(user?.id);

  if (!channelId || !threadTs || !userId || !messageTs) return null;

  const primaryAction = normalizedActions[0];
  const label = primaryAction.text?.trim() ? `"${primaryAction.text.trim()}"` : "button";
  const timestamp = primaryAction.actionTs ?? messageTs;

  return {
    channel: channelId,
    threadTs,
    userId,
    text: `Clicked Slack ${label} (action_id: ${primaryAction.actionId}).`,
    timestamp,
    metadata: {
      kind: "slack_block_action",
      actionId: primaryAction.actionId,
      blockId: primaryAction.blockId ?? null,
      value: primaryAction.value ?? null,
      parsedValue: primaryAction.parsedValue ?? null,
      actionText: primaryAction.text ?? null,
      channel: channelId,
      threadTs,
      messageTs,
      actions: sanitizeNormalizedActions(normalizedActions),
    },
  };
}
