import { describe, expect, it } from "vitest";
import {
  buildReactionPromptGuidelines,
  buildReactionTriggerMessage,
  buildReactionTriggerMetadata,
  formatReactionDisplay,
  normalizeReactionName,
  resolveReactionCommands,
} from "./reaction-triggers.js";

describe("normalizeReactionName", () => {
  it("normalizes supported emoji characters and Slack aliases", () => {
    expect(normalizeReactionName("👀")).toBe("eyes");
    expect(normalizeReactionName(":white_check_mark:")).toBe("white_check_mark");
    expect(normalizeReactionName("⬆️")).toBe("arrow_up");
    expect(normalizeReactionName(":arrow_up:")).toBe("arrow_up");
    expect(normalizeReactionName("memo")).toBe("memo");
  });

  it("throws for unsupported raw emoji input", () => {
    expect(() => normalizeReactionName("💥")).toThrow("Unsupported reaction");
  });
});

describe("resolveReactionCommands", () => {
  it("provides default mappings for summary, file-issue, and steering triggers", () => {
    const commands = resolveReactionCommands(undefined);
    expect(commands.get("memo")?.action).toBe("summarize");
    expect(commands.get("bug")?.action).toBe("file-issue");
    expect(commands.get("arrow_up")?.action).toBe("steering");
  });

  it("merges custom settings keyed by emoji or alias", () => {
    const commands = resolveReactionCommands({
      "👀": "review",
      ":repeat:": { action: "retry", prompt: "Retry the prior response right now." },
    });

    expect(commands.get("eyes")?.action).toBe("review");
    expect(commands.get("repeat")?.prompt).toBe("Retry the prior response right now.");
  });
});

describe("formatReactionDisplay", () => {
  it("includes both the emoji and Slack reaction name when known", () => {
    expect(formatReactionDisplay("eyes")).toBe("👀 (:eyes:)");
    expect(formatReactionDisplay("arrow_up")).toBe("⬆️ (:arrow_up:)");
  });
});

describe("buildReactionTriggerMessage", () => {
  it("formats a structured inbox message with context", () => {
    const message = buildReactionTriggerMessage({
      reactionName: "eyes",
      command: {
        action: "review",
        prompt: "Review the referenced message or work item.",
      },
      reactorName: "Alice",
      channel: "C123",
      threadTs: "111.222",
      messageTs: "111.333",
      reactedMessageText: "Please review PR #210",
      reactedMessageAuthor: "Bob",
    });

    expect(message).toContain("Reaction trigger from Slack:");
    expect(message).toContain("- reaction: 👀 (:eyes:)");
    expect(message).toContain("- action: review");
    expect(message).toContain("- delivery_classification: follow_up");
    expect(message).toContain("- reacted_message_text: Please review PR #210");
    expect(message).toContain("Requested action: Review the referenced message or work item.");
  });
});

describe("buildReactionTriggerMetadata", () => {
  it("marks arrow-up reactions as steering for downstream classifiers", () => {
    expect(
      buildReactionTriggerMetadata({
        reactionName: "arrow_up",
        command: {
          action: "steering",
          prompt: "Steer from here.",
        },
        reactorName: "Alice",
        channel: "C123",
        threadTs: "111.222",
        messageTs: "111.333",
        reactedMessageAuthor: "Bob",
      }),
    ).toMatchObject({
      kind: "slack_reaction_trigger",
      slackReaction: "arrow_up",
      slackReactionAction: "steering",
      deliveryClassification: "steering",
      threadTs: "111.222",
      messageTs: "111.333",
    });
  });
});

describe("buildReactionPromptGuidelines", () => {
  it("explains that reaction-triggered requests are structured inbox messages", () => {
    const joined = buildReactionPromptGuidelines().join(" ");
    expect(joined).toContain("Reaction trigger from Slack");
    expect(joined).toContain("emoji reactions");
    expect(joined).toContain(":arrow_up:");
  });
});
