import { describe, expect, it } from "vitest";
import {
  buildSlackCanvasCreateRequest,
  buildSlackCanvasEditRequest,
  buildSlackCanvasSectionsLookupRequest,
  extractSlackCanvasCommentsPage,
  extractSlackChannelCanvasId,
  normalizeSlackCanvasCommentsLimit,
  normalizeSlackCanvasCreateKind,
  normalizeSlackCanvasSectionType,
  normalizeSlackCanvasUpdateMode,
  pickSlackCanvasSectionId,
} from "./canvases.js";

describe("normalizeSlackCanvasCreateKind", () => {
  it("defaults to standalone", () => {
    expect(normalizeSlackCanvasCreateKind()).toBe("standalone");
  });

  it("accepts channel", () => {
    expect(normalizeSlackCanvasCreateKind("channel")).toBe("channel");
  });

  it("rejects unsupported kinds", () => {
    expect(() => normalizeSlackCanvasCreateKind("thread")).toThrow(
      "Unsupported canvas kind. Use 'standalone' or 'channel'.",
    );
  });
});

describe("normalizeSlackCanvasUpdateMode", () => {
  it("defaults to append", () => {
    expect(normalizeSlackCanvasUpdateMode()).toBe("append");
  });

  it("accepts prepend and replace", () => {
    expect(normalizeSlackCanvasUpdateMode("prepend")).toBe("prepend");
    expect(normalizeSlackCanvasUpdateMode("replace")).toBe("replace");
  });

  it("rejects unsupported modes", () => {
    expect(() => normalizeSlackCanvasUpdateMode("rename")).toThrow(
      "Unsupported canvas update mode. Use 'append', 'prepend', or 'replace'.",
    );
  });
});

describe("normalizeSlackCanvasSectionType", () => {
  it("accepts supported section types", () => {
    expect(normalizeSlackCanvasSectionType("h1")).toBe("h1");
    expect(normalizeSlackCanvasSectionType("any_header")).toBe("any_header");
  });

  it("returns undefined when omitted", () => {
    expect(normalizeSlackCanvasSectionType()).toBeUndefined();
  });

  it("rejects unsupported section types", () => {
    expect(() => normalizeSlackCanvasSectionType("paragraph")).toThrow(
      "Unsupported canvas section type. Use 'h1', 'h2', 'h3', or 'any_header'.",
    );
  });
});

describe("normalizeSlackCanvasCommentsLimit", () => {
  it("defaults to 20", () => {
    expect(normalizeSlackCanvasCommentsLimit()).toBe(20);
  });

  it("accepts bounded integer limits", () => {
    expect(normalizeSlackCanvasCommentsLimit(1)).toBe(1);
    expect(normalizeSlackCanvasCommentsLimit(200)).toBe(200);
  });

  it("rejects invalid limits", () => {
    expect(() => normalizeSlackCanvasCommentsLimit(0)).toThrow(
      "Canvas comment reads require limit to be an integer between 1 and 200.",
    );
    expect(() => normalizeSlackCanvasCommentsLimit(201)).toThrow(
      "Canvas comment reads require limit to be an integer between 1 and 200.",
    );
    expect(() => normalizeSlackCanvasCommentsLimit(1.5)).toThrow(
      "Canvas comment reads require limit to be an integer between 1 and 200.",
    );
  });
});

describe("buildSlackCanvasCreateRequest", () => {
  it("builds standalone canvas requests by default", () => {
    expect(buildSlackCanvasCreateRequest({ title: "Runbook", markdown: "# Hello" })).toEqual({
      kind: "standalone",
      method: "canvases.create",
      body: {
        title: "Runbook",
        document_content: { type: "markdown", markdown: "# Hello" },
      },
    });
  });

  it("attaches standalone canvases to a channel when provided", () => {
    expect(buildSlackCanvasCreateRequest({ channelId: "C123", markdown: "Attached" })).toEqual({
      kind: "standalone",
      method: "canvases.create",
      body: {
        channel_id: "C123",
        document_content: { type: "markdown", markdown: "Attached" },
      },
    });
  });

  it("builds channel canvas requests when requested", () => {
    expect(
      buildSlackCanvasCreateRequest({
        kind: "channel",
        channelId: "C123",
        title: "Project Status",
        markdown: "# Status",
      }),
    ).toEqual({
      kind: "channel",
      method: "conversations.canvases.create",
      body: {
        channel_id: "C123",
        title: "Project Status",
        document_content: { type: "markdown", markdown: "# Status" },
      },
    });
  });

  it("rejects channel canvases without a channel", () => {
    expect(() => buildSlackCanvasCreateRequest({ kind: "channel" })).toThrow(
      "Channel canvases require a channel.",
    );
  });
});

describe("buildSlackCanvasEditRequest", () => {
  it("appends content by default", () => {
    expect(buildSlackCanvasEditRequest({ canvasId: "F123", markdown: "More" })).toEqual({
      canvas_id: "F123",
      changes: [
        {
          operation: "insert_at_end",
          document_content: { type: "markdown", markdown: "More" },
        },
      ],
    });
  });

  it("prepends content when requested", () => {
    expect(
      buildSlackCanvasEditRequest({ canvasId: "F123", markdown: "Top", mode: "prepend" }),
    ).toEqual({
      canvas_id: "F123",
      changes: [
        {
          operation: "insert_at_start",
          document_content: { type: "markdown", markdown: "Top" },
        },
      ],
    });
  });

  it("replaces the whole canvas when no section is provided", () => {
    expect(
      buildSlackCanvasEditRequest({ canvasId: "F123", markdown: "Fresh", mode: "replace" }),
    ).toEqual({
      canvas_id: "F123",
      changes: [
        {
          operation: "replace",
          document_content: { type: "markdown", markdown: "Fresh" },
        },
      ],
    });
  });

  it("replaces a matched section when given a section id", () => {
    expect(
      buildSlackCanvasEditRequest({
        canvasId: "F123",
        markdown: "Fresh",
        mode: "replace",
        sectionId: "temp:C:123",
      }),
    ).toEqual({
      canvas_id: "F123",
      changes: [
        {
          operation: "replace",
          section_id: "temp:C:123",
          document_content: { type: "markdown", markdown: "Fresh" },
        },
      ],
    });
  });

  it("rejects missing canvas ids", () => {
    expect(() => buildSlackCanvasEditRequest({ canvasId: "", markdown: "x" })).toThrow(
      "Canvas updates require a canvas ID.",
    );
  });
});

describe("buildSlackCanvasSectionsLookupRequest", () => {
  it("builds lookup criteria from text only", () => {
    expect(
      buildSlackCanvasSectionsLookupRequest({ canvasId: "F123", containsText: "Status" }),
    ).toEqual({
      canvas_id: "F123",
      criteria: {
        contains_text: "Status",
      },
    });
  });

  it("includes section type when provided", () => {
    expect(
      buildSlackCanvasSectionsLookupRequest({
        canvasId: "F123",
        containsText: "Status",
        sectionType: "h2",
      }),
    ).toEqual({
      canvas_id: "F123",
      criteria: {
        contains_text: "Status",
        section_types: ["h2"],
      },
    });
  });
});

describe("pickSlackCanvasSectionId", () => {
  it("returns the only match", () => {
    expect(pickSlackCanvasSectionId([{ id: "temp:C:1" }])).toBe("temp:C:1");
  });

  it("allows selecting a specific match with section_index", () => {
    expect(pickSlackCanvasSectionId([{ id: "temp:C:1" }, { id: "temp:C:2" }], 2)).toBe("temp:C:2");
  });

  it("rejects ambiguous lookups without section_index", () => {
    expect(() => pickSlackCanvasSectionId([{ id: "temp:C:1" }, { id: "temp:C:2" }])).toThrow(
      "Canvas section lookup matched 2 sections. Provide section_index to choose one result or narrow the lookup.",
    );
  });

  it("rejects out-of-range section indexes", () => {
    expect(() => pickSlackCanvasSectionId([{ id: "temp:C:1" }], 2)).toThrow(
      "Canvas section lookup matched 1 sections; section_index 2 is out of range.",
    );
  });
});

describe("extractSlackCanvasCommentsPage", () => {
  it("extracts canvas comment pages from files.info responses", () => {
    expect(
      extractSlackCanvasCommentsPage({
        file: {
          id: "F123",
          title: "Launch plan",
          permalink: "https://example.slack.com/docs/T/F123",
          comments_count: 3,
        },
        comments: [
          { id: "Fc1", user: "U123", comment: "First comment", created: 1715000000 },
          { id: 2, user: "U234", text: "Second comment", ts: "1715000100" },
        ],
        paging: { page: 1, pages: 2, total: 3 },
        response_metadata: { next_cursor: "cursor-2" },
      }),
    ).toEqual({
      canvasId: "F123",
      title: "Launch plan",
      permalink: "https://example.slack.com/docs/T/F123",
      commentsCount: 3,
      returnedCount: 2,
      page: 1,
      pages: 2,
      nextCursor: "cursor-2",
      comments: [
        { id: "Fc1", userId: "U123", createdTs: "1715000000", text: "First comment" },
        { id: "2", userId: "U234", createdTs: "1715000100", text: "Second comment" },
      ],
    });
  });

  it("falls back to the requested canvas id and placeholder text when Slack omits fields", () => {
    expect(
      extractSlackCanvasCommentsPage(
        {
          file: {},
          comments: [{ id: "Fc1", user: "U123" }],
        },
        "F999",
      ),
    ).toEqual({
      canvasId: "F999",
      commentsCount: 1,
      returnedCount: 1,
      comments: [
        {
          id: "Fc1",
          userId: "U123",
          text: "(no comment text exposed by Slack)",
        },
      ],
    });
  });
});

describe("extractSlackChannelCanvasId", () => {
  it("reads the id from properties.canvas.id", () => {
    expect(
      extractSlackChannelCanvasId({
        channel: {
          properties: {
            canvas: { id: "F123" },
          },
        },
      }),
    ).toBe("F123");
  });

  it("falls back to channel_solutions.canvas_ids", () => {
    expect(
      extractSlackChannelCanvasId({
        channel: {
          properties: {
            channel_solutions: { canvas_ids: ["F234"] },
          },
        },
      }),
    ).toBe("F234");
  });

  it("returns null when only undocumented tab metadata is present", () => {
    expect(
      extractSlackChannelCanvasId({
        channel: {
          properties: {
            tabs: [{ id: "F345", type: "channel_canvas" }],
          },
        },
      }),
    ).toBeNull();
  });

  it("returns null when the channel has no canvas metadata", () => {
    expect(extractSlackChannelCanvasId({ channel: { properties: {} } })).toBeNull();
  });
});
