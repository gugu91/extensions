export type JsonObject = Record<string, unknown>;
export type RequestContainer = "body" | "headers" | "path" | "query";

export function operationIdToSdkExportName(operationId: string): string {
  const [first = "", ...rest] = operationId.split("_").filter(Boolean);
  return first + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

export function parseCliValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as unknown;
  }

  return raw;
}

export function parseKeyValueArg(entry: string): { key: string; value: unknown } {
  const separatorIndex = entry.indexOf("=");
  if (separatorIndex <= 0) {
    throw new Error(`Expected KEY=VALUE, received: ${entry}`);
  }

  const key = entry.slice(0, separatorIndex).trim();
  if (!key) {
    throw new Error(`Expected KEY=VALUE, received: ${entry}`);
  }

  const rawValue = entry.slice(separatorIndex + 1);
  return {
    key,
    value: parseCliValue(rawValue),
  };
}

export function parseJsonObject(raw: string): JsonObject {
  const value = JSON.parse(raw) as unknown;
  if (!isJsonObject(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value;
}

export function mergeInput(
  base: JsonObject,
  entries: ReadonlyArray<{ key: string; value: unknown }>,
): JsonObject {
  const merged: JsonObject = { ...base };
  for (const entry of entries) {
    merged[entry.key] = entry.value;
  }
  return merged;
}

export function nestMethodInput(
  flatInput: JsonObject,
  parameterLocations: Readonly<Record<string, RequestContainer>>,
): JsonObject {
  const nested: JsonObject = {};

  for (const [key, value] of Object.entries(flatInput)) {
    if (
      (key === "body" || key === "headers" || key === "path" || key === "query") &&
      isJsonObject(value)
    ) {
      nested[key] = { ...(nested[key] as JsonObject | undefined), ...value };
      continue;
    }

    const container = parameterLocations[key];
    if (!container) {
      nested[key] = value;
      continue;
    }

    const currentSection = nested[container];
    const nextSection: JsonObject = isJsonObject(currentSection) ? { ...currentSection } : {};
    nextSection[key] = value;
    nested[container] = nextSection;
  }

  return nested;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
