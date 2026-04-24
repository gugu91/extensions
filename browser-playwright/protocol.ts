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

export type BrowserToolInput = {
  backend?: BrowserBackend;
  action: BrowserAction;
  session_id?: string;
  page_id?: string;
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

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("input_json must decode to a JSON object.");
  }

  const result: BrowserArgs = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
      continue;
    }
    throw new Error(`input_json field \`${key}\` must be a string, number, boolean, or null.`);
  }
  return result;
}

function stringFrom(value: BrowserScalar | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseBrowserToolRequest(input: BrowserToolInput): BrowserToolRequest {
  const args = parseInputJson(input.input_json);

  if (input.session_id && args.session_id === undefined) {
    args.session_id = input.session_id;
  }
  if (input.page_id && args.page_id === undefined) {
    args.page_id = input.page_id;
  }

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
    throw new Error(`browser action requires string field \`${key}\` in input_json.`);
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
        "Artifacts and storage state stay rooted in the active workspace.",
      ],
    };
  }

  return {
    backend,
    available: false,
    supported_actions: [...BROWSER_ACTION_VALUES],
    notes: [
      "agent-browser is scaffolded behind the same one-tool contract.",
      "Local agent-browser support is unavailable in this harness.",
      "Local daemon compatibility is a non-goal here; any truthful future support is remote/optional executor mode unless upstream ships a real embeddable SDK.",
    ],
  };
}

export function describeBrowserActions(): string {
  return BROWSER_ACTION_VALUES.join(", ");
}
