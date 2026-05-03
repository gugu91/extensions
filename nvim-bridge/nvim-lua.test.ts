import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasNvim(): boolean {
  const result = spawnSync("nvim", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

describe("pi-nvim Lua integration", () => {
  it.skipIf(!hasNvim())("starts on Markdown files without registering PiComms commands", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-nvim-disabled-"));
    const markdownPath = path.join(dir, "short.md");
    writeFileSync(markdownPath, "# Short\n", "utf8");

    const pluginRoot = path.join(__dirname, "nvim");
    const fakeSocket = [
      "package.loaded['pi-nvim.socket'] = {",
      "connect = function() end,",
      "disconnect = function() end,",
      "invalidate_cache = function() end,",
      "send = function() return true end,",
      "is_connected = function() return true end,",
      "}",
    ].join(" ");

    try {
      const result = spawnSync(
        "nvim",
        [
          "--headless",
          "--clean",
          "-n",
          markdownPath,
          `+set rtp^=${pluginRoot}`,
          `+lua ${fakeSocket}`,
          "+lua require('pi-nvim').setup()",
          "+lua assert(vim.fn.exists(':PiCommsOpen') == 0)",
          "+lua assert(vim.fn.exists(':PiCommsAdd') == 0)",
          "+lua assert(vim.fn.exists(':PiCommsRead') == 0)",
          "+lua assert(vim.fn.exists(':PiCommsClean') == 0)",
          "+qa",
        ],
        { encoding: "utf8" },
      );

      expect(result.stderr).not.toContain("Invalid 'line': out of range");
      expect(result.stderr).not.toContain("Error");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
