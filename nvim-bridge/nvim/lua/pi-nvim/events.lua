local socket = require('pi-nvim.socket')

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

  timer:start(
    delay_ms,
    0,
    vim.schedule_wrap(function()
      if timers[key] == timer then
        timers[key] = nil
      end
      timer:stop()
      timer:close()
      fn()
    end)
  )
end

--- Get the file path relative to the git repo root.
--- Returns nil for non-file buffers.
local function get_relative_path()
  local bufpath = vim.api.nvim_buf_get_name(0)
  if bufpath == '' then
    return nil
  end

  -- Skip non-file buffers
  local buftype = vim.bo.buftype
  if buftype ~= '' then
    return nil
  end

  -- Make path relative to cwd (which should be repo root)
  local cwd = vim.fn.getcwd()
  if vim.startswith(bufpath, cwd .. '/') then
    return bufpath:sub(#cwd + 2)
  end

  return bufpath
end

--- BufEnter: send buffer_focus (no debounce).
function M.on_buf_enter()
  local file = get_relative_path()
  if not file then
    return
  end

  local line = vim.api.nvim_win_get_cursor(0)[1]

  socket.send({
    type = 'buffer_focus',
    file = file,
    line = line,
  })
end

--- WinScrolled: send visible_range (debounced 150ms).
function M.on_win_scrolled()
  debounce('visible_range', 150, function()
    local file = get_relative_path()
    if not file then
      return
    end

    local win = vim.api.nvim_get_current_win()
    local start_line = vim.fn.line('w0', win)
    local end_line = vim.fn.line('w$', win)

    socket.send({
      type = 'visible_range',
      file = file,
      start = start_line,
      ['end'] = end_line,
    })
  end)
end

--- CursorMoved: send selection if in visual mode (debounced 150ms).
function M.on_cursor_moved()
  local mode = vim.fn.mode()
  -- Visual modes: v, V, CTRL-V (^V)
  if mode ~= 'v' and mode ~= 'V' and mode ~= '\22' then
    return
  end

  debounce('selection', 150, function()
    local file = get_relative_path()
    if not file then
      return
    end

    -- Get visual selection range
    local start_line = vim.fn.line('v')
    local end_line = vim.fn.line('.')

    -- Normalize order
    if start_line > end_line then
      start_line, end_line = end_line, start_line
    end

    socket.send({
      type = 'selection',
      file = file,
      start = start_line,
      ['end'] = end_line,
    })
  end)
end

return M
