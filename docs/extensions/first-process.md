# Write your first process

Create a process that drafts a response, pauses so you can read it, and completes when you accept it.

```text
draft → review → completed
```

You’ll need a running Leitwerk with an available model. Follow the [live-model setup](../admin/local-quickstart.md) if you have a Leitwerk checkout. To work without a checkout, follow [Development setup](development-setup.md#start-with-released-packages) and then go to [Run your process](#run-your-process).

## Add the process to a checkout

Run these commands from the root of your Leitwerk checkout to create the extension and copy its source.

```sh
mkdir -p extensions/first-process/src
cp docs/examples/first-process.ts extensions/first-process/src/index.ts
```

Save this as `extensions/first-process/package.json`. It tells Leitwerk where to find the extension’s TypeScript entry point in source development mode.

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

Append `- ../../extensions/first-process` to the existing `extension_loading.sources` list in `.leitwerk/local/leitwerk.yaml`. Keep the model provider extension in the list. Paths are relative to the configuration file.

Restart Leitwerk from the checkout root using the shell where you exported the provider and encryption keys.

```sh
LEITWERK_CONFIG_PATH="$PWD/.leitwerk/local/leitwerk.yaml" npm run dev
```

Open the URL printed by Vite.

## Run your process

1. From the dashboard, select **Start a process**, then **First Process**.
2. Enter `Write a short welcome message for a community garden.` in **Prompt**, select an available model if prompted, and choose **Start**.
3. Watch the **Chronicle**. The draft turn sends your prompt to the model and saves the reply as a Markdown product named `draft`.
4. Read the draft in the review turn. The process waits here until you select **Accept**. The process then shows as completed, and the draft remains in its history.

If **First Process** is missing, check the extension path and server startup logs. If the draft turn fails, open the Chronicle for the failure details and recovery options.

## Change the prompt

In `extensions/first-process/src/index.ts`, change the draft turn’s `.buildPrompt(...)` line to ask for one sentence.

```ts
.buildPrompt((ctx) => `Answer in one sentence.\n\n${ctx.params.prompt}`)
```

Wait for the development server to reload, then start a new **First Process** run with the same prompt. Compare the shorter draft with the first run before accepting it.

## Read the process definition

The launcher passes the prompt into the process. `paramsCodec` validates it before the draft turn reads it with `.buildPrompt(...)`. The draft turn’s `.publish("draft")` gives the reply a name, and the review turn’s `.reviewProduct("draft")` shows that reply to the reviewer. The **Accept** action calls `.complete()`.

Leitwerk records the execution and published products using `structuralStateCodec`. The extension’s `setupCatalog` registers the process so its launcher appears in the dashboard.

[Download the original example source](../examples/first-process.ts).

```ts
--8<-- "docs/examples/first-process.ts"
```

See [Process SDK](process-sdk.md) for other turn types and [Testing extensions](testing.md) to check process behavior without a live model.
