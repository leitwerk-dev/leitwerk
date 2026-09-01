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
  .runtime({ developmentTools: true, docker: true })
  .use(flow.fragment<Params, State>("main").turn(implement))
  .define();
```

`.tools(...)` enables worker-local workspace primitives. `.integrationTools(...)`
authorizes extension-defined, server-executed tools for every invocation of that turn.
`.resolveIntegrationTools((params, state) => ...)` constrains them from validated durable
process data at worker start. Extension setup
registers those tools with `ServerExtensionAPI.tool(...)`; names must be lowercase
snake case, globally unique, available at server startup, and distinct from Pi built-ins,
framework tools, and the turn's outcome tools. `.runtime({ developmentTools: true })` opts the
process into mise preparation. Mise reads stock repository configuration at each declared
repository root before worker readiness and turn acceptance. The capability defaults to false;
process definitions do not declare tool names or versions.

`.runtime({ docker: true })` requires a Docker realization from the selected runner. The local
runner requires `local_worker.allow_host_docker: true` and a successful `docker info` preflight.
The Docker runner requires `docker.private_daemon.isolation`. Kubernetes requires a complete
`kubernetes.docker` block and operator-installed runtime infrastructure. Launch rejects an
unavailable requirement before creating durable process state.

Workers receive only public tool declarations
and proxy calls over authenticated IPC. `execute(ctx, args)` receives `ctx.signal`; pass it
to provider calls so stopping the turn cancels in-flight server work.

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

- **`flow.llm` (LLM Turn):** Optionally prepares deterministic inputs, then prompts the AI agent in a worker workspace with active tools (`read`, `bash`, `edit`, `write`).
- **`flow.automatic` (Worker Automatic Turn):** Runs deterministic TypeScript code inside worker workspace clones. Server-owned operations are available only through explicitly authorized integration tools.
- **`flow.human` (Human Turn):** Pauses execution and waits for operator actions on the web dashboard.

### LLM-turn preparation

Use `.prepare(...)` when deterministic mechanics exist only to supply one LLM turn. Preparation
runs after turn-start acceptance and before Pi receives a prompt. It shares the turn's authorized
integration tools, may publish a progress report, and returns bounded JSON data through
`ctx.prepared`:

```ts
const analyze = flow
  .llm<Params, State>("analyze")
  .description("Analyze process")
  .integrationTools("download_snapshot")
  .prepare(async (ctx) => {
    ctx.reportProgress({
      title: "Analysis preparation",
      steps: [{ id: "download", label: "Download snapshot", status: "in_progress" }],
    });
    return ctx.callIntegrationTool("download_snapshot", { processRef: ctx.params.processRef });
  })
  .buildPrompt((ctx) => `Analyze ${ctx.prepared.snapshotDir}`)
  .publish("analysis")
  .to("analysis_decision");
```

Preparation has no outcome or route. A preparation failure fails the owning LLM turn before Pi
starts. Retry runs preparation again. A replacement worker and Continue reuse the durable
checkpoint when the server received it; preparation must remain deterministic and external
writes must remain idempotent. The result must be JSON-serializable and at most 64 KiB. Do not
use preparation for an independently reviewable artifact, decision, wait, or business operation.
Those remain turns.

### Ticket creation adapters

A ticket adapter registers a normal integration tool with
`capability.kind: "ticket_creation"`. The capability also names the code-defined
`processId` and `startTurnId` used for the derived process; core does not privilege a
fixed process graph. The tool returns `{ externalId, url, result? }`, uses the execution
context idempotency key for its external write, and reconciles ambiguous provider
outcomes before retrying.

Adapters that can target more than one destination attach a destination
provider to the capability. `list()` returns browser-safe destination summaries
for the derived process. The worker receives those summaries as a server-added
required `destinationId` tool argument and asks the operator when the target is
ambiguous. Immediately before approval, `resolve()` converts the opaque choice
into an immutable, JSON-serializable snapshot. The server passes that snapshot
to the tool as `ctx.ticketDestination`; workers never receive adapter credentials.
`validate()` remains available for compatible launches that already carry a
snapshot.

```ts
api.tool({
  name: "tracker_create_ticket",
  description: "Create a tracker ticket",
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title", "body"],
  },
  capability: {
    kind: "ticket_creation",
    displayName: "Tracker",
    processId: "tracker_ticket_process",
    startTurnId: "draft_ticket",
    titlePath: "/title",
    descriptionPath: "/body",
    destinations: trackerDestinations,
  },
  async execute(ctx, args) {
    // Validate ctx.ticketDestination, perform one durable external write,
    // and return the standard receipt.
  },
});
```

Destination summaries may contain an opaque id, display name, group, and short
description. Snapshot `data` is adapter-owned durable state. `agentContext` is
untrusted text included in the ticket agent prompt and must not contain secrets.

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

A `flow.human` turn pauses execution until an operator acts in the web UI. Review turns identify their artifact directly through `reviewProduct`; there is no separate review classification in process state.

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

### 2. Programmatic launcher admission

Trusted operator-channel extensions start processes through
`deps.launchRuns.startProgrammatic(...)`. The operation accepts launcher input, optional model,
skill, title, and bounded non-secret process metadata, plus a required caller idempotency key. The
server creates the `LaunchRun`, repeats launcher resolution and preparation checks, prepares the
launch plan, and commits through the shared pipeline. Extensions never call the raw process launch
executor or supply a `launchRunId`.

The call returns after process commit so the channel can report the process link. Worker startup
remains asynchronous and is established only by lease, readiness, bootstrap, and accepted-turn
evidence. A returned process remains authoritative even when the result also contains a follow-up
error.

### 3. Watchers (`api.watcher`)

A **Watcher** monitors an extension-owned event source and constructs launch configs without human interaction. The extension owns its typed source, configuration parser, presentation, polling, and provider adapter. See [Watchers](watchers.md) for the source, process binding, and configuration contracts.

### External Actions

An **External Action** arms a provider trigger while a human or worker automatic turn remains selected and waiting (for example, waiting for a change request to merge or review feedback):

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

An automatic outcome can call `.wait()` to keep the automatic turn selected with
`lifecycleStatus = "waiting"`. External actions remain dormant while the automatic handler
runs. They arm after the waiting outcome is durable and then appear as active external triggers
in the process UI. They can restart that turn, route to another business turn, complete, or
abort without adding a synthetic wait turn.

Use `.when(({ params, state, process, projects }) => boolean)` for an external action that is
valid only in part of the process state. A false condition excludes the action from provider
armings and from the selected-turn UI snapshot. Keep provider-specific matching in the source
resolver; use `when` for process-owned routing scope.

### Turn progress

Worker automatic handlers and LLM preparation phases can replace their operator-facing progress snapshot with
`ctx.reportProgress(...)`. A report contains an ordered list of stable step ids, labels, and
`incomplete`, `in_progress`, `completed`, or `failed` statuses. It may also contain HTTPS links
to pull requests, merge requests, commits, or pipelines. Reports are execution visibility, not
process turns, products, or business state.

The server persists each correlated snapshot as a turn event and broadcasts a durable refresh
signal. It rejects malformed reports, unsafe links, stale turn-record ids, and updates for turns
that are no longer running. If an automatic handler or LLM preparation throws, Leitwerk changes
its current `in_progress` step to `failed` with the safe error summary before recording the turn
failure.

### Launch preparation checks

A UI launcher may return ordered `preparationChecks`. Each check has a stable unique id, an
operator label, and an asynchronous `run` function. The server launch pipeline owns checklist state.
A check returns on success or throws `SafeLaunchPreparationError` with bounded remediation.
The context supplies cancellation, the resolved launch configuration, and a safe logger. It does
not grant checklist mutation or ambient credentials. Launchers without checks receive the core
launch checklist.

Watcher definitions use the same preparation-check contract. Polling providers submit watcher
events and stable idempotency through the server-owned launch-run service; they do not supply
launch-plan or process-executor services. Watcher admission supplies the stable event key and
source policy. The shared launch pipeline then resolves the event, executes checks, prepares model
selections, and commits the process with the watcher deduplication key.
