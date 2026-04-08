export type UrlDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      hint?: string;
    };

export type SecurityOptions = {
  allowLocalhost: boolean;
  allowPrivateNetwork: boolean;
};

export type SupportedBrowserEngine = "chromium" | "firefox" | "webkit";

export const EXTENSION_RELATIVE_DIR = ".pi/extensions/browser-playwright";
export const DEFAULT_TEXT_LINES = 120;
export const DEFAULT_TEXT_CHARS = 4_000;

export function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw != null && /^(1|true|yes|on)$/i.test(raw.trim());
}

export function sanitizeLabel(value: string | undefined): string {
  const base = (value ?? "screenshot").trim().toLowerCase();
  const cleaned = base.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "screenshot";
}

export function truncateText(
  text: string,
  maxChars = DEFAULT_TEXT_CHARS,
  maxLines = DEFAULT_TEXT_LINES,
): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return "";

  const lines = normalized.split("\n");
  let result = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;

  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
    truncated = true;
  }

  result = result.trim();
  if (truncated) {
    result = `${result}\n… [truncated]`;
  }
  return result;
}

export function buildInstallInstructions(
  reason: string,
  includeNpmInstall = true,
  browserEngine: SupportedBrowserEngine = "chromium",
): string {
  const commands = [
    `cd ${EXTENSION_RELATIVE_DIR}`,
    ...(includeNpmInstall ? ["npm install"] : []),
    `npx playwright install ${browserEngine}`,
  ];

  return [
    reason,
    "",
    `Install the browser-playwright extension dependencies and ${browserEngine} browser binaries:`,
    ...commands.map((command) => `  ${command}`),
  ].join("\n");
}

export function safeRequestPageId<PageLike>(
  request: { frame(): { page(): PageLike } },
  resolvePageId: (page: PageLike) => string | null | undefined,
): string | null {
  try {
    return resolvePageId(request.frame().page()) ?? null;
  } catch {
    return null;
  }
}

function normalizeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(`Invalid URL: ${input}`, { cause: error instanceof Error ? error : undefined });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Only http/https URLs are allowed. Received protocol \`${url.protocol.replace(/:$/, "")}\`.`,
    );
  }

  return url;
}

function isLocalhostName(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized.endsWith(".localhost")
  );
}

function isObviouslyInternalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "host.docker.internal" ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".local") ||
    (!normalized.includes(".") && normalized !== "")
  );
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 0) return true;
  if (a === 127) return false;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized === "::" ||
    normalized === "0:0:0:0:0:0:0:0"
  );
}

export function assessUrl(input: string, options: SecurityOptions): UrlDecision {
  const url = normalizeUrl(input);
  const hostname = url.hostname;

  if (isLocalhostName(hostname) || hostname === "127.0.0.1" || hostname === "::1") {
    if (options.allowLocalhost) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Blocked localhost URL: ${url.toString()}`,
      hint: "Set BROWSER_ALLOW_LOCALHOST=true to allow trusted local development targets.",
    };
  }

  const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const isIpv6 = hostname.includes(":");

  if ((isIpv4 && isPrivateIpv4(hostname)) || (isIpv6 && isPrivateIpv6(hostname))) {
    if (options.allowPrivateNetwork) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Blocked private-network URL: ${url.toString()}`,
      hint: "Set BROWSER_ALLOW_PRIVATE_NETWORK=true to allow trusted private-network targets.",
    };
  }

  if (isObviouslyInternalHostname(hostname)) {
    if (options.allowPrivateNetwork) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Blocked internal hostname: ${url.toString()}`,
      hint: "Set BROWSER_ALLOW_PRIVATE_NETWORK=true to allow trusted internal hostnames.",
    };
  }

  return { allowed: true };
}
