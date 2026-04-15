import { describe, expect, it, vi } from "vitest";
import type { SinglePlayerThreadInfo } from "./single-player-runtime.js";
import { createSlackRuntimeAccess, type SlackRuntimeAccessDeps } from "./slack-runtime-access.js";
import { TtlCache } from "./ttl-cache.js";

function createDeps(overrides: Partial<SlackRuntimeAccessDeps> = {}) {
  const threads = new Map<string, SinglePlayerThreadInfo>();
  const userNames = new TtlCache<string, string>({ maxSize: 10, ttlMs: 60_000 });
  const channelCache = new TtlCache<string, string>({ maxSize: 10, ttlMs: 60_000 });
  const persistState = vi.fn();
  const slack = vi.fn(async (method: string, _token: string, body?: Record<string, unknown>) => {
    if (method === "users.info") {
      return { ok: true, user: { real_name: "Sender" } };
    }
    if (method === "conversations.list") {
      return {
        ok: true,
        channels: [{ id: "C_GENERAL", name: "general" }],
        response_metadata: { next_cursor: "" },
      };
    }
    if (method === "assistant.threads.setSuggestedPrompts") {
      return { ok: true, body };
    }
    if (method === "conversations.history") {
      return { ok: true, messages: [{ ts: body?.latest, text: "hello" }] };
    }
    if (
      method === "reactions.add" ||
      method === "reactions.remove" ||
      method === "assistant.threads.setStatus"
    ) {
      return { ok: true };
    }
    return { ok: true };
  });

  const deps: SlackRuntimeAccessDeps = {
    slack,
    getBotToken: () => "xoxb-test",
    userNames,
    channelCache,
    persistState,
    isSinglePlayerShuttingDown: () => false,
    getSuggestedPrompts: () => undefined,
    getAgentName: () => "Cobalt Olive Crane",
    getThreads: () => threads,
    getBrokerRole: () => null,
    ...overrides,
  };

  return { deps, threads, userNames, channelCache, persistState, slack };
}

describe("createSlackRuntimeAccess", () => {
  it("caches resolved user names and persists when a new cache entry is written", async () => {
    const { deps, persistState, slack } = createDeps();
    const access = createSlackRuntimeAccess(deps);

    await expect(access.resolveUser("U123")).resolves.toBe("Sender");
    await expect(access.resolveUser("U123")).resolves.toBe("Sender");

    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack).toHaveBeenCalledWith("users.info", "xoxb-test", { user: "U123" });
    expect(persistState).toHaveBeenCalledTimes(1);
  });

  it("does not cache or persist a resolved user while single-player shutdown is in progress", async () => {
    const { deps, persistState, userNames } = createDeps({
      isSinglePlayerShuttingDown: () => true,
    });
    const access = createSlackRuntimeAccess(deps);

    await expect(access.resolveUser("U123")).resolves.toBe("U123");

    expect(userNames.get("U123")).toBeUndefined();
    expect(persistState).not.toHaveBeenCalled();
  });

  it("remembers resolved channels and reuses the cache without another Slack lookup", async () => {
    const { deps, slack, channelCache } = createDeps();
    const access = createSlackRuntimeAccess(deps);

    access.rememberChannel("#general", "C_GENERAL");
    await expect(access.resolveChannel("#general")).resolves.toBe("C_GENERAL");

    expect(channelCache.get("general")).toBe("C_GENERAL");
    expect(slack).not.toHaveBeenCalled();
  });

  it("refreshes a follower reply channel into local thread state and persists the change", async () => {
    const { deps, threads, persistState } = createDeps({
      getBrokerRole: () => "follower",
      resolveFollowerThreadChannel: async (threadTs: string) =>
        threadTs === "100.1" ? "C_REFRESHED" : null,
    });
    threads.set("100.1", {
      channelId: "C_STALE",
      threadTs: "100.1",
      userId: "U123",
      source: "slack",
      context: { channelId: "C_STALE", teamId: "T1" },
    });
    const access = createSlackRuntimeAccess(deps);

    await expect(access.resolveFollowerReplyChannel("100.1")).resolves.toBe("C_REFRESHED");

    expect(threads.get("100.1")).toMatchObject({
      channelId: "C_REFRESHED",
      threadTs: "100.1",
      userId: "U123",
      source: "slack",
      context: { channelId: "C_STALE", teamId: "T1" },
    });
    expect(persistState).toHaveBeenCalledTimes(1);
  });

  it("uses agent-specific fallback suggested prompts when no custom prompts are configured", async () => {
    const { deps, slack } = createDeps();
    const access = createSlackRuntimeAccess(deps);

    await access.setSuggestedPrompts("C123", "100.1");

    expect(slack).toHaveBeenCalledWith(
      "assistant.threads.setSuggestedPrompts",
      "xoxb-test",
      expect.objectContaining({
        channel_id: "C123",
        thread_ts: "100.1",
        prompts: [
          {
            title: "Status",
            message: "Hey Cobalt Olive Crane, what are you working on right now?",
          },
          {
            title: "Help",
            message: "Cobalt Olive Crane, I need help with something in the codebase",
          },
          {
            title: "Review",
            message: "Cobalt Olive Crane, summarise the recent changes",
          },
        ],
      }),
    );
  });
});
