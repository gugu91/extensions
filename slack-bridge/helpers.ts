import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Settings ────────────────────────────────────────────

export interface SlackBridgeSettings {
  botToken?: string;
  appToken?: string;
  allowedUsers?: string[];
  defaultChannel?: string;
  suggestedPrompts?: { title: string; message: string }[];
  autoConnect?: boolean;
}

export function loadSettings(settingsPath?: string): SlackBridgeSettings {
  const p = settingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const content = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(content);
    return (parsed["slack-bridge"] as SlackBridgeSettings) ?? {};
  } catch {
    return {};
  }
}

// ─── Allowlist ───────────────────────────────────────────

export function buildAllowlist(settings: SlackBridgeSettings, envVar?: string): Set<string> | null {
  if (settings.allowedUsers && settings.allowedUsers.length > 0) {
    return new Set(settings.allowedUsers);
  }
  if (envVar) {
    return new Set(
      envVar
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }
  return null;
}

export function isUserAllowed(allowlist: Set<string> | null, userId: string): boolean {
  return allowlist === null || allowlist.has(userId);
}

// ─── Inbox formatting ────────────────────────────────────

export interface InboxMessage {
  channel: string;
  threadTs: string;
  userId: string;
  text: string;
  timestamp: string;
  isChannelMention?: boolean;
}

export function formatInboxMessages(
  messages: InboxMessage[],
  userNames: Map<string, string>,
): string {
  const lines = messages.map((m) => {
    const n = userNames.get(m.userId) ?? m.userId;
    if (m.isChannelMention) {
      return `[thread ${m.threadTs}] (channel mention in <#${m.channel}>) ${n}: ${m.text}`;
    }
    return `[thread ${m.threadTs}] ${n}: ${m.text}`;
  });

  return `New Slack messages:\n${lines.join("\n")}\n\nRespond to each via slack_send with the correct thread_ts.`;
}

// ─── Slack API encoding ──────────────────────────────────

export const FORM_METHODS = new Set([
  "auth.test",
  "users.info",
  "conversations.list",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "apps.connections.open",
]);

export function buildSlackRequest(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let serialized: string | undefined;
  const needsJson = !FORM_METHODS.has(method);

  if (body) {
    if (needsJson) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      serialized = JSON.stringify(body);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      serialized = new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, String(v)]),
      ).toString();
    }
  }

  return {
    url: `https://slack.com/api/${method}`,
    init: {
      method: "POST",
      headers,
      ...(serialized ? { body: serialized } : {}),
    },
  };
}

// ─── Mention stripping ───────────────────────────────────

export function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
}

// ─── Channel ID detection ────────────────────────────────

export function isChannelId(nameOrId: string): boolean {
  return /^[CGD][A-Z0-9]+$/.test(nameOrId);
}
