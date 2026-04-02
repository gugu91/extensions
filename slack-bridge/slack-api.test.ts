import { afterEach, describe, expect, it, vi } from "vitest";
import { callSlackApi } from "./slack-api.js";

function makeResponse(
  status: number,
  body: Record<string, unknown>,
  retryAfter?: string,
): Response {
  return {
    status,
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === "retry-after") {
          return retryAfter ?? null;
        }
        return null;
      },
    },
    async json() {
      return body;
    },
  } as unknown as Response;
}

describe("callSlackApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the parsed Slack response when ok", async () => {
    const fetchSpy = vi.fn(async () => makeResponse(200, { ok: true, channel: "C1" }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(callSlackApi("chat.postMessage", "xoxb-token", { text: "hi" })).resolves.toEqual({
      ok: true,
      channel: "C1",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries after 429 responses", async () => {
    vi.spyOn(global, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, { ok: false }, "1"))
      .mockResolvedValueOnce(makeResponse(200, { ok: true, channel: "C2" }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(callSlackApi("chat.postMessage", "xoxb-token", { text: "hi" })).resolves.toEqual({
      ok: true,
      channel: "C2",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("aborts during 429 retry backoff when the signal is aborted", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn(async () => makeResponse(429, { ok: false }, "10"));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const pending = callSlackApi(
      "chat.postMessage",
      "xoxb-token",
      { text: "hi" },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws on Slack API errors", async () => {
    const fetchSpy = vi.fn(async () =>
      makeResponse(200, { ok: false, error: "channel_not_found" }),
    );
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    await expect(callSlackApi("chat.postMessage", "xoxb-token", {})).rejects.toThrow(
      "Slack chat.postMessage: channel_not_found",
    );
  });
});
