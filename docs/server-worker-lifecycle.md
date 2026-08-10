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
- **`failed` / `exited`:** Worker termination states.

---

## 4. IPC Protocol & Message Reference

All worker communication occurs over WebSocket (`/internal/workers/connect`) using `@leitwerk-dev/worker-protocol`:

### Server -> Worker Messages
- **`worker.start`:** Supply process state, prepared turn start, non-secret runtime settings, and any LLM resource snapshot or provider credentials. Runtime settings apply to LLM and automatic workers.
- **`worker.turn_start_accepted`:** Acknowledge worker acceptance and authorize turn execution.
- **`input.batch`:** Deliver pending FIFO steering inputs.
- **`worker.stop`:** Request graceful worker cleanup and transport termination.
- **`worker.abort_turn`:** Out-of-band message interrupting active LLM execution immediately.

### Worker -> Server Messages
- **`worker.hello`:** Report worker identity and API version compatibility.
- **`worker.ready`:** Report workspace bootstrap completion, workspace facts, and loaded resource provenance.
- **`worker.turn_started`:** Request server acceptance of reserved turn-record identity.
- **`worker.event`:** Stream Pi diagnostic logs, tool calls, and text deltas.
- **`worker.turn_outcome`:** Report successful turn completion and published products.
- **`worker.turn_failed`:** Report turn execution failure or error details.
- **`worker.cleanup_completed`:** Confirm graceful cleanup completion.

---

## 5. Start Acceptance & Recovery Invariants

1. **`TurnStartRecord` Reservation:** A worker start prepares a `TurnStartRecord` in SQLite before worker execution begins. This reserves the turn-record ID but is **not** an attempt.
2. **`worker.turn_started` Acceptance:** The worker bootstraps workspace repositories, verifies resource snapshots, and sends `worker.turn_started`. The worker MUST NOT execute LLM prompts or automatic handlers until receiving `worker.turn_start_accepted`.
3. **Attempt Increment:** Server acceptance compare-and-set creates exactly one `ProcessTurnRecord` and increments its attempt count once. Replaying an accepted start identity returns acceptance without creating duplicate attempts.
4. **Failure Recovery:** If a turn fails post-acceptance, the process moves to `lifecycleStatus = error` while preserving `selectedTurnId`. The operator can trigger **Retry** (restarts from pre-turn leaf) or **Continue** (resumes saved leaf with updated prompt).

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

Snapshot upload failures are treated as infrastructure failures, preserving server read-model integrity.
