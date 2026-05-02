import { describe, expect, it } from "vitest";

import type { DeclaredPm2App } from "./ecosystem.js";
import { executePm2Action, type CommandResult, type Pm2Runner } from "./pm2.js";
import type { ResolvedSettings } from "./settings.js";

class FakeRunner implements Pm2Runner {
  readonly calls: string[][] = [];

  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "jlist") {
      return {
        stdout: JSON.stringify([
          {
            name: "api",
            pid: 123,
            pm_id: 0,
            pm2_env: { status: "online", restart_time: 2, pm_uptime: Date.now() - 10_000 },
            monit: { cpu: 1, memory: 2048 },
          },
        ]),
        stderr: "",
        code: 0,
        timedOut: false,
      };
    }
    if (args[0] === "logs") {
      return { stdout: "line1\nline2\nline3", stderr: "", code: 0, timedOut: false };
    }
    return { stdout: "ok", stderr: "", code: 0, timedOut: false };
  }
}

const settings: ResolvedSettings = {
  enabled: true,
  configPath: "/repo/ecosystem.config.cjs",
  configSource: "test",
  pm2Bin: "pm2",
  defaultLines: 2,
  maxLines: 10,
  maxBytes: 10_000,
  commandTimeoutMs: 1_000,
  readinessTimeoutMs: 100,
  settingsSources: [],
  searchedConfigPaths: ["/repo/ecosystem.config.cjs"],
  diagnostics: [],
};

const apps: DeclaredPm2App[] = [{ name: "api" }, { name: "web" }];

describe("executePm2Action", () => {
  it("renders status for declared apps even before they are running", async () => {
    const runner = new FakeRunner();
    const result = await executePm2Action(
      { action: "status", target: "all" },
      apps,
      settings,
      runner,
    );

    expect(result.text).toContain("api");
    expect(result.text).toContain("web");
    expect(result.text).toContain("stopped");
    expect(runner.calls).toEqual([["jlist"]]);
  });

  it("expands stop all into exact app-name commands", async () => {
    const runner = new FakeRunner();
    await executePm2Action({ action: "stop", target: "all" }, apps, settings, runner);

    expect(runner.calls).toContainEqual(["stop", "api"]);
    expect(runner.calls).toContainEqual(["stop", "web"]);
    expect(runner.calls).not.toContainEqual(["stop", "all"]);
  });

  it("starts via ecosystem config with --only exact app name", async () => {
    const runner = new FakeRunner();
    await executePm2Action({ action: "start", target: "api" }, apps, settings, runner);

    expect(runner.calls).toContainEqual(["start", "/repo/ecosystem.config.cjs", "--only", "api"]);
  });

  it("requires logs target to be a single declared app", async () => {
    const runner = new FakeRunner();

    await expect(
      executePm2Action({ action: "logs", target: "all" }, apps, settings, runner),
    ).rejects.toThrow("Target 'all' is not supported");
  });

  it("shows config diagnostics before a PM2 config has been created", async () => {
    const runner = new FakeRunner();
    const result = await executePm2Action(
      { action: "config" },
      [],
      {
        ...settings,
        configPath: undefined,
        configSource: undefined,
        searchedConfigPaths: ["/repo/.pi/pm2/ecosystem.config.cjs"],
      },
      runner,
    );

    expect(result.text).toContain("PM2 config: not found");
    expect(result.text).toContain("Allowed apps: none");
    expect(runner.calls).toEqual([]);
  });
});
