import { describe, expect, it } from "vitest";
import { classifyPinetMail, normalizePinetMailClass } from "./mail-classification.js";

// ─── Mail classification ─────────────────────────────────

describe("Pinet mail classification", () => {
  it("normalizes explicit class aliases", () => {
    expect(normalizePinetMailClass("steer")).toBe("steering");
    expect(normalizePinetMailClass("follow-up")).toBe("fwup");
    expect(normalizePinetMailClass("follow_up")).toBe("fwup");
    expect(normalizePinetMailClass("context-only")).toBe("maintenance_context");
    expect(normalizePinetMailClass("maintenance")).toBe("maintenance_context");
  });

  it("honors explicit metadata over heuristics", () => {
    expect(
      classifyPinetMail({
        body: "Please take issue #606 and ACK/work/ask/report.",
        metadata: { pinetMailClass: "fwup" },
      }),
    ).toMatchObject({ class: "fwup", explicit: true });
  });

  it("classifies actionable broker instructions as steering", () => {
    expect(
      classifyPinetMail({
        body: "Please take issue #606. Workflow: ACK/work/ask/report. No merge.",
        metadata: { a2a: true, senderAgent: "Broker Camel" },
      }),
    ).toMatchObject({ class: "steering", explicit: false });

    expect(
      classifyPinetMail({
        body: "Task: Final re-review current branch for PR #621. Focus on mail classification semantics.",
        metadata: { a2a: true, senderAgent: "Broker Camel" },
      }),
    ).toMatchObject({ class: "steering", explicit: false });
  });

  it("keeps ordinary issue or PR status references as follow-up", () => {
    for (const body of [
      "Thanks for the review on PR #621; looks good.",
      "Issue #606 review notes are resolved.",
      "PR #621 review looks good.",
      "Tests passed. Blockers: none.",
      "Done. Tests passed. No merge performed. Ready for human review.",
    ]) {
      expect(classifyPinetMail({ body, metadata: { a2a: true } })).toMatchObject({
        class: "fwup",
        explicit: false,
      });
    }
  });

  it("classifies legacy control and skin metadata as maintenance/context-only", () => {
    expect(
      classifyPinetMail({
        body: "/reload",
        metadata: { a2a: true, kind: "pinet_control", command: "reload" },
      }),
    ).toMatchObject({ class: "maintenance_context" });

    expect(
      classifyPinetMail({
        body: "skin update",
        metadata: { a2a: true, kind: "pinet_skin", theme: "forest" },
      }),
    ).toMatchObject({ class: "maintenance_context" });
  });

  it("classifies RALPH and terminal stand-down notes as maintenance/context-only", () => {
    for (const body of [
      "RALPH broker-only maintenance: ghost agents detected.",
      "Stand down on this lane.",
      "The thread is already satisfied; no reply is needed.",
      "No further replies are needed unless I ask for a new task.",
      "Issue #606 is now routed; no action needed.",
    ]) {
      expect(classifyPinetMail({ body, metadata: { a2a: true } })).toMatchObject({
        class: "maintenance_context",
        explicit: false,
      });
    }
  });

  it("defaults ordinary durable mail to follow-up", () => {
    expect(
      classifyPinetMail({
        body: "Thanks, looks good.",
        metadata: { a2a: true },
      }),
    ).toMatchObject({ class: "fwup", explicit: false });
  });
});
