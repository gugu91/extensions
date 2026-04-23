import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackInstallTopology } from "../../helpers.js";

const mockState = vi.hoisted(() => ({
  adapterConfigs: [] as Array<{ installId: string; config: Record<string, unknown> }>,
  sendCalls: new Map<string, unknown[]>(),
}));

vi.mock("./slack.js", () => {
  class FakeSlackAdapter {
    private readonly installId: string;

    constructor(private readonly config: Record<string, unknown>) {
      const scope = config.getDefaultScope as
        | (() => { workspace?: { installId?: string } })
        | undefined;
      this.installId = scope?.().workspace?.installId ?? "unknown";
      mockState.adapterConfigs.push({ installId: this.installId, config });
      mockState.sendCalls.set(this.installId, []);
    }

    async connect(): Promise<void> {}

    async disconnect(): Promise<void> {}

    onInbound(): void {}

    async send(message: unknown): Promise<void> {
      mockState.sendCalls.get(this.installId)?.push(message);
    }

    getBotUserId(): string {
      return `B_${this.installId}`;
    }

    isConnected(): boolean {
      return true;
    }
  }

  return {
    SlackAdapter: FakeSlackAdapter,
  };
});

import { SlackTopologyAdapter } from "./slack-topology.js";

describe("SlackTopologyAdapter", () => {
  beforeEach(() => {
    mockState.adapterConfigs.length = 0;
    mockState.sendCalls.clear();
  });

  it("connects one Slack adapter per runtime install and routes outbound scope to the matching install", async () => {
    const installs = [
      {
        installId: "primary",
        source: "explicit",
        workspaceId: "T_PRIMARY",
        botToken: "xoxb-primary",
        appToken: "xapp-primary",
        homeTabEnabled: true,
        scope: {
          workspace: {
            provider: "slack",
            source: "explicit",
            workspaceId: "T_PRIMARY",
            installId: "primary",
          },
        },
      },
      {
        installId: "secondary",
        source: "explicit",
        workspaceId: "T_SECONDARY",
        botToken: "xoxb-secondary",
        appToken: "xapp-secondary",
        homeTabEnabled: true,
        scope: {
          workspace: {
            provider: "slack",
            source: "explicit",
            workspaceId: "T_SECONDARY",
            installId: "secondary",
          },
        },
      },
    ] satisfies ReadonlyArray<ResolvedSlackInstallTopology>;
    const adapter = new SlackTopologyAdapter({
      installs,
      defaultInstallId: "primary",
      resolveInstallForScope: (scope) =>
        installs.find((install) => install.installId === scope?.workspace?.installId) ??
        installs[0] ??
        null,
    });

    await adapter.connect();
    await adapter.send({
      threadId: "100.1",
      channel: "C_SECONDARY",
      text: "hello secondary",
      scope: {
        workspace: {
          provider: "slack",
          source: "explicit",
          workspaceId: "T_SECONDARY",
          installId: "secondary",
        },
      },
    });
    await adapter.send({
      threadId: "100.2",
      channel: "C_PRIMARY",
      text: "hello default",
    });

    expect(mockState.adapterConfigs.map((entry) => entry.installId)).toEqual([
      "primary",
      "secondary",
    ]);
    expect(mockState.sendCalls.get("secondary")).toEqual([
      {
        threadId: "100.1",
        channel: "C_SECONDARY",
        text: "hello secondary",
        scope: {
          workspace: {
            provider: "slack",
            source: "explicit",
            workspaceId: "T_SECONDARY",
            installId: "secondary",
          },
        },
      },
    ]);
    expect(mockState.sendCalls.get("primary")).toEqual([
      {
        threadId: "100.2",
        channel: "C_PRIMARY",
        text: "hello default",
        scope: installs[0]?.scope,
      },
    ]);
    expect(adapter.getBotUserId()).toBe("B_primary");
  });
});
