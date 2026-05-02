import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { loadDeclaredApps, type DeclaredPm2App } from "./ecosystem.js";
import { type Pm2Action } from "./helpers.js";
import { CliPm2Runner, executePm2Action, type Pm2Runner } from "./pm2.js";
import { loadSettings, type ResolvedSettings } from "./settings.js";

const PM2_ACTIONS = ["status", "start", "restart", "stop", "logs", "urls", "config"] as const;

const Pm2ProcessParams = Type.Object({
  action: StringEnum(PM2_ACTIONS, {
    description: "PM2 action to run against declared apps only.",
  }),
  target: Type.Optional(
    Type.String({
      description: "Declared app name, or 'all' for status/start/restart/stop. Required for logs.",
    }),
  ),
  lines: Type.Optional(
    Type.Number({
      description: "Line count for logs; clamped to configured safe limits.",
    }),
  ),
});

type Pm2ProcessInput = {
  action: Pm2Action;
  target?: string;
  lines?: number;
};

type ThemeLike = {
  fg: (name: string, value: string) => string;
  bold: (value: string) => string;
};

function parseCommandArgs(args: string): Pm2ProcessInput | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const action = tokens[0] as Pm2Action;
  if (!PM2_ACTIONS.includes(action)) {
    throw new Error(`Unknown /pm2 action '${tokens[0]}'. Expected: ${PM2_ACTIONS.join(", ")}`);
  }

  let target: string | undefined;
  let lines: number | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--lines") {
      const value = tokens[index + 1];
      if (!value) throw new Error("/pm2 logs --lines requires a number");
      lines = Number(value);
      index += 1;
      continue;
    }
    if (token?.startsWith("--lines=")) {
      lines = Number(token.slice("--lines=".length));
      continue;
    }
    if (!target) {
      target = token;
      continue;
    }
    throw new Error(`Unexpected /pm2 argument '${token}'`);
  }

  return { action, target, lines };
}

function formatWarnings(warnings: string[]): string {
  return warnings.length > 0
    ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
    : "";
}

async function prepare(cwd: string): Promise<{
  settings: ResolvedSettings;
  apps: DeclaredPm2App[];
  runner: Pm2Runner;
}> {
  const settings = loadSettings({ cwd, agentDir: getAgentDir() });
  if (!settings.configPath) {
    return { settings, apps: [], runner: new CliPm2Runner(settings.pm2Bin) };
  }
  const apps = await loadDeclaredApps(settings.configPath, settings.metadataPath);
  return { settings, apps, runner: new CliPm2Runner(settings.pm2Bin) };
}

async function runPm2(
  input: Pm2ProcessInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string> {
  const { settings, apps, runner } = await prepare(ctx.cwd);
  const result = await executePm2Action(input, apps, settings, runner, signal);
  return `${result.text}${formatWarnings(result.warnings)}`;
}

async function showPm2Menu(ctx: ExtensionContext): Promise<Pm2ProcessInput> {
  const { settings } = await prepare(ctx.cwd);
  return settings.configPath ? { action: "status", target: "all" } : { action: "config" };
}

export default function pm2ProcessesExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pm2_process",
    label: "PM2 Process",
    description:
      "Manage project-local PM2 apps declared in the active ecosystem config. Actions are bounded and app-name allowlisted.",
    promptSnippet:
      "Manage declared PM2 apps via status/start/restart/stop/logs/urls/config without arbitrary shell commands.",
    promptGuidelines: [
      "Use pm2_process for project PM2 process lifecycle tasks instead of starting long-running processes with bash.",
      "pm2_process only accepts exact declared app names or all where supported; do not use PM2 wildcards or delete/kill actions.",
    ],
    parameters: Pm2ProcessParams,
    async execute(_toolCallId, params: Pm2ProcessInput, signal, _onUpdate, ctx) {
      const text = await runPm2(params, ctx, signal);
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, target: params.target },
      };
    },
    renderCall(args: Partial<Pm2ProcessInput>, theme: ThemeLike) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("pm2_process"))} ${args.action ?? ""} ${args.target ?? ""}`.trim(),
        0,
        0,
      );
    },
  });

  pi.registerCommand("pm2", {
    description: "Manage PM2 apps declared in the active ecosystem config",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommandArgs(args) ?? (await showPm2Menu(ctx));
        if (!parsed) return;
        const text = await runPm2(parsed, ctx);
        ctx.ui.notify(text, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`PM2 error: ${message}`, "error");
      }
    },
  });
}
