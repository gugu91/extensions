---
name: wipe-a2a-comments
description: Deprecated legacy PiComms cleanup note. Use when a user asks to clear/reset/remove old PiComms comments and explain that nvim-bridge now has PiComms disabled.
---

# Deprecated PiComms Cleanup

PiComms is disabled in the active `nvim-bridge` environment. Do **not** call `comment_wipe_all`; that tool is no longer registered by `nvim-bridge`.

## Preferred response

1. Explain that Neovim currently syncs editor context only; durable coordination should use Pinet directly.
2. Do not create or reinitialize `.pi/a2a/comments`.
3. If the user explicitly wants legacy local artifacts deleted, remove only the legacy comments directory after confirming intent:

```bash
bash -lc '
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
comments_dir="$repo_root/.pi/a2a/comments"
if [ -d "$comments_dir" ]; then
  rm -rf "$comments_dir"
  echo "Removed legacy PiComms comments directory: $comments_dir"
else
  echo "No legacy PiComms comments directory found: $comments_dir"
fi
'
```

## Notes

- This is legacy cleanup only.
- Do not use this as a coordination path; use Pinet lanes, inbox, and Slack/Pinet threads instead.
- The fuller Neovim-to-Pinet adapter replacement is tracked in GitHub issue #714.
