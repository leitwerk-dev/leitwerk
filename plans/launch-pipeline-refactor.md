# Launch pipeline refactor

Status: implemented; compatibility follow-ups decided

Baseline: `upstream/worker-runtime-and-launch` at `223f729` (PR #34)

## Problem

Launch orchestration is split across:

- `packages/server/src/launch-coordinator.ts`
- `packages/server/src/future-execution/lifecycle.ts`
- `packages/server/src/future-execution/execution.ts`
- `packages/server/src/process-launch-executor.ts`

UI, watcher, and due scheduled launches each sequence validation, preparation, process creation, launch-run updates, and failure mapping differently. The duplication has produced source-specific coordinator methods, repeated launch-plan preparation, and a construction cycle from future execution back to `LaunchCoordinator`.

## Goals

- Make one server-owned pipeline sequence every process launch attempt.
- Keep source-specific resolution, deduplication, and scheduling policy in adapters.
- Keep process creation and scheduled occurrence disposition atomic.
- Preserve durable `LaunchRun` recovery and startup observation semantics.
- Distinguish pre-commit rejection from post-commit reaction failure.
- Preserve the current HTTP and process-sdk interfaces unless an intentional compatibility change is documented.

## Non-goals

- Do not change the durable schema.
- Do not redesign scheduled actions.
- Do not persist executable preparation checks.
- Do not use `LaunchRun` as authoritative worker-startup evidence.
- Do not move process definitions or launch policy into configuration.

## Proposed module

Add `packages/server/src/launch-pipeline.ts` as the launch orchestration seam.

The module should expose two operations:

1. `open(...)` creates or returns a durable launch run with the standard checklist.
2. `run(...)` executes one adapter against an existing run.

Use distinct resolved and prepared types. Avoid returning raw unions such as `TResolved | LaunchFailure`, because they require unsafe structural discrimination.

Illustrative shape:

```ts
type LaunchStageFailure<TFailure> = {
  safeSummary: string;
  value: TFailure;
};

type LaunchResolution<TResolved, TFailure> =
  | { kind: "resolved"; value: TResolved }
  | { kind: "skipped" }
  | { kind: "failed"; failure: LaunchStageFailure<TFailure> };

type LaunchCommit<TResult, TFailure> =
  | {
      kind: "committed";
      result: TResult;
      process: ProcessInstance;
      startTurnId: string | null;
      reused: boolean;
    }
  | {
      kind: "committed_with_reaction_error";
      result: TResult;
      process: ProcessInstance;
      startTurnId: string | null;
      safeSummary: string;
    }
  | { kind: "failed"; failure: LaunchStageFailure<TFailure> };

type LaunchAdapter<TInput, TResolved, TPrepared, TResult, TFailure> = {
  resolve(input: TInput): Promise<LaunchResolution<TResolved, TFailure>>;
  preparationChecks(resolved: TResolved): readonly LaunchPipelineCheck[];
  prepare(
    resolved: TResolved,
  ): Promise<{ ok: true; value: TPrepared } | { ok: false; failure: LaunchStageFailure<TFailure> }>;
  commit(
    prepared: TPrepared,
    ctx: { launchRunId: string },
  ): Promise<LaunchCommit<TResult, TFailure>>;
};
```

`LaunchPipelineCheck` should bind the source-specific launch configuration before entering the pipeline. The pipeline then owns check ordering, cancellation, safe-error handling, and checklist updates without needing to understand the adapter's resolved type.

The exact generic result types may be simplified during implementation. The required properties are explicit stage outcomes, a distinct prepared value, and enough commit evidence to correlate startup without inspecting source-specific results.

## Pipeline responsibilities

For every adapter, `run(...)` owns:

1. `validate_request` transitions around `resolve`.
2. Ordered preparation-check insertion and execution.
3. `resolve_models_skills` transitions around `prepare`.
4. `create_process` transitions around `commit`.
5. Standard handling of skipped, pre-commit failed, committed, and committed-with-reaction-error outcomes.
6. Transactional launch-run correlation by passing `launchRunId` into commit.
7. Startup-step initialization from the committed process and `startTurnId`.
8. Safe handling of unexpected exceptions at the active checklist step.
9. Durable `launch.updated` invalidation after launch-run mutations.

The pipeline must not infer startup success from `LaunchRun`. Existing lease, readiness, bootstrap receipt, and accepted-turn evidence remain authoritative.

## Source adapters

### UI adapter

- Resolve launcher input through `ProcessLauncherService`.
- Bind launcher-defined preparation checks.
- Prepare models, skills, title, and launch intent.
- Commit immediate launches through the process launch executor.
- Preserve private replay storage for asynchronous UI launches.
- Reject non-`now` input at the immediate-launch entry point.

Saving a future launch is not a process launch attempt. The non-`now` HTTP path should use the split future-launch prepare/commit operations directly and should not create a startup checklist.

### Watcher adapter

- Resolve `matches`, launch configuration, launch plan, and preparation checks.
- Add the stable watcher event key as `handoffDedupKey` before preparation.
- Prepare watcher model defaults with the existing `invalidModelConfig: "omit"` policy.
- Commit through the process launch executor.
- Preserve current retry admission: an uncommitted failed run may yield its idempotency key to a new attempt; a run with an attached process remains authoritative.
- Preserve the existing handling for deduplicated processes that already started or have no viable worker.

### Scheduled adapter

- Open one launch run per durable occurrence key.
- Parse the stored payload during resolution.
- Return no executable preparation checks; functions are not persisted with a future execution.
- Re-prepare the stored launch plan with `invalidModelConfig: "reject"`.
- Compute the consume or cron-advance transition before commit.
- Commit process creation, launch-run correlation, and the future-execution transition in one transaction.
- Map terminal payload errors to removal, preparation/pre-commit errors to retry or cron advance, and post-commit reaction errors to committed work.

## Future-execution lifecycle split

Replace the broad internal `scheduleLaunch()` operation with two launch-specific operations:

```ts
prepareLaunch(...): Promise<PreparedLaunchResult>;
commitPreparedLaunch(
  prepared: PreparedLaunch,
  options?: { actor?: Actor; launchRunId?: string },
): Promise<LaunchMutationOutcome>;
```

`PreparedLaunch` should carry the normalized launch plan, validated schedule, model state, pinned resource selections, launcher input, and launch intent required for commit. It should not expose repositories or transaction mechanics.

Use the split as follows:

- The UI immediate adapter calls `prepareLaunch`, then commits with `launchRunId`.
- Future-launch creation calls the same preparation operation, then commits a future execution without a launch run.
- Scheduled due execution uses the common pipeline with its durable payload adapter.
- `reviseScheduledLaunch` should reuse the split where practical, but behavior preservation takes priority over forcing every revision path into the first change.

Remove these scheduled-only coordinator methods after migration:

- `beginScheduled`
- `observeScheduledPrepared`
- `observeScheduledCommitted`
- `failScheduled`

Also remove `getLaunchCoordinator` from future-execution dependencies. Construct the launch pipeline before the coordinator and future-execution lifecycle so dependencies remain acyclic.

## Implementation phases

### 1. Characterize behavior

Add or strengthen tests for:

- UI resolve, check, prepare, and commit failures.
- Watcher skip and retry admission.
- Deduplicated watcher processes with and without startup evidence.
- Scheduled invalid payload removal and transient retry.
- Atomic process creation plus future-execution consume/advance.
- Post-commit reaction failures retaining the committed process.
- UI replay recovery before process creation.

### 2. Add the pipeline

- Move the standard checklist and launch-run transition implementation into `launch-pipeline.ts`.
- Test through `open` and `run`, using in-memory repositories and small adapters.
- Keep startup observation methods in `LaunchCoordinator` initially; they should consume the launch-run state established by the pipeline.

### 3. Split future-launch preparation and commit

- Introduce `PreparedLaunch` and the two lifecycle operations.
- Migrate future-launch creation and immediate launch callers.
- Delete `scheduleLaunch()` after all callers move.

### 4. Migrate adapters

Migrate in this order to keep failures local:

1. UI immediate launches.
2. Watcher launches.
3. Scheduled due launches.

After each migration, remove the replaced source-specific transition code.

### 5. Remove the dependency cycle

- Inject the pipeline into scheduled execution.
- Remove future-execution access to `LaunchCoordinator`.
- Reduce `LaunchCoordinator` to admission, replay, startup observations, and restart reconciliation.

### 6. Align documentation

Update:

- `docs/arc42.md`
- `docs/server-worker-lifecycle.md`
- `docs/process-sdk.md`
- `docs/watchers.md`
- `docs/testing.md` if the recommended test seam changes

Document that launch admission is source-specific, orchestration is shared, and startup truth remains independent of launch-run progress.

## Stacked pull request impact

The open stack is shown below. The current GitHub diffs for #35-#37 do not change the public launcher interfaces `UiLauncherDefinition`, `ProcessLauncherService`, `ResolvedProcessLauncher`, `ProcessLaunchExecutorLike`, or `LaunchRunServiceLike`.

| PR | Branch | Launcher impact |
|---|---|---|
| [#35](https://github.com/leitwerk-dev/leitwerk/pull/35) | `upstream/local-session-transfer` | Does not change launcher interfaces. It changes `future-execution/lifecycle.ts` only to classify `session_transfer_in_progress` as an action conflict. Reapply that small action-only change after the lifecycle split. |
| [#36](https://github.com/leitwerk-dev/leitwerk/pull/36) | `upstream/private-docker-runtime` | Does not change `ProcessLauncherService` or `ProcessLaunchExecutorLike`, but it directly changes the launch path. It adds `ProcessRuntimeCapabilities.docker`, `assertRuntimeAvailable` to `ProcessLaunchExecutorDeps` and `FutureExecutionLifecycleDeps`, and a pre-commit runtime availability check in `process-launch-executor.ts`. |
| [#37](https://github.com/leitwerk-dev/leitwerk/pull/37) | `upstream/ticket-question-reasoning` | UI reasoning changes only. It does not touch launcher or launch-executor interfaces. |

PR #36 is the substantive follow-on conflict. Preserve its runtime check as a final pre-commit guard in `process-launch-executor.ts` so direct programmatic callers cannot bypass it. The pipeline should map that returned pre-commit failure consistently. A later refinement may also expose runtime availability as a named server-owned preparation step, but it must not replace the executor guard.

Because #35 targets #34 and #36 targets #35, changing `future-execution/lifecycle.ts`, `app.ts`, or host-capability wiring in #34 will require restacking. Resolve by moving the small #35 action-conflict change onto the split lifecycle and wiring #36's availability dependency into the new construction order.

## Follow-up refactors

Keep these out of the first behavior-preserving change unless they become necessary:

1. **Completed — separate future launches from future actions.** `future-execution/launch-lifecycle.ts` owns future-launch preparation, commit, revision, persistence, and generated-title updates. The existing future-execution lifecycle remains the public facade.
2. **Completed — extract launch-run progress projection.** `launch-run-progress.ts` owns pure startup observation and restart reconciliation reducers. The coordinator selects and persists launch runs.
3. **Completed — require launch admission for programmatic launches.** The raw process launch executor is server-internal. Trusted operator-channel extensions launch through a source-neutral admission operation that creates a durable `LaunchRun`, requires an idempotency key, and executes the shared pipeline. Callers do not manufacture or pass a `launchRunId`.
4. **Completed — retire the blocking immediate-launch route.** Immediate HTTP launches use only `POST /api/launchers/:launcherId/launch-runs`. Future-launch creation uses the explicit `POST /api/launchers/:launcherId/future-launches` route. The multiplexed blocking `POST /api/launchers/:launcherId/launch` route is removed as an intentional HTTP compatibility break.
5. **Deferred — normalize preparation diagnostics.** Do not establish a durable cross-source diagnostic-code contract without a concrete machine consumer. Preserve stable checklist step ids, existing typed launch-plan preparation issue codes, extension-owned preparation-check ids, and bounded operator-safe summaries. Revisit only when a consumer requires machine-readable classification across sources.
6. **Completed — review deduplication ownership.** `launch-idempotency.ts` distinguishes retryable watcher admission, authoritative process handoff deduplication, and durable scheduled-occurrence identity.

The two accepted compatibility changes are specified in
[`plans/launch-admission-and-http-retirement.md`](launch-admission-and-http-retirement.md).

## Acceptance criteria

- UI, watcher, and due scheduled process launches execute through `launch-pipeline.ts`.
- No scheduled-specific observation methods remain on `LaunchCoordinator`.
- Future execution no longer depends on `getLaunchCoordinator`.
- Scheduled process creation and occurrence disposition remain atomic.
- All pre-commit failures leave no new process.
- All post-commit failures return and correlate the committed process.
- Watcher and scheduled idempotency behavior is unchanged.
- Restart reconciliation does not repeat committed process creation.
- No core package imports from an extension.
- `npm run test:full` passes.
