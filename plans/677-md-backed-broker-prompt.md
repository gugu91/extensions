# Issue #677 — MD-backed broker prompt loading plan

## Slack-thread outcome

The SOUL.md thread converged away from global user preferences and away from a setting-first selector. The requested shape is:

- MD files are the source of broker prompt content.
- Broker guidance can be replaced wholesale from loaded MD content.
- Followers/workers stay append-only guidance or skill-backed.
- Hard broker guardrails/tool restrictions remain outside the replaceable MD prompt and are appended after it.

## Current code paths

- `slack-bridge/agent-event-runtime.ts` registers `before_agent_start` and routes it to `createAgentPromptGuidance(...).beforeAgentStart`.
- `slack-bridge/agent-prompt-guidance.ts` currently appends all extension prompt guidance to Pi's incoming `event.systemPrompt`.
- Role selection is runtime-driven through `deps.getBrokerRole()`:
  - `"broker"` appends `buildBrokerPromptGuidelines(...)`, then `buildBrokerToolGuardrailsPrompt()`.
  - `"follower"` appends `buildWorkerPromptGuidelines()`.
- Replaceable broker text is currently in `slack-bridge/helpers.ts` (`buildBrokerPromptGuidelines`). Non-negotiable tool restrictions live partly in that helper and partly in `slack-bridge/guardrails.ts` (`BROKER_FORBIDDEN_TOOLS`, `isBrokerForbiddenTool`, `buildBrokerToolGuardrailsPrompt`).
- Runtime enforcement already blocks broker use of `Agent`, `edit`, and `write` in `slack-bridge/slack-tool-policy-runtime.ts`; prompt text should describe that enforcement, not be the only protection.

## Proposed MD discovery and selection

Use conventional MD discovery, not a settings-first selector:

1. Workspace-local broker prompt override, resolved from the repository/worktree root: `.pi/slack-bridge/broker-prompt.md`.
2. Private user-local broker prompt override: `~/.pi/agent/slack-bridge/broker-prompt.md`.
3. Packaged default: `slack-bridge/prompts/broker/default.md` in source, copied into the built/published package.

The loader scans candidates in that order and chooses the first candidate that exists and passes readability, path-safety, UTF-8/content, and size checks. Invalid higher-priority candidates produce a privacy-safe warning but do not shadow lower-priority valid candidates; for example, an oversized workspace file falls through to the user-local file before falling back to the packaged default. Each file is broker-only prompt content; it is not global SOUL context and is not loaded for followers.

Operational notes:

- If `.pi/slack-bridge/broker-prompt.md` is intended to be private, add `.pi/slack-bridge/broker-prompt.local.md` as a later explicit convention and gitignore it. For the first slice, keep one workspace path plus one user path to avoid selector sprawl.
- The packaged default should be extracted from the current broker guidance so behavior is preserved when no override exists.
- Packaging must be part of the slice: current `slack-bridge/package.json` publishes `dist/`, README/LICENSE/manifest, and skills, while `scripts/build-package.mjs` copies TypeScript into `dist/`. Copy bundled broker prompt MD files into `dist/prompts/broker/`, include that path in the published package, and verify loading from the packaged artifact, not only from the repo checkout.
- The loader should report diagnostics like `broker prompt: workspace override loaded` or `broker prompt: packaged default loaded`, never the prompt body.
- Cap loaded content size and reject binary/non-UTF-8-looking content with a clear warning/fallback to packaged default.

## Prompt assembly and guardrail ordering

For broker sessions, assemble the system prompt as:

1. Pi's incoming `event.systemPrompt`.
2. Existing identity/personality/reaction/skin guidance that applies to all Slack/Pinet agents.
3. Loaded broker MD prompt content, replacing today's `buildBrokerPromptGuidelines(...)` output.
4. A narrow non-replaceable broker protocol/tool guardrail block appended after the MD content.

The hard block should not preserve the entire current broker policy as code-owned prompt text. This extension provides a broker communication protocol; operators may replace broker strategy/policy in MD even when that lets them make risky workflow choices. Code-owned prompt text should be limited to constraints that are backed by runtime/tool enforcement or required to explain the protocol boundary:

- broker sessions cannot directly call forbidden tools: `Agent`, `edit`, and `write`;
- local-subagent spawning through the `Agent` tool remains blocked for brokers;
- MD cannot relax `BROKER_FORBIDDEN_TOOLS`, `isBrokerForbiddenTool`, or `slack-tool-policy-runtime.ts` enforcement;
- broker diagnostics must not echo private prompt file contents.

The current no-code wording, issue/PR gate, repo-scoped delegation preferences, worktree-safety wording, and RALPH operating style should move into the packaged default MD as default policy, not into the non-replaceable hard block. A custom broker MD can replace those defaults; the extension only keeps the enforced tool/protocol boundary authoritative.

Tool restrictions from `buildBrokerToolGuardrailsPrompt()` still append last, and runtime enforcement in `isBrokerForbiddenTool` / `slack-tool-policy-runtime.ts` remains the final authority.

## Why followers remain append-only

Followers are implementation workers. Replacing their full prompt would risk hiding repo instructions, task workflow rules, Slack/Pinet reply discipline, and safety guidance. Keep `buildWorkerPromptGuidelines()` append-only for now. If worker guidance needs to become editable later, make it either:

- an appended MD snippet after the base worker workflow; or
- a packaged skill that workers can load when relevant.

Do not let broker prompt MD change follower behavior.

## Privacy and security boundaries

- Treat user-local broker prompt MD as private runtime input. Never copy its contents into Slack messages, Pinet messages, broker metadata, PRs, issue comments, logs, or diagnostics.
- Workspace-local MD may be public if committed; warn docs authors not to include secrets, private URLs, workspace names, or local absolute paths.
- Resolve paths without following symlink escapes for workspace-local files. User-local files must stay under `~/.pi/agent/slack-bridge/`.
- MD cannot relax runtime guardrails. `BROKER_FORBIDDEN_TOOLS` and broker tool-call blocking remain authoritative.
- If an override is unreadable, too large, or unsafe, continue scanning lower-priority candidates; use the packaged default only when no override candidate is valid. Surface only concise warnings.

## Minimal implementation slice

1. Add `slack-bridge/broker-prompt-loader.ts` with pure helpers:
   - resolve candidate paths in the order above;
   - read/cap UTF-8 MD;
   - return `{ source, content, warnings }` without logging content.
2. Add `slack-bridge/prompts/broker/default.md` containing the current default broker policy/guidance.
3. Update the package build/publish path so bundled prompt MD is available after installation by copying `slack-bridge/prompts/**` into `dist/prompts/**` and including that path in the published package.
4. Split current broker prompt generation:
   - default broker policy/guidance moves out of `buildBrokerPromptGuidelines` and into packaged MD;
   - only the explicitly listed non-replaceable tool/protocol guardrails remain in code and append after loaded MD.
5. Update `createAgentPromptGuidance` to load broker MD only when `getBrokerRole() === "broker"`.
6. Leave follower path unchanged.
7. Pick up prompt changes on `/pinet-start` / runtime reload; no per-turn hot reload is needed for the first slice.
8. Document the conventional MD paths and package fallback behavior in `slack-bridge/README.md`.

## Tests

- Loader unit tests for workspace override, user-local override, ordered valid-candidate scanning, invalid workspace falling through to user-local, invalid overrides falling back to packaged default, missing files, unreadable/oversized files, and privacy-safe warnings.
- Package/build test proving the packaged default MD is present and loadable from the built/published layout.
- Prompt assembly tests proving broker prompt order: base prompt, shared identity/personality, loaded broker MD, narrow hard protocol/tool guardrails, then broker tool restrictions last.
- Regression test proving `full broker MD text` can replace the old broker guidance without removing `🚫 BROKER TOOL RESTRICTION` or runtime-backed forbidden-tool warnings.
- Default-prompt test proving the packaged default MD preserves today's default broker policy text, including no-code/delegation/issue-gate/RALPH guidance, as replaceable defaults rather than hard-coded policy.
- Follower regression test proving worker guidance remains append-only and does not load broker MD.
- Security test for symlink/path escape rejection on workspace and user-local candidates.

## Decisions from PR discussion

- Workspace-local override precedes user-local override for slice 1; repo/workspace intent wins before private user preference.
- Do not add a second gitignored workspace-private filename yet.
- Copy bundled default MD into `dist/prompts/**` and publish it; do not rely on a TS-string fallback for the normal packaged default path.
- Reloading on `/pinet-start` / runtime restart is enough for slice 1; no per-turn hot reload is needed.
