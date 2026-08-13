export const DEFAULT_MAX_OUTPUT_LINES = 2_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1_024;

export interface HeadTruncation {
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export function formatOutputSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

export function measureHeadTruncation(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): HeadTruncation {
  const maxLines = options.maxLines ?? DEFAULT_MAX_OUTPUT_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const lines = content.length === 0 ? [] : content.split("\n");
  if (content.endsWith("\n")) lines.pop();

  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      truncated: false,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) break;
    outputLines.push(line);
    outputBytes += lineBytes;
  }

  return {
    truncated: true,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(outputLines.join("\n"), "utf8"),
  };
}
