import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import browserPlaywrightExtension from "./index.ts";
import { STORAGE_STATE_RELATIVE_DIR } from "./helpers.ts";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

class FakePage {
  private readonly frameRef = {};

  on(_event: string, _handler: (...args: unknown[]) => void): void {
    // no-op for focused storageState tests
  }

  url(): string {
    return "about:blank";
  }

  async title(): Promise<string> {
    return "Browser Playwright Test";
  }

  isClosed(): boolean {
    return false;
  }

  mainFrame(): object {
    return this.frameRef;
  }
}

class FakeContext {
  readonly page: FakePage;
  lastStorageStateOptions: { path?: string } | undefined;

  constructor(page: FakePage) {
    this.page = page;
  }

  async newPage(): Promise<FakePage> {
    return this.page;
  }

  async route(_pattern: string, _handler: (...args: unknown[]) => Promise<void>): Promise<void> {
    // no-op for focused storageState tests
  }

  on(_event: string, _handler: (...args: unknown[]) => void): void {
    // no-op for focused storageState tests
  }

  async storageState(options?: { path?: string }): Promise<{ cookies: unknown[]; origins: unknown[] }> {
    this.lastStorageStateOptions = options;
    const payload = {
      cookies: [{ name: "session", value: "super-secret-cookie" }],
      origins: [],
    };

    if (options?.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, JSON.stringify(payload), { encoding: "utf8" });
    }

    return payload;
  }
}

class FakeBrowser {
  contextOptions: Record<string, unknown> | null = null;
  readonly context: FakeContext;

  constructor(context: FakeContext) {
    this.context = context;
  }

  async newContext(options: Record<string, unknown>): Promise<FakeContext> {
    this.contextOptions = options;
    return this.context;
  }

  async close(): Promise<void> {
    // no-op for focused storageState tests
  }
}

async function setupExtension(workspaceRoot: string): Promise<{
  tools: Map<string, RegisteredTool>;
  shutdown: () => Promise<void>;
  browser: FakeBrowser;
  context: FakeContext;
}> {
  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, (_event: unknown) => Promise<void>>();
  const fakePage = new FakePage();
  const fakeContext = new FakeContext(fakePage);
  const fakeBrowser = new FakeBrowser(fakeContext);

  const playwright = await import("playwright");
  const chromium = playwright.chromium as unknown as {
    launch: (options: Record<string, unknown>) => Promise<unknown>;
  };
  const originalLaunch = chromium.launch;
  chromium.launch = async () => fakeBrowser as unknown;

  browserPlaywrightExtension(
    {
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      on(eventName: string, handler: (_event: unknown) => Promise<void>) {
        events.set(eventName, handler);
      },
    } as never,
    { workspaceRoot },
  );

  return {
    tools,
    browser: fakeBrowser,
    context: fakeContext,
    shutdown: async () => {
      chromium.launch = originalLaunch;
      await events.get("session_shutdown")?.({});
    },
  };
}

test("browser_session_start loads guarded storageState JSON and reports the mounted path", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "browser-playwright-index-load-"));
  const storageStatePath = resolve(workspaceRoot, STORAGE_STATE_RELATIVE_DIR, "tests/login.json");
  await mkdir(dirname(storageStatePath), { recursive: true });
  await writeFile(storageStatePath, JSON.stringify({ cookies: [], origins: [] }), {
    encoding: "utf8",
  });

  const { tools, shutdown, browser } = await setupExtension(workspaceRoot);

  try {
    const start = tools.get("browser_session_start");
    const info = tools.get("browser_session_info");
    assert.ok(start);
    assert.ok(info);

    const started = await start!.execute("tool-start", {
      storage_state_path: "tests/login.json",
    });
    const details = started.details as { session_id: string; storage_state_path: string | null };

    assert.equal(details.storage_state_path, `${STORAGE_STATE_RELATIVE_DIR}/tests/login.json`);
    assert.deepEqual(browser.contextOptions?.storageState, { cookies: [], origins: [] });

    const sessionInfo = await info!.execute("tool-info", { session_id: details.session_id });
    assert.equal(
      (sessionInfo.details as { storage_state_path: string | null }).storage_state_path,
      `${STORAGE_STATE_RELATIVE_DIR}/tests/login.json`,
    );
  } finally {
    await shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("browser_session_start rejects absolute storage state paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "browser-playwright-index-reject-"));
  const { tools, shutdown } = await setupExtension(workspaceRoot);

  try {
    const start = tools.get("browser_session_start");
    assert.ok(start);

    await assert.rejects(
      () => start!.execute("tool-start", { storage_state_path: "/tmp/evil.json" }),
      /workspace-local/,
    );
  } finally {
    await shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("browser_storage_state_save writes guarded JSON without echoing raw auth state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "browser-playwright-index-save-"));
  const savePath = resolve(workspaceRoot, STORAGE_STATE_RELATIVE_DIR, "tests/exported.json");
  const { tools, shutdown, context } = await setupExtension(workspaceRoot);

  try {
    const start = tools.get("browser_session_start");
    const save = tools.get("browser_storage_state_save");
    assert.ok(start);
    assert.ok(save);

    const started = await start!.execute("tool-start", {});
    const sessionId = (started.details as { session_id: string }).session_id;

    const saved = await save!.execute("tool-save", {
      session_id: sessionId,
      path: "tests/exported.json",
    });
    const details = saved.details as { path: string; size_bytes: number };
    const fileContent = await readFile(savePath, "utf8");

    assert.equal(details.path, `${STORAGE_STATE_RELATIVE_DIR}/tests/exported.json`);
    assert.ok(details.size_bytes > 0);
    assert.match(fileContent, /super-secret-cookie/);
    assert.doesNotMatch(JSON.stringify(saved.details), /super-secret-cookie/);
    assert.equal(context.lastStorageStateOptions, undefined);
  } finally {
    await shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("browser_storage_state_save rejects symlink targets inside the guarded directory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "browser-playwright-index-symlink-"));
  const savePath = resolve(workspaceRoot, STORAGE_STATE_RELATIVE_DIR, "tests/linked.json");
  await mkdir(dirname(savePath), { recursive: true });
  await writeFile(resolve(workspaceRoot, "outside.json"), JSON.stringify({ outside: true }), {
    encoding: "utf8",
  });
  await symlink(resolve(workspaceRoot, "outside.json"), savePath);

  const { tools, shutdown } = await setupExtension(workspaceRoot);

  try {
    const start = tools.get("browser_session_start");
    const save = tools.get("browser_storage_state_save");
    assert.ok(start);
    assert.ok(save);

    const started = await start!.execute("tool-start", {});
    const sessionId = (started.details as { session_id: string }).session_id;

    await assert.rejects(
      () =>
        save!.execute("tool-save", {
          session_id: sessionId,
          path: "tests/linked.json",
        }),
      /symlink/,
    );
  } finally {
    await shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
