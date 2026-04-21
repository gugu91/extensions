import { describe, expect, it, vi } from "vitest";
import {
  createBrokerThreadOwnerHints,
  type BrokerThreadOwnerHintsDeps,
} from "./broker-thread-owner-hints.js";

function createDeps(overrides: Partial<BrokerThreadOwnerHintsDeps> = {}) {
  const slack = vi.fn(async () => ({ ok: true, messages: [] }));

  const deps: BrokerThreadOwnerHintsDeps = {
    slack,
    getBotToken: () => "xoxb-test",
    ...overrides,
  };

  return { deps, slack: deps.slack };
}

describe("createBrokerThreadOwnerHints", () => {
  it("re-fetches resolved broker thread-owner hints so ownership changes stay fresh", async () => {
    const { deps, slack } = createDeps({
      slack: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            {
              bot_id: "B123",
              metadata: {
                event_type: "pi_agent_msg",
                event_payload: {
                  agent_owner: "owner:crane",
                  agent: "Cobalt Olive Crane",
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            {
              bot_id: "B123",
              metadata: {
                event_type: "pi_agent_msg",
                event_payload: {
                  agent_owner: "owner:moth",
                  agent: "Silent Slate Mantis",
                },
              },
            },
          ],
        }),
    });
    const brokerThreadOwnerHints = createBrokerThreadOwnerHints(deps);

    await expect(
      brokerThreadOwnerHints.resolveBrokerThreadOwnerHint("C123", "100.1"),
    ).resolves.toEqual({
      agentOwner: "owner:crane",
      agentName: "Cobalt Olive Crane",
    });
    await expect(
      brokerThreadOwnerHints.resolveBrokerThreadOwnerHint("C123", "100.1"),
    ).resolves.toEqual({
      agentOwner: "owner:moth",
      agentName: "Silent Slate Mantis",
    });

    expect(slack).toHaveBeenCalledTimes(2);
    expect(slack).toHaveBeenNthCalledWith(1, "conversations.replies", "xoxb-test", {
      channel: "C123",
      ts: "100.1",
      limit: 200,
      include_all_metadata: true,
    });
    expect(slack).toHaveBeenNthCalledWith(2, "conversations.replies", "xoxb-test", {
      channel: "C123",
      ts: "100.1",
      limit: 200,
      include_all_metadata: true,
    });
  });

  it("does not cache null hints so later lookups can retry Slack", async () => {
    const { deps, slack } = createDeps({
      slack: vi.fn(async () => ({ ok: true, messages: [] })),
    });
    const brokerThreadOwnerHints = createBrokerThreadOwnerHints(deps);

    await expect(
      brokerThreadOwnerHints.resolveBrokerThreadOwnerHint("C123", "100.1"),
    ).resolves.toBeNull();
    await expect(
      brokerThreadOwnerHints.resolveBrokerThreadOwnerHint("C123", "100.1"),
    ).resolves.toBeNull();

    expect(slack).toHaveBeenCalledTimes(2);
  });

  it("returns null for invalid inputs or Slack failures", async () => {
    const { deps, slack } = createDeps({
      slack: vi.fn(async (_method, _token, body) => {
        if (body?.channel === "C_FAIL") {
          throw new Error("Slack failed");
        }
        return { ok: true, messages: [] };
      }),
    });
    const brokerThreadOwnerHints = createBrokerThreadOwnerHints(deps);

    await expect(
      brokerThreadOwnerHints.resolveBrokerThreadOwnerHint("", "100.1"),
    ).resolves.toBeNull();
    await expect(
      brokerThreadOwnerHints.resolveBrokerThreadOwnerHint("C_FAIL", "100.1"),
    ).resolves.toBeNull();

    expect(slack).toHaveBeenCalledTimes(1);
  });
});
