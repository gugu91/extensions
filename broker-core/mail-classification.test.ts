import { describe, expect, it } from "vitest";
import { classifyPinetMail, normalizePinetMailClass } from "./mail-classification.js";

// ─── Mail classification ─────────────────────────────────

describe("Pinet mail classification", () => {
  it("normalizes explicit fwup aliases", () => {
    expect(normalizePinetMailClass("fwup")).toBe("fwup");
    expect(normalizePinetMailClass("follow-up")).toBe("fwup");
    expect(normalizePinetMailClass("follow_up")).toBe("fwup");
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
  });

  it("keeps ordinary issue or PR references as fwup without action cues", () => {
    expect(
      classifyPinetMail({
        body: "Thanks for the review on PR #621; looks good.",
        metadata: { a2a: true },
      }),
    ).toMatchObject({ class: "fwup", explicit: false });
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

  it("classifies RALPH and closed-thread notes as maintenance/context-only", () => {
    expect(
      classifyPinetMail({
        body: "RALPH broker-only maintenance: ghost agents detected.",
        metadata: { kind: "broker_maintenance" },
      }),
    ).toMatchObject({ class: "maintenance_context" });

    expect(
      classifyPinetMail({
        body: "Hard stop on this thread: no further acknowledgements are needed. Stay free and quiet.",
        metadata: { a2a: true },
      }),
    ).toMatchObject({ class: "maintenance_context" });
  });

  it("classifies terminal stand-down cues as maintenance/context-only", () => {
    for (const body of [
      "Stand down on this lane.",
      "The thread is already satisfied; no reply is needed.",
      "No further replies are needed unless I ask for a new task.",
    ]) {
      expect(classifyPinetMail({ body, metadata: { a2a: true } })).toMatchObject({
        class: "maintenance_context",
      });
    }
  });

  it("does not treat standalone issue or PR references as steering", () => {
    expect(
      classifyPinetMail({
        body: "PR #621 looks good.",
        metadata: { a2a: true },
      }),
    ).toMatchObject({ class: "fwup", explicit: false });

    expect(
      classifyPinetMail({
        body: "Issue #606 is now routed; no action needed.",
        metadata: { a2a: true },
      }),
    ).toMatchObject({ class: "maintenance_context", explicit: false });
  });

  it("defaults ordinary durable mail to fwup", () => {
    expect(
      classifyPinetMail({
        body: "Thanks, looks good.",
        metadata: { a2a: true },
      }),
    ).toMatchObject({ class: "fwup", explicit: false });
  });
});
