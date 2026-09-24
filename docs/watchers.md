# Watchers

A watcher starts a process from an external event. An external action advances a
process that already exists. Both use extension-owned sources; core does not define
a fixed provider catalog.

| Responsibility | Owner |
| --- | --- |
| Source schema, parsing, presentation, polling, event selection | Source extension. |
| Binding a source to process params and an entry turn | Process definition. |
| Configuration storage, launch admission, and durable deduplication | Server. |

See [external actions](process-sdk.md#external-actions) for in-flight routing.

## Define a source

Share one typed source object between process definitions and the provider adapter.
This fragment assumes the extension supplies `parseQueueConfig` and the SDK imports:

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

Core treats the watcher YAML as opaque until the catalog is loaded, then calls the
source parser. Errors retain the full
`process_configs.<processId>.watchers.<watcherId>` path.

## Bind a process

Use `.watcher(...)` on the process builder. The surrounding definition must supply
its codecs, state, and turns:

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

Watchers may return the same ordered
[preparation checks](process-sdk.md#launch-preparation-checks) as UI launchers.

## Configuration

Configure the code-defined watcher under its process. There is no core source-type
discriminator; every field inside the block belongs to the source extension:

```yaml
process_configs:
  work_process:
    watchers:
      incoming_work:
        enabled: true
        queue: READY
```

Sources using `parseProcessWatcherLaunchModelConfig` can also parse `launch.skills`
and model selections inside that block. Before creation, the server resolves each
skill ID to an active revision and pins it. Unknown or inactive skills reject launch.

## Poll and admit events

The provider retrieves registrations through
`deps.processWatchers.listBySource(queueSource)` and registers polling with
`deps.polling.create(...)`. Poller IDs are unique. The server starts polling after
extension setup, prevents overlapping scheduled passes, and stops it on shutdown.
A rejected pass logs its error; a completed pass with reported errors logs the result.
Tests or explicit fixtures may call `poller.poll()` without owning the timer lifecycle.

For each eligible event, request admission:

```ts
const admission = await deps.launchRuns.startWatcher(watcher, event, {
  idempotencyKey: stableSourceEventKey(watcher, event),
});
if (admission.process) {
  await acknowledgeSourceEvent(event);
}
```

The provider owns the two functions shown here. Acknowledge or consume the source
only after process creation has committed; keep failed admissions available for
retry. External acknowledgement writes must themselves be retry-safe.

## Idempotency and deduplication

Use a stable source-event key across retries. Callers supply only the registration,
event intent, key, and optional actor; they do not receive the raw process executor
or supply launch-plan dependencies.

An uncommitted failed Launch Run may yield the key to a new attempt. Once an attempt
has committed a process, later polls return that attempt instead of creating another
one. The server retains the event key as the process handoff deduplication key.
See [launch progress](server-worker-lifecycle.md#7-launch-progress).

Provider mutations follow the [external-write contract](process-sdk.md#typed-external-writes).
If a trigger disappears or closes externally, its extension owns reconciliation policy.

### Subscription generations

For external actions, providers may pass the captured `generation` from `listArmed`
to `fire`. The server checks it under the process lock. A superseded subscription
returns `external_source_superseded` without recording a turn or queuing an event.
Omitting the generation retains the generation-free queueing contract. Observations
require a captured generation and never change process position.

Recheck freshness after provider I/O before observing or firing. The SDK poll reporter
supports this check, but providers retain event-selection and scheduling policy.
See the [source reporter API](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/process-sdk/src/external-source-poll.ts)
and [watcher utilities](https://github.com/leitwerk-dev/leitwerk/blob/main/packages/watcher-utils/README.md).
Provider-specific policies belong in their extension READMEs.
