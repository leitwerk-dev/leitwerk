# Models extension

The `models` extension owns Leitwerk's standard Pi providers and configuration-defined custom gateways. Custom gateways use the managed, credential-blind `models.json` snapshot; API keys are seeded into the encrypted provider credential store and projected separately through managed `auth.json`.

## Configuration

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
    azure-openai-responses:
      api_key: env:AZURE_OPENAI_API_KEY
      base_url: https://my-resource.openai.azure.com
      models: # Optional deployments absent from Pi's built-in catalog.
        - id: private-reasoner
          reasoning: true
          thinking_level_map: {low: low, medium: medium, xhigh: xhigh}
    custom_gateways:
      internal-gateway:
        base_url: https://llm-gateway.example.com/v1
        api_key: false
        api: openai-completions
        compat:
          supportsStore: false
          thinkingFormat: deepseek
        models:
          - id: gemma-4-31b-it
            name: Gemma 4 31B IT
            reasoning: true
            thinking_level_map: {off: null, xhigh: high}
            input: [text]
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
            context_window: 262144
            max_tokens: 32768

pi:
  model_profiles:
    - id: gateway-gemma
      provider: internal-gateway
      model_id: gemma-4-31b-it
```

`api_key` accepts a literal value or `env:VARIABLE`. It only initializes an empty durable credential store; a stored revision wins on restart. Standard providers also accept an optional non-secret `base_url`, which is projected through managed `models.json` and used for server-side model calls. Set a custom gateway's `api_key` to `false` only for an endpoint that intentionally accepts unauthenticated requests.

The extension uses a code-defined standard-provider list with explicit environment-variable mappings. Pi upgrades do not implicitly enable new providers. Providers with ambient or OAuth-only authentication, including Bedrock and OpenAI Codex, require dedicated extensions.

Standard providers accept an optional `models` list to add deployments or replace catalog definitions by ID. These definitions use the provider's canonical API and configured endpoint for both worker and server calls. Credential availability still controls whether a model can be selected. Missing metadata uses Pi's explicit-model defaults: text input, no reasoning, zero estimated cost, 128,000 context tokens and 16,384 output tokens. Specify the actual limits and costs when known.

Both kinds of model definition accept `thinking_level_map`, `input`, `cost`, and `compat`. Thinking-map keys are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `null` marks a level unsupported. `context_window`, `max_tokens`, and `thinking_level_map` are converted to Pi's field names. `cost` and `compat` use Pi's camelCase keys directly. Gateway-level compatibility settings apply to all models; model-level settings override them. Supported compatibility keys are `supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `maxTokensField`, `supportsStrictMode`, `thinkingFormat`, and `requiresReasoningContentOnAssistantMessages`. Model IDs must be unique within each list, and unknown metadata fields are rejected.

Custom gateways support `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`. They support worker LLM turns. Because they do not declare a server adapter, they cannot be selected for process-title generation.
