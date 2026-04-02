import { isReadOnlyQuery, type SourceValues } from "./helpers.js";
import {
  type ExecutePsqlQueryOptions,
  type OutputFormat,
  type PsqlDetails,
  type PsqlPartialUpdate,
} from "./query-execution.js";
import type { ResolvedConfig } from "./settings.js";

export interface PsqlTunnelState {
  port: number;
  endpoint: string;
  logPath: string;
  source: SourceValues;
}

export interface RunPsqlQueryWithTunnelDependencies<
  TContext,
  TState extends PsqlTunnelState = PsqlTunnelState,
> {
  ensureTunnel: (config: ResolvedConfig, ctx: TContext) => Promise<TState>;
  buildInjectedValues: (config: ResolvedConfig, state: TState) => Record<string, string>;
  resolvePsqlBin: (options: { configuredPath?: string }) => string;
  executePsqlQuery: (
    options: ExecutePsqlQueryOptions,
  ) => Promise<{ text: string; details: PsqlDetails }>;
  truncateOutput: ExecutePsqlQueryOptions["truncateOutput"];
  formatBytes: ExecutePsqlQueryOptions["formatBytes"];
  maxOutputLines: number;
  maxOutputBytes: number;
}

export async function runPsqlQueryWithTunnel<
  TContext,
  TState extends PsqlTunnelState = PsqlTunnelState,
>(
  config: ResolvedConfig,
  query: string,
  format: OutputFormat,
  ctx: TContext,
  signal: AbortSignal | undefined,
  onUpdate: ((update: PsqlPartialUpdate) => void) | undefined,
  dependencies: RunPsqlQueryWithTunnelDependencies<TContext, TState>,
): Promise<{ text: string; details: PsqlDetails }> {
  if (!isReadOnlyQuery(query)) {
    throw new Error(
      "The psql extension only allows read-only queries and psql inspection meta-commands (e.g. SELECT, WITH, SHOW, EXPLAIN, VALUES, TABLE, \\d, \\dt).",
    );
  }

  const state = await dependencies.ensureTunnel(config, ctx);
  const injected = dependencies.buildInjectedValues(config, state);

  return dependencies.executePsqlQuery({
    psqlBin: dependencies.resolvePsqlBin({ configuredPath: config.psqlBin }),
    configPath: config.path,
    query,
    format,
    state,
    injectedEnv: injected,
    signal,
    onUpdate,
    truncateOutput: dependencies.truncateOutput,
    formatBytes: dependencies.formatBytes,
    maxOutputLines: dependencies.maxOutputLines,
    maxOutputBytes: dependencies.maxOutputBytes,
  });
}
