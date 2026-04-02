import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@gugu91/pi-ext-types/typebox";
import type { InboxMessage } from "./helpers.js";
import type { SlackResult } from "./slack-api.js";

export interface RegisterSlackToolsDeps {
  getBotToken: () => string;
  getDefaultChannel: () => string | undefined;
  getSecurityPrompt: () => string;
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
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  trackOutboundThread: (threadTs: string, channelId: string) => void;
  claimThreadOwnership: (threadTs: string, channelId: string) => void;
  clearPendingEyes: (threadTs: string) => void;
  registerConfirmationRequest: (
    threadTs: string,
    tool: string,
    action: string,
  ) => {
    status: "created" | "refreshed" | "conflict";
    conflict?: { toolPattern: string; action: string };
  };
}

function buildSlackInboxPromptGuidelines(): string[] {
  return [
    "You are connected to Slack via the slack-bridge extension.",
    "When you receive messages: ACK briefly, do the work, report blockers immediately, report the outcome when done.",
    "Security guardrails may be active for Slack-triggered actions. Check the current security prompt in each message for restrictions.",
    "When a tool requires confirmation, call slack_confirm_action first and wait for approval in the same thread.",
  ];
}

export function registerSlackTools(pi: ExtensionAPI, deps: RegisterSlackToolsDeps): void {
  const {
    getBotToken,
    getDefaultChannel,
    getSecurityPrompt,
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
    registerConfirmationRequest,
  } = deps;

  pi.registerTool({
    name: "slack_inbox",
    label: "Slack Inbox",
    description:
      "Return pending Slack messages that arrived since the last check, then clear the queue.",
    promptSnippet: "Check for new incoming Slack messages.",
    promptGuidelines: buildSlackInboxPromptGuidelines(),
    parameters: Type.Object({}),
    async execute() {
      const securityPrompt = getSecurityPrompt();
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
      requireToolPolicy(
        "slack_send",
        params.thread_ts,
        `thread_ts=${params.thread_ts ?? ""} | text=${params.text}`,
      );

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

      const response = await slack("chat.postMessage", getBotToken(), body);
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
      requireToolPolicy(
        "slack_read",
        params.thread_ts,
        `thread_ts=${params.thread_ts} | limit=${params.limit ?? 20}`,
      );

      const channel = (await resolveFollowerReplyChannel(params.thread_ts)) ?? getLastDmChannel();
      if (!channel) {
        throw new Error("Unknown thread.");
      }

      const response = await slack("conversations.replies", getBotToken(), {
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
      requireToolPolicy(
        "slack_create_channel",
        undefined,
        `name=${params.name} | topic=${params.topic ?? ""} | purpose=${params.purpose ?? ""}`,
      );

      const response = await slack("conversations.create", getBotToken(), {
        name: params.name,
      });
      const channel = response.channel as { id: string; name: string };

      if (params.topic) {
        await slack("conversations.setTopic", getBotToken(), {
          channel: channel.id,
          topic: params.topic,
        });
      }
      if (params.purpose) {
        await slack("conversations.setPurpose", getBotToken(), {
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
      requireToolPolicy(
        "slack_post_channel",
        params.thread_ts,
        `channel=${params.channel ?? defaultChannel ?? ""} | thread_ts=${params.thread_ts ?? ""} | text=${params.text}`,
      );

      const resolvedThreadChannel = await resolveFollowerReplyChannel(params.thread_ts);
      const channelInput = params.channel ?? getDefaultChannel();
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

      const response = await slack("chat.postMessage", getBotToken(), body);
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
      requireToolPolicy(
        "slack_read_channel",
        params.thread_ts,
        `channel=${params.channel} | thread_ts=${params.thread_ts ?? ""} | limit=${params.limit ?? 20}`,
      );

      const channelId = await resolveChannel(params.channel);
      const limit = params.limit ?? 20;

      let messages: Record<string, unknown>[];
      if (params.thread_ts) {
        const response = await slack("conversations.replies", getBotToken(), {
          channel: channelId,
          ts: params.thread_ts,
          limit,
        });
        messages = response.messages as Record<string, unknown>[];
      } else {
        const response = await slack("conversations.history", getBotToken(), {
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
      const channelId = await resolveFollowerReplyChannel(params.thread_ts);
      if (!channelId) {
        throw new Error(`No active Slack thread for thread_ts: ${params.thread_ts}`);
      }

      const confirmMessage =
        `⚠️ *Action requires confirmation*\n\n` +
        `Tool: \`${params.tool}\`\n` +
        `Action: ${params.action}\n\n` +
        `Reply *yes* to approve or *no* to reject.`;

      const registration = registerConfirmationRequest(
        params.thread_ts,
        params.tool,
        params.action,
      );
      if (registration.status === "conflict") {
        throw new Error(
          `Thread ${params.thread_ts} already has a pending confirmation for tool "${registration.conflict?.toolPattern}" and action ${JSON.stringify(registration.conflict?.action ?? "")}. Wait for a reply or expiry before requesting another action in the same thread.`,
        );
      }

      if (registration.status === "refreshed") {
        return {
          content: [
            {
              type: "text",
              text: `A matching confirmation request is already pending in thread ${params.thread_ts}. Wait for the user's response via slack_inbox before proceeding.`,
            },
          ],
          details: { thread_ts: params.thread_ts, tool: params.tool, status: registration.status },
        };
      }

      await slack("chat.postMessage", getBotToken(), {
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
        details: { thread_ts: params.thread_ts, tool: params.tool, status: registration.status },
      };
    },
  });
}
