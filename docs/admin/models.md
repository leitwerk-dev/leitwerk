# Models

A model profile gives a provider and model ID a stable name referenced in configuration, process defaults, and the UI. Model selection affects only future LLM calls, never a call already in flight.

## Model profiles

Define profiles under `pi.model_profiles` and name the global fallback in `pi.default_model_profile`:

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

There is no bundled model catalog. Load the extension that owns each referenced provider and use model IDs accepted by your account or gateway. `pi.default_model_profile` is required; missing, blank, or unknown values fail startup, and catalog order never selects a default.

| Field | Contract |
| --- | --- |
| `id` | Profile name shown in the UI and referenced across configuration. |
| `provider` | Registered standard, custom-gateway, or extension-owned provider ID. |
| `model_id` | Model ID understood by that provider. |
| `thinking_level` | Optional Pi reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Must be supported by the model. |
| `provider_options` | Optional non-secret string map of provider-owned execution options. |

A missing credential makes matching profiles unavailable. Malformed provider configuration fails startup.

## Standard providers and credentials

Load `./extensions/models` to register standard API-key providers and custom gateways:

```yaml
extension_loading:
  sources:
    - ./extensions/models

extensions:
  models:
    openai:
      api_key: env:OPENAI_API_KEY
```

Merge `./extensions/models` with your existing `extension_loading.sources`. For the full list of supported providers, compatibility flags, and model metadata fields, see the [models extension reference](../../extensions/models/README.md).

### Encrypted credential initialization

`api_key` accepts a literal secret or `env:VARIABLE`. If omitted for a standard provider, the models extension reads that provider's standard Pi environment variable.

Environment and YAML credentials initialize an empty encrypted credential store in SQLite (`provider_credentials`, encrypted with `LEITWERK_CREDENTIAL_ENCRYPTION_KEY`). Once stored, the durable credential revision wins on restart—changing an environment variable does not rotate an already initialized credential.

The server delivers immutable, non-secret model resource snapshots separately from the current credential layer on each physical worker start. Workers ignore `~/.pi/agent`.

## Custom gateways and pricing

Standard providers may override their non-secret `base_url` and declare additional `models` absent from Pi's built-in catalog (such as private deployment IDs). Both worker turns and server-side title generation use these endpoints and definitions.

Define OpenAI- or Pi-compatible gateways under `extensions.models.custom_gateways`:

- Custom gateways support worker LLM turns only; because they declare no server adapter, they cannot be selected for `pi.process_title_generation.model_profile`.
- Set `api_key: false` only for intentionally unauthenticated endpoints. Its placeholder material carries a `null` revision and is never persisted as a stored credential.
- Declare accurate limits and capabilities on custom models. Omitted fields fall back to Pi defaults: text-only input, `reasoning: false`, zero estimated cost, `128000` context tokens, and `16384` output tokens.
- Use `thinking_level_map` to map Pi thinking levels to provider values or `null` for unsupported levels.
- `cost` sets USD per million tokens for `input`, `output`, `cacheRead`, and `cacheWrite`. Optional `cost.tiers` entries add `inputTokensAbove`; Pi picks the highest threshold exceeded by a request's combined input, cache-read, and cache-write tokens and applies that tier to the entire request. Reasoning tokens already counted in output are not billed twice.

## Profile resolution {#profile-resolution}

LLM turns resolve their model profile in this order:

1. Explicit action choice.
2. Explicit process turn override.
3. Explicit process default.
4. Scoped execution-purpose default (Instance → primary Repository).
5. YAML `process_configs.<processId>.turn_configs.<turnId>.model_profile`.
6. YAML `process_configs.<processId>.default_model_profile`.
7. Required global `pi.default_model_profile`.

Explicit turn, launch, and action overrides are hard choices. Fixed system-purpose profiles are authoritative and must also satisfy requirements. Other inherited defaults are preferences: skip a known profile only if policy excludes it. Unknown profiles or malformed settings block rather than falling back. Once a profile is selected, unavailable or stale readiness blocks execution; availability never changes the selection. Clearing an override restores automatic selection. Viewing or submitting an unchanged automatic recommendation does not pin it.

If no inherited preference is eligible, prefer eligible profiles marked `default: true`. Rank those by fewest unrelated labels, then cost group, then profile ID. Relevant labels are the union of positive `all_of` and `any_of` labels across all effective layers; all other labels count as unrelated. Without eligible marked defaults, rank by cost group and then ID. ID ordering is locale-independent and catalog order has no effect.

Immediate UI and programmatic launches and UI-created schedules require every declared LLM turn to resolve and be available, including optional branches and fixed-purpose turns. Watchers and due schedules defer policy blocks to the affected turn. Title generation uses its fixed `pi.process_title_generation.model_profile` with process requirements; a blocked title does not block the business process or select a substitute.

The start captures scoped defaults and selection provenance. Automatic recovery rechecks the captured profile under current policy without reranking. An operator retry prepares a new start and may re-resolve inherited preferences. Explicit choices stay pinned unless cleared.

### Classification and requirements

Set `labels` (default `[]`) and `default` (default `false`) on profiles in startup configuration. Labels are case-sensitive lowercase ASCII identifiers matching `[a-z][a-z0-9_.-]*` and are normalized as sets. Operators own suitability and cost assertions. Example labels include `coding`, `planning`, `research`, `writing`, and `extraction`.

The first matching cost label in `free`, `economy`, `standard`, `premium` determines grouping and tie-breaking. Unlabeled profiles follow in Other models. All labels still participate in matching and specificity. These are ordinary labels, not price fields: zero or missing provider prices do not imply `free`.

Code declares `modelRequirements` on processes and LLM turns, including through `.modelRequirements(...)` on flow builders. Operator `model_requirements` can specify a `profiles` allowlist, `capabilities` (all required), or `labels` predicates (`all_of`, `any_of`, `none_of`). Empty allowlists and `any_of` clauses are invalid.

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

Code and operator layers at process and turn levels all intersect, including `allowed_model_profiles`. Each `any_of` clause must match independently. An empty intersection blocks work but leaves the dashboard available. Validate a process preference against process requirements; turn choices must satisfy that turn's effective requirements.

Providers project capabilities synchronously at startup. Only `true` satisfies a requirement, not `false`, unknown, or missing metadata. The models extension reports `image-input` and `reasoning`; registration alone does not prove tool-use support. Classification and requirements are not UI-editable.

Selection provenance adds `marked_default`, `automatic`, and `fixed_purpose`. Existing records decode without a SQLite schema change. Upgrade server and workers together. Do not downgrade to a decoder that does not recognize these sources after new selections have been recorded. Captured starts retain profile identity and provenance, not current classification labels.

## Related guides

- Viewing estimated costs, diagnosing configuration issues, and editing models on non-terminal processes in the UI: [Operate processes](../users/operate-processes.md).
- Implementing extension-defined model providers (`defineModelProviders` / `defineModelProvider`): [Model providers](../extensions/model-providers.md).
