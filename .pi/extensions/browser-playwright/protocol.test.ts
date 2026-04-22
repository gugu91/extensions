import assert from "node:assert/strict";
import test from "node:test";
import {
  describePlaywrightCommands,
  getBooleanArg,
  getNumberArg,
  getStringArg,
  parseBrowserToolRequest,
} from "./protocol.ts";

test("parseBrowserToolRequest parses inline command arguments from the single browser channel", () => {
  const parsed = parseBrowserToolRequest({
    mode: "playwright",
    session_id: "browser_123",
    command: 'navigate url=https://example.com new_tab=true timeout_ms=1500',
  });

  assert.equal(parsed.mode, "playwright");
  assert.equal(parsed.action, "navigate");
  assert.equal(parsed.sessionId, "browser_123");
  assert.equal(getStringArg(parsed.args, "url"), "https://example.com");
  assert.equal(getBooleanArg(parsed.args, "new_tab"), true);
  assert.equal(getNumberArg(parsed.args, "timeout_ms"), 1500);
});

test("parseBrowserToolRequest supports quoted selectors and values", () => {
  const parsed = parseBrowserToolRequest({
    command: 'fill selector="input[name=\'q\']" value="Playwright docs"',
  });

  assert.equal(parsed.action, "fill");
  assert.equal(getStringArg(parsed.args, "selector"), "input[name='q']");
  assert.equal(getStringArg(parsed.args, "value"), "Playwright docs");
});

test("parseBrowserToolRequest accepts old browser_* command names as aliases", () => {
  const parsed = parseBrowserToolRequest({
    command: "browser_wait_for text=Ready timeout_ms=2500",
  });

  assert.equal(parsed.action, "wait");
  assert.equal(getStringArg(parsed.args, "text"), "Ready");
  assert.equal(getNumberArg(parsed.args, "timeout_ms"), 2500);
});

test("parseBrowserToolRequest merges payload_json over inline args", () => {
  const parsed = parseBrowserToolRequest({
    session_id: "browser_inline",
    command: "screenshot full_page=false label=inline",
    payload_json: JSON.stringify({ full_page: true, label: "override", session_id: "browser_json" }),
  });

  assert.equal(parsed.sessionId, "browser_json");
  assert.equal(getBooleanArg(parsed.args, "full_page"), true);
  assert.equal(getStringArg(parsed.args, "label"), "override");
});

test("parseBrowserToolRequest rejects invalid payload_json", () => {
  assert.throws(
    () => parseBrowserToolRequest({ command: "start", payload_json: "{not-json}" }),
    /payload_json must be valid JSON/i,
  );
});

test("describePlaywrightCommands summarizes the single-tool playwright command set", () => {
  assert.match(describePlaywrightCommands(), /start/);
  assert.match(describePlaywrightCommands(), /navigate/);
  assert.match(describePlaywrightCommands(), /close/);
});
