-- pi-nvim: bridge neovim editor context to pi coding agent
-- This file is loaded automatically when the plugin is in runtimepath.

if vim.g.loaded_pi_nvim then
  return
end
vim.g.loaded_pi_nvim = true

-- User commands
vim.api.nvim_create_user_command('PiNvimEnable', function()
  require('pi-nvim').enable()
end, { desc = 'Enable pi-nvim bridge' })

vim.api.nvim_create_user_command('PiNvimDisable', function()
  require('pi-nvim').disable()
end, { desc = 'Disable pi-nvim bridge' })

vim.api.nvim_create_user_command('PiNvimStatus', function()
  local pi = require('pi-nvim')
  local sock = require('pi-nvim.socket')
  local status = pi.is_enabled() and 'enabled' or 'disabled'
  local conn = sock.is_connected() and 'connected' or 'disconnected'
  vim.notify(string.format('pi-nvim: %s (%s)', status, conn), vim.log.levels.INFO)
end, { desc = 'Show pi-nvim bridge status' })

vim.api.nvim_create_user_command('PinetComment', function(opts)
  require('pi-nvim.comments').create({
    body = opts.args ~= '' and opts.args or nil,
    start_line = opts.range > 0 and opts.line1 or nil,
    end_line = opts.range > 0 and opts.line2 or nil,
  })
end, {
  desc = 'Create a Pinet contextual thread on the current file line/range',
  nargs = '*',
  range = true,
})

vim.api.nvim_create_user_command('PinetThreads', function()
  require('pi-nvim.comments').refresh({ include_resolved = true })
end, { desc = 'List and sign Pinet contextual threads for the current file' })

vim.api.nvim_create_user_command('PinetReply', function(opts)
  require('pi-nvim.comments').reply(opts.fargs[1], table.concat(vim.list_slice(opts.fargs, 2), ' '))
end, { desc = 'Reply to a Pinet contextual thread', nargs = '+' })

vim.api.nvim_create_user_command('PinetResolve', function(opts)
  require('pi-nvim.comments').resolve(opts.args ~= '' and opts.args or nil, true)
end, { desc = 'Resolve a Pinet contextual thread', nargs = '?' })

vim.api.nvim_create_user_command('PinetReopen', function(opts)
  require('pi-nvim.comments').resolve(opts.args ~= '' and opts.args or nil, false)
end, { desc = 'Reopen a Pinet contextual thread', nargs = '?' })

vim.api.nvim_create_user_command('PinetThreadOpen', function(opts)
  require('pi-nvim.comments').open_thread(opts.args ~= '' and opts.args or nil)
end, { desc = 'Open a Pinet contextual thread pane', nargs = '?' })

vim.api.nvim_create_user_command('PinetOwner', function(opts)
  require('pi-nvim.comments').document_owner(opts.args ~= '' and opts.args or nil)
end, { desc = 'Set the current document Pinet owner', nargs = '?' })

vim.api.nvim_create_user_command('PinetSubscribe', function(opts)
  require('pi-nvim.comments').document_subscribe(opts.args ~= '' and opts.args or nil, true)
end, { desc = 'Subscribe an agent to the current document', nargs = '?' })

vim.api.nvim_create_user_command('PinetUnsubscribe', function(opts)
  require('pi-nvim.comments').document_subscribe(opts.args ~= '' and opts.args or nil, false)
end, { desc = 'Unsubscribe an agent from the current document', nargs = '?' })

vim.api.nvim_create_user_command('PinetSubscribers', function()
  require('pi-nvim.comments').document_status()
end, { desc = 'Show current document owner and subscribers' })

vim.api.nvim_create_user_command('PinetBindSlack', function(opts)
  require('pi-nvim.comments').document_bind_thread(opts.args)
end, { desc = 'Bind a Slack thread to the current document', nargs = 1 })

vim.keymap.set('n', ']p', function()
  require('pi-nvim.comments').next()
end, { desc = 'Next Pinet contextual thread' })

vim.keymap.set('n', '[p', function()
  require('pi-nvim.comments').prev()
end, { desc = 'Previous Pinet contextual thread' })
