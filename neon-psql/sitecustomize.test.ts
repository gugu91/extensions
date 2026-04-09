import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SHIM_DIR = path.join(TEST_DIR, "python");

function resolvePythonBin(): string | null {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["-V"], { encoding: "utf8" });
    if (result.status === 0) {
      return candidate;
    }
  }
  return null;
}

const PYTHON_BIN = resolvePythonBin();
const describeWithPython = PYTHON_BIN ? describe : describe.skip;

const PYTHON_DRIVER = [
  "import asyncio, json, os, asyncpg",
  "spec = json.loads(os.environ['CALL_SPEC'])",
  "async def main():",
  "    method = getattr(asyncpg, spec.get('method', 'connect'))",
  "    await method(*spec.get('args', []), **spec.get('kwargs', {}))",
  "asyncio.run(main())",
].join("\n");

const FAKE_ASYNCPG_MODULE = [
  "import json, os",
  "async def connect(*args, **kwargs):",
  "    with open(os.environ['OUTFILE'], 'w', encoding='utf-8') as handle:",
  "        json.dump({'args': list(args), 'kwargs': kwargs}, handle)",
  "    return {'args': list(args), 'kwargs': kwargs}",
  "async def create_pool(*args, **kwargs):",
  "    return await connect(*args, **kwargs)",
].join("\n");

type AsyncpgCallSpec = {
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  method?: "connect" | "create_pool";
};

function runPatchedAsyncpg(spec: AsyncpgCallSpec): {
  args: unknown[];
  kwargs: Record<string, unknown>;
} {
  if (!PYTHON_BIN) {
    throw new Error("python is required for neon-psql sitecustomize tests");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "neon-sitecustomize-test-"));
  const outputPath = path.join(tmpDir, "call.json");
  fs.writeFileSync(path.join(tmpDir, "asyncpg.py"), FAKE_ASYNCPG_MODULE, "utf8");

  try {
    execFileSync(PYTHON_BIN, ["-c", PYTHON_DRIVER], {
      encoding: "utf8",
      env: {
        ...process.env,
        OUTFILE: outputPath,
        CALL_SPEC: JSON.stringify(spec),
        PYTHONPATH: [PYTHON_SHIM_DIR, tmpDir].join(path.delimiter),
        NEON_TUNNEL_ACTIVE: "1",
        NEON_TUNNEL_PORT: "6543",
        NEON_TUNNEL_ENDPOINT: "ep-cool-river",
        NEON_TUNNEL_SSL_MODE: "require",
      },
    });

    return JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
      args: unknown[];
      kwargs: Record<string, unknown>;
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describeWithPython("neon-psql python sitecustomize shim", () => {
  it("patches asyncpg kwargs when the connection targets the exact local tunnel port", () => {
    const result = runPatchedAsyncpg({
      kwargs: {
        host: "127.0.0.1",
        port: 6543,
        user: "user",
        password: "secret",
        database: "app",
      },
    });

    expect(result.kwargs.server_settings).toEqual({ options: "endpoint=ep-cool-river" });
    expect(result.kwargs.ssl).toBe("require");
  });

  it("patches asyncpg DSNs when they target the exact local tunnel port", () => {
    const result = runPatchedAsyncpg({
      args: ["postgresql://user:secret@127.0.0.1:6543/app"],
    });

    expect(result.kwargs.server_settings).toEqual({ options: "endpoint=ep-cool-river" });
    expect(result.kwargs.ssl).toBe("require");
  });

  it("does not patch unrelated localhost kwargs on a different port", () => {
    const result = runPatchedAsyncpg({
      kwargs: {
        host: "127.0.0.1",
        port: 5432,
        user: "user",
        password: "secret",
        database: "app",
      },
    });

    expect(result.kwargs.server_settings).toBeUndefined();
    expect(result.kwargs.ssl).toBeUndefined();
  });

  it("does not patch unrelated localhost DSNs on a different port", () => {
    const result = runPatchedAsyncpg({
      args: ["postgresql://user:secret@127.0.0.1:5432/app"],
    });

    expect(result.kwargs.server_settings).toBeUndefined();
    expect(result.kwargs.ssl).toBeUndefined();
  });
});
