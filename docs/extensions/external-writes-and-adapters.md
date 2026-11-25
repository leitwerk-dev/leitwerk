# External writes and adapters

Server-side integration tools, ticket adapters, repository credential providers, and background maintenance hooks connect Leitwerk processes to external systems without leaking credentials into workers or duplicating remote writes on retry.

## Typed external writes

Mutating integration tools must coordinate writes through `ctx.externalWrites.ensure(identity, operation)`. The server supplies persistence and process identity:

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

`execute` must return a non-nullish value. `reconcile` receives the current phase:

| Phase | Required behavior |
| --- | --- |
| `before_execute` | Find an existing remote object or matching requested state before writing. |
| `after_execute_error` | Recover the object or state after an ambiguous execution failure. |
| `already_recorded` | Fetch the current remote object without repeating the write. |

Contract rules:

- Match by stable markers or provider IDs, including closed objects and completed writes. For updates, verify all requested fields (including normalized labels) before execution and after errors; on `already_recorded`, fetch current state without reapplying patches so later remote edits survive.
- Return `null` only when no matching object or state exists. Propagate lookup errors: a lookup error before execution blocks the write, and a logged write whose remote object cannot be recovered fails without recreating it.
- On `execute` failure, `reconcile` runs once more; if still `null`, the execution error is rethrown. If recovery or recording also fails, an `AggregateError` reports both errors with the execution error as `cause`.
- Metadata extraction and durable recording must succeed before returning; a recording failure does not re-execute on retry, it reconciles instead.
- Calls serialize per repository object and `dedupKey` within one server process.

When an operation has no recoverable remote identity, use `logOnly`:

```ts
await ctx.externalWrites.logOnly(identity, async () => {
  await restartPipeline();
  return { pipelineId, diagnosis };
});
```

`logOnly` returns `void` and skips execution once recorded; it cannot recover from a crash between remote success and local recording.

## Ticket creation adapters

Mark an integration tool with `capability: { kind: "ticket_creation", displayName, processId, startTurnId, titlePath?, descriptionPath?, descriptionFormat?, destinations? }` to let operators create a reviewed draft ticket from any durable result.

- `processId` and `startTurnId` name the extension-defined draft process; startup rejects enabled capabilities targeting missing definitions.
- `titlePath` and `descriptionPath` are RFC 6901 JSON Pointers into tool arguments for the read-only approval preview (`descriptionFormat: "markdown"` enables sanitized Markdown; default is plain text). Every argument remains inspectable without a preview mapping.
- The tool returns `{ externalId, url, result? }`, uses `ctx.idempotencyKey`, and reconciles ambiguous writes via `ctx.externalWrites.ensure`.
- Optional `destinations` provides:
  - `list(ctx)` — browser-safe `{ id, displayName, group?, description? }` choices (launching with no destinations fails before child creation).
  - `resolve(ctx)` — creates an immutable JSON `TicketCreationDestinationSnapshot` immediately before approval; the tool receives it as `ctx.ticketDestination`.
  - `validate(snapshot)` — validates persisted snapshots before reuse.
- Snapshot `data` is adapter-owned durable state; `agentContext` is untrusted prompt text and must never contain secrets.
- The server commits the child relation atomically; parent abort/stop/delete operations do not cascade to the derived process.

## Repository credentials

Processes declare non-secret repository credential requirements with `.repositoryCredentials(({ params, projects }) => requirements)` returning `{ projectKey, kind, credentialRef }[]` (`kind` is `"git_ssh"` or `"git_https"`). Each project uses at most one credential kind.

Owning extensions register server-side resolvers (`git_ssh` with private key + pinned `knownHosts`, or `git_https` with origin + username + password). For HTTPS, the server narrows the provider's origin to the exact credential-free project URL. Credentials travel only over authenticated `worker.start` IPC and are deleted on worker exit.

In worker code, invoke trusted Git with `repositoryGitSubprocessEnv(projectKey)` and `repositoryGitArgs(args)` (for example `repositoryGitArgs(["fetch", "origin"])`, which prepends `-c core.hooksPath=/dev/null`). Invoke all other subprocesses with `sanitizeWorkerSubprocessEnv()`. Never store credentials in `params`, `state`, `projects`, or session trees. See [Security](../admin/security.md).

## Integration maintenance

Integrations may register server-side background maintenance through capabilities independently of the selected turn (for example, pull/merge request observation, label synchronization, and settled feedback handling).

- Background reads commit against captured process and project snapshots under server coordination; polling never adds business turns or turn attempts.
- Ordinary observations preserve the selected turn and active execution.
- Ownership loss supersedes in-flight work before returning to a gated turn or ending the process; stale worker outcomes cannot restore superseded state.
- Provider-specific maintenance helpers belong in their owning extension (see [gitlab](../../extensions/gitlab/README.md) for an example).
