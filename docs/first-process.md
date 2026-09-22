# Write your first process

Create a process that drafts a response, waits for a person to review it, and
completes when they accept. It needs no repository, integration tool, or custom UI.

Use a source checkout with the [local setup](introduction.md) working first. For an
independent extension repository, follow [Development compositions](development-composition.md).

## Create the package

From the repository root:

```sh
mkdir -p extensions/first-process/src
cp docs/examples/first-process.ts extensions/first-process/src/index.ts
```

Create `extensions/first-process/package.json`:

```json
{
  "name": "@example/first-process",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "leitwerk": {
    "extension": {
      "source": "./src/index.ts"
    }
  }
}
```

This is a source-development package using the SDK installed by the checkout.
Before distributing it, declare its SDK dependency and add a build that supplies
`leitwerk.extension.import`. See [extension packaging](process-sdk.md#extension-package).

## Define the process

The complete [source file](examples/first-process.ts) is included below. The
walkthrough and its validation use the same file.

```ts
--8<-- "docs/examples/first-process.ts"
```

The definition makes five choices:

1. **Inputs:** `paramsCodec` validates the prompt at the process boundary. The launcher
   also returns a field error for invalid operator input.
2. **State:** `structuralStateCodec` stores the execution and product references this
   process needs. It has no additional business state.
3. **Draft:** The LLM turn starts a fresh primary branch and publishes a named markdown
   product. It has no workspace or integration tools.
4. **Review:** The human turn displays that product. Accept completes the process.
5. **Launch:** The UI launcher supplies validated params and the initial turn.

`setupCatalog` registers the definition. Server-side tools and other integration
behavior belong in `setupServer`, not in catalog registration.

## Load and run it

Add the package to the existing source list in `leitwerk.yaml`:

```yaml
extension_loading:
  sources:
    - ./extensions/models
    - ./extensions/showcase-processes
    - ./extensions/first-process
```

Restart `npm run dev`, choose **First Process**, enter a prompt, and select an
available model. The expected sequence is:

```text
draft → review → completed
```

The process waits at review until you select **Accept**. The published draft remains
in its history after completion.

If the launcher is missing, check the configuration-relative package path and the
server's extension-loading error. If the LLM turn fails, inspect the model/provider
error before retrying. Do not add retries to the process graph; recovery is a runtime
operation.

Next: use [products and human actions](process-sdk.md#passing-data-between-turns-products),
author [tools](agent-tools.md), or add a [watcher](watchers.md).

Maintainers can run the [documentation example check](testing.md#documentation) to
compile this file and validate its graph and launcher without making an LLM call.
