# Models

A model profile gives a provider/model pair a stable name. Operators select that
name at launch or for future work; processes can supply defaults and restrict
allowed profiles. Selection never changes a model call already in flight.

## Model profiles

```yaml
pi:
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

## Profile resolution

LLM turns resolve profiles in this order:

1. One-shot action override.
2. Launch per-turn override.
3. Process `turn_configs.<turnId>.model_profile`.
4. Launch default profile.
5. Process `default_model_profile`.
6. First allowed profile in `pi.model_profiles`.

`process_configs.<processId>.allowed_model_profiles` restricts defaults and overrides.
Omitting the restriction permits all configured profiles; selecting an unavailable
profile does not bypass credential requirements.

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
