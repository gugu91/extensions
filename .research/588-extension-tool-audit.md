# Issue #588 — Extension tool token-footprint audit

> Follow-up note: the Slack surface has since been standardized on a single
> `slack` dispatcher. Historical references below to direct tools such as
> `slack_inbox` and `slack_send` describe the measured pre-consolidation
> surface, not the current default registration target.

## Scope

Repo tool surfaces audited in this pass:

- `slack-bridge` Slack tools
- `slack-bridge` Pinet tools
- `slack-bridge` iMessage tool surface
- `nvim-bridge` tools / PiComms surface
- `neon-psql` tool surface

Out of scope for this pass:

- core Pi built-in tools outside this repo
- non-tool command surfaces except where they materially affect tool prompt weight
- implementation changes beyond small measurement helpers / documentation in this audit branch

## Method

I inspected exported `pi.registerTool(...)` surfaces directly and measured lightweight proxy sizes from source:

- per-tool description character count
- per-tool prompt snippet character count
- per-tool inline schema description character count proxy
- approximate tool block size in source (`registerTool` segment chars)
- hot-path prompt overlay sources such as shared `promptGuidelines`

This is not a tokenizer-exact benchmark. It is a comparative audit intended to spot outsized hot-path surfaces and progressive-discovery candidates.

## Executive summary

The repo’s biggest token-footprint risk is **not** `neon-psql`, `nvim-bridge`, or Pinet. It is the **flat Slack tool surface in `slack-bridge`**:

- `slack-bridge/slack-tools.ts` exports **23 dedicated tools**.
- Many of those tools are individually reasonable, but collectively they create a large hot-path registry and duplicate prompt guidance.
- The largest waste is not only tool count — it is also **repeated rich-Slack guidance** attached to multiple tools (`slack_send`, modal tools, blocks builder, channel post, canvas tools, etc.).
- Pinet already shows a better pattern: a small, high-frequency family (`pinet_message`, `pinet_free`, `pinet_schedule`, `pinet_agents`) with relatively compact schemas.

Primary recommendation: **do not do broad cuts yet**, but plan a staged migration where the Slack surface is reorganized into hot/warm/cold families behind progressive-discovery dispatchers.

## Inventory snapshot

### Tool counts by extension

| Extension                  | Tool count | Notes                                              |
| -------------------------- | ---------: | -------------------------------------------------- |
| `slack-bridge` Slack tools |         23 | biggest hot-path surface in repo                   |
| `slack-bridge` Pinet tools |          4 | compact, high-value, mostly justified as dedicated |
| `slack-bridge` iMessage    |          1 | small surface                                      |
| `nvim-bridge`              |          4 | small surface, two PiComms tools are warm/cold     |
| `neon-psql`                |          1 | single dispatcher-style tool already               |

### Largest `registerTool` blocks by source size proxy

| Tool                         | Approx source block chars | Notes                                                                           |
| ---------------------------- | ------------------------: | ------------------------------------------------------------------------------- |
| `comment_wipe_all`           |                      4665 | inflated because it sits near later command registration; actual schema is tiny |
| `psql`                       |                      6591 | single tool, but dispatcher-style and justified                                 |
| `slack_bookmark`             |                      5355 | action family with several modes                                                |
| `slack_modal_build`          |                      4987 | large structured schema                                                         |
| `slack_canvas_comments_read` |                      4093 | warm/cold administrative surface                                                |
| `slack_canvas_update`        |                      4066 | warm/cold administrative surface                                                |
| `slack_project_create`       |                      3840 | compound creation workflow                                                      |
| `imessage_send`              |                      3581 | single action, acceptable                                                       |
| `slack_export`               |                      3545 | warm/cold archival workflow                                                     |
| `slack_upload`               |                      3555 | frequent enough, but schema is broad                                            |

Interpretation: source block size is directional only, but it clearly points to a handful of broad Slack administrative tools that are good progressive-discovery candidates.

## Measured per-tool footprint proxies

### `slack-bridge` Slack tools

| Tool                         | Desc chars | Prompt chars | Schema proxy chars | Total proxy chars | Recommendation         |
| ---------------------------- | ---------: | -----------: | -----------------: | ----------------: | ---------------------- |
| `slack_inbox`                |         86 |           38 |                  2 |               126 | keep as hot tool       |
| `slack_blocks_build`         |        128 |           52 |                136 |               316 | split hot/warm/cold    |
| `slack_modal_build`          |        105 |           55 |                113 |               273 | split hot/warm/cold    |
| `slack_modal_open`           |         60 |           60 |                 99 |               219 | move behind dispatcher |
| `slack_modal_push`           |         64 |           56 |                 99 |               219 | move behind dispatcher |
| `slack_modal_update`         |         46 |           47 |                134 |               227 | move behind dispatcher |
| `slack_send`                 |         43 |          183 |                 74 |               300 | keep as hot tool       |
| `slack_react`                |         56 |          108 |                148 |               312 | keep as hot tool       |
| `slack_upload`               |        121 |          138 |                188 |               447 | keep as hot tool       |
| `slack_read`                 |         44 |           44 |                 65 |               153 | keep as hot tool       |
| `slack_presence`             |         99 |          133 |                153 |               385 | split hot/warm/cold    |
| `slack_export`               |         86 |          100 |                 76 |               262 | move behind dispatcher |
| `slack_create_channel`       |         69 |           27 |                109 |               205 | move behind dispatcher |
| `slack_project_create`       |         90 |           96 |                109 |               295 | move behind dispatcher |
| `slack_post_channel`         |        131 |          108 |                155 |               394 | split hot/warm/cold    |
| `slack_pin`                  |         42 |          130 |                 98 |               270 | move behind dispatcher |
| `slack_bookmark`             |        100 |          143 |                 73 |               316 | move behind dispatcher |
| `slack_schedule`             |        107 |          128 |                 74 |               309 | keep as hot tool       |
| `slack_read_channel`         |         64 |           35 |                 66 |               165 | split hot/warm/cold    |
| `slack_canvas_comments_read` |         94 |          167 |                183 |               444 | move behind dispatcher |
| `slack_canvas_create`        |         86 |          139 |                 72 |               297 | move behind dispatcher |
| `slack_canvas_update`        |        102 |          143 |                 83 |               328 | move behind dispatcher |
| `slack_confirm_action`       |        143 |           55 |                 88 |               286 | keep as hot tool       |

### `slack-bridge` Pinet tools

| Tool             | Desc chars | Prompt chars | Schema proxy chars | Total proxy chars | Recommendation   |
| ---------------- | ---------: | -----------: | -----------------: | ----------------: | ---------------- |
| `pinet_message`  |         75 |          244 |                149 |               468 | keep as hot tool |
| `pinet_free`     |         45 |           74 |                116 |               235 | keep as hot tool |
| `pinet_schedule` |         47 |           95 |                110 |               252 | keep as hot tool |
| `pinet_agents`   |         57 |          108 |                 90 |               255 | keep as hot tool |

### `slack-bridge` iMessage

| Tool            | Desc chars | Prompt chars | Schema proxy chars | Total proxy chars | Recommendation   |
| --------------- | ---------: | -----------: | -----------------: | ----------------: | ---------------- |
| `imessage_send` |         82 |          145 |                121 |               348 | keep as hot tool |

### `nvim-bridge`

| Tool               | Desc chars | Prompt chars | Schema proxy chars | Total proxy chars | Recommendation         |
| ------------------ | ---------: | -----------: | -----------------: | ----------------: | ---------------------- |
| `open_in_editor`   |         70 |            0 |                 78 |               148 | keep as hot tool       |
| `comment_add`      |         60 |            0 |                 69 |               129 | split hot/warm/cold    |
| `comment_list`     |         53 |            0 |                 91 |               144 | move behind dispatcher |
| `comment_wipe_all` |         68 |            0 |                  2 |                70 | move behind dispatcher |

### `neon-psql`

| Tool   | Desc chars | Prompt chars | Schema proxy chars | Total proxy chars | Recommendation   |
| ------ | ---------: | -----------: | -----------------: | ----------------: | ---------------- |
| `psql` |        160 |           80 |                0\* |               240 | keep as hot tool |

`*` The schema proxy undercounts here because `psql` parameters are defined via a shared `PsqlParams` constant rather than inline. Qualitatively, this is still a compact and effective single-dispatch tool.

## Major findings

### 1. `slack-bridge` has the clearest progressive-discovery opportunity

The Slack surface is large in two different ways:

1. **Too many top-level tools** for one domain family.
2. **Repeated guidance** on many tools that all belong to the same workflow cluster.

Notable prompt duplication:

- `buildSlackInboxPromptGuidelines()` alone contains **12 guidance strings / ~1567 chars**.
- `buildSlackRichMessagePromptGuidelines()` composes inbox guidance + Block Kit guidance + modal guidance.
- That rich guidance is attached repeatedly across blocks/modal/send/post-channel/canvas tools.

This is a textbook case for #586’s rule:

- compact hot path
- discoverable cold path
- move examples and long usage guidance out of the always-present tool prompt surface

#### Hot Slack tools that likely deserve to stay top-level

These are frequent, intuitive, and operationally central:

- `slack_inbox`
- `slack_send`
- `slack_read`
- `slack_upload`
- `slack_react`
- `slack_schedule`
- `slack_confirm_action`

Possibly also:

- `slack_presence` (frequent enough in reviewer-routing flows)

#### Warm/cold Slack families that look collapsible

Good dispatcher candidates:

- modal lifecycle: `slack_modal_open`, `slack_modal_push`, `slack_modal_update`
- channel administration: `slack_create_channel`, `slack_project_create`, `slack_pin`, `slack_bookmark`
- canvas administration: `slack_canvas_comments_read`, `slack_canvas_create`, `slack_canvas_update`
- archival/admin surfaces: `slack_export`, maybe `slack_read_channel`

Likely dispatcher shapes:

- `slack_modal { action: build|open|push|update }`
- `slack_channel { action: create|project_create|post|pin|bookmark|read }`
- `slack_canvas { action: comments_read|create|update }`
- `slack_archive { action: export }`

Caution: `slack_post_channel` is borderline. It is useful enough that keeping it separate may still be justified, but it is less hot than `slack_send`.

### 2. Pinet is already close to the right shape

`pinet_message`, `pinet_agents`, `pinet_free`, and `pinet_schedule` form a compact and legible family. They are hot-path enough to justify dedicated presence.

I do **not** recommend collapsing them right now. The current surface is small, memorable, and operationally important for broker/worker behavior.

One refinement worth considering later:

- trim the `pinet_message` prompt snippet, which is the largest in this family
- move extended delegation examples into docs/skills rather than tool prompt copy

But this is a low-priority optimization, not a structural problem.

### 3. `neon-psql` is already a good dispatcher model

`psql` is a single, multi-mode inspection surface with clear read-only guardrails. It is exactly the sort of compact domain entry point that #586 encourages.

Recommendation: **no structural change**.

Potential tiny polish only:

- ensure examples live in docs rather than prompt text if any are duplicated elsewhere

### 4. `nvim-bridge` is small, but PiComms can be simplified further

`open_in_editor` should remain a dedicated hot tool.

The PiComms tools are a good opportunity for a small future cleanup:

- `comment_add` may stay dedicated if it is heavily used
- `comment_list` and `comment_wipe_all` feel colder and could move under a `picomms` dispatcher

Potential future shape:

- `picomms { action: add|list|wipe_all }`
- keep `open_in_editor` separate

Risk is moderate because the current tools are already tiny, so the payoff is smaller than the Slack consolidation payoff.

### 5. iMessage is fine as-is

`imessage_send` is one tool, one action, one domain. No need to collapse further.

## Recommendation table by family

| Family                                   | Recommendation         | Rationale                                                                                    | Risk       |
| ---------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| Slack inbox/send/read core               | keep as hot tool       | frequent, obvious, low cognitive overhead                                                    | low        |
| Slack reactions/uploads/schedule/confirm | keep as hot tool       | common operational actions with clear intent                                                 | low        |
| Slack modal lifecycle                    | move behind dispatcher | highly related actions, repeated prompt guidance                                             | medium     |
| Slack block/modal builders               | split hot/warm/cold    | builder tools are useful, but can likely sit behind one richer Slack-composition entry point | medium     |
| Slack channel admin                      | move behind dispatcher | cold administrative surface                                                                  | medium     |
| Slack canvas admin                       | move behind dispatcher | cold, broad, and prompt-heavy                                                                | medium     |
| Slack export/archive                     | move behind dispatcher | archival workflow is not hot-path enough                                                     | low        |
| Pinet tools                              | keep as hot tool       | already compact and central                                                                  | low        |
| iMessage send                            | keep as hot tool       | single useful action                                                                         | low        |
| `open_in_editor`                         | keep as hot tool       | very high utility, tiny footprint                                                            | low        |
| PiComms add/list/wipe                    | split hot/warm/cold    | add is warmer; list/wipe are colder                                                          | low-medium |
| `psql`                                   | keep as hot tool       | already a good compact dispatcher                                                            | low        |

## Prompt / token waste patterns to address later

### Repeated guidance in Slack tools

The largest repeated hot-path payload appears to be guidance, not field descriptions.

Candidates to reduce:

- inbox guidance duplicated through `buildSlackRichMessagePromptGuidelines()`
- Block Kit example payload embedded in hot prompt guidance
- modal lifecycle instructions repeated across multiple tools

Follow-up strategy:

- keep only a minimal, action-specific prompt snippet on hot tools
- move broader Slack operating doctrine to docs/skills
- use one parent dispatcher to carry richer discoverability for colder branches

### Too many sibling tools for one domain

A large flat registry makes discovery harder for agents and humans alike.

Progressive discovery would improve:

- token cost
- mental model clarity
- guardrail composition by grouping related actions

### Mixed hot/cold actions in same conceptual domain

Examples:

- `slack_send` vs `slack_project_create`
- `comment_add` vs `comment_wipe_all`

These should not necessarily have the same visibility level.

## Guardrail considerations

Collapsing tools into dispatchers is only a win if guardrails stay precise.

Needed properties for any migration:

- action-level validation remains explicit
- dangerous actions (`pin`, `bookmark remove`, `project_create`, `canvas_update`, wipe/delete flows) still support confirmation policies and policy matching
- tool-policy runtime can still inspect action strings deterministically

This is feasible, but it means the migration must be deliberate. Do **not** collapse everything at once.

## Compatibility risks

### Highest compatibility risk

- Slack tool renames/removals, because many prompts and operator habits may already reference current names
- any action collapse that weakens security policy matching

### Moderate risk

- PiComms consolidation if skills/docs reference `comment_list` or `comment_wipe_all`
- Slack admin/canvas consolidation if existing workflows explicitly call those tool names

### Low risk

- docs-only prompt-trimming
- moving examples out of prompt guidance and into skills/docs
- retaining hot tool names while adding dispatcher alternatives first

## Proposed migration order

This audit does **not** implement structural cuts. But if approved later, the lowest-risk migration order looks like this:

1. **Prompt trimming only**
   - reduce duplicated Slack guidance on hot tools
   - move long examples to docs/skills

2. **Add dispatcher(s) without removing old tools**
   - introduce `slack_modal` and/or `slack_canvas` parent surfaces
   - keep legacy tools as compatibility shims initially

3. **Measure usage / ergonomics**
   - confirm that agents successfully discover and use the dispatcher flows

4. **Deprecate cold leaf tools**
   - remove only once compatibility story is clear

5. **Optionally consolidate PiComms**
   - lower priority than Slack

## Follow-up issues I would open

1. **slack-bridge: trim repeated rich-message prompt guidance**
   - small, low-risk token win

2. **slack-bridge: prototype progressive-discovery modal dispatcher**
   - `build/open/push/update` family

3. **slack-bridge: prototype progressive-discovery canvas/channel admin dispatchers**
   - colder admin surfaces

4. **nvim-bridge: evaluate `picomms` dispatcher for list/wipe flows**
   - optional, lower priority

5. **repo: add lightweight tool-footprint measurement script for CI/ad-hoc audits**
   - keeps #586 measurable instead of aspirational

## Concrete recommendations

### Keep as hot tool

- `slack_inbox`
- `slack_send`
- `slack_read`
- `slack_upload`
- `slack_react`
- `slack_schedule`
- `slack_confirm_action`
- `pinet_message`
- `pinet_free`
- `pinet_schedule`
- `pinet_agents`
- `imessage_send`
- `open_in_editor`
- `psql`

### Move behind dispatcher

- `slack_modal_open`
- `slack_modal_push`
- `slack_modal_update`
- `slack_export`
- `slack_create_channel`
- `slack_project_create`
- `slack_pin`
- `slack_bookmark`
- `slack_canvas_comments_read`
- `slack_canvas_create`
- `slack_canvas_update`
- `comment_list`
- `comment_wipe_all`

### Split hot / warm / cold

- `slack_blocks_build`
- `slack_modal_build`
- `slack_presence`
- `slack_post_channel`
- `slack_read_channel`
- `comment_add`

### Move examples/docs to skill/doc

- repeated Slack inbox / response workflow guidance
- Block Kit example payload in hot prompt guidance
- modal lifecycle teaching text duplicated across tools
- any extended Pinet delegation examples that are not essential to immediate safe use

### Needs separate implementation issue

- Slack dispatcher introduction and deprecation plan
- action-level policy matching for collapsed Slack tools
- usage/compatibility telemetry or lightweight instrumentation

### Defer / no change

- `psql`
- `imessage_send`
- Pinet 4-tool family
- `open_in_editor`

## Bottom line

If we only do one thing after this audit, it should be:

> **Shrink and regroup the flat Slack tool surface first, starting with duplicated prompt guidance and cold administrative tool families.**

That is where the repo’s largest token-footprint and progressive-discovery mismatch currently lives.
