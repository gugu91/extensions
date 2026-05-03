import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "./index.js";
import { formatContext, parseNvimEvent, type EditorState } from "./helpers.js";

function createState(overrides: Partial<EditorState> = {}): EditorState {
  return {
    file: null,
    line: null,
    visibleStart: null,
    visibleEnd: null,
    selectionStart: null,
    selectionEnd: null,
    ...overrides,
  };
}

describe("formatContext", () => {
  it("formats the current editor viewport, cursor, and selection", () => {
    expect(
      formatContext(
        createState({
          file: "src/app.ts",
          visibleStart: 10,
          visibleEnd: 20,
          line: 15,
          selectionStart: 16,
          selectionEnd: 18,
        }),
      ),
    ).toBe(
      "User is viewing src/app.ts, lines 10-20 (cursor at line 15), selection on lines 16-18.",
    );
  });

  it("returns an empty string when no file is focused", () => {
    expect(formatContext(createState())).toBe("");
  });
});

describe("nvim-bridge extension registration", () => {
  it("registers only the editor/Pinet bridge surface, not legacy PiComms tools or commands", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: vi.fn((definition: { name: string }) => tools.push(definition.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
      on: vi.fn((name: string) => events.push(name)),
    } as unknown as ExtensionAPI;

    extension(pi);

    expect(tools).toEqual(["open_in_editor"]);
    expect(tools).not.toEqual(
      expect.arrayContaining(["comment_add", "comment_list", "comment_wipe_all"]),
    );
    expect(commands).not.toEqual(expect.arrayContaining(["picomms:read", "picomms:clean"]));
    expect(events).toEqual(["session_start", "before_agent_start", "session_shutdown"]);
  });
});

describe("parseNvimEvent", () => {
  it("parses valid editor and Pinet adapter events", () => {
    expect(parseNvimEvent({ type: "buffer_focus", file: "src/app.ts", line: 12 })).toEqual({
      type: "buffer_focus",
      file: "src/app.ts",
      line: 12,
    });
    expect(parseNvimEvent({ type: "selection", file: "src/app.ts", start: 4, end: 8 })).toEqual({
      type: "selection",
      file: "src/app.ts",
      start: 4,
      end: 8,
    });
    expect(parseNvimEvent({ type: "trigger_agent", prompt: "Use Pinet" })).toEqual({
      type: "trigger_agent",
      prompt: "Use Pinet",
    });
  });

  it("rejects malformed or unknown events", () => {
    expect(parseNvimEvent({ type: "buffer_focus", file: "src/app.ts", line: 0 })).toBeNull();
    expect(parseNvimEvent({ type: "unknown", file: "src/app.ts" })).toBeNull();
    expect(parseNvimEvent(null)).toBeNull();
  });
});
