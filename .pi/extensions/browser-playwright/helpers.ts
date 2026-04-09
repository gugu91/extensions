import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

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

export interface PlaywrightStorageStateLike {
  cookies: unknown[];
  origins: unknown[];
}

export interface ChromiumExecutableCandidate {
  path: string;
  source: "env" | "path" | "system";
}

interface ChromiumExecutableLookupOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  accessImpl?: typeof access;
}

export const EXTENSION_RELATIVE_DIR = ".pi/extensions/browser-playwright";
export const STORAGE_STATE_RELATIVE_DIR = ".pi/state/browser-playwright";
export const DEFAULT_TEXT_LINES = 120;
export const DEFAULT_TEXT_CHARS = 4_000;

const STORAGE_STATE_NAME_MAX_CHARS = 80;
const CHROMIUM_PATH_NAMES_POSIX = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome",
] as const;
const CHROMIUM_PATH_NAMES_WINDOWS = ["chrome.exe", "chromium.exe"] as const;

export function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlagFrom(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  return raw != null && /^(1|true|yes|on)$/i.test(raw.trim());
}

export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagFrom(env, name);
}

export function resolveSecurityOptions(env: NodeJS.ProcessEnv = process.env): SecurityOptions {
  return {
    allowLocalhost: envFlagFrom(env, "BROWSER_ALLOW_LOCALHOST"),
    allowPrivateNetwork: envFlagFrom(env, "BROWSER_ALLOW_PRIVATE_NETWORK"),
  };
}

export function sanitizeLabel(value: string | undefined): string {
  const base = (value ?? "screenshot").trim().toLowerCase();
  const cleaned = base.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "screenshot";
}

export function sanitizeStorageStateName(value: string): string {
  const base = value.trim().toLowerCase().replace(/\.json$/i, "");
  const cleaned = base.replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (!/[a-z0-9]/.test(cleaned)) {
    throw new Error("Storage state names must contain at least one letter or number.");
  }
  return cleaned.slice(0, STORAGE_STATE_NAME_MAX_CHARS);
}

export function buildStorageStateFileName(value: string): string {
  return `${sanitizeStorageStateName(value)}.json`;
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
  extensionDir = EXTENSION_RELATIVE_DIR,
): string {
  const commands = [`cd \"${extensionDir}\"`, ...(includeNpmInstall ? ["npm install"] : [])];
  if (browserEngine === "chromium") {
    commands.push("npx playwright install chromium");
  } else {
    commands.push(`npx playwright install ${browserEngine}`);
  }

  const browserInstallHeading =
    browserEngine === "chromium"
      ? [
          "The extension prefers a host Chrome/Chromium executable when one is available.",
          "If no compatible host browser is found, install Playwright Chromium:",
        ]
      : [`Install the browser-playwright extension dependencies and ${browserEngine} browser binaries:`];

  return [
    reason,
    "",
    ...browserInstallHeading,
    ...commands.map((command) => `  ${command}`),
    "",
    "If you've symlinked the extension into `~/.pi/extensions`, run the same commands from that symlink path or the source directory.",
  ].join("\n");
}

function pathEntries(rawPath: string | undefined): string[] {
  if (!rawPath) return [];
  return rawPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function chromiumExecutableCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ChromiumExecutableCandidate[] {
  const candidates: ChromiumExecutableCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: ChromiumExecutableCandidate | null) => {
    if (!candidate) return;
    const normalized = candidate.path.trim();
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ ...candidate, path: normalized });
  };

  const configuredPath = env.BROWSER_PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  push(
    configuredPath
      ? {
          path: configuredPath,
          source: "env",
        }
      : null,
  );

  const pathNames =
    platform === "win32" ? CHROMIUM_PATH_NAMES_WINDOWS : CHROMIUM_PATH_NAMES_POSIX;
  for (const entry of pathEntries(env.PATH)) {
    for (const executableName of pathNames) {
      push({
        path: join(entry, executableName),
        source: "path",
      });
    }
  }

  const home = env.HOME ?? "";
  const localAppData = env.LOCALAPPDATA ?? "";
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? "";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? env.PROGRAMFILES_X86 ?? "";

  if (platform === "darwin") {
    for (const candidatePath of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      home ? join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome") : "",
      home
        ? join(home, "Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
        : "",
      home ? join(home, "Applications/Chromium.app/Contents/MacOS/Chromium") : "",
    ]) {
      push(candidatePath ? { path: candidatePath, source: "system" } : null);
    }
  }

  if (platform === "linux") {
    for (const candidatePath of [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ]) {
      push({ path: candidatePath, source: "system" });
    }
  }

  if (platform === "win32") {
    for (const candidatePath of [
      localAppData ? join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
      programFiles ? join(programFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
      programFilesX86
        ? join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
        : "",
      programFiles ? join(programFiles, "Chromium", "Application", "chrome.exe") : "",
      programFilesX86
        ? join(programFilesX86, "Chromium", "Application", "chrome.exe")
        : "",
    ]) {
      push(candidatePath ? { path: candidatePath, source: "system" } : null);
    }
  }

  return candidates;
}

export async function findPreferredChromiumExecutable(
  options: ChromiumExecutableLookupOptions = {},
): Promise<ChromiumExecutableCandidate | null> {
  const {
    env = process.env,
    platform = process.platform,
    accessImpl = access,
  } = options;

  for (const candidate of chromiumExecutableCandidates(env, platform)) {
    try {
      await accessImpl(candidate.path, constants.X_OK);
      return candidate;
    } catch {
      // try the next candidate
    }
  }

  return null;
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

export function isPlaywrightStorageState(
  value: unknown,
): value is PlaywrightStorageStateLike {
  if (value == null || typeof value !== "object") {
    return false;
  }

  const record = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(record.cookies) && Array.isArray(record.origins);
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

export function isLocalhostUrl(input: string): boolean {
  const url = normalizeUrl(input);
  const hostname = url.hostname;
  return isLocalhostName(hostname) || hostname === "127.0.0.1" || hostname === "::1";
}

export function resolveNavigationSecurityOptions(
  input: string,
  options: SecurityOptions,
): SecurityOptions {
  return isLocalhostUrl(input) ? { ...options, allowLocalhost: true } : options;
}

export function resolveRouteSecurityOptions(
  options: SecurityOptions,
  context: { trustedLocalhostPage: boolean },
): SecurityOptions {
  return context.trustedLocalhostPage ? { ...options, allowLocalhost: true } : options;
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
