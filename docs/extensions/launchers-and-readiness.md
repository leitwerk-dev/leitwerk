# Launchers, readiness, and progress

Process launchers expose validated entry points for operators and server callers. Readiness predicates gate worker allocation until external prerequisites hold. Progress reports stream operator-facing status during long-running deterministic work.

## UI launchers

Attach a UI launcher to a process with `.launcher({ id, label, description, visibility: "ui", ui })`.

| `ui` hook | Required | Contract |
| --- | --- | --- |
| `card` / `launchConfigSchema` | Yes | Gallery card metadata and form field schema. |
| `resolveLaunchConfig(input, ctx)` | Yes | Returns `{ ok: true, launchConfig }` or `{ ok: false, errors }`. Runs on immediate and scheduled submission. |
| `readiness(input)` | No | Fast, synchronous, local-only check returning `LauncherReadiness` (`ready`, `partial`, or `blocked` plus safe `issues`). |
| `resolveDefaults(ctx)` | No | Supplies initial form field values. |
| `resolveOptions(input, ctx)` | No | Supplies dynamic options per field for the current form input. |
| `resolvePreviewConfig(input, ctx)` | No | Validates form input and resolves model/settings preview without preparing execution resources. Never committed; falls back to `resolveLaunchConfig`. |
| `resolveRelaunchInput(previousInput, ctx)` | No | Rebuilds persisted launch input when relaunching; default preserves input verbatim. |
| `preparationChecks(input, launchConfig)` | No | Ordered async checks run during launch preparation before process commit. |

### `ProcessLaunchConfig` fields

| Field | Purpose |
| --- | --- |
| `processId`, `params` | Required target process ID and codec-valid params. |
| `startTurnId?` | Optional entry turn (defaults to `entryTurnId`). |
| `title?`, `titleSourceFields?` | Explicit title, or `{ label, value }[]` fields used by optional server-side title generation when `title` is blank. |
| `projects?` | Repository bindings (`key`, `repoLocator`, `baseBranch`, optional `workBranch`, `externalId`, `externalUrl`, `metadata`, `settingsRepository`). |
| `primaryRepositoryKey?`, `settingsContext?` | Primary repository key for scoped model defaults and trusted scope bindings. |
| `externalId?`, `externalUrl?`, `metadata?` | External source identifiers and bounded non-secret process metadata. |

### Readiness checks

`ui.readiness(input)` must be synchronous, read-only, and local: no network I/O, side effects, or credentials. Empty input requests an installation overview (`partial` means some selections work); concrete selections return `ready` or `blocked`. The gallery, launcher form, and server launch admission share this check; only `ready` launches proceed. Unexpected errors surface generic safe remediation with a correlation ID.

### Multi-select fields and presets

A `select` field with `multiple: true` encodes defaults and submitted values as newline-separated option IDs (IDs must not contain newlines). Set `searchable: true` for a filterable list. `presetsFrom` names another multi-select field whose options carry `selectionValues`: selected presets seed the target while preserving manual additions and exclusions across preset edits and draft restores. `resetOn` lists field IDs whose changes cascade-clear dependent selections. Server validation in `resolveLaunchConfig` remains authoritative.

### Launch preparation checks

Both UI launchers and watchers may return ordered `preparationChecks`: `{ id, label, run(ctx) }`. Throw `SafeLaunchPreparationError(message, safeSummary)` for operator-safe remediation (note the `(message, safeSummary)` order, distinct from `SafeOutcomePlanningError(code, message)`). The context supplies `signal`, `launchConfig`, and `logger`, never credentials or checklist mutation.

## Programmatic launch admission

Trusted server extensions and operator channels obtain `const deps = api.require(coreHostCapabilities.serverSetup)` in `setupServer` and call `deps.launchRuns.startProgrammatic(...)` instead of invoking the raw process executor. Supply launcher input, optional model/skill/title/non-secret metadata, and a required caller `idempotencyKey`.

The server re-runs launcher resolution and readiness checks, prepares the launch plan, and commits through the shared Launch Run pipeline. The call returns after process commit while worker startup runs asynchronously; report the returned process even if a post-commit reaction fails.

## Readiness predicates

Gate worker allocation beside the turn that performs the work with `.waitFor(predicate)` on `flow.llm`, `flow.mappedLlm`, or `flow.automatic`:

```ts
flow.llm("repair")
  .description("Repair failed CI")
  .waitFor(async (process) => {
    const assessment = await repository.assess(process);
    if (assessment.closed) return process.complete();
    return assessment.eligible && assessment.ciFailed;
  })
  .prompt("Repair this change's failed CI.")
  .end("done").complete();
```

The server checks the predicate before creating a `TurnStartRecord`, allocating a lease, or accepting an attempt (including retries and continuations). Predicates receive the process snapshot, projects, decoded params/state, `AbortSignal`, and `require(token)` for server read adapters.

| Return value | Effect |
| --- | --- |
| `false` | Stay waiting without a worker; recheck at the normal interval. |
| `process.waiting(message)` | Stay waiting with operator-safe guidance and no failure backoff. |
| `true` | Admit one execution; stop checks once admitted. |
| `process.complete()` / `process.abort(message)` | End the process without starting a worker. |
| `process.bindInitialProjects({ params, projects, metadata?, settingsContext? })` | Atomically bind initially unknown repositories on the initial selection before any project, start, or attempt exists, then recheck readiness. |

Rules:

- Remote reads in `.waitFor` must be read-only and never log credentials. Use `process.setState(nextState)` only to stage local observations.
- Checks run with bounded concurrency, a 30-second read timeout, and a 30-second recheck interval. Throw `RetryableWaitError` to keep waiting with exponential backoff capped at 5 minutes; other errors park the process in `error` until explicit retry.
- External edges targeting a worker turn must target a turn declaring `.waitFor(...)`. Subscriptions wake checks early but never bypass them. Mapped turns check once before freezing items and again on explicit item retry.
- Late results cannot override Stop, a changed turn, or changed state/projects.

## Turn progress and diagnostics

Automatic handlers, LLM `.prepare(...)`, and server integration tools report operator-facing progress via `ctx.reportProgress(report)`. Each call replaces the active attempt's snapshot:

```ts
ctx.reportProgress({
  title: "Ticket publication",
  summary: "Creating ticket 3 of 8: Frontend — Add deployment checks",
  steps: [],
});
```

- `steps` contains ordered `{ id, label, status }` entries (`incomplete`, `in_progress`, `completed`, `failed`) with optional credential-free HTTPS links. Use `steps: []` with a non-empty `summary` for a single live activity line.
- Progress is visibility only, never proof of a committed external operation. Stale turn IDs, canceled calls, malformed reports, and unsafe links are rejected.
- Unhandled worker errors mark any `in_progress` step `failed` before recording turn failure.
- Use `ctx.reportDiagnostic({ level, code, message, details? })` for non-secret operational diagnostics in `worker.trace`.
- Result publication may include a concise `resultSummary` (via `markdown_result`, `WorkerCompleteInput`, or `.resultSummary(name?)` on a `flow` outcome builder, defaulting to `"resultSummary"`) to summarize the artifact separately from attempt progress.

## Automatic startup recovery

Server integrations may request bounded automatic recovery for an unaccepted failed startup via `deps.commands.retryStartupAutomatically(instanceId, startRecordId)` (from `coreHostCapabilities.serverSetup`). The server returns recovery disposition, reason, count, limit, and next retry time. Repeated calls are idempotent until the deadline and reject stale targets. Check source eligibility before calling; never call `retryProcess` from unattended polling. See [Server and worker lifecycle](../maintainers/server-worker-lifecycle.md).
