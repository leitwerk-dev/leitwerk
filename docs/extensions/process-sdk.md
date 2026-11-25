# Process SDK

`@leitwerk-dev/process-sdk` defines processes, turns, products, human actions, and extension hooks. Start with [Write your first process](first-process.md) for a runnable package.

Related contracts:

- [Launchers & readiness](launchers-and-readiness.md) — UI launchers, `.waitFor(...)`, programmatic admission, progress reports.
- [Agent tools](agent-tools.md) — Workspace primitives, integration tools, approvals, outcome schemas, `abort_turn`.
- [Watchers](watchers.md) — External event sources, polling, deduplication, subscription generations.
- [External writes & adapters](external-writes-and-adapters.md) — Idempotent writes, ticket adapters, repository credentials, maintenance.
- [Scoped settings](scoped-settings.md) — Declaring scopes, fields, discovery, and `executionPurpose`.

## API compatibility

Published declarations mark every exported symbol and member `@public` (supported API) or `@internal` (implementation API). Both remain importable, callable, and typed. Classifications apply per member: a `@public` interface does not make every member public. Re-exports preserve the original tag.

Breaking a `@public` API — including removing its `@public` tag — requires release notes and a minor bump during `0.x` or a major bump from `1.0`. `@internal` APIs carry no compatibility guarantee.

Validate classifications and public signature dependencies with:

```sh
leitwerk-dev api:check --workspace PATH
```

## Extension package

Declare source and built entry points in `package.json`:

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

Source development loads `source`; production loads `import`. Declare runtime dependencies in `package.json` and build `import` before production startup. Register packages in `extension_loading.sources` (paths resolve from the config file's directory). Extensions may also declare `leitwerk.skills` ([Skill packs](skill-packs.md)), `leitwerk.ui` ([UI renderers](ui-renderers.md)), and `leitwerk.pi` ([Model providers](model-providers.md)).

Export a default `LeitwerkExtensionModule`. Server extensions access host services (`commands`, `launchRuns`, `processWatchers`, `polling`, `externalSources`) through `coreHostCapabilities.serverSetup`:

```ts
import {
  coreHostCapabilities,
  type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { myProcess } from "./my-process.js";

export default {
  manifest: { id: "my-extension", version: "1.0.0" },
  setupCatalog(api) {
    api.registerProcess(myProcess);
  },
  setupServer(api, _config) {
    const deps = api.require(coreHostCapabilities.serverSetup);
    api.events.on("process_created", ({ instanceId }) => {
      api.logger?.info?.({ instanceId }, "Process created");
    });
    void deps;
  },
} satisfies LeitwerkExtensionModule;
```

## Extension module lifecycle

An extension package exports a default `LeitwerkExtensionModule`:

| Property | Phase | Purpose |
| --- | --- | --- |
| `manifest` | Discovery | Declares unique `id`, `version`, and optional `requires` / `optional` extension IDs. |
| `scopedSettings` | Startup | Declares versioned non-secret settings, scopes, and execution purposes. |
| `modelProviders` | Pre-server | Resolves owner-scoped model providers from `extensions.<id>` before `setupServer`. |
| `setupCatalog(api)` | Catalog | Registers processes (`registerProcess`), tool renderers (`registerToolRenderer`), and catalog capabilities. |
| `setupServer(api, config)` | Server | Registers integration tools (`tool`), event subscribers, capabilities, pollers, and `onStart`/`onStop` hooks. |
| `setupWorker(api, config)` | Worker | Wires optional worker-side capabilities and event hooks. |

Server-owned integrations, credentials, and polling belong in `setupServer`, never in `setupCatalog`. Core owns durable SQLite state, worker supervision, and the application shell; extensions must not access SQLite directly or replace global navigation.

## Process definitions and turns

Author processes with the fluent `flow` builders (`flow.process<Params, State>(id)`), or with lower-level declarative primitives (`defineProcess`, `llmTurn`, `humanTurn`, `automaticTurn`, `routeTurnOutcomes`). Both validate turn metadata, route targets, product publishers, entry turns, happy paths, and action forms immediately and report independent errors together without executing codecs, prompts, or callbacks. Catalog admission repeats validation and enforces unique process IDs.

Configuration supplies runtime defaults; it never defines turns, transitions, actions, or completion policy. Multi-repository processes still have one durable instance and one execution tree.

| Builder | Execution |
| --- | --- |
| `flow.llm` | Optional deterministic preparation, then an LLM session with authorized tools. |
| `flow.mappedLlm` | Runs an LLM turn sequentially over frozen items, then collects results and routes once. |
| `flow.automatic` | Runs deterministic TypeScript in a worker; server operations require integration tools. |
| `flow.human` | Waits for an operator action or a declared external action. |
| `flow.external` | Waits for a declared external source. |

Use `.happyPath(...)` to declare the expected successful spine for navigation. Workflow inspection reads static turn, route, tool, and product declarations without evaluating prompts, mapped items, or dynamic tool resolvers.

Use `.piConfig({ appendSystemPromptTemplate?, sessionCwdTemplate? })` on `flow.process` to append Mustache-rendered instructions after the base system prompt or set a Mustache-rendered session working directory (defaults to the workspace root).

## Products

A **product** is a named Markdown artifact published by one turn and consumed by another:

| Method | Contract |
| --- | --- |
| `.publish("plan")` | Replaces the named product when the turn completes. |
| `.consume("plan")` | Requires the product before the turn runs; exposes `ctx.input.plan`. |
| `.optionalConsume("plan")` | Exposes `ctx.input.plan` when present. |

Every consumed product (required or optional) must have a declared publisher in the same process. Publishing stores a reference to the source turn record rather than copying prompt state.

## Human turns and external actions

A human turn names the reviewed product with `.reviewProduct(...)` and declares operator actions:

```ts
const review = flow
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

Do not define Retry or Continue actions; recovery is generic runtime infrastructure. Server extensions can trigger retry via `deps.commands.retryProcess(instanceId)` under the process lock.

### External actions

An external action advances an existing process while a human, waiting LLM, or waiting automatic turn is selected:

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

- Automatic outcomes may `.wait()` to hold the turn for external actions without adding a synthetic wait turn.
- External actions arm only while the turn is durably waiting (including during a readiness check); they are inactive while a worker executes.
- Use `.when(({ params, state, process, projects }) => boolean)` to gate subscription arming and UI visibility from process state.
- Any external edge targeting a worker turn must obey [Readiness predicates](launchers-and-readiness.md#readiness-predicates).

## Worker turns

`ModelRequirements` is a data-only contract. Declare `modelRequirements` on a process or LLM turn, including through `.modelRequirements(...)` on flow builders. It supports profile allowlists, required capabilities, and `all_of`, `any_of`, and `none_of` label clauses. Non-LLM turn declarations and empty allowlists or `any_of` clauses are rejected. Operator requirements intersect with code declarations; they cannot widen them. See [model policy](../admin/models.md#classification-and-requirements).

### LLM branch and context modes

Select how an LLM turn attaches to the process Pi session tree:

| Method | Behavior |
| --- | --- |
| `.freshPrimary()` | Primary branch with fresh context (no prior conversation). |
| `.freshSeededPrimary()` | Primary branch with fresh seeded context. |
| `.fullPrimary()` | Primary branch retaining full prior conversation. |
| `.continueFromPrimaryLeaf()` | Continues from `currentPrimaryPathLeaf` (falls back to current leaf). |
| `.rootBranchReview()` | Runs on a root side branch with full context and restores the primary leaf afterward. |
| `.startFromProductBranch(product, fallback?)` | Starts from the branch that published `product` (defaults to `session_root` fallback). |

### LLM turn preparation and questions

Use `.prepare(fn)` for deterministic work that supplies one LLM turn after acceptance and before prompting:

```ts
const analyze = flow
  .llm<Params, State>("analyze")
  .description("Analyze process")
  .integrationTools("download_snapshot")
  .prepare(async (ctx) => {
    await ctx.callIntegrationTool("download_snapshot", { processRef: ctx.params.processRef });
    return { instructions: "Inspect the downloaded snapshot." };
  })
  .buildPrompt((ctx) => ctx.prepared.instructions)
  .publish("analysis")
  .to("analysis_decision");
```

Preparation rules:

- Result must be non-secret, JSON-serializable, and at most 64 KiB.
- Preparation exposes immutable `ctx.scopedSettings`, `ctx.callIntegrationTool(...)`, `ctx.reportProgress(...)`, and `ctx.reportDiagnostic(...)` (writes non-secret diagnostics to `worker.trace`).
- Failure fails the owning turn before prompting. Retry re-runs preparation; Continue and worker replacement reuse the saved checkpoint when present. Keep preparation deterministic and writes idempotent.

Enable operator questions with `.askQuestions()`. An optional predicate `.askQuestions(ctx => boolean)` runs after preparation using captured params, state, and `ctx.prepared`; returning `false` omits `ask_questions` and its guidance.

### Outcome effects and state routing

LLM and automatic outcomes update durable state through `.state(...)` or `.effect(...)`:

- `.state(({ ctx, event }) => nextState)` computes the next validated state.
- `.effect(({ ctx, event }) => ({ state, processPatch?, queueInput? }))` updates state and optionally patches process metadata or queues durable input.

State-routed LLM outcomes run their effect first, then pick a declared branch from the updated state; both persist together. Branch values may be turn IDs or `ProcessOutcomeBranchSpec` objects (`{ to, label, description }`) used by Workflow graph inspection:

```ts
.routeByState(
  {
    approval: {
      to: "review",
      label: "Approval required",
      description: "An operator must approve the saved plan.",
    },
    bypass: { to: "implement", label: "Skip plan approval" },
  },
  ({ ctx }) => (ctx.state.skipApproval ? "bypass" : "approval"),
)
```

For outcome Markdown publication, `.outcomeTool(...)` auto-injects a required `markdown` parameter when publishing a product; call `.markdown(name, { publish: true })` to use a custom parameter name.

### Automatic turns

`flow.automatic<Params, State>(turnId)` executes deterministic TypeScript inside a worker:

```ts
const publish = flow
  .automatic<Params, State>("publish")
  .description("Push branch and open PR")
  .integrationTools("forge_create_pr")
  .run(async (ctx) => {
    const repo = ctx.repo.get("app"); // { fsPath, baseBranch, workBranch }
    await ctx.callIntegrationTool("forge_create_pr", {
      projectKey: "app",
      branch: repo.workBranch,
    });
    return { outcome: "published", resultSummary: "Opened pull request" };
  })
  .outcome("published", (o) => o.complete());
```

- `.run(ctx => WorkerCompleteInput)` returns `{ outcome, params?, markdown?, resultSummary? }`.
- `ctx.repo` (`FlowRepoLookup`) provides `get(key)`, `optional(key)`, and `all()` returning `{ fsPath, baseBranch, workBranch }`.
- Declare every possible outcome with `.outcome(id, builder)` routing via `.to(...)`, `.complete()`, `.wait()`, or `.routeByState(...)`.

### External turns

`flow.external<Params, State>(turnId)` pauses on one or more external action sources without allocating a worker:

```ts
const waitCi = flow
  .external<Params, State>("wait_ci")
  .description("Wait for CI result")
  .from(ciPassedSource)
  .state(({ ctx, event }) => ({ ...ctx.state, buildUrl: event.url }))
  .to("deliver");
```

Route each `.from(source)` branch with `.to(turnId)`, `.complete()`, or `.lifecycleStatus(status)`, and optional `.state(...)` / `.effect(...)`. See [External action sources](watchers.md#external-action-sources) for `defineExternalActionSource`.

### Runtime capabilities and storage sizing

Configure worker runtime requirements with `.runtime(...)`:

| Option | Values / default | Effect |
| --- | --- | --- |
| `repositoryCheckout` | `"eager"` (default), `"on_demand"`, `"none"` | Eager clones all projects at bootstrap; `"on_demand"` exposes `checkout_repository`; `"none"` keeps bindings for server tools with no clones or checkout tool. |
| `developmentTools` | `boolean` (`false`) | Runs `mise install` at each repository root before readiness. Repository config selects tool versions. |
| `docker` | `boolean` (`false`) | Requires Docker support from the runner (`local_worker.allow_host_docker`, `docker.private_daemon.isolation`, or `kubernetes.docker`). Launch rejects unavailable runners before creation. |

For Kubernetes process-volume sizing, supply synchronous, side-effect-free `.resolveStorageSize(({ params, projects }) => string | undefined)` returning a positive Kubernetes quantity (such as `128Mi` or `1Gi`) or `undefined` for the global default. Explicit `process_configs.<id>.storage_size` bypasses the resolver; local and Docker runners ignore it; existing PVCs are never resized. See [Configuration](../admin/configuration.md).

## Mapped LLM turns

Use `flow.mappedLlm<Params, State, Item, Result>(turnId, items)` to run one LLM turn sequentially per frozen item while keeping a single graph node. Each item gets its own turn record, Chronicle card, and rail row; `.collect(...)` combines results and routes once.

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

Contract rules:

- **Freezing:** Entering the turn evaluates `items` once on the server and parses each with `itemCodec` (at most 500 items; unique non-empty keys `<= 200` chars; plain-text labels `<= 200` chars defaulting to key). `stateAfterSnapshot` runs in the same transaction so the full list need not reach workers.
- **Worker scope:** Each worker receives only `ctx.item`, `ctx.itemKey`, `ctx.itemLabel`, `ctx.itemIndex`, and `ctx.itemCount`. Declare `.prepare()`, `.consume()`, and `.optionalConsume()` before `.buildPrompt()` for narrowed callback types.
- **Item outcomes:** Item outcomes declare parameters and `.yield(...)` only (no routing, state mutation, or product publication). `yield` runs on the server and its return value must pass `resultCodec`; throwing `SafeOutcomePlanningError(code, message)` rejects the outcome cleanly. Each item's Markdown comes from the reserved `markdown` argument. Leaf-outcome capture receives `mappedResult` immediately on item acceptance.
- **Collection and recovery:** After the last item, `collect` receives results in item order and applies `.to()`, `.complete()`, `.lifecycleStatus()`, or `.routeByState()`. An empty list collects immediately without starting a worker. A failed item stays current for Retry or Continue without re-running completed items; each item resolves its model independently. Re-entering the turn later freezes fresh items.

For worker-side outcome correction (`.validateOutcome`), contextual schemas (`.resolveParameters`), nested `anyOf`, and `.strictSchema()`, see [Agent tools](agent-tools.md#outcome-tools).

## Server extension events

Server extensions subscribe to lifecycle events via `api.events.on(name, handler)` in `setupServer`. Events emitted during a process mutation are deferred until the process lock is released, so handlers never deadlock with `ProcessEngine`.

| Event (`ServerExtensionEventMap`) | Key payload fields |
| --- | --- |
| `process_created` | `instanceId`, `process`, `projects`, `launcherId?` |
| `process_updated` | `instanceId`, `process`, `changedFields` |
| `turn_started` | `instanceId`, `turnRecord` |
| `turn_outcome` | `instanceId`, `turnRecordId`, `turnId`, `outcome`, `params`, `turnResultMarkdown?` |
| `turn_failed` | `instanceId`, `turnRecord`, `errorSummary`, `errorClass?` |
| `leaf_outcome_captured` | `instanceId`, `snapshot` |
| `question_requested` | `instanceId`, `request` |
| `review_requested` | `instanceId`, `changedProjects`, `workerId?` |
| `plan_saved`, `plan_approved`, `plan_revision_requested`, `review_completed` | Domain-specific plan/review payloads for coding workflows |

Mutate processes from event handlers via `deps.commands` or `deps.launchRuns` (from `api.require(coreHostCapabilities.serverSetup)`); never write to SQLite directly.

## Built-in extensions

These first-party extensions ship in the repository and load through the same `extension_loading.sources` contract as external packages. Each owns its configuration schema and process behavior in its package README.

### Showcase & examples

| Extension | Purpose |
| --- | --- |
| [showcase-processes](../../extensions/showcase-processes/README.md) | Poem Creator process, filesystem watcher, and custom leaf-outcome renderer. |
| [example-processes](../../extensions/example-processes/README.md) | Single Prompt, Done Tool, External Complete, and Kubernetes smoke processes. |
| [process-analysis](../../extensions/process-analysis/README.md) | Read-only analysis launcher for inspecting an existing process. |

### Core capabilities & skills

| Extension | Purpose |
| --- | --- |
| [models](../../extensions/models/README.md) | Standard Pi API-key providers and config-defined custom gateways. |
| [skills](../../extensions/skills/README.md) | Extension-bundled skills automatically available to workers. |
| [mattpocock-skills](../../extensions/mattpocock-skills/README.md) | Selectable skill pack built from pinned upstream skills and patches. |
| [coding](../../extensions/coding/README.md) | Shared repository-change turn graph, commit-message rules, and branch finalization. |
| [git-ssh](../../extensions/git-ssh/README.md) | Pinned SSH key and `known_hosts` repository credential profiles. |
| [ticket-creation](../../extensions/ticket-creation/README.md) | Derived draft ticket process, destination snapshots, and approval flow. |
| [telegram](../../extensions/telegram/README.md) | Telegram forum-topic bridge for process interaction. |

### Provider integrations & workflows

| Extension | Purpose |
| --- | --- |
| [github](../../extensions/github/README.md) | GitHub issues, pull requests, watchers, and external actions. |
| [github-repo-change](../../extensions/github-repo-change/README.md) | GitHub issue and UI-launched repository changes with pull-request delivery. |
| [gitlab](../../extensions/gitlab/README.md) | GitLab issues, merge requests, watchers, external actions, and MR maintenance. |
| [gitlab-repo-change](../../extensions/gitlab-repo-change/README.md) | GitLab issue and UI-launched repository changes with merge-request delivery. |
| [forgejo](../../extensions/forgejo/README.md) | Forgejo issues, pull requests, watchers, and external actions. |
| [forgejo-repo-change](../../extensions/forgejo-repo-change/README.md) | Forgejo issue and UI-launched repository changes with pull-request delivery. |
| [woodpecker](../../extensions/woodpecker/README.md) | Woodpecker CI profiles and pipeline integration tools. |
| [jira](../../extensions/jira/README.md) | Jira Data Center issue integration, watchers, and scoped project settings. |
| [jira-gitlab-change](../../extensions/jira-gitlab-change/README.md) | Multi-component Jira and GitLab delivery workflow. |
| [jira-issue-split](../../extensions/jira-issue-split/README.md) | Split Jira epics or issues into scoped child tickets per repository. |

### Core package references

| Package | Purpose |
| --- | --- |
| [@leitwerk-dev/wiki](../../packages/wiki/README.md) | Core package owning topic solution wiki storage, agent tools, HTTP handlers, and browser views. |
