# Server and Worker Lifecycle

Worker processes in Leitwerk operate under strict server supervision: the server owns desired lifecycle state in SQLite, while physical worker runners execute state transitions, report interaction facts, and upload session snapshots. This reference details how workers connect, adopt running containers, process turns, and recover from failures.

---

## 1. Responsibilities & Ownership Boundaries

### Server Ownership
- **Durable State:** Exclusive owner of SQLite (`ProcessInstance`, `ProcessTurnRecord`, `WorkerLease`, annotations).
- **ProcessEngine Operations:** Serializes process state mutations, resolves graph transitions, and manages database transactions.
- **Worker Supervision:** Manages worker leases, adoption, heartbeats, and runner container/pod allocation.
- **Input Sequencing:** Receives and sequence-numbers FIFO steering inputs from operators.
- **External Integration:** Manages watchers, arms external actions, and executes safe external API writes (`ensureWrite`).

### Worker Ownership
- **Isolated Execution:** Manages one worker runtime assigned to one active process instance.
- **Pi Agent Execution:** Bootstraps Pi coding agents, manages execution trees, and handles LLM sessions.
- **Workspace Management:** Clones full Git repositories, checks out work branches, and aggregates `AGENTS.md` and skills.
- **Fact & Log Reporting:** Streams interaction events (`worker.event`), turn outcomes, and session tree snapshots to the server.

> [!IMPORTANT]
> Workers **never** access SQLite directly. All durable state changes flow over authenticated WebSocket IPC (`/internal/workers/connect`) or snapshot HTTP endpoints (`PUT /session-snapshot`).

---

## 2. Worker Runners & Isolation Contracts

The supervisor separates durable lease state from physical execution through `WorkerRunner`.

| Runner | Isolation Level | Process Storage | Production Suitability |
|---|---|---|---|
| **Docker** | Container isolation per process | Mounts `ProcessVolume` at `/state` | Production single-machine |
| **Kubernetes** | Pod per process in dedicated namespace | Mounts PVC at `/state` | Production cloud-native |
| **Local** | Node.js subprocess (no container isolation) | Server directory paths | Local development & testing |

Before starting isolated runners (Docker or Kubernetes), the supervisor invokes `ProcessVolume.ensure(instanceId)` and passes the returned volume reference to `WorkerRunner.start(...)`. Isolated runners must not create process storage implicitly.

A terminal worker observation triggers immediate, idempotent removal of its runtime unit. Failed removals enter a background backlog with bounded backoff. Startup adoption also queues stale units this way: one reclamation failure does not block other adoptions, durable reconciliation, or server readiness. Cleanup logs identify the unit and report the backlog count, but never include worker connection or snapshot tokens.

---

## 3. Worker Lease Lifecycle States

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

## 4. IPC Protocol & Message Reference

All worker communication occurs over WebSocket (`/internal/workers/connect`) using `@leitwerk-dev/worker-protocol`:

### Server -> Worker Messages
- **`worker.start`:** Supply process state, prepared turn start, non-secret runtime settings, authorized integration-tool declarations, and any LLM resource snapshot or model-provider credentials. Durable credentials carry a numbered revision. Generated bootstrap-only material carries a null revision and is materialized for the worker without enabling credential refresh. External integration credentials remain server-only. Runtime settings apply to LLM and automatic workers.
- **`worker.turn_start_accepted`:** Acknowledge worker acceptance and authorize turn execution.
- **`worker.turn_terminal_recorded`:** Confirm that a correlated turn outcome or failure is durable. The worker retains and replays the terminal fact until this acknowledgement arrives.
- **`worker.integration_tool_result`:** Return a correlated server-owned tool result.
- **`input.batch`:** Deliver pending FIFO steering inputs.
- **`worker.stop`:** Request graceful worker cleanup and transport termination.
- **`worker.abort_turn`:** Out-of-band message interrupting active LLM execution immediately.

### Worker -> Server Messages
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

---

## 5. Start Acceptance & Recovery Invariants

1. **`TurnStartRecord` Reservation:** A worker start prepares a `TurnStartRecord` in SQLite before worker execution begins. This reserves the turn-record ID but is **not** an attempt.
2. **`worker.turn_started` Acceptance:** The worker bootstraps every declared workspace repository, resolves the Pi resource bundle from delivered bytes or the process volume, verifies and persists it, and sends `worker.turn_started`. A clone, checkout, branch, manifest, or workspace aggregate failure fails bootstrap; the worker does not report readiness or request turn acceptance with a partial workspace. The worker MUST NOT execute LLM prompts or automatic handlers until receiving `worker.turn_start_accepted`.
3. **Attempt Increment:** Server acceptance compare-and-set creates exactly one `ProcessTurnRecord` and increments its attempt count once. Replaying an accepted start identity returns acceptance without creating duplicate attempts.
4. **Accepted-start reconciliation:** Durable acceptance remains desired server state until the owning worker reports `busy`. Server-to-worker messages that encounter a closing connection remain queued for reconnect. An idle reconnect heartbeat and the idle-running watchdog replay the matching `worker.turn_start_accepted` message idempotently.
5. **Terminal acknowledgement:** After the mandatory snapshot, the worker sends `worker.turn_outcome` or `worker.turn_failed`, remains busy, and retries the same correlated fact after timeout or reconnect. The server records terminal facts idempotently and returns `worker.turn_terminal_recorded` only after the durable mutation succeeds. A recording rejection or exception becomes an infrastructure turn failure instead of being discarded.
6. **Failure Recovery:** If an executable turn fails, the process moves to `lifecycleStatus = error` while preserving `selectedTurnId`. The operator can retry worker-owned turns. LLM startup retry reassembles the latest authorized resources and records a new immutable digest when their content changed. Failed LLM turns with saved progress can also continue from the saved leaf with an updated prompt. Model overrides apply only to LLM retries.

A watchdog reconciles an accepted turn that remains `running` beyond the heartbeat timeout while its worker reports `idle`. If the worker remains idle for another timeout after replay, the watchdog records an infrastructure failure and stops the worker so generic retry is available.

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

## 6. Session Snapshot Uploads

The worker's JSONL tree file records full agent interaction history. Workers upload snapshot files to the server via:

```http
PUT /internal/workers/:instanceId/session-snapshot
Authorization: Bearer <snapshot-token>
```

Uploads are mandatory at four key execution points:
1. Immediately after `worker.ready` (when tree is non-empty).
2. Prior to emitting `worker.turn_outcome`.
3. Prior to emitting `worker.turn_failed`.
4. Prior to emitting `worker.cleanup_completed`.

Snapshot upload failures are treated as infrastructure failures, preserving server read-model integrity. A successful upload does not complete the worker lifecycle: the worker keeps the terminal fact pending until the server acknowledges its durable recording.

## 7. Launch progress

Every launch attempt has a durable `LaunchRun`. UI, trusted programmatic, watcher, and
due-schedule adapters own source-specific admission, resolution, deduplication, and scheduling
policy. Programmatic callers provide launcher input and an idempotency key; they never call the
raw process executor or choose a Launch Run id. One server-owned launch pipeline sequences
validation, ordered preparation checks, model and skill preparation, and process commit. Process creation and scheduled occurrence disposition commit atomically.
The server attaches the process id in that commit. Pre-commit failures create no process;
post-commit reaction failures retain and correlate the committed process. Launch Runs report
orchestration progress, but they are not process-startup evidence.
The process-detail API derives startup history from a `TurnStartRecord`, its correlated
`WorkerLease`, server-observed connection and readiness timestamps, and the accepted first turn.
A successful startup requires all of those records to agree. Runner observers expose only
`preparing_runtime`, `allocating_runtime`, and `starting_runtime`, and workers may send
`worker.bootstrap_progress` phases, but incoming phases are not launch-run truth. The server first
persists the corresponding lease timestamp, start state, accepted turn record, or title-job state,
then asks the launch coordinator to refresh from durable evidence. One pure startup-evidence
projector supplies both process startup history and launch checklist projection. The coordinator
persists and broadcasts only a changed projection. Reading a launch run performs the same
projection, repairing a missed event-triggered refresh. On restart, incomplete runs reconcile
from durable process, lease, title-job, readiness, turn-start, and turn records. Before process creation, UI
and trusted programmatic launches resume from a server-private replay payload stored outside the
launch read model and deleted when coordination finishes. After process creation,
recovery uses durable facts and does not repeat process creation.
The process-creation transaction also records the requested initial turn and actor in private
replay storage. If the server stops before selecting that turn, recovery selects it under the
process lock only while the process remains unstarted. Recovery never repeats process-created
extension reactions or overwrites a turn selection or abort that already committed. Plans without
an initial turn, or with an initial human or external turn, complete startup without starting a worker.
The private replay is deleted when coordination finishes. Duplicate incomplete Launch Runs for one
process are cancelled during reconciliation and never select the startup shown on process
detail. The latest startup-retry run is authoritative; without a retry, the latest `createdAt` and
then id wins deterministically. Watcher retries retain one stable idempotency key for the latest attempt. Once an attempt
commits a process, later polls return that attempt instead of creating incomplete launch runs.
