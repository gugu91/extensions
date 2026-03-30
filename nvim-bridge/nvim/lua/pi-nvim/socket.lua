local M = {}

local uv = vim.loop or vim.uv

local pipe = nil
local connected = false
local cached_socket_path = nil
local reconnect_timer = nil
local backoff = 1 -- seconds, doubles up to max_backoff
local max_backoff = 10
local should_reconnect = true
local request_seq = 0
local pending_requests = {}
local listeners = {}

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

local function emit(event, payload)
  local callbacks = listeners[event]
  if not callbacks then
    return
  end

  for _, callback in ipairs(callbacks) do
    local ok, err = pcall(callback, payload)
    if not ok then
      vim.notify('pi-nvim: socket listener failed: ' .. tostring(err), vim.log.levels.ERROR)
    end
  end
end

--- Subscribe to socket-level events.
--- Returns an unsubscribe function.
function M.on(event, callback)
  if type(event) ~= 'string' or type(callback) ~= 'function' then
    return function() end
  end

  if not listeners[event] then
    listeners[event] = {}
  end
  table.insert(listeners[event], callback)

  local unsubscribed = false
  return function()
    if unsubscribed then
      return
    end
    unsubscribed = true

    local callbacks = listeners[event]
    if not callbacks then
      return
    end

    for i, fn in ipairs(callbacks) do
      if fn == callback then
        table.remove(callbacks, i)
        break
      end
    end

    if #callbacks == 0 then
      listeners[event] = nil
    end
  end
end

--- Cancel any pending reconnect timer.
local function cancel_reconnect()
  if reconnect_timer then
    reconnect_timer:stop()
    reconnect_timer:close()
    reconnect_timer = nil
  end
end

local function reject_all_pending_requests(reason)
  for id, callback in pairs(pending_requests) do
    pending_requests[id] = nil
    pcall(callback, {
      code = reason,
      message = reason,
    })
  end
end

--- Schedule a reconnect with exponential backoff.
local function schedule_reconnect()
  if not should_reconnect then
    return
  end

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
--- @param opts table|nil opts.no_reconnect=true disables auto reconnect
function M.disconnect(opts)
  cancel_reconnect()

  if opts and opts.no_reconnect then
    should_reconnect = false
  end

  if connected then
    emit('disconnected', nil)
  end

  connected = false

  if pipe then
    if not pipe:is_closing() then
      pipe:close()
    end
    pipe = nil
  end

  reject_all_pending_requests('disconnected')
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

--- Send an RPC request and wait for response.
--- Returns result, err
function M.request(request_type, payload, opts)
  if not connected then
    return nil, {
      code = 'not_connected',
      message = 'not connected to pi',
    }
  end

  request_seq = request_seq + 1
  local request_id = string.format('nvim-%d-%d', os.time(), request_seq)

  local done = false
  local result = nil
  local err = nil

  pending_requests[request_id] = function(response_err, response_result)
    err = response_err
    result = response_result
    done = true
  end

  local sent = M.send({
    id = request_id,
    type = request_type,
    payload = payload,
  })

  if not sent then
    pending_requests[request_id] = nil
    return nil, {
      code = 'send_failed',
      message = 'failed to send request',
    }
  end

  local timeout_ms = (opts and opts.timeout_ms) or 5000
  local completed = vim.wait(timeout_ms, function()
    return done
  end, 10)

  if not completed then
    pending_requests[request_id] = nil
    return nil,
      {
        code = 'timeout',
        message = string.format('request timed out after %dms', timeout_ms),
      }
  end

  if err then
    return nil, err
  end

  return result, nil
end

local function handle_server_message(msg)
  if type(msg) ~= 'table' then
    return
  end

  if msg.type == 'ok' and type(msg.id) == 'string' then
    local callback = pending_requests[msg.id]
    if callback then
      pending_requests[msg.id] = nil
      callback(nil, msg.result)
    end
    return
  end

  if msg.type == 'error' and type(msg.id) == 'string' then
    local callback = pending_requests[msg.id]
    if callback then
      pending_requests[msg.id] = nil
      callback(msg.error or { code = 'request_error', message = 'request_error' }, nil)
    end
    return
  end

  if msg.type == 'open_file' and msg.file then
    M.handle_command(msg)
    return
  end

  if type(msg.type) == 'string' then
    emit(msg.type, msg.payload)
  else
    emit('message', msg)
  end
end

--- Connect to the Unix socket.
function M.connect()
  should_reconnect = true

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
      emit('connected', nil)
    end)

    -- Handle incoming commands from pi
    local read_buffer = ''
    pipe:read_start(function(read_err, data)
      if read_err or not data then
        -- Server closed connection
        vim.schedule(function()
          M.disconnect()
          schedule_reconnect()
        end)
        return
      end

      read_buffer = read_buffer .. data
      local lines = vim.split(read_buffer, '\n', { plain = true })
      -- Keep the last incomplete line in buffer
      read_buffer = table.remove(lines) or ''

      for _, line in ipairs(lines) do
        if line ~= '' then
          vim.schedule(function()
            local ok, msg = pcall(vim.fn.json_decode, line)
            if ok and msg then
              handle_server_message(msg)
            end
          end)
        end
      end
    end)
  end)
end

--- Handle a command from pi.
function M.handle_command(cmd)
  if cmd.type == 'open_file' and cmd.file then
    local filepath = cmd.file
    -- Resolve relative paths against cwd
    if not vim.startswith(filepath, '/') then
      filepath = vim.fn.getcwd() .. '/' .. filepath
    end

    vim.cmd('edit ' .. vim.fn.fnameescape(filepath))

    if cmd.line then
      local line = tonumber(cmd.line)
      if line then
        vim.api.nvim_win_set_cursor(0, { line, 0 })
        vim.cmd('normal! zz')
      end
    end
  end
end

--- Check if currently connected.
function M.is_connected()
  return connected
end

return M
