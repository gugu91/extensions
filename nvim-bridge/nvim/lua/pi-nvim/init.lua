local events = require('pi-nvim.events')
local pinet = require('pi-nvim.pinet')
local socket = require('pi-nvim.socket')

local M = {}

local enabled = false

function M.setup(_opts)
  enabled = true

  -- Connect socket on startup.
  socket.connect()

  if vim.fn.exists(':PinetAsk') == 0 then
    vim.api.nvim_create_user_command('PinetAsk', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end

      local has_range = (cmd_opts.range or 0) > 0
      pinet.ask({
        message = cmd_opts.args,
        start_line = has_range and cmd_opts.line1 or nil,
        end_line = has_range and cmd_opts.line2 or nil,
      })
    end, {
      desc = 'Send current Neovim context to pi as a Pinet-oriented request',
      range = true,
      nargs = '*',
    })
  end

  if vim.fn.exists(':PinetRead') == 0 then
    vim.api.nvim_create_user_command('PinetRead', function()
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      pinet.read()
    end, {
      desc = 'Ask pi to read pending Pinet follow-ups for this repository',
    })
  end

  -- BufEnter: send buffer_focus (no debounce).
  vim.api.nvim_create_autocmd('BufEnter', {
    group = vim.api.nvim_create_augroup('PiNvimBufEnter', { clear = true }),
    callback = function()
      if not enabled then
        return
      end
      events.on_buf_enter()
    end,
  })

  -- WinScrolled: send visible_range (debounced).
  vim.api.nvim_create_autocmd('WinScrolled', {
    group = vim.api.nvim_create_augroup('PiNvimWinScrolled', { clear = true }),
    callback = function()
      if not enabled then
        return
      end
      events.on_win_scrolled()
    end,
  })

  -- CursorMoved: send selection in visual mode (debounced).
  vim.api.nvim_create_autocmd('CursorMoved', {
    group = vim.api.nvim_create_augroup('PiNvimCursorMoved', { clear = true }),
    callback = function()
      if not enabled then
        return
      end
      events.on_cursor_moved()
    end,
  })

  -- DirChanged / FocusGained: invalidate cached git info and reconnect.
  vim.api.nvim_create_autocmd({ 'DirChanged', 'FocusGained' }, {
    group = vim.api.nvim_create_augroup('PiNvimDirChanged', { clear = true }),
    callback = function()
      if not enabled then
        return
      end
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
  socket.disconnect({ no_reconnect = true })
end

function M.is_enabled()
  return enabled
end

return M
