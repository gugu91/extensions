import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import browserPlaywrightExtension from "./index.ts";

type ToolDefinition = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
};

type EventHandler = (event?: unknown, ctx?: unknown) => Promise<void> | void;

class FakePage {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private currentUrl = "about:blank";
  private closed = false;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return "Fake Page";
  }

  mainFrame(): FakePage {
    return this;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const handler of this.handlers.get("close") ?? []) {
      handler();
    }
  }
}

class FakeBrowserContext {
  readonly routeCalls: string[] = [];
  readonly storageStateCalls: Array<{ path?: string }> = [];
  readonly pageEventHandlers: Array<(page: FakePage) => void> = [];
  readonly pages: FakePage[] = [];
  readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  async route(pattern: string, _handler: unknown): Promise<void> {
    this.routeCalls.push(pattern);
  }

  on(event: string, handler: (page: FakePage) => void): void {
    if (event === "page") {
      this.pageEventHandlers.push(handler);
    }
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.pages.push(page);
    for (const handler of this.pageEventHandlers) {
      handler(page);
    }
    return page;
  }

  async storageState(options?: { path?: string }): Promise<void> {
    this.storageStateCalls.push(options ?? {});
    if (options?.path) {
      await fs.mkdir(path.dirname(options.path), { recursive: true });
      await fs.writeFile(options.path, JSON.stringify({ cookies: [], origins: [] }), "utf8");
    }
  }
}

class FakeBrowser {
  launchOptions: Record<string, unknown> | null = null;
  newContextOptions: Record<string, unknown> | null = null;
  closed = false;
  context: FakeBrowserContext | null = null;

  async newContext(options: Record<string, unknown>): Promise<FakeBrowserContext> {
    this.newContextOptions = options;
    this.context = new FakeBrowserContext(options);
    return this.context;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function createFakePlaywright(browser: FakeBrowser) {
  return {
    chromium: {
      launch: async (options: Record<string, unknown>) => {
        browser.launchOptions = options;
        return browser;
      },
    },
    firefox: {
      launch: async (options: Record<string, unknown>) => {
        browser.launchOptions = options;
        return browser;
      },
    },
    webkit: {
      launch: async (options: Record<string, unknown>) => {
        browser.launchOptions = options;
        return browser;
      },
    },
  };
}

async function withRegisteredExtension(
  run: (context: {
    workspaceRoot: string;
    tools: Map<string, ToolDefinition>;
    events: Map<string, EventHandler>;
    browser: FakeBrowser;
  }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "browser-playwright-index-"));
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, EventHandler>();
  const browser = new FakeBrowser();

  const pi = {
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    on(eventName: string, handler: EventHandler) {
      events.set(eventName, handler);
    },
  };

  browserPlaywrightExtension(pi as never, {
    workspaceRoot,
    artifactRoot: path.join(workspaceRoot, ".pi", "artifacts", "browser-playwright"),
    loadPlaywright: async () => createFakePlaywright(browser) as never,
  });

  try {
    await run({ workspaceRoot, tools, events, browser });
  } finally {
    await events.get("session_shutdown")?.();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("browser_session_start loads an explicit storageState file and browser_storage_state_export writes a workspace-local JSON file", async () => {
  await withRegisteredExtension(async ({ workspaceRoot, tools, browser }) => {
    const importPath = ".pi/state/import.json";
    const importAbsolutePath = path.join(workspaceRoot, importPath);
    await fs.mkdir(path.dirname(importAbsolutePath), { recursive: true });
    await fs.writeFile(importAbsolutePath, JSON.stringify({ cookies: [], origins: [] }), "utf8");

    const startTool = tools.get("browser_session_start");
    const infoTool = tools.get("browser_session_info");
    const exportTool = tools.get("browser_storage_state_export");

    assert.ok(startTool);
    assert.ok(infoTool);
    assert.ok(exportTool);

    const startResult = await startTool.execute("tool-start", {
      storage_state_path: importPath,
      headless: true,
    });

    const sessionId = startResult.details.session_id;
    assert.equal(typeof sessionId, "string");
    assert.deepEqual(browser.launchOptions, { headless: true });
    assert.equal(browser.newContextOptions?.storageState, importAbsolutePath);
    assert.equal(startResult.details.storage_state?.loaded_from_path, importPath);

    const infoResult = await infoTool.execute("tool-info", { session_id: sessionId as string });
    assert.equal(infoResult.details.storage_state?.loaded_from_path, importPath);

    const exportPath = ".pi/state/exported.json";
    const exportResult = await exportTool.execute("tool-export", {
      session_id: sessionId,
      storage_state_path: exportPath,
    });

    assert.equal(exportResult.details.storage_state_path, exportPath);
    assert.doesNotMatch(exportResult.content[0]?.text ?? "", /cookies|origins/);

    const exportedRaw = await fs.readFile(path.join(workspaceRoot, exportPath), "utf8");
    assert.deepEqual(JSON.parse(exportedRaw), { cookies: [], origins: [] });
    assert.deepEqual(browser.context?.storageStateCalls, [{ path: path.join(workspaceRoot, exportPath) }]);
  });
});
