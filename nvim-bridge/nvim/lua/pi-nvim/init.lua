local comments = require('pi-nvim.comments')
local events = require('pi-nvim.events')
local socket = require('pi-nvim.socket')

local M = {}

local enabled = false

function M.setup(_opts)
  enabled = true

  -- Connect socket on startup
  socket.connect()
  comments.setup()

  -- PiComms timeline commands.
  if vim.fn.exists(':PiCommsOpen') == 0 then
    vim.api.nvim_create_user_command('PiCommsOpen', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end

      local thread_id = cmd_opts.args ~= '' and cmd_opts.args or nil
      local has_range = (cmd_opts.range or 0) > 0

      comments.open({
        thread_id = thread_id,
        start_line = has_range and cmd_opts.line1 or nil,
        end_line = has_range and cmd_opts.line2 or nil,
        focus_composer = false,
      })
    end, {
      desc = 'Open PiComms panel for the current thread',
      range = true,
      nargs = '?',
    })
  end

  if vim.fn.exists(':PiCommsRefresh') == 0 then
    vim.api.nvim_create_user_command('PiCommsRefresh', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      local thread_id = cmd_opts.args ~= '' and cmd_opts.args or nil
      comments.refresh({
        thread_id = thread_id,
        open_if_missing = true,
        focus_composer = false,
      })
    end, {
      desc = 'Refresh PiComms timeline',
      nargs = '?',
    })
  end

  if vim.fn.exists(':PiCommsAdd') == 0 then
    vim.api.nvim_create_user_command('PiCommsAdd', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end

      local thread_id = cmd_opts.args ~= '' and cmd_opts.args or nil
      local has_range = (cmd_opts.range or 0) > 0

      comments.open({
        thread_id = thread_id,
        start_line = has_range and cmd_opts.line1 or nil,
        end_line = has_range and cmd_opts.line2 or nil,
        focus_composer = true,
      })
    end, {
      desc = 'Open PiComms and focus the inline composer',
      range = true,
      nargs = '?',
    })
  end

  if vim.fn.exists(':PiCommsNext') == 0 then
    vim.api.nvim_create_user_command('PiCommsNext', function()
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      comments.next_thread()
    end, {
      desc = 'Jump to the next PiComms thread in this file',
    })
  end

  if vim.fn.exists(':PiCommsClose') == 0 then
    vim.api.nvim_create_user_command('PiCommsClose', function()
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      comments.close()
    end, {
      desc = 'Close the PiComms panel',
    })
  end

  if vim.fn.exists(':PiCommsRead') == 0 then
    vim.api.nvim_create_user_command('PiCommsRead', function()
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      comments.trigger_read()
    end, {
      desc = 'Trigger /picomms:read',
    })
  end

  if vim.fn.exists(':PiCommsClean') == 0 then
    vim.api.nvim_create_user_command('PiCommsClean', function()
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      comments.trigger_clean()
    end, {
      desc = 'Trigger /picomms:clean',
    })
  end

  -- BufEnter: send buffer_focus (no debounce)
  vim.api.nvim_create_autocmd('BufEnter', {
    group = vim.api.nvim_create_augroup('PiNvimBufEnter', { clear = true }),
    callback = function()
      if not enabled then
        return
      end
      events.on_buf_enter()
    end,
  })

  -- WinScrolled: send visible_range (debounced)
  vim.api.nvim_create_autocmd('WinScrolled', {
    group = vim.api.nvim_create_augroup('PiNvimWinScrolled', { clear = true }),
    callback = function()
      if not enabled then
        return
      end
      events.on_win_scrolled()
    end,
  })

  -- CursorMoved: send selection in visual mode (debounced)
  vim.api.nvim_create_autocmd('CursorMoved', {
    group = vim.api.nvim_create_augroup('PiNvimCursorMoved', { clear = true }),
    callback = function()
      if not enabled then
        return
      end
      events.on_cursor_moved()
    end,
  })

  -- DirChanged / FocusGained: invalidate cached git info and reconnect
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
  comments.setup()
end

function M.disable()
  enabled = false
  socket.disconnect({ no_reconnect = true })
end

function M.is_enabled()
  return enabled
end

return M
