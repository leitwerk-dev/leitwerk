# Server and worker lifecycle

The server owns the process history. A worker runs one assigned step and reports what happened. If a worker disappears, the server uses that history to decide what can run again.

## When a start becomes an attempt

Before a worker begins, the server reserves an identity for the selected step in a `TurnStartRecord`. When the worker signals that it is ready to execute that step, the server records acceptance in a `ProcessTurnRecord` and counts one attempt. The worker waits for the acknowledgement before it runs the step.

This distinction matters during recovery. A startup failure leaves the step selected and available for another start. A failure during execution leaves a failed attempt in the process history. A retry can run the same step again, and a late message from the old worker must still match the attempt it belongs to.

## Responsibilities and ownership

| Role | Owns |
| --- | --- |
| **Server** | SQLite (`ProcessInstance`, `ProcessTurnRecord`, `WorkerLease`, annotations), `ProcessEngine` per-process locking and transitions, worker supervision/adoption, FIFO `ProcessInput` sequencing, watchers, and idempotent external writes. |
| **Worker** | Isolated single-process execution, Pi agent bootstrap and JSONL trees, Git clones and `AGENTS.md`/skills aggregation, and streaming events/snapshots to the server. |

Workers **never** open SQLite. State flows exclusively over authenticated WebSocket IPC (`/internal/workers/connect`) and `PUT /internal/workers/:instanceId/session-snapshot`.

## Start acceptance and recovery

Worker starts pass the server's `.waitFor` readiness gate before reserving a start; see [Launchers and readiness](../extensions/launchers-and-readiness.md).

1. **`TurnStartRecord` reservation:** Prepares a `TurnStartRecord` in SQLite, reserving a `turnRecordId` without creating a turn attempt.
2. **`worker.turn_started` acceptance:** The worker prepares repositories (all declared repos by default, retained checkouts only for `repositoryCheckout: "on_demand"`, or none for `"none"`), verifies the Pi resource bundle, and sends `worker.turn_started`. Workers must not prompt Pi or run automatic handlers until receiving `worker.turn_start_accepted`.
3. **Attempt increment:** Compare-and-set acceptance creates one `ProcessTurnRecord`, increments `attemptNumber` once, and sends `worker.turn_start_accepted` after durable commit and lock release (before post-commit reactions or Launch Run projections). Replays acknowledge idempotently without extra attempts.
4. **Accepted-start reconciliation:** Durable acceptance remains desired server state until the worker reports `busy`; outbound messages across a closing connection remain queued for reconnect. An idle reconnect or watchdog replays `worker.turn_start_accepted`; if the worker stays idle past a second timeout, the watchdog records an infrastructure failure and stops the worker.
5. **Terminal acknowledgement:** After uploading the session snapshot, the worker keeps `worker.turn_outcome` / `worker.turn_failed` pending and replays it until `worker.turn_terminal_recorded` confirms durable commit. Server rejections or exceptions during terminal recording become infrastructure turn failures (preserving any produced result entry and continuation metadata so Continue and Retry remain available), and recovery retains the admitted lease ID so late failures cannot park a newer start.
6. **Recovery:** Failures preserve `selectedTurnId` and park in `lifecycleStatus = error`. An owning runtime exit after `draining` or `cleanup` without a durable terminal outcome still fails and parks an accepted running turn; exits from non-owning workers or for already-terminal turns do not. `retryProcess()` routes unaccepted starts to startup recovery (re-assembling LLM resources without incrementing turn attempts) and accepted failures to turn retry. Eligible LLM failures also support Continue from the saved leaf. Explicit `abort_turn` reports `llm_error` with its reason and keeps Continue/Retry available.

During an LLM turn, automatic handler, or LLM preparation, `worker.integration_tool_request` validates the active turn record, selected turn, project, and tool authorization, replaying identical tool-call identities across reconnects. When stopped, `worker.integration_tool_cancel` aborts `ctx.signal`; committed external writes are not rolled back (see [External writes](../extensions/external-writes-and-adapters.md#typed-external-writes)).

A model readiness failure retains the selected profile and provenance before worker acceptance. Automatic recovery rechecks the captured selection under current policy without reranking; operator retry prepares anew and may refresh inherited choices. Accepted work keeps its capture. Classification labels and automatic-candidate flags are server-only selection metadata, not worker configuration or adoption-fingerprint inputs.

### Execution inspection and session snapshots

Execution inspection observations require the live lease of the accepted start and are idempotent; replacement workers append new revisions to the same execution. Immutable instruction/tool content is stored separately from references so evidence survives cache eviction.

LLM workers upload the JSONL tree via `PUT /internal/workers/:instanceId/session-snapshot` (bearer-authenticated per lease):

- Best effort after `worker.ready` and before `worker.failed`.
- Mandatory (correlated to `turnRecordId`) before `worker.turn_outcome` or `worker.turn_failed`.
- Mandatory before `worker.cleanup_completed` when Pi is initialized.

Mandatory upload failures become infrastructure failures. Automatic turns do not upload snapshots.

## AppContext lifecycle

`createAppContext()` acquires resources without binding or starting background work. `ctx.listen({ host?, port?, useBoundAddressAsBaseUrl? })` binds the HTTP/WS listener, reconciles durable state, adopts compatible live workers, and runs extension start hooks in order. It resolves with `{ address, port }` only once `/api/ready` returns 200. Unknown workers receive retryable responses until adoption and reconciliation finish.

- Host and port default to config (`port: 0` requests an ephemeral port). `useBoundAddressAsBaseUrl: true` is permitted only for unauthenticated loopback fixtures before reconciliation and rejects before binding if authenticated or non-loopback.
- Concurrent `listen()` calls share one startup operation when options match; conflicting options reject without disrupting the listener. Raw `app.listen()` leaves readiness false and cannot be adopted later.
- `ctx.close()` (and `app.close()`) immediately drops readiness, stops local workers, detaches isolated workers, runs stop hooks in reverse order (attempting all and aggregating errors), and closes owned resources without deleting caller-injected databases or retained process/workspace state. If `close()` fails while unwinding a startup error, the startup error remains the cause.
- Failed or closed contexts cannot restart; construct a new context.

Optional Kubernetes background controllers (volume pre-provisioning and worker image preloading) share start/stop lifecycle independently and never gate server readiness or ordinary process starts.

## Worker runners and storage

`WorkerRunner` separates durable lease state from physical execution:

| Runner | Isolation | Process storage | Use |
| --- | --- | --- | --- |
| **Docker** | Per-process container | `ProcessVolume` mounted at `/state` | Production single-host |
| **Kubernetes** | Per-process namespace + Pod | Retained PVC mounted at `/state` | Production cluster |
| **Local** | Host Node.js subprocess | Server-configured directories | Development and tests |

Before starting an isolated runner, the supervisor calls `ProcessVolume.ensure(instanceId, requirements)` and passes the resolved volume reference to `WorkerRunner.start(...)`. Isolated runners must not create process storage implicitly. On Kubernetes, `requirements.size` sets initial PVC capacity before provisioning (existing PVCs are never resized across restarts), and `requirements.docker: true` selects the configured Docker process `StorageClass`. Launch configuration is immutable for a physical worker's lifetime; config edits take effect only on a new worker.

Terminal worker observations trigger idempotent physical unit removal before permitting replacement. Pending physical removal blocks new workers for that process until all its stale units are gone. Failed removals and stale units queued during startup adoption enter a bounded-backoff cleanup backlog without blocking other adoptions or server readiness; an adopted worker that times out remains attached until physical cleanup finishes.

`ProcessStateExporter` is a separate read-only runner seam for local session transfer: it waits for quiescence under the per-process coordinator, stops any idle writable worker, mounts only `workspace/` and `tree/`, never enters worker adoption, and never receives model or repository credentials.

## Worker lease states

```text
               +---------------+
               |   Spawning    |
               +-------+-------+
                       |
                       v
               +---------------+
               | Bootstrapping |
               +-------+-------+
                       |
                       v
     +---------------> Idle <---------------+
     |                 |                    |
     |                 v                    |
     |               Busy ------------------+
     |                 |
     |                 v
     |              Draining
     |                 |
     v                 v
  Exited <---------- Cleanup <---------- Failed
```

`worker.ready` establishes the initial heartbeat baseline after bootstrap, keeping image pulls and workspace preparation outside `stale_heartbeat_timeout`.

## Worker IPC

Worker messages use WebSocket (`/internal/workers/connect`) and `@leitwerk-dev/worker-protocol`. Server and worker artifacts must match the protocol API version (`2026-09-16`).

### Server to worker

- **`worker.start`**: process state, prepared turn start, non-secret runtime settings, authorized integration-tool schemas, and LLM resource snapshot or model-provider credentials (numbered durable revisions or null-revision generated bootstrap material).
- **`worker.turn_start_accepted`**: acknowledges worker acceptance and authorizes execution.
- **`worker.turn_terminal_recorded`**: confirms durable recording of a correlated turn outcome or failure.
- **`worker.credential_update_accepted`**: acknowledges compare-and-set provider credential updates.
- **`worker.question_response`**: delivers operator answers to a paused `ask_questions` request.
- **`worker.integration_tool_result`**: returns a correlated server-owned tool result.
- **`input.batch`**: delivers pending FIFO steering inputs.
- **`worker.stop`**: requests graceful cleanup and shutdown.
- **`worker.abort_turn`**: interrupts active LLM execution immediately.

### Worker to server

- **`worker.hello`**: worker identity and API version compatibility check.
- **`worker.ready`**: bootstrap completion, workspace facts, and loaded resource provenance.
- **`worker.heartbeat` / `worker.state`**: periodic liveness and worker state (`idle` / `busy`) reports.
- **`worker.bootstrap_progress` / `worker.diagnostic_trace`**: sanitized bootstrap progress and pre-ready diagnostics.
- **`worker.turn_started`**: requests acceptance of a reserved `TurnStartRecord`.
- **`worker.event`**: streams `pi.*` activity, `turn.progress`, `turn.prepared`, `execution.inspection`, and `worker.trace` diagnostics.
- **`worker.question_requested`**: requests operator input for `ask_questions`.
- **`worker.input_consumed`**: acknowledges delivery of `input.batch` items.
- **`worker.integration_tool_request` / `worker.integration_tool_cancel`**: invokes or cancels an authorized server-owned integration tool.
- **`worker.credential_update`**: compare-and-set update for changed durable provider credentials (never emitted for null-revision generated material).
- **`worker.turn_outcome` / `worker.turn_failed`**: reports correlated terminal result or failure.
- **`worker.cleanup_started` / `worker.cleanup_completed` / `worker.lifecycle_parked` / `worker.failed`**: reports graceful cleanup stages, parked lifecycle, and worker-level failure.

Workers retry WebSocket connections until explicit shutdown or server startup timeout, emitting sanitized stage/code diagnostics (and bounded Pod termination messages on Kubernetes).

## Launch progress and admission

Every launch attempt creates a durable `LaunchRun` for checklist projection without storing secrets or runtime IDs. Pre-commit launch recovery resumes from private replay data (deleted once coordination finishes); post-commit recovery uses durable state without repeating process-created extension reactions or overwriting a committed turn selection or abort.

| Operation | Route | Accepted schedule mode |
| --- | --- | --- |
| Validate form/model/skills/schedule | `POST /api/launchers/:launcherId/validate` | `now`, `once`, `cron` |
| Immediate launch | `POST /api/launchers/:launcherId/launch-runs` | `now` |
| Save future launch | `POST /api/launchers/:launcherId/future-launches` | `once` or `cron` |

Validation uses optional `resolvePreviewConfig` (falling back to `resolveLaunchConfig`) without creating runs, processes, titles, or preparation checks. Revising a scheduled launch to `now` runs preparation checks and creates a `LaunchRun`.

Server-observed startup milestones (`turn.prompt_started`, first nonempty `pi.stream.delta` with `streamType: "text"` — excluding thinking and tool output — plus Kubernetes Pod/PVC observations) are recorded per physical lease in `startup.workerStarts`. Server receipt totals and Kubernetes source-time intervals use separate clocks and must not be added together.

## Credentials on worker start

Repository credentials (`git_ssh`, `git_https`) and Docker registry credentials (`docker_registries` for `runtime.docker` processes) are resolved anew at each physical start and delivered only via authenticated `worker.start` IPC, never in non-secret resource snapshots or exports. See [Security](../admin/security.md).

## Worker capacity and automatic startup recovery

`workers.max_parallel_processes` bounds allocated workers and in-flight allocations; excess requests queue FIFO without starting `startup_timeout` until admitted. Stopping a process cancels its queued request; restart with `resume_on_boot` rebuilds queued starts from persisted active starts.

Each newly prepared LLM start captures its required [scoped settings](../extensions/scoped-settings.md) and override revisions; operator retries capture current overrides, whereas recovery of a prepared/accepted start retains its captured snapshot.

Transient unaccepted startup failures allow up to three automatic starts (with 30s and 60s delays) tracked in start-state JSON; configuration, credential, OOM, and unknown failures require operator recovery. This retry budget is shared with model-availability waits and never resets across server restarts or availability changes.
