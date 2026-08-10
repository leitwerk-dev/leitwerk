# Watchers

**Watchers** enable event-driven automation in Leitwerk. While manual launchers require a human operator to fill out a form, a **Watcher** monitors external systems—such as Jira issues, GitLab merge requests, or local filesystem paths—and triggers a launcher to resolve configuration and start a new process instance whenever matching work appears.

## Watchers vs. External Actions

It is important to distinguish between discovering new work and advancing existing work:

- **Watchers (Process Creation):** Discover external events and trigger a launcher to create a **new process instance**. Watchers do not advance active, running processes.
- **External Actions (In-Flight Execution):** Armed during a human review turn to advance an **existing process instance** when an external condition is met (e.g., waiting for a GitLab merge request to be merged). See [Process SDK](process-sdk.md#external-actions).

## Declaring & Configuring Watchers

Watchers are declared in code by an extension and enabled via configuration.

### 1. Code Declaration (`api.watcher`)

An extension registers a watcher definition and its launch resolver:

```ts
// Registered inside setup(api) in an extension
api.watcher({
  id: "jira_default",
  displayName: "Jira Issue Watcher",
  type: "jira",
  resolveLaunchConfig: async (item) => ({
    processId: "jira_issue_process",
    params: { issueKey: item.issueKey, summary: item.summary },
    projects: [{ key: "repo", repoLocator: item.repoUrl, baseBranch: "main" }],
  }),
});
```

### 2. Configuration (`leitwerk.yaml`)

Watchers are enabled per process in `leitwerk.yaml`:

```yaml
process_configs:
  jira_issue_process:
    watchers:
      jira_default:
        type: jira
        enabled: true
        poll_interval: 30s
        project_keys: ["PROJ"]
```

- **`type`:** Selects the provider watcher implementation (`jira`, `gitlab_mr`, `forgejo_issue`, or `filesystem`).
- **`enabled`:** Toggles background polling for that watcher instance.

### Forgejo issues across all visible repositories

`forgejo_issue` delegates polling of all repositories visible to a server-owned
Forgejo profile:

```yaml
process_configs:
  forgejo_repo_change_process:
    watchers:
      use_leitwerk:
        type: forgejo_issue
        enabled: true
        profile: homeserver
        poll_interval: 30s
        labels:
          trigger: use-leitwerk
          done: leitwerk-done
```

The provider supplies repository and issue metadata to the watcher launch resolver.
Use a stable handoff key such as `forgejo:<owner>/<repo>#<number>` so repeated polls
cannot create duplicate active processes.

## Idempotency & Deduplication

Because background watchers poll external systems periodically, they must handle retries and duplicate events safely:

### 1. Deduplication
Watchers use stable provider identifiers (such as Jira issue keys `PROJ-123`, GitLab MR IDs, or file paths) to ensure that a single external item creates only one active process instance. If an open process already exists for that item, repeated polls skip process creation.

### 2. Idempotent External Writes (`ensureWrite`)
External operations (such as attaching process links to Jira tickets or adding comments to GitLab MRs) use `ensureWrite()` from `@leitwerk-dev/external-writes`. This guarantees that repeated poll cycles or server restarts converge on the same remote links, labels, and status without posting duplicate comments or creating duplicate tickets.

### 3. Trigger Removal
If an external trigger item is removed or closed outside of Leitwerk, the provider watcher can reconcile the change by marking the process complete or aborting cleanly.
