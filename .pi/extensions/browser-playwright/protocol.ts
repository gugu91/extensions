export const BROWSER_MODE_VALUES = ["playwright", "agent-browser"] as const;
export type BrowserMode = (typeof BROWSER_MODE_VALUES)[number];

export const PLAYWRIGHT_COMMAND_VALUES = [
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
export type PlaywrightCommand = (typeof PLAYWRIGHT_COMMAND_VALUES)[number];

const PLAYWRIGHT_COMMAND_ALIASES: Record<string, PlaywrightCommand> = {
  start: "start",
  session_start: "start",
  browser_session_start: "start",
  info: "info",
  session_info: "info",
  browser_session_info: "info",
  navigate: "navigate",
  browser_navigate: "navigate",
  snapshot: "snapshot",
  browser_snapshot: "snapshot",
  extract: "extract",
  browser_extract: "extract",
  click: "click",
  browser_click: "click",
  fill: "fill",
  browser_fill: "fill",
  press: "press",
  browser_press: "press",
  wait: "wait",
  wait_for: "wait",
  browser_wait_for: "wait",
  screenshot: "screenshot",
  browser_screenshot: "screenshot",
  tabs: "tabs",
  browser_tabs: "tabs",
  close: "close",
  browser_close: "close",
};

export type BrowserCommandScalar = string | number | boolean | null;
export type BrowserCommandArgs = Record<string, BrowserCommandScalar>;

export type BrowserToolInput = {
  mode?: BrowserMode;
  session_id?: string;
  page_id?: string;
  command: string;
  payload_json?: string;
};

export type BrowserToolRequest = {
  mode: BrowserMode;
  action: string;
  rawCommand: string;
  sessionId?: string;
  pageId?: string;
  args: BrowserCommandArgs;
};

function coerceScalar(raw: string): BrowserCommandScalar {
  const normalized = raw.trim();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized === "null") return null;
  if (/^-?\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  if (/^-?\d+\.\d+$/.test(normalized)) return Number.parseFloat(normalized);
  return raw;
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error(`Unterminated quote in browser command: ${input}`);
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseInlineArgs(tokens: string[]): BrowserCommandArgs {
  const args: BrowserCommandArgs = {};

  for (const token of tokens) {
    if (token.startsWith("--") && token.length > 2) {
      args[token.slice(2)] = true;
      continue;
    }

    const separatorIndex = token.indexOf("=");
    if (separatorIndex > 0) {
      const key = token.slice(0, separatorIndex);
      const value = token.slice(separatorIndex + 1);
      args[key] = coerceScalar(value);
      continue;
    }

    args[token] = true;
  }

  return args;
}

function parsePayloadJson(raw: string | undefined): BrowserCommandArgs {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`payload_json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload_json must decode to a JSON object.");
  }

  const result: BrowserCommandArgs = {};
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
    throw new Error(`payload_json field \`${key}\` must be a string, number, boolean, or null.`);
  }
  return result;
}

function normalizeAction(rawAction: string): string {
  const normalized = rawAction.trim().toLowerCase().replace(/-/g, "_");
  return PLAYWRIGHT_COMMAND_ALIASES[normalized] ?? normalized;
}

function stringFrom(value: BrowserCommandScalar | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseBrowserToolRequest(input: BrowserToolInput): BrowserToolRequest {
  const rawCommand = input.command.trim();
  if (rawCommand.length === 0) {
    throw new Error("browser command must not be empty.");
  }

  const tokens = tokenizeCommand(rawCommand);
  const [rawAction, ...rest] = tokens;
  const inlineArgs = parseInlineArgs(rest);
  const payloadArgs = parsePayloadJson(input.payload_json);
  const args: BrowserCommandArgs = {
    ...inlineArgs,
    ...payloadArgs,
  };

  if (input.session_id && args.session_id === undefined) {
    args.session_id = input.session_id;
  }
  if (input.page_id && args.page_id === undefined) {
    args.page_id = input.page_id;
  }

  return {
    mode: input.mode ?? "playwright",
    action: normalizeAction(rawAction),
    rawCommand,
    sessionId: stringFrom(args.session_id),
    pageId: stringFrom(args.page_id),
    args,
  };
}

export function getStringArg(args: BrowserCommandArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function requireStringArg(args: BrowserCommandArgs, key: string): string {
  const value = getStringArg(args, key);
  if (!value) {
    throw new Error(`browser command requires string argument \`${key}\`.`);
  }
  return value;
}

export function getBooleanArg(args: BrowserCommandArgs, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getNumberArg(args: BrowserCommandArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

export function describePlaywrightCommands(): string {
  return PLAYWRIGHT_COMMAND_VALUES.join(", ");
}
