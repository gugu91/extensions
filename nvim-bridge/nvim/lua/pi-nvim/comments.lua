local socket = require('pi-nvim.socket')

local M = {}

local DEFAULT_THREAD = 'global'
local CONTEXT_THREAD_PREFIX = 'ctx:'

local setup_done = false
local active_thread = DEFAULT_THREAD
local active_thread_context = nil
local active_thread_label = DEFAULT_THREAD
local timeline_content_line_count = 8

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
local focus_timeline
local focus_composer
local enter_insert_mode
local submit_comment

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

local function normalize_context(context)
  if type(context) ~= 'table' or type(context.file) ~= 'string' or context.file == '' then
    return nil
  end

  local start_line = tonumber(context.startLine)
  local end_line = tonumber(context.endLine)

  if start_line == nil and end_line == nil then
    return nil
  end

  if start_line == nil then
    start_line = end_line
  end
  if end_line == nil then
    end_line = start_line
  end

  start_line, end_line = normalize_range(start_line, end_line)

  return {
    file = context.file,
    startLine = start_line,
    endLine = end_line,
  }
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

local function build_context_thread_id(context)
  local normalized = normalize_context(context)
  if not normalized then
    return nil
  end

  return string.format(
    '%s%s:%d-%d',
    CONTEXT_THREAD_PREFIX,
    normalized.file,
    normalized.startLine,
    normalized.endLine
  )
end

local function derive_comment_thread_id(comment)
  if type(comment) ~= 'table' then
    return DEFAULT_THREAD
  end

  if
    type(comment.threadId) == 'string'
    and comment.threadId ~= ''
    and comment.threadId ~= DEFAULT_THREAD
  then
    return comment.threadId
  end

  local contextual = build_context_thread_id(comment.context)
  if contextual then
    return contextual
  end

  if type(comment.threadId) == 'string' and comment.threadId ~= '' then
    return comment.threadId
  end

  return DEFAULT_THREAD
end

local function normalize_thread_id(thread_id, fallback)
  if type(thread_id) ~= 'string' then
    return fallback or DEFAULT_THREAD
  end

  local trimmed = trim(thread_id)
  if trimmed == '' then
    return fallback or DEFAULT_THREAD
  end

  return trimmed
end

local function thread_from_payload(payload)
  if type(payload) ~= 'table' then
    return nil
  end
  if type(payload.threadId) == 'string' then
    return normalize_thread_id(payload.threadId)
  end
  if type(payload.comment) == 'table' then
    return derive_comment_thread_id(payload.comment)
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
  local normalized = normalize_context(context)
  if not normalized then
    return nil
  end

  if normalized.startLine and normalized.endLine then
    return string.format('%s:%d-%d', normalized.file, normalized.startLine, normalized.endLine)
  end

  return normalized.file
end

local function format_timestamp(iso)
  if type(iso) ~= 'string' or iso == '' then
    return 'unknown-time'
  end

  local ok, parsed = pcall(vim.fn.strptime, '%Y-%m-%dT%H:%M:%S', iso:sub(1, 19))
  if ok and type(parsed) == 'number' and parsed > 0 then
    return os.date('%Y-%m-%d %H:%M', parsed)
  end

  return iso
end

local function thread_label(thread_id, context)
  local context_label = format_context(context)
  if context_label then
    return context_label
  end

  local normalized = normalize_thread_id(thread_id)
  if vim.startswith(normalized, CONTEXT_THREAD_PREFIX) then
    return normalized:sub(#CONTEXT_THREAD_PREFIX + 1)
  end

  return normalized
end

local function thread_title_label(thread_id, context)
  local normalized = normalize_context(context)
  if normalized then
    if normalized.startLine == normalized.endLine then
      return string.format('line %d', normalized.startLine)
    end
    return string.format('lines %d-%d', normalized.startLine, normalized.endLine)
  end

  local normalized_thread = normalize_thread_id(thread_id)
  if normalized_thread == DEFAULT_THREAD then
    return 'general'
  end

  return truncate(thread_label(thread_id, context), 24)
end

local function panel_metrics()
  local width = math.max(54, math.min(96, math.floor(vim.o.columns * 0.42)))
  local max_height = math.max(16, vim.o.lines - 6)
  local footer_height = 2
  local composer_height = 5
  local min_timeline_height = 6
  local desired_height = timeline_content_line_count + footer_height + composer_height + 2
  local min_height = min_timeline_height + footer_height + composer_height
  local total_height = math.max(min_height, math.min(max_height, desired_height))

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
  local title_label = thread_title_label(active_thread, active_thread_context)
  return {
    relative = metrics.relative,
    style = metrics.style,
    border = metrics.border,
    width = metrics.width,
    height = metrics.height,
    row = metrics.row,
    col = metrics.col,
    title = string.format(' PiComms · %s ', title_label),
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

local function apply_panel_layout()
  if is_valid_win(timeline_win) then
    vim.api.nvim_win_set_config(timeline_win, timeline_window_config())
  end
  if is_valid_win(footer_win) then
    vim.api.nvim_win_set_config(footer_win, footer_window_config())
  end
  if is_valid_win(composer_win) then
    vim.api.nvim_win_set_config(composer_win, composer_window_config())
  end
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

local function indicator_text(count)
  local value = tonumber(count) or 0
  if value <= 0 then
    return indicator_icon
  end
  if value > 99 then
    return indicator_icon .. '99+'
  end
  return indicator_icon .. tostring(value)
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

  vim.api.nvim_set_hl(0, 'PiCommsIndicator', { default = true, link = 'WarningMsg' })

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
        priority = 16,
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
    local context = normalize_context(type(comment) == 'table' and comment.context or nil)
    if context then
      local file_map = indicator_cache_by_file[context.file]
      if not file_map then
        file_map = {}
        indicator_cache_by_file[context.file] = file_map
      end

      file_map[context.startLine] = (file_map[context.startLine] or 0) + 1
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
  local normalized = normalize_context(composer_context) or normalize_context(active_thread_context)
  local label = normalized and normalized.file or active_thread_label or 'general'
  local metrics = panel_metrics()
  return truncate(label, math.max(20, metrics.width - 10))
end

local function footer_lines()
  return {
    'reply · ' .. get_composer_context_label(),
    'i insert • Enter send • S-Enter nl • q close',
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

  if vim.api.nvim_buf_line_count(composer_buf) == 0 then
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

focus_timeline = function()
  if not is_valid_win(timeline_win) then
    return
  end

  vim.cmd('stopinsert')
  vim.api.nvim_set_current_win(timeline_win)
end

focus_composer = function(start_insert)
  if not is_valid_win(composer_win) then
    return
  end

  ensure_composer_seed()
  vim.api.nvim_set_current_win(composer_win)
  if start_insert then
    vim.cmd('startinsert')
  else
    vim.cmd('stopinsert')
  end
end

enter_insert_mode = function()
  focus_composer(true)
end

local function set_panel_window_options(winid, wrapped)
  vim.wo[winid].wrap = wrapped
  vim.wo[winid].number = false
  vim.wo[winid].relativenumber = false
  vim.wo[winid].signcolumn = 'no'
  vim.wo[winid].cursorline = false
  vim.wo[winid].winfixwidth = true
  vim.wo[winid].winfixheight = true
end

local function set_common_panel_keymaps(buf)
  local map_opts = { buffer = buf, silent = true }
  vim.keymap.set('n', 'q', close_panel, map_opts)
  vim.keymap.set('n', '<C-w>q', close_panel, map_opts)
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

  set_common_panel_keymaps(buf)
  vim.keymap.set('n', 'i', enter_insert_mode, {
    buffer = buf,
    silent = true,
    desc = 'Insert PiComms reply',
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

  set_common_panel_keymaps(buf)
  vim.keymap.set('n', 'i', enter_insert_mode, {
    buffer = buf,
    silent = true,
    desc = 'Insert PiComms reply',
  })
end

submit_comment = function()
  local current_mode = vim.api.nvim_get_mode().mode
  local was_insert = current_mode:sub(1, 1) == 'i'
  local comment = get_composer_text()
  if comment == '' then
    vim.notify('pi-nvim: comment is empty', vim.log.levels.WARN)
    if was_insert then
      enter_insert_mode()
    else
      focus_composer(false)
    end
    return
  end

  local payload = {
    threadId = active_thread,
    body = comment,
    actorType = 'human',
    actorId = (vim.env.USER and vim.env.USER ~= '') and vim.env.USER or 'user',
    context = composer_context or active_thread_context,
  }

  local result, err = socket.request('comment.add', payload, { timeout_ms = 8000 })
  if not result then
    vim.notify('pi-nvim: failed to add comment: ' .. get_error_message(err), vim.log.levels.WARN)
    if was_insert then
      enter_insert_mode()
    else
      focus_composer(false)
    end
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

  if was_insert then
    enter_insert_mode()
  else
    focus_composer(false)
  end
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
  vim.keymap.set('n', 'q', close_panel, map_opts)
  vim.keymap.set('n', '<C-w>q', close_panel, map_opts)
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
    set_panel_window_options(timeline_win, false)
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
    set_panel_window_options(footer_win, false)
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
    set_panel_window_options(composer_win, true)
    vim.wo[composer_win].winhighlight = 'Normal:NormalFloat,NormalNC:NormalFloat'
  end

  render_footer()
  ensure_composer_seed()

  if opts.focus_composer then
    focus_composer(false)
  else
    focus_timeline()
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

local function render_comment(comment)
  local created_at = format_timestamp(comment.createdAt)
  local actor_type = type(comment.actorType) == 'string' and comment.actorType or 'unknown'
  local actor_id = type(comment.actorId) == 'string' and comment.actorId or 'unknown'
  local context = format_context(comment.context)
  local body = type(comment.body) == 'string' and comment.body or ''
  local body_lines = body ~= '' and vim.split(body, '\n', { plain = true })
    or { '_(empty comment)_' }

  local lines = {
    string.format('╭─ %s:%s · %s', actor_type, actor_id, created_at),
  }

  for _, body_line in ipairs(body_lines) do
    table.insert(lines, '│ ' .. body_line)
  end

  if context then
    table.insert(lines, '╰─ ' .. context)
  else
    table.insert(lines, '╰─ ' .. derive_comment_thread_id(comment))
  end

  return lines
end

local function render_timeline(result)
  if not is_valid_buf(timeline_buf) then
    return
  end

  local comments = type(result) == 'table' and type(result.comments) == 'table' and result.comments
    or {}

  local lines = {}

  if #comments == 0 then
    table.insert(lines, '_No comments yet_')
  else
    for index, comment in ipairs(comments) do
      if index > 1 then
        table.insert(lines, '')
      end
      local rendered = render_comment(comment)
      for _, line in ipairs(rendered) do
        table.insert(lines, line)
      end
    end
  end

  timeline_content_line_count = math.max(8, #lines)
  apply_panel_layout()
  render_footer()
  set_timeline_lines(lines)
end

local function is_same_context(a, b)
  local left = normalize_context(a)
  local right = normalize_context(b)
  if not left or not right then
    return false
  end

  return left.file == right.file
    and left.startLine == right.startLine
    and left.endLine == right.endLine
end

local function score_comment_for_context(comment, context)
  local normalized_context = normalize_context(context)
  local comment_context = normalize_context(type(comment) == 'table' and comment.context or nil)
  if not normalized_context or not comment_context then
    return nil
  end
  if comment_context.file ~= normalized_context.file then
    return nil
  end

  local span = math.max(0, comment_context.endLine - comment_context.startLine)

  if normalized_context.startLine ~= normalized_context.endLine then
    if is_same_context(comment_context, normalized_context) then
      return 0 + span / 1000
    end

    local overlaps = not (
      comment_context.endLine < normalized_context.startLine
      or comment_context.startLine > normalized_context.endLine
    )
    if overlaps then
      return 100
        + math.abs(comment_context.startLine - normalized_context.startLine)
        + math.abs(comment_context.endLine - normalized_context.endLine)
        + span / 1000
    end

    return nil
  end

  local line = normalized_context.startLine
  if comment_context.startLine == line and comment_context.endLine == line then
    return 0
  end
  if comment_context.startLine == line then
    return 10 + span / 1000
  end
  if comment_context.startLine <= line and comment_context.endLine >= line then
    return 20 + span / 1000
  end

  return nil
end

local function newer_comment(a, b)
  local a_time = type(a) == 'table' and type(a.createdAt) == 'string' and a.createdAt or ''
  local b_time = type(b) == 'table' and type(b.createdAt) == 'string' and b.createdAt or ''
  if a_time ~= b_time then
    return a_time > b_time
  end

  local a_id = type(a) == 'table' and type(a.id) == 'string' and a.id or ''
  local b_id = type(b) == 'table' and type(b.id) == 'string' and b.id or ''
  return a_id > b_id
end

local function resolve_thread_for_context(context, comments)
  local normalized_context = normalize_context(context)
  local fallback_thread = build_context_thread_id(normalized_context) or DEFAULT_THREAD
  if not normalized_context or type(comments) ~= 'table' then
    return fallback_thread, normalized_context, thread_label(fallback_thread, normalized_context)
  end

  local best_comment = nil
  local best_score = nil

  for _, comment in ipairs(comments) do
    local score = score_comment_for_context(comment, normalized_context)
    if score ~= nil then
      if
        best_score == nil
        or score < best_score
        or (score == best_score and newer_comment(comment, best_comment))
      then
        best_comment = comment
        best_score = score
      end
    end
  end

  if best_comment then
    local best_context = normalize_context(best_comment.context) or normalized_context
    local best_thread = derive_comment_thread_id(best_comment)
    return best_thread, best_context, thread_label(best_thread, best_context)
  end

  return fallback_thread, normalized_context, thread_label(fallback_thread, normalized_context)
end

local function schedule_refresh_if_open(thread_id)
  if thread_id and normalize_thread_id(thread_id) ~= active_thread then
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

local function collect_thread_targets(result, file)
  local targets_by_thread = {}
  local ordered = {}

  if type(result) ~= 'table' or type(result.comments) ~= 'table' then
    return ordered
  end

  for _, comment in ipairs(result.comments) do
    local context = normalize_context(type(comment) == 'table' and comment.context or nil)
    if context and context.file == file then
      local thread_id = derive_comment_thread_id(comment)
      local existing = targets_by_thread[thread_id]
      if not existing then
        existing = {
          thread_id = thread_id,
          context = context,
          latest = comment,
        }
        targets_by_thread[thread_id] = existing
        table.insert(ordered, existing)
      else
        if
          context.startLine < existing.context.startLine
          or (
            context.startLine == existing.context.startLine
            and context.endLine < existing.context.endLine
          )
        then
          existing.context = context
        end
        if newer_comment(comment, existing.latest) then
          existing.latest = comment
        end
      end
    end
  end

  table.sort(ordered, function(a, b)
    if a.context.startLine ~= b.context.startLine then
      return a.context.startLine < b.context.startLine
    end
    if a.context.endLine ~= b.context.endLine then
      return a.context.endLine < b.context.endLine
    end
    return a.thread_id < b.thread_id
  end)

  return ordered
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
  opts = opts or {}

  local requested_context = opts.context or build_context(opts.start_line, opts.end_line)
  local resolved_thread = normalize_thread_id(opts.thread_id, active_thread)
  local resolved_context = normalize_context(requested_context)
  local resolved_label = thread_label(resolved_thread, resolved_context)

  if opts.thread_id == nil and resolved_context then
    local all, err = request_all_comments(12000)
    if all and type(all.comments) == 'table' then
      resolved_thread, resolved_context, resolved_label =
        resolve_thread_for_context(resolved_context, all.comments)
    else
      if not opts.silent then
        vim.notify(
          'pi-nvim: failed to resolve PiComms thread: ' .. get_error_message(err),
          vim.log.levels.WARN
        )
      end
      resolved_thread = build_context_thread_id(resolved_context) or DEFAULT_THREAD
      resolved_label = thread_label(resolved_thread, resolved_context)
    end
  elseif opts.thread_id == nil and not resolved_context then
    resolved_thread = DEFAULT_THREAD
    resolved_label = DEFAULT_THREAD
  end

  active_thread = normalize_thread_id(resolved_thread, DEFAULT_THREAD)
  active_thread_context = resolved_context
  active_thread_label = resolved_label
  composer_context = normalize_context(opts.reply_context) or resolved_context

  ensure_panel_windows({
    focus_composer = opts.focus_composer == true,
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
    active_thread = normalize_thread_id(opts.thread_id, active_thread)
    active_thread_label = thread_label(active_thread, active_thread_context)
  end
  if opts.context then
    active_thread_context = normalize_context(opts.context)
    active_thread_label = thread_label(active_thread, active_thread_context)
  end
  if opts.reply_context then
    composer_context = normalize_context(opts.reply_context)
  end

  if opts.open_if_missing == true then
    ensure_panel_windows({
      focus_composer = opts.focus_composer == true,
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

function M.next_thread()
  local file = get_relative_path()
  if not file then
    vim.notify('pi-nvim: current buffer is not a file', vim.log.levels.WARN)
    return
  end

  local result, err = request_all_comments(12000)
  if not result then
    vim.notify(
      'pi-nvim: failed to load PiComms threads: ' .. get_error_message(err),
      vim.log.levels.WARN
    )
    return
  end

  local targets = collect_thread_targets(result, file)
  if #targets == 0 then
    vim.notify('pi-nvim: no PiComms threads found for this file', vim.log.levels.INFO)
    return
  end

  local current_line = vim.api.nvim_win_get_cursor(0)[1]
  local current_index = nil
  for index, target in ipairs(targets) do
    if current_line >= target.context.startLine and current_line <= target.context.endLine then
      current_index = index
      break
    end
  end

  local next_target = nil
  if current_index ~= nil then
    next_target = targets[current_index + 1] or targets[1]
  else
    for _, target in ipairs(targets) do
      if target.context.startLine > current_line then
        next_target = target
        break
      end
    end
    if not next_target then
      next_target = targets[1]
    end
  end

  vim.api.nvim_win_set_cursor(0, { next_target.context.startLine, 0 })
  vim.cmd('normal! zz')

  M.open({
    thread_id = next_target.thread_id,
    context = next_target.context,
    reply_context = next_target.context,
    focus_composer = false,
    silent = true,
  })
end

function M.open_composer(opts)
  opts = opts or {}
  opts.focus_composer = true
  M.open(opts)
end

function M.close(opts)
  opts = opts or {}

  local open = is_valid_win(timeline_win) or is_valid_win(footer_win) or is_valid_win(composer_win)
  if not open then
    if not opts.silent then
      vim.notify('pi-nvim: PiComms panel is not open', vim.log.levels.WARN)
    end
    return false
  end

  close_panel()
  return true
end

return M
