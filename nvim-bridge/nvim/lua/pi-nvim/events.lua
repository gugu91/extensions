local socket = require("pi-nvim.socket")

local M = {}

-- Debounce timers per event type
local timers = {}

--- Debounce a function call.
--- @param key string Event type key for the timer
--- @param delay_ms number Debounce delay in milliseconds
--- @param fn function Function to call after debounce
local function debounce(key, delay_ms, fn)
  -- Cancel existing timer for this key
  if timers[key] then
    timers[key]:stop()
    timers[key]:close()
    timers[key] = nil
  end

  local uv = vim.loop or vim.uv
  local timer = uv.new_timer()
  timers[key] = timer

  timer:start(delay_ms, 0, vim.schedule_wrap(function()
    if timers[key] == timer then
      timers[key] = nil
    end
    timer:stop()
    timer:close()
    fn()
  end))
end

local function trim(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

--- Get the file path relative to the git repo root.
--- Returns nil for non-file buffers.
local function get_relative_path()
  local bufpath = vim.api.nvim_buf_get_name(0)
  if bufpath == "" then
    return nil
  end

  -- Skip non-file buffers
  local buftype = vim.bo.buftype
  if buftype ~= "" then
    return nil
  end

  -- Make path relative to cwd (which should be repo root)
  local cwd = vim.fn.getcwd()
  if vim.startswith(bufpath, cwd .. "/") then
    return bufpath:sub(#cwd + 2)
  end

  return bufpath
end

local function normalize_range(start_line, end_line)
  local current = vim.api.nvim_win_get_cursor(0)[1]
  start_line = tonumber(start_line) or current
  end_line = tonumber(end_line) or start_line

  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  return start_line, end_line
end

--- Open a floating window to capture a comment for a selected range.
function M.open_comment_window(start_line, end_line)
  local file = get_relative_path()
  if not file then
    vim.notify("pi-nvim: current buffer is not a file", vim.log.levels.WARN)
    return
  end

  start_line, end_line = normalize_range(start_line, end_line)

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = "markdown"

  -- Side panel: dock to the right side of the editor.
  local width = math.max(36, math.min(72, math.floor(vim.o.columns * 0.35)))
  local height = math.max(8, vim.o.lines - 6)
  local row = 1
  local col = math.max(0, vim.o.columns - width - 2)

  local title = string.format(" Pi comment %s:%d-%d ", file, start_line, end_line)

  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    style = "minimal",
    border = "rounded",
    width = width,
    height = height,
    row = row,
    col = col,
    title = title,
    title_pos = "center",
  })

  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "" })

  local function close_window()
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
  end

  local function submit()
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    local comment = trim(table.concat(lines, "\n"))

    if comment == "" then
      vim.notify("pi-nvim: empty comment discarded", vim.log.levels.WARN)
      close_window()
      return
    end

    local sent = socket.send({
      type = "selection_comment",
      file = file,
      start = start_line,
      ["end"] = end_line,
      comment = comment,
    })

    if sent then
      vim.notify("pi-nvim: comment sent", vim.log.levels.INFO)
    else
      vim.notify("pi-nvim: not connected to pi", vim.log.levels.WARN)
    end

    close_window()
  end

  local function newline()
    local keys = vim.api.nvim_replace_termcodes("<CR>", true, false, true)
    vim.api.nvim_feedkeys(keys, "in", false)
  end

  local map_opts = { buffer = buf, nowait = true, silent = true }
  -- Enter sends the comment
  vim.keymap.set("n", "<CR>", submit, map_opts)
  vim.keymap.set("i", "<CR>", submit, map_opts)

  -- Shift-Enter inserts a new line (terminal support may vary)
  vim.keymap.set("i", "<S-CR>", newline, map_opts)
  -- Reliable fallback for newline
  vim.keymap.set("i", "<C-j>", newline, map_opts)

  vim.keymap.set("n", "<Esc>", close_window, map_opts)
  vim.keymap.set("i", "<Esc>", close_window, map_opts)

  vim.notify("pi-nvim: Enter=send • Shift-Enter/C-j=new line • Esc=cancel", vim.log.levels.INFO)
  vim.cmd("startinsert")
end

--- BufEnter: send buffer_focus (no debounce).
function M.on_buf_enter()
  local file = get_relative_path()
  if not file then return end

  local line = vim.api.nvim_win_get_cursor(0)[1]

  socket.send({
    type = "buffer_focus",
    file = file,
    line = line,
  })
end

--- WinScrolled: send visible_range (debounced 150ms).
function M.on_win_scrolled()
  debounce("visible_range", 150, function()
    local file = get_relative_path()
    if not file then return end

    local win = vim.api.nvim_get_current_win()
    local start_line = vim.fn.line("w0", win)
    local end_line = vim.fn.line("w$", win)

    socket.send({
      type = "visible_range",
      file = file,
      start = start_line,
      ["end"] = end_line,
    })
  end)
end

--- CursorMoved: send selection if in visual mode (debounced 150ms).
function M.on_cursor_moved()
  local mode = vim.fn.mode()
  -- Visual modes: v, V, CTRL-V (^V)
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then
    return
  end

  debounce("selection", 150, function()
    local file = get_relative_path()
    if not file then return end

    -- Get visual selection range
    local start_line = vim.fn.line("v")
    local end_line = vim.fn.line(".")

    -- Normalize order
    if start_line > end_line then
      start_line, end_line = end_line, start_line
    end

    socket.send({
      type = "selection",
      file = file,
      start = start_line,
      ["end"] = end_line,
    })
  end)
end

return M
