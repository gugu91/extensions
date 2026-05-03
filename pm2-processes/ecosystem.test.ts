import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDeclaredApps } from "./ecosystem.js";

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pm2-ecosystem-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("loadDeclaredApps", () => {
  it("loads declared app names and metadata", async () => {
    const dir = makeTmp();
    const configPath = path.join(dir, "ecosystem.config.cjs");
    const metadataPath = path.join(dir, "metadata.json");
    writeFileSync(configPath, "module.exports = { apps: [{ name: 'api' }, { name: 'web' }] };\n");
    writeFileSync(
      metadataPath,
      JSON.stringify({ apps: { api: { url: "http://localhost:3001/health" } } }),
    );

    const apps = await loadDeclaredApps(configPath, metadataPath);

    expect(apps).toEqual([
      {
        name: "api",
        metadata: {
          url: "http://localhost:3001/health",
          readinessUrl: undefined,
          description: undefined,
        },
      },
      { name: "web", metadata: undefined },
    ]);
  });

  it("rejects duplicate names", async () => {
    const dir = makeTmp();
    const configPath = path.join(dir, "ecosystem.config.cjs");
    writeFileSync(configPath, "module.exports = { apps: [{ name: 'api' }, { name: 'api' }] };\n");

    await expect(loadDeclaredApps(configPath)).rejects.toThrow("Duplicate PM2 app name");
  });

  it("requires explicit app names", async () => {
    const dir = makeTmp();
    const configPath = path.join(dir, "ecosystem.config.cjs");
    writeFileSync(configPath, "module.exports = { apps: [{ script: 'server.js' }] };\n");

    await expect(loadDeclaredApps(configPath)).rejects.toThrow(
      "must declare a non-empty string name",
    );
  });

  it("does not execute JavaScript ecosystem files while discovering apps", async () => {
    const dir = makeTmp();
    const configPath = path.join(dir, "ecosystem.config.cjs");
    const sideEffectPath = path.join(dir, "side-effect.txt");
    writeFileSync(
      configPath,
      `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(sideEffectPath)}, "executed");\nmodule.exports = { apps: [{ name: "api" }] };\n`,
    );

    await expect(loadDeclaredApps(configPath)).resolves.toEqual([
      { name: "api", metadata: undefined },
    ]);
    expect(existsSync(sideEffectPath)).toBe(false);
  });

  it("rejects dynamic app names instead of executing workspace config", async () => {
    const dir = makeTmp();
    const configPath = path.join(dir, "ecosystem.config.cjs");
    writeFileSync(configPath, "module.exports = { apps: [{ name: process.env.APP_NAME }] };\n");

    await expect(loadDeclaredApps(configPath)).rejects.toThrow("static string name");
  });
});
