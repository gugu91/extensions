local socket = require('pi-nvim.socket')

local M = {}

local setup_done = false
local active_thread = 'global'
local timeline_buf = nil
local timeline_win = nil
local footer_buf = nil
local footer_win = nil
local composer_buf = nil
local composer_win = nil
local composer_context = nil
local refresh_pending = false
local indicator_refresh_pending = false

local indicator_ns = vim.api.nvim_create_namespace('PiCommsIndicators')
local indicator_cache_by_file = {}
local indicator_icon = ''

local close_panel
local focus_composer
local submit_comment

local superscript_digits = {
  ['0'] = '⁰',
  ['1'] = '¹',
  ['2'] = '²',
  ['3'] = '³',
  ['4'] = '⁴',
  ['5'] = '⁵',
  ['6'] = '⁶',
  ['7'] = '⁷',
  ['8'] = '⁸',
  ['9'] = '⁹',
}

local function is_valid_buf(bufnr)
  return bufnr ~= nil and vim.api.nvim_buf_is_valid(bufnr)
end

local function is_valid_win(winid)
  return winid ~= nil and vim.api.nvim_win_is_valid(winid)
end

local function trim(text)
  return (text:gsub('^%s+', ''):gsub('%s+$', ''))
end

local function truncate(text, max_len)
  if type(text) ~= 'string' then
    return ''
  end

  if #text <= max_len then
    return text
  end

  if max_len <= 1 then
    return '…'
  end

  return text:sub(1, max_len - 1) .. '…'
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

local function get_relative_path_for_buf(bufnr)
  local bufpath = vim.api.nvim_buf_get_name(bufnr)
  if bufpath == '' then
    return nil
  end

  local bo = vim.bo[bufnr]
  if bo and bo.buftype and bo.buftype ~= '' then
    return nil
  end

  local cwd = vim.fn.getcwd()
  if vim.startswith(bufpath, cwd .. '/') then
    return bufpath:sub(#cwd + 2)
  end

  return bufpath
end

local function get_relative_path()
  return get_relative_path_for_buf(0)
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
  local file = get_relative_path()
  if not file then
    return nil
  end

  if start_line == nil and end_line == nil then
    local current = vim.api.nvim_win_get_cursor(0)[1]
    start_line = current
    end_line = current
  elseif start_line == nil then
    start_line = end_line
  elseif end_line == nil then
    end_line = start_line
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

local function number_to_superscript(n)
  local text = tostring(n)
  local parts = {}
  for c in text:gmatch('.') do
    table.insert(parts, superscript_digits[c] or '')
  end
  return table.concat(parts)
end

local function indicator_text(count)
  if not count or count <= 1 then
    return indicator_icon
  end

  if count <= 99 then
    return indicator_icon .. number_to_superscript(count)
  end

  return indicator_icon .. '⁺'
end

local function panel_metrics()
  local width = math.max(46, math.min(100, math.floor(vim.o.columns * 0.45)))
  local total_height = math.max(18, vim.o.lines - 6)
  local footer_height = 3
  local composer_height = math.max(4, math.min(8, math.floor(total_height * 0.24)))
  local min_timeline_height = 8

  if total_height - footer_height - composer_height < min_timeline_height then
    composer_height = math.max(3, total_height - footer_height - min_timeline_height)
  end

  return {
    relative = 'editor',
    style = 'minimal',
    border = 'rounded',
    width = width,
    height = total_height,
    row = 1,
    col = math.max(0, vim.o.columns - width - 2),
    footer_height = footer_height,
    composer_height = composer_height,
  }
end

local function timeline_window_config()
  local metrics = panel_metrics()
  return {
    relative = metrics.relative,
    style = metrics.style,
    border = metrics.border,
    width = metrics.width,
    height = metrics.height,
    row = metrics.row,
    col = metrics.col,
    title = string.format(' PiComms [%s] ', active_thread),
    title_pos = 'center',
  }
end

local function footer_window_config()
  local metrics = panel_metrics()
  return {
    relative = 'win',
    win = timeline_win,
    style = 'minimal',
    border = 'none',
    width = metrics.width,
    height = metrics.footer_height,
    row = metrics.height - metrics.composer_height - metrics.footer_height,
    col = 0,
    zindex = 60,
  }
end

local function composer_window_config()
  local metrics = panel_metrics()
  return {
    relative = 'win',
    win = timeline_win,
    style = 'minimal',
    border = 'none',
    width = metrics.width,
    height = metrics.composer_height,
    row = metrics.height - metrics.composer_height,
    col = 0,
    zindex = 61,
  }
end

local function set_timeline_title(total)
  if not is_valid_win(timeline_win) then
    return
  end

  local config = vim.api.nvim_win_get_config(timeline_win)
  config.title = string.format(' PiComms [%s] (%d) ', active_thread, tonumber(total) or 0)
  config.title_pos = 'center'
  vim.api.nvim_win_set_config(timeline_win, config)
end

local function request_comments(thread_id, timeout_ms)
  return socket.request('comment.list', {
    threadId = thread_id,
  }, {
    timeout_ms = timeout_ms or 8000,
  })
end

local function request_all_comments(timeout_ms)
  return socket.request('comment.list_all', {}, {
    timeout_ms = timeout_ms or 12000,
  })
end

local function trigger_agent_prompt(prompt)
  local sent = socket.send({
    type = 'trigger_agent',
    prompt = prompt,
  })

  if not sent then
    vim.notify('pi-nvim: not connected to pi', vim.log.levels.WARN)
    return false
  end

  return true
end

local function clear_indicators(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end

  vim.api.nvim_buf_clear_namespace(bufnr, indicator_ns, 0, -1)
end

local function apply_indicators_to_buffer(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end

  local bo = vim.bo[bufnr]
  if bo and bo.buftype and bo.buftype ~= '' then
    clear_indicators(bufnr)
    return
  end

  local file = get_relative_path_for_buf(bufnr)
  clear_indicators(bufnr)

  if not file then
    return
  end

  local lines = indicator_cache_by_file[file]
  if type(lines) ~= 'table' then
    return
  end

  vim.api.nvim_set_hl(0, 'PiCommsIndicator', { default = true, link = 'Comment' })

  local line_numbers = {}
  for line, _ in pairs(lines) do
    table.insert(line_numbers, line)
  end
  table.sort(line_numbers)

  for _, line in ipairs(line_numbers) do
    local count = lines[line]
    if type(count) == 'number' and count > 0 and line >= 1 then
      vim.api.nvim_buf_set_extmark(bufnr, indicator_ns, line - 1, 0, {
        virt_text = { { indicator_text(count), 'PiCommsIndicator' } },
        virt_text_pos = 'eol',
        hl_mode = 'combine',
        priority = 12,
      })
    end
  end
end

local function apply_indicators_to_visible_buffers()
  local buffers = vim.api.nvim_list_bufs()
  for _, bufnr in ipairs(buffers) do
    if vim.api.nvim_buf_is_loaded(bufnr) then
      apply_indicators_to_buffer(bufnr)
    end
  end
end

local function rebuild_indicator_cache(result)
  indicator_cache_by_file = {}

  if type(result) ~= 'table' or type(result.comments) ~= 'table' then
    return
  end

  for _, comment in ipairs(result.comments) do
    local context = type(comment) == 'table' and comment.context or nil
    if type(context) == 'table' and type(context.file) == 'string' then
      local start_line = tonumber(context.startLine)
      local end_line = tonumber(context.endLine)

      if start_line and not end_line then
        end_line = start_line
      end
      if end_line and not start_line then
        start_line = end_line
      end

      if start_line and end_line then
        start_line = math.max(1, math.floor(start_line))
        end_line = math.max(1, math.floor(end_line))
        if start_line > end_line then
          start_line, end_line = end_line, start_line
        end

        local file_map = indicator_cache_by_file[context.file]
        if not file_map then
          file_map = {}
          indicator_cache_by_file[context.file] = file_map
        end

        local span = math.min(end_line - start_line + 1, 500)
        for offset = 0, span - 1 do
          local line = start_line + offset
          file_map[line] = (file_map[line] or 0) + 1
        end
      end
    end
  end
end

local function refresh_indicators(opts)
  opts = opts or {}

  local result, err = request_all_comments(12000)
  if not result then
    if not opts.silent then
      vim.notify(
        'pi-nvim: failed to refresh PiComms indicators: ' .. get_error_message(err),
        vim.log.levels.WARN
      )
    end
    return
  end

  rebuild_indicator_cache(result)
  apply_indicators_to_visible_buffers()
end

local function schedule_indicator_refresh(silent)
  if indicator_refresh_pending then
    return
  end

  indicator_refresh_pending = true
  vim.defer_fn(function()
    indicator_refresh_pending = false
    refresh_indicators({ silent = silent ~= false })
  end, 150)
end

local function get_composer_context_label()
  local label = format_context(composer_context)
  if not label or label == '' then
    return 'no file context'
  end

  local metrics = panel_metrics()
  return truncate(label, math.max(20, metrics.width - 16))
end

local function footer_lines()
  local metrics = panel_metrics()
  return {
    string.rep('─', math.max(12, metrics.width - 4)),
    'new comment: ' .. get_composer_context_label(),
    'Enter submit • Shift-Enter/C-j newline • q close',
  }
end

local function render_footer()
  if not is_valid_buf(footer_buf) then
    return
  end

  vim.bo[footer_buf].modifiable = true
  vim.api.nvim_buf_set_lines(footer_buf, 0, -1, false, footer_lines())
  vim.bo[footer_buf].modifiable = false
  vim.bo[footer_buf].modified = false
end

local function get_composer_text()
  if not is_valid_buf(composer_buf) then
    return ''
  end

  local lines = vim.api.nvim_buf_get_lines(composer_buf, 0, -1, false)
  return trim(table.concat(lines, '\n'))
end

local function ensure_composer_seed()
  if not is_valid_buf(composer_buf) then
    return
  end

  local line_count = vim.api.nvim_buf_line_count(composer_buf)
  if line_count == 0 then
    vim.api.nvim_buf_set_lines(composer_buf, 0, -1, false, { '' })
  end
end

local function reset_composer_buffer()
  if not is_valid_buf(composer_buf) then
    return
  end

  vim.bo[composer_buf].modifiable = true
  vim.api.nvim_buf_set_lines(composer_buf, 0, -1, false, { '' })

  if is_valid_win(composer_win) then
    vim.api.nvim_win_set_cursor(composer_win, { 1, 0 })
  end
end

close_panel = function()
  if is_valid_win(composer_win) then
    vim.api.nvim_win_close(composer_win, true)
  end
  composer_win = nil

  if is_valid_win(footer_win) then
    vim.api.nvim_win_close(footer_win, true)
  end
  footer_win = nil

  if is_valid_win(timeline_win) then
    vim.api.nvim_win_close(timeline_win, true)
  end
  timeline_win = nil
end

focus_composer = function()
  if not is_valid_win(composer_win) then
    return
  end

  ensure_composer_seed()
  vim.api.nvim_set_current_win(composer_win)
  vim.cmd('startinsert')
end

local function configure_timeline_buffer(buf)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'markdown'
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true

  local ok = pcall(vim.api.nvim_buf_set_name, buf, string.format('pi://picomms/%s', active_thread))
  if not ok then
    -- ignore duplicate-name errors
  end

  vim.keymap.set('n', 'q', close_panel, {
    buffer = buf,
    silent = true,
    desc = 'Close PiComms panel',
  })
end

local function configure_footer_buffer(buf)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'markdown'
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true

  local ok =
    pcall(vim.api.nvim_buf_set_name, buf, string.format('pi://picomms/%s/footer', active_thread))
  if not ok then
    -- ignore duplicate-name errors
  end

  vim.keymap.set('n', 'q', close_panel, {
    buffer = buf,
    silent = true,
    desc = 'Close PiComms panel',
  })
end

submit_comment = function()
  local comment = get_composer_text()
  if comment == '' then
    vim.notify('pi-nvim: comment is empty', vim.log.levels.WARN)
    focus_composer()
    return
  end

  local payload = {
    threadId = active_thread,
    body = comment,
    actorType = 'human',
    actorId = (vim.env.USER and vim.env.USER ~= '') and vim.env.USER or 'user',
    context = composer_context,
  }

  local result, err = socket.request('comment.add', payload, { timeout_ms = 8000 })
  if not result then
    vim.notify('pi-nvim: failed to add comment: ' .. get_error_message(err), vim.log.levels.WARN)
    focus_composer()
    return
  end

  local comment_id = result.comment and result.comment.id
  if type(comment_id) == 'string' and comment_id ~= '' then
    vim.notify('pi-nvim: comment added (' .. comment_id .. ')', vim.log.levels.INFO)
  else
    vim.notify('pi-nvim: comment added', vim.log.levels.INFO)
  end

  reset_composer_buffer()
  schedule_indicator_refresh(true)

  if is_valid_buf(timeline_buf) then
    M.refresh({
      open_if_missing = false,
      silent = true,
    })
  end

  focus_composer()
end

local function configure_composer_buffer(buf)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'markdown'
  vim.bo[buf].modifiable = true
  vim.bo[buf].readonly = false

  local ok =
    pcall(vim.api.nvim_buf_set_name, buf, string.format('pi://picomms/%s/composer', active_thread))
  if not ok then
    -- ignore duplicate-name errors
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
  vim.keymap.set('n', 'q', close_panel, map_opts)
end

local function ensure_panel_windows(opts)
  opts = opts or {}

  if not is_valid_win(timeline_win) then
    if is_valid_win(footer_win) then
      pcall(vim.api.nvim_win_close, footer_win, true)
      footer_win = nil
    end
    if is_valid_win(composer_win) then
      pcall(vim.api.nvim_win_close, composer_win, true)
      composer_win = nil
    end
  end

  if not is_valid_buf(timeline_buf) then
    timeline_buf = vim.api.nvim_create_buf(false, true)
    configure_timeline_buffer(timeline_buf)
  end

  local timeline_config = timeline_window_config()
  if is_valid_win(timeline_win) then
    vim.api.nvim_win_set_buf(timeline_win, timeline_buf)
    vim.api.nvim_win_set_config(timeline_win, timeline_config)
  else
    timeline_win = vim.api.nvim_open_win(timeline_buf, false, timeline_config)
    vim.wo[timeline_win].wrap = false
    vim.wo[timeline_win].number = false
    vim.wo[timeline_win].relativenumber = false
    vim.wo[timeline_win].signcolumn = 'no'
    vim.wo[timeline_win].cursorline = false
    vim.wo[timeline_win].winfixwidth = true
    vim.wo[timeline_win].winfixheight = true
  end

  if not is_valid_buf(footer_buf) then
    footer_buf = vim.api.nvim_create_buf(false, true)
    configure_footer_buffer(footer_buf)
  end

  local footer_config = footer_window_config()
  if is_valid_win(footer_win) then
    vim.api.nvim_win_set_buf(footer_win, footer_buf)
    vim.api.nvim_win_set_config(footer_win, footer_config)
  else
    footer_win = vim.api.nvim_open_win(footer_buf, false, footer_config)
    vim.wo[footer_win].wrap = false
    vim.wo[footer_win].number = false
    vim.wo[footer_win].relativenumber = false
    vim.wo[footer_win].signcolumn = 'no'
    vim.wo[footer_win].cursorline = false
    vim.wo[footer_win].winfixwidth = true
    vim.wo[footer_win].winfixheight = true
    vim.wo[footer_win].winhighlight = 'Normal:NormalFloat,NormalNC:NormalFloat'
  end

  if not is_valid_buf(composer_buf) then
    composer_buf = vim.api.nvim_create_buf(false, true)
    configure_composer_buffer(composer_buf)
    vim.api.nvim_buf_set_lines(composer_buf, 0, -1, false, { '' })
  end

  local composer_config = composer_window_config()
  if is_valid_win(composer_win) then
    vim.api.nvim_win_set_buf(composer_win, composer_buf)
    vim.api.nvim_win_set_config(composer_win, composer_config)
  else
    composer_win = vim.api.nvim_open_win(composer_buf, false, composer_config)
    vim.wo[composer_win].wrap = true
    vim.wo[composer_win].number = false
    vim.wo[composer_win].relativenumber = false
    vim.wo[composer_win].signcolumn = 'no'
    vim.wo[composer_win].cursorline = false
    vim.wo[composer_win].winfixwidth = true
    vim.wo[composer_win].winfixheight = true
    vim.wo[composer_win].winhighlight = 'Normal:NormalFloat,NormalNC:NormalFloat'
  end

  render_footer()
  ensure_composer_seed()

  if opts.focus_composer ~= false then
    focus_composer()
  elseif is_valid_win(timeline_win) then
    vim.api.nvim_set_current_win(timeline_win)
  end
end

local function set_timeline_lines(lines)
  if not is_valid_buf(timeline_buf) then
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
  if not is_valid_buf(timeline_buf) then
    return
  end

  local comments = type(result) == 'table' and type(result.comments) == 'table' and result.comments
    or {}
  local total = type(result) == 'table' and tonumber(result.total) or #comments

  local lines = {
    '# PiComms',
    string.format('thread: %s', active_thread),
    string.format('total: %d', total or 0),
    '',
  }

  if #comments == 0 then
    table.insert(lines, '_No comments yet_')
    table.insert(lines, '')
  else
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
  end

  set_timeline_lines(lines)
  set_timeline_title(total)
end

local function schedule_refresh_if_open(thread_id)
  if thread_id and thread_id ~= active_thread then
    return
  end

  if not is_valid_win(timeline_win) then
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

  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWinEnter' }, {
    group = vim.api.nvim_create_augroup('PiCommsIndicators', { clear = true }),
    callback = function(args)
      apply_indicators_to_buffer(args.buf)
    end,
  })

  socket.on('comment.added', function(payload)
    schedule_refresh_if_open(thread_from_payload(payload))
    schedule_indicator_refresh(true)
  end)

  socket.on('comments.updated', function(payload)
    schedule_refresh_if_open(thread_from_payload(payload))
    schedule_indicator_refresh(true)
  end)

  socket.on('comments.wiped', function()
    schedule_refresh_if_open(active_thread)
    schedule_indicator_refresh(true)
  end)

  socket.on('connected', function()
    schedule_refresh_if_open(active_thread)
    schedule_indicator_refresh(true)
  end)

  schedule_indicator_refresh(true)
end

function M.open(opts)
  if type(opts) == 'string' or opts == nil then
    opts = { thread_id = opts }
  end

  if opts.thread_id then
    active_thread = normalize_thread_id(opts.thread_id)
  end

  local context = build_context(opts.start_line, opts.end_line)
  if context then
    composer_context = context
  end

  ensure_panel_windows({
    focus_composer = opts.focus_composer ~= false,
  })

  M.refresh({
    thread_id = active_thread,
    open_if_missing = false,
    silent = opts.silent,
  })
end

function M.refresh(opts)
  opts = opts or {}

  if opts.thread_id then
    active_thread = normalize_thread_id(opts.thread_id)
  end

  if opts.open_if_missing == true then
    ensure_panel_windows({
      focus_composer = opts.focus_composer ~= false,
    })
  end

  if not is_valid_buf(timeline_buf) or not is_valid_win(timeline_win) then
    if not opts.silent then
      vim.notify('pi-nvim: PiComms panel is not open', vim.log.levels.WARN)
    end
    return
  end

  if is_valid_buf(footer_buf) then
    pcall(
      vim.api.nvim_buf_set_name,
      footer_buf,
      string.format('pi://picomms/%s/footer', active_thread)
    )
  end
  if is_valid_buf(composer_buf) then
    pcall(
      vim.api.nvim_buf_set_name,
      composer_buf,
      string.format('pi://picomms/%s/composer', active_thread)
    )
  end
  pcall(vim.api.nvim_buf_set_name, timeline_buf, string.format('pi://picomms/%s', active_thread))
  render_footer()

  local result, err = request_comments(active_thread, 8000)
  if not result then
    if not opts.silent then
      vim.notify(
        'pi-nvim: failed to load PiComms comments: ' .. get_error_message(err),
        vim.log.levels.WARN
      )
    end
    return
  end

  render_timeline(result)
end

function M.trigger_read()
  local ok = trigger_agent_prompt('/picomms:read')
  if ok then
    vim.notify('pi-nvim: triggered /picomms:read', vim.log.levels.INFO)
  end
end

function M.trigger_clean()
  local confirmed = vim.fn.confirm(
    'Run /picomms:clean for this repository? This wipes all PiComms comments.',
    '&Yes\n&No',
    2
  )

  if confirmed ~= 1 then
    return
  end

  local ok = trigger_agent_prompt('/picomms:clean')
  if ok then
    vim.notify('pi-nvim: triggered /picomms:clean', vim.log.levels.INFO)
  end
end

function M.open_composer(opts)
  opts = opts or {}
  opts.focus_composer = true
  M.open(opts)
end

return M
