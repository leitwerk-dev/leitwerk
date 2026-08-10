# Watchers

**Watchers** enable event-driven automation in Leitwerk. While manual launchers require a human operator to fill out a form, a **Watcher** monitors an external signal—most commonly a local filesystem path in the shipped tree—and triggers a launcher to resolve configuration and start a new process instance whenever matching work appears.

## Watchers vs. External Actions

It is important to distinguish between discovering new work and advancing existing work:

- **Watchers (Process Creation):** Discover external events and trigger a launcher to create a **new process instance**. Watchers do not advance active, running processes.
- **External Actions (In-Flight Execution):** Armed during a human review turn to advance an **existing process instance** when an external condition is met (e.g., waiting for a GitLab merge request to be merged). See [Process SDK](process-sdk.md#external-actions).

## Shipped poller vs. schema hooks

- **In-tree poller:** The server ships a **filesystem** process-watcher poller (`createFilesystemProcessWatchersService`). The example config and `showcase-processes` poem watcher use `type: filesystem`.
- **Schema / extension hooks:** Config also accepts `jira` and `gitlab_mr` watcher shapes (and the registry can list them), but there are **no in-tree provider packages** that poll Jira or GitLab MRs. Those types are for extension-owned providers, not built-in behavior.

## Declaring & Configuring Watchers

Watchers are declared in code by an extension and enabled via configuration.

### 1. Code Declaration (`api.watcher`)

An extension registers a watcher definition and its launch resolver:

```ts
// Registered inside a process / extension definition
.watcher({
  id: "create_poem",
  label: "Create Poem from File",
  type: "filesystem",
  matches(event) {
    return typeof event.content === "string";
  },
  resolveLaunchConfig(event) {
    return {
      processId: "poem_creator_process",
      params: { prompt: String(event.content).trim() },
      startTurnId: "draft_poem",
    };
  },
})
```

### 2. Configuration (`leitwerk.yaml`)

Watchers are enabled per process in `leitwerk.yaml`. Filesystem watchers require `enabled`, `poll_interval`, and `file_path`:

```yaml
process_configs:
  poem_creator_process:
    watchers:
      create_poem:
        type: filesystem
        enabled: true
        poll_interval: 1s
        file_path: /tmp/create-poem
```

For reference, the config schema for other types (when an extension provides the poller) uses fields such as:

- **jira:** `project`, `poll_interval`, `labels.trigger` / `labels.done`, `target_branch_label_prefix` (not `project_keys`)
- **gitlab_mr:** `group`, `poll_interval`, `labels.trigger` / `labels.done`

- **`type`:** Selects the watcher implementation (`filesystem` shipped; `jira` / `gitlab_mr` require an extension provider).
- **`enabled`:** Toggles background polling for that watcher instance.

## Idempotency & Deduplication

Because background watchers poll periodically, they must handle retries and duplicate events safely:

### 1. Deduplication
Provider watchers should use stable external identifiers so a single external item creates only one active process instance (skip creation when an open process already exists for that id). The shipped **filesystem** poller instead consumes/unlinks the trigger file after a successful launch (`consumeTriggerFile`); it does not implement open-instance skip by path. Extension-owned providers (for example issue/MR watchers) are responsible for their own open-process dedup.

### 2. Idempotent External Writes (`ensureWrite`)
External operations (for example attaching process links or updating remote labels from an extension provider) use `ensureWrite()` from `@leitwerk-dev/external-writes`. This guarantees that repeated poll cycles or server restarts converge on the same remote links, labels, and status without posting duplicate side effects.

### 3. Trigger Removal
If an external trigger item is removed or closed outside of Leitwerk, an extension provider watcher can reconcile by completing or aborting the related process. Filesystem triggers are removed when consumed after launch.
