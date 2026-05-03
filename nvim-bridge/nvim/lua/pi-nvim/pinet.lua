local socket = require('pi-nvim.socket')

local M = {}

local function trim(text)
  if type(text) ~= 'string' then
    return ''
  end
  return (text:gsub('^%s+', ''):gsub('%s+$', ''))
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

local function build_context_label(start_line, end_line)
  local file = get_relative_path()
  if not file then
    return nil
  end

  start_line, end_line = normalize_range(start_line, end_line)
  if start_line == end_line then
    return string.format('%s:%d', file, start_line)
  end
  return string.format('%s:%d-%d', file, start_line, end_line)
end

local function send_prompt(prompt)
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

function M.ask(opts)
  opts = opts or {}
  local message = trim(opts.message)
  if message == '' then
    message = 'Please help with this Neovim context.'
  end

  local context = build_context_label(opts.start_line, opts.end_line) or 'unknown buffer'
  local prompt = table.concat({
    'Neovim Pinet request.',
    '',
    'Context: ' .. context,
    '',
    'Request:',
    message,
    '',
    'Use Pinet for coordination, delegation, durable lanes, or follow-up tracking when needed. Do not use PiComms; this nvim adapter is intentionally thin.',
  }, '\n')

  if send_prompt(prompt) then
    vim.notify('pi-nvim: sent Pinet request for ' .. context, vim.log.levels.INFO)
    return true
  end

  return false
end

function M.read()
  local context = build_context_label() or 'unknown buffer'
  local prompt = table.concat({
    'Please check Pinet for pending work or follow-up relevant to this repository and current Neovim context.',
    '',
    'Context: ' .. context,
    '',
    'Use `pinet action=read` and summarize anything actionable. Do not use PiComms.',
  }, '\n')

  if send_prompt(prompt) then
    vim.notify('pi-nvim: queued Pinet read request', vim.log.levels.INFO)
    return true
  end

  return false
end

return M
