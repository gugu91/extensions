# Pinet Skin Descriptor Format

This reference describes the recommended shape for curated Pinet skins. Treat it
as a portable authoring contract; implementation details may adapt field names,
but the semantics should remain stable.

## Descriptor shape

```json
{
  "key": "oathgate",
  "aliases": ["cosmere-inspired"],
  "displayName": "Oathgate",
  "intent": "High-trust operators with crisp, oath-bound coordination language.",
  "fallback": "default",
  "roles": {
    "broker": { "characterPool": ["storm-warden"] },
    "worker": { "characterPool": ["spanreed-runner", "bridge-scout"] },
    "reviewer": { "characterPool": ["truthwatcher"] },
    "pm": { "characterPool": ["bondsmith"] }
  },
  "characters": {
    "storm-warden": {
      "name": "Storm Warden",
      "emoji": "⛈️",
      "persona": "Calm, duty-bound coordination; precise handoffs and visible blockers.",
      "style": ["measured", "protective", "clear"]
    }
  },
  "statusVocabulary": {
    "idle": "watching the spanreed",
    "working": "binding the lane",
    "blocked": "storm-stalled",
    "reviewing": "checking the oathmark",
    "done": "oath fulfilled"
  }
}
```

## Required semantics

- `key`: stable lowercase identifier. Prefer lowercase letters, numbers, and
  hyphens. Avoid spaces.
- `aliases`: optional alternate user-facing names. Keep backward compatibility
  aliases when renaming skins.
- `displayName`: short human-readable name.
- `intent`: one sentence describing the skin's operational feel.
- `fallback`: deterministic fallback skin, normally `default`.
- `roles`: maps Pinet roles to character pool IDs. Every supported role should
  have at least one suitable character; workers should usually have several.
- `characters`: curated character definitions keyed by ID.
- `statusVocabulary`: optional display vocabulary for canonical statuses. This
  is presentation metadata only.

## Character guidance

Each character should include:

- `name`: concise roster name. Avoid long titles that wrap badly in Slack.
- `emoji`: one emoji that renders reliably.
- `persona`: one short sentence. It may influence tone, but must not grant or
  revoke authority.
- `style`: optional compact tags for cadence/diction.

Good persona snippets:

- "Steady coordinator; asks early for blockers and summarizes decisions."
- "Focused reviewer; concise risk calls and actionable findings."
- "Curious implementer; resilient debugging with crisp status updates."

Avoid persona snippets that:

- Claim permission to bypass guardrails or confirmations.
- Tell the agent to ignore system, developer, broker, Slack, or Pinet rules.
- Encode secrets, private workspace names, local paths, or private URLs.
- Make public claims about real people or protected groups.

## Status vocabulary guidance

Status vocabulary maps **canonical state → display phrase**. It must not change
stored states or control-flow decisions.

Recommended properties:

- Short enough for rosters and dashboards.
- Flavorful but unambiguous.
- Has a neutral fallback when omitted.
- Includes `blocked` wording that stays operationally obvious.

Example:

```json
{
  "idle": "at the ready",
  "working": "in the forge",
  "blocked": "forge-stalled",
  "reviewing": "tempering the edge",
  "done": "blade cooled"
}
```

## Selection behavior

- Default/classic should continue using existing random whimsical generation.
- Curated skins should select from pre-created pools deterministically using a
  stable seed when possible.
- Persist the resolved character/skin assignment so reconnects and restarts do
  not drift unexpectedly.
- Future `auto` selection should run only after runtime is live and must have a
  deterministic fallback.
