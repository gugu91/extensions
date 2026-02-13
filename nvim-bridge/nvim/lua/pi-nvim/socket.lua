local M = {}

local uv = vim.loop or vim.uv

local pipe = nil
local connected = false
local cached_socket_path = nil
local reconnect_timer = nil
local backoff = 1 -- seconds, doubles up to max_backoff
local max_backoff = 10

--- Compute the socket path from git repo root + branch.
--- Returns nil if not in a git repo.
local function compute_socket_path()
  local repo_root = vim.fn.systemlist('git rev-parse --show-toplevel 2>/dev/null')[1]
  if vim.v.shell_error ~= 0 or not repo_root then
    return nil
  end

  local branch = vim.fn.systemlist('git branch --show-current 2>/dev/null')[1]
  if vim.v.shell_error ~= 0 or not branch then
    branch = ''
  end

  local key = repo_root .. ':' .. branch
  local hash = vim.fn.sha256(key)
  return '/tmp/pi-nvim/' .. hash .. '.sock'
end

--- Get socket path (cached).
local function get_socket_path()
  if not cached_socket_path then
    cached_socket_path = compute_socket_path()
  end
  return cached_socket_path
end

--- Invalidate cached git info (called on DirChanged / FocusGained).
function M.invalidate_cache()
  cached_socket_path = nil
end

--- Cancel any pending reconnect timer.
local function cancel_reconnect()
  if reconnect_timer then
    reconnect_timer:stop()
    reconnect_timer:close()
    reconnect_timer = nil
  end
end

--- Schedule a reconnect with exponential backoff.
local function schedule_reconnect()
  cancel_reconnect()

  reconnect_timer = uv.new_timer()
  local delay_ms = backoff * 1000

  reconnect_timer:start(
    delay_ms,
    0,
    vim.schedule_wrap(function()
      cancel_reconnect()
      M.connect()
    end)
  )

  -- Exponential backoff, capped
  backoff = math.min(backoff * 2, max_backoff)
end

--- Disconnect and clean up pipe.
function M.disconnect()
  cancel_reconnect()
  connected = false
  if pipe then
    if not pipe:is_closing() then
      pipe:close()
    end
    pipe = nil
  end
end

--- Send a newline-delimited JSON message.
function M.send(data)
  if not connected or not pipe then
    return false
  end

  local ok, encoded = pcall(vim.fn.json_encode, data)
  if not ok then
    return false
  end

  local success = pcall(function()
    pipe:write(encoded .. '\n')
  end)

  return success
end

--- Connect to the Unix socket.
function M.connect()
  -- Disconnect existing connection first
  if pipe then
    M.disconnect()
  end

  local sock_path = get_socket_path()
  if not sock_path then
    return
  end

  pipe = uv.new_pipe(false)

  pipe:connect(sock_path, function(err)
    if err then
      -- Connection failed, schedule reconnect
      if pipe and not pipe:is_closing() then
        pipe:close()
      end
      pipe = nil
      connected = false
      schedule_reconnect()
      return
    end

    -- Connection succeeded
    vim.schedule(function()
      connected = true
      backoff = 1 -- reset backoff on success
    end)

    -- Handle disconnect
    pipe:read_start(function(read_err, data)
      if read_err or not data then
        -- Server closed connection
        vim.schedule(function()
          M.disconnect()
          schedule_reconnect()
        end)
      end
    end)
  end)
end

--- Check if currently connected.
function M.is_connected()
  return connected
end

return M
