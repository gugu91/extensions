import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasNvim(): boolean {
  const result = spawnSync("nvim", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

describe("pi-nvim Lua integration", () => {
  it.skipIf(!hasNvim())(
    "starts on Markdown files with Pinet commands and no PiComms surface",
    () => {
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
        "on = function() return function() end end,",
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
            "+runtime plugin/pi-nvim.lua",
            `+lua ${fakeSocket}`,
            "+lua require('pi-nvim').setup()",
            "+lua for _, name in ipairs({ 'PiCommsOpen', 'PiCommsAdd', 'PiCommsRead', 'PiCommsClean' }) do assert(vim.fn.exists(':' .. name) == 0) end; for _, name in ipairs({ 'PinetComment', 'PinetThreads', 'PinetReply' }) do assert(vim.fn.exists(':' .. name) == 2) end",
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
    },
  );

  it.skipIf(!hasNvim())("uses canonical worktree paths from a subdirectory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-nvim-paths-"));
    const appPath = path.join(dir, "src", "app.ts");
    const subdir = path.join(dir, "sub");
    const scriptPath = path.join(dir, "test.lua");
    mkdirSync(path.dirname(appPath), { recursive: true });
    mkdirSync(subdir);
    writeFileSync(appPath, "export const value = 1;\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const pluginRoot = path.join(__dirname, "nvim");
    writeFileSync(
      scriptPath,
      [
        `vim.cmd('cd ' .. vim.fn.fnameescape(${JSON.stringify(subdir)}))`,
        `require('pi-nvim.socket').handle_command({ type = 'open_file', file = 'src/app.ts' })`,
        `assert((vim.uv or vim.loop).fs_realpath(vim.api.nvim_buf_get_name(0)) == require('pi-nvim.paths').worktree_root() .. '/src/app.ts')`,
        `_G.pinet_sent = nil`,
        `package.loaded['pi-nvim.socket'] = { send = function(message) _G.pinet_sent = message end }`,
        `package.loaded['pi-nvim.events'] = nil`,
        `require('pi-nvim.events').on_buf_enter()`,
        `assert(_G.pinet_sent.file == 'src/app.ts')`,
        `vim.cmd('qa!')`,
      ].join("\n"),
      "utf8",
    );

    try {
      const result = spawnSync(
        "nvim",
        ["--headless", "--clean", "-n", "--cmd", `set rtp^=${pluginRoot}`, "-l", scriptPath],
        { cwd: subdir, encoding: "utf8" },
      );
      expect(`${result.stdout}${result.stderr}`).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasNvim())("restores resolved signs after reconnect", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-nvim-restore-"));
    const scriptPath = path.join(dir, "test.lua");
    const pluginRoot = path.join(__dirname, "nvim");
    writeFileSync(
      scriptPath,
      [
        `_G.pinet_refresh_opts = nil`,
        `package.loaded['pi-nvim.comments'] = { refresh = function(opts) _G.pinet_refresh_opts = opts end }`,
        `package.loaded['pi-nvim.events'] = { on_buf_enter = function() end, on_win_scrolled = function() end, on_cursor_moved = function() end }`,
        `package.loaded['pi-nvim.socket'] = {`,
        `  connect = function() end, disconnect = function() end, invalidate_cache = function() end,`,
        `  is_connected = function() return true end,`,
        `  on = function(event, callback) if event == 'connected' then callback() end; return function() end end,`,
        `}`,
        `vim.cmd('diffthis')`,
        `require('pi-nvim').setup()`,
        `assert(_G.pinet_refresh_opts.include_resolved == true)`,
        `vim.cmd('qa!')`,
      ].join("\n"),
      "utf8",
    );

    try {
      const result = spawnSync(
        "nvim",
        ["--headless", "--clean", "-n", "--cmd", `set rtp^=${pluginRoot}`, "-l", scriptPath],
        { encoding: "utf8" },
      );
      expect(`${result.stdout}${result.stderr}`).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasNvim())("anchors an external native-diff buffer as the old side", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-nvim-native-diff-"));
    const repoPath = path.join(dir, "repo");
    const appPath = path.join(repoPath, "src", "app.ts");
    const oldPath = path.join(dir, "old-app.ts");
    const scriptPath = path.join(dir, "test.lua");
    mkdirSync(path.dirname(appPath), { recursive: true });
    writeFileSync(appPath, "export const value = 2;\n", "utf8");
    writeFileSync(oldPath, "export const value = 1;\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
    execFileSync("git", ["add", "src/app.ts"], { cwd: repoPath });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: repoPath });
    const oldBlob = execFileSync("git", ["hash-object", oldPath], {
      cwd: repoPath,
      encoding: "utf8",
    }).trim();

    const pluginRoot = path.join(__dirname, "nvim");
    writeFileSync(
      scriptPath,
      [
        `_G.pinet_request = nil`,
        `package.loaded['pi-nvim.socket'] = {`,
        `  request = function(kind, payload) _G.pinet_request = { kind = kind, payload = payload }; return { threads = {} }, nil end,`,
        `  on = function() return function() end end,`,
        `}`,
        `vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(appPath)}))`,
        `vim.cmd('diffthis')`,
        `vim.cmd('vsplit ' .. vim.fn.fnameescape(${JSON.stringify(oldPath)}))`,
        `vim.cmd('diffthis')`,
        `require('pi-nvim.comments').refresh({ include_resolved = true })`,
        `assert(_G.pinet_request.kind == 'pinet.thread.list')`,
        `assert(_G.pinet_request.payload.anchor.path == 'src/app.ts')`,
        `assert(_G.pinet_request.payload.anchor.side == 'old')`,
        `assert(_G.pinet_request.payload.anchor.blobOid == ${JSON.stringify(oldBlob)})`,
        `vim.cmd('qa!')`,
      ].join("\n"),
      "utf8",
    );

    try {
      const result = spawnSync(
        "nvim",
        ["--headless", "--clean", "-n", "--cmd", `set rtp^=${pluginRoot}`, "-l", scriptPath],
        { cwd: repoPath, encoding: "utf8" },
      );
      expect(`${result.stdout}${result.stderr}`).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
