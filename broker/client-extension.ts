import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrokerClient } from "./client.js";

// ─── Tool registration ───────────────────────────────────

export function registerBrokerTools(
  pi: ExtensionAPI,
  client: BrokerClient,
  agentName: string,
): void {
  // ─── slack_inbox ─────────────────────────────────────

  pi.registerTool({
    name: "slack_inbox",
    label: "Slack Inbox",
    description:
      "Return pending Slack messages that arrived since the last check, then clear the queue.",
    promptSnippet: "Check for new incoming Slack messages.",
    promptGuidelines: [
      "You are connected to Slack via the slack-bridge extension.",
      "New Slack messages are queued — call `slack_inbox` periodically (e.g. between tasks or when you see the badge count increase) to check for pending messages.",
      "Reply to each message with `slack_send`, passing the correct `thread_ts`.",
      "Pick a fun, creative agent name based on your current task (e.g. 'Refactor Raccoon', 'Bug Squasher 3000', 'CSS Wizard'). Choose a matching emoji.",
      "First message in a new thread: use full format — '🦝 (Refactor Raccoon) Just finished splitting the auth module.'",
      "Follow-up messages in the same thread: just prefix with the emoji — '🦝 Found two more files to split.'",
      "Keep the same name and emoji for the duration of the task. Pick a new one when the task changes.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const messages = await client.pollInbox();

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: "(no new messages)" }],
          details: { count: 0 },
        };
      }

      // Auto-ack all received messages
      const ids = messages.map((m) => m.id);
      await client.ackMessages(ids);

      const lines = messages.map((m) => {
        const name = m.userName ?? m.userId;
        const prefix = m.isChannelMention
          ? `[thread ${m.threadId}] (channel mention in <#${m.channel}>) ${name}`
          : `[thread ${m.threadId}] ${name}`;
        return `${prefix} (${m.timestamp}): ${m.text}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: messages.length },
      };
    },
  });

  // ─── slack_send ──────────────────────────────────────

  pi.registerTool({
    name: "slack_send",
    label: "Slack Send",
    description: "Send a message in a Slack assistant thread.",
    promptSnippet: "Reply in a Slack assistant thread.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text (Slack markdown)" }),
      thread_ts: Type.Optional(
        Type.String({
          description: "Thread to reply in. Omit to start a new conversation.",
        }),
      ),
    }),
    async execute(_id, params) {
      const threadId = params.thread_ts ?? "";
      await client.send(threadId, params.text, { agent: agentName });

      return {
        content: [
          {
            type: "text",
            text: threadId
              ? `Replied in thread ${threadId}.`
              : "Sent message. Check inbox for thread_ts.",
          },
        ],
        details: { threadId },
      };
    },
  });

  // ─── slack_read ──────────────────────────────────────

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
      const result = await client.slackProxy("conversations.replies", {
        ts: params.thread_ts,
        limit: params.limit ?? 20,
      });

      const msgs = (result.messages as Record<string, unknown>[]) ?? [];
      const lines = msgs.map((m) => {
        const name = (m.user as string) ?? "bot";
        const txt = (m.text as string) ?? "";
        const ts = m.ts as string;
        return `[${ts}] ${name}: ${txt}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: { count: msgs.length },
      };
    },
  });

  // ─── slack_post_channel ──────────────────────────────

  pi.registerTool({
    name: "slack_post_channel",
    label: "Slack Post Channel",
    description:
      "Post a message to a Slack channel (by name or ID), optionally in a thread. Uses defaultChannel from settings if channel is omitted.",
    promptSnippet: "Post a message to a Slack channel.",
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
      const channel = params.channel ?? "";
      await client.send(params.thread_ts ?? "", params.text, {
        agent: agentName,
        channel,
        type: "channel_post",
      });

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Replied in thread ${params.thread_ts} in channel ${channel}.`
              : `Posted to ${channel || "default channel"}.`,
          },
        ],
        details: { channel },
      };
    },
  });

  // ─── slack_read_channel ──────────────────────────────

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
      const method = params.thread_ts ? "conversations.replies" : "conversations.history";
      const rpcParams: Record<string, unknown> = {
        channel: params.channel,
        limit: params.limit ?? 20,
      };
      if (params.thread_ts) rpcParams.ts = params.thread_ts;

      const result = await client.slackProxy(method, rpcParams);
      const msgs = (result.messages as Record<string, unknown>[]) ?? [];

      const lines = msgs.map((m) => {
        const name = (m.user as string) ?? "bot";
        const txt = (m.text as string) ?? "";
        const ts = m.ts as string;
        return `[${ts}] ${name}: ${txt}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: { count: msgs.length, channel: params.channel },
      };
    },
  });

  // ─── slack_create_channel ────────────────────────────

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
      const result = await client.slackProxy("conversations.create", {
        name: params.name,
        ...(params.topic ? { topic: params.topic } : {}),
        ...(params.purpose ? { purpose: params.purpose } : {}),
      });

      const ch = result.channel as { id: string; name: string } | undefined;
      const name = ch?.name ?? params.name;
      const id = ch?.id ?? "unknown";

      return {
        content: [{ type: "text", text: `Created channel #${name} (${id})` }],
        details: { id, name },
      };
    },
  });
}
