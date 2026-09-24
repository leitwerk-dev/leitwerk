# Server and worker lifecycle

The server owns durable process and worker state. Workers execute accepted turns,
report facts, and upload session snapshots. This reference owns acceptance,
supervision, launch evidence, and recovery contracts. See [LLM turn flow](llm-turn.md)
for the end-to-end sequence and [operations](operations.md) for deployment recovery.

## AppContext lifecycle

`createAppContext()` acquires resources without binding or starting background work.
`ctx.listen({ host?, port?, useBoundAddressAsBaseUrl? })` binds, reconciles durable
state, adopts workers, and runs start hooks in order. It resolves with the actual
`{ address, port }` only when `/api/ready` can return 200. Unknown workers receive
retryable responses until adoption and reconciliation finish.

Host and port default to configuration; port `0` requests an ephemeral port.
Binding preserves `server.base_url`. Unauthenticated loopback fixtures may set
`useBoundAddressAsBaseUrl: true` before reconciliation. Authenticated or non-loopback
use rejects before binding; browser fixtures retain their configured UI origin.

Concurrent startup calls share one operation. The first fixes binding options;
later matching or optionless calls reuse it. Conflicting explicit options reject
without disrupting the listener. Raw `app.listen()` is bind-only: readiness remains
false and `ctx.listen()` cannot adopt it later.

`ctx.close()` clears readiness immediately, prevents further startup, drains active
work and requests, and closes context-owned resources. Local workers stop; isolated
workers detach. Stop hooks run in reverse order, all are attempted, and errors are
reported together. Concurrent or repeated closes share the same result. Injected
databases remain caller-owned; durable process, workspace, and tree data are retained.
Direct `app.close()` uses the same shutdown contract.

Construction or startup failure releases acquired resources. A failed or closed
context cannot restart; create a new one. If shutdown also fails, the startup error
remains the cause of the aggregate error. See [testing](testing.md#harness-lifecycle)
for fixture setup.

---

## Responsibilities and ownership

### Server
- **Durable State:** Exclusive owner of SQLite (`ProcessInstance`, `ProcessTurnRecord`, `WorkerLease`, annotations).
- **ProcessEngine Operations:** Serializes process state mutations, resolves graph transitions, and manages database transactions.
- **Worker Supervision:** Manages worker leases, adoption, heartbeats, and runner container/pod allocation.
- **Input Sequencing:** Receives and sequence-numbers FIFO steering inputs from operators.
- **External Integration:** Manages watchers, arms external actions, and executes safe external API writes (`ctx.externalWrites.ensure`).

### Worker
- **Isolated Execution:** Manages one worker runtime assigned to one active process instance.
- **Pi Agent Execution:** Bootstraps Pi coding agents, manages execution trees, and handles LLM sessions.
- **Workspace Management:** Clones full Git repositories, checks out work branches, and aggregates `AGENTS.md` and skills.
- **Fact & Log Reporting:** Streams interaction events (`worker.event`), turn outcomes, and session tree snapshots to the server.

Workers **never** access SQLite directly. State changes flow over authenticated
WebSocket IPC (`/internal/workers/connect`) or `PUT /internal/workers/:instanceId/session-snapshot`.

---

## Worker runners {#2-worker-runners-isolation-contracts}

The supervisor separates durable lease state from physical execution through `WorkerRunner`.

| Runner | Isolation Level | Process Storage | Production Suitability |
|---|---|---|---|
| **Docker** | Container isolation per process | Mounts `ProcessVolume` at `/state` | Production single-machine |
| **Kubernetes** | Pod per process in dedicated namespace; optional operator-selected RuntimeClass for private Docker | Mounts PVC at `/state` | Production cloud-native |
| **Local** | Node.js subprocess (no container isolation) | Server directory paths | Local development & testing |

Before starting isolated runners (Docker or Kubernetes), the supervisor invokes `ProcessVolume.ensure(instanceId, requirements)` and passes the returned volume reference to `WorkerRunner.start(...)`. Isolated runners must not create process storage implicitly. Kubernetes selects the configured Docker process StorageClass when `requirements.docker` is true.
`requirements.size` supplies new PVC capacity, resolved before provisioning; resolution
failures prevent startup. Existing PVCs remain authoritative across restarts and worker
replacement. See [storage selection](configuration.md#per-process-storage-size) and the
[resolver contract](process-sdk.md#process-storage-sizing).

Launch configuration is immutable for the lifetime of a physical worker. Configuration changes apply only when the server creates a new worker. Operators must explicitly recycle existing workers when a change must take effect immediately.

A terminal worker observation triggers immediate, idempotent removal of its runtime unit. Docker containers and Kubernetes Pods mark removal as their replacement handoff, so the supervisor does not finalize the physical exit or permit replacement until cleanup succeeds. Failed removals enter a background backlog with bounded backoff. Startup adoption also queues stale units this way: one reclamation failure does not block other adoptions, durable reconciliation, or server readiness. Pending removal blocks new workers for that process until all its stale units are gone. An adopted worker that times out remains attached until physical cleanup finishes. Cleanup logs identify the unit and report the backlog count, but never include worker connection or snapshot tokens.

`ProcessStateExporter` is a separate, read-only runner seam for local session transfer. An attempt waits behind the accepted execution chain under the per-process operation coordinator. At quiescence, the server stops the idle worker, confirms that no writable worker lease remains, and holds the reservation through preflight and streaming. The exporter resolves or provisions its runner-specific storage from the process id. It never starts an agent turn or receives model, provider, or repository credentials. Cancellation, lease expiry, hard deadline, deletion, and stream completion release the reservation. Cancelled and failed attempts remain terminal when pending exporter work finishes. Ending a stream closes its source as well as the relay.

Export helpers are not workers and cannot enter worker adoption. Startup removes
stale helpers; missing image, server URL, or relay configuration rejects runner
construction. Helpers use the runner's trusted default image and expose only the
read-only workspace/tree scope described in [Security](security.md#2-secrets-container-isolation).
Kubernetes scheduling and volume attachment occur after the writable worker is gone.

---

## Worker lease states

Durable worker leases transition through distinct lifecycle states owned exclusively by the server:

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

- **`spawning`:** Server allocation phase starting physical container or pod.
- **`bootstrapping`:** Worker runtime connecting over WebSocket, preparing workspace clones, and verifying Pi resource snapshots.
- **`idle`:** Worker ready and awaiting next assigned turn.
- **`busy`:** Worker executing active LLM or automatic turn.
- **`draining` / `cleanup`:** Graceful turn completion, uploading final snapshots, and releasing worker resources.
- **`failed` / `exited`:** Worker termination states. Reaching a terminal lease state does not imply that the runtime unit has already been removed; reclamation remains prompt and best-effort.

The stale-heartbeat watchdog does not use lease creation time. `worker.ready` establishes the
first heartbeat baseline after bootstrap, and periodic `worker.heartbeat` messages advance it.
This keeps image pulls and workspace preparation outside the heartbeat timeout.

---

## Worker IPC {#4-ipc-protocol-message-reference}

Worker messages use WebSocket (`/internal/workers/connect`) and
`@leitwerk-dev/worker-protocol`. Deploy matching server and worker artifacts;
the current worker API version is `2026-09-16`.

### Server to worker
- **`worker.start`:** Supply process state, prepared turn start, non-secret runtime settings, authorized integration-tool declarations, and any LLM resource snapshot or model-provider credentials. Durable credentials carry a numbered revision. Generated bootstrap-only material carries a null revision and is materialized for the worker without enabling credential refresh. External integration credentials remain server-only. Runtime settings apply to LLM and automatic workers.
- **`worker.turn_start_accepted`:** Acknowledge worker acceptance and authorize turn execution.
- **`worker.turn_terminal_recorded`:** Confirm that a correlated turn outcome or failure is durable. The worker retains and replays the terminal fact until this acknowledgement arrives.
- **`worker.integration_tool_result`:** Return a correlated server-owned tool result.
- **`input.batch`:** Deliver pending FIFO steering inputs.
- **`worker.stop`:** Request graceful worker cleanup and transport termination.
- **`worker.abort_turn`:** Out-of-band message interrupting active LLM execution immediately.

### Worker to server
- **`worker.hello`:** Report worker identity and API version compatibility.
- **`worker.ready`:** Report workspace bootstrap completion, workspace facts, and loaded resource provenance.
- **`worker.turn_started`:** Request server acceptance of reserved turn-record identity.
- **`worker.event`:** Stream Pi diagnostic logs, tool calls, text deltas, correlated turn progress snapshots, and LLM preparation checkpoints.
- **`worker.integration_tool_request`:** Invoke a server-owned tool authorized for the active turn.
- **`worker.integration_tool_cancel`:** Abort a pending server-owned tool invocation.
- **`worker.credential_update`:** Compare-and-set a changed durable provider credential against its numbered revision. Null-revision generated material never emits this message.
- **`worker.turn_outcome`:** Report successful turn completion and published products.
- **`worker.turn_failed`:** Report turn execution failure or error details.
- **`worker.cleanup_completed`:** Confirm graceful cleanup completion.

### Worker connection recovery

Reconnect timers keep the worker alive, including before its first connection.
Explicit transport shutdown cancels retries; the server owns the startup deadline.

Failures report the connection stage, attempt number, and an allowlisted transport
or numeric WebSocket close code. Raw errors, close reasons, URLs, and credentials
are omitted. Workers emit safe summaries to stderr and, on Kubernetes, retain the
first failure and latest observation in the termination message. The runner records
that diagnostic before reclaiming the Pod. Successful connection clears stale
failure evidence.

---

## Acceptance and recovery {#5-start-acceptance-recovery-invariants}

1. **`TurnStartRecord` Reservation:** A worker start prepares a `TurnStartRecord` in SQLite before worker execution begins. This reserves the turn-record ID but is **not** an attempt.
2. **`worker.turn_started` Acceptance:** The worker bootstraps every declared workspace repository, resolves the Pi resource bundle from delivered bytes or the process volume, verifies and persists it, and sends `worker.turn_started`. A clone, checkout, branch, manifest, or workspace aggregate failure fails bootstrap; the worker does not report readiness or request turn acceptance with a partial workspace. The worker MUST NOT execute LLM prompts or automatic handlers until receiving `worker.turn_start_accepted`.
3. **Attempt Increment:** Server acceptance compare-and-set creates exactly one `ProcessTurnRecord` and increments its attempt count once. Replaying an accepted start identity returns acceptance without creating duplicate attempts.
4. **Accepted-start reconciliation:** Durable acceptance remains desired server state until the owning worker reports `busy`. Server-to-worker messages that encounter a closing connection remain queued for reconnect. An idle reconnect heartbeat and the idle-running watchdog replay the matching `worker.turn_start_accepted` message idempotently.
5. **Terminal acknowledgement:** After the mandatory snapshot, the worker sends `worker.turn_outcome` or `worker.turn_failed`, remains busy, and retries the same correlated fact after timeout or reconnect. The server records terminal facts idempotently and returns `worker.turn_terminal_recorded` only after the durable mutation succeeds. A recording rejection or exception becomes an infrastructure turn failure instead of being discarded.
6. **Failure Recovery:** If an executable turn fails, the process moves to `lifecycleStatus = error` while preserving `selectedTurnId`. Operators and server extensions can retry worker-owned turns. `retryProcess()` routes a current preparation or bootstrap failure to startup recovery without creating a turn attempt; accepted failed turns use turn recovery. Startup retry validates the failed start identity and lifecycle under the process lock, so a concurrent Stop or newer start remains authoritative. LLM startup retry reassembles the latest authorized resources and records a new immutable digest when their content changed. Failed LLM turns with saved progress can also continue from the saved leaf with an updated prompt. Model overrides apply only to LLM retries.

A watchdog reconciles an accepted turn that remains `running` beyond the heartbeat timeout while its worker reports `idle`. If the worker remains idle for another timeout after replay, the watchdog records an infrastructure failure and stops the worker so generic retry is available.

Start acceptance is acknowledged after durable recording and lock release, before
post-commit work. Later reaction or Launch Run projection failures do not revoke
acceptance or suppress its acknowledgement. Replays do not create another attempt.
Terminal recording recovery retains the worker lease identity admitted with the
message; a late failure must not park a newer start owned by another execution.

During an LLM turn, a declared integration tool uses
`worker.integration_tool_request` / `worker.integration_tool_result`. The server checks
the running turn record, selected turn, process project, and turn authorization before
dispatching to the extension registry. A pending worker call is replayed after IPC
reconnect with the same Pi tool-call identity. When the turn stops, the worker sends
`worker.integration_tool_cancel`, the server aborts the execution context signal, and the
worker restores normal prompt guards. Implementations must pass that signal to cancellable
provider operations. An external write already committed by its provider cannot be rolled back.

Worker automatic turns and LLM preparation use the same integration-tool protocol. Their call
identities derive from the accepted turn record and deterministic call order, preserving
reconnect replay and stale-turn rejection. Progress snapshots use `turn.progress` worker events.
The server accepts them only for the current running turn record, stores them as durable process
events, and asks connected browsers to rebuild their compact snapshot.

An authored LLM preparation phase runs after acceptance and before prompt evaluation. Its
`turn.prepared` event contains bounded, non-secret JSON correlated to the running turn record.
The server stores only the first valid checkpoint for an attempt. Replacement workers reuse that
checkpoint. Continue reuses the failed attempt's checkpoint; Retry runs preparation for its new
attempt. Preparation must remain deterministic because a failure before server receipt can cause
it to run again.

---

## Session snapshots {#6-session-snapshot-uploads}

The worker's JSONL tree file records full agent interaction history. Workers upload snapshot files to the server via:

```http
PUT /internal/workers/:instanceId/session-snapshot
Authorization: Bearer <snapshot-token>
```

Automatic sessions do not upload snapshots. LLM sessions use these rules:

- After `worker.ready` and before `worker.failed`: best effort.
- Before publishing a turn outcome or turn failure: mandatory and correlated to the turn record.
- Before `worker.cleanup_completed`: mandatory when Pi is available; skipped otherwise.

Mandatory upload failures become infrastructure failures. Best-effort failures allow the pending lifecycle operation to continue. A successful upload does not complete terminal publication: the worker keeps the terminal fact pending until the server acknowledges its durable recording.

## Launch progress {#7-launch-progress}

Every launch attempt has a durable `LaunchRun`. UI, trusted programmatic, watcher,
and scheduled sources supply their admission, resolution, deduplication, and scheduling
policy. They do not call the raw process executor or choose a Launch Run ID.

The shared server pipeline validates, runs ordered preparation checks, prepares models
and skills, and commits the process. Process creation, launch correlation, and scheduled
occurrence disposition commit atomically. Pre-commit failure creates no process;
post-commit reaction failure retains the committed process.

Launch Runs report orchestration progress, not process-startup truth. Both checklist
and process-detail startup use one projection of the `TurnStartRecord`, correlated
lease, server-observed connection/readiness, and accepted first turn. Those records
must agree. Runner phases (`preparing_runtime`, `allocating_runtime`,
`starting_runtime`) and `worker.bootstrap_progress` do not establish success alone.
Persist the evidence before publishing a changed projection. Reading a Launch Run
repairs missed refresh notifications from the same durable facts.

### Launch recovery

Before process creation, UI and trusted programmatic launches resume from private
replay data, never from a browser read model. After commit, recovery uses durable
facts without creating the process again. Private replay is removed when coordination
finishes.

The initial turn and actor are retained with creation. Recovery may select that turn
under the process lock only while the process remains unstarted. It never repeats
process-created extension reactions or overwrites a committed turn selection or abort.
A launch without an initial turn, or with an initial human/external turn, can finish
startup without a worker.

Reconciliation cancels duplicate incomplete Launch Runs for one process. The latest
startup retry wins; without a retry, order by `createdAt`, then ID. This selection
does not choose process-detail startup evidence. Watcher retries retain a stable
idempotency key; once an attempt commits a process, later polls return it rather
than creating new incomplete runs.

Worker readiness requires successful Pi version validation and SDK preparation.
SDK loading failures fail managed bootstrap.

### Durable startup observations

The server retains the first valid receipt of each startup milestone per physical
worker lease. Replacement leases retain separate history.
Prompt start uses `turn.prompt_started`; first text requires a nonempty
`pi.stream.delta` with `streamType: "text"`. Both require the current worker and
initial accepted turn to match and use server receipt time. Thinking and tool
output do not qualify.

Kubernetes observations belong to the worker Pod and container. A cached-image
event does not count as a pull start. API failures leave gaps; a PVC read failure
does not suppress Pod observations. Adoption resumes collection for the original
lease without reconstructing unobserved request boundaries.

The UI snapshot's optional `startup.workerStarts` contains all physical leases,
observations and derived intervals. It uses durable timestamps only.
Unknown historical milestones remain missing. Intervals report
`available`, `missing` or `invalid_order`; only available intervals have durations.
Server receipt totals and Kubernetes source-time intervals use separate clocks.
Kubernetes timestamps retain source precision (seconds, milliseconds or microseconds).
Derived durations use millisecond resolution. Storage, scheduling and pulls may
overlap and must not be added into an exclusive breakdown. PVC binding uses a
last-not-bound/first-bound sampling window, with a missing lower bound when no
unbound state was observed. The upper bound is not the exact binding time.

Optional volume pre-provisioning never blocks server readiness or ordinary process
allocation. Only fresh, unclaimed volumes enter the pool. Ownership changes end
pool ownership, and progress survives server restart. See
[configuration](configuration.md#pre-provisioned-kubernetes-volumes) for driver
requirements, permissions, and safe draining.

Outcome and external-action annotations retain selected target and reserved start
and turn-record identifiers in the transition transaction. A reserved identifier
does not mean a worker accepted the start. Chronicle provenance follows explicit
identifiers and retry parents; timestamps do not establish causal links.
Observation annotations replace one snapshot per resolved subscription generation,
retain the last successful facts across refresh failures, and reject stale writes.

### Launch HTTP boundary

| Operation | Route | Accepted schedule mode |
| --- | --- | --- |
| Immediate launch | `POST /api/launchers/:launcherId/launch-runs` | `now` |
| Save future work | `POST /api/launchers/:launcherId/future-launches` | `once` or `cron` |

Other modes return 400 before admission. Saving future work does not create a Launch
Run or startup checklist. Revising future work to `now` repeats launcher preparation
checks and admits a Launch Run. Process creation consumes the future launch atomically;
a preparation failure preserves it for a later revision or run.

## Repository credentials on worker start

Repository credentials are resolved anew for each physical worker start and
sent through authenticated IPC, separately from non-secret resource snapshots.
Bootstrap verifies project, reference, credential kind, and exact HTTPS scope.
Both `git_ssh` and `git_https` are supported. Credentials remain outside checkouts
and retained runtime payloads. See [security](security.md#https-repository-authentication).

### Docker registry credentials

Each physical start resolves current [registry bindings](configuration.md#docker-registry-credentials)
and delivers credentials through authenticated `worker.start` only to processes
whose code declares `runtime.docker`. See [credential cleanup and security](security.md#docker-registry-credentials).

## Worker capacity admission

`max_parallel_processes` counts allocated workers and in-flight allocations. When
all slots are occupied, worker requests enter a FIFO queue and return immediately;
launching does not fail and does not hold the process operation open. Startup
evidence shows “Waiting for worker capacity.” A queued request creates neither a
worker lease nor a turn attempt. The worker startup timeout begins at admission,
not while waiting for capacity.

Worker exit and allocation failure wake the queue. Admission rechecks the current
start identity and active lifecycle, so stopped or superseded starts cannot run.
Stopping a process cancels its pending admission. Server shutdown clears the
in-memory queue; with `resume_on_boot`, persisted active worker starts rebuild it
during startup reconciliation. Runtime startup failures after admission retain the
normal durable error and retry behavior.
