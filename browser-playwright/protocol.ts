export const BROWSER_BACKEND_VALUES = ["playwright", "agent-browser"] as const;
export type BrowserBackend = (typeof BROWSER_BACKEND_VALUES)[number];

export const BROWSER_ACTION_VALUES = [
  "start",
  "info",
  "navigate",
  "snapshot",
  "extract",
  "click",
  "fill",
  "press",
  "wait",
  "screenshot",
  "tabs",
  "close",
] as const;
export type BrowserAction = (typeof BROWSER_ACTION_VALUES)[number];

export type BrowserScalar = string | number | boolean | null;
export type BrowserArgs = Record<string, BrowserScalar>;
export type BrowserArgsInput = Record<string, unknown>;

export type BrowserToolInput = {
  backend?: BrowserBackend;
  action: BrowserAction;
  session_id?: string;
  page_id?: string;
  args?: BrowserArgsInput;
  input_json?: string;
};

export type BrowserToolRequest = {
  backend: BrowserBackend;
  action: BrowserAction;
  sessionId?: string;
  pageId?: string;
  args: BrowserArgs;
};

export type BrowserCapabilities = {
  backend: BrowserBackend;
  available: boolean;
  supported_actions: BrowserAction[];
  notes?: string[];
};

type BrowserActionSchema = {
  description: string;
  requires_session_id?: boolean;
  optional_session_id?: boolean;
  requires_page_id?: boolean;
  args?: {
    required?: string[];
    optional?: string[];
  };
  example: Record<string, unknown>;
};

const BROWSER_ACTION_SCHEMAS: Record<BrowserAction, BrowserActionSchema> = {
  start: {
    description: "Start a Playwright browser session and optionally open an initial URL.",
    args: {
      optional: [
        "url",
        "browser",
        "headless",
        "viewport_width",
        "viewport_height",
        "storage_state_name",
      ],
    },
    example: { action: "start", args: { url: "https://example.com" } },
  },
  info: {
    description:
      "Return session diagnostics when session_id is provided, or return the compact browser action catalogue/schema when no session_id is provided.",
    optional_session_id: true,
    args: { optional: ["topic"] },
    example: { action: "info", args: { topic: "schema" } },
  },
  navigate: {
    description: "Navigate the active page, or a new tab, to a URL.",
    requires_session_id: true,
    args: { required: ["url"], optional: ["new_tab", "wait_until", "timeout_ms"] },
    example: {
      action: "navigate",
      session_id: "browser_123",
      args: { url: "https://example.com/docs", new_tab: true },
    },
  },
  snapshot: {
    description: "Capture a compact text/metadata snapshot of the current page.",
    requires_session_id: true,
    args: { optional: ["selector"] },
    example: { action: "snapshot", session_id: "browser_123" },
  },
  extract: {
    description: "Extract text or simple attributes from matching page elements.",
    requires_session_id: true,
    args: { required: ["selector"], optional: ["attribute", "limit"] },
    example: { action: "extract", session_id: "browser_123", args: { selector: "h1" } },
  },
  click: {
    description: "Click an element matched by selector or accessible label.",
    requires_session_id: true,
    args: { optional: ["selector", "label", "timeout_ms"] },
    example: { action: "click", session_id: "browser_123", args: { selector: "button" } },
  },
  fill: {
    description: "Fill an input-like element.",
    requires_session_id: true,
    args: { required: ["value"], optional: ["selector", "label", "timeout_ms"] },
    example: {
      action: "fill",
      session_id: "browser_123",
      args: { selector: "input[name='q']", value: "Playwright docs" },
    },
  },
  press: {
    description: "Send a keyboard key press, optionally scoped to an element.",
    requires_session_id: true,
    args: { required: ["key"], optional: ["selector", "timeout_ms"] },
    example: { action: "press", session_id: "browser_123", args: { key: "Enter" } },
  },
  wait: {
    description: "Wait for text, selector, URL, timeout, or load state.",
    requires_session_id: true,
    args: { optional: ["text", "selector", "url", "timeout_ms", "load_state"] },
    example: { action: "wait", session_id: "browser_123", args: { text: "Loaded" } },
  },
  screenshot: {
    description: "Capture a screenshot artifact for the active or selected page.",
    requires_session_id: true,
    args: { optional: ["label", "full_page"] },
    example: {
      action: "screenshot",
      session_id: "browser_123",
      args: { label: "search-results", full_page: true },
    },
  },
  tabs: {
    description: "List pages/tabs, switch active page, or close a page.",
    requires_session_id: true,
    args: { optional: ["op", "page_id"] },
    example: { action: "tabs", session_id: "browser_123", args: { op: "list" } },
  },
  close: {
    description: "Close a page or an entire browser session.",
    requires_session_id: true,
    args: { optional: ["page_id"] },
    example: { action: "close", session_id: "browser_123" },
  },
};

function parseInputJson(raw: string | undefined): BrowserArgs {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `input_json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseArgsObject(parsed, "input_json");
}

function parseArgsObject(raw: unknown, source: "args" | "input_json"): BrowserArgs {
  if (raw === undefined) return {};
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object.`);
  }

  const result: BrowserArgs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
      continue;
    }
    throw new Error(`${source} field \`${key}\` must be a string, number, boolean, or null.`);
  }
  return result;
}

function mergeArgs(preferredArgs: BrowserArgs, compatibilityArgs: BrowserArgs): BrowserArgs {
  const merged: BrowserArgs = { ...compatibilityArgs };
  for (const [key, value] of Object.entries(preferredArgs)) {
    const compatibilityValue = compatibilityArgs[key];
    if (compatibilityValue !== undefined && !Object.is(compatibilityValue, value)) {
      throw new Error(
        `Conflicting browser input for \`${key}\`: args.${key} and input_json.${key} differ. Use one value.`,
      );
    }
    merged[key] = value;
  }
  return merged;
}

function applyTopLevelId(
  args: BrowserArgs,
  topLevelValue: string | undefined,
  key: "session_id" | "page_id",
): void {
  if (!topLevelValue) return;
  const nestedValue = args[key];
  if (nestedValue !== undefined && nestedValue !== topLevelValue) {
    throw new Error(
      `Conflicting browser input for \`${key}\`: top-level ${key} is authoritative and differs from the nested args/input_json value.`,
    );
  }
  args[key] = topLevelValue;
}

function stringFrom(value: BrowserScalar | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBrowserAction(value: string): value is BrowserAction {
  return BROWSER_ACTION_VALUES.includes(value as BrowserAction);
}

export function parseBrowserToolRequest(input: BrowserToolInput): BrowserToolRequest {
  const compatibilityArgs = parseInputJson(input.input_json);
  const preferredArgs = parseArgsObject(input.args, "args");
  const args = mergeArgs(preferredArgs, compatibilityArgs);

  applyTopLevelId(args, input.session_id, "session_id");
  applyTopLevelId(args, input.page_id, "page_id");

  return {
    backend: input.backend ?? "playwright",
    action: input.action,
    sessionId: stringFrom(args.session_id),
    pageId: stringFrom(args.page_id),
    args,
  };
}

export function getStringArg(args: BrowserArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function requireStringArg(args: BrowserArgs, key: string): string {
  const value = getStringArg(args, key);
  if (!value) {
    throw new Error(`browser action requires string field \`${key}\` in args.`);
  }
  return value;
}

export function getBooleanArg(args: BrowserArgs, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getNumberArg(args: BrowserArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

export function buildCapabilities(backend: BrowserBackend): BrowserCapabilities {
  if (backend === "playwright") {
    return {
      backend,
      available: true,
      supported_actions: [...BROWSER_ACTION_VALUES],
      notes: [
        "Playwright is the supported local browsing path in this Anthropic sandbox.",
        "Use action='info' without a session_id for compact action help/schema discovery.",
        "Artifacts and storage state stay rooted in the active workspace.",
      ],
    };
  }

  return {
    backend,
    available: false,
    supported_actions: [],
    notes: [
      "agent-browser is scaffolded behind the same one-tool contract but is unavailable locally.",
      "Local daemon compatibility is a non-goal here; any truthful future support is remote/optional executor mode unless upstream ships a real embeddable SDK.",
    ],
  };
}

export function buildBrowserDiscovery(topic: string | undefined): Record<string, unknown> {
  const normalizedTopic = topic?.trim().toLowerCase();
  const actionSummaries = BROWSER_ACTION_VALUES.map((action) => ({
    action,
    description: BROWSER_ACTION_SCHEMAS[action].description,
    requires_session_id: BROWSER_ACTION_SCHEMAS[action].requires_session_id ?? false,
  }));

  const base = {
    tool: "browser",
    contract: {
      preferred_shape: "browser({ action, args?, session_id?, page_id?, backend? })",
      args: "Preferred structured carrier for action-specific scalar fields.",
      input_json: "Compatibility-only JSON string carrier; do not use for new calls.",
      backend: "Omit for normal local use; Playwright is the supported local path.",
      top_level_ids: "Top-level session_id/page_id are authoritative; conflicting nested IDs fail.",
    },
    discovery: {
      catalog: { action: "info" },
      all_schemas: { action: "info", args: { topic: "schema" } },
      action_schema: { action: "info", args: { topic: "navigate" } },
    },
  };

  if (!normalizedTopic || normalizedTopic === "help" || normalizedTopic === "actions") {
    return {
      ...base,
      actions: actionSummaries,
    };
  }

  if (normalizedTopic === "schema" || normalizedTopic === "schemas") {
    return {
      ...base,
      actions: actionSummaries,
      schemas: BROWSER_ACTION_SCHEMAS,
    };
  }

  if (isBrowserAction(normalizedTopic)) {
    return {
      ...base,
      action: normalizedTopic,
      schema: BROWSER_ACTION_SCHEMAS[normalizedTopic],
    };
  }

  throw new Error(
    `Unsupported browser info topic \`${topic}\`. Use help, schema, or one of: ${describeBrowserActions()}.`,
  );
}

export function describeBrowserActions(): string {
  return BROWSER_ACTION_VALUES.join(", ");
}
