# Process SDK

`@leitwerk-dev/process-sdk` defines processes, turns, launchers, and extension
contracts. Start with [Write your first process](first-process.md) for a complete
example. This page is the reference for authors; snippets illustrate individual
APIs and assume the surrounding process, types, and adapters already exist.

## API compatibility

Published declarations use `@public` for supported APIs and `@internal` for
implementation APIs. Both remain importable, callable, and fully typed. The tags
state compatibility, not access restrictions. Each member has its own tag;
a public interface does not make every member public. Re-exports retain the
original classification.

Breaking a public API requires release notes and a minor version bump during
`0.x`, or a major bump from `1.0`. Removing its public tag also breaks that
contract, even when current consumers no longer use it. Internal APIs have no
such compatibility promise.

Run `leitwerk-dev api:check --workspace PATH` from an installed
`@leitwerk-dev/dev-tools` package to check classifications and public signature
dependencies. Internal API calls are allowed. No consumer checkout is required.

## Extension package

An extension package declares its development and built entry points:

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

Source development loads `source`; production loads `import`. Declare dependencies
in the package and build the production entry before loading it. Add the package
to `extension_loading.sources`; relative paths resolve from the configuration
file's directory. See [Development compositions](development-composition.md) for
independent workspaces and released-package development.

Extensions can also declare `leitwerk.skills` to install an adapted, selectable
[skill pack](skill-packs.md). Its generated resources are imported by the server;
launches pin selected revisions and their dependencies.

## Registering the extension (`src/index.ts`)

Export a `LeitwerkExtensionModule`. Register definitions in `setupCatalog` and
server-owned integrations in `setupServer`:

```ts
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { myProcess } from "./my-process.js";

export default {
  manifest: { id: "my-extension", version: "1.0.0" },
  setupCatalog(api) {
    api.registerProcess(myProcess);
  },
} satisfies LeitwerkExtensionModule;
```

Model provider sets resolve before server setup. Each provider parses only its
owner-supplied configuration fragment. See [extension-defined providers](models.md#extension-defined-providers).
Browser result renderers use a separate [UI manifest](extension-ui.md).

Shared solution wikis are owned by [`@leitwerk-dev/wiki`](../packages/wiki/README.md),
including their process bindings, tools, and contribution guidance. `.runtime({ repositoryCheckout: "on_demand" })`
opts a process into [lazy full clones](process-workspace.md#2-repository-management).
Use `repositoryCheckout: "none"` for server-tool-only repository inspection. It
retains project bindings but skips clone preparation on startup and resume, and
never exposes `checkout_repository`. Declare `.tools()` and only read-only
integration tools when local commands and writes must be unavailable.

## Turn types

`defineProcess(...)` and `flow.process(...).define()` validate declared turn metadata,
routes, products, entry turns, the happy path, and shared action forms before returning.
Independent errors are reported together with process and turn context. Checks that
depend on an invalid declaration are skipped. Validation does not execute codecs,
initial state, prompts, or process callbacks.

Catalog admission repeats the same checks, including checks on retained transitions,
so later metadata changes cannot bypass validation. Catalog registration separately
checks process provenance and duplicate process IDs.

Invalid definitions that previously failed during catalog loading or server setup
now fail at definition. Exact diagnostic wording and order are not a compatibility
contract.

A process declares its graph in code. Configuration supplies runtime defaults;
it does not define turns, transitions, actions, or completion policy.

| Builder | Execution |
| --- | --- |
| `flow.llm` | Optionally prepares deterministic input, then prompts an agent with authorized tools. |
| `flow.mappedLlm` | Runs an LLM turn sequentially for frozen items, then collects their results and routes once. |
| `flow.automatic` | Runs deterministic TypeScript in a worker. Server operations require authorized integration tools. |
| `flow.human` | Waits for an operator action or a declared external action. |
| `flow.external` | Waits for a declared external source. |

Declare all route targets and product publishers in the same process definition.
Use `.happyPath(...)` to identify its expected successful route for navigation;
it does not override transitions. A process with multiple repositories still has
one instance and one persisted execution tree.

### Workspace tools and runtime requirements

`.tools(...)` enables worker-local primitives. `.integrationTools(...)` authorizes
server-executed tools. `.resolveIntegrationTools((params, state) => ...)` can
constrain authorization using validated process data at worker start.
See [Agent tools](agent-tools.md) for naming, cancellation, and replay rules.

`.runtime({ developmentTools: true })` opts into mise preparation at each declared
repository root before worker readiness and turn acceptance. It defaults to false.
Processes do not declare tool versions; repository mise configuration does.
See [workspace preparation](process-workspace.md#2-repository-management).

`.runtime({ docker: true })` requires a Docker realization from the selected runner:

| Runner | Requirement |
| --- | --- |
| Local | `local_worker.allow_host_docker: true` and a successful `docker info` preflight. |
| Docker | `docker.private_daemon.isolation` set to the selected isolation mode. |
| Kubernetes | Complete `kubernetes.docker` wiring and operator-installed runtime infrastructure. |

Launch rejects unavailable requirements before creating a process. Kubernetes
configuration does not install or verify the node runtime infrastructure.

### Process storage sizing

A process may derive new Kubernetes process-volume capacity from extension-owned
server configuration:

```ts
.resolveStorageSize(({ params, projects }) =>
  serverConfiguration.storageSizeFor(params, projects)
)
```

`serverConfiguration.storageSizeFor` is extension code, not an SDK method. The
same `resolveStorageSize` field exists on `defineProcess`. It receives validated
params and persisted projects. Return a positive Kubernetes quantity, such as
`128Mi` or `1Gi`, or `undefined` for the global default. The size covers the whole
process volume, not individual repositories.

The resolver is synchronous and side-effect free. It runs before Kubernetes
provisioning, after server setup, and may run again on replacement or retry.
Exceptions and invalid results fail startup. An explicit
`process_configs.<processId>.storage_size` bypasses it. Local and Docker runners
never invoke it. Existing PVCs are not resized or recreated. See
[storage selection](configuration.md#per-process-storage-size).

### LLM-turn preparation

Use `.prepare(...)` for deterministic work that exists only to supply one LLM
turn. It runs after acceptance and before prompt evaluation:

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
    await ctx.callIntegrationTool("download_snapshot", { processRef: ctx.params.processRef });
    return { instructions: "Inspect the downloaded snapshot." };
  })
  .buildPrompt((ctx) => ctx.prepared.instructions)
  .publish("analysis")
  .to("analysis_decision");
```

Preparation has no outcome or route. Its result must be non-secret,
JSON-serializable, and at most 64 KiB. Failure fails the owning turn before the
model is prompted. Retry runs preparation again. Continue and replacement workers
reuse the checkpoint when one reached the server; otherwise preparation may run
again. Keep preparation deterministic and external writes idempotent.

Use a separate turn for an independently reviewable artifact, decision, wait, or
business operation. See [acceptance and recovery](server-worker-lifecycle.md#5-start-acceptance-recovery-invariants)
for the runtime contract.

### Mapped LLM turns

Use `flow.mappedLlm(turnId, items)` to run an LLM turn once per item, such as each candidate in a
shortlist. The turn remains one graph node. Items run sequentially, each with its own
turn record, Chronicle card, and rail entry. Each outcome yields a typed result;
`.collect(...)` combines the results and routes once.

```ts
const investigate = flow
  .mappedLlm<Params, State, Candidate, InvestigationResult>("investigate_candidate", {
    items: ({ state }) => state.candidates,
    itemCodec: candidateCodec,
    resultCodec: investigationResultCodec,
    key: ({ item }) => item.id,
    label: ({ item }) => `${item.service}: ${item.pattern}`,
    stateAfterSnapshot: ({ state }) => ({ ...state, candidates: [] }),
  })
  .description("Investigate one candidate")
  .askQuestions()
  .executionPurpose("candidate_investigation")
  .optionalConsume("plan")
  .prepare(({ item }) => ({ focus: `${item.service}: ${item.pattern}` }))
  .buildPrompt((ctx) =>
    `Candidate ${ctx.itemIndex + 1} of ${ctx.itemCount}: ${ctx.prepared.focus}\n${ctx.input.plan ?? ""}`,
  )
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

Mapped and ordinary LLM builders share configuration methods: descriptions, execution
purpose, tools and dynamic integration-tool selection, operator questions, products,
readiness, preparation, and context selection. Declare a publisher for every consumed product,
including the optional `plan` in this example. Item outcomes yield results; collection
owns completion. Mapped builders do not expose `.publish(...)` or `.end(...)`.

Declare `.prepare(...)`, `.consume(...)`, and `.optionalConsume(...)` before
`.buildPrompt(...)` so its callback receives the refined types. `prepare` infers its
return type. A typed `FlowForEachOptions<Params, State, Item, Result>` source lets
`flow.mappedLlm(...)` infer all four types. For an inline source, supply all four type
arguments as above; supplying only `Params, State` leaves item and result types at
their defaults. Builders retain their fluent mutation behavior.

To migrate, replace `flow.llm<Params, State>(id).forEach<Item, Result>(items)` with
`flow.mappedLlm<Params, State, Item, Result>(id, items)` and move shared configuration
after the factory. The compiled definition still uses `LlmTurnDefinition.forEach`;
persisted mapped runs and recovery keep the same representation.

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
the outcome without recording a result. Each item's result markdown comes from the
outcome's reserved `markdown` argument.

After the last item, `collect` receives the results in item order and returns the
new state. Then the collection route applies: `.to(turnId)`, `.complete()`,
`.lifecycleStatus(status)`, or `.routeByState(branches, choose)`, whose chooser sees
the collected state. An empty list collects immediately without starting an item.

A failed item stays current. Retry and Continue run the same item; completed items
are never re-run. Each item start resolves the model independently, so an unavailable
model parks the process at that item. Abort ends the run. Re-entering the turn after
another route starts a new run with fresh items.

## Passing data between turns (products)

A **product** is a named markdown result published by one turn and consumed by another.

| Method | Contract |
| --- | --- |
| `.publish("plan")` | Replaces the named product when the turn completes. |
| `.consume("plan")` | Requires the product before the turn runs; exposes it as `ctx.input.plan`. |
| `.optionalConsume("plan")` | Uses the product when present. |

Required and optional products both need a declared publisher. Definition and
extension loading apply the same graph validation. LLM and automatic outcomes may
publish markdown parameters. Publishing a product retains a reference to its
source turn record; it does not copy an arbitrary mutable prompt context.

## Human review turns & actions

A human turn identifies its result with `.reviewProduct(...)` and declares actions:

```ts
const decision = flow
  .human<Params, State>("review")
  .description("Review the draft")
  .reviewProduct("draft")
  .action("accept", (action) => action.label("Accept").complete())
  .action("revise", (action) =>
    action.label("Request revision").form({
      id: "revision",
      title: "Revision instructions",
      fields: [{
        id: "message", label: "Instructions", kind: "textarea",
        primaryPrompt: true, required: true, publish: true,
      }],
    }).to("draft"),
  );
```

There is no separate review classification in process state. Generic Retry and
Continue are recovery operations, not process-defined actions. Server extensions
use `commands.retryProcess(instanceId)` for the current failed startup or accepted
turn; stale retries are rejected under the process lock.

## Process launchers & triggers

### Launchers

A process's `.launcher(...)` declares a UI card, input schema, and
`ui.resolveLaunchConfig(input, context)`. A successful resolution returns
`{ ok: true, launchConfig }`; validation returns `{ ok: false, errors }` with field
errors. The launch configuration identifies the process, validated params, optional
projects, and initial turn. See the [complete example](first-process.md).

Launcher schemas also support trusted operator channels. A channel must use server
launch admission; it must not invoke the raw process executor.

### Programmatic launcher admission

`deps.launchRuns.startProgrammatic(...)` accepts launcher input, optional model,
skill, title, bounded non-secret process metadata, and a required caller idempotency
key. The server resolves and checks the launcher again, prepares the launch plan,
and commits through the shared pipeline. Callers do not choose a `launchRunId`.

The call returns after process commit. Worker startup remains asynchronous. A
returned process stays authoritative even if a follow-up reaction fails; report
that process rather than creating a replacement. See
[launch progress](server-worker-lifecycle.md#7-launch-progress).

### Readiness before a worker starts

Keep readiness beside the turn that does the work:

```ts
flow.llm("repair")
  .description("Repair failed CI")
  .waitFor(async process => {
    const assessment = await repository.assess(process);
    if (assessment.closed) return process.complete();
    return assessment.eligible && assessment.ciFailed;
  })
  .prompt("Repair this change's failed CI.")
  .end("done").complete();
```

Predicates receive the process snapshot, projects, decoded params/state, an abort
signal, and `require(token)` for extension-owned server read adapters. Readiness is
optional; ordinary turns can use `.prompt("Write a short poem.")` alone.

Ordinary LLM, mapped LLM, and automatic turns support `.waitFor(predicate)`. The server checks it
before persisting any worker start (including retry and continuation), allocating
a lease, or accepting a turn attempt:

- `false` keeps the selected turn waiting without a worker.
- `true` admits one execution. Checks stop after admission.
- `return process.complete()` completes the process without a worker.

Remote operations in the predicate must be read-only. Use
`process.setState(nextState)` only to stage local observations; the server validates
and commits them if the check is still current. Worker preparation and external
writes belong in the executing turn or an idempotent server delivery service.
Never log credentials in predicate errors.

The server bounds concurrent checks, checks again after 30 seconds, and times out
each read after 30 seconds. `RetryableWaitError` keeps the process waiting with a
persisted diagnostic and exponential backoff capped at five minutes. Other errors
park the process in error until an explicit retry. Retry checks readiness again.
Scheduling-only readiness writes (check revision, due time and retry counters)
preserve the process's activity timestamp and list position. Business state,
admission, lifecycle changes and new or recovered diagnostics advance it.
Restart retains the pending check and due time. Late results cannot override Stop,
a different selected turn, changed params/state, or changed project bindings.

External edges to worker turns must target a turn declaring `.waitFor(...)`.
Definition validation rejects ungated targets. Readiness notifications create no
turn records; published external input keeps its product record. Subscriptions can
wake a check, but cannot bypass it or defeat polling backoff. Mapped turns check
once before freezing their item list; explicit item retries check again.

### Watchers

Watchers start processes from external events. The source extension owns parsing,
presentation, polling, and provider policy. The server owns launch admission and
deduplication. See [Watchers](watchers.md).

### External actions

An external action advances an existing process while a human, waiting LLM or
automatic turn remains selected and waiting:

```ts
const review = flow
  .human<Params, State>("implementation_review")
  .description("Review implementation")
  .externalAction(
    "change_merged",
    codeHostExternal.changeMerged({ projectKey: "app" }),
    (action) => action.label("Merge request merged").complete(),
  );
```

An automatic outcome can `.wait()` without introducing a synthetic wait turn.
External actions arm while the selected turn is durably waiting, including in a
readiness check. Waiting LLM turns support the same `.externalAction(...)` builder;
their fixed routes appear in the graph and selected-turn action projection. They
are inactive while the handler runs. They may wake readiness
for the same or another worker turn, select a human turn, complete, or abort.
Use `.when(...)` to require any published facts needed by the source resolver;
readiness can wait before the first execution has produced those facts.

Use `.when(({ params, state, process, projects }) => boolean)` for process-owned
routing conditions. False excludes the action from both provider subscriptions and
the selected-turn UI. Provider-specific event matching stays in the source resolver.

### Turn progress

Automatic handlers and LLM preparation replace their progress snapshot with
`ctx.reportProgress(...)`. Reports have ordered stable step IDs, labels, and
`incomplete`, `in_progress`, `completed`, or `failed` states. Optional HTTPS links
identify related pull requests, merge requests, commits, or pipelines.

Reports are execution visibility, not turns, products, or proof that an operation
occurred. The server rejects malformed reports, unsafe links, stale turn IDs, and
updates to non-running turns. A thrown handler error marks its current in-progress
step failed before recording the turn failure.

Result publication can include `resultSummary` through `markdown_result`,
`WorkerCompleteInput`, or an outcome's `resultSummaryParameter`. Omitting it remains
valid. A result summary describes the result; `TurnProgressReport.summary` describes
an attempt or wait.

### Launch preparation checks

UI launchers and watchers may return ordered `preparationChecks`. Each has a stable
unique ID, operator label, and asynchronous `run` function. Return on success or
throw `SafeLaunchPreparationError` with safe remediation. The context provides
cancellation, the resolved configuration, and safe logging, not credentials or
checklist mutation. Launchers without checks receive the core checklist.

### External observations

A source may define pure `describeEvent(event)` output: `summary`, optional
`markdown`, and `links`. Consumption persists a valid description. Invalid or failed
optional descriptions do not block event consumption.

Providers may call `externalSources.observe` with the captured subscription
`generation`, an observation, or `refreshError`. Observations include `summary`,
`links`, `observedAt`, and opaque `subject` and `revision`. They never fire transitions.
Timestamps must be valid; HTTP(S) links need unique IDs and must not contain
credentials. Rejected reports preserve the last known facts. See
[subscription generations](watchers.md#subscription-generations). A server provider may
also stage codec-validated business `state` with an observation. The generation
fences that state write without selecting a turn or allocating a worker. Include
its state and project bindings in the source resolver when they affect freshness;
unchanged observations should omit state writes.

## Ticket creation adapters

An integration tool with `capability.kind: "ticket_creation"` names the code-defined
`processId` and `startTurnId` for a derived draft process. Core does not supply a
privileged ticket graph. Startup rejects enabled capabilities whose process or
entry turn is missing.

The catalog exposes `titlePath` and `descriptionPath` as JSON Pointers for the
read-only approval preview. `descriptionFormat: "markdown"` enables sanitized
Markdown rendering; plain text is the default. Every argument remains inspectable when no preview
mapping exists. A launch with no available destinations fails before creating a
child. Retrying an accepted launch returns its existing child, including when the
provider is temporarily unavailable or worker startup needs recovery.

The tool returns `{ externalId, url, result? }`, uses its execution context's
idempotency key, and reconciles ambiguous provider writes. A capability may also
provide destinations:

- `list()` supplies browser-safe IDs, names, groups, and descriptions.
- The worker chooses an opaque `destinationId`, asking the operator when ambiguous.
- Immediately before approval, `resolve()` creates an immutable JSON snapshot.
- The tool receives that snapshot as `ctx.ticketDestination`, never worker-supplied credentials.
- `validate()` supports launches already carrying a snapshot.

Snapshot `data` is adapter-owned durable state. Its `agentContext` is untrusted
prompt text and must not contain secrets. The server commits the child relation
with the process; parent lifecycle operations do not cascade to the child. See
[tool approvals](agent-tools.md#tool-approvals).

## Repository HTTPS credentials

Processes declare only `{ projectKey, kind, credentialRef }`. Credential providers
resolve `git_ssh` or `git_https` material on the server. HTTPS providers authorize an
origin; the server narrows it to the exact credential-free project URL. Each project
has one credential kind. SSH retains pinned known-host verification.

Trusted Git uses `repositoryGitSubprocessEnv(projectKey)` and `repositoryGitArgs()`.
Ordinary subprocesses use `sanitizeWorkerSubprocessEnv()`. Never put credentials in
params, state, projects, or session trees. See [security](security.md#https-repository-authentication).

## Testing process definitions

Use the [extension testing harnesses](testing.md#extension-testing) to inspect
process descriptions, evaluate handlers with independent fixtures, and exercise
durable server/worker behavior. Assert observations instead of constructing SDK
contexts or inspecting handler registries. Keep extension-specific prompt and
state tests with their owner.

## Typed external writes

`ctx.externalWrites.ensure(identity, operation)` returns the remote value after
recording the write. The server supplies storage and process identity:

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
| `before_execute` | Find the remote object or requested state before writing. |
| `after_execute_error` | Recover the object or requested state after an execution error. |
| `already_recorded` | Fetch the current object without repeating the write. |

Use stable markers or provider identifiers. Reads must include closed objects and
completed writes. For updates, compare all requested fields, including normalized
labels, before execution and after errors. Logged replay fetches the current object
without reapplying the patch; later edits must survive.

Return `null` only when no matching object or requested state exists. Propagate
lookup errors. A lookup failure before execution prevents the write. A logged write
whose remote object cannot be recovered fails without recreating it.

After execution failure, reconciliation runs once more. No match rethrows the
execution error. If recovery or recording also fails, an `AggregateError` contains
both errors and retains the execution error as its `cause`.

Metadata extraction and durable recording must succeed before returning. A recording
failure does not repeat execution; a later call reconciles again. Calls serialize
by repository object and deduplication key within one server process. Separate
servers, repository objects, and keys are not coordinated.

Use `logOnly` when an operation has no recoverable remote identity:

```ts
await ctx.externalWrites.logOnly(identity, async () => {
  await restartPipeline();
  return { pipelineId, diagnosis };
});
```

`logOnly` returns `void`. A recorded write skips execution. It cannot recover a lost
response or remote success followed by recording failure.

## Scoped settings and execution purposes

Extensions declare versioned settings and named scopes through
`LeitwerkExtensionModule.scopedSettings`. LLM turns bind them with
`.executionPurpose(id)`. The server resolver is available through
`scopedSettingsCapability`; workers consume the immutable `ctx.scopedSettings`
snapshot. See [Scoped settings](scoped-settings.md) for inheritance, discovery,
validation, and launcher contracts.

State-routed LLM outcomes evaluate their effect first, then choose a declared branch
using the returned state. The state update and selected transition persist together;
policy lookups belong in the effect so routing does not repeat them.

### Integration maintenance

Integrations may register server maintenance through a capability, independent of
the selected turn. GitLab's [maintained-process helper](../extensions/gitlab/README.md#shared-mr-maintenance)
provides MR observation, active/done labels, settled feedback and durable
acknowledgements. Processes declare their bindings, existing external edges, repair
policy and completion adapters. Polling does not add business turns or turn attempts.
Changed work returns to publication; a no-change result resumes observation.

Background reads commit against their process and project snapshots under server
coordination. Ordinary observations retain the selected turn and its execution.
Ownership loss supersedes in-flight work before returning to an existing gated turn
or ending the process; stale worker outcomes cannot restore the prior state.
