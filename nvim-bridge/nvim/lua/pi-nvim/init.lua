local socket = require("pi-nvim.socket")
local events = require("pi-nvim.events")

local M = {}

local enabled = false

function M.setup(opts)
  opts = vim.tbl_deep_extend("force", {
    comment_keymap = "<leader>pc",
  }, opts or {})
  enabled = true

  -- Connect socket on startup
  socket.connect()

  -- Command: add a free-form comment for a selected range.
  if vim.fn.exists(":PiNvimComment") == 0 then
    vim.api.nvim_create_user_command("PiNvimComment", function(cmd_opts)
      if not enabled then
        vim.notify("pi-nvim: bridge is disabled", vim.log.levels.WARN)
        return
      end
      events.open_comment_window(cmd_opts.line1, cmd_opts.line2)
    end, {
      desc = "Open a comment window for the selected range and send to pi",
      range = true,
    })
  end

  -- Optional shortcut (default: <leader>pc)
  if opts.comment_keymap and opts.comment_keymap ~= "" then
    local map_opts = { silent = true, desc = "pi-nvim: comment selected range" }
    vim.keymap.set("x", opts.comment_keymap, ":<C-u>'<,'>PiNvimComment<CR>", map_opts)
    vim.keymap.set("n", opts.comment_keymap, ":<C-u>.,.PiNvimComment<CR>", map_opts)
  end

  -- BufEnter: send buffer_focus (no debounce)
  vim.api.nvim_create_autocmd("BufEnter", {
    group = vim.api.nvim_create_augroup("PiNvimBufEnter", { clear = true }),
    callback = function()
      if not enabled then return end
      events.on_buf_enter()
    end,
  })

  -- WinScrolled: send visible_range (debounced)
  vim.api.nvim_create_autocmd("WinScrolled", {
    group = vim.api.nvim_create_augroup("PiNvimWinScrolled", { clear = true }),
    callback = function()
      if not enabled then return end
      events.on_win_scrolled()
    end,
  })

  -- CursorMoved: send selection in visual mode (debounced)
  vim.api.nvim_create_autocmd("CursorMoved", {
    group = vim.api.nvim_create_augroup("PiNvimCursorMoved", { clear = true }),
    callback = function()
      if not enabled then return end
      events.on_cursor_moved()
    end,
  })

  -- DirChanged / FocusGained: invalidate cached git info and reconnect
  vim.api.nvim_create_autocmd({ "DirChanged", "FocusGained" }, {
    group = vim.api.nvim_create_augroup("PiNvimDirChanged", { clear = true }),
    callback = function()
      if not enabled then return end
      socket.invalidate_cache()
      socket.connect()
    end,
  })

  -- Seed initial context, useful when plugin itself is lazy-loaded.
  events.on_buf_enter()
  events.on_win_scrolled()
end

function M.enable()
  enabled = true
  socket.connect()
end

function M.disable()
  enabled = false
  socket.disconnect()
end

function M.is_enabled()
  return enabled
end

return M
