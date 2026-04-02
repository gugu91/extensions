import { describe, expect, it } from "vitest";
import {
  extractSlackBlockActionDedupKey,
  extractSlackEventDedupKey,
  extractSlackSocketDedupKey,
} from "./slack-socket-dedup.js";

describe("extractSlackSocketDedupKey", () => {
  it("prefers Slack event_id for events_api frames", () => {
    expect(
      extractSlackSocketDedupKey({
        type: "events_api",
        payload: {
          event_id: "Ev123",
          event: {
            type: "message",
            channel: "D1",
            ts: "111.222",
            user: "U1",
          },
        },
      }),
    ).toBe("event:Ev123");
  });

  it("falls back to a stable message signature when event_id is missing", () => {
    expect(
      extractSlackSocketDedupKey({
        type: "events_api",
        payload: {
          event: {
            type: "message",
            channel: "D1",
            thread_ts: "111.000",
            ts: "111.222",
            user: "U1",
          },
        },
      }),
    ).toBe("message:D1:111.000:111.222:U1:");
  });

  it("extracts block action dedup keys from interactive frames", () => {
    expect(
      extractSlackSocketDedupKey({
        type: "interactive",
        payload: {
          type: "block_actions",
          user: { id: "U1" },
          channel: { id: "C1" },
          container: {
            channel_id: "C1",
            thread_ts: "111.000",
            message_ts: "111.222",
          },
          actions: [
            {
              action_id: "review.approve",
              action_ts: "111.333",
            },
          ],
        },
      }),
    ).toBe("block_actions:U1:C1:111.000:111.222:review.approve@111.333");
  });
});

describe("extractSlackEventDedupKey", () => {
  it("builds stable keys for reaction_added events", () => {
    expect(
      extractSlackEventDedupKey({
        type: "reaction_added",
        user: "U_REACTOR",
        reaction: "eyes",
        event_ts: "999.000",
        item: {
          type: "message",
          channel: "C123",
          ts: "111.333",
        },
      }),
    ).toBe("reaction_added:C123:111.333:U_REACTOR:eyes:999.000");
  });
});

describe("extractSlackBlockActionDedupKey", () => {
  it("still derives a stable key when block actions omit action_ts", () => {
    expect(
      extractSlackBlockActionDedupKey({
        type: "block_actions",
        user: { id: "U1" },
        channel: { id: "C1" },
        container: {
          channel_id: "C1",
          thread_ts: "111.000",
          message_ts: "111.222",
        },
        actions: [{ action_id: "review.approve" }],
      }),
    ).toBe("block_actions:U1:C1:111.000:111.222:review.approve@");
  });
});
