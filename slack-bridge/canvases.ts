export interface SlackCanvasDocumentContent {
  type: "markdown";
  markdown: string;
}

export type SlackCanvasCreateMethod = "canvases.create" | "conversations.canvases.create";
export type SlackCanvasCreateKind = "standalone" | "channel";
export type SlackCanvasUpdateMode = "append" | "prepend" | "replace";
export type SlackCanvasSectionType = "h1" | "h2" | "h3" | "any_header";
export type SlackCanvasEditOperation = "insert_at_end" | "insert_at_start" | "replace";

export interface SlackCanvasCreateInput {
  kind?: string;
  title?: string;
  markdown?: string;
  channelId?: string;
}

export interface SlackCanvasCreateRequest {
  kind: SlackCanvasCreateKind;
  method: SlackCanvasCreateMethod;
  body: {
    title?: string;
    channel_id?: string;
    document_content?: SlackCanvasDocumentContent;
  };
}

export interface SlackCanvasEditRequest {
  canvas_id: string;
  changes: [
    {
      operation: SlackCanvasEditOperation;
      document_content: SlackCanvasDocumentContent;
      section_id?: string;
    },
  ];
}

export interface SlackCanvasSectionLookupRequest {
  canvas_id: string;
  criteria: {
    contains_text: string;
    section_types?: SlackCanvasSectionType[];
  };
}

export interface SlackCanvasReadRequest {
  canvas_id: string;
}

export interface SlackCanvasSectionLookupResult {
  id?: string;
  markdown?: string;
}

function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildDocumentContent(markdown?: string): SlackCanvasDocumentContent | undefined {
  if (markdown == null || markdown.length === 0) return undefined;
  return { type: "markdown", markdown };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map(asString).filter((item): item is string => Boolean(item));
  return strings.length > 0 ? strings : undefined;
}

export function normalizeSlackCanvasCreateKind(kind?: string): SlackCanvasCreateKind {
  const normalized = kind?.trim().toLowerCase();
  if (!normalized) return "standalone";
  if (normalized === "standalone" || normalized === "channel") {
    return normalized;
  }
  throw new Error("Unsupported canvas kind. Use 'standalone' or 'channel'.");
}

export function normalizeSlackCanvasUpdateMode(mode?: string): SlackCanvasUpdateMode {
  const normalized = mode?.trim().toLowerCase();
  if (!normalized) return "append";
  if (normalized === "append" || normalized === "prepend" || normalized === "replace") {
    return normalized;
  }
  throw new Error("Unsupported canvas update mode. Use 'append', 'prepend', or 'replace'.");
}

export function normalizeSlackCanvasSectionType(type?: string): SlackCanvasSectionType | undefined {
  const normalized = type?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized === "h1" ||
    normalized === "h2" ||
    normalized === "h3" ||
    normalized === "any_header"
  ) {
    return normalized;
  }
  throw new Error("Unsupported canvas section type. Use 'h1', 'h2', 'h3', or 'any_header'.");
}

export function buildSlackCanvasCreateRequest(
  input: SlackCanvasCreateInput,
): SlackCanvasCreateRequest {
  const kind = normalizeSlackCanvasCreateKind(input.kind);
  const channelId = normalizeOptionalString(input.channelId);
  const title = normalizeOptionalString(input.title);
  const documentContent = buildDocumentContent(input.markdown);

  if (kind === "channel") {
    if (!channelId) {
      throw new Error("Channel canvases require a channel.");
    }
    return {
      kind,
      method: "conversations.canvases.create",
      body: {
        ...(title ? { title } : {}),
        ...(documentContent ? { document_content: documentContent } : {}),
        channel_id: channelId,
      },
    };
  }

  return {
    kind,
    method: "canvases.create",
    body: {
      ...(title ? { title } : {}),
      ...(documentContent ? { document_content: documentContent } : {}),
      ...(channelId ? { channel_id: channelId } : {}),
    },
  };
}

export function buildSlackCanvasEditRequest(input: {
  canvasId: string;
  markdown: string;
  mode?: string;
  sectionId?: string;
}): SlackCanvasEditRequest {
  const canvasId = normalizeOptionalString(input.canvasId);
  if (!canvasId) {
    throw new Error("Canvas updates require a canvas ID.");
  }
  if (input.markdown.length === 0) {
    throw new Error("Canvas updates require markdown content.");
  }

  const sectionId = normalizeOptionalString(input.sectionId);
  const mode = normalizeSlackCanvasUpdateMode(input.mode);
  const operation: SlackCanvasEditOperation =
    mode === "append" ? "insert_at_end" : mode === "prepend" ? "insert_at_start" : "replace";

  return {
    canvas_id: canvasId,
    changes: [
      {
        operation,
        document_content: { type: "markdown", markdown: input.markdown },
        ...(sectionId ? { section_id: sectionId } : {}),
      },
    ],
  };
}

export function buildSlackCanvasSectionsLookupRequest(input: {
  canvasId: string;
  containsText: string;
  sectionType?: string;
}): SlackCanvasSectionLookupRequest {
  const canvasId = normalizeOptionalString(input.canvasId);
  if (!canvasId) {
    throw new Error("Canvas section lookups require a canvas ID.");
  }

  const containsText = normalizeOptionalString(input.containsText);
  if (!containsText) {
    throw new Error("Canvas section lookups require text to match.");
  }

  const sectionType = normalizeSlackCanvasSectionType(input.sectionType);
  return {
    canvas_id: canvasId,
    criteria: {
      contains_text: containsText,
      ...(sectionType ? { section_types: [sectionType] } : {}),
    },
  };
}

export function buildSlackCanvasReadRequest(input: { canvasId: string }): SlackCanvasReadRequest {
  const canvasId = normalizeOptionalString(input.canvasId);
  if (!canvasId) {
    throw new Error("Canvas reads require a canvas ID.");
  }

  return { canvas_id: canvasId };
}

export function extractSlackCanvasMarkdown(
  sections: SlackCanvasSectionLookupResult[] | undefined,
): string {
  const markdown = (sections ?? [])
    .map((section) => normalizeOptionalString(section.markdown))
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
    .trim();

  return markdown;
}

export function pickSlackCanvasSectionId(
  sections: SlackCanvasSectionLookupResult[] | undefined,
  sectionIndex?: number,
): string {
  const matches = (sections ?? [])
    .map((section) => normalizeOptionalString(section.id))
    .filter((id): id is string => Boolean(id));

  if (matches.length === 0) {
    throw new Error("No canvas sections matched the lookup.");
  }

  if (sectionIndex != null) {
    if (!Number.isInteger(sectionIndex) || sectionIndex < 1) {
      throw new Error("section_index must be a positive integer.");
    }
    const selected = matches[sectionIndex - 1];
    if (!selected) {
      throw new Error(
        `Canvas section lookup matched ${matches.length} sections; section_index ${sectionIndex} is out of range.`,
      );
    }
    return selected;
  }

  if (matches.length > 1) {
    throw new Error(
      `Canvas section lookup matched ${matches.length} sections. Provide section_index to choose one result or narrow the lookup.`,
    );
  }

  return matches[0];
}

export function extractSlackChannelCanvasId(response: Record<string, unknown>): string | null {
  const channel = asRecord(response.channel);
  const properties = asRecord(channel?.properties);
  if (!properties) return null;

  const directCanvas = asString(properties.canvas);
  if (directCanvas) return directCanvas;

  const canvasRecord = asRecord(properties.canvas);
  const canvasId = asString(canvasRecord?.id) ?? asString(canvasRecord?.canvas_id);
  if (canvasId) return canvasId;

  const channelSolutions = asRecord(properties.channel_solutions);
  const canvasIds = asStringArray(channelSolutions?.canvas_ids);
  if (canvasIds?.[0]) return canvasIds[0];

  return null;
}

export function extractExistingChannelCanvasId(response: Record<string, unknown>): string | null {
  const canvasId = extractSlackChannelCanvasId(response);
  return canvasId;
}
