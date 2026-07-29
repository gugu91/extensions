import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHerdrWorkerRuntimeController,
  type HerdrCommandOptions,
  type HerdrCommandRunner,
} from "./subtree-broker-runtime.js";

interface HerdrInvocation {
  args: string[];
  options: HerdrCommandOptions;
}

const tempDirs: string[] = [];
const originalTmuxSession = process.env.PINET_TMUX_SESSION;

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-herdr-controller-"));
  tempDirs.push(dir);
  return dir;
}

function missingSessionError(): Error {
  return Object.assign(new Error("herdr command failed"), {
    stderr: 'Error: Os { code: 2, kind: NotFound, message: "No such file or directory" }',
  });
}

function missingPaneError(): Error {
  return Object.assign(new Error("herdr command failed"), {
    stderr:
      '{"error":{"code":"pane_not_found","message":"pane w1:p2 not found"},"id":"cli:pane:get"}',
  });
}

function workspaceCreated(paneId: string): string {
  return JSON.stringify({ result: { root_pane: { pane_id: paneId } } });
}

function processInfo(paneId: string, shellPid: number): string {
  return JSON.stringify({ result: { process_info: { pane_id: paneId, shell_pid: shellPid } } });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (originalTmuxSession === undefined) delete process.env.PINET_TMUX_SESSION;
  else process.env.PINET_TMUX_SESSION = originalTmuxSession;
});

describe("Herdr worker runtime controller", () => {
  it("starts the owned server and neutralizes an inherited tmux identity", async () => {
    process.env.PINET_TMUX_SESSION = "parent-stale";
    const calls: HerdrInvocation[] = [];
    const configDir = tempConfigDir();
    let invocation = 0;
    const runHerdrCommand: HerdrCommandRunner = async (args, options) => {
      calls.push({ args, options });
      invocation += 1;
      if (invocation === 1) throw missingSessionError();
      if (invocation === 4) return workspaceCreated("w1:p2");
      if (invocation === 5) return processInfo("w1:p2", 4242);
      return "{}";
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: configDir,
    });
    const spec = controller.createLaunchSpec("worker-one");
    const launcherPath = path.join(configDir, "launchers", "worker-one.sh");

    await controller.launch(spec, launcherPath, {
      PINET_SOCKET_PATH: "/tmp/pinet.sock",
      PINET_LAUNCH_ID: "launch-1",
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["--session", "pinet-workers", "pane", "list"],
      ["--session", "pinet-workers", "server"],
      ["--session", "pinet-workers", "pane", "list"],
      [
        "--session",
        "pinet-workers",
        "workspace",
        "create",
        "--cwd",
        path.dirname(launcherPath),
        "--label",
        "worker-one",
        "--env",
        "PINET_SOCKET_PATH=/tmp/pinet.sock",
        "--env",
        "PINET_LAUNCH_ID=launch-1",
        "--env",
        "PINET_BROKER_AGENT_ID=",
        "--env",
        "PINET_BROKER_MANAGED=",
        "--env",
        "PINET_LANE_ID=",
        "--env",
        "PINET_LAUNCH_SOURCE=",
        "--env",
        "PINET_PARENT_AGENT_ID=",
        "--env",
        "PINET_ROOT_AGENT_ID=",
        "--env",
        "PINET_SPAWNED_BY_AGENT_ID=",
        "--env",
        "PINET_SUBTREE_ROLE=",
        "--env",
        "PINET_TMUX_SESSION=",
        "--no-focus",
      ],
      ["--session", "pinet-workers", "pane", "process-info", "--pane", "w1:p2"],
      ["--session", "pinet-workers", "pane", "run", "w1:p2", `'${launcherPath}'`],
    ]);
    expect(calls[1]?.options.detached).toBe(true);
    expect(calls.every((call) => call.options.env.XDG_CONFIG_HOME === configDir)).toBe(true);
    expect(calls.every((call) => call.options.env.PINET_TMUX_SESSION === "parent-stale")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(configDir, "herdr", "config.toml"), "utf8")).toBe(
      "[experimental]\npane_history = true\n",
    );
    expect(spec).toMatchObject({
      runtimeKind: "herdr",
      herdrPaneId: "w1:p2",
      herdrShellPid: 4242,
    });
  });

  it("rolls back a created pane when PID capture fails", async () => {
    const calls: string[][] = [];
    const configDir = tempConfigDir();
    const processError = new Error("process info unavailable");
    const runHerdrCommand: HerdrCommandRunner = async (args) => {
      calls.push(args);
      if (args.includes("create")) return workspaceCreated("w1:p3");
      if (args.includes("process-info")) throw processError;
      return "{}";
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: configDir,
    });
    const spec = controller.createLaunchSpec("worker-rollback");

    await expect(controller.launch(spec, "/tmp/worker-rollback.sh", {})).rejects.toBe(processError);
    expect(calls.at(-1)).toEqual(["--session", "pinet-workers", "pane", "close", "w1:p3"]);
    expect(spec).toMatchObject({ herdrPaneId: null, herdrShellPid: null });
    await expect(controller.cleanup(spec)).resolves.toBeUndefined();
  });

  it("surfaces the pane id when rollback before PID capture fails", async () => {
    const configDir = tempConfigDir();
    const runHerdrCommand: HerdrCommandRunner = async (args) => {
      if (args.includes("create")) return workspaceCreated("w1:p5");
      if (args.includes("process-info")) throw new Error("process info unavailable");
      if (args.includes("close")) throw new Error("close transport unavailable");
      return "{}";
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: configDir,
    });
    const spec = controller.createLaunchSpec("worker-rollback-failure");

    await expect(controller.launch(spec, "/tmp/worker-rollback-failure.sh", {})).rejects.toThrow(
      "pane w1:p5, and rollback failed: close transport unavailable",
    );
    expect(spec).toMatchObject({ herdrPaneId: "w1:p5", herdrShellPid: null });
  });

  it("treats cleanup with no recorded pane generation as a no-op", async () => {
    const runHerdrCommand = vi.fn<HerdrCommandRunner>();
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: tempConfigDir(),
    });

    await expect(
      controller.cleanup(controller.createLaunchSpec("never-launched")),
    ).resolves.toBeUndefined();
    expect(runHerdrCommand).not.toHaveBeenCalled();
  });

  it("propagates a launch failure after capturing the pane generation", async () => {
    const configDir = tempConfigDir();
    const launchError = new Error("pane input transport failed");
    let invocation = 0;
    const runHerdrCommand: HerdrCommandRunner = async () => {
      invocation += 1;
      if (invocation === 2) return workspaceCreated("w1:p4");
      if (invocation === 3) return processInfo("w1:p4", 9876);
      if (invocation === 4) throw launchError;
      return "{}";
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: configDir,
    });
    const spec = controller.createLaunchSpec("worker-failure");

    await expect(controller.launch(spec, "/tmp/worker-failure.sh", {})).rejects.toBe(launchError);
    expect(spec).toMatchObject({ herdrPaneId: "w1:p4", herdrShellPid: 9876 });
  });

  it("closes a pane only when its fresh shell PID matches", async () => {
    const calls: string[][] = [];
    const runHerdrCommand: HerdrCommandRunner = async (args) => {
      calls.push(args);
      return args.includes("process-info") ? processInfo("w1:p2", 4242) : "{}";
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: tempConfigDir(),
    });
    const spec = controller.createLaunchSpec("worker-one");
    spec.herdrPaneId = "w1:p2";
    spec.herdrShellPid = 4242;

    await controller.cleanup(spec);

    expect(calls).toEqual([
      ["--session", "pinet-workers", "pane", "get", "w1:p2"],
      ["--session", "pinet-workers", "pane", "process-info", "--pane", "w1:p2"],
      ["--session", "pinet-workers", "pane", "close", "w1:p2"],
    ]);
  });

  it("refuses cleanup when the pane shell PID no longer matches", async () => {
    const calls: string[][] = [];
    const runHerdrCommand: HerdrCommandRunner = async (args) => {
      calls.push(args);
      return args.includes("process-info") ? processInfo("w1:p2", 9999) : "{}";
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: tempConfigDir(),
    });
    const spec = controller.createLaunchSpec("worker-one");
    spec.herdrPaneId = "w1:p2";
    spec.herdrShellPid = 4242;

    await expect(controller.cleanup(spec)).rejects.toThrow(
      "recorded shell PID 4242, observed 9999",
    );
    expect(calls).toHaveLength(2);
    expect(calls.some((args) => args.includes("close"))).toBe(false);
  });

  it.each([
    ["missing pane", missingPaneError],
    ["missing session", missingSessionError],
  ])("treats a %s as already cleaned", async (_label, createError) => {
    const runHerdrCommand: HerdrCommandRunner = async () => {
      throw createError();
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: tempConfigDir(),
    });
    const spec = controller.createLaunchSpec("worker-one");
    spec.herdrPaneId = "w1:p2";
    spec.herdrShellPid = 4242;

    await expect(controller.cleanup(spec)).resolves.toBeUndefined();
  });

  it("propagates operational cleanup failures", async () => {
    const operationalError = new Error("Herdr API transport unavailable");
    const runHerdrCommand: HerdrCommandRunner = async () => {
      throw operationalError;
    };
    const controller = createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: tempConfigDir(),
    });
    const spec = controller.createLaunchSpec("worker-one");
    spec.herdrPaneId = "w1:p2";
    spec.herdrShellPid = 4242;

    await expect(controller.cleanup(spec)).rejects.toBe(operationalError);
  });
});
