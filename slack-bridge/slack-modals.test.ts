import { describe, expect, it } from "vitest";
import {
  buildSlackModalTemplate,
  decodeSlackModalPrivateMetadata,
  encodeSlackModalPrivateMetadata,
  normalizeSlackModalViewInput,
} from "./slack-modals.js";

describe("buildSlackModalTemplate", () => {
  it("builds a confirmation modal", () => {
    const result = buildSlackModalTemplate({
      template: "confirmation",
      title: "Deploy approval",
      text: "Ready to deploy to production.",
      confirm_phrase: "CONFIRM",
      callback_id: "deploy.confirm",
    });

    expect(result.view).toMatchObject({
      type: "modal",
      callback_id: "deploy.confirm",
      blocks: [{ type: "section" }, { type: "input", block_id: "confirm_phrase" }],
    });
  });

  it("builds a form modal", () => {
    const result = buildSlackModalTemplate({
      template: "form",
      title: "PR review",
      fields: [
        { label: "Status", action_id: "status" },
        { label: "Comments", action_id: "comments", multiline: true },
      ],
    });

    expect(result.view.blocks).toHaveLength(2);
  });

  it("builds a multi-select modal", () => {
    const result = buildSlackModalTemplate({
      template: "multi_select",
      title: "Pick services",
      label: "Services",
      action_id: "services",
      options: [
        { text: "API", value: "api" },
        { text: "Worker", value: "worker" },
      ],
      initial_values: ["worker"],
    });

    expect(result.view).toMatchObject({
      type: "modal",
      blocks: [
        {
          type: "input",
          element: {
            type: "multi_static_select",
            initial_options: [{ value: "worker" }],
          },
        },
      ],
    });
  });
});

describe("normalizeSlackModalViewInput", () => {
  it("requires a modal view object", () => {
    expect(() => normalizeSlackModalViewInput({ type: "home" })).toThrow(
      'Slack modal view.type must be "modal".',
    );
  });
});

describe("modal private metadata helpers", () => {
  it("embeds and restores thread context alongside custom metadata", () => {
    const encoded = encodeSlackModalPrivateMetadata(JSON.stringify({ workflow: "deploy" }), {
      threadTs: "123.456",
      channel: "C123",
    });
    const decoded = decodeSlackModalPrivateMetadata(encoded);

    expect(decoded.threadContext).toEqual({ threadTs: "123.456", channel: "C123" });
    expect(decoded.value).toEqual({ workflow: "deploy" });
  });

  it("preserves plain-string metadata when encoding thread context", () => {
    const encoded = encodeSlackModalPrivateMetadata("deploy", {
      threadTs: "123.456",
      channel: "C123",
    });
    const decoded = decodeSlackModalPrivateMetadata(encoded);

    expect(decoded.threadContext).toEqual({ threadTs: "123.456", channel: "C123" });
    expect(decoded.value).toBe("deploy");
  });
});
