import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "./settings.js";

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pm2-processes-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("loadSettings", () => {
  it("discovers project-local default ecosystem config", () => {
    const cwd = makeTmp();
    const configPath = path.join(cwd, ".pi", "pm2", "ecosystem.config.cjs");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, "module.exports = { apps: [] };\n");

    const settings = loadSettings({ cwd, agentDir: makeTmp(), env: {} });

    expect(settings.configPath).toBe(configPath);
    expect(settings.configSource).toBe("default:.pi/pm2/ecosystem.config.cjs");
  });

  it("uses PI_PM2_CONFIG before defaults", () => {
    const cwd = makeTmp();
    const explicit = path.join(cwd, "custom.config.cjs");
    writeFileSync(explicit, "module.exports = { apps: [] };\n");
    const defaultConfig = path.join(cwd, "ecosystem.config.cjs");
    writeFileSync(defaultConfig, "module.exports = { apps: [] };\n");

    const settings = loadSettings({ cwd, agentDir: makeTmp(), env: { PI_PM2_CONFIG: explicit } });

    expect(settings.configPath).toBe(explicit);
    expect(settings.configSource).toBe("env:PI_PM2_CONFIG");
  });

  it("merges global and project settings with project precedence", () => {
    const cwd = makeTmp();
    const agentDir = makeTmp();
    const globalConfig = path.join(cwd, "global.config.cjs");
    const projectConfig = path.join(cwd, "project.config.cjs");
    writeFileSync(globalConfig, "module.exports = { apps: [] };\n");
    writeFileSync(projectConfig, "module.exports = { apps: [] };\n");
    mkdirSync(path.join(agentDir), { recursive: true });
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ "pm2-processes": { configPath: globalConfig, maxLines: 42 } }),
    );
    writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pm2-processes": { configPath: projectConfig } }),
    );

    const settings = loadSettings({ cwd, agentDir, env: {} });

    expect(settings.configPath).toBe(projectConfig);
    expect(settings.maxLines).toBe(42);
    expect(settings.settingsSources).toHaveLength(2);
  });
});
