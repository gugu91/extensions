# @gugu910/pi-openai-execution-shaping

Experimental Pi extension that prototypes a **narrow, extension-only** version of the missing OpenClaw-style execution shaping for **OpenAI / OpenAI Codex GPT-5** models.

## What this prototype does

When explicitly enabled, the extension:

- targets only configured `openai` / `openai-codex` GPT-5-family models
- appends a stronger **execution-biased overlay** for those models
- detects some **plan-only / commentary-only** endings with no tool progress
- injects a **hidden follow-up user-equivalent nudge** to keep the model acting

This is intentionally a **prototype extension**, not a Pi core rewrite.

## What it does not do

This package does **not** reimplement Pi core behavior such as:

- provider transport changes
- tool-schema normalization
- low-level OpenAI replay handling
- native incomplete-turn retry semantics inside the core agent loop
- explicit `working` / `paused` / `blocked` / `abandoned` run-state surfacing

Those either already landed upstream in Pi, or would require upstream SDK/core seams beyond a clean extension prototype.

## Configuration

The extension is **disabled by default**. Enable it explicitly in either:

- project-local `.pi/settings.json`, or
- global `~/.pi/agent/settings.json`

under the `"openai-execution-shaping"` key.

### Minimal example

```json
{
  "openai-execution-shaping": {
    "enabled": true
  }
}
```

### Full example

```json
{
  "openai-execution-shaping": {
    "enabled": true,
    "providers": ["openai", "openai-codex"],
    "modelRegex": "^gpt-5",
    "promptOverlay": {
      "enabled": true
    },
    "autoContinue": {
      "enabled": true,
      "maxTurns": 1
    },
    "debug": false
  }
}
```

### Config fields

- `enabled` — master switch; must be `true` to do anything
- `providers` — provider ids to target; defaults to `openai` and `openai-codex`
- `modelRegex` — case-insensitive regex matched against the normalized model id; defaults to `^gpt-5`
- `promptOverlay.enabled` — append the execution-bias overlay during `before_agent_start`; default `true`
- `autoContinue.enabled` — send the hidden continuation nudge after detected commentary-only drift; default `true`
- `autoContinue.maxTurns` — bounded number of extension follow-up turns per user prompt; default `1`, clamped to `0..5`
- `debug` — show lightweight TUI notifications when the extension auto-continues

## Status command

The extension registers:

- `/openai-execution-shaping-status`

It reports whether the extension is enabled, whether the current model is targeted, the loaded config source, and the current continuation counter.

## How the prototype works

### 1) Prompt overlay

On `before_agent_start`, targeted models receive extra instructions that bias them toward:

- acting first when the next step is clear
- treating commentary-only turns as incomplete
- continuing through multi-step work until complete or genuinely blocked
- avoiding unnecessary permission asks after a single exploratory step

### 2) Bounded auto-continue

On `agent_end`, the extension looks for a narrow class of likely drift:

- final assistant turn
- `stopReason === "stop"`
- **no tool results** for the prompt
- no assistant tool calls in the final message
- text that looks like future-intent / approval-handoff commentary
- no obvious completion language or genuine blocker question

When that pattern matches, the extension injects a **hidden custom message** with `triggerTurn: true`.

That custom message participates in LLM context as a user-equivalent steer, but stays hidden from the TUI (`display: false`).

## Known limitations

This package is intentionally constrained by the current Pi extension/runtime seams.

### What the extension can do cleanly

- add model-targeted prompt shaping
- inspect completed turns and issue bounded hidden follow-up nudges
- keep the experiment opt-in and tightly scoped to OpenAI/Codex GPT-5 models

### What still needs Pi core support for a cleaner implementation

- treating plan-only / commentary-only turns as **core incomplete-turn retries** instead of post-hoc follow-up turns
- detecting and handling **one-action-then-narrative** patterns *inside* the agent loop rather than only after `agent_end`
- surfacing richer lifecycle states like `blocked` / `paused` / `abandoned`
- provider/model-specific prompt overlays integrated at the core prompt builder layer

So this prototype should be read as:

> the narrowest extension-only slice that demonstrates the behavior-shaping idea without upstream Pi core changes.

## Development

```bash
pnpm --filter @gugu910/pi-openai-execution-shaping lint
pnpm --filter @gugu910/pi-openai-execution-shaping typecheck
pnpm --filter @gugu910/pi-openai-execution-shaping test
pnpm --filter @gugu910/pi-openai-execution-shaping build
```
