# #475 — broker prompt layering on `main`

This note records the current repo-level source of truth for broker prompt layering.
It documents what `main` does today. It does **not** propose new prompt semantics.

## Current repo truth

### Project-level prompt files

Current `main` has:

- no project `.pi/SYSTEM.md`
- no project `.pi/APPEND_SYSTEM.md`

So this repo does **not** replace Pi's base system prompt at the project level, and it does **not** append a project-scoped system prompt fragment through those files.

### Root context files

Current `main` does have root context files:

- `AGENTS.md`
- `CLAUDE.md`

Per Pi's documented loading model:

- project `.pi/SYSTEM.md` would replace the default system prompt
- project `.pi/APPEND_SYSTEM.md` would append to it
- `AGENTS.md` / `CLAUDE.md` are loaded as context files
- `before_agent_start` can modify the current turn's effective system prompt

At repo scope, that means broker turns in this repo inherit Pi's upstream effective prompt first — i.e. the prompt Pi has already assembled before `slack-bridge` runs, including the upstream base prompt selection plus root `AGENTS.md` / `CLAUDE.md` context that Pi loaded for the repo.

## `slack-bridge` broker append layer

`slack-bridge/agent-prompt-guidance.ts` does not replace the incoming prompt. It appends to `event.systemPrompt` in `before_agent_start`:

```ts
return {
  systemPrompt: event.systemPrompt + "\n\n" + buildPromptGuidelines().join("\n"),
};
```

For broker turns, the append order is:

1. identity guidance (`buildIdentityReplyGuidelines()` via `getIdentityGuidelines()`)
2. personality guidance (`buildAgentPersonalityGuidelines()`)
3. reaction guidance (`buildReactionPromptGuidelines()`)
4. optional skin guidance (`buildPinetSkinPromptGuideline()`) when a skin theme/personality is active
5. broker guidance (`buildBrokerPromptGuidelines()`)
6. broker tool guardrails (`buildBrokerToolGuardrailsPrompt()`)

Collapsed to the narrow broker-specific layers for this issue, the order is:

1. identity / personality / reaction
2. broker guidance
3. broker tool guardrails

## What this issue verifies

The narrow regression slice for #475 is:

- document this repo-level prompt layering truth in this file
- keep broker prompt semantics unchanged
- add one root-runtime integration test proving that an incoming sentinel `systemPrompt` survives as the prefix, with the broker guidance layers appended after it

## Evidence in repo

- `slack-bridge/agent-prompt-guidance.ts`
- `slack-bridge/agent-prompt-guidance.test.ts`
- `slack-bridge/index.test.ts`

## Upstream Pi references

- `README.md` — context files and `.pi/SYSTEM.md` / `APPEND_SYSTEM.md`
- `docs/extensions.md` — `before_agent_start` can replace or extend the current turn system prompt
