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

The provider adapter obtains only registrations for its exact typed source:

```ts
const watchers = deps.processWatchers?.listBySource(queueSource) ?? [];
for (const watcher of watchers) {
  const launchPlan = await watcher.resolveLaunch(event);
  // Prepare and commit launchPlan through the server capabilities.
}
```

## Idempotency and deduplication

Provider adapters should use stable external identifiers so repeated polls do not create duplicate active work. External mutations should use `ensureWrite()` from `@leitwerk-dev/external-writes` so retries and restarts converge without duplicate remote writes.

If a trigger disappears or closes externally, the owning extension decides how to reconcile that state.
