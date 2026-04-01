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
  autoFollow?: boolean;
  agentName?: string;
  agentEmoji?: string;
  security?: {
    readOnly?: boolean;
    requireConfirmation?: string[];
    blockedTools?: string[];
  };
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

// ─── Agent list formatting ───────────────────────────────

export interface AgentDisplayInfo {
  emoji: string;
  name: string;
  id: string;
  status: "working" | "idle";
  metadata?: { cwd?: string; branch?: string; host?: string } | null;
}

export function shortenPath(p: string, homedir: string): string {
  if (p === homedir) return "~";
  const prefix = homedir.endsWith("/") ? homedir : homedir + "/";
  if (p.startsWith(prefix)) {
    return "~/" + p.slice(prefix.length);
  }
  return p;
}

export function buildIdentityReplyGuidelines(
  agentEmoji: string,
  agentName: string,
  location: string,
): [string, string, string] {
  return [
    `First message in a new thread: use exact format — '${agentEmoji} \`${agentName}\` reporting from \`${location}\`\\n\\n<message body>'`,
    `Follow-up messages in the same thread: keep the same full identity prefix — '${agentEmoji} \`${agentName}\` <message>'`,
    "Never use emoji-only prefixes (for example, '🦅 Working now') — always include the full identity prefix above on every post.",
  ];
}

export function buildAgentStableId(
  sessionFile?: string,
  host = os.hostname(),
  cwd = process.cwd(),
  leafId?: string,
): string {
  if (sessionFile) {
    return `${host}:session:${path.resolve(sessionFile)}`;
  }
  if (leafId) {
    return `${host}:leaf:${leafId}`;
  }
  return `${host}:cwd:${path.resolve(cwd)}`;
}

export interface FollowerThreadState {
  channelId: string;
  threadTs: string;
  userId: string;
  owner?: string;
}

export interface FollowerInboxEntry {
  message: {
    threadId?: string;
    sender?: string;
    body?: string;
    createdAt?: string;
    metadata: Record<string, unknown> | null;
  };
}

export interface FollowerInboxSyncResult {
  inboxMessages: InboxMessage[];
  threadUpdates: FollowerThreadState[];
  lastDmChannel: string | null;
  changed: boolean;
}

export function isDirectMessageChannel(channel: string): boolean {
  return /^D[A-Z0-9]+$/.test(channel);
}

export function syncFollowerInboxEntries(
  entries: FollowerInboxEntry[],
  existingThreads: ReadonlyMap<string, FollowerThreadState>,
  agentName: string,
  lastDmChannel: string | null,
): FollowerInboxSyncResult {
  let nextLastDmChannel = lastDmChannel;
  let changed = false;
  const threadUpdates: FollowerThreadState[] = [];

  const inboxMessages = entries.map((entry) => {
    const meta = entry.message.metadata ?? {};
    const threadTs = entry.message.threadId ?? "";
    const channel = typeof meta.channel === "string" ? meta.channel : "";
    const sender = entry.message.sender ?? "";

    if (threadTs && channel) {
      const existing = existingThreads.get(threadTs);
      const nextThread: FollowerThreadState = {
        channelId: channel,
        threadTs,
        userId: existing?.userId || sender,
        owner: existing?.owner ?? agentName,
      };

      if (
        !existing ||
        existing.channelId !== nextThread.channelId ||
        existing.userId !== nextThread.userId ||
        existing.owner !== nextThread.owner
      ) {
        changed = true;
      }

      threadUpdates.push(nextThread);
    }

    if (isDirectMessageChannel(channel) && nextLastDmChannel !== channel) {
      nextLastDmChannel = channel;
      changed = true;
    }

    return {
      channel,
      threadTs,
      userId: sender,
      text: entry.message.body ?? "",
      timestamp: entry.message.createdAt ?? "",
    };
  });

  return {
    inboxMessages,
    threadUpdates,
    lastDmChannel: nextLastDmChannel,
    changed,
  };
}

export interface FollowerReconnectUiUpdate {
  nextWasDisconnected: boolean;
  notify?: {
    level: "warning" | "info";
    message: string;
  };
}

export function getFollowerReconnectUiUpdate(
  event: "disconnect" | "reconnect",
  wasDisconnected: boolean,
): FollowerReconnectUiUpdate {
  if (event === "disconnect") {
    return wasDisconnected
      ? { nextWasDisconnected: true }
      : {
          nextWasDisconnected: true,
          notify: {
            level: "warning",
            message: "Pinet broker disconnected — reconnecting...",
          },
        };
  }

  if (!wasDisconnected) {
    return { nextWasDisconnected: false };
  }

  return {
    nextWasDisconnected: false,
    notify: {
      level: "info",
      message: "Pinet broker reconnected",
    },
  };
}

/**
 * Track a thread from a broker inbound message in the threads map.
 * Used by the broker onInbound callback so that slack_send can resolve
 * the channel for channel-mention messages.
 */
export function trackBrokerInboundThread(
  threads: Map<string, FollowerThreadState>,
  inMsg: { threadId: string; channel: string; userId?: string },
  owner?: string,
): void {
  if (!inMsg.threadId || !inMsg.channel) return;
  if (!threads.has(inMsg.threadId)) {
    threads.set(inMsg.threadId, {
      channelId: inMsg.channel,
      threadTs: inMsg.threadId,
      userId: inMsg.userId ?? "",
      owner,
    });
  }
}

export function formatAgentList(agents: AgentDisplayInfo[], homedir: string): string {
  if (agents.length === 0) return "(no agents connected)";

  return agents
    .map((a) => {
      let line = `${a.emoji} ${a.name} (${a.id}) \u2014 ${a.status}`;

      const meta = a.metadata;
      if (meta && (meta.cwd || meta.branch || meta.host)) {
        const cwd = meta.cwd ? shortenPath(meta.cwd, homedir) : "";
        const branch = meta.branch ? ` (${meta.branch})` : "";
        const host = meta.host ? ` @ ${meta.host}` : "";
        line += `\n   ${cwd}${branch}${host}`;
      }

      return line;
    })
    .join("\n");
}

// ─── Random agent names ──────────────────────────────────

const ADJECTIVES = [
  "Cosmic",
  "Turbo",
  "Neon",
  "Solar",
  "Quantum",
  "Pixel",
  "Cyber",
  "Atomic",
  "Stellar",
  "Thunder",
  "Crystal",
  "Mystic",
  "Hyper",
  "Ultra",
  "Mega",
  "Super",
  "Electric",
  "Galactic",
  "Sonic",
  "Laser",
  "Rocket",
  "Shadow",
  "Blazing",
  "Frozen",
];

const ANIMALS = [
  "Badger",
  "Penguin",
  "Falcon",
  "Otter",
  "Raccoon",
  "Fox",
  "Panda",
  "Wolf",
  "Eagle",
  "Dolphin",
  "Lynx",
  "Cobra",
  "Raven",
  "Gecko",
  "Mantis",
  "Osprey",
  "Jaguar",
  "Heron",
  "Bison",
  "Viper",
  "Hawk",
  "Crane",
  "Moose",
  "Owl",
];

const EMOJIS = [
  "🦡",
  "🐧",
  "🦅",
  "🦦",
  "🦝",
  "🦊",
  "🐼",
  "🐺",
  "🦅",
  "🐬",
  "🐱",
  "🐍",
  "🐦‍⬛",
  "🦎",
  "🦗",
  "🦅",
  "🐆",
  "🪿",
  "🦬",
  "🐍",
  "🦅",
  "🦩",
  "🫎",
  "🦉",
];

export function generateAgentName(): { name: string; emoji: string } {
  const ai = Math.floor(Math.random() * ADJECTIVES.length);
  const ni = Math.floor(Math.random() * ANIMALS.length);
  return {
    name: `${ADJECTIVES[ai]} ${ANIMALS[ni]}`,
    emoji: EMOJIS[ni],
  };
}

// ─── Agent identity persistence ─────────────────────────

export function resolveAgentIdentity(
  settings: SlackBridgeSettings,
  envNickname?: string,
): { name: string; emoji: string } {
  // 1. Explicit config (both must be present)
  if (settings.agentName && settings.agentEmoji) {
    return { name: settings.agentName, emoji: settings.agentEmoji };
  }

  // 2. PI_NICKNAME env var (emoji generated)
  if (envNickname) {
    const generated = generateAgentName();
    return { name: envNickname, emoji: generated.emoji };
  }

  // 3. Fully generated
  return generateAgentName();
}
