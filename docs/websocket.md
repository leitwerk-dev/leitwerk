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
- `eventSequence`: Persisted ingestion sequence on live activity frames. It orders events even when timestamps are equal.

---

## 2. Durability & Reconnect Protocol

Frames are classified into two durability categories:

| Durability | Purpose | Reconnect Handling |
|---|---|---|
| **`durable`** | Process status updates, worker state changes, input acknowledgements. | Invalidates client HTTP read models. HTTP snapshots remain authoritative. |
| **`ephemeral`** | Compact turn summaries, reasoning deltas, tool updates, liveness probes. | Live-only. Dropped during network disconnections. |

### Reconnect Re-synchronization

When a browser client reconnects after network interruption:

1. Re-establishes WebSocket connection to `/ws`.
2. Concurrently fetches relevant HTTP snapshots (such as `GET /api/processes/:id/ui-snapshot`).
3. Buffers updates during each HTTP fetch. Compact summary frames replace earlier summaries for the same turn; only an open reasoning view retains detail frames.
4. Applies frames with `eventSequence > throughEventSequence` once, in sequence order. Each boundary is captured alongside synchronous durable reads, before asynchronous session work. Timestamps remain presentation data; unsequenced metadata invalidations use the captured `rebuiltAt` boundary.
5. Refreshes full reasoning only while the expanded view remains open. It retains visible content during recovery and provides Retry on failure. Requests and frames for another turn are rejected.

The page never fetches reasoning details on load, hover, idle, or reconnect with the overlay closed. A direct reasoning link renders the shell first and starts its detail request independently. Ordinary compact snapshots cannot replace expanded history.

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
- `launch.updated` — carries `launchRunId` and nullable `instanceId`; the browser refetches the
  authoritative launch-run read model. Checklist details never appear in the frame.

### Streaming & Interactive Frames

- **`primary_path.summary_updated` (`ephemeral`):** Complete bounded summary for one `turnRecordId`, with its `throughEventSequence`. Replaces inline live state.
- **`pi.stream.delta`, `pi.tool.started`, `pi.tool.completed`, `pi.usage`, `pi.error`, `pi.retry.*`, `pi.compaction.*` (`ephemeral`):** Recorded activity for the expanded reasoning view, correlated by `turnRecordId` and `eventSequence`.
- **`primary_path.assistant_partial`, `primary_path.tool_call_started`, `primary_path.tool_call_completed`, `primary_path.usage_updated`:** Full primary-path compatibility frames. The compact page uses summary frames.
- **`primary_path.turn_started`, `primary_path.assistant_committed` (`durable`):** Turn lifecycle updates. An open overlay follows the same turn record through completion and loads its committed trace.

`GET /api/processes/:instanceId/turn-records/:turnRecordId/reasoning` returns `state: "live" | "committed"` and `throughEventSequence`. Live responses replay all recorded events for that exact turn record, without a lookback limit. Committed responses use the retained session tree plus recorded operational events. When the retained tree has no assistant or tool content for the turn, the response uses recorded events and preserves any session-derived prompt, usage, and diagnostics. A worker failure before snapshot upload does not erase recorded history. Ship the protocol, server, migrations, and bundled UI together; no new configuration is required.
