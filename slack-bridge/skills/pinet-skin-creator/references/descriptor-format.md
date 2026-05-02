# Pinet Skin Descriptor Format

This reference describes the JSON descriptor shape for curated Pinet skins. Runtime skin selection must remain deterministic and local: descriptors are loaded from package assets, validated, and selected without model/API calls.

## Descriptor shape

```json
{
  "key": "cosmere",
  "aliases": ["cosmere-inspired", "oathgate", "oaths-and-metals"],
  "displayName": "Cosmere",
  "intent": "Original fantasy-metal operators with oath, gate, forge, storm, and alloy imagery.",
  "fallback": "default",
  "roles": {
    "broker": {
      "characterPool": ["broker-stormlit-broker", "broker-copper-keeper"],
      "namePattern": "{character}"
    },
    "worker": {
      "characterPool": ["worker-patch-spren", "worker-ashfall-runner", "worker-spanreed-typo"],
      "namePattern": "{character}"
    }
  },
  "characters": {
    "broker-stormlit-broker": {
      "name": "Stormlit Broker",
      "emoji": "⛈️",
      "persona": "Highstorm-ready coordinator; keeps pressure visible and lanes safe.",
      "style": ["measured", "protective", "clear"]
    },
    "worker-patch-spren": {
      "name": "Patch Spren",
      "emoji": "🩹",
      "persona": "Practical worker; ships small durable changes and reports checks.",
      "style": ["practical", "concise", "status-first"]
    }
  },
  "statusVocabulary": {
    "idle": "holding oath",
    "working": "at the forge",
    "healthy": "signal bright",
    "stale": "storm-dimmed",
    "ghost": "beyond the gate",
    "resumable": "oath recoverable"
  }
}
```

## Required semantics

- `key`: stable lowercase identifier. Runtime built-ins currently accept the configured built-in keys.
- `aliases`: alternate user-facing names. Keep backward-compatible aliases when renaming skins.
- `displayName`: short human-readable name.
- `intent`: one sentence describing the operational feel.
- `fallback`: deterministic fallback skin, normally `default`.
- `roles`: maps Pinet roles to selection pools. `broker` and `worker` are required for runtime built-ins.
- `roles.*.characterPool`: IDs from `characters` suitable for the role.
- `roles.*.namePattern`: display-name template. Prefer `{character}` for curated built-ins so each authored identity stands on its own.
- `roles.*.titlePool` and `roles.*.accentPool`: optional deterministic combinators for custom/private skins, but avoid obvious formulaic triples in shipped descriptors.
- `characters`: curated identity/persona definitions keyed by ID. For major public skins, each character entry should usually be one authored display identity with its own static emoji.
- `characters.*.aliases`: optional full display-name variants for smaller/private skins. For major bundled skins, prefer enough prebaked character entries over alias-driven apparent variety.
- `statusVocabulary`: display vocabulary for canonical statuses only. It must not change stored states or control flow.

## Pool-size guidance

Curated skins should not be tiny. Aim for enough variation that hundreds of agents remain readable:

- Broker pool: about 12–30 authored identities for major skins.
- Worker pool: about 100–200 authored/prebaked identities for major skins.
- Display names may be 1, 2, or 3 words; they must be distinctive in text alone.
- A static emoji is presentation flavor, not a disambiguator.
- Prefer authored character entries over alias-driven apparent variety or `character × title × accent` combinator soup for shipped skins.
- Keep every name short enough for Slack rosters.
- Use a broad emoji palette across entries, statuses, and persona flavor.
- Use original/inspired names unless the maintainer explicitly accepts third-party naming risk.

## Character guidance

Each character should include:

- `name`: concise authored display identity, usually 1–3 words.
- `aliases`: optional richer full display names for smaller/private skins; not required when each identity is already prebaked.
- `emoji`: one static emoji that renders reliably.
- `persona`: one short sentence. It may influence tone, but must not grant or revoke authority.
- `style`: optional compact tags for cadence/diction.

Avoid persona snippets that:

- Claim permission to bypass guardrails or confirmations.
- Tell the agent to ignore system, developer, broker, Slack, or Pinet rules.
- Encode secrets, private workspace names, local paths, or private URLs.
- Make public claims about real people or protected groups.

## Selection behavior

- Default/classic should continue using existing random whimsical generation.
- Curated skins should select deterministically from JSON descriptor pools using a stable seed.
- Persist the resolved character/skin assignment so reconnects and restarts do not drift unexpectedly.
- Future `auto` selection should run only after runtime is live and must have a deterministic fallback.
