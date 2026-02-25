local comments = require('pi-nvim.comments')
local events = require('pi-nvim.events')
local socket = require('pi-nvim.socket')

local M = {}

local enabled = false

function M.setup(opts)
  opts = vim.tbl_deep_extend('force', {
    comment_keymap = '<leader>pc',
    a2a_comment_keymap = '<leader>pa',
    a2a_open_keymap = '<leader>pl',
  }, opts or {})

  enabled = true

  -- Connect socket on startup
  socket.connect()
  comments.setup()

  -- Command: add a free-form one-shot comment for agent context.
  if vim.fn.exists(':PiNvimComment') == 0 then
    vim.api.nvim_create_user_command('PiNvimComment', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      events.open_comment_window(cmd_opts.line1, cmd_opts.line2)
    end, {
      desc = 'Open a context comment window and send to pi',
      range = true,
    })
  end

  -- A2A comments timeline commands.
  if vim.fn.exists(':PiCommentsOpen') == 0 then
    vim.api.nvim_create_user_command('PiCommentsOpen', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      local thread_id = cmd_opts.args ~= '' and cmd_opts.args or nil
      comments.open(thread_id)
    end, {
      desc = 'Open A2A comments timeline',
      nargs = '?',
    })
  end

  if vim.fn.exists(':PiCommentsRefresh') == 0 then
    vim.api.nvim_create_user_command('PiCommentsRefresh', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end
      local thread_id = cmd_opts.args ~= '' and cmd_opts.args or nil
      comments.refresh({ thread_id = thread_id, open_if_missing = true })
    end, {
      desc = 'Refresh A2A comments timeline',
      nargs = '?',
    })
  end

  if vim.fn.exists(':PiCommentAdd') == 0 then
    vim.api.nvim_create_user_command('PiCommentAdd', function(cmd_opts)
      if not enabled then
        vim.notify('pi-nvim: bridge is disabled', vim.log.levels.WARN)
        return
      end

      local thread_id = cmd_opts.args ~= '' and cmd_opts.args or nil
      local has_range = (cmd_opts.range or 0) > 0

      comments.open_composer({
        thread_id = thread_id,
        start_line = has_range and cmd_opts.line1 or nil,
        end_line = has_range and cmd_opts.line2 or nil,
      })
    end, {
      desc = 'Add a persistent A2A comment',
      range = true,
      nargs = '?',
    })
  end

  -- Optional shortcut (default: <leader>pc) for one-shot context comments.
  if opts.comment_keymap and opts.comment_keymap ~= '' then
    local map_opts = { silent = true, desc = 'pi-nvim: context comment' }
    vim.keymap.set('x', opts.comment_keymap, ":<C-u>'<,'>PiNvimComment<CR>", map_opts)
    vim.keymap.set('n', opts.comment_keymap, ':<C-u>.,.PiNvimComment<CR>', map_opts)
  end

  -- Optional shortcut (default: <leader>pa) for persistent A2A comments.
  if opts.a2a_comment_keymap and opts.a2a_comment_keymap ~= '' then
    local map_opts = { silent = true, desc = 'pi-nvim: add A2A comment' }
    vim.keymap.set('x', opts.a2a_comment_keymap, ":<C-u>'<,'>PiCommentAdd<CR>", map_opts)
    vim.keymap.set('n', opts.a2a_comment_keymap, ':<C-u>PiCommentAdd<CR>', map_opts)
  end

  -- Optional shortcut (default: <leader>pl) to open timeline.
  if opts.a2a_open_keymap and opts.a2a_open_keymap ~= '' then
    local map_opts = { silent = true, desc = 'pi-nvim: open A2A comments timeline' }
    vim.keymap.set('n', opts.a2a_open_keymap, ':<C-u>PiCommentsOpen<CR>', map_opts)
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
