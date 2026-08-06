# Models

Model profiles give operators and processes stable names for configured provider models.

## Model profiles

Define profiles under `pi.model_profiles`:

```yaml
pi:
  model_profiles:
    - id: gpt_sol_high
      provider: openai
      model_id: gpt-4o
      thinking_level: high
    - id: claude_fast
      provider: anthropic
      model_id: claude-3-5-sonnet-20241022
    - id: gateway_coder
      provider: internal-gateway
      model_id: gemma-4-31b-it
```

### Profile fields

| Field | Description |
|---|---|
| `id` | Custom profile name presented in the UI and referenced in process configurations (e.g. `gpt_sol_high`). |
| `provider` | ID of a registered standard, custom-gateway, or extension-owned provider. |
| `model_id` | Canonical model identifier recognized by the backend provider (e.g. `gpt-4o`). |
| `thinking_level` | Optional reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). |
| `provider_options` | Optional key-value object of provider-specific execution settings. |

## Standard and custom providers

Load `./extensions/models` to register standard API-key providers and configured gateways:

```yaml
extension_loading:
  sources:
    - ./extensions/models

extensions:
  models:
    openai:
      api_key: env:OPENAI_API_KEY
    anthropic:
      api_key: env:ANTHROPIC_API_KEY
```

### Credential initialization

`api_key` under `extensions.models.<provider_id>` accepts a literal value or `env:VAR_NAME`. When omitted for a standard provider, the models extension checks that provider's standard Pi environment variables. The resulting value only initializes an empty encrypted credential store; an existing durable revision wins on restart.

Set a custom gateway's `api_key` to `false` only when its endpoint intentionally accepts unauthenticated requests.

### Custom gateways

Define OpenAI-compatible gateways and internal inference endpoints under `custom_gateways`:

```yaml
extensions:
  models:
    custom_gateways:
      internal-gateway:
        base_url: https://llm-gateway.example.com/v1
        api_key: false # Set to false for unauthenticated endpoints, or use env:VAR_NAME
        api: openai-completions
        models:
          - id: gemma-4-31b-it
            name: Gemma 4 31B IT
            reasoning: true
            context_window: 262144
            max_tokens: 32768
          - id: qwen-3.6-27b
            name: Qwen 3.6 27B
            reasoning: true
            context_window: 131072
            max_tokens: 81920
```

```yaml
pi:
  model_profiles:
    - id: gateway_gemma
      provider: internal-gateway
      model_id: gemma-4-31b-it
```

## Profile resolution

LLM turns resolve their profile in this order:

1. One-shot action override.
2. Launch per-turn override.
3. Process `turn_configs.<turnId>.model_profile`.
4. Launch default profile.
5. Process `default_model_profile`.
6. First allowed profile in `pi.model_profiles`.

## Extension-defined providers

An extension exposes one owner-scoped provider set. It may return a fixed provider or providers derived from its configuration:

```ts
import { defineModelProvider, defineModelProviders } from "@leitwerk-dev/process-sdk";

const customModelProvider = defineModelProvider({
	id: "custom-broker",
	parseConfig: parseCustomConfig,
	worker: customWorker,
	models: evaluateCustomModelStatuses,
	credential: { parse: parseCustomCredential },
	secrets: ({ credential }) => credential ? { token: credential.token } : {},
});

export const modelProviders = defineModelProviders((rawConfig) => [{
	definition: customModelProvider,
	rawConfig,
}]);
```

Provider sets resolve before server setup. Provider definitions remain code-owned; the models extension uses the same interface to instantiate custom gateways declared under `extensions.models.custom_gateways`.
