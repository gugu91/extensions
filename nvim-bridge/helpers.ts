export interface EditorState {
  file: string | null;
  line: number | null;
  visibleStart: number | null;
  visibleEnd: number | null;
  selectionStart: number | null;
  selectionEnd: number | null;
}

export type NvimEvent =
  | { type: "buffer_focus"; file: string; line: number }
  | { type: "visible_range"; file: string; start: number; end: number }
  | { type: "selection"; file: string; start: number; end: number }
  | { type: "trigger_agent"; prompt: string };

type NvimRpcJsonPrimitive = string | number | boolean | null;
export type NvimRpcJsonValue = NvimRpcJsonPrimitive | NvimRpcJsonObject | NvimRpcJsonValue[];
export interface NvimRpcJsonObject {
  [key: string]: NvimRpcJsonValue;
}

function asNvimRpcObject(value: NvimRpcJsonValue | undefined): NvimRpcJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

export function toPositiveInteger(value: NvimRpcJsonValue | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

export function formatContext(state: EditorState): string {
  if (!state.file) return "";

  let msg = `User is viewing ${state.file}`;

  if (state.visibleStart != null && state.visibleEnd != null) {
    msg += `, lines ${state.visibleStart}-${state.visibleEnd}`;
  }

  if (state.line != null) {
    msg += ` (cursor at line ${state.line})`;
  }

  if (state.selectionStart != null && state.selectionEnd != null) {
    msg += `, selection on lines ${state.selectionStart}-${state.selectionEnd}`;
  }

  msg += ".";
  return msg;
}

export function parseNvimEvent(value: NvimRpcJsonValue | undefined): NvimEvent | null {
  const event = asNvimRpcObject(value);
  if (!event || typeof event.type !== "string") return null;

  switch (event.type) {
    case "buffer_focus": {
      const line = toPositiveInteger(event.line);
      if (typeof event.file !== "string" || line == null) return null;
      return {
        type: "buffer_focus",
        file: event.file,
        line,
      };
    }

    case "visible_range": {
      const start = toPositiveInteger(event.start);
      const end = toPositiveInteger(event.end);
      if (typeof event.file !== "string" || start == null || end == null) return null;
      return {
        type: "visible_range",
        file: event.file,
        start,
        end,
      };
    }

    case "selection": {
      const start = toPositiveInteger(event.start);
      const end = toPositiveInteger(event.end);
      if (typeof event.file !== "string" || start == null || end == null) return null;
      return {
        type: "selection",
        file: event.file,
        start,
        end,
      };
    }

    case "trigger_agent": {
      if (typeof event.prompt !== "string") return null;
      return {
        type: "trigger_agent",
        prompt: event.prompt,
      };
    }

    default:
      return null;
  }
}
