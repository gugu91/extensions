import os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@gugu91/pi-ext-types/typebox";
import type { InboxMessage } from "./helpers.js";
import type { SlackResult } from "./slack-api.js";
import {
  buildSlackCanvasCreateRequest,
  buildSlackCanvasEditRequest,
  buildSlackCanvasSectionsLookupRequest,
  extractSlackChannelCanvasId,
  normalizeSlackCanvasUpdateMode,
  pickSlackCanvasSectionId,
} from "./canvases.js";
import { resolveScheduledWakeupFireAt } from "./scheduled-wakeups.js";
import { performSlackUpload, prepareSlackUpload } from "./slack-upload.js";

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
    "Use slack_upload instead of giant inline code blocks when sharing diffs, logs, screenshots, generated files, or long snippets.",
    "Use slack_schedule for reminders, timed announcements, and delayed follow-ups instead of waiting around to send a message later.",
    "Use slack_pin for important Slack messages you want highlighted in the conversation, and use slack_bookmark for durable channel-header links like repos, dashboards, docs, and runbooks.",
    "When uploading from a local path, only files inside the current working directory or the system temp directory are allowed.",
  ];
}

function getSlackCanvasSummary(markdown?: string): string {
  if (markdown == null || markdown.length === 0) return "(empty canvas)";
  const collapsed = markdown.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 77)}...`;
}

function isSlackMethodError(err: unknown, method: string, ...codes: string[]): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  return codes.some((code) => err.message.includes(`Slack ${method}: ${code}`));
}

function normalizeSlackPinAction(action: string): "pin" | "unpin" {
  const normalized = action.trim().toLowerCase();
  if (normalized === "pin" || normalized === "unpin") {
    return normalized;
  }
  throw new Error("action must be 'pin' or 'unpin'.");
}

function normalizeSlackBookmarkAction(action: string): "add" | "remove" | "list" {
  const normalized = action.trim().toLowerCase();
  if (normalized === "add" || normalized === "remove" || normalized === "list") {
    return normalized;
  }
  throw new Error("action must be 'add', 'remove', or 'list'.");
}

function normalizeSlackBookmarkUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("url is required when action='add'.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("url must be an absolute http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http or https.");
  }

  return parsed.toString();
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
    const info = await slack("conversations.info", getBotToken(), { channel: channelId });
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

  async function resolveSlackTargetChannel(
    threadTs: string | undefined,
    channel: string | undefined,
  ): Promise<string> {
    const trackedThreadChannel = threadTs ? await resolveFollowerReplyChannel(threadTs) : null;
    if (trackedThreadChannel) {
      return trackedThreadChannel;
    }

    const channelInput = channel?.trim();
    if (channelInput) {
      return resolveChannel(channelInput);
    }

    if (!threadTs) {
      const dmChannel = getLastDmChannel();
      if (dmChannel) {
        return dmChannel;
      }

      const defaultChannel = getDefaultChannel();
      if (defaultChannel) {
        return resolveChannel(defaultChannel);
      }
    }

    throw new Error(
      threadTs
        ? "Unknown Slack thread. If you know the destination channel, pass channel explicitly."
        : "No active Slack thread. Provide channel or configure defaultChannel in settings.json.",
    );
  }

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
    name: "slack_upload",
    label: "Slack Upload",
    description:
      "Upload a file or snippet into Slack using the external upload flow. Supports inline content and guarded local file paths.",
    promptSnippet:
      "Upload files, snippets, diffs, logs, screenshots, or generated artifacts into Slack threads when inline text would be awkward or too long.",
    parameters: Type.Object({
      content: Type.Optional(
        Type.String({
          description:
            "Inline content to upload as a snippet or file. Provide exactly one of content or path.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            "Local file path to upload. For safety, only files inside the current working directory or system temp directory are allowed.",
        }),
      ),
      filename: Type.Optional(
        Type.String({
          description:
            "Filename shown in Slack. Required for inline content, optional for path uploads.",
        }),
      ),
      filetype: Type.Optional(
        Type.String({
          description: "Optional filetype/snippet language override, e.g. diff, typescript, json.",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Optional Slack title for the uploaded file" }),
      ),
      channel: Type.Optional(
        Type.String({
          description:
            "Optional channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({ description: "Optional thread timestamp to attach the upload to" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_upload",
        params.thread_ts,
        `thread_ts=${params.thread_ts ?? ""} | channel=${params.channel ?? getDefaultChannel() ?? ""} | filename=${params.filename ?? ""} | path=${params.path ?? ""} | content_length=${params.content?.length ?? 0}`,
      );

      const upload = await prepareSlackUpload(params, process.cwd(), os.tmpdir());
      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const { fileId, response } = await performSlackUpload({
        upload,
        channelId,
        threadTs: params.thread_ts,
        slack,
        token: getBotToken(),
      });

      if (params.thread_ts) {
        trackOutboundThread(params.thread_ts, channelId);
        claimThreadOwnership(params.thread_ts, channelId);
        clearPendingEyes(params.thread_ts);
      }

      const uploadedFiles = Array.isArray(response.files)
        ? (response.files as Record<string, unknown>[])
        : [];
      const uploadedFile = uploadedFiles[0];
      const permalink =
        uploadedFile && typeof uploadedFile.permalink === "string"
          ? uploadedFile.permalink
          : undefined;

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Uploaded \`${upload.filename}\` to thread ${params.thread_ts}.`
              : `Uploaded \`${upload.filename}\` to channel ${params.channel ?? channelId}.`,
          },
        ],
        details: {
          fileId,
          channel: channelId,
          filename: upload.filename,
          title: upload.title,
          source: upload.source,
          ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
          ...(permalink ? { permalink } : {}),
          ...(upload.resolvedPath ? { path: upload.resolvedPath } : {}),
        },
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
        `channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | text=${params.text}`,
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
    name: "slack_pin",
    label: "Slack Pin",
    description: "Pin or unpin a Slack message by timestamp.",
    promptSnippet:
      "Pin important Slack messages like decisions, confirmations, or follow-up items. Unpin stale ones when they are no longer relevant.",
    parameters: Type.Object({
      action: Type.String({ description: "'pin' to pin a message or 'unpin' to remove the pin" }),
      message_ts: Type.String({ description: "Timestamp (ts) of the message to pin or unpin" }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({
          description: "Optional thread timestamp used to resolve the current channel",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_pin",
        params.thread_ts,
        `action=${params.action} | channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | message_ts=${params.message_ts}`,
      );

      const action = normalizeSlackPinAction(params.action);
      const messageTs = params.message_ts.trim();
      if (!messageTs) {
        throw new Error("message_ts is required.");
      }

      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const method = action === "pin" ? "pins.add" : "pins.remove";
      const body = { channel: channelId, timestamp: messageTs };

      try {
        await slack(method, getBotToken(), body);
      } catch (err) {
        if (action === "pin" && isSlackMethodError(err, "pins.add", "already_pinned")) {
          return {
            content: [
              {
                type: "text",
                text: `Message ${messageTs} is already pinned in channel ${params.channel ?? channelId}.`,
              },
            ],
            details: {
              channel: channelId,
              message_ts: messageTs,
              action,
              status: "already_pinned",
            },
          };
        }

        if (action === "unpin" && isSlackMethodError(err, "pins.remove", "no_pin", "not_pinned")) {
          return {
            content: [
              {
                type: "text",
                text: `Message ${messageTs} is not currently pinned in channel ${params.channel ?? channelId}.`,
              },
            ],
            details: { channel: channelId, message_ts: messageTs, action, status: "not_pinned" },
          };
        }

        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text:
              action === "pin"
                ? `Pinned message ${messageTs} in channel ${params.channel ?? channelId}.`
                : `Unpinned message ${messageTs} in channel ${params.channel ?? channelId}.`,
          },
        ],
        details: {
          channel: channelId,
          message_ts: messageTs,
          action,
          status: action === "pin" ? "pinned" : "unpinned",
        },
      };
    },
  });

  pi.registerTool({
    name: "slack_bookmark",
    label: "Slack Bookmark",
    description:
      "Add, list, or remove channel bookmarks for durable links like repos, dashboards, docs, and runbooks.",
    promptSnippet:
      "Use bookmarks for persistent channel-header links. Add repos, dashboards, docs, and runbooks; list existing bookmarks; remove stale ones by ID.",
    parameters: Type.Object({
      action: Type.String({ description: "'add', 'list', or 'remove'" }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({
          description: "Optional thread timestamp used to resolve the current channel",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Bookmark title (required when action='add')" }),
      ),
      url: Type.Optional(Type.String({ description: "Bookmark URL (required when action='add')" })),
      emoji: Type.Optional(
        Type.String({ description: "Optional emoji label for the bookmark, e.g. :rocket:" }),
      ),
      bookmark_id: Type.Optional(
        Type.String({ description: "Bookmark ID (required when action='remove')" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_bookmark",
        params.thread_ts,
        `action=${params.action} | channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | title=${params.title ?? ""} | url=${params.url ?? ""} | bookmark_id=${params.bookmark_id ?? ""}`,
      );

      const action = normalizeSlackBookmarkAction(params.action);
      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const channelLabel = params.channel ?? channelId;

      if (action === "list") {
        const response = await slack("bookmarks.list", getBotToken(), { channel_id: channelId });
        const bookmarks = Array.isArray(response.bookmarks)
          ? (response.bookmarks as Array<Record<string, unknown>>)
          : [];
        const lines = bookmarks.map((bookmark) => {
          const id = typeof bookmark.id === "string" ? bookmark.id : "(unknown-id)";
          const title = typeof bookmark.title === "string" ? bookmark.title : "(untitled)";
          const link = typeof bookmark.link === "string" ? bookmark.link : "(no link)";
          const emoji =
            typeof bookmark.emoji === "string" && bookmark.emoji.length > 0
              ? `${bookmark.emoji} `
              : "";
          return `- ${id}: ${emoji}${title} -> ${link}`;
        });

        return {
          content: [
            {
              type: "text",
              text:
                lines.length > 0
                  ? `Bookmarks in ${channelLabel}:\n${lines.join("\n")}`
                  : `No bookmarks found in ${channelLabel}.`,
            },
          ],
          details: { channel: channelId, count: bookmarks.length, bookmarks },
        };
      }

      if (action === "add") {
        const title = params.title?.trim();
        if (!title) {
          throw new Error("title is required when action='add'.");
        }

        const link = normalizeSlackBookmarkUrl(params.url ?? "");
        const emoji = params.emoji?.trim();
        const response = await slack("bookmarks.add", getBotToken(), {
          channel_id: channelId,
          title,
          type: "link",
          link,
          ...(emoji ? { emoji } : {}),
        });
        const bookmark =
          response.bookmark && typeof response.bookmark === "object"
            ? (response.bookmark as Record<string, unknown>)
            : undefined;
        const bookmarkId = bookmark && typeof bookmark.id === "string" ? bookmark.id : undefined;

        return {
          content: [
            {
              type: "text",
              text: `Added bookmark '${title}' to ${channelLabel}.`,
            },
          ],
          details: {
            channel: channelId,
            action,
            title,
            url: link,
            ...(emoji ? { emoji } : {}),
            ...(bookmarkId ? { bookmark_id: bookmarkId } : {}),
          },
        };
      }

      const bookmarkId = params.bookmark_id?.trim();
      if (!bookmarkId) {
        throw new Error("bookmark_id is required when action='remove'.");
      }

      try {
        await slack("bookmarks.remove", getBotToken(), {
          channel_id: channelId,
          bookmark_id: bookmarkId,
        });
      } catch (err) {
        if (isSlackMethodError(err, "bookmarks.remove", "not_found")) {
          return {
            content: [
              {
                type: "text",
                text: `Bookmark ${bookmarkId} was not found in ${channelLabel}.`,
              },
            ],
            details: { channel: channelId, action, bookmark_id: bookmarkId, status: "not_found" },
          };
        }

        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text: `Removed bookmark ${bookmarkId} from ${channelLabel}.`,
          },
        ],
        details: { channel: channelId, action, bookmark_id: bookmarkId, status: "removed" },
      };
    },
  });

  pi.registerTool({
    name: "slack_schedule",
    label: "Slack Schedule",
    description:
      "Schedule a Slack message for later using chat.scheduleMessage. Supports relative delays and absolute times.",
    promptSnippet:
      "Schedule a Slack message for later instead of waiting around. Use it for reminders, timed announcements, and delayed follow-ups.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text (Slack markdown)" }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({ description: "Optional thread timestamp to reply in later" }),
      ),
      delay: Type.Optional(
        Type.String({ description: "Relative delay like 5m, 30s, 1h30m, or 1d" }),
      ),
      at: Type.Optional(
        Type.String({ description: "Absolute ISO-8601 UTC time, e.g. 2026-04-02T14:30:00Z" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_schedule",
        params.thread_ts,
        `channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | delay=${params.delay ?? ""} | at=${params.at ?? ""} | text=${params.text}`,
      );

      const text = params.text.trim();
      if (!text) {
        throw new Error("text is required");
      }

      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const fireAt = resolveScheduledWakeupFireAt({ delay: params.delay, at: params.at });
      const postAt = Math.floor(Date.parse(fireAt) / 1000);

      const body: Record<string, unknown> = {
        channel: channelId,
        text,
        post_at: postAt,
      };
      if (params.thread_ts) {
        body.thread_ts = params.thread_ts;
      }

      const response = await slack("chat.scheduleMessage", getBotToken(), body);
      const scheduledMessageId =
        typeof response.scheduled_message_id === "string"
          ? response.scheduled_message_id
          : undefined;

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Scheduled message for ${fireAt} in thread ${params.thread_ts}.`
              : `Scheduled message for ${fireAt} in channel ${params.channel ?? channelId}.`,
          },
        ],
        details: {
          channel: channelId,
          post_at: postAt,
          fire_at: fireAt,
          ...(scheduledMessageId ? { scheduled_message_id: scheduledMessageId } : {}),
          ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
        },
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
      requireToolPolicy(
        "slack_canvas_create",
        undefined,
        `kind=${params.kind ?? "standalone"} | channel=${params.channel ?? ""} | title=${params.title ?? ""}`,
      );

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

      const response = await slack(request.method, getBotToken(), request.body);
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
      requireToolPolicy(
        "slack_canvas_update",
        undefined,
        `canvas_id=${params.canvas_id ?? ""} | channel=${params.channel ?? ""} | mode=${params.mode ?? "append"} | section_contains_text=${params.section_contains_text ?? ""}`,
      );

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
          getBotToken(),
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
      await slack("canvases.edit", getBotToken(), request as unknown as Record<string, unknown>);

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
