# Models

A model profile gives a provider/model pair a stable name. Operators select that
name at launch or for future work; processes can supply defaults and restrict
allowed profiles. Selection never changes a model call already in flight.

## Dashboard costs and readiness

The dashboard reports estimated USD costs from durable LLM turn summaries across
retained processes. Each turn contributes once, including failed attempts and
alternate branches. Grouping uses the provider/model captured at turn start;
editing or removing a profile does not change historical attribution. Older
records without a captured identity appear under **Unknown model**. Costs do not
include deleted process history or internal calls without recorded turn usage.

Only turns with recorded cost contribute to totals and per-model rows. A recorded
zero is valid; absent cost is unavailable. Partial coverage reports the number of
priced turns. These estimates are not a provider billing statement.

Configuration issues report unknown or disallowed model references, unavailable
profiles or credentials, stale availability, and invalid saved model settings.
Sources identify YAML defaults, watcher overrides, scoped settings, current
process selections, and scheduled work. Correctable settings and processes link
to their existing pages. The dashboard reads cached availability and does not
probe providers, change model choices, or run recovery. Fatal startup validation
still applies; a server that cannot start cannot serve its dashboard.

## Model profiles

```yaml
pi:
  default_model_profile: example_model
  model_profiles:
    - id: example_model
      provider: openai
      model_id: gpt-4o
    - id: gateway_coder
      provider: internal-gateway
      model_id: team-coder
```

These are examples, not a bundled catalog. Use model IDs available to your account
or defined by your gateway, and load the extension that owns each provider.

### Profile fields

| Field | Contract |
| --- | --- |
| `id` | Your profile name, shown in the UI and referenced in configuration. |
| `provider` | Registered standard, custom-gateway, or extension-owned provider ID. |
| `model_id` | Model ID understood by that provider. |
| `thinking_level` | Optional Pi level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The selected model must support it. |
| `provider_options` | Optional non-secret string map of provider-owned execution settings. |

A missing credential makes profiles unavailable. Malformed provider configuration
fails startup. Check the provider ID, loaded extension, model ID, and credential
status before retrying a launch.

## Standard and custom providers

The optional models extension registers standard API-key providers and configured
gateways:

```yaml
extension_loading:
  sources:
    - ./extensions/models

extensions:
  models:
    openai:
      api_key: env:OPENAI_API_KEY
```

Merge this with the existing extension list; do not replace other required sources.
Full provider fields, custom model definitions, compatibility options, limits, and
cost metadata belong in the
[models extension reference](https://github.com/leitwerk-dev/leitwerk/blob/main/extensions/models/README.md).

### Credential initialization

A provider's `api_key` accepts a literal secret or `env:VARIABLE`. If omitted for a
standard provider, the models extension checks that provider's standard Pi
environment variables. This initializes only an empty encrypted credential store;
an existing durable revision wins on restart. Changing the environment is not a
credential-rotation mechanism for an already initialized store.

The server sends current credentials separately from immutable non-secret model
resources. Workers do not load the operator's ambient Pi directory.

### Custom gateways

Standard providers may override their non-secret `base_url` and declare model IDs
absent from Pi's catalog, such as private deployment IDs. Both worker calls and
server-side title generation use the configured endpoint and explicit definitions.

Configured gateways live under `extensions.models.custom_gateways`. Set
`api_key: false` only for an intentionally unauthenticated endpoint. Generated
placeholder material has a null revision: it is not stored or refreshed as a
persistent credential.

Explicit model definitions must describe the endpoint's actual limits and
capabilities. Omitted metadata uses Pi's defaults: text input, no reasoning, zero
estimated cost, 128,000 context tokens, and 16,384 output tokens. These are not
claims about the endpoint. `thinking_level_map` can map a Pi level to a provider
value or null for unsupported levels.

`cost` supplies USD rates per million tokens for `input`, `output`, `cacheRead`,
and `cacheWrite`. Optional `cost.tiers` entries supply the same rates plus
`inputTokensAbove`. Pi selects the highest threshold exceeded by a request's
combined input, cache-read, and cache-write tokens, and applies that tier to
the entire request. Reasoning tokens already counted in output are not billed
a second time.

## Profile resolution

LLM turns resolve profiles in this order:

1. Explicit action choice.
2. Explicit process turn choice.
3. Explicit process default.
4. Scoped execution-purpose default (Instance → primary Repository).
5. YAML `turn_configs.<turnId>.model_profile`.
6. YAML process `default_model_profile`.
7. Required global `pi.default_model_profile`.

`pi.default_model_profile` must name a configured profile. Missing, blank, or unknown
values fail configuration loading. Catalog order never selects a default. Existing
installations must add this setting before upgrading.

Turn, launch and action overrides are hard choices. Fixed system-purpose profiles
are authoritative and must satisfy the same requirements. Other inherited defaults
are preferences: skip a known profile only when policy excludes it, then continue
the chain. Unknown profiles and malformed settings block rather than falling back.
Once an eligible profile is chosen, unavailable or stale status blocks; availability
never changes selection. Clearing an override restores automatic selection. Merely
viewing or submitting an automatic recommendation does not pin it.

When no inherited preference is eligible, prefer eligible profiles marked `default:
true`. Among those candidates, fewer unrelated labels wins, then cost group, then
profile ID. Relevant labels are the union of positive all-of/any-of labels in every
effective layer. All other labels, including cost and organization labels, count
as unrelated. Without eligible marked defaults, rank by cost group then ID.
IDs use fixed, locale-independent ordering; configuration order has no effect.

Immediate UI and programmatic launches, and UI-created schedules, require every
declared LLM turn to resolve and be available, including optional branches and
fixed-purpose turns. Watchers and due schedules defer policy blocks to the affected
turn. Title generation uses its fixed profile with process requirements; a blocked
title does not block the business process or substitute another title model.

[Scoped settings](scoped-settings.md) resolve when preparing each new start and
retain their values and revisions with that start. Later edits affect future steps,
including new operator retries, while worker recovery uses the captured start.

### Classification and requirements

Profiles may declare `labels` (default `[]`) and `default` (default `false`). Labels
are case-sensitive lowercase ASCII identifiers matching `[a-z][a-z0-9_.-]*` and
are normalized as sets. Operators own suitability and cost assertions. Starter
labels include `coding`, `planning`, `research`, `writing`, and `extraction`.
`free`, `economy`, `standard`, and `premium` are ordinary labels, not price fields.
`free` means no usage cost; zero or missing provider prices never imply it.
The first matching cost label in that order controls grouping and tie-breaking.
Profiles without a cost label follow under Other models. Multiple cost labels
are valid; all remain active for matching and specificity.

Code declares `modelRequirements` on processes and LLM turns (or through the flow
builder's `.modelRequirements(...)`). Configuration adds `model_requirements` at
process and turn levels. Each requirements object supports `profiles` (allowlist),
`capabilities` (all required), and `labels` with `all_of`, `any_of`, and `none_of`.
Explicit empty profile allowlists and any-of clauses are invalid.

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

Code process, operator process, code turn and operator turn layers are conjunctive.
Each any-of clause must match independently; clauses are never unioned. The legacy
`allowed_model_profiles` additionally intersects these restrictions. An empty
intersection blocks work but leaves the dashboard available. A process preference
need not serve every turn. Validate it against process requirements; validate turn
choices against that turn's effective requirements.

Capabilities are supplied by the owning provider's synchronous `capabilities`
catalog projection at startup, not by status probes. Only confirmed `true` support
satisfies a required capability; absent, unknown and false support fail eligibility.
The models extension supplies `image-input` and `reasoning`. Registration alone
never proves tool-use support. Classification and requirements are startup-only.

Selection provenance adds `marked_default`, `automatic` and `fixed_purpose` to the
existing serialized sources. Existing records decode unchanged; there is no SQLite
schema change. Upgrade server and workers together; do not downgrade to a decoder
that does not recognize these sources after new selections have been persisted.
Captured starts retain identity and provenance, not current classification labels.

Automatic availability recovery rechecks the captured profile, even after settings
edits. If policy now excludes it, recovery blocks. Operator retry makes a new
preparation and may re-resolve inherited choices; explicit choices remain pinned
unless cleared.

## Extension-defined providers

An extension exposes one owner-scoped `modelProviders` resolver built with
`defineModelProviders`. It returns provider definitions and the configuration fragment
for each. It may return a fixed provider or instantiate providers from owner configuration.

Sets resolve before `setupServer`. Each provider validates only its returned
fragment. A provider using Pi's standard APIs can contribute non-secret model
resources through `configuredPiProvider`; credentials remain separate. Custom
providers use `defineModelProvider` to declare configuration, model availability,
credential parsing, and worker behavior.

See the [SDK provider declarations](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/process-sdk/src/model-provider.ts)
for signatures and the [SDK compatibility contract](process-sdk.md#api-compatibility)
for supported members.

### Editing a running instance

In **Process inspector → Inputs & configuration → Model defaults and overrides**,
choose **Edit models** to change the instance default or individual step profiles.
Nonterminal processes remain editable, including active, errored and scheduled work.
Completed and aborted processes are read-only. Steps with a fixed system-purpose
model cannot be overridden.

Changes apply to future executions and retries. An active execution or prepared
start keeps its recorded model. Explicit one-time launch and action selections
remain in effect for their execution and retries. Saving does not restart workers,
retry failed work, change the plan revision, or alter the default recorded at creation.

Clearing a step override restores the explicit process default, then the scoped
purpose default, YAML turn default, YAML process default, and configured global default.
Explicit process choices take precedence over YAML turn defaults. Scheduled actions that
inherit instance settings refresh their displayed model and availability block;
their payloads and run times do not change. Explicit scheduled model choices remain.

`PATCH /api/processes/:instanceId/model-config` saves a sparse patch;
`POST /api/processes/:instanceId/model-config/preview` previews the same patch.
Both accept `defaultModelProfileId` and `turnConfigs`, for example:

```json
{"defaultModelProfileId":"fast","turnConfigs":{"draft":{"modelProfileId":null}}}
```

Omitted settings remain unchanged. `null` clears an instance override. The server
validates selected profiles against process policy and current availability.
Unknown, non-model and fixed-model steps are rejected. Malformed saved settings
must be repaired before editing. Saves merge with the latest persisted settings:
unrelated concurrent edits survive, and the last successful save wins for the same
setting. Changes are recorded with the acting principal.
