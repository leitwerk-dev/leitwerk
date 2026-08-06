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
    custom_gateways:
      internal-gateway:
        base_url: https://llm-gateway.example.com/v1
        api_key: false
        api: openai-completions
        models:
          - id: gemma-4-31b-it
            name: Gemma 4 31B IT
            reasoning: true
            context_window: 262144
            max_tokens: 32768

pi:
  model_profiles:
    - id: gateway-gemma
      provider: internal-gateway
      model_id: gemma-4-31b-it
```

`api_key` accepts a literal value or `env:VARIABLE`. It only initializes an empty durable credential store; a stored revision wins on restart. Set it to `false` only for an endpoint that intentionally accepts unauthenticated requests.

The extension uses a code-defined standard-provider list with explicit environment-variable mappings. Pi upgrades do not implicitly enable new providers. Providers with ambient or OAuth-only authentication, including Bedrock and OpenAI Codex, require dedicated extensions.

Custom gateways support `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`. They support worker LLM turns. Because they do not declare a server adapter, they cannot be selected for process-title generation.
