function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipLine(value: string, maxLength = 220): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function pushContextLine(
  lines: string[],
  rawValue: string | null | undefined,
  maxLength = 220,
): void {
  if (!rawValue) return;
  const normalized = clipLine(normalizeWhitespace(rawValue), maxLength);
  if (!normalized) return;
  lines.push(normalized);
}

export interface SlackInboundFileContext {
  id?: string;
  title?: string;
  name?: string;
  prettyType?: string;
  filetype?: string;
  mimetype?: string;
  mode?: string;
  permalink?: string;
  urlPrivate?: string;
  preview?: string;
}

function extractTextObject(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];

  const text = asString(record.text);
  return text ? [text] : [];
}

function extractRichTextElementText(element: Record<string, unknown>): string[] {
  const type = asString(element.type) ?? "";

  switch (type) {
    case "text": {
      const text = asString(element.text);
      return text ? [text] : [];
    }
    case "link": {
      const text = asString(element.text);
      const url = asString(element.url);
      if (text && url && text !== url) {
        return [`${text} (${url})`];
      }
      return text ? [text] : url ? [url] : [];
    }
    case "emoji": {
      const name = asString(element.name);
      return name ? [`:${name}:`] : [];
    }
    case "user": {
      const userId = asString(element.user_id);
      return userId ? [`<@${userId}>`] : [];
    }
    case "channel": {
      const channelId = asString(element.channel_id);
      return channelId ? [`<#${channelId}>`] : [];
    }
    case "rich_text_section":
    case "rich_text_list":
    case "rich_text_quote":
    case "rich_text_preformatted": {
      return asRecordArray(element.elements).flatMap((child) => extractRichTextElementText(child));
    }
    default:
      return [];
  }
}

function extractBlockContextLines(blocks: unknown): string[] {
  const lines: string[] = [];

  for (const block of asRecordArray(blocks)) {
    const type = asString(block.type) ?? "";

    switch (type) {
      case "header":
      case "section": {
        for (const value of extractTextObject(block.text)) {
          pushContextLine(lines, value);
        }
        for (const field of asRecordArray(block.fields)) {
          for (const value of extractTextObject(field)) {
            pushContextLine(lines, value);
          }
        }
        break;
      }
      case "context": {
        for (const element of asRecordArray(block.elements)) {
          for (const value of extractTextObject(element)) {
            pushContextLine(lines, value);
          }
        }
        break;
      }
      case "image": {
        pushContextLine(lines, asString(block.alt_text));
        break;
      }
      case "rich_text": {
        for (const element of asRecordArray(block.elements)) {
          const text = extractRichTextElementText(element).join("");
          pushContextLine(lines, text);
        }
        break;
      }
      default:
        break;
    }
  }

  return lines;
}

function extractAttachmentContextLines(attachments: unknown): string[] {
  const lines: string[] = [];

  for (const attachment of asRecordArray(attachments)) {
    pushContextLine(lines, asString(attachment.pretext));
    pushContextLine(lines, asString(attachment.title));
    pushContextLine(lines, asString(attachment.text));
    pushContextLine(lines, asString(attachment.fallback));
    pushContextLine(lines, asString(attachment.footer));
    lines.push(...extractBlockContextLines(attachment.blocks));
  }

  return lines;
}

function extractSlackInboundFiles(files: unknown): SlackInboundFileContext[] {
  const extracted: SlackInboundFileContext[] = [];

  for (const file of asRecordArray(files)) {
    const entry: SlackInboundFileContext = {};

    const id = asString(file.id);
    if (id) entry.id = id;

    const title = asString(file.title);
    if (title) entry.title = title;

    const name = asString(file.name);
    if (name) entry.name = name;

    const prettyType = asString(file.pretty_type);
    if (prettyType) entry.prettyType = prettyType;

    const filetype = asString(file.filetype);
    if (filetype) entry.filetype = filetype;

    const mimetype = asString(file.mimetype);
    if (mimetype) entry.mimetype = mimetype;

    const mode = asString(file.mode);
    if (mode) entry.mode = mode;

    const permalink = asString(file.permalink);
    if (permalink) entry.permalink = permalink;

    const urlPrivate = asString(file.url_private_download) ?? asString(file.url_private);
    if (urlPrivate) entry.urlPrivate = urlPrivate;

    const preview = asString(file.preview);
    if (preview) entry.preview = preview;

    if (Object.keys(entry).length > 0) {
      extracted.push(entry);
    }
  }

  return extracted;
}

function buildSlackFileSummaryLine(file: SlackInboundFileContext): string | null {
  const label = file.title ?? file.name ?? null;
  const type = file.prettyType ?? file.filetype ?? file.mimetype ?? null;
  const parts = [label, type, file.mode].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" — ") : null;
}

function buildSlackFileHandleLine(file: SlackInboundFileContext): string | null {
  const parts = [
    file.id ? `file_id=${file.id}` : null,
    file.permalink ? `permalink=${file.permalink}` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" | ") : null;
}

function extractFileContextLines(files: unknown): string[] {
  const lines: string[] = [];

  for (const file of extractSlackInboundFiles(files)) {
    pushContextLine(lines, buildSlackFileSummaryLine(file));
    pushContextLine(lines, buildSlackFileHandleLine(file), 500);
    pushContextLine(lines, file.preview);
  }

  return lines;
}

function dedupeContextLines(baseText: string, lines: string[]): string[] {
  const baseNormalized = normalizeWhitespace(baseText).toLowerCase();
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const line of lines) {
    const normalized = normalizeWhitespace(line).toLowerCase();
    if (!normalized) continue;
    if (baseNormalized && normalized === baseNormalized) {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(line);
  }

  return deduped;
}

export function extractSlackMessageContextLines(
  evt: Record<string, unknown>,
  baseText = "",
): string[] {
  const lines = [
    ...extractBlockContextLines(evt.blocks),
    ...extractAttachmentContextLines(evt.attachments),
    ...extractFileContextLines(evt.files),
  ];

  return dedupeContextLines(baseText, lines).slice(0, 4);
}

export function extractSlackInboundMessageMetadata(
  evt: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const files = extractSlackInboundFiles(evt.files);
  if (files.length === 0) {
    return undefined;
  }

  return {
    kind: "slack_file_context",
    files,
  };
}

export function buildSlackInboundMessageText(
  baseText: string,
  evt: Record<string, unknown>,
): string {
  const trimmedBase = baseText.trim();
  const contextLines = extractSlackMessageContextLines(evt, trimmedBase);

  if (contextLines.length === 0) {
    return trimmedBase;
  }

  const prefix = trimmedBase.length > 0 ? trimmedBase : "(Slack message had no plain-text body)";
  return `${prefix}\n\nSlack message context:\n${contextLines.map((line) => `- ${line}`).join("\n")}`;
}
