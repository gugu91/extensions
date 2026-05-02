# Pinet Skin Descriptor Format

This reference describes the JSON descriptor shape for curated Pinet skins. Runtime skin selection must remain deterministic and local: descriptors are loaded from package assets, validated, and selected without model/API calls.

## Descriptor shape

```json
{
  "key": "oathgate",
  "aliases": ["cosmere-inspired", "oaths-and-metals"],
  "displayName": "Oathgate",
  "intent": "Original fantasy-metal operators with oath, gate, forge, storm, and alloy imagery.",
  "fallback": "default",
  "roles": {
    "broker": {
      "characterPool": ["oathgate-warden", "storm-cartographer"],
      "titlePool": ["Warden", "Cartographer", "Binder"],
      "accentPool": ["Oathgate", "Stormbound", "Alloy"],
      "namePattern": "{accent} {title} {character}"
    },
    "worker": {
      "characterPool": ["forge-scribe", "gate-runner", "bronze-scout"],
      "titlePool": ["Scribe", "Runner", "Scout", "Forger"],
      "accentPool": ["Iron", "Bronze", "Storm", "Gate"],
      "namePattern": "{accent} {character} {title}"
    }
  },
  "characters": {
    "oathgate-warden": {
      "name": "Vala",
      "emoji": "🛡️",
      "persona": "Oathgate coordinator; holds commitments steady and keeps blockers visible.",
      "style": ["measured", "protective", "clear"]
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
- `roles.*.titlePool` and `roles.*.accentPool`: optional deterministic combinators for large meshes.
- `roles.*.namePattern`: display-name template using `{character}`, `{title}`, and `{accent}`.
- `characters`: curated character/persona definitions keyed by ID.
- `statusVocabulary`: display vocabulary for canonical statuses only. It must not change stored states or control flow.

## Pool-size guidance

Curated skins should not be tiny. Aim for enough variation that hundreds of agents remain readable:

- Broker pool: about 8–16 characters plus 12+ titles/accent values.
- Worker pool: about 16–32 characters plus 16+ titles/accent values.
- Prefer deterministic combinatorics (`character × title × accent`) over enormous flat generated lists.
- Keep every name short enough for Slack rosters.
- Use original/inspired names unless the maintainer explicitly accepts third-party naming risk.

## Character guidance

Each character should include:

- `name`: concise roster base name.
- `emoji`: one emoji that renders reliably.
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
