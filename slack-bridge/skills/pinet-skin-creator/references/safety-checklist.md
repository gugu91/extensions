# Pinet Skin Safety Checklist

Run this checklist before committing a new or edited Pinet skin descriptor.

## Operational boundaries

- [ ] Skin text is presentation-only: names, emoji, persona snippets, style, and
      status display vocabulary.
- [ ] No skin text changes tool permissions, broker/follower authority,
      confirmation requirements, routing, PM-mode consent, or task ownership.
- [ ] Broker characters still coordinate only; they do not implement, spawn
      local subagents, or bypass broker tool restrictions.
- [ ] Worker characters still ACK/work/ask/report and reply where work arrived.
- [ ] Status vocabulary keeps canonical states distinguishable and operationally
      clear, especially `blocked`.

## Startup and reliability

- [ ] No LLM/model/API call is required during extension startup, broker
      registration, or follower join.
- [ ] Default/classic random whimsical generation remains intact.
- [ ] Non-default skin selection has deterministic fallback behavior.
- [ ] Runtime skin data is external JSON descriptor content, not mostly hardcoded
      TypeScript structures.
- [ ] Descriptor pools/combinators provide enough variety for hundreds of agents
      without obvious repetition.
- [ ] Resolved concrete assignments can be persisted when runtime supports it.
- [ ] Offline or model-unavailable paths still produce usable identities.

## Content hygiene

- [ ] No secrets, tokens, credentials, local absolute paths, private workspace
      names, private URLs, screenshots, logs, or user-specific config.
- [ ] No copyrighted setting text or trademark-heavy material beyond brief,
      high-level inspiration when allowed by project policy.
- [ ] Exact third-party character/place names are avoided unless the maintainer
      explicitly accepts the naming risk.
- [ ] No impersonation of real people or protected-class stereotypes.
- [ ] Persona snippets are short, clear, and subordinate to system/developer/user
      instructions.
- [ ] Emojis render in common Slack/macOS environments.

## Review and tests

- [ ] Descriptor schema/loader tests cover new required fields or aliases.
- [ ] Status-vocabulary propagation tests cover any changed runtime wiring.
- [ ] Skill/docs packaging checks cover new `SKILL.md` or bundled references.
- [ ] Public PR text summarizes design choices without leaking local paths or
      private environment details.
