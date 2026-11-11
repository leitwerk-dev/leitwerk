# Model classification and deterministic selection

Status: implemented in the shared SDK, configuration, server policy, managed start
paths, and model controls. Full validation and focused browser checks are recorded
in the implementation handoff. See `docs/models.md` for the supported contract.

Technical choices: `labels` and `default` on profiles; `modelRequirements` in code;
`model_requirements` in YAML; `profiles`, `capabilities`, and label predicates inside
requirements. Provider `capabilities` is synchronous startup catalog metadata.
New provenance values extend JSON decoding without changing the SQLite schema;
upgrade server and workers together and do not downgrade old decoders after writes.

## 1. Goal and scope

Make model selection predictable for operators, process authors, and unattended
watchers. A process default is a preference; process and turn requirements are
hard constraints. The server selects a profile without consulting availability,
then blocks if that profile is unavailable.

This changes shared configuration, SDK declarations, selection semantics, launch
and scheduling flows, and every model picker. It is not a UI-only sorting change.

In scope:

- Profile properties, deterministic selection, and grouped pickers.
- Static process and turn requirements in code and operator configuration.
- Consistent enforcement for launch, actions, retries, scheduled work, and watchers.
- Dashboard diagnostics and short explanations of effective choices.

Out of scope:

- Repository/instance-derived code classifications and dynamic requirements.
- Hosting/privacy as a built-in classification.
- Arbitrary preference rules, expression languages, scores, or learned routing.
- Availability-based substitution, provider failover, and cost-budget enforcement.
- Editing profile properties or restrictions in the UI.
- Claiming that selection policy provides tenant isolation or contains arbitrary
  network access by trusted extensions/tools.

## 2. Agreed behavior

1. Properties belong to a configured profile, not merely a provider/model pair.
   Two profiles for the same model can have different operational settings.
2. Cost tiers are ordinary labels: `free`, `economy`, `standard`, and `premium`,
   in that presentation/tie-break order. There is no dedicated cost field or
   cost-specific requirement syntax. `free` means no cost associated with model
   usage; never infer it from missing pricing or zero-valued provider metadata.
3. Operators own cost and suitability/classification labels. Technical capability
   metadata should come from providers where reliable.
4. Processes and LLM turns can declare requirements. Operator configuration can
   narrow those requirements, never widen them.
5. Supported restrictions: profile allowlists, required capabilities, and labels
   with all-of, any-of, and none-of matching. Cost restrictions use those same
   label predicates.
6. Explicit turn/action selections must satisfy requirements; invalid selections
   block instead of being replaced.
7. A process default applies where eligible. A turn may resolve another model
   when that default is ineligible.
8. Automatic selection first prefers eligible profiles marked `default: true`.
   Among them, fewer unrelated labels wins, then lower cost tier, then profile ID.
9. With no eligible marked default, choose by cost tier, then profile ID.
10. Availability never affects selection or ranking. An unavailable or stale
    selected profile blocks, even if another eligible profile is available.
11. UI ordering is cost group, then alphabetical profile ID. It is independent of
    configuration order and selection ranking.
12. Launch exposes a process default plus per-turn choices. Viewing or submitting
    an unchanged automatic recommendation must not persist an explicit override.
13. Preserve the existing default precedence chain before automatic ranking. An
    eligible global default wins over marked defaults.
14. All policy labels count toward specificity, including cost labels and
    organization classifications.
15. Immediate UI launch requires a resolvable, available model for every declared
    LLM turn. Watcher launches defer model-policy blocks until the affected turn
    needs to execute.
16. An excluded/unavailable title model blocks title generation, not the business
    process. Report the issue without substituting a model.

17. Cost grouping/tie-breaking uses the first matching label in the fixed cost
    order. Profiles without a cost label follow the named groups under “Other
    models”; missing/multiple cost labels cause no special validation error.
18. Programmatic launches use all-turn readiness checks. UI-created schedules
    check all turns when saved; due execution blocks at the affected turn.
19. Automatic recovery retries the captured model. Operator retry may re-resolve
    inherited choices; explicit turn/action choices remain pinned unless cleared.

All numbered behavioral decisions below are confirmed. Illustrative field names
and implementation recommendations remain subject to normal implementation review.

## 3. Current implementation and integration risks

| Area | Current implementation | Required change or risk |
| --- | --- | --- |
| Profile/config types | `packages/protocol/src/config-snapshot.ts`, `packages/server/src/config/config-loader.ts` | Profiles have identity/thinking/provider options, but no classification. The global default is required. |
| Policy construction | `packages/server/src/process-model-policy/construct.ts` | One immutable startup snapshot; only process-level YAML allowlists. Must incorporate code and YAML requirements for every LLM turn. |
| Resolution | `packages/server/src/process-model-policy/evaluate.ts` | Selects the first inherited value, then validates; it does not search eligible alternatives. Fixed system-purpose models are authoritative. |
| Validation interface | `packages/server/src/process-model-policy/types.ts` | `runtime_selection`, `profile_options`, and `compatible_profiles` lack turn context. Extending only the resolver would leave enforcement and picker gaps. |
| Launch preparation | `packages/server/src/process-model-policy/launch.ts` | Validates defaults and turn overrides against process policy only. Selected-turn preparation reports only some resolution failures. Invalid values can be omitted in an explicit sanitization mode. |
| Watchers | `packages/server/src/launch-coordinator.ts` | Watcher configuration uses `invalidModelConfig: "omit"` unless an event supplies a default. Bad configuration can be dropped rather than block. |
| Instance editing | `packages/server/src/process-model-config.ts` | Flattens patched profile IDs into one process-only validation loop, losing which turn each choice belongs to. |
| Actions/scheduling | `packages/server/src/process-engine/ops/execute-action.ts`, `packages/server/src/future-execution/` | Several explicit/pinned validation paths use process-only validation even when a destination turn is known. |
| Recovery | `packages/server/src/process-model-policy/evaluate.ts` | Preparation recovery re-resolves inherited selections. An availability event must not become a route to selecting a different profile. |
| Start capture | `packages/server/src/process-engine/turn-start-preflight.ts` | Resolves before yielding and captures the effective selection. Preserve this atomic capture and the separate worker-acceptance boundary. |
| Title generation | `packages/server/src/process-title-generator.ts` | Separately checks the old YAML allowlist before enqueuing a job. New restrictions must not be bypassed by this internal LLM call. |
| Dashboard | `packages/server/src/dashboard-model-issues.ts` | Inspects references with process-only validation. Cannot currently diagnose an unresolved turn with no explicit reference, nor distinguish a skipped preference from a hard invalid override. |
| Policy projection | `packages/server/src/process-model-policy/project.ts` | One process-wide profile list in configuration order is reused by all turns. Excluded profiles disappear, which can hide the identity of invalid saved choices. |
| Pickers | `GenericLauncher.svelte`, `ProcessModelEditor.svelte`, `ModelProfileOptions.svelte` | Multiple render paths; no grouping and no turn-specific eligibility. A shared options implementation exists but is not used everywhere. |
| Provenance | `packages/domain/src/domain-model.ts`, `process-model-policy/types.ts` | Source values are durable and have validators. `explicit` does not mean pinned: instance defaults are explicit, but only launch/action sources are pinned today. |
| Worker adoption | `packages/server/src/process-model-policy/fingerprint.ts` | Includes raw worker static config. New metadata and array-order changes could unnecessarily invalidate adoption; code-defined requirements are not represented by simply adding YAML fields. |

Additional callers to audit: launcher preview sanitization, scoped model settings,
SDK model-selection services, provider-options endpoints, warm-cache compatibility
hints, mapped LLM turns, and extension-owned model-choice UIs/integrations. Core
packages must not import extensions to obtain metadata or enforce policy.

## 4. Proposed domain/configuration contract

### 4.1 Profile metadata

Illustrative YAML, subject to naming review:

```yaml
pi:
  default_model_profile: general
  model_profiles:
    - id: sol
      provider: organization-provider
      model_id: organization-coder
      labels: [coding, standard, approved-for-internal-code]
      default: true
```

Recommendation:

- Use one policy-label collection with a documented starter vocabulary (`coding`,
  `planning`, `research`, `writing`, `extraction`, `free`, `economy`, `standard`,
  `premium`) and organization-owned labels.
  Do not create overlapping `coding` booleans and `labels: [coding]` semantics.
- Keep technical capabilities separate from labels. A `coding` label is an
  operator assertion, not proof of model quality.
- Default `default` to false and labels to an empty set.
- Normalize labels as sets; define identifier syntax/case explicitly. Reject
  malformed values. Do not let duplicate labels affect matching or ranking.
- Do not equate an omitted capability with confirmed support. Distinguish
  supported, unsupported, and unknown where metadata is incomplete.
- Provider metadata used for eligibility must be a stable configuration/catalog
  snapshot, not a live availability probe. The current provider status interface
  exposes availability, not a capability catalog; this needs a deliberate SDK
  extension or a reliable static metadata projection.
- Start with capabilities that can actually be established. Image input and
  reasoning metadata may be available; do not assume tool-use support solely
  because a provider is registered. Unknown required support fails eligibility.

**D1 — Accepted: cost values are ordinary labels.** Use `labels` for cost,
matching and specificity, with no dedicated `cost_tier`/`cost_tiers` fields.
Do not add mandatory cost labels, an Unclassified tier, or missing-cost warnings.
Retain the agreed free/economy/standard/premium ordering for presentation and
cost-based tie-breaking. Never infer free from provider pricing.

**D1a — Accepted: missing/multiple cost labels in ordering.** Use the first
matching label in the fixed free/economy/standard/premium order
for grouping and cost tie-breaking. Profiles with no matching label follow those
groups, under a neutral “Other models” heading in the picker. This is only an
ordering rule: it adds no label, eligibility restriction, warning, or exclusive
cost-label validation. All actual labels still participate in matching and
specificity.

### 4.2 Requirements

Add a shared data-only requirements type to the process SDK, exposed on process
and LLM-turn declarations and propagated through definition/flow builders.
Operator equivalents belong at process and turn configuration levels.

Illustrative YAML:

```yaml
process_configs:
  repository_change:
    model_requirements:
      labels:
        all_of: [approved-for-internal-code]
    turn_configs:
      implement:
        model_requirements:
          labels:
            all_of: [coding]
            any_of: [free, economy, standard]
```

Retain `allowed_model_profiles` as an enforced restriction during migration. If
an allowlist is also supported within the new requirements object, both intersect;
neither overwrites the other. Prefer one canonical documented form for new config.

Effective eligibility is the conjunction of:

1. Code-defined process requirements.
2. Operator process requirements, including the existing allowlist.
3. Code-defined turn requirements.
4. Operator turn requirements.

Preserve each layer's origin for explanations. In particular, do not merge any-of
clauses into one union: process `any_of: [coding, writing]` AND turn
`any_of: [planning, research]` requires at least one match from EACH clause.

Omitted restrictions are unconstrained. Explicit empty allowlists/any-of lists
should be rejected rather than accidentally interpreted as unrestricted. An empty
intersection between individually valid layers is a policy issue, not malformed
YAML: keep the server/dashboard available and block affected work.

Code normally uses portable labels/capabilities; profile IDs are installation
specific. Requirements on non-LLM turns should be rejected rather than ignored.

### 4.3 Specificity

For eligible marked defaults, proposed definition:

```text
relevantLabels = union of positive labels in every effective all-of/any-of clause
unrelatedCount = size(profile.labels minus relevantLabels)
rank = (unrelatedCount, costTierRank, profileId)
```

None-of labels do not increase relevance. Profile allowlists and capabilities
are eligibility filters, not additional specificity weights. Cost labels use the
same positive-label relevance and unrelated-label count as every other label.
Without positive label requirements, every profile label is unrelated: an
unlabelled marked default wins over a labelled marked default before cost ties.

This implements the agreed coding/planning example without arbitrary weights.
For an any-of clause, both alternatives count as relevant; a profile supporting
both is not penalized merely for satisfying both.

**D2 — Accepted: all policy labels affect ranking.** With one label collection,
adding an unrelated organization classification can change which marked default
wins. Count all policy labels, including cost labels, and document this behavior.
For a coding-only requirement, `[coding]` has fewer unrelated labels than
`[coding, economy]` and wins the marked-default specificity comparison before
cost tie-breaking. Do not introduce a separate suitability/classification ranking
system in v1; avoid decorative labels.

Use a fixed, locale-independent ID comparator for backend tie-breaking. Do not
use array order, availability timestamps, estimated prices, or host locale.

## 5. Resolution and precedence

### 5.1 Preserve existing defaults deliberately

The existing chain is broader than the conversation's shorthand:

1. Action/launch override, including an applicable pinned choice on retry.
2. Instance turn override.
3. Instance process default.
4. Scoped execution-purpose default (instance/repository).
5. YAML turn default.
6. YAML process default.
7. Global `pi.default_model_profile`.

Fixed system-purpose selections currently take precedence over this chain and
cannot be edited. They must still pass all applicable requirements.

**D3 — Accepted: preserve existing default precedence.** Retain this chain, then
apply the new automatic ranking only when no inherited candidate is eligible.
Treat instance turn/action/launch selections and fixed system-purpose models as
hard choices. Treat process, scoped-purpose, and YAML inherited defaults
as preferences that may be skipped ONLY for policy incompatibility.

Consequences:

- An eligible process default still wins over `default: true`.
- A required, eligible global default also wins over marked defaults. Marked
  defaults are chiefly useful when existing defaults fail the turn's requirements.
- Existing instance-default-over-YAML-turn precedence remains unchanged.
- An unknown named profile, malformed saved setting, or unsupported execution
  option is a configuration error, not permission to keep searching.
- Once an eligible candidate is chosen, unavailable/stale status blocks. Do not
  continue to the next default or ranked candidate.

Do not put marked defaults ahead of the global default or retire the global
default requirement in this change.

### 5.2 Pure selection, separate readiness

Keep one server-owned policy module with three conceptual operations:

1. Compile effective requirements and classify profile eligibility.
2. Resolve a profile from explicit intent, inherited preferences, and deterministic
   ranking. Inputs contain no availability state.
3. Check the chosen profile's readiness against cached availability.

The existing policy interface can encapsulate these operations; callers should
not sequence a new family of low-level functions themselves.

Return structured selection/rejection evidence:

- Selected profile ID and source.
- Requirements and their origins.
- Skipped incompatible preferences with concise reason codes.
- Whether ranking used marked defaults or the general cost/ID tie-break.
- Availability as a separate status/reason.

Full scoring/debug traces are unnecessary. Enough structure is needed to avoid
reconstructing explanations from English messages or misleading source labels.

Failure cases must distinguish no eligible model, invalid explicit choice,
unknown profile, unknown required capability, and selected-model unavailability.
Readiness failures retain the chosen profile identity.

## 6. Execution flow and lifecycle

### 6.1 Launch and watcher admission

Resolve each model-selectable turn for preview, but do not materialize resolved
recommendations into explicit `turnConfigs`. Persist operator intent separately
from the selection captured for an actual start.

Validate explicit turn selections against the correct turn. Validate a process
default against process requirements, not the intersection of all turns. A process
with economy-only extraction and premium-only planning is valid with separate
resolved models even though no single profile can serve both.

**D4 — Accepted: source-specific admission, shared execution policy.**

- UI launch requires a resolvable model for every declared LLM turn, including
  optional branches and fixed-purpose LLM turns. Every selected model must also
  be available. A non-LLM entry does not waive the UI's all-turn readiness check.
- Watcher launches do not fail admission solely because a future turn lacks a
  valid model. Retain the configuration and issues; block the affected turn when
  it needs to execute. Report the problem on the dashboard before then.
- Every actual LLM start enforces the same requirements and availability checks,
  regardless of launch source. No source may relax execution policy.
- Malformed input that cannot be represented safely still fails parsing; deferral
  is not permission to discard unknown IDs or forbidden explicit choices.
- Check declared turns without invoking process logic or enumerating dynamic paths.

**D4a — Accepted: immediate UI launch requires all-turn readiness.** Every
selected model must resolve and be available at admission, including models for
optional branches. Availability remains separate from deterministic selection;
an unavailable winner blocks launch rather than causing substitution.

**D4b — Accepted: programmatic and scheduled admission.** Programmatic launches
use UI-style all-turn readiness checks. Schedules created through the UI validate
all turns when saved; due execution enforces readiness at the affected turn.
Preserve server-derived origin; do not add a caller-controlled flag that bypasses
strict UI admission.

Replace silent omission of invalid watcher configuration with retained,
turn-specific diagnostics. A valid but incompatible process preference can be
skipped by the resolver; an unknown profile or invalid explicit turn override
blocks its affected turn. UI launch reports these failures before admission.
Preview sanitization must preserve issues instead of making bad choices look like
successful automatic selection.

Keep watcher deduplication, event acknowledgement, retry behavior, and durable
launch-run reporting intact. Distinguish pre-creation rejection from a durably
created process parked at a blocked turn. Preserve the existing handoff contract
so a parked process does not trigger duplicate launches or lose its source event.
A dashboard diagnostic is not a substitute for the corresponding launch/start
result.

### 6.2 Actions, retries, and scheduled work

- Action input can determine the destination turn. Obtain that turn from the
  existing pure action plan before projecting options or validating an override.
- Extend validation requests with an explicit process-default/turn target; avoid
  an optional turn ID whose omission silently means weaker enforcement.
- Cover save, preview, schedule creation, schedule reconciliation, due execution,
  startup retry, failed-turn retry, continuation, and final start preparation.
- Revalidate at the authoritative mutation/start point; browser previews are
  advisory and may be stale. Preserve drafts on rejection.
- Keep explicit launch/action choices pinned across applicable retries. Clearing
  an override explicitly returns to inheritance.
- Keep inherited future executions responsive to configuration/settings edits,
  but never responsive to availability by choosing another model.
- Recompute provider-specific options from the selected profile/provider. Do not
  carry options for a skipped provider onto the newly selected provider.
- Warm-cache compatibility is advisory and must not rank or admit profiles that
  the destination turn excludes.

### 6.3 Prepared starts and recovery

Prepared/accepted work keeps its captured profile and execution configuration.
A model-readiness failure must also record the selected profile so an availability
transition only retries that profile, not the selection algorithm.

**D5 — Accepted: recovery after edits.** Automatic availability recovery rechecks
the captured selection. An operator retry creates a new preparation and may
re-resolve inherited choices under current settings; explicit turn/action choices
remain pinned unless cleared. If policy now forbids the captured choice, block
recovery and require a new preparation. Never change an already accepted
execution's model.

Preserve lifecycle coordination, deferred extension events, start acceptance,
turn-record correlation, and the rule that a pre-acceptance preparation failure is
not a ProcessTurnRecord attempt.

Audit adoption fingerprints separately for captured execution inputs versus
future selection policy. Canonicalize unordered label/requirement sets and catalog
order where appropriate. A display-order change must not cause a model switch or
unnecessary worker restart. Do not weaken checks on executable worker config.

### 6.4 Internal LLM calls

Title generation receives process-related input but currently bypasses the shared
policy module. Apply process requirements to its fixed configured profile, both
when enqueuing and when dispatching an existing queued job. Never substitute another
profile to make this internal call work.

**D6 — Accepted: optional title failure does not block the business process.**
An excluded/unavailable title profile blocks title generation; retain the existing
untitled/manual-title path and show a diagnostic. Never substitute a model.
Required fixed-purpose turns block normally.

Audit other managed internal LLM calls for equivalent policy bypasses. Document
that arbitrary trusted extension/tool networking is not secured by profile filters.

## 7. UX plan

Mode: Operate. Preserve the existing calm, native, keyboard-first interface. No
new settings management surface or routing-rule editor.

### 7.1 Shared model picker

Use one common options/data presentation across launcher, instance editor, action,
retry/recovery, scheduled launch, and applicable scoped-settings model controls.

- Group as Free, Economy, Standard, Premium, then Other models. Use the first
  matching cost label in that fixed order; profiles without one appear in Other
  models. Do not introduce an Unclassified tier or reject multiple cost labels.
- Sort alphabetically by stable profile ID within each group, regardless of YAML.
- Show profile ID as primary identity; provider/model/thinking settings as
  supporting detail so similar profiles remain distinguishable.
- Keep eligibility and availability separate. An eligible but unavailable profile
  remains visible with a reason; never make automatic selection look like “no model”.
- Keep a saved selected profile visible even when deleted, excluded, or unavailable.
  A missing option must not make the browser display the blank/automatic option.
- Hide unrelated excluded candidates by default; offer “Why unavailable?” with
  per-profile reasons and the process/turn/configuration source.
- User search/filters only narrow the display. They never alter saved selection,
  effective requirements, or backend resolution. Distinguish “no search matches”
  from “no model satisfies this turn's requirements”.
- Native selects support optgroups, not reliable rich badges or explanations.
  Start with text options plus selected-profile details and a disclosure beneath
  the field. Add compact search/label filters around the select where needed;
  do not build a custom combobox just to put chips inside options.
- Use text as well as color, visible labels, keyboard focus, announced preview
  updates, and a single-column mobile layout.

Unavailable options may stay disabled for new overrides, as today, but the current
selection and reason remain visible. “Selected” does not imply “ready”.

### 7.2 Launch

Primary view: process preference and a compact resolved-model summary per turn.
Per-turn overrides remain an advanced disclosure. Requirements and unresolved
steps are visible without opening every selector. UI launch is disabled while
any declared LLM turn lacks a resolvable, available model; link each error to its
step control.
Do not hide optional-branch errors behind the advanced disclosure.

Use `Automatic` / `Use automatic selection` rather than an unqualified
`Recommended` / `Use process default` when the backend can choose a different model.
Example: “sol · Automatic — process default does not satisfy coding.”

Changing the process default previews all affected turns. Show which turns keep
it and which use another model; never imply it forces one model across the process.
If the preference is used by no turn, explain that rather than presenting it as
an effective model. A valid configuration can have no common model for all turns.

Do not badge `default: true` as “the default”: multiple profiles can be marked.
Prefer “Default candidate” in details; show the actual resolved selection clearly.

### 7.3 Existing processes, actions, and recovery

Show three separate concepts where applicable:

- Model used by the active/recorded execution.
- Process preference and explicit overrides.
- Model that a new execution would resolve now.

Changing defaults must not make historical records appear to have used the new
model. “Default at creation” is not evidence of every turn's execution model.

Action selectors follow the planned target turn, not just the process catalog.
If input changes the target, retain the explicit draft, explain that it is now
invalid, and require correction. Do not silently erase it.

Recovery distinguishes “Retry with captured explicit model” from “Use current
automatic selection”. Explain blocking credentials without promising failover.

### 7.4 Dashboard

Use the shared policy evaluator without provider probes, launch resolution,
process side effects, or arbitrary extension callbacks.

Separate:

- Errors: no eligible model for a turn; forbidden explicit choice; unknown profile;
  selected profile unavailable; incompatible fixed-purpose model.
- Warnings: stale availability, selection requiring generic cost/ID fallback,
  or materially tied marked defaults. Missing cost classification alone is not
  a special configuration issue.
- Information in local previews: a process preference skipped for an expected
  turn requirement. This alone is not a configuration error.

Diagnostics name the process/turn, affected profile, failed requirement, and its
origin. Link to editable instance/scoped settings where available; otherwise show
the configuration path. Group shared provider/profile failures instead of one
alert per affected turn.

Do not warn merely because two defaults share `coding`. Specificity may resolve
that overlap intentionally. Recommended warning threshold: equal specificity
among eligible marked defaults, with the winning tie-break stated. Avoid warning
about unreachable hypothetical combinations or resolved historical executions.

The dashboard must detect definition-level failures even when no process has yet
been launched. Scope live instance issues to current/future work; historical
profile removal must not masquerade as broken past execution.

## 8. Persistence and compatibility

- Preserve existing profile IDs, explicit selections, launch intent, and historical
  provider/model/cost attribution.
- Add provenance sources for marked-default and generic automatic selection;
  decide fixed-purpose provenance explicitly instead of calling it a process default.
- Update source validators, codecs, HTTP/IPC projections, presenters, and scoped
  settings capture. Do not infer new semantics solely from `kind: explicit`.
- Persist enough selection provenance to distinguish the original execution from
  a new preview. Decide whether compact requirement/policy evidence must accompany
  captured starts; current metadata must never be presented as historical evidence.
- Keep profile metadata and policy server-owned where workers do not need them.
  Avoid expanding worker snapshots/credentials just for picker display.
- Inspect durable schema/JSON validation before implementation. Any durable schema
  change requires an explicit migration and file-backed preservation tests; extending
  serialized enums also needs backward-compatible decoding and a rollout decision.
- Existing configurations without new requirements should keep their selected
  models under D3. Sorting changes are presentation-only for those configurations.
- Model properties/requirements remain startup configuration in v1. Do not imply
  hot reload; scoped settings and instance overrides retain their existing lifecycle.

## 9. Implementation sequence

### Phase 1 — Encode confirmed semantics and examples

D1–D6, including D1a and D4a/D4b, are agreed. Finalize SDK/config field names and
write independent examples for inheritance, intersections, specificity,
availability blocking, and recovery. Align target-state docs with these confirmed
contracts as implementation begins.

### Phase 2 — Data and policy core

1. Extend profile/config/protocol and SDK declarations, including flow-builder
   propagation and definition validation.
2. Resolve stable provider capability metadata without live status dependencies.
3. Compile requirements with origins and canonical sets.
4. Add pure eligibility/ranking and richer provenance behind the current policy
   module. Retain the established default chain according to D3.
5. Add turn-targeted validation/projection, not UI-local filtering.

### Phase 3 — Enforce every execution path

Update launch preparation, watchers, instance patching, action planning/commit,
future execution lifecycle/reconciliation, retries, preparation recovery, fixed
purposes/title jobs, and the final turn-start preflight. Remove silent omission
from admission and preserve failure evidence. Audit worker capture/adoption.

### Phase 4 — Project and present

Extend HTTP/SDK view contracts with metadata, per-turn eligibility, selected identity,
and short structured reasons. Build shared grouped options and update every picker.
Preserve explicit-vs-inherited intent and preview/draft race handling. Add dashboard
policy diagnostics from the same evaluator.

### Phase 5 — Migration, documentation, and validation

Update `leitwerk.yaml.example` with every new config field. Align relevant contracts
in `docs/models.md`, `docs/configuration.md`, `docs/process-sdk.md`,
`docs/scoped-settings.md`, `docs/ui.md`, `docs/watchers.md`,
`docs/server-worker-lifecycle.md`, `docs/llm-turn.md`, `docs/ubiquitous_language.md`,
and `docs/security.md`; review the other source-of-truth docs for wording drift.
Update extension READMEs only for their actual declarations/provider contracts.
Keep dynamic code classification in `docs/future.md`.

Review whether the precedence/availability trade-off warrants a short ADR in the
repository's established architecture-decision structure. Do not create a parallel
glossary or duplicate the ubiquitous language.

## 10. Validation matrix

Test through observable policy/HTTP/SDK behavior, not source structure or helper
names. Reuse existing policy and integration suites rather than duplicating them.

| Scenario | Expected result |
| --- | --- |
| Reorder profiles, labels, or equivalent restriction sets | Same selected ID and eligibility; picker remains sorted. |
| Process default lacks coding; sol is an eligible marked coding default | sol selected for coding turn; process preference retained for other turns. |
| Marked defaults `[coding]` and `[coding, planning]`; require coding | Fewer unrelated labels wins before cost. |
| Require both coding and planning | Coding-only profile excluded. |
| Equal specificity | Cost tier then fixed ID ordering decides. |
| No marked default eligible | Cost/ID selection; diagnostic explains generic fallback. |
| Process and turn any-of clauses differ | Both clauses must be satisfied; union cannot widen eligibility. |
| Required capability or required positive label absent | Does not satisfy that requirement; cost labels use ordinary label matching. |
| No cost label and no cost-label requirement | Eligible without cost-specific warning; follows named cost groups. |
| Multiple cost labels | First matching label in fixed cost order determines group/tie-break; all labels remain active in matching/specificity. |
| Zero/missing token prices without explicit free label | Never classified as free. |
| Chosen default unavailable; other candidates available | Same chosen ID, blocked execution. |
| Provider status changes while config stays fixed | Readiness changes, selected ID does not. |
| Unknown explicit/saved profile | Clear failure; no omission or automatic substitute. |
| Forged turn override through HTTP/SDK | Rejected server-side before the forbidden call. |
| Process default incompatible with one turn | Turn resolves independently; no requirement that one profile serve all turns. |
| UI launch has an unresolvable optional LLM turn | Admission blocked with a turn-specific explanation. |
| Watcher has an unresolvable future turn | Launch may proceed; affected turn blocks when reached; configuration is retained and diagnosed. |
| Watcher's immediate turn has a bad configured override | No forbidden call; visible blocked start; dedup/event acknowledgement behavior preserved. |
| Action input changes destination turn | Options/validation use the new turn; invalid draft remains explainable. |
| Availability recovery after inherited setting edit | Automatic recovery keeps captured model; operator retry may re-resolve inherited choices. |
| Programmatic launch has an unavailable optional-turn model | All-turn readiness check blocks admission. |
| UI-created schedule | All-turn readiness checked when saved; due execution blocks at affected turn without substitution. |
| Scheduled work reaches execution after settings/policy changes | Explicit intent preserved; inherited selection refreshed under defined lifecycle. |
| Fixed purpose/title model violates process policy | No forbidden LLM request; required turn blocks, optional title job does not block business process. |
| Model metadata/defaults edited during a running call | Current capture unchanged; future resolution reflects permitted edits. |
| Invalid/deleted selected profile in picker | Identity/error stays visible; control never appears reset to automatic. |
| Preview responses arrive out of order | Latest draft wins; submitting unchanged automatic choice stays inherited. |
| Many affected turns share one unavailable provider | Grouped dashboard issue, not alert spam. |

Use extension-owned fakes and `FakeLlmProvider`; no real model/provider calls are
needed. Include file-backed migration/restart tests if persistence changes, plus
focused browser checks at desktop/mobile widths for grouping, keyboard operation,
empty/blocked states, and long profile names.

Rebuild before Vitest. Application/shared-contract/config changes require
`npm run test:full`. The implementation requires full application validation and focused browser checks.

## 11. Decision status

All behavioral decisions confirmed:

- **D1:** Cost values are ordinary labels, with no dedicated fields or special
  missing-cost validation/warnings.
- **D1a:** First matching cost label determines grouping/tie-break; profiles
  without one follow the named cost groups. Multiple cost labels are valid.
- **D2:** All policy labels, including cost labels, affect specificity.
- **D3:** Preserve existing inheritance before the new ranking heuristic.
- **D4/D4a:** Immediate UI launch requires all declared LLM turns to resolve and
  their selected models to be available; watcher launches defer model-policy
  blocks to the affected turn.
- **D4b:** Programmatic launches require all-turn readiness. UI-created schedules
  validate all turns when saved; due execution blocks at the affected turn.
- **D5:** Automatic recovery keeps the captured selection. Operator retry may
  re-resolve inherited choices; explicit turn/action choices remain pinned unless
  cleared.
- **D6:** Optional title-job failure does not block the business process.

Implementation review still needs to finalize field names, reliable capability
metadata, and any durable encoding/migration changes. These technical choices
must preserve the confirmed behavior above.
