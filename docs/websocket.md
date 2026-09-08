# Browser WebSocket Protocol

Real-time client updates in Leitwerk are handled via a persistent WebSocket stream at `GET /ws`. This document defines how browser UI clients receive live assistant output, buffer frames during network reconnects, and invalidate HTTP queries when durable process state changes.

---

## 1. Connection & Message Envelope

Clients connect to `GET /ws` using the `leitwerk/ws/v1` subprotocol. When authentication is enabled, connection upgrades require a valid session cookie and an `Origin` matching the configured application origin. API token Authorization headers are rejected on `/ws` in both authentication modes; use browser access. Worker connection and snapshot credentials remain separate.

All server frames follow a unified message envelope:

```json
{
  "protocol": "leitwerk/ws/v1",
  "type": "process.updated",
  "durability": "durable",
  "sentAt": "2026-03-27T13:30:00.000Z",
  "instanceId": "agt_01JABCDEFG",
  "payload": {}
}
```

- `durability`: Classification (`durable` vs `ephemeral`) governing reconnect handling.
- `instanceId`: Process ID associated with the frame (omitted for global system events).

---

## 2. Durability & Reconnect Protocol

Frames are classified into two durability categories:

| Durability | Purpose | Reconnect Handling |
|---|---|---|
| **`durable`** | Process status updates, worker state changes, input acknowledgements. | Invalidates client HTTP read models. HTTP snapshots remain authoritative. |
| **`ephemeral`** | High-frequency streaming text deltas (`primary_path.delta`), tool updates, liveness probes. | Live-only. Dropped during network disconnections. |

### Reconnect Re-synchronization

When a browser client reconnects after network interruption:

1. Re-establishes WebSocket connection to `/ws`.
2. Concurrently fetches relevant HTTP snapshots (such as `GET /api/processes/:id/ui-snapshot`).
3. Buffers incoming streaming frames during the HTTP fetch.
4. Applies only buffered frames whose `sentAt` timestamp is newer than the snapshot's `rebuiltAt` timestamp.
5. Resumes normal live frame processing.

---

## 3. Server Frame Reference

### Connection & Control Frames

- **`hello` (`ephemeral`):** Confirms successful WebSocket connection and protocol version.
- **`pong` (`ephemeral`):** Response to client `ping` liveness probe.

### Summary Invalidation Frames (`durable`)

These frames notify clients that durable server state has changed, triggering invalidation or refetching of HTTP read models:

- `process.created` / `process.updated` / `process.deleted`
- `process.input.queued` / `process.input.acknowledged`
- `project.updated` / `worker.state` / `future.updated`

### Streaming & Interactive Frames

- **`primary_path.delta` (`ephemeral`):** Streaming text chunk emitted during active LLM execution.
- **`primary_path.tool_call` / `primary_path.tool_result` (`ephemeral`):** Real-time tool execution events.
- **`primary_path.question_requested` (`durable`):** Pause notification emitted when an agent requests interactive human Q&A (`ask_questions`).
