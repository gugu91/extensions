export const DEFAULT_MAX_OUTPUT_LINES = 2_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1_024;

export function formatOutputSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

export function measureOutputLimits(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): { exceedsLimit: boolean; totalLines: number; totalBytes: number } {
  const maxLines = options.maxLines ?? DEFAULT_MAX_OUTPUT_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const totalLines =
    content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  const totalBytes = Buffer.byteLength(content, "utf8");

  return {
    exceedsLimit: totalLines > maxLines || totalBytes > maxBytes,
    totalLines,
    totalBytes,
  };
}
