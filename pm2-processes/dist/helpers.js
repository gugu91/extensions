import { Buffer } from "node:buffer";
export function normalizeTarget(target, apps, options) {
    const requested = target?.trim() || (options.defaultAll ? "all" : undefined);
    if (!requested)
        throw new Error("A target app name is required for this PM2 action");
    if (requested === "all") {
        if (!options.allowAll)
            throw new Error("Target 'all' is not supported for this PM2 action");
        return { targetLabel: "all", names: apps.map((app) => app.name) };
    }
    const app = apps.find((candidate) => candidate.name === requested);
    if (!app) {
        const allowed = apps.map((candidate) => candidate.name).join(", ");
        throw new Error(`Unknown PM2 app '${requested}'. Allowed targets: ${allowed}`);
    }
    return { targetLabel: app.name, names: [app.name] };
}
export function normalizeLines(lines, defaultLines, maxLines) {
    if (lines === undefined || !Number.isFinite(lines))
        return defaultLines;
    return Math.min(maxLines, Math.max(1, Math.floor(lines)));
}
export function truncateTail(text, maxBytes, maxLines) {
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const tailLines = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
    const buffer = Buffer.from(tailLines, "utf8");
    const truncatedByLines = lines.length > maxLines;
    if (buffer.byteLength <= maxBytes) {
        return { text: tailLines, truncated: truncatedByLines };
    }
    const slice = buffer.subarray(Math.max(0, buffer.byteLength - maxBytes)).toString("utf8");
    const firstNewline = slice.indexOf("\n");
    const safeSlice = firstNewline >= 0 ? slice.slice(firstNewline + 1) : slice;
    return { text: safeSlice, truncated: true };
}
export function formatBytes(bytes) {
    if (bytes === undefined || !Number.isFinite(bytes))
        return "n/a";
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
export function formatUptime(startedAt, now = Date.now()) {
    if (!startedAt || !Number.isFinite(startedAt))
        return "n/a";
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d${hours % 24}h`;
}
export function buildPlainTable(headers, rows) {
    const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)));
    const renderRow = (row) => row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join("  ")
        .trimEnd();
    return [
        renderRow(headers),
        renderRow(widths.map((width) => "-".repeat(width))),
        ...rows.map(renderRow),
    ].join("\n");
}
export function summarizeCommandOutput(stdout, stderr, maxBytes) {
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    if (!combined)
        return "(no output)";
    return truncateTail(combined, maxBytes, 200).text;
}
