# Process SDK

The **Process SDK** (`@leitwerk-dev/process-sdk`) is the TypeScript framework for building custom processes, turn graphs, launchers, and UI extensions in Leitwerk. This guide walks through packaging an extension, defining turn graphs with the `flow` builder, routing state with products, and exposing launchers to the operator dashboard.

## Extension Package

Every extension is a TypeScript package that points to its source and build files in `package.json`:

```json
{
  "name": "@my-org/my-extension",
  "leitwerk": {
    "extension": {
      "source": "./src/index.ts",
      "import": "./dist/index.js"
    }
  }
}
```

- **`source`:** Loaded directly during development (`npm run dev`) so you can edit TypeScript without re-building.
- **`import`:** Loaded from `./dist` in production builds.

Add your extension path to `leitwerk.yaml` under `extension_loading.sources` for Leitwerk to load it at startup.

## Extension Structure

A typical extension directory is laid out as follows:

```
my-extension/
├── package.json
├── src/
│   ├── index.ts          # Main extension entrypoint
│   ├── my-process.ts     # Process definition and turn graph
│   └── codecs.ts         # Params & State JSON codecs
└── tsconfig.json
```

## Defining a Process (`src/my-process.ts`)

Define your turn graph using the `flow` builder:

```ts
// src/my-process.ts
import { flow } from "@leitwerk-dev/process-sdk";
import { paramsCodec, stateCodec } from "./codecs.js";

const implement = flow
  .llm<Params, State>("implement")
  .description("Implement requested change")
  .tools("read", "bash", "edit", "write")
  .integrationTools("repository_get_change", "pipeline_get_step_logs")
  .freshPrimary()
  .buildPrompt((ctx) => `Implement this task:\n${ctx.params.prompt}`)
  .publish("summary")
  .to("review");

export const myProcess = flow
  .process<Params, State>("my_custom_process")
  .displayName("My Custom Process")
  .entry("implement")
  .happyPath("implement")
  .codecs({ params: paramsCodec, state: stateCodec })
  .initialState(() => ({ summary: null }))
  .use(flow.fragment<Params, State>("main").turn(implement))
  .define();
```

`.tools(...)` enables worker-local workspace primitives. `.integrationTools(...)`
authorizes extension-defined, server-executed tools for that turn. Extension setup
registers those tools with `ServerExtensionAPI.tool(...)`; names must be lowercase
snake case, globally unique, and available at server startup. Workers receive only
public tool declarations and proxy calls over authenticated IPC.

## Registering the Extension (`src/index.ts`)

Export the extension entrypoint to register your process with Leitwerk:

```ts
// src/index.ts
import { defineExtension } from "@leitwerk-dev/process-sdk";
import { myProcess } from "./my-process.js";

export default defineExtension({
  manifest: {
    id: "my-extension",
    name: "My Custom Extension",
    version: "1.0.0",
  },
  setup(api) {
    api.process(myProcess);
  },
});
```

### Model provider sets

An extension exposes all of its model providers through one owner-scoped resolver. It can return one fixed provider, as Codex Nifto does, or instantiate multiple providers from extension configuration, as the models extension does:

```ts
export default {
  manifest,
  modelProviders: defineModelProviders((rawConfig) => [
    { definition: customModelProvider, rawConfig },
  ]),
};
```

Provider sets resolve before server setup. Each definition parses only its returned `rawConfig` fragment. Custom endpoints that use Pi's standard APIs contribute a credential-blind `models.json` document through `configuredPiProvider()`; current credentials are delivered separately through managed credential files.

### Turn Types

Every step in a process graph is a **Turn**:

- **`flow.llm` (LLM Turn):** Prompts the AI agent in a worker workspace with active tools (`read`, `bash`, `edit`, `write`).
- **`flow.automatic` (Worker Automatic Turn):** Runs deterministic TypeScript code inside worker workspace clones.
- **`flow.serverAutomatic` (Server Automatic Turn):** Runs deterministic host code on the central server.
- **`flow.human` (Human Turn):** Pauses execution and waits for operator actions on the web dashboard.

## Passing Data Between Turns (Products)

A **Product** is a named markdown artifact published by one turn and consumed by another:

```ts
// Turn 1: Generates and publishes the "plan" product
const generatePlan = flow
  .llm<Params, State>("generate_plan")
  .publish("plan")
  .to("review_plan");

// Turn 2: Consumes the "plan" product in its prompt context
const implement = flow
  .llm<Params, State>("implement")
  .consume("plan")
  .buildPrompt((ctx) => `Implement this plan:\n\n${ctx.input.plan}`)
  .publish("summary")
  .to("plan_decision");
```

- **`.publish("productName")`:** Replaces the named product in process state upon turn completion.
- **`.consume("productName")`:** Requires the product to exist before the turn runs, making it accessible via `ctx.input[productName]`.
- **`.optionalConsume("productName")`:** Consumes the product only if present.

## Human Review Turns & Actions

A `flow.human` turn pauses execution until an operator acts in the web UI:

```ts
const planDecision = flow
  .human<Params, State>("plan_decision")
  .description("Review implementation plan")
  .reviewProduct("plan")
  .action("approve", (action) => action.label("Approve Plan").to("implement"))
  .action("request_revision", (action) =>
    action
      .label("Request Revision")
      .form({
        id: "revision_form",
        title: "Revision Feedback",
        fields: [
          {
            id: "message",
            label: "Feedback Notes",
            kind: "textarea",
            primaryPrompt: true,
            required: true,
            publish: true,
          },
        ],
      })
      .to("generate_plan"),
  );
```

## Process Launchers & Triggers

Every process requires a way to be launched (constructing its initial parameters and git repository context).

### 1. Launchers (`api.launcher`)

A **Launcher** defines the canonical field schema and resolution logic for starting a process. Client interfaces—including the Web UI dashboard, extension-provided chat adapters, and CLI tools—read this schema to prompt operators for inputs:

```ts
// Registered inside setup(api) in src/index.ts
api.launcher({
  id: "my_process_launcher",
  displayName: "Run Custom Task",
  description: "Start a custom AI coding task on a local repo",
  processId: "my_custom_process",
  fields: [
    { id: "prompt", label: "Task Prompt", kind: "textarea", required: true },
    { id: "repoLocator", label: "Repository Path", kind: "text", required: true },
  ],
  resolveLaunchConfig: async (input) => ({
    processId: "my_custom_process",
    params: { prompt: input.fields.prompt },
    projects: [
      { key: "repo", repoLocator: input.fields.repoLocator, baseBranch: "main" },
    ],
  }),
});
```

### 2. Watchers (`api.watcher`)

A **Watcher** monitors an extension-owned event source and constructs launch configs automatically without human interaction. The extension defines the typed source, configuration parser, presentation, and provider adapter:

```ts
api.watcher({
  id: "incoming_work",
  label: "Incoming work",
  description: "Launch from discovered work",
  source: workQueueSource,
  resolveLaunchConfig: async (event) => ({
    processId: "my_custom_process",
    params: { prompt: event.summary },
    externalId: event.itemId,
  }),
});
```

Watchers are enabled in `leitwerk.yaml` under `process_configs.<processId>.watchers.<watcherId>`.

### External Actions

An **External Action** arms a provider trigger while a human turn remains selected (for example, waiting for a change request to merge or a review feedback file to be written):

```ts
const reviewTurn = flow
  .human<Params, State>("implementation_review")
  .description("Review implementation")
  .externalAction(
    "change_merged",
    codeHostExternal.changeMerged({ projectKey: "app" }),
    (external) => external.label("Merge request merged").complete(),
  );
```
