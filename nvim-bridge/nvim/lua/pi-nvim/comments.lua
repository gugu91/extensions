local paths = require('pi-nvim.paths')
local socket = require('pi-nvim.socket')

local M = {}

local ns = vim.api.nvim_create_namespace('pinet_contextual_threads')
local signs_defined = false
local latest_threads = {}

local function define_signs()
  if signs_defined then
    return
  end
  signs_defined = true
  vim.fn.sign_define('PinetThread', { text = '▎', texthl = 'DiagnosticInfo' })
  vim.fn.sign_define('PinetThreadResolved', { text = '✓', texthl = 'DiagnosticHint' })
end

local function run_git(worktree, args, stdin)
  local command = { 'git', '-C', worktree }
  vim.list_extend(command, args)
  if vim.system then
    local result = vim.system(command, { text = true, stdin = stdin }):wait()
    if result.code ~= 0 then
      return nil
    end
    return vim.trim(result.stdout or '')
  end
  local escaped = vim.tbl_map(vim.fn.shellescape, command)
  local output = vim.fn.system(table.concat(escaped, ' '), stdin)
  if vim.v.shell_error ~= 0 then
    return nil
  end
  return vim.trim(output)
end

local function current_anchor()
  local worktree = paths.worktree_root()
  if not worktree then
    return nil
  end

  local common_dir =
    run_git(worktree, { 'rev-parse', '--path-format=absolute', '--git-common-dir' })
  local head_oid = run_git(worktree, { 'rev-parse', 'HEAD' })
  if not common_dir or not head_oid then
    return nil
  end
  common_dir = (vim.uv or vim.loop).fs_realpath(common_dir) or common_dir
  local repository = common_dir:match('^(.*)/%.git$') or common_dir
  local file, side = paths.buffer_path_and_side(worktree)
  if not file then
    return nil
  end
  local is_diff = vim.wo.diff
  if is_diff and not side then
    return nil
  end
  if not is_diff and not run_git(worktree, { 'ls-files', '--error-unmatch', '--', file }) then
    return nil
  end

  local base_oid = run_git(worktree, { 'merge-base', 'HEAD', '@{upstream}' })
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local contents = table.concat(lines, '\n')
  if vim.bo.endofline then
    contents = contents .. '\n'
  end
  local blob_oid = run_git(worktree, { 'hash-object', '--stdin' }, contents)
  if not blob_oid then
    return nil
  end

  if not is_diff then
    local head_blob_oid = run_git(worktree, { 'rev-parse', 'HEAD:' .. file })
    return {
      repository = repository,
      worktree = worktree,
      path = file,
      baseOid = base_oid or vim.NIL,
      headOid = head_oid,
      blobOid = blob_oid,
      anchorKind = 'normal',
      headBlobOid = head_blob_oid or vim.NIL,
      dirty = head_blob_oid ~= blob_oid,
    }
  end

  return {
    repository = repository,
    worktree = worktree,
    path = file,
    baseOid = base_oid or vim.NIL,
    headOid = head_oid,
    blobOid = blob_oid,
    anchorKind = 'diff',
    side = side,
  }
end

local function get_visual_range_or_cursor()
  local mode = vim.fn.mode()
  if mode == 'v' or mode == 'V' or mode == '\22' then
    local start_line = vim.fn.line('v')
    local end_line = vim.fn.line('.')
    if start_line > end_line then
      start_line, end_line = end_line, start_line
    end
    return start_line, end_line
  end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  return line, line
end

local function get_lines_text(start_line, end_line)
  return table.concat(vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false), '\n')
end

local function prompt_text(prompt, opts)
  local ok, value = pcall(vim.fn.input, opts or {}, prompt)
  if not ok or value == '' then
    return nil
  end
  return value
end

local function anchor_state(thread)
  local metadata = thread and thread.metadata or {}
  return metadata.state or {}
end

local function anchor(thread)
  local metadata = thread and thread.metadata or {}
  return metadata.codeAnchor or {}
end

local function thread_line(thread)
  return anchor(thread).startLine or 1
end

local function apply_signs(threads)
  define_signs()
  local bufnr = vim.api.nvim_get_current_buf()
  vim.fn.sign_unplace('pinet-contextual-threads', { buffer = bufnr })
  vim.api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)

  for i, thread in ipairs(threads or {}) do
    local line = thread_line(thread)
    local resolved = anchor_state(thread).resolved == true
    vim.fn.sign_place(
      i,
      'pinet-contextual-threads',
      resolved and 'PinetThreadResolved' or 'PinetThread',
      bufnr,
      { lnum = line, priority = resolved and 5 or 10 }
    )
    vim.api.nvim_buf_set_extmark(bufnr, ns, math.max(line - 1, 0), 0, {
      virt_text = {
        { ' Pinet ' .. thread.threadId, resolved and 'DiagnosticHint' or 'DiagnosticInfo' },
      },
      virt_text_pos = 'eol',
    })
  end
end

local function refresh(opts)
  opts = opts or {}
  local revision = current_anchor()
  if not revision then
    return nil
  end
  local result, err = socket.request('pinet.thread.list', {
    anchor = revision,
    includeResolved = opts.include_resolved == true,
    limit = opts.limit or 100,
  })
  if err then
    vim.notify('Pinet threads: ' .. (err.message or 'request failed'), vim.log.levels.WARN)
    return nil
  end
  latest_threads = result.threads or {}
  apply_signs(latest_threads)
  return latest_threads
end

function M.refresh(opts)
  return refresh(opts)
end

function M.create(opts)
  opts = opts or {}
  local revision = current_anchor()
  if not revision then
    vim.notify('Pinet could not identify a tracked file revision.', vim.log.levels.WARN)
    return
  end
  local document = socket.request('pinet.document.get', { anchor = revision }) or {}
  local target = opts.target_agent_id or document.ownerAgentId or vim.g.pinet_agent_id
  if not target and not document.ownerAgentId then
    target = prompt_text('Document owner Pinet agent id: ')
  end
  if not target then
    return
  end
  local body = opts.body or prompt_text('Comment: ')
  if not body then
    return
  end
  local start_line, end_line = opts.start_line, opts.end_line
  if not start_line or not end_line then
    start_line, end_line = get_visual_range_or_cursor()
  end
  local selected = get_lines_text(start_line, end_line)
  local result, err = socket.request('pinet.thread.create', {
    targetAgentId = target,
    body = body,
    anchor = revision,
    startLine = start_line,
    endLine = end_line,
    selectedText = selected,
    contextText = selected,
  })
  if err then
    vim.notify('Pinet comment failed: ' .. (err.message or 'request failed'), vim.log.levels.ERROR)
    return
  end
  vim.notify('Pinet thread created: ' .. result.threadId, vim.log.levels.INFO)
  refresh()
end

function M.document_owner(agent_id)
  local revision = current_anchor()
  agent_id = agent_id or prompt_text('Document owner Pinet agent id: ')
  if not revision or not agent_id then
    return
  end
  local result, err =
    socket.request('pinet.document.owner', { anchor = revision, agentId = agent_id })
  if err then
    vim.notify(
      'Pinet document owner failed: ' .. (err.message or 'request failed'),
      vim.log.levels.ERROR
    )
    return
  end
  vim.notify('Pinet document owner: ' .. tostring(result.ownerAgentId), vim.log.levels.INFO)
end

function M.document_subscribe(agent_id, subscribe)
  local revision = current_anchor()
  agent_id = agent_id or vim.g.pinet_agent_id or prompt_text('Subscriber Pinet agent id: ')
  if not revision or not agent_id then
    return
  end
  local request = subscribe == false and 'pinet.document.unsubscribe' or 'pinet.document.subscribe'
  local result, err = socket.request(request, { anchor = revision, agentId = agent_id })
  if err then
    vim.notify(
      'Pinet document subscription failed: ' .. (err.message or 'request failed'),
      vim.log.levels.ERROR
    )
    return
  end
  vim.notify(
    'Pinet subscribers: ' .. table.concat(result.subscribers or {}, ', '),
    vim.log.levels.INFO
  )
end

function M.document_status()
  local revision = current_anchor()
  if not revision then
    vim.notify('Pinet could not identify a tracked file revision.', vim.log.levels.WARN)
    return
  end
  local result, err = socket.request('pinet.document.get', { anchor = revision })
  if err then
    vim.notify(
      'Pinet document status failed: ' .. (err.message or 'request failed'),
      vim.log.levels.ERROR
    )
    return
  end
  vim.notify(
    string.format(
      'Pinet document owner=%s subscribers=%s',
      tostring(result.ownerAgentId or 'none'),
      table.concat(result.subscribers or {}, ', ')
    ),
    vim.log.levels.INFO
  )
end

function M.document_bind_thread(thread_id)
  local revision = current_anchor()
  thread_id = thread_id or prompt_text('Slack thread id: ')
  if not revision or not thread_id then
    return
  end
  local result, err =
    socket.request('pinet.document.bind_thread', { anchor = revision, threadId = thread_id })
  if err then
    vim.notify(
      'Pinet document binding failed: ' .. (err.message or 'request failed'),
      vim.log.levels.ERROR
    )
    return
  end
  vim.notify('Pinet document bound: ' .. tostring(result.documentId), vim.log.levels.INFO)
end

function M.reply(thread_id, body)
  thread_id = thread_id or prompt_text('Thread id: ')
  body = body or prompt_text('Reply: ')
  if not thread_id or not body then
    return
  end
  local _, err = socket.request('pinet.thread.reply', { threadId = thread_id, body = body })
  if err then
    vim.notify('Pinet reply failed: ' .. (err.message or 'request failed'), vim.log.levels.ERROR)
    return
  end
  refresh({ include_resolved = true })
end

function M.resolve(thread_id, resolved)
  thread_id = thread_id or prompt_text('Thread id: ')
  if not thread_id then
    return
  end
  local _, err =
    socket.request('pinet.thread.resolve', { threadId = thread_id, resolved = resolved ~= false })
  if err then
    vim.notify('Pinet resolve failed: ' .. (err.message or 'request failed'), vim.log.levels.ERROR)
    return
  end
  refresh({ include_resolved = true })
end

local function render_thread(thread)
  local lines = {}
  local a = anchor(thread)
  local state = anchor_state(thread)
  table.insert(
    lines,
    string.format(
      '# %s %s:%s-%s [%s]',
      thread.threadId,
      a.path or '?',
      a.startLine or '?',
      a.endLine or '?',
      a.side or '?'
    )
  )
  table.insert(lines, state.resolved and 'state: resolved' or 'state: open')
  table.insert(lines, '')
  for _, message in ipairs(thread.messages or {}) do
    table.insert(
      lines,
      string.format('%s %s:', message.createdAt or '', message.sender or 'unknown')
    )
    for body_line in tostring(message.body or ''):gmatch('([^\n]*)\n?') do
      if body_line ~= '' then
        table.insert(lines, '  ' .. body_line)
      end
    end
    table.insert(lines, '')
  end
  return lines
end

function M.open_thread(thread_id)
  thread_id = thread_id or prompt_text('Thread id: ')
  if not thread_id then
    return
  end
  local thread, err = socket.request('pinet.thread.get', { threadId = thread_id })
  if err then
    vim.notify('Pinet thread failed: ' .. (err.message or 'request failed'), vim.log.levels.ERROR)
    return
  end
  vim.cmd('botright 12split')
  local bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_win_set_buf(0, bufnr)
  vim.bo[bufnr].filetype = 'pinet-thread'
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, render_thread(thread))
end

local function nearest_thread(delta)
  if #latest_threads == 0 then
    refresh()
  end
  if #latest_threads == 0 then
    return nil
  end
  local current = vim.api.nvim_win_get_cursor(0)[1]
  local selected = nil
  for _, thread in ipairs(latest_threads) do
    local line = thread_line(thread)
    if delta > 0 and line > current and (not selected or line < thread_line(selected)) then
      selected = thread
    elseif delta < 0 and line < current and (not selected or line > thread_line(selected)) then
      selected = thread
    end
  end
  return selected or latest_threads[1]
end

function M.next()
  local thread = nearest_thread(1)
  if thread then
    vim.api.nvim_win_set_cursor(0, { thread_line(thread), 0 })
  end
end

function M.prev()
  local thread = nearest_thread(-1)
  if thread then
    vim.api.nvim_win_set_cursor(0, { thread_line(thread), 0 })
  end
end

socket.on('thread.updated', function()
  refresh({ include_resolved = true })
end)

return M
