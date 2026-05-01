import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { probeGitContext } from "./git-metadata.js";

export const DEFAULT_BROKER_PROMPT_MAX_BYTES = 64 * 1024;

export type BrokerPromptSource = "workspace" | "user" | "packaged";

export interface BrokerPromptWarning {
  source: BrokerPromptSource;
  reason: "unsafe_path" | "unreadable" | "too_large" | "invalid_utf8" | "empty";
  message: string;
}

export interface BrokerPromptCandidate {
  source: BrokerPromptSource;
  path: string;
  root: string;
  required: boolean;
}

export interface BrokerPromptLoadOptions {
  workspaceRoot?: string;
  cwd?: string;
  homeDir?: string;
  defaultPromptPath?: string;
  maxBytes?: number;
}

export interface BrokerPromptLoadResult {
  source: BrokerPromptSource;
  content: string;
  warnings: BrokerPromptWarning[];
  diagnostic: string;
}

export interface BrokerPromptTemplateValues {
  agentEmoji: string;
  agentName: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function describeSource(source: BrokerPromptSource): string {
  switch (source) {
    case "workspace":
      return "workspace override";
    case "user":
      return "user-local override";
    case "packaged":
      return "packaged default";
  }
}

function warning(
  source: BrokerPromptSource,
  reason: BrokerPromptWarning["reason"],
  detail: string,
): BrokerPromptWarning {
  return {
    source,
    reason,
    message: `broker prompt: ${describeSource(source)} rejected (${detail}); continuing`,
  };
}

export function resolveBrokerPromptCandidates(
  options: BrokerPromptLoadOptions = {},
): BrokerPromptCandidate[] {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? options.cwd ?? process.cwd());
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? "");
  const userRoot = path.join(homeDir, ".pi", "agent", "slack-bridge");
  const defaultPromptPath = path.resolve(
    options.defaultPromptPath ?? path.join(moduleDir, "prompts", "broker", "default.md"),
  );
  const defaultRoot = path.resolve(path.dirname(path.dirname(path.dirname(defaultPromptPath))));

  return [
    {
      source: "workspace",
      path: path.join(workspaceRoot, ".pi", "slack-bridge", "broker-prompt.md"),
      root: workspaceRoot,
      required: false,
    },
    {
      source: "user",
      path: path.join(userRoot, "broker-prompt.md"),
      root: userRoot,
      required: false,
    },
    {
      source: "packaged",
      path: defaultPromptPath,
      root: defaultRoot,
      required: true,
    },
  ];
}

async function readValidCandidate(
  candidate: BrokerPromptCandidate,
  maxBytes: number,
): Promise<{ content: string } | { warning: BrokerPromptWarning } | null> {
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await fs.realpath(candidate.root);
    realPath = await fs.realpath(candidate.path);
  } catch (error) {
    if (!candidate.required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return { warning: warning(candidate.source, "unreadable", "unreadable") };
  }

  if (!isWithinRoot(realPath, realRoot)) {
    return { warning: warning(candidate.source, "unsafe_path", "path escapes allowed root") };
  }

  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return { warning: warning(candidate.source, "unreadable", "unreadable") };
  }

  if (!stat.isFile()) {
    return { warning: warning(candidate.source, "unreadable", "not a regular file") };
  }

  if (stat.size > maxBytes) {
    return { warning: warning(candidate.source, "too_large", `over ${maxBytes} bytes`) };
  }

  let data: Buffer;
  try {
    data = await fs.readFile(realPath);
  } catch {
    return { warning: warning(candidate.source, "unreadable", "unreadable") };
  }

  let content: string;
  try {
    content = decoder.decode(data);
  } catch {
    return { warning: warning(candidate.source, "invalid_utf8", "invalid UTF-8") };
  }

  if (content.includes("\0")) {
    return { warning: warning(candidate.source, "invalid_utf8", "binary-looking content") };
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { warning: warning(candidate.source, "empty", "empty file") };
  }

  return { content: trimmed };
}

async function resolveDefaultWorkspaceRoot(options: BrokerPromptLoadOptions): Promise<string> {
  if (options.workspaceRoot) {
    return path.resolve(options.workspaceRoot);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const gitContext = await probeGitContext(cwd);
  return path.resolve(gitContext.repoRoot ?? cwd);
}

export async function loadBrokerPrompt(
  options: BrokerPromptLoadOptions = {},
): Promise<BrokerPromptLoadResult> {
  const warnings: BrokerPromptWarning[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_BROKER_PROMPT_MAX_BYTES;
  const workspaceRoot = await resolveDefaultWorkspaceRoot(options);

  for (const candidate of resolveBrokerPromptCandidates({ ...options, workspaceRoot })) {
    const result = await readValidCandidate(candidate, maxBytes);
    if (result === null) {
      continue;
    }
    if ("warning" in result) {
      warnings.push(result.warning);
      continue;
    }
    return {
      source: candidate.source,
      content: result.content,
      warnings,
      diagnostic: `broker prompt: ${describeSource(candidate.source)} loaded`,
    };
  }

  throw new Error(
    "No valid broker prompt candidates found; packaged default is missing or invalid.",
  );
}

export function renderBrokerPromptContent(
  content: string,
  values: BrokerPromptTemplateValues,
): string {
  return content
    .replaceAll("{{agentEmoji}}", values.agentEmoji)
    .replaceAll("{{agentName}}", values.agentName);
}
