import { spawn } from "node:child_process";
import net from "node:net";

import type { DeclaredPm2App } from "./ecosystem.js";
import {
  buildPlainTable,
  formatBytes,
  formatUptime,
  normalizeLines,
  normalizeTarget,
  summarizeCommandOutput,
  truncateTail,
  type Pm2Action,
} from "./helpers.js";
import type { ResolvedSettings } from "./settings.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface Pm2Runner {
  run(
    args: string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CommandResult>;
}

export interface Pm2ProcessStatus {
  name: string;
  status: string;
  pid?: number;
  pmId?: number;
  cpu?: number;
  memory?: number;
  restarts?: number;
  uptime?: string;
  url?: string;
}

export interface Pm2ActionResult {
  text: string;
  details: Record<string, unknown>;
  warnings: string[];
}

export interface ExecuteActionInput {
  action: Pm2Action;
  target?: string;
  lines?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CliPm2Runner implements Pm2Runner {
  constructor(private readonly pm2Bin: string) {}

  run(
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pm2Bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const timeout = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
          }, options.timeoutMs)
        : undefined;

      const abort = (): void => {
        timedOut = true;
        child.kill("SIGTERM");
      };

      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        resolve({ stdout, stderr, code, timedOut });
      });
    });
  }
}

function parsePm2List(stdout: string): Pm2ProcessStatus[] {
  const parsed = JSON.parse(stdout || "[]") as unknown;
  if (!Array.isArray(parsed)) throw new Error("pm2 jlist did not return a JSON array");
  return parsed.flatMap((item): Pm2ProcessStatus[] => {
    if (!isRecord(item)) return [];
    const name = typeof item.name === "string" ? item.name : undefined;
    if (!name) return [];
    const env = isRecord(item.pm2_env) ? item.pm2_env : {};
    const monit = isRecord(item.monit) ? item.monit : {};
    return [
      {
        name,
        status: typeof env.status === "string" ? env.status : "unknown",
        pid: typeof item.pid === "number" ? item.pid : undefined,
        pmId: typeof item.pm_id === "number" ? item.pm_id : undefined,
        cpu: typeof monit.cpu === "number" ? monit.cpu : undefined,
        memory: typeof monit.memory === "number" ? monit.memory : undefined,
        restarts: typeof env.restart_time === "number" ? env.restart_time : undefined,
        uptime: formatUptime(typeof env.pm_uptime === "number" ? env.pm_uptime : undefined),
      },
    ];
  });
}

async function getDeclaredStatuses(
  apps: DeclaredPm2App[],
  runner: Pm2Runner,
  settings: ResolvedSettings,
  signal?: AbortSignal,
): Promise<Pm2ProcessStatus[]> {
  const result = await runner.run(["jlist"], { signal, timeoutMs: settings.commandTimeoutMs });
  if (result.timedOut) throw new Error(`pm2 jlist timed out after ${settings.commandTimeoutMs}ms`);
  if (result.code !== 0) {
    throw new Error(
      `pm2 jlist failed: ${summarizeCommandOutput(result.stdout, result.stderr, settings.maxBytes)}`,
    );
  }
  const running = parsePm2List(result.stdout);
  return apps.map((app) => {
    const match = running.find((process) => process.name === app.name);
    return {
      name: app.name,
      status: match?.status ?? "stopped",
      pid: match?.pid,
      pmId: match?.pmId,
      cpu: match?.cpu,
      memory: match?.memory,
      restarts: match?.restarts,
      uptime: match?.uptime,
      url: app.metadata?.url,
    };
  });
}

function renderStatusTable(statuses: Pm2ProcessStatus[]): string {
  if (statuses.length === 0) return "No declared PM2 apps matched.";
  return buildPlainTable(
    ["app", "status", "pid", "cpu", "mem", "restarts", "uptime", "url"],
    statuses.map((status) => [
      status.name,
      status.status,
      status.pid === undefined ? "-" : String(status.pid),
      status.cpu === undefined ? "-" : `${status.cpu}%`,
      formatBytes(status.memory),
      status.restarts === undefined ? "-" : String(status.restarts),
      status.uptime ?? "n/a",
      status.url ?? "-",
    ]),
  );
}

async function runMutation(
  action: "start" | "restart" | "stop",
  names: string[],
  settings: ResolvedSettings,
  runner: Pm2Runner,
  signal?: AbortSignal,
): Promise<string[]> {
  const outputs: string[] = [];
  if (!settings.configPath) throw new Error("No PM2 config file is active");
  for (const name of names) {
    const args = action === "stop" ? ["stop", name] : [action, settings.configPath, "--only", name];
    const result = await runner.run(args, { signal, timeoutMs: settings.commandTimeoutMs });
    if (result.timedOut)
      throw new Error(`pm2 ${action} ${name} timed out after ${settings.commandTimeoutMs}ms`);
    if (result.code !== 0) {
      throw new Error(
        `pm2 ${action} ${name} failed: ${summarizeCommandOutput(result.stdout, result.stderr, settings.maxBytes)}`,
      );
    }
    outputs.push(
      `pm2 ${action} ${name}: ${summarizeCommandOutput(result.stdout, result.stderr, 2_000)}`,
    );
  }
  return outputs;
}

function renderConfig(apps: DeclaredPm2App[], settings: ResolvedSettings): string {
  const metadata = settings.metadataPath
    ? `${settings.metadataPath} (${settings.metadataSource})`
    : "none";
  return [
    `PM2 config: ${settings.configPath ?? "not found"}`,
    `Config source: ${settings.configSource ?? "none"}`,
    `Metadata: ${metadata}`,
    `PM2 binary: ${settings.pm2Bin}`,
    `Allowed apps: ${apps.map((app) => app.name).join(", ") || "none"}`,
    `Log limits: default ${settings.defaultLines} lines, max ${settings.maxLines} lines / ${settings.maxBytes} bytes`,
  ].join("\n");
}

function renderUrls(apps: DeclaredPm2App[]): string {
  const rows = apps
    .filter((app) => app.metadata?.url || app.metadata?.readinessUrl)
    .map((app) => [app.name, app.metadata?.url ?? "-", app.metadata?.readinessUrl ?? "-"]);
  if (rows.length === 0)
    return "No PM2 app URLs configured. Add .pi/pm2/metadata.json with app URL metadata.";
  return buildPlainTable(["app", "url", "readiness"], rows);
}

function localhostPortFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) return null;
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : null;
  } catch {
    return null;
  }
}

async function canConnectLocalPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });
}

async function collectPortWarnings(
  apps: DeclaredPm2App[],
  names: string[],
  statuses: Pm2ProcessStatus[],
  settings: ResolvedSettings,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const app of apps.filter((candidate) => names.includes(candidate.name))) {
    const status = statuses.find((candidate) => candidate.name === app.name)?.status;
    if (status === "online") continue;
    const port = localhostPortFromUrl(app.metadata?.url ?? app.metadata?.readinessUrl);
    if (!port) continue;
    if (await canConnectLocalPort(port, Math.min(settings.readinessTimeoutMs, 1_000))) {
      warnings.push(
        `Port ${port} for ${app.name} appears to be in use while PM2 does not report the app online; not killing unrelated processes.`,
      );
    }
  }
  return warnings;
}

export async function executePm2Action(
  input: ExecuteActionInput,
  apps: DeclaredPm2App[],
  settings: ResolvedSettings,
  runner: Pm2Runner,
  signal?: AbortSignal,
): Promise<Pm2ActionResult> {
  if (!settings.enabled) throw new Error("pm2-processes is disabled by settings");

  if (input.action === "config") {
    return {
      text: renderConfig(apps, settings),
      details: { action: input.action, settings },
      warnings: settings.diagnostics,
    };
  }

  if (!settings.configPath) {
    throw new Error(
      `No PM2 config file found. Searched:\n${settings.searchedConfigPaths.join("\n")}`,
    );
  }

  if (input.action === "urls") {
    return { text: renderUrls(apps), details: { action: input.action, apps }, warnings: [] };
  }

  if (input.action === "logs") {
    const target = normalizeTarget(input.target, apps, { defaultAll: false, allowAll: false });
    const lines = normalizeLines(input.lines, settings.defaultLines, settings.maxLines);
    const result = await runner.run(
      ["logs", target.names[0] ?? "", "--lines", String(lines), "--nostream", "--raw"],
      {
        signal,
        timeoutMs: settings.commandTimeoutMs,
      },
    );
    if (result.timedOut)
      throw new Error(
        `pm2 logs ${target.targetLabel} timed out after ${settings.commandTimeoutMs}ms`,
      );
    if (result.code !== 0) {
      throw new Error(
        `pm2 logs ${target.targetLabel} failed: ${summarizeCommandOutput(result.stdout, result.stderr, settings.maxBytes)}`,
      );
    }
    const truncated = truncateTail(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
      settings.maxBytes,
      lines,
    );
    const suffix = truncated.truncated
      ? `\n\n[logs truncated to ${lines} lines / ${settings.maxBytes} bytes]`
      : "";
    return {
      text: `Logs for ${target.targetLabel}:\n${truncated.text || "(no log output)"}${suffix}`,
      details: {
        action: input.action,
        target: target.targetLabel,
        lines,
        truncated: truncated.truncated,
      },
      warnings: [],
    };
  }

  const target = normalizeTarget(input.target, apps, { defaultAll: true, allowAll: true });
  if (input.action === "status") {
    const statuses = await getDeclaredStatuses(apps, runner, settings, signal);
    const selected = statuses.filter((status) => target.names.includes(status.name));
    return {
      text: renderStatusTable(selected),
      details: { action: input.action, target: target.targetLabel, statuses: selected },
      warnings: [],
    };
  }

  const beforeStatuses = await getDeclaredStatuses(apps, runner, settings, signal);
  const warnings = await collectPortWarnings(apps, target.names, beforeStatuses, settings);
  const mutationOutput = await runMutation(input.action, target.names, settings, runner, signal);
  const afterStatuses = await getDeclaredStatuses(apps, runner, settings, signal);
  const selected = afterStatuses.filter((status) => target.names.includes(status.name));
  return {
    text: [`PM2 ${input.action} ${target.targetLabel} complete.`, renderStatusTable(selected)].join(
      "\n\n",
    ),
    details: {
      action: input.action,
      target: target.targetLabel,
      outputs: mutationOutput,
      statuses: selected,
    },
    warnings,
  };
}
