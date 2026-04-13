import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  APPLESCRIPT_BINARY_PATH,
  detectIMessageMvpEnvironment,
  formatIMessageMvpReadiness,
  type DetectIMessageMvpEnvironmentOptions,
} from "./mvp.js";

const execFileAsync = promisify(execFile);

export interface RunAppleScriptInput {
  osascriptPath: string;
  scriptLines: string[];
  args: string[];
}

export interface RunAppleScriptResult {
  stdout: string;
  stderr: string;
}

export type RunAppleScript = (
  input: RunAppleScriptInput,
) => Promise<RunAppleScriptResult> | RunAppleScriptResult;

export interface SendIMessageOptions {
  recipient: string;
  text: string;
  osascriptPath?: string;
  runAppleScript?: RunAppleScript;
}

export function normalizeIMessageRecipient(recipient: string): string {
  const normalized = recipient.trim();
  if (!normalized) {
    throw new Error("iMessage recipient is required.");
  }
  return normalized;
}

export function getDefaultIMessageThreadId(recipient: string): string {
  return `imessage:${normalizeIMessageRecipient(recipient).toLowerCase()}`;
}

export function buildIMessageSendAppleScript(): string[] {
  return [
    "on run argv",
    'set recipientHandle to item 1 of argv',
    'set messageBody to item 2 of argv',
    'tell application "Messages"',
    'set targetService to 1st service whose service type = iMessage',
    'set targetBuddy to buddy recipientHandle of targetService',
    'send messageBody to targetBuddy',
    "end tell",
    "end run",
  ];
}

export async function runAppleScript(input: RunAppleScriptInput): Promise<RunAppleScriptResult> {
  const args = [...input.scriptLines.flatMap((line) => ["-e", line]), ...input.args];
  const result = await execFileAsync(input.osascriptPath, args);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function assertIMessageSendCapability(
  options: DetectIMessageMvpEnvironmentOptions = {},
): void {
  const environment = detectIMessageMvpEnvironment(options);
  if (environment.canAttemptSend) {
    return;
  }

  throw new Error(
    ["iMessage send-first adapter is not ready.", ...formatIMessageMvpReadiness(environment)].join(
      " ",
    ),
  );
}

export async function sendIMessage(options: SendIMessageOptions): Promise<RunAppleScriptResult> {
  const recipient = normalizeIMessageRecipient(options.recipient);
  const text = options.text.trim();
  if (!text) {
    throw new Error("iMessage text is required.");
  }

  const runner = options.runAppleScript ?? runAppleScript;
  return runner({
    osascriptPath: options.osascriptPath ?? APPLESCRIPT_BINARY_PATH,
    scriptLines: buildIMessageSendAppleScript(),
    args: [recipient, text],
  });
}
