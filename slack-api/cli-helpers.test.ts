import { describe, expect, it } from "vitest";

import {
  isJsonObject,
  mergeInput,
  nestMethodInput,
  operationIdToSdkExportName,
  parseCliValue,
  parseJsonObject,
  parseKeyValueArg,
} from "./cli-helpers.ts";

describe("operationIdToSdkExportName", () => {
  it("camel-cases Slack operation ids", () => {
    expect(operationIdToSdkExportName("auth_test")).toBe("authTest");
    expect(operationIdToSdkExportName("files_getUploadURLExternal")).toBe(
      "filesGetUploadURLExternal",
    );
  });
});

describe("parseCliValue", () => {
  it("parses booleans, null, numbers, and JSON", () => {
    expect(parseCliValue("true")).toBe(true);
    expect(parseCliValue("false")).toBe(false);
    expect(parseCliValue("null")).toBeNull();
    expect(parseCliValue("42")).toBe(42);
    expect(parseCliValue("3.5")).toBe(3.5);
    expect(parseCliValue('{"ok":true}')).toEqual({ ok: true });
    expect(parseCliValue('["a",1]')).toEqual(["a", 1]);
  });

  it("preserves plain strings", () => {
    expect(parseCliValue("C123")).toBe("C123");
    expect(parseCliValue(" hello ")).toBe(" hello ");
  });
});

describe("parseKeyValueArg", () => {
  it("splits key-value pairs", () => {
    expect(parseKeyValueArg("limit=200")).toEqual({ key: "limit", value: 200 });
  });

  it("rejects malformed entries", () => {
    expect(() => parseKeyValueArg("oops")).toThrow("Expected KEY=VALUE");
  });
});

describe("parseJsonObject", () => {
  it("accepts objects and rejects arrays", () => {
    expect(parseJsonObject('{"channel":"C123"}')).toEqual({ channel: "C123" });
    expect(() => parseJsonObject("[]")).toThrow("Expected a JSON object.");
  });
});

describe("mergeInput", () => {
  it("applies later key-value pairs over base input", () => {
    expect(
      mergeInput({ channel: "C123", text: "before" }, [
        { key: "text", value: "after" },
        { key: "unfurl_links", value: false },
      ]),
    ).toEqual({
      channel: "C123",
      text: "after",
      unfurl_links: false,
    });
  });
});

describe("nestMethodInput", () => {
  it("routes flat params into body/query/header containers", () => {
    expect(
      nestMethodInput(
        {
          token: "xoxb-test",
          channel: "C123",
          text: "hello",
          limit: 50,
        },
        {
          token: "headers",
          channel: "body",
          text: "body",
          limit: "query",
        },
      ),
    ).toEqual({
      headers: { token: "xoxb-test" },
      body: { channel: "C123", text: "hello" },
      query: { limit: 50 },
    });
  });

  it("preserves explicit nested sections as an escape hatch", () => {
    expect(
      nestMethodInput(
        {
          headers: { token: "xoxb-test" },
          query: { limit: 20 },
          cursor: "abc",
        },
        { cursor: "query" },
      ),
    ).toEqual({
      headers: { token: "xoxb-test" },
      query: { limit: 20, cursor: "abc" },
    });
  });
});

describe("isJsonObject", () => {
  it("narrows plain objects", () => {
    expect(isJsonObject({ ok: true })).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
  });
});
