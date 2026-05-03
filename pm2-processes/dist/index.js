import { StringEnum } from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadDeclaredApps } from "./ecosystem.js";
import {} from "./helpers.js";
import { CliPm2Runner, executePm2Action } from "./pm2.js";
import { loadSettings } from "./settings.js";
const PM2_ACTIONS = ["status", "start", "restart", "stop", "logs", "urls", "config"];
const Pm2ProcessParams = Type.Object({
    action: StringEnum(PM2_ACTIONS, {
        description: "PM2 action to run against declared apps only.",
    }),
    target: Type.Optional(Type.String({
        description: "Declared app name, or 'all' for status/start/restart/stop. Required for logs.",
    })),
    lines: Type.Optional(Type.Number({
        description: "Line count for logs; clamped to configured safe limits.",
    })),
});
function parseCommandArgs(args) {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return null;
    const action = tokens[0];
    if (!PM2_ACTIONS.includes(action)) {
        throw new Error(`Unknown /pm2 action '${tokens[0]}'. Expected: ${PM2_ACTIONS.join(", ")}`);
    }
    let target;
    let lines;
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === "--lines") {
            const value = tokens[index + 1];
            if (!value)
                throw new Error("/pm2 logs --lines requires a number");
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
function formatWarnings(warnings) {
    return warnings.length > 0
        ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "";
}
async function prepare(cwd, options) {
    const settings = loadSettings({ cwd, agentDir: getAgentDir() });
    const runner = new CliPm2Runner(settings.pm2Bin);
    if (!settings.configPath)
        return { settings, apps: [], runner };
    try {
        const apps = await loadDeclaredApps(settings.configPath, settings.metadataPath);
        return { settings, apps, runner };
    }
    catch (error) {
        if (!options.tolerateAppDiscoveryErrors)
            throw error;
        const message = error instanceof Error ? error.message : String(error);
        return {
            settings: {
                ...settings,
                diagnostics: [...settings.diagnostics, `PM2 app discovery skipped: ${message}`],
            },
            apps: [],
            runner,
        };
    }
}
async function runPm2(input, ctx, signal) {
    const { settings, apps, runner } = await prepare(ctx.cwd, {
        tolerateAppDiscoveryErrors: input.action === "config",
    });
    const result = await executePm2Action(input, apps, settings, runner, signal);
    return `${result.text}${formatWarnings(result.warnings)}`;
}
async function showPm2Menu(ctx) {
    const settings = loadSettings({ cwd: ctx.cwd, agentDir: getAgentDir() });
    return settings.configPath ? { action: "status", target: "all" } : { action: "config" };
}
export default function pm2ProcessesExtension(pi) {
    pi.registerTool({
        name: "pm2_process",
        label: "PM2 Process",
        description: "Manage project-local PM2 apps declared in the active ecosystem config. Actions are bounded and app-name allowlisted.",
        promptSnippet: "Manage declared PM2 apps via status/start/restart/stop/logs/urls/config without arbitrary shell commands.",
        promptGuidelines: [
            "Use pm2_process for project PM2 process lifecycle tasks instead of starting long-running processes with bash.",
            "pm2_process only accepts exact declared app names or all where supported; do not use PM2 wildcards or delete/kill actions.",
        ],
        parameters: Pm2ProcessParams,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const text = await runPm2(params, ctx, signal);
            return {
                content: [{ type: "text", text }],
                details: { action: params.action, target: params.target },
            };
        },
        renderCall(args, theme) {
            return new Text(`${theme.fg("toolTitle", theme.bold("pm2_process"))} ${args.action ?? ""} ${args.target ?? ""}`.trim(), 0, 0);
        },
    });
    pi.registerCommand("pm2", {
        description: "Manage PM2 apps declared in the active ecosystem config",
        handler: async (args, ctx) => {
            try {
                const parsed = parseCommandArgs(args) ?? (await showPm2Menu(ctx));
                if (!parsed)
                    return;
                const text = await runPm2(parsed, ctx);
                ctx.ui.notify(text, "info");
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`PM2 error: ${message}`, "error");
            }
        },
    });
}
