import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapabilities,
  describeBrowserActions,
  getBooleanArg,
  getNumberArg,
  getStringArg,
  parseBrowserToolRequest,
} from "./protocol.ts";

test("parseBrowserToolRequest builds a typed request from the single browser tool envelope", () => {
  const parsed = parseBrowserToolRequest({
    backend: "playwright",
    action: "navigate",
    session_id: "browser_123",
    input_json: JSON.stringify({ url: "https://example.com", new_tab: true, timeout_ms: 1500 }),
  });

  assert.equal(parsed.backend, "playwright");
  assert.equal(parsed.action, "navigate");
  assert.equal(parsed.sessionId, "browser_123");
  assert.equal(getStringArg(parsed.args, "url"), "https://example.com");
  assert.equal(getBooleanArg(parsed.args, "new_tab"), true);
  assert.equal(getNumberArg(parsed.args, "timeout_ms"), 1500);
});

test("parseBrowserToolRequest allows session_id and page_id to flow through top-level fields", () => {
  const parsed = parseBrowserToolRequest({
    action: "click",
    session_id: "browser_123",
    page_id: "page_abc",
    input_json: JSON.stringify({ selector: "button" }),
  });

  assert.equal(parsed.backend, "playwright");
  assert.equal(parsed.sessionId, "browser_123");
  assert.equal(parsed.pageId, "page_abc");
  assert.equal(getStringArg(parsed.args, "selector"), "button");
});

test("parseBrowserToolRequest lets input_json override top-level session_id when needed", () => {
  const parsed = parseBrowserToolRequest({
    action: "screenshot",
    session_id: "browser_inline",
    input_json: JSON.stringify({ session_id: "browser_json", full_page: true, label: "override" }),
  });

  assert.equal(parsed.sessionId, "browser_json");
  assert.equal(getBooleanArg(parsed.args, "full_page"), true);
  assert.equal(getStringArg(parsed.args, "label"), "override");
});

test("parseBrowserToolRequest rejects invalid input_json", () => {
  assert.throws(
    () => parseBrowserToolRequest({ action: "start", input_json: "{not-json}" }),
    /input_json must be valid JSON/i,
  );
});

test("buildCapabilities reports playwright as available and agent-browser as scaffolded", () => {
  const playwright = buildCapabilities("playwright");
  const agentBrowser = buildCapabilities("agent-browser");

  assert.equal(playwright.available, true);
  assert.equal(agentBrowser.available, false);
  assert.match(agentBrowser.notes?.join(" ") ?? "", /scaffolded/i);
});

test("describeBrowserActions summarizes the typed browser action enum", () => {
  assert.match(describeBrowserActions(), /start/);
  assert.match(describeBrowserActions(), /navigate/);
  assert.match(describeBrowserActions(), /close/);
});
