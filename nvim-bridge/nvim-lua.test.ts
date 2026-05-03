import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasNvim(): boolean {
  const result = spawnSync("nvim", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function runNvimWithFakeSocket(commands: string[]): SpawnSyncReturns<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-nvim-pinet-"));
  const markdownPath = path.join(dir, "note.md");
  writeFileSync(markdownPath, "# Note\n\nBody\n", "utf8");

  const pluginRoot = path.join(__dirname, "nvim");
  const fakeSocket = [
    "_G.pi_nvim_last_payload = nil",
    "package.loaded['pi-nvim.socket'] = {",
    "connect = function() end,",
    "disconnect = function() end,",
    "invalidate_cache = function() end,",
    "is_connected = function() return true end,",
    "send = function(payload) _G.pi_nvim_last_payload = payload return true end,",
    "}",
  ].join(" ");

  try {
    return spawnSync(
      "nvim",
      [
        "--headless",
        "--clean",
        "-n",
        markdownPath,
        `+set rtp^=${pluginRoot}`,
        `+lua ${fakeSocket}`,
        "+lua require('pi-nvim').setup()",
        ...commands,
        "+qa",
      ],
      { cwd: dir, encoding: "utf8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pi-nvim Lua integration", () => {
  it.skipIf(!hasNvim())("sends current Markdown context through :PinetAsk", () => {
    const result = runNvimWithFakeSocket([
      "+2PinetAsk please coordinate this with the team",
      "+lua assert(_G.pi_nvim_last_payload.type == 'trigger_agent'); assert(string.find(_G.pi_nvim_last_payload.prompt, 'Neovim Pinet request', 1, true)); assert(string.find(_G.pi_nvim_last_payload.prompt, 'note.md:2', 1, true)); assert(string.find(_G.pi_nvim_last_payload.prompt, 'please coordinate this with the team', 1, true))",
    ]);

    expect(result.stderr).not.toContain("Error");
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasNvim())("sends a Pinet read prompt and leaves PiComms commands absent", () => {
    const result = runNvimWithFakeSocket([
      "+PinetRead",
      "+lua assert(_G.pi_nvim_last_payload.type == 'trigger_agent'); assert(string.find(_G.pi_nvim_last_payload.prompt, 'pending work or follow-up', 1, true)); assert(string.find(_G.pi_nvim_last_payload.prompt, 'note.md:1', 1, true)); assert(vim.fn.exists(':PiCommsOpen') == 0); assert(vim.fn.exists(':PiCommsAdd') == 0); assert(vim.fn.exists(':PiCommsRead') == 0); assert(vim.fn.exists(':PiCommsClean') == 0)",
    ]);

    expect(result.stderr).not.toContain("Error");
    expect(result.status).toBe(0);
  });
});
