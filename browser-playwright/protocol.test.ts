import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBrowserDiscovery,
  buildCapabilities,
  describeBrowserActions,
  formatBrowserResponseText,
  getBooleanArg,
  getNumberArg,
  getStringArg,
  normalizeBrowserOutputOptions,
  parseBrowserToolRequest,
  type BrowserToolEnvelope,
} from "./protocol.ts";

test("parseBrowserToolRequest prefers top-level args for the single browser tool envelope", () => {
  const parsed = parseBrowserToolRequest({
    backend: "playwright",
    action: "navigate",
    session_id: "browser_123",
    args: { url: "https://example.com", new_tab: true, timeout_ms: 1500 },
  });

  assert.equal(parsed.backend, "playwright");
  assert.equal(parsed.action, "navigate");
  assert.equal(parsed.sessionId, "browser_123");
  assert.equal(getStringArg(parsed.args, "url"), "https://example.com");
  assert.equal(getBooleanArg(parsed.args, "new_tab"), true);
  assert.equal(getNumberArg(parsed.args, "timeout_ms"), 1500);
});

test("parseBrowserToolRequest keeps input_json-only calls compatible", () => {
  const parsed = parseBrowserToolRequest({
    action: "navigate",
    input_json: JSON.stringify({ url: "https://example.com", new_tab: true }),
  });

  assert.equal(parsed.backend, "playwright");
  assert.equal(getStringArg(parsed.args, "url"), "https://example.com");
  assert.equal(getBooleanArg(parsed.args, "new_tab"), true);
});

test("parseBrowserToolRequest accepts identical args and input_json fields", () => {
  const parsed = parseBrowserToolRequest({
    action: "navigate",
    args: { url: "https://example.com", new_tab: true },
    input_json: JSON.stringify({ url: "https://example.com", new_tab: true }),
  });

  assert.equal(getStringArg(parsed.args, "url"), "https://example.com");
  assert.equal(getBooleanArg(parsed.args, "new_tab"), true);
});

test("parseBrowserToolRequest rejects conflicting args and input_json fields", () => {
  assert.throws(
    () =>
      parseBrowserToolRequest({
        action: "navigate",
        args: { url: "https://example.com/a" },
        input_json: JSON.stringify({ url: "https://example.com/b" }),
      }),
    /args\.url and input_json\.url differ/i,
  );
});

test("parseBrowserToolRequest allows session_id and page_id to flow through top-level fields", () => {
  const parsed = parseBrowserToolRequest({
    action: "click",
    session_id: "browser_123",
    page_id: "page_abc",
    args: { selector: "button" },
  });

  assert.equal(parsed.backend, "playwright");
  assert.equal(parsed.sessionId, "browser_123");
  assert.equal(parsed.pageId, "page_abc");
  assert.equal(getStringArg(parsed.args, "selector"), "button");
});

test("parseBrowserToolRequest keeps top-level ids authoritative when nested values match", () => {
  const parsed = parseBrowserToolRequest({
    action: "screenshot",
    session_id: "browser_123",
    page_id: "page_abc",
    args: {
      session_id: "browser_123",
      page_id: "page_abc",
      full_page: true,
      label: "matching-ids",
    },
  });

  assert.equal(parsed.sessionId, "browser_123");
  assert.equal(parsed.pageId, "page_abc");
  assert.equal(getBooleanArg(parsed.args, "full_page"), true);
  assert.equal(getStringArg(parsed.args, "label"), "matching-ids");
});

test("parseBrowserToolRequest rejects nested ids that conflict with top-level ids", () => {
  assert.throws(
    () =>
      parseBrowserToolRequest({
        action: "screenshot",
        session_id: "browser_inline",
        args: { session_id: "browser_args", full_page: true },
      }),
    /top-level session_id is authoritative/i,
  );
});

test("parseBrowserToolRequest still supports backward-compatible nested ids without top-level ids", () => {
  const parsed = parseBrowserToolRequest({
    action: "screenshot",
    input_json: JSON.stringify({ session_id: "browser_json", page_id: "page_json" }),
  });

  assert.equal(parsed.sessionId, "browser_json");
  assert.equal(parsed.pageId, "page_json");
});

test("parseBrowserToolRequest rejects invalid input_json", () => {
  assert.throws(
    () => parseBrowserToolRequest({ action: "start", input_json: "{not-json}" }),
    /input_json must be valid JSON/i,
  );
});

test("parseBrowserToolRequest rejects non-scalar args fields", () => {
  assert.throws(
    () => parseBrowserToolRequest({ action: "start", args: { nested: { url: "x" } } }),
    /args field `nested` must be a string, number, boolean, or null/i,
  );
});

test("buildCapabilities reports playwright as available and agent-browser as unavailable locally", () => {
  const playwright = buildCapabilities("playwright");
  const agentBrowser = buildCapabilities("agent-browser");

  assert.equal(playwright.available, true);
  assert.match(playwright.notes?.join(" ") ?? "", /help\/schema discovery/i);
  assert.equal(agentBrowser.available, false);
  assert.deepEqual(agentBrowser.supported_actions, []);
  assert.match(agentBrowser.notes?.join(" ") ?? "", /unavailable locally/i);
});

test("buildBrowserDiscovery returns catalog and action schemas through the existing info action", () => {
  const catalog = buildBrowserDiscovery(undefined);
  const navigate = buildBrowserDiscovery("navigate");

  assert.equal(catalog.tool, "browser");
  assert.match(JSON.stringify(catalog), /preferred_shape/);
  assert.match(JSON.stringify(catalog), /action_schema/);
  assert.match(JSON.stringify(navigate), /Navigate the active page/);
});

test("buildBrowserDiscovery action schemas match runtime-supported argument names", () => {
  type RuntimeArgSchema = { args?: { required?: string[]; optional?: string[] } };
  function schemaFor(action: string): RuntimeArgSchema {
    const discovery = buildBrowserDiscovery(action);
    assert.equal(typeof discovery.schema, "object");
    assert.notEqual(discovery.schema, null);
    return discovery.schema as RuntimeArgSchema;
  }

  assert.deepEqual(schemaFor("snapshot").args, undefined);
  assert.deepEqual(schemaFor("extract").args, {
    optional: ["selector", "attribute", "max_items"],
  });
  assert.deepEqual(schemaFor("click").args, {
    required: ["selector"],
    optional: ["timeout_ms", "double_click"],
  });
  assert.deepEqual(schemaFor("fill").args, {
    required: ["selector", "value"],
    optional: ["timeout_ms"],
  });
  assert.deepEqual(schemaFor("wait").args, {
    optional: ["selector", "text", "url_includes", "load_state", "delay_ms", "timeout_ms"],
  });
  assert.deepEqual(schemaFor("tabs").args, { optional: ["activate_page_id"] });
  assert.deepEqual(schemaFor("close").args, { optional: ["close_session"] });
});

test("buildBrowserDiscovery rejects unknown schema topics clearly", () => {
  assert.throws(() => buildBrowserDiscovery("unknown"), /Unsupported browser info topic/i);
});

test("normalizeBrowserOutputOptions defaults to compact cli and accepts aliases", () => {
  assert.deepEqual(normalizeBrowserOutputOptions({}), { format: "cli", full: false });
  assert.deepEqual(normalizeBrowserOutputOptions({ f: "json", "--full": true }), {
    format: "json",
    full: true,
  });
  assert.deepEqual(normalizeBrowserOutputOptions({ "-f": "cli", full: true }), {
    format: "cli",
    full: true,
  });
});

test("normalizeBrowserOutputOptions rejects invalid format and full values", () => {
  assert.throws(
    () => normalizeBrowserOutputOptions({ format: "xml" }),
    /format must be "cli" or "json"/i,
  );
  assert.throws(() => normalizeBrowserOutputOptions({ full: "true" }), /full must be a boolean/i);
});

test("formatBrowserResponseText uses compact cli text by default while preserving details", () => {
  const envelope: BrowserToolEnvelope = {
    backend: "playwright",
    action: "navigate",
    session_id: "browser_123",
    page_id: "page_abc",
    capabilities: buildCapabilities("playwright"),
    result: {
      session_id: "browser_123",
      page: {
        page_id: "page_abc",
        url: "https://example.com/docs",
        title: "Docs",
      },
    },
    artifacts: [],
  };

  const text = formatBrowserResponseText(envelope, { format: "cli", full: false });
  assert.match(text, /^Browser navigated:/);
  assert.match(text, /https:\/\/example\.com\/docs/);
  assert.doesNotMatch(text, /"capabilities"/);
});

test("formatBrowserResponseText returns the structured envelope for explicit json or full", () => {
  const envelope: BrowserToolEnvelope = {
    backend: "playwright",
    action: "screenshot",
    session_id: "browser_123",
    page_id: "page_abc",
    capabilities: buildCapabilities("playwright"),
    result: {
      session_id: "browser_123",
      page_id: "page_abc",
      path: ".pi/artifacts/browser-playwright/browser_123/example.png",
      full_page: false,
    },
    artifacts: [
      { kind: "screenshot", path: ".pi/artifacts/browser-playwright/browser_123/example.png" },
    ],
  };

  const jsonText = formatBrowserResponseText(envelope, { format: "json", full: false });
  assert.deepEqual(JSON.parse(jsonText), envelope);

  const fullText = formatBrowserResponseText(envelope, { format: "cli", full: true });
  assert.deepEqual(JSON.parse(fullText), envelope);
});

test("buildBrowserDiscovery advertises compact defaults and output opt-ins", () => {
  const catalog = buildBrowserDiscovery(undefined);
  assert.match(JSON.stringify(catalog), /Defaults to compact CLI text/);
  assert.match(JSON.stringify(catalog), /args\.format='json'/);
  assert.match(JSON.stringify(catalog), /--full/);
});

test("describeBrowserActions summarizes the typed browser action enum", () => {
  assert.match(describeBrowserActions(), /start/);
  assert.match(describeBrowserActions(), /navigate/);
  assert.match(describeBrowserActions(), /close/);
});
