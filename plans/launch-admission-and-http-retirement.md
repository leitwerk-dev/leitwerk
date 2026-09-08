# Launch admission and HTTP route retirement

Status: implemented

Depends on: `plans/launch-pipeline-refactor.md`

## Decisions

1. Every process launch attempt, including launches initiated by trusted extensions, requires server-owned admission and a durable `LaunchRun`.
2. The raw process launch executor is an internal commit mechanism. It is not an extension capability.
3. Immediate HTTP launches use `POST /api/launchers/:launcherId/launch-runs` and return `202` with a launch-run id.
4. Future-launch creation gets an explicit HTTP route. The multiplexed blocking `POST /api/launchers/:launcherId/launch` route is then removed.
5. These Process SDK and HTTP changes are intentional compatibility breaks. Do not retain aliases that permit launch-pipeline bypass.

## Problem

`ProcessLaunchExecutorLike` is currently exposed through `CoreServerSetupDeps.processLaunches`. A trusted extension can resolve and prepare a launch plan, then commit it without launch admission. The Telegram extension does this. Such launches bypass launcher preparation checks, durable replay, standard checklist progress, and shared failure mapping unless the caller reimplements them.

The launcher HTTP interface also has two immediate-launch contracts:

- `POST /api/launchers/:launcherId/launch-runs` admits an asynchronous immediate launch.
- `POST /api/launchers/:launcherId/launch` blocks through preparation and process creation for `schedule.mode = "now"`, while also creating future launches for `once` and `cron`.

The UI already uses the launch-run route for immediate launches. Keeping the blocking path preserves duplicate orchestration and makes `/launch` describe two different operations.

## Goals

- Make admission mandatory for UI, watcher, scheduled, and trusted extension launch sources.
- Keep `LaunchRun` creation, replay, checklist sequencing, failure mapping, and process correlation server-owned.
- Preserve Telegram's process metadata, actor attribution, operator feedback, and recent-value behavior.
- Give future-launch creation a route whose name and response contract describe durable scheduling rather than immediate process creation.
- Remove the obsolete blocking route and its compatibility surface.

## Non-goals

- Do not make `LaunchRun` authoritative startup evidence.
- Do not expose the generic launch-pipeline adapter interface to extensions.
- Do not let callers provide or manufacture a `launchRunId`.
- Do not route future-launch persistence through process-launch admission.
- Do not add durable cross-source preparation diagnostic codes.
- Do not change watcher or scheduled-occurrence idempotency semantics.

## Target interfaces

### Trusted extension admission

Replace public `CoreServerSetupDeps.processLaunches` with a higher-level operation on the existing launch-run capability. The exact names may be simplified, but the interface must express one admitted launcher submission rather than raw process creation.

Illustrative shape:

```ts
interface ProgrammaticLaunchRequestLike {
  launcherId: string;
  launcherInput: Record<string, unknown>;
  title?: string | null;
  modelConfig?: LaunchModelConfigInputLike;
  skillIds?: readonly string[];
  processMetadata?: Record<string, unknown>;
}

interface ProgrammaticLaunchResultLike {
  launchRunId: string;
  process: ProcessInstance | null;
  error: string | null;
}

interface LaunchRunServiceLike {
  startProgrammatic(
    request: ProgrammaticLaunchRequestLike,
    opts: { idempotencyKey: string; actor?: Actor },
  ): Promise<ProgrammaticLaunchResultLike>;

  startWatcher<TConfig, TEvent>(/* existing contract */): Promise<WatcherLaunchResultLike>;
}
```

`startProgrammatic` may await resolution and commit so an operator-channel extension can report the resulting process. The launch remains durably admitted before work begins. Worker startup continues asynchronously and is observed through existing startup evidence.

`processMetadata` is an optional, bounded, JSON-serializable patch for trusted delivery context such as Telegram chat and thread identity. The server applies it to the resolved launch plan before preparation and stores it with replay input. It must not overwrite server-owned metadata keys. If a narrower delivery-context field can preserve current behavior, prefer that smaller interface.

The server must validate the complete request before storing replay data. A caller retry with the same idempotency key returns the authoritative launch attempt rather than creating another process.

### HTTP

Use these launcher mutation routes:

| Operation | Route | Success |
|---|---|---|
| Admit an immediate launch | `POST /api/launchers/:launcherId/launch-runs` | `202` with `StartLaunchRunResponseBody` |
| Create a future launch | `POST /api/launchers/:launcherId/future-launches` | `201` with the future-launch representation |

The future-launch route accepts only `schedule.mode = "once" | "cron"`. The launch-run route accepts only `schedule.mode = "now"`. Invalid modes return `400`; neither route silently redirects to the other behavior.

Remove `POST /api/launchers/:launcherId/launch` after all in-repository callers and tests migrate. Do not change that route to return a launch-run response because doing so would preserve its ambiguous name with a third response contract.

## Server design

Deepen `LaunchCoordinator` or replace it with a smaller admission module that owns these source adapters:

- UI immediate submission.
- Trusted programmatic launcher submission.
- Watcher event submission.
- Startup retry admission.

The programmatic adapter must reuse the UI launcher's resolution, preparation-check binding, model/skill preparation, and commit mapping. Source differences are limited to origin, idempotency policy, actor, and optional trusted delivery metadata.

Add `"programmatic"` to `LaunchOrigin` unless a more precise stable term is chosen. Do not label trusted extension launches as `"ui"`; origin is durable operator-facing provenance.

Keep these functions server-internal:

- `createProcessFromLaunchConfig`
- `createProcessFromLaunchPlan`
- scheduled commit helpers

Internal watcher and future-execution wiring may call the executor only from their pipeline commit adapters. `buildHostCapabilities` must no longer publish it.

## Idempotency and replay

Programmatic admission requires a non-empty idempotency key.

For Telegram:

- Allocate the key when a pending launch reaches confirmed submission.
- Retain it in the pending launch session across retryable delivery or request failures.
- Do not derive it only from mutable form values.
- Clear it when the session is cancelled or a committed process becomes authoritative.

Replay data must contain only normalized, non-secret launch input, actor attribution, selected resources, and the approved metadata patch. Preparation functions and credentials are never persisted.

On restart:

- Reconcile a committed run without creating the process again.
- Replay an admitted, uncommitted run through the common pipeline when replay input is available.
- Preserve the existing rule that launch progress is not worker-startup evidence.

## Implementation phases

### 1. Characterize public and extension behavior

Add tests proving:

- Telegram resolution, preparation checks, model preparation, and pre-commit failures produce a launch run and no process.
- Telegram post-commit reaction failure retains and reports the committed process.
- Repeating a Telegram submission with one idempotency key does not create another process.
- Telegram thread metadata and actor attribution survive admission.
- Programmatic replay does not recreate a committed process after restart.
- The current future-launch HTTP request and response are captured before route migration.

### 2. Add programmatic admission

- Add the source-neutral SDK request and result types.
- Add the programmatic method to `LaunchRunServiceLike`.
- Extend server admission with a programmatic origin and durable replay input.
- Reuse the UI resolution and preparation adapter instead of copying it.
- Validate and merge the bounded trusted metadata patch before model/skill preparation.
- Add focused coordinator/pipeline tests.

### 3. Migrate Telegram

- Replace direct launch-plan preparation and `processLaunches.createProcessFromLaunchPlan` with programmatic admission.
- Preserve conversational validation and model selection UX. Server admission remains authoritative and repeats validation at commit time.
- Preserve recent-value recording only when a process is committed.
- Preserve distinct pre-commit failure and committed-with-follow-up-problem messages.
- Add and retain a stable submission idempotency key in pending launch state.

### 4. Internalize the executor

- Remove `ProcessLaunchExecutorLike`, `ProcessLaunchExecutionResultLike`, and related raw execution input types from the public Process SDK when no extension caller remains.
- Remove `processLaunches` from `CoreServerSetupDeps`, test-support defaults, and extension fixtures.
- Inject internal executor dependencies directly into server launch adapters.
- Keep executor unit tests at the durable commit seam.

### 5. Split future-launch HTTP creation

- Add `POST /api/launchers/:launcherId/future-launches`.
- Reject `schedule.mode = "now"` on the new route.
- Reuse `prepareLaunch` and `commitPreparedLaunch`; do not create a launch run or startup checklist.
- Add/update protocol contracts and API client methods.
- Migrate the UI's `once` and `cron` submissions.
- Migrate server, extension, and system tests that intentionally create future launches.

### 6. Remove the blocking route

- Delete `POST /api/launchers/:launcherId/launch`.
- Remove `LaunchCoordinator.startBlocking` if no internal admitted caller needs it. A programmatic admission implementation may retain equivalent internal orchestration under a source-neutral name, but it must not restore blocking HTTP behavior.
- Migrate tests that use the old route for immediate setup to the launch-run route plus launch-run/process observation helpers.
- Assert the removed route returns `404`.
- Search the repository for the old route and raw executor capability before completion.

### 7. Align documentation

Update at least:

- `docs/arc42.md`
- `docs/process-sdk.md`
- `docs/server-worker-lifecycle.md`
- `docs/ui.md`
- `docs/websocket.md` if launch observation changes
- `docs/testing.md`
- `docs/ubiquitous_language.md`
- extension-specific documentation for Telegram

Document the Process SDK and HTTP compatibility breaks. State that future-launch persistence is not a process launch attempt and therefore has no startup checklist.

## Compatibility table

| Existing contract | Target contract | Compatibility |
|---|---|---|
| `CoreServerSetupDeps.processLaunches` | `CoreServerSetupDeps.launchRuns.startProgrammatic` | Breaking Process SDK change |
| Optional caller-supplied `launchRunId` on raw executor options | Server-created launch-run correlation | Breaking; old option removed from public SDK |
| `POST .../launch` with `schedule.mode = "now"` | `POST .../launch-runs` | Breaking HTTP change |
| `POST .../launch` with `once` or `cron` | `POST .../future-launches` | Breaking HTTP route change |
| Future launch response payload | Same semantic future-launch representation | Preserved on the new route |
| Launch checklist summaries | Bounded `safeSummary` and existing step ids | Preserved; no universal diagnostic codes added |

The repository is pre-1.0, but the changes remain explicit breaks. Release notes must name both migrations.

## Implementation result

- Trusted extensions use `LaunchRunServiceLike.startProgrammatic`; the raw executor and its result types are server-internal.
- Telegram supplies one stable idempotency key per launch draft and preserves thread metadata through the admitted request.
- Immediate HTTP launch is available only through `/launch-runs`.
- Future-launch creation uses `/future-launches`; the old multiplexed `/launch` route is absent.
- Test and Kubernetes smoke helpers admit and observe asynchronous launch runs instead of restoring a blocking route.
- Durable diagnostics remain bounded summaries and existing step/check identifiers.

## Acceptance criteria

- No extension can call the raw process launch executor.
- Every trusted programmatic process launch has a durable `LaunchRun` before resolution or preparation begins.
- Programmatic launches execute launcher preparation checks and the common pipeline.
- Callers provide idempotency intent, not launch-run identity.
- Telegram preserves current metadata, actor, feedback, and recent-value behavior.
- Immediate HTTP launch is available only through `/launch-runs`.
- Future-launch creation is available only through `/future-launches`.
- `POST /api/launchers/:launcherId/launch` is absent.
- Future-launch creation does not create a launch run or startup checklist.
- Pre-commit failures create no process; post-commit failures retain the correlated process.
- Restart reconciliation never recreates a committed process.
- Documentation and compatibility notes are aligned.
- `npm run test:full` passes.
