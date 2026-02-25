---
name: wipe-a2a-comments
description: Wipes all persistent A2A comments for the current git repository. Use when the user asks to clear/reset/remove all comments.
---

# Wipe A2A Comments

Use this skill when the user wants to delete **all** stored A2A comments in the current repository.

## Preferred flow

1. Verify the user intent is destructive and explicit.
2. Call the `comment_wipe_all` tool.
3. Report how many comments were removed.

## Fallback (if the tool is unavailable)

Run this repo-local reset command:

```bash
bash -lc '
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
comments_dir="$repo_root/.pi/a2a/comments"
removed=0
if [ -d "$comments_dir/meta" ]; then
  removed="$(find "$comments_dir/meta" -type f -name "*.json" | wc -l | tr -d " ")"
fi
rm -rf "$comments_dir"
mkdir -p "$comments_dir/items" "$comments_dir/meta"
updated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
cat > "$comments_dir/index.json" <<EOF
{
  "version": 1,
  "updatedAt": "$updated_at",
  "comments": []
}
EOF
echo "Wiped A2A comments in repo: $repo_root"
echo "Removed comments: $removed"
'
```

## Notes

- This wipe is **per git repository**.
- This only affects `.pi/a2a/comments` in the current repo.
