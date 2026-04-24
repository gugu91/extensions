import { describe, expect, it } from "vitest";

import {
  encodeSlackBlockActionValue,
  extractSlackBlockActionsPayloadFromEnvelope,
  extractSlackInteractivePayloadFromEnvelope,
  normalizeSlackBlockActionPayload,
  normalizeSlackBlocksInput,
  normalizeSlackViewSubmissionPayload,
} from "./slack-block-kit.js";

describe("normalizeSlackBlocksInput", () => {
  it("accepts a JSON array of block objects", () => {
    expect(
      normalizeSlackBlocksInput([
        { type: "section", text: { type: "mrkdwn", text: "hello" } },
        { type: "divider" },
      ]),
    ).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hello" } }, { type: "divider" }]);
  });

  it("rejects non-array input", () => {
    expect(() => normalizeSlackBlocksInput({ type: "section" })).toThrow(
      "Slack blocks must be a JSON array of objects.",
    );
  });
});

describe("encodeSlackBlockActionValue", () => {
  it("passes through strings and encodes objects as JSON", () => {
    expect(encodeSlackBlockActionValue("approve")).toBe("approve");
    expect(encodeSlackBlockActionValue({ action: "approve", issue: 27 })).toBe(
      '{"action":"approve","issue":27}',
    );
  });
});

describe("extractSlackBlockActionsPayloadFromEnvelope", () => {
  it("extracts block_actions payloads from interactive envelopes", () => {
    expect(
      extractSlackBlockActionsPayloadFromEnvelope({
        type: "interactive",
        payload: JSON.stringify({ type: "block_actions", actions: [] }),
      }),
    ).toEqual({ type: "block_actions", actions: [] });
  });

  it("extracts generic interactive payloads such as view submissions", () => {
    expect(
      extractSlackInteractivePayloadFromEnvelope({
        type: "interactive",
        payload: JSON.stringify({ type: "view_submission", view: { id: "V1" } }),
      }),
    ).toEqual({ type: "view_submission", view: { id: "V1" } });
  });

  it("ignores non-interactive envelopes", () => {
    expect(
      extractSlackBlockActionsPayloadFromEnvelope({
        type: "events_api",
        payload: { type: "block_actions" },
      }),
    ).toBeNull();
  });
});

describe("normalizeSlackBlockActionPayload", () => {
  it("normalizes a block action into an inbox event with structured metadata", () => {
    const event = normalizeSlackBlockActionPayload({
      type: "block_actions",
      trigger_id: "trigger-1",
      user: { id: "U123" },
      channel: { id: "C123" },
      container: {
        channel_id: "C123",
        message_ts: "123.456",
        thread_ts: "123.000",
      },
      actions: [
        {
          action_id: "review.approve",
          block_id: "review-actions",
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          value: '{"decision":"approve","pr":212}',
          action_ts: "123.789",
          style: "primary",
        },
      ],
    });

    expect(event).toEqual({
      channel: "C123",
      threadTs: "123.000",
      userId: "U123",
      text: 'Clicked Slack "Approve" (action_id: review.approve).',
      timestamp: "123.789",
      metadata: {
        kind: "slack_block_action",
        triggerId: "trigger-1",
        viewId: null,
        callbackId: null,
        viewHash: null,
        actionId: "review.approve",
        blockId: "review-actions",
        value: '{"decision":"approve","pr":212}',
        parsedValue: { decision: "approve", pr: 212 },
        actionText: "Approve",
        channel: "C123",
        threadTs: "123.000",
        messageTs: "123.456",
        modalPrivateMetadata: null,
        actions: [
          {
            actionId: "review.approve",
            blockId: "review-actions",
            text: "Approve",
            type: "button",
            style: "primary",
            value: '{"decision":"approve","pr":212}',
            parsedValue: { decision: "approve", pr: 212 },
            actionTs: "123.789",
          },
        ],
      },
    });
  });

  it("falls back to message ts when thread ts is absent", () => {
    const event = normalizeSlackBlockActionPayload({
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "D123" },
      container: {
        channel_id: "D123",
        message_ts: "222.333",
      },
      actions: [
        {
          action_id: "task.done",
          type: "button",
          text: { type: "plain_text", text: "Done" },
        },
      ],
    });

    expect(event?.threadTs).toBe("222.333");
    expect(event?.timestamp).toBe("222.333");
  });

  it("routes modal block actions using private_metadata thread context", () => {
    const event = normalizeSlackBlockActionPayload({
      type: "block_actions",
      trigger_id: "trigger-2",
      user: { id: "U123" },
      view: {
        id: "V123",
        callback_id: "deploy.confirm",
        hash: "hash-1",
        private_metadata:
          '{"workflow":"deploy","__piSlackModalContext":{"threadTs":"123.456","channel":"C123"}}',
      },
      actions: [
        {
          action_id: "deploy.confirm.toggle",
          type: "radio_buttons",
          action_ts: "333.444",
        },
      ],
    });

    expect(event).toMatchObject({
      channel: "C123",
      threadTs: "123.456",
      metadata: {
        kind: "slack_block_action",
        triggerId: "trigger-2",
        viewId: "V123",
        callbackId: "deploy.confirm",
        modalPrivateMetadata: { workflow: "deploy" },
      },
    });
  });
});

describe("normalizeSlackViewSubmissionPayload", () => {
  it("normalizes modal submissions into inbox events with parsed state", () => {
    const event = normalizeSlackViewSubmissionPayload({
      type: "view_submission",
      trigger_id: "trigger-1",
      user: { id: "U123" },
      view: {
        id: "V123",
        callback_id: "deploy.confirm",
        title: { type: "plain_text", text: "Deploy approval" },
        private_metadata:
          '{"workflow":"deploy","__piSlackModalContext":{"threadTs":"123.456","channel":"C123"}}',
        state: {
          values: {
            confirm_phrase: {
              confirm_phrase: {
                type: "plain_text_input",
                value: "CONFIRM",
              },
            },
          },
        },
      },
    });

    expect(event).toEqual({
      channel: "C123",
      threadTs: "123.456",
      userId: "U123",
      text: 'Submitted Slack modal (deploy.confirm) "Deploy approval".',
      timestamp: "V123",
      metadata: {
        kind: "slack_view_submission",
        triggerId: "trigger-1",
        callbackId: "deploy.confirm",
        viewId: "V123",
        externalId: null,
        viewHash: null,
        channel: "C123",
        threadTs: "123.456",
        privateMetadata: { workflow: "deploy" },
        stateValues: {
          confirm_phrase: {
            confirm_phrase: {
              type: "plain_text_input",
              value: "CONFIRM",
            },
          },
        },
      },
    });
  });
});
