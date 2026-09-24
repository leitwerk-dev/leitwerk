# Process SDK

The **Process SDK** (`@leitwerk-dev/process-sdk`) is the TypeScript framework for building custom processes, turn graphs, launchers, and UI extensions in Leitwerk. This guide walks through packaging an extension, defining turn graphs with the `flow` builder, routing state with products, and exposing launchers to the operator dashboard.

## API compatibility

Published declarations use `@public` for supported APIs and `@internal` for
implementation APIs. Both remain importable, callable, and fully typed. These
tags describe compatibility; they do not restrict access. Each exposed member
has its own tag. A public interface, class, or capability does not make all of
its members public. Re-exports retain the declaration's classification.

Breaking a public API requires release notes and a minor version bump during
`0.x`, or a major bump from `1.0`. Removing a public API's tag is also a breaking
change. Later disappearance of consumer usage does not withdraw this promise.
Internal APIs can change without that compatibility promise.

The initial classification uses actual code in the current `leitwerk-private`,
`leitwerk-public`, and `leitwerk-rsnc` working trees: runtime code, tests, type
references, supplied contracts, development scripts, and extension composition
loading. Named supporting types are public where needed by public signatures.
Documentation and Leitwerk's own calls do not independently establish support.
Generated files, dependencies, and vendored core checkouts are excluded.

For example, `ServerExtensionAPI.get`, `require`, `provide`, `tool`, and `onStop`
are public; `onStart` is internal. `PiPromptOptions.tools` is public, while
`shouldBlockToolCall`, `suspendPromptGuards`, and `terminalAcknowledgement` are
internal. Forwarding an options object does not consume all its members.

Run `leitwerk-dev api:check --workspace PATH` from an installed
`@leitwerk-dev/dev-tools` package to check an extension workspace. It verifies
classification completeness, conflicting tags, and public signature
dependencies. Internal API calls are allowed. The check needs no consumer
checkout.

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
`RepositoryIssue` and `RepositoryPullRequest` describe shared repository response fields; extensions may re-export them under provider-specific names or extend them for provider-specific fields.
`IntegrationHttpClient` shares authenticated HTTP, JSON/204 handling, `writeJson(path, method, body, signal?)`, and array pagination; extensions supply headers, API prefixes, page sizes, and endpoint methods.
`RepositoryHttpClient` adds common issue/comment and pull-request endpoints; extensions retain path encoding and provider-specific operations.
`parseRepositoryPullRequestConfig`, `parseRepositoryFeedbackConfig`, and `parseRepositoryIssueCancelledConfig` parse shared polling fields, returning `null` for missing or wrongly typed required fields. They default polling to `30s`, feedback cursors to zero, and the quiet period to 120 seconds; extensions retain authorization and event policy.

`repositoryFeedbackBatch(unseen, config, now)` returns feedback IDs, advanced cursors, and their merge key, or `null` while empty or within the quiet period. Callers filter authorization and unseen IDs first.
`defineExternalActionSource<TConfig>(metadata)` creates a generic resolver-based source factory. Each call retains the metadata and resolver, creates an empty config, and sets `inputMode: "none"`.
`createExternalSourcePollReporter(sources, result, { forwardGeneration: true })` includes nonempty arming generations in fired events. The default preserves generation-free delivery; freshness checks remain the caller's responsibility.

`parseRepositoryIssueWatcherConfig(raw, legacyType, distinctLabels?)` and `presentRepositoryIssueWatcherConfig` share issue watcher parsing and presentation. Parsing trims strings, validates positive durations and repository filters, and parses launch settings. Distinct trigger/done labels are opt-in; extensions keep their source IDs and event types. `matchesRepository(config, repository)` applies their include/exclude filters; exclusions win.

Use `structuralStateCodec` for state containing only semantic and product refs; it parses with
`parseStructuralProcessState` and serializes unchanged. Use `emptyParamsCodec` for empty params.

### Process storage sizing

An extension can derive new Kubernetes process-volume capacity from its own
server configuration. Register a synchronous resolver with the flow builder:

```ts
.resolveStorageSize(({ params, projects }) =>
  serverConfiguration.storageSizeFor(params, projects)
)
```

Here `serverConfiguration.storageSizeFor` is extension-owned code, not an SDK
method. The same `resolveStorageSize` field is available on `defineProcess`.
The resolver receives codec-validated process params and the instance's persisted
projects. Return a positive Kubernetes quantity such as `128Mi`, `1Gi`, or `50Gi`,
or `undefined` to use the global default. The returned size covers the whole process
volume; core does not sum repository sizes or interpret extension settings.

The server invokes the resolver before provisioning on Kubernetes worker starts,
after extension server setup. Read validated server configuration through the
extension's own closure. Keep the resolver side-effect free; it may run again on
retry or replacement. Exceptions and invalid results fail startup. An explicit
`process_configs.<processId>.storage_size` bypasses the resolver. Local and Docker
runners never invoke it. Existing PVCs remain unchanged regardless of later results.
See [storage configuration](configuration.md#per-process-storage-size).

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

- **`flow.llm` (LLM Turn):** Optionally prepares deterministic inputs, then prompts the AI agent in a worker workspace with active tools (`read`, `bash`, `edit`, `write`). With `.forEach(...)`, it runs once per frozen item.
- **`flow.automatic` (Worker Automatic Turn):** Runs deterministic TypeScript code inside worker workspace clones. Server-owned operations are available only through explicitly authorized integration tools.
- **`flow.human` (Human Turn):** Pauses execution and waits for operator actions on the web dashboard.

### LLM-turn preparation

Server extensions use `commands.retryProcess(instanceId)` to recover the current failed
startup or accepted turn. A preparation or bootstrap failure replaces the current start
record without creating a turn attempt. The engine validates its identity and lifecycle
under the process lock; a concurrent Stop or changed start rejects the stale retry.
An accepted failed turn retains normal turn-retry behavior.

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

### Mapped LLM turns

Use `.forEach(...)` to run an LLM turn once per item, such as each candidate in a
shortlist. The turn remains one graph node. Items run sequentially, each with its own
turn record, Chronicle card, and rail entry. Each outcome yields a typed result;
`.collect(...)` combines the results and routes once.

```ts
const investigate = flow
  .llm<Params, State>("investigate_candidate")
  .description("Investigate one candidate")
  .forEach<Candidate, InvestigationResult>({
    items: ({ state }) => state.candidates,
    itemCodec: candidateCodec,
    resultCodec: investigationResultCodec,
    key: ({ item }) => item.id,
    label: ({ item }) => `${item.service}: ${item.pattern}`,
    stateAfterSnapshot: ({ state }) => ({ ...state, candidates: [] }),
  })
  .buildPrompt((ctx) => `Candidate ${ctx.itemIndex + 1} of ${ctx.itemCount}: ${ctx.item.pattern}`)
  .outcomeTool("candidate_noise", (outcome) =>
    outcome
      .description("Classify this candidate as noise")
      .requiredString("summary", "Reason this candidate is noise")
      .yield(({ ctx, event }) => validateNoiseResult(ctx.item, event.params)),
  )
  .collect(({ state }, results) => ({ ...state, dispositions: results }))
  .routeByState({ review: "check_writing", done: "deliver" }, ({ state }) =>
    state.dispositions.some(needsReview) ? "review" : "done",
  );
```

Entering the turn evaluates `items` once on the server. Each item is parsed and
serialized by `itemCodec`; keys must be unique, non-empty, and at most 200 characters,
and at most 500 items are frozen. Labels are plain text, at most 200 characters, and
default to the key. The order, values, keys, and labels are durable and do not follow
later state changes. `stateAfterSnapshot` runs in the same transaction, before any
item starts, so the source list need not reach workers. A worker receives only its
active item: `ctx.item`, `ctx.itemKey`, `ctx.itemLabel`, `ctx.itemIndex`, and
`ctx.itemCount` in `prepare` and `buildPrompt`.

An item outcome declares parameters and `.yield(...)` only. It cannot route, change
process state, or publish a product. Definitions that declare these operations are
invalid. `yield` runs on the server with the item and validated outcome parameters.
Its value must pass `resultCodec`; a failure or a `SafeOutcomePlanningError` rejects
the outcome without recording a result. Each item's result markdown comes from the outcome's reserved
`markdown` argument.

After the last item, `collect` receives the results in item order and returns the
new state. Then the collection route applies: `.to(turnId)`, `.complete()`,
`.lifecycleStatus(status)`, or `.routeByState(branches, choose)`, whose chooser sees
the collected state. An empty list collects immediately without starting an item.

A failed item stays current. Retry and Continue run the same item; completed items
are never re-run. Each item start resolves the model independently, so an unavailable
model parks the process at that item. Abort ends the run. Re-entering the turn after
another route starts a new run with fresh items.

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
snapshot. `parseJsonData(value, message?)` validates and detaches JSON data;
it rejects cycles, non-finite numbers, non-plain objects and symbol-keyed objects.

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

Flow definition and extension loading use the same graph product validation. Both required and optional products must have a declared publisher; LLM and automatic outcomes can publish markdown parameters.

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

Result publication accepts an optional `resultSummary`: `markdown_result`, automatic
`WorkerCompleteInput`, and outcome declarations using `resultSummaryParameter`.
Omitting it keeps existing publication valid. The server retains it in the turn
milestone annotation. `TurnProgressReport.summary` explains the attempt or wait;
progress is a snapshot, not proof that an operation occurred.

External sources may define a pure `describeEvent(event)` returning `summary`,
optional `markdown`, and `links`. Consumption persists the returned description.
Server providers may call `externalSources.observe` with the arming's captured
`generation`, an observation (`summary`, `links`, `observedAt`, opaque `subject`
and `revision`), or `refreshError`. Observation writes never fire transitions.

External observation reports require a valid observation timestamp and uniquely identified HTTP(S)
links without embedded credentials. Invalid reports are rejected without replacing the last known
facts. Invalid or failing optional event descriptions are omitted; they do not block event consumption.

## Repository HTTPS credentials

`RepositoryCredentialProvider` is a discriminated union of `git_ssh` and `git_https`. HTTPS providers resolve `{ origin, username, password }`; processes declare only `{ projectKey, kind, credentialRef }`. The server verifies the project locator against the provider origin and adds the exact credential-free HTTPS repository URL to `WorkerGitHttpsCredential`. A project has one credential kind. SSH providers retain their private-key and pinned-known-hosts contract.

Trusted Git calls use `repositoryGitSubprocessEnv(projectKey)` and `repositoryGitArgs()`. Ordinary tool commands use `sanitizeWorkerSubprocessEnv()`, which removes internal helper references, Git credential configuration, askpass/SSH agent variables and server token, API-key, password and secret variables. Credentials must never enter process params, state, projects or session trees.

## Testing process definitions

Use the supported [extension testing harnesses](testing.md#extension-testing) to
inspect descriptions, evaluate handlers with independent fixtures, and execute
server/worker behavior. Extension tests should assert observations instead of
constructing SDK contexts or inspecting handler registries. Keep prompt and state
helper tests in the extension that owns those helpers.

Startup compatibility migrations can rewrite encoded process params through
the server-setup capability’s `processes.update(instanceId, { paramsJson })`
method, alongside persisted state and position. Run
such migrations during extension setup, before background services start.
Use codec parsing to validate compatibility before writing.

## Typed external writes

`ctx.externalWrites.ensure(identity, operation)` returns the remote value after
recording the write. The server supplies storage and process identity.

```ts
return ctx.externalWrites.ensure(
  { writeType: "provider.create", dedupKey: ctx.idempotencyKey },
  {
    reconcile: async () => findRemoteByStableIdentity(), // value or null
    execute: () => createRemote(),
    toMetadata: (remote) => ({ id: remote.id, url: remote.url }),
  },
);
```

`execute` must return a non-nullish value. `reconcile` receives one of three phases:

| Phase | Required behavior |
| --- | --- |
| `before_execute` | Find the remote object before creating or updating it. |
| `after_execute_error` | Recover the object after an execution error. |
| `already_recorded` | Fetch the current object without repeating the write. |

Use stable markers or provider identifiers. Reads must include closed objects and
completed writes. For updates, compare all requested fields, including normalized
labels, before execution and after errors. On logged replay, fetch the current
object without reapplying the patch; later edits must survive.

Return `null` only when no matching object or requested state exists. Propagate
authentication, transport, and other lookup errors. A lookup failure before execution prevents the write.
A logged write whose remote object cannot be recovered fails without recreating it.
If execution fails, reconciliation runs once more. No match rethrows the execution
error. If recovery or recording also fails, an `AggregateError` contains both errors
and has the execution error as its `cause`.

Metadata extraction and durable recording must succeed before the call returns.
A recording failure does not repeat execution. A later call reconciles again.
Calls serialize by repository object and deduplication key within one server
process. Separate servers, repository objects, and keys are not coordinated.

Use `logOnly` when an operation has no recoverable remote identity:

```ts
await ctx.externalWrites.logOnly(identity, async () => {
  await restartPipeline();
  return { pipelineId, diagnosis }; // durable metadata
});
```

`logOnly` returns `void`. A recorded write skips execution. It cannot recover a
lost response or remote success followed by a recording failure.

To migrate from `ensureWrite`, use the context methods above instead of passing a
repository and process ID. Replace `createWriteIdentity` with an object literal.
`ensure` returns the remote value directly; neither method returns execution status
or a deduplication key. The package root supports `ExternalWrites`, `WriteIdentity`,
and `WriteOperation`; `/internal` is not a supported extension API.

Existing durable records and remote markers remain valid. Historical unmarked
writes may not be recoverable. No schema or configuration change is required.

## Shared integration operations

The SDK supports repository feedback normalization and quiet-period batching,
repository watcher/source configuration parsing, watcher presentation, and repository
matching. Their exported input and result types are part of the supported API.
Extensions remain responsible for authorization and provider-specific filtering.
Parsing defaults, feedback cursors, and merge keys are shared across callers.

`IntegrationHttpError` exposes its HTTP `status`; `objectArg`, `stringArg`,
`numberArg`, `parseJsonData`, and `repositoryHttpsUrl` provide shared boundary
validation. `ServerExtensionAPI.logger` and its `info`, `warn`, and `error` methods
are optional.

`createExternalSourcePollReporter` returns `ExternalSourcePollReporter`. Its
`isCurrent(kind, armed)` compares the process, arming id, generation, and resolved
value after provider I/O. Supplying `currentKinds` also checks freshness before
`fire` and `observe`. Omit it to retain caller-managed freshness checks.
`forwardGeneration` defaults to false. Observation is a no-op when the source
service lacks observation support or the captured subscription lacks a generation.

Use `recordConfirmedWrite` from `@leitwerk-dev/external-writes` to record an
already-confirmed remote object without repeating the remote operation. It returns
`{ recorded, dedupKey }`; `ensureWrite` continues to return `{ performed, dedupKey }`.
