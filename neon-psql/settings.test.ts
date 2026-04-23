import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig } from "./settings.js";

describe("loadConfig", () => {
  let tmpDir: string;
  let cwd: string;
  let agentDir: string;
  let extensionDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "neon-psql-test-"));
    cwd = path.join(tmpDir, "workspace");
    agentDir = path.join(tmpDir, "agent");
    extensionDir = path.join(tmpDir, "extension");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(extensionDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads top-level project settings with default-off injection and narrow psql env", () => {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "neon-psql": {
          sourceEnv: { host: "PROJECT_DB_HOST" },
        },
      }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result).toMatchObject({
      path: path.join(cwd, ".pi", "settings.json") + "#neon-psql",
      injectIntoBash: false,
      injectPythonShim: false,
      sourceEnv: {
        host: "PROJECT_DB_HOST",
        port: "DB_PORT",
        user: "DB_USER",
        password: "DB_PASSWORD",
        database: "DB_NAME",
      },
      psqlEnv: {
        NEON_TUNNEL_DATABASE_URL: "postgres_url",
      },
    });
    expect(result?.logPath).toBe(path.join(cwd, ".pi", "neon-psql-tunnel.log"));
    expect(result?.injectEnv.DATABASE_URL).toBe("postgres_url");
  });

  it("prefers project settings over global settings", () => {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "neon-psql": { injectIntoBash: false } }),
    );
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "neon-psql": { injectIntoBash: true } }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result?.path).toBe(path.join(cwd, ".pi", "settings.json") + "#neon-psql");
    expect(result?.injectIntoBash).toBe(false);
  });

  it("loads top-level global settings when project settings are absent", () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        "neon-psql": {
          injectPythonShim: false,
          logPath: "logs/neon.log",
        },
      }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result).toMatchObject({
      path: path.join(agentDir, "settings.json") + "#neon-psql",
      injectIntoBash: false,
      injectPythonShim: false,
    });
    expect(result?.logPath).toBe(path.join(cwd, "logs", "neon.log"));
  });

  it("keeps explicit injection opt-ins and separate psql env overrides", () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        "neon-psql": {
          injectIntoBash: true,
          injectPythonShim: true,
          psqlEnv: {
            NEON_TUNNEL_DATABASE_URL: "psql_url",
          },
          injectEnv: {
            DATABASE_URL: "postgres_url",
            ASYNCPG_DSN: "asyncpg_dsn",
          },
        },
      }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result?.injectIntoBash).toBe(true);
    expect(result?.injectPythonShim).toBe(true);
    expect(result?.psqlEnv).toEqual({
      NEON_TUNNEL_DATABASE_URL: "psql_url",
    });
    expect(result?.injectEnv).toMatchObject({
      DATABASE_URL: "postgres_url",
      ASYNCPG_DSN: "asyncpg_dsn",
    });
  });

  it("prefers explicit env config file over settings", () => {
    const explicitPath = path.join(tmpDir, "explicit.json");
    fs.writeFileSync(explicitPath, JSON.stringify({ injectIntoBash: true }));
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "neon-psql": { injectIntoBash: false } }),
    );

    const result = loadConfig({
      cwd,
      agentDir,
      extensionDir,
      env: { PI_NEON_PSQL_CONFIG: explicitPath },
    });

    expect(result?.path).toBe(explicitPath);
    expect(result?.injectIntoBash).toBe(true);
  });

  it("falls back to legacy config files", () => {
    fs.writeFileSync(
      path.join(extensionDir, "config.json"),
      JSON.stringify({ injectPythonShim: false }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result?.path).toBe(path.join(extensionDir, "config.json"));
    expect(result?.injectPythonShim).toBe(false);
  });

  it("returns null when the selected config is disabled", () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "neon-psql": { enabled: false } }),
    );
    fs.writeFileSync(
      path.join(extensionDir, "config.json"),
      JSON.stringify({ injectIntoBash: true }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result).toBeNull();
  });

  it("preserves absolute log paths", () => {
    const absoluteLogPath = path.join(tmpDir, "logs", "neon.log");
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "neon-psql": { logPath: absoluteLogPath } }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result?.logPath).toBe(absoluteLogPath);
  });

  it("loads an optional psql binary override", () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "neon-psql": { psqlBin: " /custom/psql " } }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result?.psqlBin).toBe("/custom/psql");
  });
});
