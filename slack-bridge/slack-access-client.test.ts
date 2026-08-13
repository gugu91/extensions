import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackSocketModeClient, type SlackCall } from "./slack-access.js";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];
  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });
  readonly send = vi.fn();
  readyState = FakeWebSocket.OPEN;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(): void {}
}

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.unstubAllGlobals();
});

describe("SlackSocketModeClient startup", () => {
  it("requests startup data concurrently but opens the socket after resolving bot identity", async () => {
    type SlackResponse = Awaited<ReturnType<SlackCall>>;
    let resolveAuth!: (value: SlackResponse) => void;
    let resolveSocket!: (value: SlackResponse) => void;
    const authResponse = new Promise<SlackResponse>((resolve) => {
      resolveAuth = resolve;
    });
    const socketResponse = new Promise<SlackResponse>((resolve) => {
      resolveSocket = resolve;
    });
    const slack = vi.fn<SlackCall>((method) => {
      if (method === "auth.test") return authResponse;
      if (method === "apps.connections.open") return socketResponse;
      throw new Error(`Unexpected Slack method: ${method}`);
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = new SlackSocketModeClient({
      slack,
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
    const connecting = client.connect();

    expect(slack).toHaveBeenCalledWith("auth.test", "xoxb-test");
    expect(slack).toHaveBeenCalledWith("apps.connections.open", "xapp-test");

    resolveSocket({ url: "wss://slack.example/socket" });
    await socketResponse;
    expect(FakeWebSocket.instances).toHaveLength(0);

    resolveAuth({ user_id: "U_BOT" });
    await connecting;

    expect(client.getBotUserId()).toBe("U_BOT");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
