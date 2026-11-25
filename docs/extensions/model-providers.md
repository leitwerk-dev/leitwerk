# Model providers

Extensions own model provider implementations. Startup resolves each extension's providers before `setupServer`, validates owner-scoped configuration under `extensions.<extensionId>`, and stores credentials in the encrypted SQLite credential store. For operator YAML setup and profile resolution order, see [Models](../admin/models.md).

## Exposing a provider set

Attach `modelProviders` to your `LeitwerkExtensionModule` using `defineModelProviders`:

```ts
import {
  defineModelProviders,
  type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";

export default {
  manifest: { id: "my-provider-ext", version: "1.0.0" },
  modelProviders: defineModelProviders((ownerConfig) => [
    { definition: myProvider, rawConfig: ownerConfig },
  ]),
} satisfies LeitwerkExtensionModule;
```

`defineModelProviders` receives only the owning extension's `extensions.<id>` fragment and returns `{ definition, rawConfig }[]` entries. It may return fixed providers or dynamically instantiate providers (such as custom gateways) from owner configuration. Malformed provider configuration fails startup; missing credentials leave profiles unavailable rather than crashing startup.

## Defining a provider

Build each provider with `defineModelProvider({ id, parseConfig, worker, server?, models, capabilities?, options?, secrets, credential? })`:

| Field | Contract |
| --- | --- |
| `id` | Unique provider ID referenced by `pi.model_profiles[].provider`. |
| `parseConfig(raw)` | Parses non-secret `config` and optional bootstrap `credential` (used only to initialize an empty durable store; an existing stored revision wins on restart). |
| `worker` | How workers load the provider: `builtinPiProvider(id)`, `configuredPiProvider(id, resolveModels)` (emits non-secret `models.json` into the immutable Pi snapshot), or `piWorker({ config?, credentialFiles? })`. |
| `server` | Optional server-side adapter (`builtinPiProvider(id)` or `piServer()`) for server-only LLM calls such as title generation. |
| `models(ctx)` | Reports `ProviderModelStatus[]` (`available`, `unavailable`, or `stale`, plus optional credential-free `safeReason`) for configured profiles. Providers without live probing can delegate to `credentialBasedModelStatuses(...)`. |
| `capabilities({ config, modelId })` | Optional synchronous catalog projection. Reports `true`, `false`, or `"unknown"` per capability. Missing metadata is unknown. Do not probe readiness or credentials or perform side effects here. |
| `options` | Optional `defineProviderOptions({ fields, choices? })` declaring non-secret per-profile `provider_options`. |
| `secrets(ctx)` | Maps validated `config`, current `credential`, and resolved `options` to key/value secrets delivered over authenticated worker IPC (never baked into non-secret resource snapshots). |
| `credential` | Optional `{ parse(value) }` validator applied to configured, stored, and worker-refreshed credentials. |

## Custom Pi worker and server entrypoints

Prefer `builtinPiProvider` or `configuredPiProvider` when Pi's built-in APIs suffice. For custom worker or server adapters (`piWorker(...)` / `piServer()`), declare lane-aware entrypoints inside `package.json`:

```json
{
  "leitwerk": {
    "extension": {
      "source": "./src/index.ts",
      "import": "./dist/index.js"
    },
    "pi": {
      "worker": {
        "source": "./src/pi-worker.ts",
        "import": "./dist/pi-worker.js"
      },
      "server": {
        "source": "./src/pi-server.ts",
        "import": "./dist/pi-server.js"
      }
    }
  }
}
```

- **Worker entrypoint (`leitwerk.pi.worker`):** Exports a default `definePiWorker((pi, ctx) => { pi.registerProvider(...); })`. `ctx` provides `model`, resolved `options`, validated `workerConfig`, `secrets` (`get`, `require`, `keys`), and `report(event)`.
- **Versioned worker config:** Pass `config: defineWorkerConfig({ version, schema, resolve })` to `piWorker(...)` to project non-secret provider config into a versioned JSON payload delivered to `ctx.workerConfig`.
- **Server entrypoint (`leitwerk.pi.server`):** Exports a default `definePiServerAdapter({ generateText(input) })` for server-only text generation (such as process title generation).

See the built-in [models extension](../../extensions/models/README.md) for a complete implementation of standard API-key providers and custom gateways, and [API compatibility](process-sdk.md#api-compatibility) for supported SDK classifications.
