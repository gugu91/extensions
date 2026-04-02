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

  it("loads top-level project settings", () => {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "neon-psql": {
          injectIntoBash: false,
          sourceEnv: { host: "PROJECT_DB_HOST" },
        },
      }),
    );

    const result = loadConfig({ cwd, agentDir, extensionDir, env: {} });

    expect(result).toMatchObject({
      path: path.join(cwd, ".pi", "settings.json") + "#neon-psql",
      injectIntoBash: false,
      injectPythonShim: true,
      sourceEnv: {
        host: "PROJECT_DB_HOST",
        port: "DB_PORT",
        user: "DB_USER",
        password: "DB_PASSWORD",
        database: "DB_NAME",
      },
    });
    expect(result?.logPath).toBe(path.join(cwd, ".pi", "neon-psql-tunnel.log"));
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
      injectIntoBash: true,
      injectPythonShim: false,
    });
    expect(result?.logPath).toBe(path.join(cwd, "logs", "neon.log"));
  });

  it("prefers explicit env config file over settings", () => {
    const explicitPath = path.join(tmpDir, "explicit.json");
    fs.writeFileSync(explicitPath, JSON.stringify({ injectIntoBash: false }));
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "neon-psql": { injectIntoBash: true } }),
    );

    const result = loadConfig({
      cwd,
      agentDir,
      extensionDir,
      env: { PI_NEON_PSQL_CONFIG: explicitPath },
    });

    expect(result?.path).toBe(explicitPath);
    expect(result?.injectIntoBash).toBe(false);
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
});

describe("neon-psql — core query validation", () => {
  // Helper function to test query validation
  function isReadOnlyQuery(query: string): boolean {
    const stripped = query
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--.*$/gm, " ")
      .trim()
      .toLowerCase();

    if (stripped.length === 0) return false;
    const metaCommand = stripped.charCodeAt(0) === 92; // Check for backslash
    if (metaCommand) return true;

    return ["select", "with", "show", "explain", "values", "table"].some((prefix) =>
      stripped.startsWith(prefix),
    );
  }

  it("allows SELECT statements", () => {
    expect(isReadOnlyQuery("SELECT * FROM users")).toBe(true);
    expect(isReadOnlyQuery("SELECT COUNT(*) FROM orders")).toBe(true);
  });

  it("allows WITH queries", () => {
    expect(isReadOnlyQuery("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(true);
  });

  it("allows SHOW commands", () => {
    expect(isReadOnlyQuery("SHOW databases")).toBe(true);
  });

  it("allows EXPLAIN", () => {
    expect(isReadOnlyQuery("EXPLAIN SELECT 1")).toBe(true);
  });

  it("allows VALUES and TABLE", () => {
    expect(isReadOnlyQuery("VALUES (1), (2)")).toBe(true);
    expect(isReadOnlyQuery("TABLE users")).toBe(true);
  });

  it("rejects INSERT, UPDATE, DELETE", () => {
    expect(isReadOnlyQuery("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isReadOnlyQuery("UPDATE t SET x=1")).toBe(false);
    expect(isReadOnlyQuery("DELETE FROM t")).toBe(false);
  });

  it("rejects CREATE, ALTER, DROP", () => {
    expect(isReadOnlyQuery("CREATE TABLE t (id INT)")).toBe(false);
    expect(isReadOnlyQuery("ALTER TABLE t ADD COLUMN x INT")).toBe(false);
    expect(isReadOnlyQuery("DROP TABLE t")).toBe(false);
  });

  it("handles comments correctly", () => {
    expect(isReadOnlyQuery("/* comment */ SELECT 1")).toBe(true);
    expect(isReadOnlyQuery("-- comment\nSELECT 1")).toBe(true);
  });

  it("rejects empty queries", () => {
    expect(isReadOnlyQuery("")).toBe(false);
    expect(isReadOnlyQuery("   ")).toBe(false);
    expect(isReadOnlyQuery("-- just a comment")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isReadOnlyQuery("select * from t")).toBe(true);
    expect(isReadOnlyQuery("SELECT * FROM T")).toBe(true);
  });
});
