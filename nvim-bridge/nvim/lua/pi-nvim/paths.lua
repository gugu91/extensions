local M = {}

local uv = vim.uv or vim.loop

function M.worktree_root()
  local root = vim.fn.systemlist('git rev-parse --show-toplevel 2>/dev/null')[1]
  if vim.v.shell_error ~= 0 or not root then
    return nil
  end
  return uv.fs_realpath(root) or root
end

function M.relative_to_worktree(bufpath, worktree)
  if not bufpath or bufpath == '' or not worktree then
    return nil
  end
  local canonical = uv.fs_realpath(bufpath) or vim.fn.fnamemodify(bufpath, ':p')
  if vim.startswith(canonical, worktree .. '/') then
    return canonical:sub(#worktree + 2)
  end
  return nil
end

function M.buffer_path_and_side(worktree)
  local bufpath = vim.api.nvim_buf_get_name(0)
  if bufpath == '' then
    return nil, nil
  end

  if vim.startswith(bufpath, 'fugitive://') and vim.fn.exists('*FugitiveParse') == 1 then
    local parsed = vim.fn.FugitiveParse(bufpath)
    local object = parsed[1] or ''
    local file = object:match('^:0:(.+)$') or object:match('^[^:]+:(.+)$')
    return file, file and 'old' or nil
  end

  local relative = M.relative_to_worktree(bufpath, worktree)
  if relative then
    return relative, 'new'
  end

  if vim.wo.diff then
    local current_win = vim.api.nvim_get_current_win()
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if win ~= current_win and vim.wo[win].diff then
        local paired =
          M.relative_to_worktree(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)), worktree)
        if paired then
          return paired, 'old'
        end
      end
    end
  end

  return nil, nil
end

function M.resolve_worktree_path(filepath)
  if not filepath or filepath == '' or vim.startswith(filepath, '/') then
    return filepath
  end
  local worktree = M.worktree_root()
  return worktree and (worktree .. '/' .. filepath) or nil
end

return M
