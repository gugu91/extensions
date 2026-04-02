import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@gugu91/pi-ext-types/typebox";
import type { InboxMessage } from "./helpers.js";
import type { SecurityGuardrails } from "./guardrails.js";
import type { SlackResult } from "./slack-api.js";
import {
  buildSlackCanvasCreateRequest,
  buildSlackCanvasEditRequest,
  buildSlackCanvasSectionsLookupRequest,
  extractSlackChannelCanvasId,
  normalizeSlackCanvasUpdateMode,
  pickSlackCanvasSectionId,
} from "./canvases.js";

export interface RegisterSlackToolsDeps {
  botToken: string;
  defaultChannel?: string;
  securityPrompt: string;
  guardrails: SecurityGuardrails;
  inbox: InboxMessage[];
  slack: (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>;
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getLastDmChannel: () => string | null;
  updateBadge: () => void;
  resolveUser: (userId: string) => Promise<string>;
  resolveFollowerReplyChannel: (threadTs: string | undefined) => Promise<string | null>;
  resolveChannel: (nameOrId: string) => Promise<string>;
  rememberChannel: (name: string, channelId: string) => void;
  requireToolPolicy: (toolName: string, threadTs: string | undefined) => void;
  trackOutboundThread: (threadTs: string, channelId: string) => void;
  claimThreadOwnership: (threadTs: string, channelId: string) => void;
  clearPendingEyes: (threadTs: string) => void;
  getThreadChannel: (threadTs: string) => string | null;
  registerConfirmationRequest: (threadTs: string, tool: string, action: string) => void;
}

function buildSlackInboxPromptGuidelines(
  securityPrompt: string,
  guardrails: SecurityGuardrails,
): string[] {
  return [
    "You are connected to Slack via the slack-bridge extension.",
    "When you receive messages: ACK briefly, do the work, report blockers immediately, report the outcome when done.",
    ...(securityPrompt
      ? [
          "Security guardrails are active for Slack-triggered actions. Check the security prompt in each message for restrictions.",
          ...(guardrails.requireConfirmation?.length
            ? [
                `Before using tools matching these patterns: [${guardrails.requireConfirmation.join(", ")}], you MUST call slack_confirm_action first and wait for approval.`,
              ]
            : []),
          ...(guardrails.readOnly
            ? [
                "READ-ONLY MODE is active. Do NOT use write, edit, bash, or any tool that modifies files or state.",
              ]
            : []),
        ]
      : []),
  ];
}

function getSlackCanvasSummary(markdown?: string): string {
  if (markdown == null || markdown.length === 0) return "(empty canvas)";
  const collapsed = markdown.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 77)}...`;
}

export function registerSlackTools(pi: ExtensionAPI, deps: RegisterSlackToolsDeps): void {
  const {
    botToken,
    defaultChannel,
    securityPrompt,
    guardrails,
    inbox,
    slack,
    getAgentName,
    getAgentEmoji,
    getLastDmChannel,
    updateBadge,
    resolveUser,
    resolveFollowerReplyChannel,
    resolveChannel,
    rememberChannel,
    requireToolPolicy,
    trackOutboundThread,
    claimThreadOwnership,
    clearPendingEyes,
    getThreadChannel,
    registerConfirmationRequest,
  } = deps;

  async function resolveCanvasTarget(
    canvasId: string | undefined,
    channel: string | undefined,
  ): Promise<{ canvasId: string; channelId?: string; channelLabel?: string }> {
    const trimmedCanvasId = canvasId?.trim();
    if (trimmedCanvasId) {
      return { canvasId: trimmedCanvasId };
    }

    const channelInput = channel?.trim();
    if (!channelInput) {
      throw new Error("Provide either canvas_id or channel.");
    }

    const channelId = await resolveChannel(channelInput);
    const info = await slack("conversations.info", botToken, { channel: channelId });
    const resolvedCanvasId = extractSlackChannelCanvasId(info);
    if (!resolvedCanvasId) {
      throw new Error(
        `Slack did not expose a channel canvas ID in conversations.info for ${channelInput}. Provide canvas_id directly.`,
      );
    }

    return {
      canvasId: resolvedCanvasId,
      channelId,
      channelLabel: channelInput,
    };
  }

  pi.registerTool({
    name: "slack_inbox",
    label: "Slack Inbox",
    description:
      "Return pending Slack messages that arrived since the last check, then clear the queue.",
    promptSnippet: "Check for new incoming Slack messages.",
    promptGuidelines: buildSlackInboxPromptGuidelines(securityPrompt, guardrails),
    parameters: Type.Object({}),
    async execute() {
      const securityHeader = securityPrompt ? `${securityPrompt}\n\n` : "";
      const agentName = getAgentName();
      const agentEmoji = getAgentEmoji();

      if (inbox.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${securityHeader}(no new messages) — you are ${agentEmoji} ${agentName}`,
            },
          ],
          details: { count: 0 },
        };
      }

      const pending = inbox.splice(0, inbox.length);
      updateBadge();

      const lines: string[] = [];
      for (const message of pending) {
        const name = await resolveUser(message.userId);
        const prefix = message.isChannelMention
          ? `[thread ${message.threadTs}] (channel mention in <#${message.channel}>) ${name}`
          : `[thread ${message.threadTs}] ${name}`;
        lines.push(`${prefix} (${message.timestamp}): ${message.text}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `${securityHeader}You are ${agentEmoji} ${agentName}.\n\n${lines.join("\n")}`,
          },
        ],
        details: { count: pending.length },
      };
    },
  });

  pi.registerTool({
    name: "slack_send",
    label: "Slack Send",
    description: "Send a message in a Slack assistant thread.",
    promptSnippet:
      "Reply in a Slack assistant thread. When you receive a task: ACK briefly, do the work, report blockers immediately, report the outcome when done. Always reply where the task came from.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text (Slack markdown)" }),
      thread_ts: Type.Optional(
        Type.String({
          description: "Thread to reply in. Omit to start a new conversation.",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy("slack_send", params.thread_ts);

      const channel = (await resolveFollowerReplyChannel(params.thread_ts)) ?? getLastDmChannel();
      if (!channel) {
        throw new Error(
          "No active Slack thread. If you know the channel and thread_ts, use slack_post_channel instead.",
        );
      }

      const body: Record<string, unknown> = {
        channel,
        text: params.text,
        metadata: {
          event_type: "pi_agent_msg",
          event_payload: { agent: getAgentName() },
        },
      };
      if (params.thread_ts) body.thread_ts = params.thread_ts;

      const response = await slack("chat.postMessage", botToken, body);
      const ts = (response.message as { ts: string }).ts;
      const actualTs = params.thread_ts ?? ts;

      trackOutboundThread(actualTs, channel);
      claimThreadOwnership(actualTs, channel);

      if (params.thread_ts) {
        clearPendingEyes(params.thread_ts);
      }

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Replied in thread ${params.thread_ts}.`
              : `Sent message (thread_ts: ${ts}). Use this to continue the conversation.`,
          },
        ],
        details: { ts, channel },
      };
    },
  });

  pi.registerTool({
    name: "slack_read",
    label: "Slack Read",
    description: "Read messages from a Slack assistant thread.",
    promptSnippet: "Read messages from a Slack assistant thread.",
    parameters: Type.Object({
      thread_ts: Type.String({ description: "Thread to read." }),
      limit: Type.Optional(Type.Number({ description: "Max messages (default 20)" })),
    }),
    async execute(_id, params) {
      requireToolPolicy("slack_read", params.thread_ts);

      const channel = getThreadChannel(params.thread_ts) ?? getLastDmChannel();
      if (!channel) {
        throw new Error("Unknown thread.");
      }

      const response = await slack("conversations.replies", botToken, {
        channel,
        ts: params.thread_ts,
        limit: params.limit ?? 20,
      });

      const messages = response.messages as Record<string, unknown>[];
      const lines: string[] = [];
      for (const message of messages) {
        const userId = message.user as string | undefined;
        const name = userId ? await resolveUser(userId) : "bot";
        const text = (message.text as string) ?? "";
        const ts = message.ts as string;
        lines.push(`[${ts}] ${name}: ${text}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: { count: messages.length },
      };
    },
  });

  pi.registerTool({
    name: "slack_create_channel",
    label: "Slack Create Channel",
    description: "Create a new Slack channel, optionally setting its topic and purpose.",
    promptSnippet: "Create a new Slack channel.",
    parameters: Type.Object({
      name: Type.String({
        description: "Channel name (lowercase, no spaces, max 80 chars)",
      }),
      topic: Type.Optional(Type.String({ description: "Channel topic" })),
      purpose: Type.Optional(Type.String({ description: "Channel purpose" })),
    }),
    async execute(_id, params) {
      requireToolPolicy("slack_create_channel", undefined);

      const response = await slack("conversations.create", botToken, {
        name: params.name,
      });
      const channel = response.channel as { id: string; name: string };

      if (params.topic) {
        await slack("conversations.setTopic", botToken, {
          channel: channel.id,
          topic: params.topic,
        });
      }
      if (params.purpose) {
        await slack("conversations.setPurpose", botToken, {
          channel: channel.id,
          purpose: params.purpose,
        });
      }

      rememberChannel(channel.name, channel.id);

      return {
        content: [{ type: "text", text: `Created channel #${channel.name} (${channel.id})` }],
        details: { id: channel.id, name: channel.name },
      };
    },
  });

  pi.registerTool({
    name: "slack_post_channel",
    label: "Slack Post Channel",
    description:
      "Post a message to a Slack channel (by name or ID), optionally in a thread. Uses defaultChannel from settings if channel is omitted.",
    promptSnippet:
      "Post a message to a Slack channel or thread. Use when you need to target a specific channel or thread by ID.",
    parameters: Type.Object({
      channel: Type.Optional(
        Type.String({
          description: "Channel name or ID (uses defaultChannel from settings if omitted)",
        }),
      ),
      text: Type.String({ description: "Message text (Slack markdown)" }),
      thread_ts: Type.Optional(Type.String({ description: "Thread timestamp to reply in" })),
    }),
    async execute(_id, params) {
      requireToolPolicy("slack_post_channel", params.thread_ts);

      const resolvedThreadChannel = await resolveFollowerReplyChannel(params.thread_ts);
      const channelInput = params.channel ?? defaultChannel;
      let channelId = params.channel ? await resolveChannel(params.channel) : resolvedThreadChannel;

      if (!channelId && channelInput) {
        channelId = await resolveChannel(channelInput);
      }
      if (!channelId) {
        throw new Error("No channel specified and no defaultChannel configured in settings.json.");
      }

      const body: Record<string, unknown> = {
        channel: channelId,
        text: params.text,
        metadata: {
          event_type: "pi_agent_msg",
          event_payload: { agent: getAgentName() },
        },
      };
      if (params.thread_ts) body.thread_ts = params.thread_ts;

      const response = await slack("chat.postMessage", botToken, body);
      const ts = (response.message as { ts: string }).ts;
      const actualTs = params.thread_ts ?? ts;

      trackOutboundThread(actualTs, channelId);
      claimThreadOwnership(actualTs, channelId);

      const channelLabel = params.channel ?? resolvedThreadChannel ?? channelInput ?? channelId;
      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Replied in thread ${params.thread_ts} in channel ${channelLabel}.`
              : `Posted to #${channelLabel} (ts: ${ts}).`,
          },
        ],
        details: { ts, channel: channelId },
      };
    },
  });

  pi.registerTool({
    name: "slack_read_channel",
    label: "Slack Read Channel",
    description: "Read messages from a Slack channel or a thread within a channel.",
    promptSnippet: "Read messages from a Slack channel.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name or ID" }),
      thread_ts: Type.Optional(
        Type.String({ description: "Thread timestamp to read replies from" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
    }),
    async execute(_id, params) {
      requireToolPolicy("slack_read_channel", params.thread_ts);

      const channelId = await resolveChannel(params.channel);
      const limit = params.limit ?? 20;

      let messages: Record<string, unknown>[];
      if (params.thread_ts) {
        const response = await slack("conversations.replies", botToken, {
          channel: channelId,
          ts: params.thread_ts,
          limit,
        });
        messages = response.messages as Record<string, unknown>[];
      } else {
        const response = await slack("conversations.history", botToken, {
          channel: channelId,
          limit,
        });
        messages = (response.messages as Record<string, unknown>[]).reverse();
      }

      const lines: string[] = [];
      for (const message of messages) {
        const userId = message.user as string | undefined;
        const name = userId ? await resolveUser(userId) : "bot";
        const text = (message.text as string) ?? "";
        const ts = message.ts as string;
        lines.push(`[${ts}] ${name}: ${text}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: { count: messages.length, channel: channelId },
      };
    },
  });

  pi.registerTool({
    name: "slack_canvas_create",
    label: "Slack Canvas Create",
    description:
      "Create a Slack canvas with markdown content, either standalone or as a channel canvas.",
    promptSnippet:
      "Create a Slack canvas for long-lived documentation. Use standalone canvases for shared docs and kind='channel' for a channel's main canvas.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Canvas title" })),
      markdown: Type.Optional(
        Type.String({
          description: "Initial canvas content in markdown. Omit for an empty canvas.",
        }),
      ),
      channel: Type.Optional(
        Type.String({ description: "Channel name or ID to attach the canvas to" }),
      ),
      kind: Type.Optional(
        Type.String({ description: "Canvas kind: 'standalone' (default) or 'channel'" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy("slack_canvas_create", undefined);

      const channelInput = params.channel?.trim();
      const channelId = channelInput ? await resolveChannel(channelInput) : undefined;
      const request = buildSlackCanvasCreateRequest({
        kind: params.kind,
        title: params.title,
        markdown: params.markdown,
        channelId,
      });

      if (channelInput && channelId) {
        rememberChannel(channelInput.replace(/^#/, ""), channelId);
      }

      const response = await slack(request.method, botToken, request.body);
      const canvasId = response.canvas_id as string;
      const channelLabel = channelInput ?? channelId;
      const targetSummary =
        request.kind === "channel"
          ? `Created channel canvas ${canvasId}${channelLabel ? ` for ${channelLabel}` : ""}.`
          : `Created standalone canvas ${canvasId}${channelLabel ? ` attached to ${channelLabel}` : ""}.`;

      return {
        content: [
          {
            type: "text",
            text: `${targetSummary} Initial content: ${getSlackCanvasSummary(params.markdown)}`,
          },
        ],
        details: {
          canvas_id: canvasId,
          kind: request.kind,
          channel: channelId,
        },
      };
    },
  });

  pi.registerTool({
    name: "slack_canvas_update",
    label: "Slack Canvas Update",
    description:
      "Append, prepend, or replace content in an existing Slack canvas by canvas ID or channel canvas lookup.",
    promptSnippet:
      "Update a Slack canvas. Use mode='append' or 'prepend' for additive updates, or mode='replace' to replace the whole canvas or a matched section.",
    parameters: Type.Object({
      canvas_id: Type.Optional(Type.String({ description: "Canvas ID to update" })),
      channel: Type.Optional(
        Type.String({ description: "Channel name or ID whose channel canvas should be updated" }),
      ),
      markdown: Type.String({ description: "Canvas content in markdown" }),
      mode: Type.Optional(
        Type.String({ description: "Update mode: 'append' (default), 'prepend', or 'replace'" }),
      ),
      section_contains_text: Type.Optional(
        Type.String({
          description: "When mode='replace', replace the first section matching this text",
        }),
      ),
      section_type: Type.Optional(
        Type.String({
          description: "Optional section type for lookups: 'h1', 'h2', 'h3', or 'any_header'",
        }),
      ),
      section_index: Type.Optional(
        Type.Number({
          description:
            "Optional 1-based section index to choose when the lookup matches multiple sections",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy("slack_canvas_update", undefined);

      const mode = normalizeSlackCanvasUpdateMode(params.mode);
      if (params.section_contains_text && mode !== "replace") {
        throw new Error("section_contains_text can only be used with mode='replace'.");
      }
      if (params.section_index != null && !params.section_contains_text) {
        throw new Error("section_index can only be used together with section_contains_text.");
      }

      const target = await resolveCanvasTarget(params.canvas_id, params.channel);
      let sectionId: string | undefined;

      if (params.section_contains_text) {
        const lookup = buildSlackCanvasSectionsLookupRequest({
          canvasId: target.canvasId,
          containsText: params.section_contains_text,
          sectionType: params.section_type,
        });
        const response = await slack(
          "canvases.sections.lookup",
          botToken,
          lookup as unknown as Record<string, unknown>,
        );
        const sections = response.sections as Array<{ id?: string }> | undefined;
        try {
          sectionId = pickSlackCanvasSectionId(sections, params.section_index);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Canvas section lookup for '${params.section_contains_text}' failed: ${message}`,
          );
        }
      }

      const request = buildSlackCanvasEditRequest({
        canvasId: target.canvasId,
        markdown: params.markdown,
        mode,
        sectionId,
      });
      await slack("canvases.edit", botToken, request as unknown as Record<string, unknown>);

      const sectionSummary = params.section_contains_text
        ? ` Replaced section matching '${params.section_contains_text}'.`
        : "";
      const targetSummary = target.channelLabel
        ? `Updated channel canvas ${target.canvasId} for ${target.channelLabel}.`
        : `Updated canvas ${target.canvasId}.`;

      return {
        content: [
          {
            type: "text",
            text: `${targetSummary} Mode: ${mode}.${sectionSummary} Content: ${getSlackCanvasSummary(params.markdown)}`,
          },
        ],
        details: {
          canvas_id: target.canvasId,
          channel: target.channelId,
          mode,
          section_id: sectionId,
        },
      };
    },
  });

  pi.registerTool({
    name: "slack_confirm_action",
    label: "Slack Confirm Action",
    description:
      "Request user confirmation in a Slack thread before performing a dangerous action. Use when security guardrails require confirmation for a tool.",
    promptSnippet: "Request confirmation in Slack before dangerous actions.",
    parameters: Type.Object({
      thread_ts: Type.String({ description: "Thread to post confirmation request in" }),
      action: Type.String({ description: "Description of the action needing approval" }),
      tool: Type.String({ description: "Name of the tool that requires confirmation" }),
    }),
    async execute(_id, params) {
      const channelId = getThreadChannel(params.thread_ts);
      if (!channelId) {
        throw new Error(`No active Slack thread for thread_ts: ${params.thread_ts}`);
      }

      const confirmMessage =
        `⚠️ *Action requires confirmation*\n\n` +
        `Tool: \`${params.tool}\`\n` +
        `Action: ${params.action}\n\n` +
        `Reply *yes* to approve or *no* to reject.`;

      registerConfirmationRequest(params.thread_ts, params.tool, params.action);

      await slack("chat.postMessage", botToken, {
        channel: channelId,
        thread_ts: params.thread_ts,
        text: confirmMessage,
        metadata: {
          event_type: "pi_agent_msg",
          event_payload: { agent: getAgentName() },
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `Confirmation requested in thread ${params.thread_ts}. Wait for the user's response via slack_inbox before proceeding. If the user approves, continue with the action. If denied, inform them and skip the action.`,
          },
        ],
        details: { thread_ts: params.thread_ts, tool: params.tool },
      };
    },
  });
}
