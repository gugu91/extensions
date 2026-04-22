# Reviewer agent port — built-in `Agent` → `pi-subagents`

> Audience: whoever is installing the new reviewer on the mesh. Currently the
> pi built-in `Agent` tool is broken (`"path" argument must be of type string`
> on every spawn), and the `twin` model is unavailable. This doc maps the
> existing `~/.pi/agent/agents/code-reviewer.md` to the format that
> **`pi-subagents`** (npm package `pi-subagents`, maintained by
> `nicopreme` / repo `nicobailon/pi-subagents`) expects.
>
> The human copies the ported file into `~/.pi/agent/agents/code-reviewer.md`
> once the mapping here is approved. This worktree only holds the plan files.

## 1. What we're porting to

`pi-subagents` is a pi extension (`pi install npm:pi-subagents`) that ships
the `subagent` tool plus slash commands (`/run`, `/chain`, `/parallel`,
`/agents`, `/subagents-status`).

**Agent-file discovery** (priority high → low):

| Scope   | Path                                      | Notes                                       |
| ------- | ----------------------------------------- | ------------------------------------------- |
| Project | `.pi/agents/{name}.md` (walks up)         | Wins on name collisions                     |
| User    | `~/.pi/agent/agents/{name}.md`            | Same path the existing reviewer lives at    |
| Builtin | `~/.pi/agent/extensions/subagent/agents/` | Ships with `scout`, `reviewer`, `worker`, … |

So the ported file keeps the **same on-disk location** we already use:
`~/.pi/agent/agents/code-reviewer.md`. No relocation required.

Legacy `.agents/{name}.md` is still read as a fallback, but new writes go to
`.pi/agents/`.

## 2. Frontmatter field mapping

Current reviewer frontmatter (pi built-in `Agent`):

```yaml
---
name: code-reviewer
description: GitHub PR reviewer that defaults to twin, posts to PiComms and GitHub, and uses a playful self-chosen signature
tools: read, bash, grep, find, ls, comment_add, comment_list
model: twin
---
```

Ported frontmatter (`pi-subagents`):

```yaml
---
name: code-reviewer
description: GitHub PR reviewer that defaults to twin, posts to PiComms and GitHub, and uses a playful self-chosen signature
model: twin
fallbackModels: anthropic/claude-opus-4-7, anthropic/claude-sonnet-4-5
tools: read, bash, grep, find, ls, comment_add, comment_list
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---
```

### Field-by-field

| Old field                             | New field / semantics                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                | Same. Identity used by `subagent` tool and `/run code-reviewer`.                                                                                                                                                                                                                                                                                                                              |
| `description`                         | Same. Surfaces in `/agents` TUI and LLM-facing agent list.                                                                                                                                                                                                                                                                                                                                    |
| `model: twin`                         | Kept as stated default (see §3 for caveat).                                                                                                                                                                                                                                                                                                                                                   |
| `tools: …, comment_add, comment_list` | Keep `comment_add` / `comment_list` in `tools`. In `pi-subagents`, a present `tools:` field becomes Pi's `--tools` allowlist, and Pi applies that allowlist to **both builtin and extension tool names**. `comment_add` / `comment_list` are extension tools from `nvim-bridge`, so dropping them would break PiComms posting. Keep: `read, bash, grep, find, ls, comment_add, comment_list`. |
| _(implicit extensions)_               | Leave `extensions` **absent** so `nvim-bridge` and the rest of the normal extension set still load. Extension loading alone is not enough when `tools:` is present — the loaded tool names must also survive the `--tools` allowlist. Explicit extension-path allowlisting is still fragile across machines.                                                                                  |

### Added fields (explicit, even though they're defaults)

| Field                          | Value   | Rationale                                                                                                                                                                                           |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemPromptMode: replace`    | default | The reviewer body is a full system prompt — we do **not** want pi's normal base prompt appended. Setting this explicitly documents intent and guards against future default changes.                |
| `inheritProjectContext: false` | default | A code reviewer should judge the diff on its own merits. Inheriting `AGENTS.md` / `CLAUDE.md` would bias verdicts toward repo conventions. Matches the README's "Fully isolated specialist" recipe. |
| `inheritSkills: false`         | default | No reason to drop the whole skills catalog into the reviewer's context.                                                                                                                             |
| `fallbackModels`               | new     | Ordered backup when `twin` is unavailable on the mesh. Only triggers on provider/model-availability errors, not on tool errors — so a bad `gh` call still fails loudly. See §3.                     |

Fields we intentionally **omit** (all default to the behavior we want):
`thinking`, `skill`, `output`, `defaultReads`, `defaultProgress`, `interactive`,
`maxSubagentDepth`, `extensions`.

## 3. Model override pattern

The reviewer's opening paragraph already says _"If the caller launched you
with an explicit model override, use that override. Otherwise, default to
`twin`."_ In `pi-subagents` the override is surfaced in three ways:

### 3.1 Via the `subagent` tool (programmatic)

```jsonc
{
  "agent": "code-reviewer",
  "task": "Review PR #523",
  "model": "anthropic/claude-opus-4-7",
}
```

The `model` param on a single-agent call wins over the agent's frontmatter
default.

### 3.2 Via slash command (interactive)

```
/run code-reviewer[model=anthropic/claude-opus-4-7] "Review PR #523"
```

Inline `[key=value,…]` overrides are supported on `/run`, `/chain`, and
`/parallel`.

### 3.3 Via chain step config

```jsonc
{
  "chain": [
    { "agent": "scout", "task": "{task}" },
    { "agent": "code-reviewer", "task": "Review {previous}", "model": "anthropic/claude-opus-4-7" },
  ],
}
```

### 3.4 Current mesh reality

`twin` is not exposed on this mesh right now. `Goat` and `Turtle` both had to
fall back to `anthropic/claude-opus-4-7` for PRs #511, #516, #518, #523.

Two options for handling that cleanly:

1. **Keep `model: twin` + rely on `fallbackModels`**. Frontmatter declares
   intent; `fallbackModels` carries the mesh. Works as long as the primary
   failure is a provider/model-availability error and not a silent hang.
2. **Flip the default to opus for now**. Set `model: anthropic/claude-opus-4-7`
   and note in the body that the historical default is `twin`. Simpler but
   rewrites intent every time the mesh changes.

The ported file uses **option 1** — it keeps `twin` as the stated intent,
matches the existing reviewer text verbatim, and documents the fallback chain
so the caller doesn't have to remember the override each time.

If we ever see `twin` stall instead of erroring (not a provider/availability
error), `fallbackModels` won't trip — callers should pass `model=` explicitly
in that case.

## 4. Reviewer body — unchanged

The markdown body ports **verbatim**. Specifically, the following sections are
preserved without edits:

- **Default review target** — GitHub PR preferred, no silent fallback to
  unstaged local changes
- **Autonomy and safety** — read-only with two side effects (PiComms +
  GitHub review comments), explicit allowlist and disallowlist for bash
- **Review priorities** — bugs → architecture → security
- **Verification expectations** — targeted tests / lint / typecheck before
  finalizing
- **Decision policy** — strict, default to Block
- **Tone** — teaching mode
- **Signature and reviewer name** — self-chosen 1-2 word Title Case playful
  codename, consistent within a run
- **PiComms reporting** — thread `pr-<number>-review` or `code-review`
  fallback, signature + blank line prefix
- **GitHub reporting** — `gh pr review --comment` or `gh pr comment`
- **Output format** — Verdict / Review Scope / Findings / Checklist /
  Summary

No semantic changes. The port is frontmatter-only.

## 5. Where callers invoke it

### One-shot review (most common)

```
/run code-reviewer[model=anthropic/claude-opus-4-7] "Review PR #523"
```

Or via the Agents Manager TUI (`Ctrl+Shift+A` / `/agents`).

### From another agent / chain step

The `subagent` tool call above.

### From Pinet delegation

Agents inside this mesh that need a review should still reply via
`pinet_message` with the final verdict. The reviewer posts to PiComms and
GitHub itself; the delegating agent just relays the summary.

## 6. Caveats & known issues

1. **Worktree + extension clash.** When the reviewer is spawned with `cwd`
   inside a worktree that contains its own `.pi/extensions/browser-playwright/index.ts`,
   pi tries to register every browser tool twice — once from
   `~/.pi/agent/extensions/browser-playwright/index.ts` and once from the
   worktree's copy — and the child subagent aborts at startup before any
   tool runs. This is **not** an agent-definition issue; it's a pi/extension
   loader issue. Current workaround (the "Goat / Turtle pattern"):

   ```bash
   cd .worktrees/<review-worktree>
   mv .pi/extensions/browser-playwright/index.ts \
      .pi/extensions/browser-playwright/index.ts.turtle-disabled
   ```

   Non-destructive (we remove the worktree after the review anyway). We
   should file a separate issue against `pi-subagents` or pi-core to
   de-duplicate identical extension registrations before the child spawns.

2. **`twin` unavailable on current mesh.** Callers must pass
   `model=anthropic/claude-opus-4-7` until `twin` is back, or rely on
   `fallbackModels`. See §3.

3. **`tools:` constrains extension tools too.** In `pi-subagents`, a
   present `tools:` field becomes Pi's `--tools` allowlist, and Pi applies
   that list to both builtin and extension tool names. For this reviewer,
   `comment_add` and `comment_list` must stay in the list or PiComms posting
   will fail.

4. **PiComms posting depends on both extension loading and tool allowlisting.**
   Leaving `extensions:` absent ensures `nvim-bridge` loads in the child,
   and keeping `comment_add` / `comment_list` in `tools:` ensures those
   extension tools remain callable. If a future reviewer variant sets
   `extensions:` to an allowlist, that allowlist must still include the
   `nvim-bridge` extension path.

5. **Built-in `Agent` tool is currently broken.** Separate from this port.
   Every `Agent` call across every `subagent_type` fails with
   `The "path" argument must be of type string. Received undefined`. Once
   the built-in tool is fixed we'll have two viable routes for calling the
   reviewer (built-in `Agent` + `pi-subagents`); until then, `pi-subagents`
   is the only working path.

## 7. Install & rollback

**Install** (human runs after approving this mapping):

```bash
mkdir -p ~/.pi/agent/agents
if [ -f ~/.pi/agent/agents/code-reviewer.md ]; then
  cp ~/.pi/agent/agents/code-reviewer.md ~/.pi/agent/agents/code-reviewer.md.pre-pi-subagents.bak
fi
cp plans/reviewer-code-reviewer.nicopreme.md ~/.pi/agent/agents/code-reviewer.md
```

**Rollback** (restore the pre-port file or pre-install absence):

```bash
if [ -f ~/.pi/agent/agents/code-reviewer.md.pre-pi-subagents.bak ]; then
  cp ~/.pi/agent/agents/code-reviewer.md.pre-pi-subagents.bak ~/.pi/agent/agents/code-reviewer.md
else
  rm -f ~/.pi/agent/agents/code-reviewer.md
fi
```

This keeps rollback copy-based and backup-first, with no assumption that
`~/.pi/agent` is itself a git repo.

## 8. Smoke test after install

```
/run code-reviewer[model=anthropic/claude-opus-4-7] "Sanity-check yourself: print your frontmatter back, state your signature rule, and confirm that `comment_add` and `comment_list` remain available. Do not post anywhere."
```

Expected:

- Response begins with `*Will's reviewer agent <ChosenName>*`
- Agent acknowledges `model: twin` as the stated default but recognizes the
  `model=anthropic/claude-opus-4-7` override.
- Agent confirms `comment_add` and `comment_list` remain available, preserving
  the PiComms posting path.
- No PiComms comment, no GitHub comment (we told it not to).

If the self-check passes, run it against a low-stakes real PR with
`/run code-reviewer[model=anthropic/claude-opus-4-7] "Review PR #<n>"`
and confirm the PiComms thread `pr-<n>-review` + GitHub PR comment both
land.
