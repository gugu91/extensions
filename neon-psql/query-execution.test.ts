import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  executePsqlQuery,
  type ExecutePsqlQueryOptions,
  type PsqlExecutionState,
  type SpawnedPsqlProcess,
} from "./query-execution.js";
import type { ResolvedConfig } from "./settings.js";

class FakePsqlProcess extends EventEmitter implements SpawnedPsqlProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];

  emitStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }

  emitStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }

  close(code: number | null = 0): void {
    this.emit("close", code);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  kill(signal?: NodeJS.Signals): void {
    this.killSignals.push(signal);
    queueMicrotask(() => this.emit("close", null));
  }
}

const source = {
  host: "ep-cool-river.us-east-1.aws.neon.tech",
  port: "5432",
  user: "user@example.com",
  password: "super-secret",
  database: "app",
};

const state: PsqlExecutionState = {
  port: 6543,
  endpoint: "ep-cool-river",
  logPath: "/tmp/neon-psql.log",
  source,
};

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
  injectEnv: {
    NEON_TUNNEL_DATABASE_URL:
      "postgresql://user%40example.com:super-secret@127.0.0.1:6543/app?sslmode=require",
  },
};

function makeOptions(overrides: Partial<ExecutePsqlQueryOptions> = {}): ExecutePsqlQueryOptions {
  return {
    psqlBin: config.psqlBin ?? "/usr/bin/psql",
    configPath: config.path,
    query: "SELECT 1",
    format: "table",
    state,
    injectedEnv: config.injectEnv,
    spawnProcess: vi.fn(() => new FakePsqlProcess()),
    truncateOutput: (text) => ({
      content: text,
      truncated: false,
      outputLines: text === "" ? 0 : text.split("\n").length,
      totalLines: text === "" ? 0 : text.split("\n").length,
      outputBytes: Buffer.byteLength(text, "utf8"),
      totalBytes: Buffer.byteLength(text, "utf8"),
    }),
    formatBytes: (bytes) => `${bytes}B`,
    ...overrides,
  };
}

describe("executePsqlQuery", () => {
  it("rejects non-read-only queries before spawning psql", async () => {
    const spawnProcess = vi.fn();

    await expect(
      executePsqlQuery(
        makeOptions({ query: "DELETE FROM users", spawnProcess: spawnProcess as never }),
      ),
    ).rejects.toThrow(
      "The psql extension only allows read-only queries and psql inspection meta-commands",
    );

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("spawns psql with the injected connection env and streams partial updates", async () => {
    const child = new FakePsqlProcess();
    const spawnProcess = vi.fn(() => child);
    const updates: string[] = [];

    const promise = executePsqlQuery(
      makeOptions({
        format: "csv",
        spawnProcess: spawnProcess as never,
        onUpdate: (update) => {
          updates.push(update.content?.[0]?.text ?? "");
        },
      }),
    );

    child.emitStdout("id,name");
    child.emitStderr("NOTICE: streamed");
    child.close(0);

    const result = await promise;

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/custom/bin/psql",
      [
        config.injectEnv.NEON_TUNNEL_DATABASE_URL,
        "-v",
        "ON_ERROR_STOP=1",
        "-P",
        "pager=off",
        "--csv",
        "-c",
        "SELECT 1",
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          NEON_TUNNEL_DATABASE_URL: config.injectEnv.NEON_TUNNEL_DATABASE_URL,
          PGPASSWORD: source.password,
          PGAPPNAME: "pi-extension-psql",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(updates).toEqual(["id,name", "id,name\nNOTICE: streamed"]);
    expect(result.text).toBe("id,name\nNOTICE: streamed");
    expect(result.details.streaming).toBe(false);
    expect(result.details.outputPreview).toBe("id,name\nNOTICE: streamed");
    expect(result.details.tunnelPort).toBe(state.port);
  });

  it("uses tsv flags when requested", async () => {
    const child = new FakePsqlProcess();
    const spawnProcess = vi.fn(() => child);

    const promise = executePsqlQuery(
      makeOptions({ format: "tsv", spawnProcess: spawnProcess as never }),
    );

    child.emitStdout("1\tAlice");
    child.close(0);
    await promise;

    expect(spawnProcess).toHaveBeenCalledWith(
      "/custom/bin/psql",
      [
        config.injectEnv.NEON_TUNNEL_DATABASE_URL,
        "-v",
        "ON_ERROR_STOP=1",
        "-P",
        "pager=off",
        "-A",
        "-F",
        "\t",
        "-c",
        "SELECT 1",
      ],
      expect.any(Object),
    );
  });

  it("throws combined output when psql exits non-zero", async () => {
    const child = new FakePsqlProcess();

    const promise = executePsqlQuery(makeOptions({ spawnProcess: vi.fn(() => child) as never }));

    child.emitStdout("partial rows");
    child.emitStderr("ERROR: syntax error at or near FROM");
    child.close(1);

    await expect(promise).rejects.toThrow("partial rows\nERROR: syntax error at or near FROM");
  });

  it("writes the full output to disk when the rendered output is truncated", async () => {
    const child = new FakePsqlProcess();
    const truncateOutput = vi.fn(() => ({
      content: "row 1\nrow 2",
      truncated: true,
      outputLines: 2,
      totalLines: 10,
      outputBytes: 20,
      totalBytes: 100,
    }));
    const writeFullOutput = vi.fn(async () => "/tmp/pi-psql-full.txt");
    const formatBytes = vi.fn((bytes: number) => `${bytes}B`);

    const promise = executePsqlQuery(
      makeOptions({
        spawnProcess: vi.fn(() => child) as never,
        truncateOutput,
        writeFullOutput,
        formatBytes,
      }),
    );

    child.emitStdout("lots of rows...");
    child.close(0);

    const result = await promise;

    expect(truncateOutput).toHaveBeenCalledWith("lots of rows...", {
      maxLines: expect.any(Number),
      maxBytes: expect.any(Number),
    });
    expect(writeFullOutput).toHaveBeenCalledWith("lots of rows...");
    expect(result.details.fullOutputPath).toBe("/tmp/pi-psql-full.txt");
    expect(result.text).toContain(
      "[Output truncated: showing 2 of 10 lines (20B of 100B). Full output saved to: /tmp/pi-psql-full.txt]",
    );
  });

  it("kills the child process and surfaces an abort error", async () => {
    const child = new FakePsqlProcess();
    const controller = new AbortController();

    const promise = executePsqlQuery(
      makeOptions({ signal: controller.signal, spawnProcess: vi.fn(() => child) as never }),
    );

    controller.abort();

    await expect(promise).rejects.toThrow("psql query aborted");
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("surfaces spawn errors directly", async () => {
    const child = new FakePsqlProcess();

    const promise = executePsqlQuery(makeOptions({ spawnProcess: vi.fn(() => child) as never }));

    child.fail(new Error("spawn failed"));

    await expect(promise).rejects.toThrow("spawn failed");
  });
});
