import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  assessUrl,
  buildInstallInstructions,
  envFlag,
  parseIntegerEnv,
  resolveStorageStateExportPath,
  resolveStorageStateImportPath,
  safeRequestPageId,
  sanitizeLabel,
  truncateText,
  type SupportedBrowserEngine,
} from "./helpers.ts";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  ConsoleMessage,
  Locator,
  Page,
  Request,
  Route,
} from "playwright";

type PlaywrightModule = typeof import("playwright");

type BrowserEngine = SupportedBrowserEngine;

type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

type PageSummary = {
  page_id: string;
  url: string;
  title: string | null;
  is_active: boolean;
  closed: boolean;
  created_at: string;
  last_activity_at: string;
};

type ConsoleEntry = {
  timestamp: string;
  page_id: string;
  type: string;
  text: string;
};

type BlockedRequestEntry = {
  timestamp: string;
  page_id: string | null;
  url: string;
  resource_type: string;
  reason: string;
};

type NetworkSummary = {
  total_requests: number;
  blocked_requests: number;
  failed_requests: number;
};

type BrowserPageRecord = {
  id: string;
  page: Page;
  createdAt: string;
  lastActivityAt: string;
};

type BrowserSession = {
  id: string;
  browserEngine: BrowserEngine;
  browser: Browser;
  context: BrowserContext;
  createdAt: string;
  lastActivityAt: string;
  headless: boolean;
  storageStatePath: string | null;
  pages: Map<string, BrowserPageRecord>;
  pageIds: WeakMap<Page, string>;
  activePageId: string | null;
  consoleEntries: ConsoleEntry[];
  blockedRequests: BlockedRequestEntry[];
  networkSummary: NetworkSummary;
};

export type BrowserPlaywrightExtensionDeps = {
  loadPlaywright?: (browserEngine: BrowserEngine) => Promise<PlaywrightModule>;
  workspaceRoot?: string;
  artifactRoot?: string;
};

const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));
const WORKSPACE_ROOT = resolve(EXTENSION_DIR, "../../..");
const DEFAULT_ARTIFACT_ROOT = resolve(EXTENSION_DIR, "../../artifacts/browser-playwright");

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_MS = parseIntegerEnv("BROWSER_PLAYWRIGHT_IDLE_TIMEOUT_MS", 15 * 60_000);
const SESSION_SWEEP_INTERVAL_MS = 60_000;
const MAX_CONSOLE_ENTRIES = 25;
const MAX_BLOCKED_REQUESTS = 25;
const MAX_SNAPSHOT_TEXT_CHARS = 6_000;
const MAX_COLLECTION_ITEMS = 10;

const WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle", "commit"] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function loadPlaywright(browserEngine: BrowserEngine): Promise<PlaywrightModule> {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error(
      buildInstallInstructions(
        "Playwright is not installed for `.pi/extensions/browser-playwright`.",
        true,
        browserEngine,
      ),
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function isMissingBrowserExecutableError(error: unknown): boolean {
  const message = asErrorMessage(error);
  return (
    message.includes("Executable doesn't exist") ||
    message.includes("browserType.launch") ||
    message.includes("Please run the following command")
  );
}

function isWaitUntil(value: string): value is WaitUntil {
  return WAIT_UNTIL_VALUES.includes(value as WaitUntil);
}

function normalizeWaitUntil(value: string | undefined): WaitUntil {
  if (!value) return "domcontentloaded";
  if (!isWaitUntil(value)) {
    throw new Error(
      `Unsupported wait_until value \`${value}\`. Use one of: ${WAIT_UNTIL_VALUES.join(", ")}.`,
    );
  }
  return value;
}

function getSecurityOptions(): { allowLocalhost: boolean; allowPrivateNetwork: boolean } {
  return {
    allowLocalhost: envFlag("BROWSER_ALLOW_LOCALHOST"),
    allowPrivateNetwork: envFlag("BROWSER_ALLOW_PRIVATE_NETWORK"),
  };
}

function recordConsoleEntry(session: BrowserSession, entry: ConsoleEntry): void {
  session.consoleEntries.push(entry);
  if (session.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    session.consoleEntries.splice(0, session.consoleEntries.length - MAX_CONSOLE_ENTRIES);
  }
}

function recordBlockedRequest(session: BrowserSession, entry: BlockedRequestEntry): void {
  session.blockedRequests.push(entry);
  session.networkSummary.blocked_requests += 1;
  if (session.blockedRequests.length > MAX_BLOCKED_REQUESTS) {
    session.blockedRequests.splice(0, session.blockedRequests.length - MAX_BLOCKED_REQUESTS);
  }
}

function touchSession(session: BrowserSession): void {
  session.lastActivityAt = nowIso();
}

function touchPage(pageRecord: BrowserPageRecord): void {
  pageRecord.lastActivityAt = nowIso();
}

async function safeTitle(page: Page): Promise<string | null> {
  try {
    const title = await page.title();
    return title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

function getPageRecord(session: BrowserSession, pageId: string): BrowserPageRecord {
  const pageRecord = session.pages.get(pageId);
  if (!pageRecord) {
    throw new Error(`Unknown page_id: ${pageId}`);
  }
  return pageRecord;
}

async function buildPageSummary(
  session: BrowserSession,
  pageRecord: BrowserPageRecord,
): Promise<PageSummary> {
  return {
    page_id: pageRecord.id,
    url: pageRecord.page.url(),
    title: await safeTitle(pageRecord.page),
    is_active: session.activePageId === pageRecord.id,
    closed: pageRecord.page.isClosed(),
    created_at: pageRecord.createdAt,
    last_activity_at: pageRecord.lastActivityAt,
  };
}

async function listPages(session: BrowserSession): Promise<PageSummary[]> {
  const summaries = await Promise.all(
    [...session.pages.values()].map((pageRecord) => buildPageSummary(session, pageRecord)),
  );
  return summaries.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function getSessionOrThrow(
  sessions: Map<string, BrowserSession>,
  sessionId: string,
): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown session_id: ${sessionId}`);
  }
  touchSession(session);
  return session;
}

async function registerPage(session: BrowserSession, page: Page): Promise<BrowserPageRecord> {
  const existingPageId = session.pageIds.get(page);
  if (existingPageId) {
    return getPageRecord(session, existingPageId);
  }

  const pageRecord: BrowserPageRecord = {
    id: `page_${randomUUID()}`,
    page,
    createdAt: nowIso(),
    lastActivityAt: nowIso(),
  };

  session.pageIds.set(page, pageRecord.id);
  session.pages.set(pageRecord.id, pageRecord);
  session.activePageId = pageRecord.id;
  touchSession(session);

  page.on("console", (message: ConsoleMessage) => {
    recordConsoleEntry(session, {
      timestamp: nowIso(),
      page_id: pageRecord.id,
      type: message.type(),
      text: truncateText(message.text(), 500, 12),
    });
  });

  page.on("pageerror", (error: Error) => {
    recordConsoleEntry(session, {
      timestamp: nowIso(),
      page_id: pageRecord.id,
      type: "pageerror",
      text: truncateText(error.message, 500, 12),
    });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      touchPage(pageRecord);
      touchSession(session);
      session.activePageId = pageRecord.id;
    }
  });

  page.on("requestfailed", () => {
    session.networkSummary.failed_requests += 1;
  });

  page.on("close", () => {
    session.pages.delete(pageRecord.id);
    if (session.activePageId === pageRecord.id) {
      session.activePageId = [...session.pages.keys()][0] ?? null;
    }
    touchSession(session);
  });

  return pageRecord;
}

async function createTrackedPage(session: BrowserSession): Promise<BrowserPageRecord> {
  const page = await session.context.newPage();
  return registerPage(session, page);
}

async function resolvePageRecord(
  session: BrowserSession,
  pageId: string | undefined,
  createIfMissing: boolean,
): Promise<BrowserPageRecord> {
  if (pageId) {
    const pageRecord = getPageRecord(session, pageId);
    touchPage(pageRecord);
    return pageRecord;
  }

  if (session.activePageId && session.pages.has(session.activePageId)) {
    const pageRecord = getPageRecord(session, session.activePageId);
    touchPage(pageRecord);
    return pageRecord;
  }

  const firstPage = session.pages.values().next().value as BrowserPageRecord | undefined;
  if (firstPage) {
    session.activePageId = firstPage.id;
    touchPage(firstPage);
    return firstPage;
  }

  if (!createIfMissing) {
    throw new Error(`Session ${session.id} has no open pages. Start a new tab or session.`);
  }

  return createTrackedPage(session);
}

function maybeLastBlockedRequest(session: BrowserSession, url: string): BlockedRequestEntry | null {
  const normalized = url.replace(/\/$/, "");
  for (let index = session.blockedRequests.length - 1; index >= 0; index -= 1) {
    const entry = session.blockedRequests[index];
    if (entry.url.replace(/\/$/, "") === normalized) {
      return entry;
    }
  }
  return null;
}

async function gotoWithSafety(
  session: BrowserSession,
  pageRecord: BrowserPageRecord,
  url: string,
  waitUntil: WaitUntil,
  timeoutMs: number,
): Promise<void> {
  const decision = assessUrl(url, getSecurityOptions());
  if (!decision.allowed) {
    throw new Error([decision.reason, decision.hint].filter(Boolean).join("\n"));
  }

  try {
    await pageRecord.page.goto(url, { waitUntil, timeout: timeoutMs });
    session.activePageId = pageRecord.id;
    touchPage(pageRecord);
    touchSession(session);
  } catch (error) {
    const blocked = maybeLastBlockedRequest(session, url);
    if (blocked) {
      throw new Error(blocked.reason);
    }
    throw error;
  }
}

async function waitForPossibleNavigation(
  page: Page,
  previousUrl: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.waitForURL((current) => current.toString() !== previousUrl, {
      timeout: Math.min(timeoutMs, 3_000),
    });
    return;
  } catch {
    // fall through
  }

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 3_000) });
  } catch {
    // best effort
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function buildElementSummary(
  locator: Locator,
  attribute: string | undefined,
): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};

  const text = truncateText(
    await locator.innerText().catch(async () => (await locator.textContent()) ?? ""),
  );
  if (text) {
    summary.text = text;
  }

  if (attribute) {
    summary.attribute = attribute;
    summary.value = (await locator.getAttribute(attribute)) ?? null;
    return summary;
  }

  const href = await locator.getAttribute("href").catch(() => null);
  const src = await locator.getAttribute("src").catch(() => null);
  const placeholder = await locator.getAttribute("placeholder").catch(() => null);
  const ariaLabel = await locator.getAttribute("aria-label").catch(() => null);
  const name = await locator.getAttribute("name").catch(() => null);
  const type = await locator.getAttribute("type").catch(() => null);
  const role = await locator.getAttribute("role").catch(() => null);
  const value = await locator.inputValue().catch(() => null);

  if (href) summary.href = href;
  if (src) summary.src = src;
  if (placeholder) summary.placeholder = placeholder;
  if (ariaLabel) summary.aria_label = ariaLabel;
  if (name) summary.name = name;
  if (type) summary.type = type;
  if (role) summary.role = role;
  if (value) summary.value = truncateText(value, 300, 6);

  return summary;
}

async function collectElements(
  locator: Locator,
  maxItems = MAX_COLLECTION_ITEMS,
  attribute?: string,
): Promise<{ count: number; items: Record<string, unknown>[]; truncated: boolean }> {
  const count = await locator.count();
  const items: Record<string, unknown>[] = [];
  const stopAt = Math.min(count, maxItems);
  for (let index = 0; index < stopAt; index += 1) {
    items.push(await buildElementSummary(locator.nth(index), attribute));
  }
  return { count, items, truncated: count > stopAt };
}

async function buildPageInspection(pageRecord: BrowserPageRecord): Promise<{
  title: string | null;
  url: string;
  text: string;
  headings: { count: number; items: Record<string, unknown>[]; truncated: boolean };
  links: { count: number; items: Record<string, unknown>[]; truncated: boolean };
  buttons: { count: number; items: Record<string, unknown>[]; truncated: boolean };
  fields: { count: number; items: Record<string, unknown>[]; truncated: boolean };
}> {
  const page = pageRecord.page;
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  return {
    title: await safeTitle(page),
    url: page.url(),
    text: truncateText(bodyText, MAX_SNAPSHOT_TEXT_CHARS, 180),
    headings: await collectElements(page.locator("h1, h2, h3"), 8),
    links: await collectElements(page.locator("a[href]"), 10),
    buttons: await collectElements(
      page.locator("button, input[type='button'], input[type='submit']"),
      10,
    ),
    fields: await collectElements(page.locator("input, textarea, select"), 10),
  };
}

async function closeSession(session: BrowserSession): Promise<void> {
  try {
    await session.browser.close();
  } catch {
    // best effort
  }
}

function buildStorageStateInfo(session: BrowserSession): { loaded_from_path: string | null } {
  return {
    loaded_from_path: session.storageStatePath,
  };
}

export default function browserPlaywrightExtension(
  pi: ExtensionAPI,
  deps: BrowserPlaywrightExtensionDeps = {},
) {
  const loadPlaywrightModule = deps.loadPlaywright ?? loadPlaywright;
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const artifactRoot = deps.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  const sessions = new Map<string, BrowserSession>();
  let cleanupTimer: NodeJS.Timeout | null = setInterval(() => {
    void cleanupExpiredSessions();
  }, SESSION_SWEEP_INTERVAL_MS);
  cleanupTimer.unref?.();

  async function cleanupExpiredSessions(): Promise<void> {
    if (DEFAULT_IDLE_TIMEOUT_MS <= 0) return;

    const now = Date.now();
    const expiredSessions = [...sessions.values()].filter((session) => {
      const idleFor = now - Date.parse(session.lastActivityAt);
      return idleFor >= DEFAULT_IDLE_TIMEOUT_MS;
    });

    for (const session of expiredSessions) {
      await closeSession(session);
      sessions.delete(session.id);
    }
  }

  function registerCommonHandlers(): void {
    pi.on("session_shutdown", async () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      await Promise.all([...sessions.values()].map((session) => closeSession(session)));
      sessions.clear();
    });
  }

  registerCommonHandlers();

  pi.registerTool({
    name: "browser_session_start",
    label: "Browser Session Start",
    description:
      "Start a Playwright browser session for reusable multi-step browsing with safe network defaults.",
    promptSnippet:
      "Start a reusable Playwright browser session before navigating or interacting with pages.",
    promptGuidelines: [
      "Reuse browser session_id values across related browsing steps instead of starting a fresh browser every time.",
      "Use browser_navigate to visit public sites and browser_tabs to inspect or switch tabs.",
      "Use storage_state_path only for explicit opt-in login/session reuse workflows.",
    ],
    parameters: Type.Object({
      browser: Type.Optional(
        StringEnum(["chromium", "firefox", "webkit"] as const, {
          description: "Browser engine. Defaults to chromium.",
        }),
      ),
      headless: Type.Optional(Type.Boolean({ description: "Launch headless. Defaults to true." })),
      url: Type.Optional(Type.String({ description: "Optional initial URL to open." })),
      viewport_width: Type.Optional(Type.Number({ description: "Viewport width in pixels." })),
      viewport_height: Type.Optional(Type.Number({ description: "Viewport height in pixels." })),
      storage_state_path: Type.Optional(
        Type.String({
          description:
            "Optional workspace-relative Playwright storageState JSON file to load into the new session.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        throw new Error("Cancelled before starting a browser session.");
      }

      await cleanupExpiredSessions();
      await ensureDirectory(artifactRoot);

      const resolvedStorageState = params.storage_state_path
        ? await resolveStorageStateImportPath(workspaceRoot, params.storage_state_path)
        : null;

      const browserEngine = (params.browser ?? "chromium") as BrowserEngine;
      const playwright = await loadPlaywrightModule(browserEngine);
      const browserType = playwright[browserEngine] as BrowserType;
      const headless = params.headless ?? true;

      let browser: Browser | null = null;
      try {
        browser = await browserType.launch({ headless });
      } catch (error) {
        if (isMissingBrowserExecutableError(error)) {
          throw new Error(
            buildInstallInstructions(
              `Playwright is installed but ${browserEngine} browser binaries are missing.`,
              false,
              browserEngine,
            ),
          );
        }
        throw error;
      }

      try {
        const context = await browser.newContext({
          viewport:
            params.viewport_width && params.viewport_height
              ? { width: params.viewport_width, height: params.viewport_height }
              : { width: 1280, height: 800 },
          ...(resolvedStorageState ? { storageState: resolvedStorageState.absolutePath } : {}),
        });

        const session: BrowserSession = {
          id: `browser_${randomUUID()}`,
          browserEngine,
          browser,
          context,
          createdAt: nowIso(),
          lastActivityAt: nowIso(),
          headless,
          storageStatePath: resolvedStorageState?.relativePath ?? null,
          pages: new Map(),
          pageIds: new WeakMap(),
          activePageId: null,
          consoleEntries: [],
          blockedRequests: [],
          networkSummary: {
            total_requests: 0,
            blocked_requests: 0,
            failed_requests: 0,
          },
        };

        await context.route("**/*", async (route: Route) => {
          const request: Request = route.request();
          session.networkSummary.total_requests += 1;
          const decision = assessUrl(request.url(), getSecurityOptions());
          if (!decision.allowed) {
            const pageId = safeRequestPageId(request, (page) => session.pageIds.get(page) ?? null);
            recordBlockedRequest(session, {
              timestamp: nowIso(),
              page_id: pageId,
              url: request.url(),
              resource_type: request.resourceType(),
              reason: [decision.reason, decision.hint].filter(Boolean).join("\n"),
            });
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        });

        context.on("page", (page) => {
          void registerPage(session, page);
        });

        const pageRecord = await createTrackedPage(session);
        sessions.set(session.id, session);

        if (params.url) {
          try {
            await gotoWithSafety(
              session,
              pageRecord,
              params.url,
              "domcontentloaded",
              DEFAULT_NAVIGATION_TIMEOUT_MS,
            );
          } catch (error) {
            sessions.delete(session.id);
            await closeSession(session);
            throw error;
          }
        }

        const pages = await listPages(session);
        const activePage = session.activePageId
          ? getPageRecord(session, session.activePageId)
          : null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: session.id,
                  browser: session.browserEngine,
                  headless: session.headless,
                  created_at: session.createdAt,
                  active_page_id: activePage?.id ?? null,
                  pages,
                  artifact_dir: relative(workspaceRoot, artifactRoot),
                  storage_state: buildStorageStateInfo(session),
                  safety: {
                    allow_localhost: envFlag("BROWSER_ALLOW_LOCALHOST"),
                    allow_private_network: envFlag("BROWSER_ALLOW_PRIVATE_NETWORK"),
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: {
            session_id: session.id,
            browser: session.browserEngine,
            headless: session.headless,
            created_at: session.createdAt,
            active_page_id: activePage?.id ?? null,
            pages,
            artifact_dir: relative(workspaceRoot, artifactRoot),
            storage_state: buildStorageStateInfo(session),
            safety: {
              allow_localhost: envFlag("BROWSER_ALLOW_LOCALHOST"),
              allow_private_network: envFlag("BROWSER_ALLOW_PRIVATE_NETWORK"),
            },
          },
        };
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "browser_session_info",
    label: "Browser Session Info",
    description: "Inspect browser session state, tabs, and concise console/network summaries.",
    promptSnippet:
      "Inspect an existing browser session and list its tabs, active page, and recent browser activity.",
    parameters: Type.Object({
      session_id: Type.String({
        description: "Browser session_id returned by browser_session_start.",
      }),
    }),
    async execute(_toolCallId, params) {
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const pages = await listPages(session);
      const result = {
        session_id: session.id,
        browser: session.browserEngine,
        headless: session.headless,
        created_at: session.createdAt,
        last_activity_at: session.lastActivityAt,
        active_page_id: session.activePageId,
        page_count: pages.length,
        pages,
        storage_state: buildStorageStateInfo(session),
        network_summary: session.networkSummary,
        recent_console: session.consoleEntries,
        blocked_requests: session.blockedRequests,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate an existing tab or a new tab to a public URL with safe network checks.",
    promptSnippet: "Navigate a browser session tab to a URL, optionally opening a new tab.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      url: Type.String({
        description: "Destination URL. Only public http/https URLs are allowed by default.",
      }),
      page_id: Type.Optional(
        Type.String({ description: "Existing page_id to reuse. Defaults to the active page." }),
      ),
      new_tab: Type.Optional(
        Type.Boolean({
          description: "Open the URL in a new tab instead of reusing the current one.",
        }),
      ),
      wait_until: Type.Optional(
        Type.String({ description: "One of load, domcontentloaded, networkidle, commit." }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Navigation timeout in milliseconds." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Cancelled before navigation.");
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const waitUntil = normalizeWaitUntil(params.wait_until);
      const timeoutMs = params.timeout_ms ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
      const pageRecord = params.new_tab
        ? await createTrackedPage(session)
        : await resolvePageRecord(session, params.page_id, true);

      await gotoWithSafety(session, pageRecord, params.url, waitUntil, timeoutMs);

      const result = {
        session_id: session.id,
        page: await buildPageSummary(session, pageRecord),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Capture a concise structured snapshot of the current page: title, visible text, links, buttons, and fields.",
    promptSnippet:
      "Capture a concise structured page snapshot for the active tab or a specific page.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id. Defaults to the active page." }),
      ),
    }),
    async execute(_toolCallId, params) {
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const pageRecord = await resolvePageRecord(session, params.page_id, false);
      const inspection = await buildPageInspection(pageRecord);

      const result = {
        session_id: session.id,
        page_id: pageRecord.id,
        ...inspection,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_extract",
    label: "Browser Extract",
    description:
      "Extract visible text or selector-matched data from a page without arbitrary page evaluation.",
    promptSnippet:
      "Extract visible text or selector-matched fields from a page in a structured way.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id. Defaults to the active page." }),
      ),
      selector: Type.Optional(
        Type.String({ description: "Optional Playwright selector to extract from." }),
      ),
      attribute: Type.Optional(
        Type.String({ description: "Optional attribute name to extract instead of text." }),
      ),
      max_items: Type.Optional(
        Type.Number({ description: "Maximum matched items to return. Defaults to 5." }),
      ),
    }),
    async execute(_toolCallId, params) {
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const pageRecord = await resolvePageRecord(session, params.page_id, false);
      const page = pageRecord.page;
      const maxItems = params.max_items ?? 5;

      const result: {
        session_id: string;
        page_id: string;
        selector: string | null;
        attribute: string | null;
        url: string;
        title: string | null;
        text: string | null;
        match_count: number | null;
        items: Record<string, unknown>[];
        truncated: boolean;
      } = {
        session_id: session.id,
        page_id: pageRecord.id,
        selector: params.selector ?? null,
        attribute: params.attribute ?? null,
        url: page.url(),
        title: await safeTitle(page),
        text: null,
        match_count: null,
        items: [],
        truncated: false,
      };

      if (!params.selector) {
        const text = await page
          .locator("body")
          .innerText()
          .catch(() => "");
        result.text = truncateText(text, MAX_SNAPSHOT_TEXT_CHARS, 180);
      } else {
        const extracted = await collectElements(
          page.locator(params.selector),
          maxItems,
          params.attribute,
        );
        result.match_count = extracted.count;
        result.items = extracted.items;
        result.truncated = extracted.truncated;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click a page element by selector and report the resulting tab or URL state.",
    promptSnippet: "Click a selector in the browser and report the resulting URL or active tab.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      selector: Type.String({ description: "Playwright selector to click." }),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id. Defaults to the active page." }),
      ),
      timeout_ms: Type.Optional(Type.Number({ description: "Click timeout in milliseconds." })),
      double_click: Type.Optional(
        Type.Boolean({ description: "Use a double click instead of a single click." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Cancelled before click.");
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const pageRecord = await resolvePageRecord(session, params.page_id, false);
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const page = pageRecord.page;
      const locator = page.locator(params.selector).first();
      const previousUrl = page.url();
      const blockedCountBefore = session.blockedRequests.length;

      await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
      if (params.double_click) {
        await locator.dblclick({ timeout: timeoutMs });
      } else {
        await locator.click({ timeout: timeoutMs });
      }
      await waitForPossibleNavigation(page, previousUrl, timeoutMs);

      const activePage = await resolvePageRecord(
        session,
        session.activePageId ?? pageRecord.id,
        false,
      );
      const blockedRequest =
        session.blockedRequests.length > blockedCountBefore
          ? session.blockedRequests[session.blockedRequests.length - 1]
          : null;
      const result = {
        session_id: session.id,
        clicked_selector: params.selector,
        previous_url: previousUrl,
        active_page: await buildPageSummary(session, activePage),
        blocked_request: blockedRequest,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Fill an input or textarea by selector.",
    promptSnippet: "Fill a page field by selector with text input.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      selector: Type.String({ description: "Playwright selector for the field to fill." }),
      value: Type.String({ description: "Value to type into the field." }),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id. Defaults to the active page." }),
      ),
      timeout_ms: Type.Optional(Type.Number({ description: "Fill timeout in milliseconds." })),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Cancelled before fill.");
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const pageRecord = await resolvePageRecord(session, params.page_id, false);
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const locator = pageRecord.page.locator(params.selector).first();

      await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
      await locator.fill(params.value, { timeout: timeoutMs });
      touchPage(pageRecord);

      const result = {
        session_id: session.id,
        page_id: pageRecord.id,
        selector: params.selector,
        value_length: params.value.length,
        url: pageRecord.page.url(),
        title: await safeTitle(pageRecord.page),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "Browser Press",
    description: "Press a keyboard key on the page or on a selected element.",
    promptSnippet: "Press a keyboard key on the page or a selected element.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      key: Type.String({ description: "Keyboard key, e.g. Enter, Tab, ArrowDown, Escape." }),
      selector: Type.Optional(
        Type.String({ description: "Optional selector to focus before pressing the key." }),
      ),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id. Defaults to the active page." }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Optional timeout for selector-based press actions." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Cancelled before key press.");
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const pageRecord = await resolvePageRecord(session, params.page_id, false);
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const previousUrl = pageRecord.page.url();
      const blockedCountBefore = session.blockedRequests.length;

      if (params.selector) {
        const locator = pageRecord.page.locator(params.selector).first();
        await locator.press(params.key, { timeout: timeoutMs });
      } else {
        await pageRecord.page.keyboard.press(params.key);
      }

      await waitForPossibleNavigation(pageRecord.page, previousUrl, timeoutMs);
      touchPage(pageRecord);
      const blockedRequest =
        session.blockedRequests.length > blockedCountBefore
          ? session.blockedRequests[session.blockedRequests.length - 1]
          : null;
      const result = {
        session_id: session.id,
        page_id: pageRecord.id,
        selector: params.selector ?? null,
        key: params.key,
        previous_url: previousUrl,
        url: pageRecord.page.url(),
        title: await safeTitle(pageRecord.page),
        blocked_request: blockedRequest,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_wait_for",
    label: "Browser Wait For",
    description:
      "Wait for a selector, text, URL fragment, load state, or explicit delay within a browser session.",
    promptSnippet:
      "Wait for a selector, text, load state, URL fragment, or short delay in the browser.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id. Defaults to the active page." }),
      ),
      selector: Type.Optional(
        Type.String({ description: "Wait for this selector to become visible." }),
      ),
      text: Type.Optional(Type.String({ description: "Wait for visible text to appear." })),
      url_includes: Type.Optional(
        Type.String({ description: "Wait until the URL contains this substring." }),
      ),
      load_state: Type.Optional(
        Type.String({ description: "Wait for load, domcontentloaded, or networkidle." }),
      ),
      delay_ms: Type.Optional(
        Type.Number({ description: "Wait for an explicit delay in milliseconds." }),
      ),
      timeout_ms: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds." })),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Cancelled before wait.");
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const pageRecord = await resolvePageRecord(session, params.page_id, false);
      const page = pageRecord.page;
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      let matched = "";

      if (params.selector) {
        await page
          .locator(params.selector)
          .first()
          .waitFor({ state: "visible", timeout: timeoutMs });
        matched = `selector:${params.selector}`;
      } else if (params.text) {
        await page.getByText(params.text, { exact: false }).first().waitFor({
          state: "visible",
          timeout: timeoutMs,
        });
        matched = `text:${params.text}`;
      } else if (params.url_includes) {
        await page.waitForURL((current) => current.toString().includes(params.url_includes ?? ""), {
          timeout: timeoutMs,
        });
        matched = `url_includes:${params.url_includes}`;
      } else if (params.load_state) {
        const loadState = normalizeWaitUntil(params.load_state);
        if (loadState === "commit") {
          await page.waitForURL(() => true, { timeout: timeoutMs, waitUntil: "commit" });
        } else {
          await page.waitForLoadState(loadState, { timeout: timeoutMs });
        }
        matched = `load_state:${params.load_state}`;
      } else if (params.delay_ms) {
        await page.waitForTimeout(params.delay_ms);
        matched = `delay_ms:${params.delay_ms}`;
      } else {
        throw new Error(
          "browser_wait_for requires one of selector, text, url_includes, load_state, or delay_ms.",
        );
      }

      touchPage(pageRecord);
      const result = {
        session_id: session.id,
        page_id: pageRecord.id,
        matched,
        url: page.url(),
        title: await safeTitle(page),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Capture a screenshot into `.pi/artifacts/browser-playwright/` and return structured artifact metadata.",
    promptSnippet:
      "Capture a screenshot and store it under the workspace-local browser-playwright artifacts directory.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id. Defaults to the active page." }),
      ),
      full_page: Type.Optional(
        Type.Boolean({ description: "Capture the full page. Defaults to false." }),
      ),
      label: Type.Optional(
        Type.String({ description: "Optional label used in the screenshot filename." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Cancelled before screenshot.");
      await cleanupExpiredSessions();
      await ensureDirectory(artifactRoot);
      const session = getSessionOrThrow(sessions, params.session_id);
      const pageRecord = await resolvePageRecord(session, params.page_id, false);
      const page = pageRecord.page;
      const sessionArtifactDir = resolve(artifactRoot, session.id);
      await mkdir(sessionArtifactDir, { recursive: true });

      const timestamp = nowIso().replace(/[:.]/g, "-");
      const fileName = `${timestamp}-${sanitizeLabel(params.label)}.png`;
      const absolutePath = resolve(sessionArtifactDir, fileName);
      await page.screenshot({
        path: absolutePath,
        fullPage: params.full_page ?? false,
        type: "png",
      });
      touchPage(pageRecord);

      const relativePath = relative(workspaceRoot, absolutePath);
      const result = {
        session_id: session.id,
        page_id: pageRecord.id,
        path: relativePath,
        url: page.url(),
        title: await safeTitle(page),
        timestamp: nowIso(),
        full_page: params.full_page ?? false,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_storage_state_export",
    label: "Browser Storage State Export",
    description:
      "Export a session's Playwright storageState into a workspace-local JSON file for explicit reuse.",
    promptSnippet:
      "Export browser storageState only when the user explicitly wants to reuse login/session state later.",
    promptGuidelines: [
      "This is explicit opt-in persistence only — browser sessions do not auto-save state on close, reload, or shutdown.",
      "Use workspace-relative storage_state_path values only.",
    ],
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      storage_state_path: Type.Optional(
        Type.String({
          description:
            "Optional workspace-relative .json path. Defaults under `.pi/artifacts/browser-playwright/storage-state/`.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      const resolvedPath = await resolveStorageStateExportPath(
        workspaceRoot,
        params.storage_state_path,
        session.id,
      );
      await ensureDirectory(dirname(resolvedPath.absolutePath));
      await session.context.storageState({ path: resolvedPath.absolutePath });

      const result = {
        session_id: session.id,
        storage_state_path: resolvedPath.relativePath,
        exported_at: nowIso(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "List tabs for a browser session and optionally switch the active tab.",
    promptSnippet: "List session tabs and optionally switch the active page_id.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      activate_page_id: Type.Optional(
        Type.String({ description: "Optional page_id to make active." }),
      ),
    }),
    async execute(_toolCallId, params) {
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);
      if (params.activate_page_id) {
        getPageRecord(session, params.activate_page_id);
        session.activePageId = params.activate_page_id;
      }
      const pages = await listPages(session);
      const result = {
        session_id: session.id,
        active_page_id: session.activePageId,
        page_count: pages.length,
        pages,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close a single tab or an entire browser session.",
    promptSnippet: "Close a browser tab or the entire session when you are done with it.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Browser session_id." }),
      page_id: Type.Optional(
        Type.String({ description: "Optional page_id to close. Omit to close the whole session." }),
      ),
      close_session: Type.Optional(
        Type.Boolean({ description: "Force closing the whole session." }),
      ),
    }),
    async execute(_toolCallId, params) {
      await cleanupExpiredSessions();
      const session = getSessionOrThrow(sessions, params.session_id);

      if (params.close_session || !params.page_id) {
        await closeSession(session);
        sessions.delete(session.id);
        const result = {
          session_id: session.id,
          closed: "session",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }

      const pageRecord = getPageRecord(session, params.page_id);
      await pageRecord.page.close();
      const remainingPages = await listPages(session);
      if (remainingPages.length === 0) {
        await closeSession(session);
        sessions.delete(session.id);
        const result = {
          session_id: session.id,
          closed: "page",
          page_id: params.page_id,
          session_closed: true,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }

      const result = {
        session_id: session.id,
        closed: "page",
        page_id: params.page_id,
        session_closed: false,
        active_page_id: session.activePageId,
        pages: remainingPages,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
