# Browser WebSocket protocol

Browser clients connect to `GET /ws` for live activity and invalidations. HTTP
snapshots remain authoritative for durable state. This protocol is separate from
[worker IPC](server-worker-lifecycle.md#4-ipc-protocol-message-reference).

## Connection and envelope

Use the `leitwerk/ws/v1` subprotocol. With authentication enabled, upgrades require
a valid session cookie and an Origin matching the configured application origin.
API token Authorization headers are rejected in both authentication modes.
Worker connect and snapshot credentials do not authenticate browser clients.

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

`instanceId` is omitted for global events. Live activity also carries its persisted
`eventSequence`; it orders events even when timestamps are equal.

## Durability

| Classification | Examples | Client behavior |
| --- | --- | --- |
| `durable` | Process changes, worker state, input acknowledgements. | Invalidate and refetch the relevant HTTP read model. |
| `ephemeral` | Compact summaries, text deltas, tool activity, liveness probes. | Apply live. Missed frames are not replayed by this connection. |

An ephemeral frame may describe activity retained by the server. The classification
specifies delivery behavior, not whether the underlying fact is stored.

### Reconnect re-synchronization

1. Reconnect to `/ws`.
2. Fetch relevant HTTP snapshots concurrently, including process `ui-snapshot`.
3. Buffer updates during each fetch. Keep only the latest compact summary per turn;
   retain detail frames only for an open reasoning view.
4. Apply frames with `eventSequence > throughEventSequence` once, in order. Capture
   the boundary alongside durable reads, before asynchronous session work. Unsequenced
   metadata invalidations use `rebuiltAt`; timestamps do not order activity.
5. Refresh expanded history only while it is open. Reject responses and frames for
   another turn, retain visible content during recovery, and offer Retry on failure.

Do not fetch reasoning on load, hover, idle, or reconnect with its overlay closed.
A direct reasoning link renders the shell first and loads detail independently.
Compact refreshes cannot shorten expanded history. See [UI contracts](ui.md).

## Server frames

### Connection control

- `hello` (`ephemeral`) confirms the connection and protocol version.
- `pong` (`ephemeral`) responds to client `ping`.

### Durable invalidations

- `process.created`, `process.updated`, `process.deleted`
- `process.input.queued`, `process.input.acknowledged`
- `project.updated`, `worker.state`, `future.updated`
- `launch.updated`: contains `launchRunId` and nullable `instanceId`, not checklist
  details. Refetch the launch-run read model.

### Live and turn activity

| Frame | Contract |
| --- | --- |
| `primary_path.summary_updated` | Ephemeral bounded summary for one `turnRecordId`, with `throughEventSequence`. Replaces inline live state. |
| `pi.stream.delta`, `pi.tool.started`, `pi.tool.completed`, `pi.usage`, `pi.error`, `pi.retry.*`, `pi.compaction.*` | Ephemeral recorded activity for expanded reasoning, correlated by turn record and event sequence. |
| `primary_path.assistant_partial`, `primary_path.tool_call_started`, `primary_path.tool_call_completed`, `primary_path.usage_updated` | Full primary-path compatibility frames; compact pages use summary frames. |
| `primary_path.turn_started`, `primary_path.assistant_committed` | Durable lifecycle updates. An open overlay follows the same record through completion. |

## Reasoning detail

`GET /api/processes/:instanceId/turn-records/:turnRecordId/reasoning` returns
`state: "live" | "committed"` and `throughEventSequence`. Live responses include
all recorded activity for that record, without a lookback limit.

Committed responses use the retained session tree plus operational events. If the
event history contains assistant text, thinking, tool calls, or results missing
from the tree, use that history while retaining session-derived prompt, missing
usage, and diagnostics. A complete session remains authoritative when events add
no activity. Failure before snapshot upload must not erase recorded history.

Deploy compatible protocol, server, database schema, and UI artifacts together.
