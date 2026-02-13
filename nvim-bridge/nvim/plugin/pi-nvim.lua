-- pi-nvim: bridge neovim editor context to pi coding agent
-- This file is loaded automatically when the plugin is in runtimepath.

if vim.g.loaded_pi_nvim then
  return
end
vim.g.loaded_pi_nvim = true

-- User commands
vim.api.nvim_create_user_command("PiNvimEnable", function()
  require("pi-nvim").enable()
end, { desc = "Enable pi-nvim bridge" })

vim.api.nvim_create_user_command("PiNvimDisable", function()
  require("pi-nvim").disable()
end, { desc = "Disable pi-nvim bridge" })

vim.api.nvim_create_user_command("PiNvimStatus", function()
  local pi = require("pi-nvim")
  local sock = require("pi-nvim.socket")
  local status = pi.is_enabled() and "enabled" or "disabled"
  local conn = sock.is_connected() and "connected" or "disconnected"
  vim.notify(string.format("pi-nvim: %s (%s)", status, conn), vim.log.levels.INFO)
end, { desc = "Show pi-nvim bridge status" })
