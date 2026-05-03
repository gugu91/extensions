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
  it.skipIf(!hasNvim())(
    "ignores stale PiComms indicators past the end of a Markdown buffer",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "pi-nvim-md-"));
      const markdownPath = path.join(dir, "short.md");
      writeFileSync(markdownPath, "# Short\n", "utf8");

      const pluginRoot = path.join(__dirname, "nvim");
      const fakeSocket =
        "package.loaded['pi-nvim.socket'] = { " +
        "request = function() return { comments = { { context = { " +
        "file = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':.'), " +
        "startLine = 99, endLine = 99 " +
        "} } } }, nil end, " +
        "on = function() return function() end end " +
        "}";

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
            "+lua require('pi-nvim.comments').setup()",
            "+sleep 300m",
            "+qa",
          ],
          { encoding: "utf8" },
        );

        expect(result.stderr).not.toContain("Invalid 'line': out of range");
        expect(result.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
