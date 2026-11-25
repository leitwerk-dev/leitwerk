# Watchers

A **watcher** starts new processes from external events. An **external action** advances an existing process. Source extensions own parsing, presentation, polling, and provider policy; core owns configuration storage, launch admission, and deduplication.

| Responsibility | Owner |
| --- | --- |
| Source schema, parsing, presentation, polling, event selection | Source extension |
| Binding a source to process params and entry turn | Process definition |
| Config storage, launch admission, durable deduplication | Server |

See [External actions](process-sdk.md#external-actions) and [Readiness predicates](launchers-and-readiness.md#readiness-predicates) for routing events into existing processes.

## Define a watcher source

Share one typed `ProcessWatcherSource` between provider adapters and process definitions:

```ts
interface QueueConfig {
  enabled: boolean;
  queue: string;
}

interface QueueEvent {
  itemId: string;
  summary: string;
}

const queueSource = defineProcessWatcherSource<QueueConfig, QueueEvent>({
  id: "acme.work_queue",
  label: "Work queue",
  parseConfig(raw) {
    const { config, launch } = parseQueueConfig(raw);
    return {
      config,
      enabled: config.enabled,
      launchModelConfig: parseProcessWatcherLaunchModelConfig(launch),
    };
  },
  presentConfig(config) {
    return {
      targetSummary: `Queue ${config.queue}`,
      details: [{ label: "Queue", value: config.queue }],
    };
  },
});
```

Core keeps watcher YAML opaque until catalog load, then invokes `parseConfig`. Validation errors preserve the `process_configs.<processId>.watchers.<watcherId>` path.

## Bind to a process

Attach watchers via `.watcher(...)` on the process builder:

```ts
.watcher({
  id: "incoming_work",
  label: "Incoming work",
  description: "Start work from the queue",
  source: queueSource,
  resolveLaunchConfig: async (item) => ({
    processId: "work_process",
    params: { itemId: item.itemId, summary: item.summary },
    externalId: item.itemId,
  }),
})
```

Watchers support the same optional `preparationChecks` as UI launchers ([Launch preparation checks](launchers-and-readiness.md#launch-preparation-checks)).

A watcher may also set `defaultModelProfileId` on the returned `launchConfig` from trusted event data. That selection overrides the configured watcher default and must pass model validation (unavailable profiles fail admission rather than falling back). Configured per-turn overrides retain precedence.

## Configuration

Operators configure watchers under their process in `leitwerk.yaml`. Every key inside the watcher block belongs to the source extension:

```yaml
process_configs:
  work_process:
    watchers:
      incoming_work:
        enabled: true
        queue: READY
```

Sources using `parseProcessWatcherLaunchModelConfig` accept `launch.skills` and model overrides inside the watcher block. Before commit, the server resolves each skill ID to its active revision and pins it; unknown or inactive skills reject launch.

## Poll and admit events

In `setupServer(api, config)`, get the host services with `api.require(coreHostCapabilities.serverSetup)`. Register a poller for each configured watcher. This example uses your queue adapter’s `fetchEligibleEvents` and `acknowledgeSourceEvent` functions.

```ts
const deps = api.require(coreHostCapabilities.serverSetup);
if (Array.isArray(deps)) {
  throw new Error("Expected one server setup capability");
}
const watchers = deps.processWatchers?.listBySource(queueSource) ?? [];

for (const watcher of watchers) {
  const id = `acme.work_queue:${watcher.processId}:${watcher.watcherId}`;
  deps.polling.create({
    id,
    isEnabled: () => watcher.enabled,
    pollInterval: () => "30s",
    async pollOnce() {
      const result: { errors: string[] } = { errors: [] };
      for (const event of await fetchEligibleEvents(watcher.config)) {
        try {
          const admission = await deps.launchRuns.startWatcher(watcher, event, {
            idempotencyKey: JSON.stringify([id, watcher.config.queue, event.itemId]),
          });
          if (admission.error) {
            result.errors.push(`${event.itemId}: ${admission.error}`);
          }
          if (admission.process) {
            await acknowledgeSourceEvent(event);
          }
        } catch (error) {
          result.errors.push(`${event.itemId}: ${String(error)}`);
        }
      }
      return result;
    },
  });
}
```

Use unique poller IDs. The server starts enabled pollers after extension setup, prevents overlapping passes, logs thrown errors and entries in `result.errors`, and stops pollers on shutdown. Tests can call `poll()` on the registration returned by `deps.polling.create(...)` to run a pass without timers.

Acknowledge or consume an external event once `admission.process` is present. Leave uncommitted events retryable. Route remote acknowledgements through [Typed external writes](external-writes-and-adapters.md#typed-external-writes).

A watcher may set `defaultModelProfileId` from trusted event data. This preference overrides the watcher default; per-turn overrides retain precedence. Invalid choices that can be represented are retained with diagnostics, not silently omitted. Malformed configuration still fails parsing.

Watcher admission defers policy and availability blocks to the affected turn. Each LLM start uses the same [model requirements and selection](../admin/models.md#profile-resolution) as UI launches. An unavailable selected profile blocks without failover. A durably created process retains its handoff identity and source acknowledgement even when blocked.

### Deduplication

Pass a stable `idempotencyKey` across retries. An uncommitted failed Launch Run releases the key for retry; once a process commits, later polls with the same key return that existing process.

## External action sources

Define resolver-based sources for `flow.external` and `.externalAction(...)` with `defineExternalActionSource`:

```ts
const changeMerged = defineExternalActionSource<{ projectKey: string; prNumber: number }>({
  kind: "acme.change_merged",
  label: "Change merged",
  describeEvent: () => ({ summary: "Change merged" }),
});

// Used in a process definition:
const mergedSource = changeMerged<Params, State>(({ state }) => ({
  projectKey: "app",
  prNumber: state.prNumber,
}));
```

`resolve({ params, state })` computes process-specific subscription config; core hashes and persists it opaquely without interpreting provider fields.

### Restarting a waiting process

To restart a waiting process with updated revision data, call `deps.commands.startProcess(instanceId, turnId, { restart })` supplying `restart.expected` (captured waiting turn, params, and state), `restart.stateJson`, and optional `restart.project` (repository key plus old/new base). The server validates and commits atomically under the process lock. Treat `restart_superseded` as a signal to skip and rediscover; never mutate state directly before starting a turn.

## Subscription generations and observations

External subscriptions (`deps.externalSources`) reflect committed process changes immediately without waiting for reactions.

- **Fenced firing:** Pass the captured `generation` from `listArmed` to `fire`. If state changed in the meantime, the server returns `external_source_superseded` without queuing an event or recording a turn.
- **Observations:** Report current external status with `deps.externalSources.observe` using the captured `generation`, an observation (`summary`, credential-free HTTPS `links`, valid `observedAt`, opaque `subject`/`revision`), or `refreshError`. Observations never fire transitions; rejected reports keep the last known facts.
- **Staging state:** An observation may stage codec-validated `state` under the same generation fence without starting a worker. Include any state or project bindings affecting freshness in the source resolver, and omit state writes when unchanged.
- **Event descriptions:** Sources may define pure `describeEvent(event)` returning `{ summary, markdown?, links? }` persisted on consumption; malformed descriptions do not block consumption.

Recheck freshness after provider I/O before observing or firing. Use `createExternalSourcePollReporter` from `@leitwerk-dev/process-sdk` and shared helpers in `@leitwerk-dev/watcher-utils` for standard poll reporting.
