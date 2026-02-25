local socket = require('pi-nvim.socket')

local M = {}

local setup_done = false
local active_thread = 'global'
local timeline_buf = nil
local refresh_pending = false

local function trim(text)
  return (text:gsub('^%s+', ''):gsub('%s+$', ''))
end

local function normalize_thread_id(thread_id)
  if type(thread_id) ~= 'string' then
    return active_thread
  end
  local trimmed = trim(thread_id)
  if trimmed == '' then
    return active_thread
  end
  return trimmed
end

local function get_relative_path()
  local bufpath = vim.api.nvim_buf_get_name(0)
  if bufpath == '' then
    return nil
  end

  local buftype = vim.bo.buftype
  if buftype ~= '' then
    return nil
  end

  local cwd = vim.fn.getcwd()
  if vim.startswith(bufpath, cwd .. '/') then
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

local function build_context(start_line, end_line)
  if start_line == nil or end_line == nil then
    return nil
  end

  local file = get_relative_path()
  if not file then
    return nil
  end

  start_line, end_line = normalize_range(start_line, end_line)
  return {
    file = file,
    startLine = start_line,
    endLine = end_line,
  }
end

local function thread_from_payload(payload)
  if type(payload) ~= 'table' then
    return nil
  end
  if type(payload.threadId) == 'string' then
    return payload.threadId
  end
  if type(payload.comment) == 'table' and type(payload.comment.threadId) == 'string' then
    return payload.comment.threadId
  end
  return nil
end

local function get_error_message(err)
  if type(err) == 'string' then
    return err
  end
  if type(err) == 'table' then
    if type(err.message) == 'string' and err.message ~= '' then
      return err.message
    end
    if type(err.code) == 'string' and err.code ~= '' then
      return err.code
    end
  end
  return 'unknown error'
end

local function format_context(context)
  if type(context) ~= 'table' or type(context.file) ~= 'string' then
    return nil
  end

  local start_line = tonumber(context.startLine)
  local end_line = tonumber(context.endLine)

  if start_line and end_line then
    return string.format('%s:%d-%d', context.file, start_line, end_line)
  end

  return context.file
end

local function configure_timeline_buffer(buf)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'markdown'
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true

  local ok = pcall(vim.api.nvim_buf_set_name, buf, string.format('pi://comments/%s', active_thread))
  if not ok then
    -- ignore duplicate-name errors
  end

  local map_opts = { buffer = buf, silent = true }
  vim.keymap.set('n', 'q', function()
    local wins = vim.fn.win_findbuf(buf)
    for _, win in ipairs(wins) do
      if vim.api.nvim_win_is_valid(win) then
        vim.api.nvim_win_close(win, true)
      end
    end
  end, vim.tbl_extend('force', map_opts, { desc = 'Close comments timeline' }))

  vim.keymap.set('n', 'r', function()
    M.refresh({ open_if_missing = false })
  end, vim.tbl_extend('force', map_opts, { desc = 'Refresh comments timeline' }))

  vim.keymap.set('n', 'a', function()
    M.open_composer({ thread_id = active_thread })
  end, vim.tbl_extend('force', map_opts, { desc = 'Add A2A comment' }))
end

local function ensure_timeline_buffer()
  if timeline_buf and vim.api.nvim_buf_is_valid(timeline_buf) then
    local wins = vim.fn.win_findbuf(timeline_buf)
    if #wins > 0 then
      vim.api.nvim_set_current_win(wins[1])
      return timeline_buf
    end

    vim.cmd('botright split')
    local win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(win, timeline_buf)
    return timeline_buf
  end

  vim.cmd('botright split')
  local win = vim.api.nvim_get_current_win()
  timeline_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_win_set_buf(win, timeline_buf)
  configure_timeline_buffer(timeline_buf)
  return timeline_buf
end

local function set_timeline_lines(lines)
  if not timeline_buf or not vim.api.nvim_buf_is_valid(timeline_buf) then
    return
  end

  vim.bo[timeline_buf].modifiable = true
  vim.bo[timeline_buf].readonly = false
  vim.api.nvim_buf_set_lines(timeline_buf, 0, -1, false, lines)
  vim.bo[timeline_buf].modifiable = false
  vim.bo[timeline_buf].readonly = true
  vim.bo[timeline_buf].modified = false
end

local function render_timeline(result)
  if not timeline_buf or not vim.api.nvim_buf_is_valid(timeline_buf) then
    return
  end

  local comments = type(result) == 'table' and type(result.comments) == 'table' and result.comments
    or {}
  local total = type(result) == 'table' and tonumber(result.total) or #comments

  local lines = {
    '# A2A Comments',
    string.format('thread: %s', active_thread),
    string.format('total: %d', total or 0),
    '',
  }

  if #comments == 0 then
    table.insert(lines, '_No comments yet_')
    set_timeline_lines(lines)
    return
  end

  for _, comment in ipairs(comments) do
    local created_at = type(comment.createdAt) == 'string' and comment.createdAt or 'unknown-time'
    local actor_type = type(comment.actorType) == 'string' and comment.actorType or 'unknown'
    local actor_id = type(comment.actorId) == 'string' and comment.actorId or 'unknown'
    local comment_id = type(comment.id) == 'string' and comment.id or 'unknown-id'

    table.insert(lines, string.rep('─', 72))
    table.insert(lines, string.format('[%s] %s:%s', created_at, actor_type, actor_id))
    table.insert(lines, string.format('id: %s', comment_id))

    local context = format_context(comment.context)
    if context then
      table.insert(lines, string.format('context: %s', context))
    end

    table.insert(lines, '')

    local body = type(comment.body) == 'string' and comment.body or ''
    if body == '' then
      table.insert(lines, '_(empty comment)_')
    else
      local body_lines = vim.split(body, '\n', { plain = true })
      for _, body_line in ipairs(body_lines) do
        table.insert(lines, body_line)
      end
    end

    table.insert(lines, '')
  end

  set_timeline_lines(lines)
end

local function request_comments(thread_id, timeout_ms)
  return socket.request('comment.list', {
    threadId = thread_id,
  }, {
    timeout_ms = timeout_ms or 8000,
  })
end

local function schedule_refresh_if_open(thread_id)
  if thread_id and thread_id ~= active_thread then
    return
  end

  if not timeline_buf or not vim.api.nvim_buf_is_valid(timeline_buf) then
    return
  end

  if refresh_pending then
    return
  end

  refresh_pending = true
  vim.defer_fn(function()
    refresh_pending = false
    M.refresh({
      open_if_missing = false,
      silent = true,
    })
  end, 120)
end

function M.setup()
  if setup_done then
    return
  end
  setup_done = true

  socket.on('comment.added', function(payload)
    schedule_refresh_if_open(thread_from_payload(payload))
  end)

  socket.on('comments.updated', function(payload)
    schedule_refresh_if_open(thread_from_payload(payload))
  end)

  socket.on('connected', function()
    schedule_refresh_if_open(active_thread)
  end)
end

function M.open(thread_id)
  active_thread = normalize_thread_id(thread_id)
  ensure_timeline_buffer()
  M.refresh({
    thread_id = active_thread,
    open_if_missing = false,
  })
end

function M.refresh(opts)
  opts = opts or {}

  if opts.thread_id then
    active_thread = normalize_thread_id(opts.thread_id)
  end

  local should_open = opts.open_if_missing == true
  if should_open then
    ensure_timeline_buffer()
  end

  if not timeline_buf or not vim.api.nvim_buf_is_valid(timeline_buf) then
    if not opts.silent then
      vim.notify('pi-nvim: comments timeline is not open', vim.log.levels.WARN)
    end
    return
  end

  local result, err = request_comments(active_thread, 8000)
  if not result then
    if not opts.silent then
      vim.notify(
        'pi-nvim: failed to load comments: ' .. get_error_message(err),
        vim.log.levels.WARN
      )
    end
    return
  end

  pcall(vim.api.nvim_buf_set_name, timeline_buf, string.format('pi://comments/%s', active_thread))
  render_timeline(result)
end

function M.open_composer(opts)
  opts = opts or {}

  if opts.thread_id then
    active_thread = normalize_thread_id(opts.thread_id)
  end

  local context = build_context(opts.start_line, opts.end_line)

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'markdown'

  local width = math.max(40, math.min(90, math.floor(vim.o.columns * 0.42)))
  local height = math.max(8, vim.o.lines - 8)
  local row = 1
  local col = math.max(0, vim.o.columns - width - 2)

  local title = string.format(' A2A comment [%s] ', active_thread)
  if context then
    title = string.format(' A2A comment [%s] %s ', active_thread, format_context(context))
  end

  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    style = 'minimal',
    border = 'rounded',
    width = width,
    height = height,
    row = row,
    col = col,
    title = title,
    title_pos = 'center',
  })

  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '' })

  local function close_window()
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
  end

  local function get_comment_text()
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    return trim(table.concat(lines, '\n'))
  end

  local function submit_comment()
    local comment = get_comment_text()
    if comment == '' then
      vim.notify('pi-nvim: empty comment discarded', vim.log.levels.WARN)
      close_window()
      return
    end

    local payload = {
      threadId = active_thread,
      body = comment,
      actorType = 'human',
      actorId = (vim.env.USER and vim.env.USER ~= '') and vim.env.USER or 'user',
      context = context,
    }

    local result, err = socket.request('comment.add', payload, { timeout_ms = 8000 })

    if not result then
      vim.notify('pi-nvim: failed to add comment: ' .. get_error_message(err), vim.log.levels.WARN)
      close_window()
      return
    end

    local comment_id = result.comment and result.comment.id
    if type(comment_id) == 'string' and comment_id ~= '' then
      vim.notify('pi-nvim: comment added (' .. comment_id .. ')', vim.log.levels.INFO)
    else
      vim.notify('pi-nvim: comment added', vim.log.levels.INFO)
    end

    close_window()

    if timeline_buf and vim.api.nvim_buf_is_valid(timeline_buf) then
      M.refresh({
        open_if_missing = false,
        silent = true,
      })
    end
  end

  local function newline()
    local keys = vim.api.nvim_replace_termcodes('<CR>', true, false, true)
    vim.api.nvim_feedkeys(keys, 'in', false)
  end

  local map_opts = { buffer = buf, nowait = true, silent = true }
  vim.keymap.set('n', '<CR>', submit_comment, map_opts)
  vim.keymap.set('i', '<CR>', submit_comment, map_opts)

  vim.keymap.set('i', '<S-CR>', newline, map_opts)
  vim.keymap.set('i', '<C-j>', newline, map_opts)

  vim.keymap.set('n', '<Esc>', close_window, map_opts)
  vim.keymap.set('i', '<Esc>', close_window, map_opts)

  vim.cmd('startinsert')
end

return M
