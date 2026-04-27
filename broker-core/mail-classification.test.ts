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

  it("defaults ordinary durable mail to fwup", () => {
    expect(
      classifyPinetMail({
        body: "Thanks, looks good.",
        metadata: { a2a: true },
      }),
    ).toMatchObject({ class: "fwup", explicit: false });
  });
});
