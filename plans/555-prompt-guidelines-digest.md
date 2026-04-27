# Prompt guidelines digest

Issue: #555

This document is the repo's short source of truth for **where prompt guidance
belongs** and **where it does not**. The goal is to keep prompt intent legible
without turning every layer into a second system prompt.

## Why this exists

The repo already uses several prompt surfaces well, but they are layered across
root context files, runtime appenders, tool prompt snippets, and injected task
messages. Without one durable digest, guidance drifts and the same rule gets
repeated in the wrong place.

This digest defines:

- the prompt-surface hierarchy
- intended ownership for each layer
- when to use prose vs runtime enforcement
- the repo's preferred anti-sprawl rules
- the no-duplication contract for downstream overlays

## Source-of-truth hierarchy

### No-duplication contract

If a rule is defined in this digest or in the canonical root guidance it points
to, downstream overlays **must not duplicate that rule text**. They may only add
scoped extensions that depend on runtime role, persona, active transport,
current task context, or guardrail state.

In practice:

- root guidance owns durable repo-wide rules
- downstream overlays may add broker/worker/persona/guardrail deltas
- downstream task messages may add ephemeral task/thread specifics
- lower layers should cite or rely on higher-layer rules rather than restating them

This keeps the hierarchy legible and gives future dedupe work a clear authority:
remove repeated doctrine, keep only the layer-specific delta.

### 1. Runtime enforcement beats prose

If a rule must hold even when prompt text drifts, implement it in code.

Use runtime enforcement for:

- tool blocking or confirmation gates
- role restrictions that must never be bypassed
- message routing, reply-path, or delivery guarantees
- safety-sensitive policy where "the model should remember" is not enough

Strong in-repo examples:

- `slack-bridge/guardrails.ts` — broker tool restrictions are enforced, not just suggested
- Slack security prompt flow and tool-policy runtime — turn-level Slack restrictions stay tied to runtime state

### 2. Root context files carry durable repo-wide rules

`AGENTS.md` is the durable human-readable repo-wide guidance surface. It should
hold rules that are stable across sessions, models, and tasks.

Use `AGENTS.md` for:

- coding standards and typing rules
- workflow expectations that apply repo-wide
- git/worktree safety rules
- testing and review expectations
- durable communication norms that are not transport-specific

Do **not** use `AGENTS.md` for:

- ephemeral task instructions
- current issue-specific acceptance criteria
- transport/session state like "reply in this thread"
- model-specific execution nudges
- rules that really need runtime enforcement

### 3. `CLAUDE.md` should not become a second root source of truth

This repo currently has byte-identical `AGENTS.md` and `CLAUDE.md`. That is
explicitly a compatibility layer, not two independent policy documents.

Rule:

- `AGENTS.md` is the canonical editable root context file
- `CLAUDE.md` should either mirror `AGENTS.md` exactly or clearly point back to it
- do not let the two files diverge with separate policy text

If root guidance changes, update the strategy intentionally rather than editing
only one file.

### 4. `before_agent_start` appenders add session/runtime overlays

These overlays are extensions of the root guidance, not replacements for it.
They should carry only the runtime-scoped delta needed for the current role or
session.

Use `before_agent_start` only for guidance that depends on runtime role,
transport, model targeting, or currently active environment state.

Use appenders for:

- broker vs follower role overlays
- active agent identity / persona flavor
- model-targeted execution-bias overlays
- editor context snapshots that are fresh for one session turn
- currently active security prompt text derived from runtime policy

Do **not** use appenders for:

- repo-wide coding standards already covered in `AGENTS.md`
- long evergreen philosophy docs
- issue-specific instructions that belong in a task message
- hard policy that should be runtime-enforced instead

Strong in-repo examples:

- `slack-bridge/agent-prompt-guidance.ts` appends role-aware broker/worker guidance and bounded persona overlays
- `openai-execution-shaping/index.ts` appends a model-targeted execution overlay during `before_agent_start`
- `nvim-bridge/index.ts` injects current editor context only when it is fresh and relevant

### 5. Injected task messages carry ephemeral work context

Injected messages should also stay additive. They provide the current task or
thread context, not a second copy of repo doctrine.

If the instruction is specific to the current task, thread, or turn, inject it
as a message instead of growing the durable prompt layers.

Use injected task messages for:

- inbox items and pending Slack/Pinet work
- issue-specific acceptance criteria
- thread-local security context
- reaction-triggered requested actions
- editor/comment context that changes frequently
- bounded follow-up nudges after runtime inspection

Do **not** use injected task messages for:

- stable repo rules
- reusable role doctrine
- long-lived style guides

Strong in-repo examples:

- `slack-bridge/inbox-drain-runtime.ts` builds the actionable inbox prompt from pending work
- `slack-bridge/reaction-triggers.ts` turns reaction actions into explicit requested-task prompts
- `nvim-bridge/index.ts` sends PiComms/editor context as task guidance rather than permanent repo policy
- `openai-execution-shaping` hidden continuation nudges are injected as bounded follow-up messages, not permanent prompt text

### 6. Tool prompt snippets stay tool-local

Tool `promptSnippet` / `promptGuidelines` text should explain how to use that
specific tool well. They are not a substitute for repo policy.

Use tool-level prompt text for:

- required call sequencing
- argument pitfalls
- output-shape expectations
- tool-specific safety reminders

Do **not** use tool-level prompt text for:

- broad repo workflow doctrine
- agent persona doctrine for the whole session
- cross-tool release or coding policy

## Do / don't digest

### Do

- keep durable repo rules in one root source of truth
- treat downstream overlays as scoped extensions, not duplicate policy documents
- use runtime appenders for role- or state-dependent overlays
- send ephemeral task context as messages
- enforce non-negotiable rules in code
- point new prompt work at strong in-repo examples before inventing new layers
- prefer short, bounded overlays over sprawling motivational prose

### Don't

- duplicate the same rule across root files, downstream overlays, task messages, and tool snippets
- encode hard safety or role restrictions only in prose
- put issue-specific asks into `AGENTS.md`
- stuff evergreen repo doctrine into `before_agent_start`
- let `AGENTS.md` and `CLAUDE.md` drift into separate policies
- use persona/style guidance to change correctness, safety, or reporting discipline

## Preferred style references in this repo

When adding or reviewing prompt text, use these as the style bar:

- **Role overlays:** `slack-bridge/agent-prompt-guidance.ts`
- **Runtime-enforced guardrails:** `slack-bridge/guardrails.ts`
- **Bounded personality guidance:** `slack-bridge/helpers.ts` (`buildAgentPersonalityGuidelines` and skin helpers)
- **Ephemeral task injection:** `slack-bridge/inbox-drain-runtime.ts`, `slack-bridge/reaction-triggers.ts`, `nvim-bridge/index.ts`
- **Model-targeted overlays:** `openai-execution-shaping/index.ts`

These examples share the same pattern:

- small overlay
- clear ownership
- runtime state where needed
- enforcement in code when the rule matters operationally

## Review checklist for future prompt changes

Before adding prompt text, ask:

1. Is this durable repo policy? Put it in `AGENTS.md`.
2. Is this runtime-role or session-state dependent? Use `before_agent_start` for the layer-specific delta only.
3. Is this only about the current task or thread? Inject a message instead.
4. Is this a rule that must hold no matter what? Enforce it in code.
5. Is this tool-specific guidance? Keep it on the tool surface only.
6. Am I duplicating guidance that already exists elsewhere? If yes, delete or reference instead of repeating.

## Recommended root-context strategy

For this repo:

- keep `AGENTS.md` as the canonical root guidance file
- keep `CLAUDE.md` aligned as a compatibility mirror or explicit pointer
- place prompt-layering/design rationale in `plans/` docs like this one
- keep implementation-specific overlays near the runtime that owns them

That gives the repo one durable digest, one canonical root policy surface, and
clear boundaries for appenders, injected messages, and runtime enforcement.
