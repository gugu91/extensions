import { describe, expect, it, vi } from "vitest";

import { runPsqlQueryWithTunnel, type PsqlTunnelState } from "./query-runner.js";
import type { ResolvedConfig } from "./settings.js";

const config: ResolvedConfig = {
  path: "/tmp/neon-psql.json",
  injectIntoBash: true,
  injectPythonShim: true,
  logPath: "/tmp/neon-psql.log",
  psqlBin: "/custom/bin/psql",
  sourceEnv: {
    host: "DB_HOST",
    port: "DB_PORT",
    user: "DB_USER",
    password: "DB_PASSWORD",
    database: "DB_NAME",
  },
  psqlEnv: {
    NEON_TUNNEL_DATABASE_URL: "postgresql://user:pass@127.0.0.1:6543/app",
  },
  injectEnv: {
    DATABASE_URL: "postgresql://user:pass@127.0.0.1:6543/app",
    PYTHONPATH: "/danger-zone",
  },
};

const state: PsqlTunnelState = {
  port: 6543,
  endpoint: "ep-cool-river",
  logPath: "/tmp/neon-psql.log",
  source: {
    host: "ep-cool-river.us-east-1.aws.neon.tech",
    port: "5432",
    user: "user@example.com",
    password: "super-secret",
    database: "app",
  },
};

describe("runPsqlQueryWithTunnel", () => {
  it("rejects mutating queries before trying to start the tunnel", async () => {
    const ensureTunnel = vi.fn();
    const buildPsqlEnv = vi.fn();
    const resolvePsqlBin = vi.fn();
    const executePsqlQuery = vi.fn();

    await expect(
      runPsqlQueryWithTunnel(config, "DELETE FROM users", "table", {}, undefined, undefined, {
        ensureTunnel,
        buildPsqlEnv,
        resolvePsqlBin,
        executePsqlQuery,
        truncateOutput: vi.fn(),
        formatBytes: vi.fn((bytes: number) => `${bytes}B`),
        maxOutputLines: 2000,
        maxOutputBytes: 50 * 1024,
      }),
    ).rejects.toThrow(
      "The psql extension only allows read-only queries and psql inspection meta-commands",
    );

    expect(ensureTunnel).not.toHaveBeenCalled();
    expect(buildPsqlEnv).not.toHaveBeenCalled();
    expect(resolvePsqlBin).not.toHaveBeenCalled();
    expect(executePsqlQuery).not.toHaveBeenCalled();
  });

  it("starts the tunnel and delegates to executePsqlQuery for read-only queries", async () => {
    const ensureTunnel = vi.fn(async () => state);
    const buildPsqlEnv = vi.fn(() => config.psqlEnv);
    const resolvePsqlBin = vi.fn(() => "/custom/bin/psql");
    const executePsqlQuery = vi.fn(async () => ({
      text: "id,name\n1,Alice",
      details: {
        query: "SELECT 1",
        format: "table" as const,
        tunnelPort: state.port,
        endpoint: state.endpoint,
        logPath: state.logPath,
        configPath: config.path,
        streaming: false,
        outputPreview: "id,name\n1,Alice",
      },
    }));
    const truncateOutput = vi.fn((text: string) => ({
      content: text,
      truncated: false,
      outputLines: text.split("\n").length,
      totalLines: text.split("\n").length,
      outputBytes: Buffer.byteLength(text, "utf8"),
      totalBytes: Buffer.byteLength(text, "utf8"),
    }));
    const formatBytes = vi.fn((bytes: number) => `${bytes}B`);
    const onUpdate = vi.fn();
    const signal = new AbortController().signal;

    const result = await runPsqlQueryWithTunnel(
      config,
      "SELECT 1",
      "table",
      { hasUI: false },
      signal,
      onUpdate,
      {
        ensureTunnel,
        buildPsqlEnv,
        resolvePsqlBin,
        executePsqlQuery,
        truncateOutput,
        formatBytes,
        maxOutputLines: 2000,
        maxOutputBytes: 50 * 1024,
      },
    );

    expect(ensureTunnel).toHaveBeenCalledWith(config, { hasUI: false });
    expect(buildPsqlEnv).toHaveBeenCalledWith(config, state);
    expect(resolvePsqlBin).toHaveBeenCalledWith({ configuredPath: config.psqlBin });
    expect(executePsqlQuery).toHaveBeenCalledWith({
      psqlBin: "/custom/bin/psql",
      configPath: config.path,
      query: "SELECT 1",
      format: "table",
      state,
      psqlEnv: config.psqlEnv,
      signal,
      onUpdate,
      truncateOutput,
      formatBytes,
      maxOutputLines: 2000,
      maxOutputBytes: 50 * 1024,
    });
    expect(result.text).toBe("id,name\n1,Alice");
  });
});
