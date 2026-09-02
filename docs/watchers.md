# Watchers

**Watchers** enable event-driven process creation. Core stores watcher configuration and connects a configured watcher to a process definition; the extension that supplies the watcher source owns its schema, validation, presentation, polling, event type, and provider behavior.

## Watchers vs. External Actions

- **Watchers (process creation):** discover external events and create new process instances.
- **External actions (in-flight execution):** advance an existing process when an external condition is met. See [Process SDK](process-sdk.md#external-actions).

## Defining a watcher source

An extension defines a typed source once and shares that object between process definitions and its provider adapter:

```ts
interface QueueConfig {
  enabled: boolean;
  queue: string;
}

interface QueueEvent {
  itemId: string;
  summary: string;
}

export const queueSource = defineProcessWatcherSource<QueueConfig, QueueEvent>({
  id: "acme.work_queue",
  label: "Work queue",
  parseConfig(raw) {
    // The extension validates its raw configuration here.
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

Core treats the YAML block as opaque data and calls the source parser after the extension catalog is loaded. Parser errors retain the full `process_configs.<processId>.watchers.<watcherId>` path.

## Declaring a process watcher

The process definition binds a watcher ID and launch resolver to the extension-owned source:

```ts
watchers(api) {
  api.watcher({
    id: "incoming_work",
    label: "Incoming work",
    description: "Launches a process for discovered work",
    source: queueSource,
    resolveLaunchConfig: async (item) => ({
      processId: "work_process",
      params: { itemId: item.itemId, summary: item.summary },
      externalId: item.itemId,
    }),
  });
}
```

## Configuration

Watcher configuration remains colocated with its process configuration. Every field inside the watcher block is defined by the source extension; there is no core watcher type discriminator.

```yaml
process_configs:
  work_process:
    watchers:
      incoming_work:
        enabled: true
        queue: READY
        poll_interval: 30s
```

Sources using `parseProcessWatcherLaunchModelConfig` also accept launch-time skills:

```yaml
launch:
  skills:
    - code-review
```

Before process creation, the server resolves each id to its active revision and pins the
immutable selections to the process. An unknown or inactive skill rejects the launch.

The provider adapter obtains only registrations for its exact typed source and registers
its polling work with the server:

```ts
const watchers = deps.processWatchers?.listBySource(queueSource) ?? [];
const poller = deps.polling.create({
  id: "acme-work-queue",
  pollInterval: () => "5s",
  isEnabled: () => true,
  async pollOnce() {
    const result = emptyPollResult();
    for (const watcher of watchers) {
      const launch = await deps.launchRuns.startWatcher(watcher, event, {
        idempotencyKey: stableSourceEventKey(watcher, event),
      });
      if (launch.process) {
        await consumeSourceEvent(event);
        result.created.push(launch.process.id);
      } else if (launch.error) {
        result.errors.push(`${watcher.processId}:${watcher.watcherId}:${launch.error}`);
      } else {
        result.skipped.push(`${watcher.processId}:${watcher.watcherId}`);
      }
    }
    return result;
  },
});
```

The server starts registered pollers after extension setup and stops them during
shutdown. Poller IDs must be unique. Scheduled passes do not overlap. A rejected pass
is logged with the full error. A completed pass with a non-empty `errors` array is logged
with the complete result. Providers may call `poller.poll()` directly in tests or explicit
fixtures, but do not own scheduled polling lifecycle.

## Idempotency and deduplication

Provider adapters should use stable external identifiers so repeated polls do not create duplicate active work. External mutations should use `ensureWrite()` from `@leitwerk-dev/external-writes` so retries and restarts converge without duplicate remote writes.

If a trigger disappears or closes externally, the owning extension decides how to reconcile that state.
